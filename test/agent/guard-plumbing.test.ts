import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { durablePreCheck } from "../../src/agent/guard.ts";
import { guardOmpToolCall, guardToolCall } from "../../src/agent/guard-paths.ts";
import { claudeGuard } from "../../src/claude/guard.ts";
import { tempDir } from "./support.ts";

/**
 * Orrery's hook plumbing (the hook commands, codex-hook and claude-hook, and the recorder, orrery holder) is run only by
 * Orrery's hooks: shell text that runs it is refused in every gate, so an agent cannot give a hook made-up input and
 * put a "user:" message in its own memory. Orrery's other commands stay open to agents.
 */

const PLUMBING = "This command runs Orrery's hook plumbing (codex-hook, claude-hook, orrery holder), which only Orrery's own hooks run.";

function world() {
	const root = tempDir("orrery-plumbing-");
	const folder = join(root, "ws");
	const home = join(root, "home");
	return { root, options: { folder, allowedRoots: [] as string[], cwd: folder, home, foreignViews: [] as string[] } };
}

/** Every gate's verdict on one command line: pi's bash, OMP's bash and eval, Claude Code's Bash and an MCP shell, orrery run. */
function verdicts(command: string): (string | undefined)[] {
	const { root, options } = world();
	try {
		return [
			guardToolCall("bash", { command }, options),
			guardToolCall("bash", { command, path: "." }, options),
			guardOmpToolCall("bash", { command }, options),
			guardOmpToolCall("eval", { language: "sh", code: command }, options),
			claudeGuard("Bash", { command }, options),
			claudeGuard("mcp__shell__run", { command }, options),
			durablePreCheck({ name: "bash", arguments: { command } }, options),
		];
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

describe("Orrery's hook plumbing in shell text", () => {
	it.each([
		["a Codex hook fed made-up input", `echo '{"session_id":"s","prompt":"hi"}' | orrery codex-hook user-prompt-submit`],
		["a Claude Code hook", "orrery claude-hook stop < reply.json"],
		["a hook by the program's path", "/home/u/.local/bin/orrery codex-hook stop"],
		["a hook through a lookup", '"$(command -v orrery)" claude-hook user-prompt-submit'],
		["a hook named apart by quotes", "orrery codex-ho''ok user-prompt-submit"],
		["a hook named in a brace group", "orrery claude-h{o,x}ok stop"],
		["a hook named by an escape", "orrery $'\\x63odex-hook' stop"],
		["a hook from code", "python3 -c \"import subprocess; subprocess.run(['orrery', 'codex-hook', 'stop'])\""],
		["the recorder", "orrery holder Atlas --session s --claude-pid 1"],
		["the recorder after an option", "orrery --config /tmp/c.toml holder Atlas --session s"],
		["the recorder by its path", "/opt/bin/orrery holder Atlas"],
		["the recorder, quoted", "'orrery' \"holder\" Atlas"],
		["the recorder through a lookup", "$(which orrery) holder Atlas"],
		["the recorder after a redirection", "orrery --config x 2>&1 holder Atlas"],
		["the recorder, in another case", "Orrery HOLDER Atlas"],
	])("refuses %s in every gate", (_what, command) => {
		expect(verdicts(command)).toEqual(Array(7).fill(PLUMBING));
	});

	it.each([
		["Orrery's own commands", "orrery status && orrery status Atlas --json && orrery help agent && orrery usage --days 3"],
		["the summary model's switch", "orrery compactor Atlas"],
		["a holder that is not Orrery's", "cat placeholder.txt; grep -n holder notes.md; ls holder"],
		["holder in another command than orrery's", "orrery status; echo holder"],
		["a folder named orrery", "ls ~/src/orrery/holder.ts && cd orrery-holder"],
		["a hook's name inside a longer word", "npm test test/cli/codex-hook.test.ts && cat claude-hooks.md"],
	])("leaves %s alone", (_what, command) => {
		expect(verdicts(command)).toEqual(Array(7).fill(undefined));
	});
});
