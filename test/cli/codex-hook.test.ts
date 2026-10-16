import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { cleanEnv, cleanupDirs, cliCommand, testAgent } from "../claude/support.ts";

afterEach(cleanupDirs);

/** The reason Codex shows the model: "Command blocked by PreToolUse hook: <reason>." (it adds the period). */
const REASON = "Orrery's Codex guard is not built yet";

/** Runs `orrery codex-hook <event>` as Codex does: its input as JSON on stdin. */
function hook(event: string, input: object, env: Record<string, string> = {}) {
	const c = cliCommand(["codex-hook", event]);
	return spawnSync(c.cmd, c.args, { input: JSON.stringify(input), env: cleanEnv(env), encoding: "utf8", timeout: 20_000 });
}

describe("orrery codex-hook (before the guard is built)", () => {
	it("refuses every tool call by exit code 2 with the reason on stderr, which Codex honours whatever is on stdout", () => {
		for (const tool_input of [{ command: "ls" }, { command: "*** Begin Patch\n*** Add File: x\n+y\n*** End Patch" }, {}]) {
			const r = hook("pre-tool-use", { hook_event_name: "PreToolUse", session_id: "s", tool_name: "Bash", tool_input });
			expect([r.status, r.stdout, r.stderr]).toEqual([2, "", REASON]);
		}
		// Even with input it cannot read.
		const c = cliCommand(["codex-hook", "pre-tool-use"]);
		const garbled = spawnSync(c.cmd, c.args, { input: "not json", env: cleanEnv({}), encoding: "utf8", timeout: 20_000 });
		expect([garbled.status, garbled.stderr]).toEqual([2, REASON]);
	});

	it("without a config, says so at SessionStart and nothing at the other events, and never fails the session", () => {
		const env = { ORRERY_CONFIG: "/nonexistent/orrery/config.toml" };
		const start = hook("session-start", { session_id: "s", source: "startup" }, env);
		expect([start.status, start.stderr]).toEqual([0, ""]);
		expect(JSON.parse(start.stdout)).toEqual({ systemMessage: expect.stringMatching(/^Orrery: the config could not be read \(.*\); this session runs without memory\.$/) });
		for (const event of ["user-prompt-submit", "stop", "session-end"]) {
			const r = hook(event, { session_id: "s", prompt: "Codename Saffron.", last_assistant_message: "Noted." }, env);
			// Exit 0 always: a 2 would block the prompt, or keep a turn going.
			expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
		}
	});

	it("says an unknown event on stderr, never quoting the input, and still exits 0", () => {
		const t = testAgent();
		const r = hook("post-compact", { session_id: "s", prompt: "Codename Saffron." }, { ORRERY_CONFIG: t.configPath });
		expect([r.status, r.stdout]).toEqual([0, ""]);
		expect(r.stderr).toContain("unknown hook event post-compact");
		expect(r.stderr).not.toContain("Saffron");
	});
});
