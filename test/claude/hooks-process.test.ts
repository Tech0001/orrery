import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readMode } from "../../src/claude/spool.ts";
import { readHolder } from "../../src/agent/handover.ts";
import { forgetSession, recordSession } from "../../src/agent/sessions.ts";
import { MemoryStore } from "../../src/memory/index.ts";
import { cleanupFakes, releasesServer, scratch } from "../release/fake-releases.ts";
import { cleanEnv, cleanupDirs, cliCommand, fakeClaude, hookCli, messages, testAgent, waitUntil } from "./support.ts";

afterEach(cleanupDirs);
afterEach(cleanupFakes);

describe("the hooks as Claude Code runs them", () => {
	it("record a session: SessionStart starts a real holder, prompts and replies land in memory, SessionEnd lets it go", async () => {
		const t = testAgent({ setup: true });
		const claude = fakeClaude();
		const env = { ORRERY_CONFIG: t.configPath, CLAUDE_PROJECT_DIR: t.folder };
		const at = { session_id: "s1", cwd: t.folder };
		try {
			const before = Date.now();
			const start = await claude.hook("session-start", { ...at, source: "startup" }, env);
			expect([start.status, start.stderr]).toEqual([0, ""]);
			expect(JSON.parse(start.stdout).hookSpecificOutput.additionalContext).toMatch(/· recording/);
			// The holder got SessionStart's time as --since: earlier than its own start, which comes after loading.
			expect(readMode(t.agent.dir, "s1")?.since).toBeGreaterThanOrEqual(before);
			expect(readMode(t.agent.dir, "s1")?.since).toBeLessThan(readHolder(t.agent.dir)!.startedAt);
			// Nothing for the model. The holder runs with summaries off (see testAgent); on a slow machine its notice can
			// land between SessionStart and this prompt, and then it reaches the user here, once.
			const prompted = (await claude.hook("user-prompt-submit", { ...at, prompt: "Codename Saffron." }, env)).stdout;
			if (prompted !== "") expect(JSON.parse(prompted)).toEqual({ systemMessage: expect.stringMatching(/^Orrery: Test's summaries stopped: unknown model /) });
			await claude.hook("stop", { ...at, last_assistant_message: "Noted: Saffron." }, env);
			await waitUntil(() => messages(t.agent).length === 2);
			const end = await claude.hook("session-end", { ...at, reason: "other" }, env);
			expect([end.status, end.stdout, end.stderr]).toEqual([0, "", ""]);
			await waitUntil(() => readHolder(t.agent.dir) === undefined, 10_000);
			expect(messages(t.agent)).toEqual(["user: Codename Saffron.", "talk: Noted: Saffron."]);
			MemoryStore.open(join(t.agent.dir, "memory.sqlite")).close();
		} finally {
			claude.kill();
		}
	}, 60_000);

	it("run a second Claude Code's session read-only while the first records, and record none of its words", async () => {
		const t = testAgent({ setup: true });
		const a = fakeClaude();
		const b = fakeClaude();
		const env = { ORRERY_CONFIG: t.configPath, CLAUDE_PROJECT_DIR: t.folder };
		try {
			expect(JSON.parse((await a.hook("session-start", { session_id: "a1", cwd: t.folder }, env)).stdout).hookSpecificOutput.additionalContext).toMatch(/· recording/);
			const second = JSON.parse((await b.hook("session-start", { session_id: "b1", cwd: t.folder }, env)).stdout);
			expect(second.hookSpecificOutput.additionalContext).toMatch(/· read-only/);
			await b.hook("user-prompt-submit", { session_id: "b1", cwd: t.folder, prompt: "Not for memory." }, env);
			await a.hook("user-prompt-submit", { session_id: "a1", cwd: t.folder, prompt: "For memory." }, env);
			await waitUntil(() => messages(t.agent).length === 1);
			await new Promise((resolve) => setTimeout(resolve, 700));
			expect(messages(t.agent)).toEqual(["user: For memory."]);
		} finally {
			a.kill();
			b.kill();
			await waitUntil(() => readHolder(t.agent.dir) === undefined, 5000).catch(() => {});
		}
	}, 60_000);

	// Without ORRERY_CONFIG, ~/.orrery or ~/.config/orrery, the hook falls back to the server's config, which a test must not read.
	it.skipIf(existsSync("/etc/orrery/config.toml"))("exit 0 and print nothing without any orrery config", () => {
		const t = testAgent();
		const none = hookCli("user-prompt-submit", { session_id: "s1", cwd: t.folder, prompt: "x" }, { HOME: t.dir });
		expect([none.status, none.stdout, none.stderr]).toEqual([0, "", ""]);
	}, 60_000);

	it("tell the user once that a newer release is out, from the cache, and never ask the network themselves", async () => {
		const t = testAgent();
		const home = scratch();
		mkdirSync(join(home, "app", "0.6.0"), { recursive: true });
		writeFileSync(join(home, "app", "0.6.0", "VERSION"), "0.6.0\n");
		symlinkSync("0.6.0", join(home, "app", "current"));
		// A day-old answer: the hook shows it and leaves the refresh to the recorder.
		writeFileSync(join(home, "update-check.json"), JSON.stringify({ checkedAt: Date.now() - 2 * 86_400_000, latest: "0.6.1" }));
		const { base, hits } = await releasesServer("0.6.2", {});
		const env = { ORRERY_CONFIG: t.configPath, CLAUDE_PROJECT_DIR: t.folder, ORRERY_HOME: home, ORRERY_RELEASES_URL: base };
		const at = { session_id: "s1", cwd: t.folder };
		const first = hookCli("user-prompt-submit", { ...at, prompt: "hello" }, env);
		expect([first.status, first.stderr]).toEqual([0, ""]);
		expect(JSON.parse(first.stdout)).toEqual({ systemMessage: "Orrery 0.6.1 is available. Run `orrery update`, then restart this session." });
		expect(hookCli("stop", { ...at, last_assistant_message: "hi" }, env).stdout).toBe("");
		expect(hits).toEqual([]);
	}, 60_000);

	it("exit 0 and print nothing outside an agent; a broken config gets one stderr line, never the input", () => {
		const t = testAgent();
		const outside = hookCli("session-start", { session_id: "s1", cwd: t.dir }, { ORRERY_CONFIG: t.configPath, CLAUDE_PROJECT_DIR: t.dir });
		expect([outside.status, outside.stdout, outside.stderr]).toEqual([0, "", ""]);
		const broken = hookCli("stop", { session_id: "s1", cwd: t.folder, last_assistant_message: "secret words" }, { ORRERY_CONFIG: join(t.dir, "missing.toml") });
		expect([broken.status, broken.stdout]).toEqual([0, ""]);
		expect(broken.stderr).toMatch(/^Orrery: .*missing\.toml.*\n$/);
		expect(broken.stderr).not.toContain("secret");
	}, 60_000);

	it("PreToolUse denies every call while a config is there but cannot be read, or is named and missing (fix round 1)", () => {
		const t = testAgent();
		const call = { session_id: "s1", cwd: t.folder, tool_name: "Read", tool_input: { file_path: join(t.folder, "notes.md") } };
		const broken = join(t.dir, "broken.toml");
		writeFileSync(broken, "[");
		for (const config of [broken, join(t.dir, "missing.toml")]) {
			const out = hookCli("pre-tool-use", call, { ORRERY_CONFIG: config, CLAUDE_PROJECT_DIR: t.folder });
			expect([config, out.status]).toEqual([config, 0]);
			expect(JSON.parse(out.stdout)).toEqual({
				hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: expect.stringMatching(/^Orrery guard: Orrery's config could not be read/) },
			});
			expect(out.stderr).toMatch(/^Orrery: /);
		}
		// The same call with the agent's good config goes through.
		expect(hookCli("pre-tool-use", call, { ORRERY_CONFIG: t.configPath, CLAUDE_PROJECT_DIR: t.folder }).stdout).toBe("");
	}, 60_000);

	it("PreToolUse keeps the config file ORRERY_CONFIG names read-only and named in no command (fix round 2)", () => {
		const t = testAgent();
		// The config inside the agent's own folder: only the config rule can refuse a write there.
		const file = join(t.folder, "orrery.toml");
		writeFileSync(file, readFileSync(t.configPath, "utf8"));
		const tool = (tool_name: string, tool_input: object) =>
			hookCli("pre-tool-use", { session_id: "s1", cwd: t.folder, tool_name, tool_input }, { ORRERY_CONFIG: file, CLAUDE_PROJECT_DIR: t.folder }).stdout;
		expect(tool("Bash", { command: `printf '[' >> ${file}` })).toMatch(/"permissionDecision":"deny".*sensitive/);
		expect(tool("Write", { file_path: file, content: "[" })).toMatch(/"permissionDecision":"deny".*Orrery's config/);
		expect(tool("Read", { file_path: file })).toBe("");
		expect(tool("Write", { file_path: join(t.folder, "notes.md"), content: "x" })).toBe("");
	}, 60_000);
});

const claudeReady = spawnSync("claude", ["--version"], { encoding: "utf8" }).status === 0;

/**
 * The installed Claude Code itself, with a scratch HOME and CLAUDE_CONFIG_DIR (the person's settings are never read or
 * written) whose only hook is Orrery's SessionStart, and an API that answers nothing (a closed local port): enough for
 * the hook to run, and for Orrery to decide which agent's the session is. Nothing reaches a model.
 */
describe.skipIf(!claudeReady)("the hooks in the installed Claude Code (scratch homes, no model)", () => {
	const quote = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`;
	/** `claude -p` in `cwd`, killed once `done(its pid)` holds (or after 30 s); its pid. */
	async function claudeUntil(t: ReturnType<typeof testAgent>, cwd: string, done: (pid: number) => boolean): Promise<number> {
		const settings = join(t.dir, "claude-config");
		mkdirSync(settings, { recursive: true });
		const c = cliCommand(["claude-hook", "session-start"]);
		writeFileSync(join(settings, "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: [c.cmd, ...c.args].map(quote).join(" ") }] }] } }));
		const env = cleanEnv({
			HOME: join(t.dir, "home"),
			CLAUDE_CONFIG_DIR: settings,
			ORRERY_CONFIG: t.configPath,
			ANTHROPIC_API_KEY: `sk-ant-${"test"}`,
			ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
			CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
			DISABLE_AUTOUPDATER: "1",
		});
		const child = spawn("claude", ["-p", "hello", "--max-turns", "1"], { cwd, env, stdio: ["ignore", "ignore", "ignore"] });
		const pid = child.pid as number;
		try {
			await waitUntil(() => done(pid), 30_000);
		} finally {
			child.kill("SIGKILL");
		}
		return pid;
	}
	const decision = (t: ReturnType<typeof testAgent>, pid: number) => join(t.config.dataDir, "claude-processes", `${pid}.json`);

	it("its SessionStart hook knows the Claude Code by CLAUDE_PID, its parent: the decision and the host record are that process's", async () => {
		const t = testAgent();
		mkdirSync(join(t.dir, "home"));
		// Only a hook whose CLAUDE_PID passed the check decides anything (src/claude/pick.ts claudeHookPid).
		const pid = await claudeUntil(t, t.folder, (claude) => existsSync(join(t.config.dataDir, "session-hosts", `${claude}.json`)));
		expect(JSON.parse(readFileSync(decision(t, pid), "utf8"))).toMatchObject({ kind: "folder" });
		expect(JSON.parse(readFileSync(join(t.config.dataDir, "session-hosts", `${pid}.json`), "utf8"))).toMatchObject({ agent: "Test", tool: "claude-code", pid });
	}, 60_000);

	it("started inside an agent's session (a recorded ancestor), in the agent's own folder: decided nested, nothing recorded for it", async () => {
		const t = testAgent();
		mkdirSync(join(t.dir, "home"));
		// This test's process stands for a pi session of Test's that started Claude Code from its shell.
		expect(recordSession(t.config.dataDir, { agent: "Test", tool: "pi", pid: process.pid })).toBe(true);
		try {
			const pid = await claudeUntil(t, t.folder, (claude) => existsSync(decision(t, claude)));
			expect(JSON.parse(readFileSync(decision(t, pid), "utf8"))).toMatchObject({ kind: "nested", outer: "Test", tool: "pi" });
			expect(readdirSync(join(t.config.dataDir, "session-hosts"))).toEqual([`${process.pid}.json`]);
		} finally {
			forgetSession(t.config.dataDir, process.pid);
		}
	}, 60_000);
});
