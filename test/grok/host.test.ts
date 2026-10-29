import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProcessInfo } from "../../src/agent/process.ts";
import { GROK_LEADER_REFUSAL, grokHostRefusal, grokPid, isGrokLeader } from "../../src/grok/host.ts";
import { cleanupDirs, testAgent } from "../claude/support.ts";

afterEach(cleanupDirs);

const HOST = new URL("../../src/grok/host.ts", import.meta.url).pathname;

describe("grokPid", () => {
	it("is the hook's parent, the grok program, passing over shells that did not exec; never past the program to npm's launcher", () => {
		// As seen live: npm's launcher (node), the program it runs (grok), and a hook started by a shell that did not exec.
		const tree: Record<number, ProcessInfo> = {
			10: { ppid: 1, name: "bash" },
			20: { ppid: 10, name: "node" },
			30: { ppid: 20, name: "grok" },
			40: { ppid: 30, name: "sh" },
			50: { ppid: 40, name: "bash" },
			60: { ppid: 30, name: "orrery" },
		};
		const info = (pid: number) => tree[pid];
		expect(grokPid(30, info)).toBe(30);
		expect(grokPid(40, info)).toBe(30);
		expect(grokPid(50, info)).toBe(30);
		expect(grokPid(60, info)).toBe(60);
		expect(grokPid(99, info)).toBe(99);
	});

	it.skipIf(process.platform !== "linux" && process.platform !== "darwin")("finds the real process above a shell that runs the hook", () => {
		const script = `import(${JSON.stringify(HOST)}).then((m) => process.stdout.write(String(m.grokPid())))`;
		const node = `${JSON.stringify(process.execPath)} --disable-warning=ExperimentalWarning -e ${JSON.stringify(script)}`;
		const nested = spawnSync("/bin/sh", ["-c", `${node}; :`], { encoding: "utf8" });
		expect(Number(nested.stdout), nested.stderr).toBe(process.pid);
	});
});

describe("Grok's shared leader (leader mode)", () => {
	/** Grok 1.0.70's leader, as seen live: started by the first session's grok, from Grok's own binary. */
	const LEADER = ["/home/u/.grok/downloads/grok-linux-x86_64", "agent", "leader", "--no-exit-on-disconnect", "--relay-on-demand", "--grok-ws-url", "wss://example.invalid/ws", "--grok-ws-origin", "https://example.invalid"];

	it("is `grok agent [options] leader`; a session, a dedicated agent and a person's words naming it are not", () => {
		expect(isGrokLeader(LEADER)).toBe(true);
		expect(isGrokLeader(["grok", "agent", "--plugin-dir", "/p", "leader"])).toBe(true);
		for (const argv of [
			// An agent's session: Orrery's flags first (its own `agent leader` words are refused at launch: grokArgsRefusal).
			["grok", "--no-leader", "--rules", "# Memory\n\nthe agent was the leader", "-c"],
			["/home/u/.grok/downloads/grok-linux-x86_64", "agent", "stdio"],
			["/home/u/.grok/downloads/grok-linux-x86_64", "agent", "--no-leader", "stdio"],
			["grok", "leader", "kill"],
			["grok", "--leader"],
			["grok"],
			[],
		]) {
			expect(isGrokLeader(argv), argv.join(" ")).toBe(false);
		}
	});

	it("refuses a leader, and a process whose command line can't be read; never asks about its parent, which a leader may have lost", () => {
		const argv: Record<number, readonly string[]> = { 30: ["grok", "--no-leader", "--rules", "x"], 40: LEADER };
		const argvOf = (pid: number) => argv[pid];
		expect(grokHostRefusal(30, argvOf)).toBeUndefined();
		expect(grokHostRefusal(40, argvOf)).toBe(GROK_LEADER_REFUSAL);
		expect(grokHostRefusal(50, argvOf)).toBe("Grok's command line can't be read");
	});

	it.skipIf(process.platform !== "linux" && process.platform !== "darwin")("refuses a real leader, with its parent alive and once its parent is gone", async () => {
		// A stand-in leader: node runs a script named `agent` with `leader` after it, as Grok's binary runs `agent leader`.
		const t = testAgent();
		writeFileSync(join(t.dir, "agent"), "setTimeout(() => {}, 60_000);\n");
		const live = spawn(process.execPath, ["agent", "leader", "--no-exit-on-disconnect"], { cwd: t.dir, stdio: "ignore" });
		// Its parent gone: a shell that started it in the background and exited (the leader keeps running, reparented).
		const orphan = spawnSync("/bin/sh", ["-c", `${JSON.stringify(process.execPath)} agent leader >/dev/null 2>&1 & echo $!`], { cwd: t.dir, encoding: "utf8" });
		const orphanPid = Number(orphan.stdout.trim());
		const session = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)", "agent", "leader"], { stdio: "ignore" });
		try {
			const ready = (pid: number) => spawnSync("/bin/sh", ["-c", `ps -o args= -p ${pid}`], { encoding: "utf8" }).stdout.includes("leader");
			for (const pid of [live.pid as number, orphanPid, session.pid as number]) {
				for (let i = 0; i < 50 && !ready(pid); i++) await new Promise((done) => setTimeout(done, 20));
			}
			expect(grokHostRefusal(live.pid as number)).toBe(GROK_LEADER_REFUSAL);
			expect(grokHostRefusal(orphanPid)).toBe(GROK_LEADER_REFUSAL);
			// Not Grok's leader: its first argument is node's own.
			expect(grokHostRefusal(session.pid as number)).toBeUndefined();
			expect(grokHostRefusal(process.pid)).toBeUndefined();
		} finally {
			live.kill();
			session.kill();
			try {
				process.kill(orphanPid);
			} catch {
				// gone
			}
		}
	});
});
