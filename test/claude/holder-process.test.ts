import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { holderLog, sessionDir } from "../../src/claude/paths.ts";
import { readMode } from "../../src/claude/spool.ts";
import { MemoryStore } from "../../src/memory/index.ts";
import { cleanupFakes, releasesServer, scratch } from "../release/fake-releases.ts";
import { cleanEnv, cleanupDirs, cliCommand, messages, spool, testAgent, waitUntil } from "./support.ts";

afterEach(cleanupDirs);
afterEach(cleanupFakes);

/** `orrery holder Test` for session s1 of the Claude Code process `claudePid`, with the test agent's config only. */
function holderProcess(configPath: string, claudePid: number, extra: string[] = [], env: Record<string, string> = {}) {
	const c = cliCommand(["holder", "Test", "--session", "s1", "--claude-pid", String(claudePid), "--nonce", "n1", ...extra]);
	return spawn(c.cmd, c.args, {
		env: cleanEnv({ ORRERY_CONFIG: configPath, ...env }),
		stdio: "ignore",
	});
}

describe("orrery holder", () => {
	it("records spooled prompts and replies, logs no contents, and exits when its session ends", async () => {
		const t = testAgent({ setup: true });
		const claude = spawn("sleep", ["60"], { env: cleanEnv({}), stdio: "ignore" });
		const since = Date.now();
		const holder = holderProcess(t.configPath, claude.pid!, ["--since", String(since)]);
		try {
			const exited = new Promise<number | null>((resolve) => holder.on("exit", resolve));
			await waitUntil(() => readMode(t.agent.dir, "s1")?.nonce === "n1", 10_000);
			expect(readMode(t.agent.dir, "s1")).toMatchObject({ mode: "recording", since });
			spool(t.agent, "s1", { kind: "prompt", text: "Codename Saffron." }, claude.pid!);
			spool(t.agent, "s1", { kind: "reply", text: "Noted: Saffron." }, claude.pid!);
			await waitUntil(() => messages(t.agent).length === 2);
			await waitUntil(() => readFileSync(join(t.folder, ".orrery", "view.md"), "utf8").includes("1+1|"));
			spool(t.agent, "s1", { kind: "end" }, claude.pid!);
			expect(await exited).toBe(0);
			expect(messages(t.agent)).toEqual(["user: Codename Saffron.", "talk: Noted: Saffron."]);
			const log = readFileSync(holderLog(t.agent.dir), "utf8");
			expect(log).toContain("s1: recording");
			expect(log).not.toContain("Saffron");
			expect(statSync(holderLog(t.agent.dir)).mode & 0o777).toBe(0o600);
			MemoryStore.open(join(t.agent.dir, "memory.sqlite")).close();
			expect(existsSync(sessionDir(t.agent.dir, "s1"))).toBe(false);
		} finally {
			holder.kill();
			claude.kill();
		}
	}, 60_000);

	it("exits when the Claude Code process is gone, even without SessionEnd", async () => {
		const t = testAgent();
		const claude = spawn("sleep", ["60"], { env: cleanEnv({}), stdio: "ignore" });
		const holder = holderProcess(t.configPath, claude.pid!);
		try {
			const exited = new Promise<number | null>((resolve) => holder.on("exit", resolve));
			await waitUntil(() => readMode(t.agent.dir, "s1")?.mode === "recording", 10_000);
			claude.kill();
			expect(await exited).toBe(0);
		} finally {
			holder.kill();
			claude.kill();
		}
	}, 60_000);

	it("makes the daily update check in the background, for the hooks to read", async () => {
		const t = testAgent();
		const home = scratch();
		const { base, hits } = await releasesServer("0.6.1", {});
		const claude = spawn("sleep", ["60"], { env: cleanEnv({}), stdio: "ignore" });
		const holder = holderProcess(t.configPath, claude.pid!, [], { ORRERY_HOME: home, ORRERY_RELEASES_URL: base });
		try {
			await waitUntil(() => readMode(t.agent.dir, "s1")?.mode === "recording", 10_000);
			await waitUntil(() => existsSync(join(home, "update-check.json")), 10_000);
			expect(JSON.parse(readFileSync(join(home, "update-check.json"), "utf8"))).toMatchObject({ latest: "0.6.1" });
			expect(hits).toEqual(["/releases/latest"]);
		} finally {
			holder.kill();
			claude.kill();
		}
	}, 60_000);

	it("makes no update check with [updates] check = false", async () => {
		const t = testAgent();
		appendFileSync(t.configPath, "\n[updates]\ncheck = false\n");
		const home = scratch();
		const { base, hits } = await releasesServer("0.6.1", {});
		const claude = spawn("sleep", ["60"], { env: cleanEnv({}), stdio: "ignore" });
		const holder = holderProcess(t.configPath, claude.pid!, [], { ORRERY_HOME: home, ORRERY_RELEASES_URL: base });
		try {
			await waitUntil(() => readMode(t.agent.dir, "s1")?.mode === "recording", 10_000);
			await new Promise((done) => setTimeout(done, 500));
			expect(hits).toEqual([]);
			expect(existsSync(join(home, "update-check.json"))).toBe(false);
		} finally {
			holder.kill();
			claude.kill();
		}
	}, 60_000);
});
