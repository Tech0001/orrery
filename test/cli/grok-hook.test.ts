import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newToken } from "../../src/agent/pick.ts";
import { listSessions } from "../../src/claude/spool.ts";
import { cleanEnv, cleanupDirs, cliCommand, grokLeaderFolder, grokLeaderLaunch, testAgent } from "../claude/support.ts";

afterEach(cleanupDirs);

/**
 * Runs `orrery grok-hook <event>` as Grok does: its input as JSON on stdin, started by a process (the "grok") that runs in
 * `cwd`, which the hook takes as the folder Grok runs in.
 */
function hook(event: string, input: object | string, env: Record<string, string>, cwd: string) {
	const c = cliCommand(["grok-hook", event]);
	const script = `const r = require("node:child_process").spawnSync(${JSON.stringify(c.cmd)}, ${JSON.stringify(c.args)}, { input: process.env.HOOK_INPUT, encoding: "utf8", env: { ...process.env, HOOK_INPUT: "" } }); process.stdout.write(JSON.stringify({ status: r.status, stdout: r.stdout, stderr: r.stderr }));`;
	const r = spawnSync(process.execPath, ["-e", script], { cwd, env: cleanEnv({ ...env, HOOK_INPUT: typeof input === "string" ? input : JSON.stringify(input) }), encoding: "utf8", timeout: 30_000 });
	return JSON.parse(r.stdout) as { status: number; stdout: string; stderr: string };
}

const input = (extra: object = {}) => ({ hookEventName: "x", sessionId: "01a188c0-06ae-78a2-b15c-bec4228c7070", cwd: "/tmp/anywhere", ...extra });

describe("orrery grok-hook pre-tool-use, the guard", () => {
	const SENSITIVE_COMMAND = "Orrery guard: This command touches sensitive files (keys, credentials or Orrery's private data)";
	const call = (cwd: string, toolName: string, toolInput: object) => input({ cwd, toolName, toolInput, toolInputTruncated: false });

	it("lets a call through with exit 0 and nothing on stdout or stderr; refuses with exit 2 and the reason on stderr", () => {
		const t = testAgent();
		// A Grok opened as an agent but refused (no token): no agent's rules, which keep ~/.ssh.
		expect(hook("pre-tool-use", call(t.folder, "run_terminal_command", { command: "cat ~/.ssh/id_rsa" }), { ORRERY_CONFIG: t.configPath, ORRERY_AGENT: "Test" }, t.folder)).toEqual({ status: 2, stdout: "", stderr: SENSITIVE_COMMAND });
		// Then each, a plain grok's rules (Orrery's own) among them.
		const envs: Record<string, string>[] = [{ ORRERY_CONFIG: t.configPath, ORRERY_AGENT: "Test" }, { ORRERY_CONFIG: t.configPath }];
		for (const env of envs) {
			expect(hook("pre-tool-use", call(t.folder, "run_terminal_command", { command: "ls" }), env, t.folder)).toEqual({ status: 0, stdout: "", stderr: "" });
			const memory = hook("pre-tool-use", call(t.folder, "read_file", { target_file: join(t.agent.dir, "memory.sqlite") }), env, t.folder);
			expect([memory.status, memory.stdout, memory.stderr]).toEqual([2, "", expect.stringMatching(/^Orrery guard: .*memory\.sqlite is a sensitive file \(keys, credentials or Orrery's private data\)$/)]);
			// Orrery's config, read-only to every session; Grok's folder too.
			const config = hook("pre-tool-use", call(t.folder, "write", { file_path: t.configPath, content: "[" }), env, t.folder);
			expect([config.status, config.stdout]).toEqual([2, ""]);
			expect(config.stderr).toMatch(/^Orrery guard: .*Orrery's config: (agents may read it, not change it|it may be read, not changed)$/);
			const hooks = hook("pre-tool-use", call(t.folder, "run_terminal_command", { command: "rm ~/.grok/hooks/orrery.json" }), env, t.folder);
			expect([hooks.status, hooks.stderr]).toEqual([2, expect.stringMatching(/^Orrery guard: This command names Grok's folder/)]);
		}
	});

	it("refuses every call while the config can't be read; with no config at all, there is nothing of Orrery's to keep", () => {
		const t = testAgent();
		const broken = join(t.dir, "broken.toml");
		writeFileSync(broken, "[");
		const r = hook("pre-tool-use", call(t.folder, "run_terminal_command", { command: "ls" }), { ORRERY_CONFIG: broken }, t.folder);
		expect([r.status, r.stdout]).toEqual([2, ""]);
		// One line: Grok takes the first line of stderr as the reason.
		expect(r.stderr).toMatch(/^Orrery guard: Orrery's config could not be read \(.+\), so no call can be checked; nothing was run\. Fix the config file$/);
		expect(r.stderr).not.toContain("\n");
		const home = join(t.dir, "home");
		mkdirSync(home);
		const none = cleanEnv({ ORRERY_HOME: join(home, ".orrery") });
		delete none.ORRERY_CONFIG;
		const c = cliCommand(["grok-hook", "pre-tool-use"]);
		const plain = spawnSync(c.cmd, c.args, { input: JSON.stringify(call(t.folder, "run_terminal_command", { command: "cat ~/.ssh/id_rsa" })), env: { ...none, HOME: home }, encoding: "utf8", timeout: 20_000 });
		expect([plain.status, plain.stdout, plain.stderr]).toEqual([0, "", ""]);
	});

	it("refuses input over 1 MB unread, and a failure of its own command line: exit 2, never Grok's fail-open", () => {
		const t = testAgent();
		const env = { ORRERY_CONFIG: t.configPath };
		const big = cliCommand(["grok-hook", "pre-tool-use"]);
		const huge = spawnSync(big.cmd, big.args, { input: JSON.stringify(call(t.folder, "write", { file_path: "notes.md", content: "x".repeat(1_100_000) })), env: cleanEnv(env), encoding: "utf8", timeout: 20_000 });
		expect([huge.status, huge.stdout, huge.stderr]).toEqual([2, "", "Orrery guard: this call's input is too large for Orrery's guard to check (over 1 MB); nothing was run"]);
		const c = cliCommand(["grok-hook", "pre-tool-use", "--no-such-option"]);
		const r = spawnSync(c.cmd, c.args, { input: JSON.stringify(call(t.folder, "run_terminal_command", { command: "ls" })), env: cleanEnv(env), encoding: "utf8", timeout: 20_000 });
		expect([r.status, r.stdout]).toEqual([2, ""]);
		expect(r.stderr).toMatch(/^Orrery guard: this call could not be checked \(.+\); nothing was run$/);
	});

	it("refuses when it is still waiting at its watchdog's time, 6 s (input that never ends), inside the 10 s Grok gives it", async () => {
		const t = testAgent();
		const c = cliCommand(["grok-hook", "pre-tool-use"]);
		const child = spawn(c.cmd, c.args, { env: cleanEnv({ ORRERY_CONFIG: t.configPath }), stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		// Part of a call, and the input left open.
		child.stdin.write(JSON.stringify(call(t.folder, "run_terminal_command", { command: "ls" })).slice(0, 40));
		const started = performance.now();
		const status = await new Promise<number | null>((done) => child.on("exit", done));
		child.stdin.destroy();
		expect([status, stdout, stderr]).toEqual([2, "", "Orrery guard: this call could not be checked in time; nothing was run"]);
		expect(performance.now() - started).toBeLessThan(9000);
	}, 30_000);
});

describe("orrery grok-hook", () => {
	it("in a plain grok (no ORRERY_AGENT) in an agent's folder, says at SessionStart how to open the agent, and nothing at any other event", () => {
		const t = testAgent();
		const env = { ORRERY_CONFIG: t.configPath };
		const start = hook("session-start", input({ source: "new" }), env, t.folder);
		expect([start.status, start.stderr]).toEqual([0, ""]);
		expect(JSON.parse(start.stdout)).toEqual({ systemMessage: expect.stringContaining("Open it with orrery agent Test --tool grok.") });
		for (const event of ["user-prompt-submit", "stop", "stop-cancelled", "session-end"]) {
			expect(hook(event, input({ prompt: "Codename Saffron.", promptId: "p-1", lastAssistantMessage: "Noted.", reason: "end_turn" }), env, t.folder), event).toEqual({ status: 0, stdout: "", stderr: "" });
		}
		// Elsewhere it says nothing at all.
		const elsewhere = join(t.dir, "elsewhere");
		mkdirSync(elsewhere);
		expect(hook("session-start", input({ source: "new" }), env, elsewhere)).toEqual({ status: 0, stdout: "", stderr: "" });
	});

	it("without a config, says so at SessionStart in a Grok opened as an agent, and nothing in a plain grok; never fails the session", () => {
		const env = { ORRERY_CONFIG: "/nonexistent/orrery/config.toml" };
		const t = testAgent();
		const opened = hook("session-start", input({ source: "new" }), { ...env, ORRERY_AGENT: "Test" }, t.folder);
		expect([opened.status, opened.stderr]).toEqual([0, ""]);
		expect(JSON.parse(opened.stdout)).toEqual({ systemMessage: expect.stringMatching(/^Orrery: the config could not be read \(.*\); this session runs without memory\.$/) });
		for (const event of ["session-start", "user-prompt-submit", "stop"]) {
			expect(hook(event, input({ source: "new", prompt: "Codename Saffron.", lastAssistantMessage: "Noted.", reason: "end_turn" }), env, t.folder), event).toEqual({ status: 0, stdout: "", stderr: "" });
		}
	});

	it("run by Grok's shared leader (leader mode), every event decides, claims and records nothing, whatever agent and token it has; SessionStart says why", () => {
		const t = testAgent();
		const token = newToken();
		const leaderHook = (event: string, given: object, env: Record<string, string>) => {
			const c = cliCommand(["grok-hook", event]);
			const [cmd, args] = grokLeaderLaunch(c.cmd, c.args);
			const r = spawnSync(cmd, args, { cwd: grokLeaderFolder(), env: cleanEnv(env), input: JSON.stringify(given), encoding: "utf8", timeout: 30_000 });
			return { status: r.status, stdout: r.stdout, stderr: r.stderr };
		};
		// The leader's environment is its first client's: here an agent's, with a token nobody has claimed.
		const env = { ORRERY_CONFIG: t.configPath, ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: token };
		const start = leaderHook("session-start", input({ source: "new" }), env);
		expect([start.status, start.stderr]).toEqual([0, ""]);
		expect(JSON.parse(start.stdout)).toEqual({ systemMessage: "Orrery: Grok runs this session's hooks and memory tools in its shared leader process (leader mode), where one session's agent can't be told from another's; Orrery opens its agents with --no-leader. This session records nothing and gets no memory tools." });
		for (const event of ["user-prompt-submit", "pre-tool-use", "stop", "stop-cancelled", "session-end"]) {
			expect(leaderHook(event, input({ prompt: "Codename Saffron.", promptId: "p-1", lastAssistantMessage: "Noted.", reason: "end_turn", toolName: "run_terminal_command", toolInput: { command: "ls" } }), env), event).toEqual({ status: 0, stdout: "", stderr: "" });
		}
		// A plain window's leader: nothing said at all.
		expect(leaderHook("session-start", input({ source: "new" }), { ORRERY_CONFIG: t.configPath })).toEqual({ status: 0, stdout: "", stderr: "" });
		// The guard still judges there, by Orrery's own rules: Orrery's settings and every agent's memory are kept.
		const write = leaderHook("pre-tool-use", input({ cwd: t.folder, toolName: "write", toolInput: { file_path: t.configPath, content: "[" }, toolInputTruncated: false }), env);
		expect([write.status, write.stdout, write.stderr]).toEqual([2, "", expect.stringMatching(/^Orrery guard: .*Orrery's config: it may be read, not changed$/)]);
		const memory = leaderHook("pre-tool-use", input({ cwd: t.folder, toolName: "read_file", toolInput: { target_file: join(t.agent.dir, "memory.sqlite") }, toolInputTruncated: false }), env);
		expect([memory.status, memory.stderr]).toEqual([2, expect.stringMatching(/^Orrery guard: .* is a sensitive file/)]);
		// Nothing decided, claimed, hosted or spooled.
		expect(existsSync(join(t.config.dataDir, "grok-processes"))).toBe(false);
		expect(existsSync(join(t.config.dataDir, "session-hosts"))).toBe(false);
		expect(existsSync(join(t.agent.dir, "claims"))).toBe(false);
		expect(listSessions(t.agent.dir)).toEqual([]);
	});

	it("says an unknown event on stderr, never quoting the input, and still exits 0", () => {
		const t = testAgent();
		const r = hook("post-compact", input({ prompt: "Codename Saffron." }), { ORRERY_CONFIG: t.configPath }, t.folder);
		expect([r.status, r.stdout]).toEqual([0, ""]);
		expect(r.stderr).toContain("unknown hook event post-compact");
		expect(r.stderr).not.toContain("Saffron");
	});
});
