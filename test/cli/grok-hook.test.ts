import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanEnv, cleanupDirs, cliCommand, testAgent } from "../claude/support.ts";

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

describe("orrery grok-hook", () => {
	it("lets every tool call through until the guard comes: exit 0 and nothing on stdout or stderr", () => {
		const t = testAgent();
		const r = hook("pre-tool-use", input({ toolName: "run_terminal_command", toolInput: { command: "ls" }, toolInputTruncated: false }), { ORRERY_CONFIG: t.configPath, ORRERY_AGENT: "Test" }, t.folder);
		expect(r).toEqual({ status: 0, stdout: "", stderr: "" });
	});

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

	it("says an unknown event on stderr, never quoting the input, and still exits 0", () => {
		const t = testAgent();
		const r = hook("post-compact", input({ prompt: "Codename Saffron." }), { ORRERY_CONFIG: t.configPath }, t.folder);
		expect([r.status, r.stdout]).toEqual([0, ""]);
		expect(r.stderr).toContain("unknown hook event post-compact");
		expect(r.stderr).not.toContain("Saffron");
	});
});
