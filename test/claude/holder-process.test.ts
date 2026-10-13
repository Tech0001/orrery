import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { holderLog, sessionDir } from "../../src/claude/paths.ts";
import { readMode } from "../../src/claude/spool.ts";
import { MemoryStore } from "../../src/memory/index.ts";
import { cleanEnv, cleanupDirs, MAIN, messages, spool, testLane, waitUntil } from "./support.ts";

afterEach(cleanupDirs);

/** `orrery holder Test` for session s1 of the Claude Code process `claudePid`, with the test lane's config only. */
function holderProcess(configPath: string, claudePid: number, extra: string[] = []) {
	return spawn(process.execPath, ["--disable-warning=ExperimentalWarning", MAIN, "holder", "Test", "--session", "s1", "--claude-pid", String(claudePid), "--nonce", "n1", ...extra], {
		env: cleanEnv({ ORRERY_CONFIG: configPath }),
		stdio: "ignore",
	});
}

describe("orrery holder", () => {
	it("records spooled prompts and replies, logs no contents, and exits when its session ends", async () => {
		const t = testLane({ setup: true });
		const claude = spawn("sleep", ["60"], { env: cleanEnv({}), stdio: "ignore" });
		const since = Date.now();
		const holder = holderProcess(t.configPath, claude.pid!, ["--since", String(since)]);
		try {
			const exited = new Promise<number | null>((resolve) => holder.on("exit", resolve));
			await waitUntil(() => readMode(t.lane.dir, "s1")?.nonce === "n1", 10_000);
			expect(readMode(t.lane.dir, "s1")).toMatchObject({ mode: "recording", since });
			spool(t.lane, "s1", { kind: "prompt", text: "Codename Saffron." }, claude.pid!);
			spool(t.lane, "s1", { kind: "reply", text: "Noted: Saffron." }, claude.pid!);
			await waitUntil(() => messages(t.lane).length === 2);
			await waitUntil(() => readFileSync(join(t.workspace, ".orrery", "view.md"), "utf8").includes("1+1|"));
			spool(t.lane, "s1", { kind: "end" }, claude.pid!);
			expect(await exited).toBe(0);
			expect(messages(t.lane)).toEqual(["user: Codename Saffron.", "talk: Noted: Saffron."]);
			const log = readFileSync(holderLog(t.lane.dir), "utf8");
			expect(log).toContain("s1: recording");
			expect(log).not.toContain("Saffron");
			expect(statSync(holderLog(t.lane.dir)).mode & 0o777).toBe(0o600);
			MemoryStore.open(join(t.lane.dir, "memory.sqlite")).close();
			expect(existsSync(sessionDir(t.lane.dir, "s1"))).toBe(false);
		} finally {
			holder.kill();
			claude.kill();
		}
	}, 60_000);

	it("exits when the Claude Code process is gone, even without SessionEnd", async () => {
		const t = testLane();
		const claude = spawn("sleep", ["60"], { env: cleanEnv({}), stdio: "ignore" });
		const holder = holderProcess(t.configPath, claude.pid!);
		try {
			const exited = new Promise<number | null>((resolve) => holder.on("exit", resolve));
			await waitUntil(() => readMode(t.lane.dir, "s1")?.mode === "recording", 10_000);
			claude.kill();
			expect(await exited).toBe(0);
		} finally {
			holder.kill();
			claude.kill();
		}
	}, 60_000);
});
