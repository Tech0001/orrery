import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readMode } from "../../src/claude/spool.ts";
import { readHolder } from "../../src/agent/handover.ts";
import { MemoryStore } from "../../src/memory/index.ts";
import { cleanEnv, cleanupDirs, hookCli, messages, testAgent, waitUntil } from "./support.ts";

afterEach(cleanupDirs);

/** A stand-in for a Claude Code process: alive until killed. */
const claudeProcess = () => spawn("sleep", ["60"], { env: cleanEnv({}), stdio: "ignore" });

describe("the hooks as Claude Code runs them", () => {
	it("record a session: SessionStart starts a real holder, prompts and replies land in memory, SessionEnd lets it go", async () => {
		const t = testAgent({ setup: true });
		const claude = claudeProcess();
		const env = { ORRERY_CONFIG: t.configPath, CLAUDE_PROJECT_DIR: t.folder, CLAUDE_PID: String(claude.pid) };
		const at = { session_id: "s1", cwd: t.folder };
		try {
			const before = Date.now();
			const start = hookCli("session-start", { ...at, source: "startup" }, env);
			expect([start.status, start.stderr]).toEqual([0, ""]);
			expect(JSON.parse(start.stdout).hookSpecificOutput.additionalContext).toMatch(/· recording/);
			// The holder got SessionStart's time as --since: earlier than its own start, which comes after loading.
			expect(readMode(t.agent.dir, "s1")?.since).toBeGreaterThanOrEqual(before);
			expect(readMode(t.agent.dir, "s1")?.since).toBeLessThan(readHolder(t.agent.dir)!.startedAt);
			// Nothing for the model. The holder runs with summaries off (see testAgent); on a slow machine its notice can
			// land between SessionStart and this prompt, and then it reaches the user here, once.
			const prompted = hookCli("user-prompt-submit", { ...at, prompt: "Codename Saffron." }, env).stdout;
			if (prompted !== "") expect(JSON.parse(prompted)).toEqual({ systemMessage: expect.stringMatching(/^Orrery: Test's summaries stopped: unknown model /) });
			hookCli("stop", { ...at, last_assistant_message: "Noted: Saffron." }, env);
			await waitUntil(() => messages(t.agent).length === 2);
			const end = hookCli("session-end", { ...at, reason: "other" }, env);
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
		const a = claudeProcess();
		const b = claudeProcess();
		const env = (pid: number | undefined) => ({ ORRERY_CONFIG: t.configPath, CLAUDE_PROJECT_DIR: t.folder, CLAUDE_PID: String(pid) });
		try {
			expect(JSON.parse(hookCli("session-start", { session_id: "a1", cwd: t.folder }, env(a.pid)).stdout).hookSpecificOutput.additionalContext).toMatch(/· recording/);
			const second = JSON.parse(hookCli("session-start", { session_id: "b1", cwd: t.folder }, env(b.pid)).stdout);
			expect(second.hookSpecificOutput.additionalContext).toMatch(/· read-only/);
			hookCli("user-prompt-submit", { session_id: "b1", cwd: t.folder, prompt: "Not for memory." }, env(b.pid));
			hookCli("user-prompt-submit", { session_id: "a1", cwd: t.folder, prompt: "For memory." }, env(a.pid));
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
