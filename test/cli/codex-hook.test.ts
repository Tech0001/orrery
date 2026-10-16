import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { cleanEnv, cliCommand } from "../claude/support.ts";

/** The reason Codex shows the model: "Command blocked by PreToolUse hook: <reason>." (it adds the period). */
const REASON = "Orrery's Codex guard is not built yet";

/** Runs `orrery codex-hook <event>` as Codex does: its input as JSON on stdin. */
function hook(event: string, input: object) {
	const c = cliCommand(["codex-hook", event]);
	return spawnSync(c.cmd, c.args, { input: JSON.stringify(input), env: cleanEnv({}), encoding: "utf8", timeout: 20_000 });
}

describe("orrery codex-hook (before the recorder and the guard are built)", () => {
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

	it("answers the other events with nothing to add", () => {
		for (const event of ["session-start", "user-prompt-submit", "stop", "session-end"]) {
			const r = hook(event, { session_id: "s" });
			expect([r.status, r.stdout, r.stderr]).toEqual([0, "{}", ""]);
		}
	});
});
