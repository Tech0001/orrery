import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { durablePreCheck } from "../../src/agent/guard.ts";
import { guardOmpToolCall, guardToolCall } from "../../src/agent/guard-paths.ts";
import { claudeGuard } from "../../src/claude/guard.ts";
import { openCodeGuard } from "../../src/opencode/guard.ts";
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

/**
 * Every gate's verdict on one command line: pi's bash, OMP's bash and eval, Claude Code's Bash and an MCP shell, orrery
 * run, OpenCode's shell, Code Mode program and an MCP shell.
 */
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
			openCodeGuard("shell", { command }, options),
			openCodeGuard("execute", { code: command }, options),
			openCodeGuard("box_run", { command }, options),
		];
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

describe("Orrery's hook plumbing in shell text", () => {
	it.each([
		// The hook commands, however Orrery is reached.
		["a Codex hook fed made-up input", `echo '{"session_id":"s","prompt":"hi"}' | orrery codex-hook user-prompt-submit`],
		["a Claude Code hook", "orrery claude-hook stop < reply.json"],
		["a hook by the program's path", "/home/u/.local/bin/orrery codex-hook stop"],
		["a hook through env", "env ORRERY_CONFIG=/x orrery codex-hook stop"],
		["a hook through command", "command orrery claude-hook stop"],
		["a hook through exec", "exec orrery codex-hook stop"],
		["a hook through a lookup", '"$(command -v orrery)" claude-hook user-prompt-submit'],
		["a hook through which", "$(which orrery) codex-hook stop"],
		["a hook fed to xargs", "echo codex-hook stop | xargs orrery"],
		["a hook in the source under node", "node /src/orrery/src/cli/main.ts codex-hook stop"],
		["a hook in the source under bun", "bun src/cli/main.ts claude-hook stop"],
		["a hook from code", "python3 -c \"import subprocess; subprocess.run(['orrery', 'codex-hook', 'stop'])\""],
		// ... by any spelling the readings know.
		["a hook's name with a backslash in it", "orrery codex\\-hook stop"],
		["a hook's name partly quoted", 'orrery "codex"-hook stop'],
		["a hook's name split by empty quotes", "orrery co''dex-hook stop"],
		["a hook's name in a brace group", "orrery {codex,x}-hook stop"],
		["a hook's name split by a brace group", "orrery claude-h{o,x}ok stop"],
		["a hook's name by a $'…' escape", "orrery $'\\x63odex-hook' stop"],
		["a hook's name by an octal escape", "orrery $'\\143laude-hook' stop"],
		["a hook's name in capitals", "orrery CODEX-HOOK stop"],
		["a hook's name after an expansion that may be empty", "orrery ${x}codex-hook stop"],
		["a hook's name before an expansion that may be empty", "orrery claude-hook$x stop"],
		["a hook's name after an empty substitution", "orrery $()codex-hook stop"],
		["a hook's name after a printf escape", "printf 'x\\ncodex-hook\\nstop' | xargs orrery"],
		// The recorder: holder with Orrery's program, in either order.
		["the recorder", "orrery holder Atlas --session s --claude-pid 1"],
		["the recorder after an option", "orrery --config /tmp/c.toml holder Atlas --session s"],
		["the recorder after a quoted separator", "orrery --config ';' holder Atlas"],
		["the recorder after a quoted pipe", "orrery --config 'a|b' holder Atlas"],
		["the recorder after a redirection", "orrery --config x 2>&1 holder Atlas"],
		["the recorder by its path", "/opt/bin/orrery holder Atlas"],
		["the recorder through env", "env orrery holder Atlas"],
		["the recorder through command", "command orrery holder Atlas"],
		["the recorder through exec", "exec orrery holder Atlas"],
		["the recorder through which", "$(which orrery) holder Atlas"],
		["the recorder fed to xargs", "echo holder Atlas | xargs orrery"],
		["the recorder fed to xargs by printf", "printf 'Atlas\\nholder\\n' | xargs orrery"],
		["the recorder in the source under node", "node /src/orrery/src/cli/main.ts holder Atlas"],
		["the recorder in the source under bun", "cd src && bun cli/main.ts holder Atlas"],
		["the recorder, quoted", "'orrery' \"holder\" Atlas"],
		["the recorder split by empty quotes", "orrery hol''der Atlas"],
		["the recorder with a backslash in it", "orrery h\\older Atlas"],
		["the recorder in a brace group", "orrery ho{l,x}der Atlas"],
		["the recorder by a $'…' escape", "orrery $'\\x68older' Atlas"],
		["the recorder, in capitals", "Orrery HOLDER Atlas"],
		["the recorder through a variable that names the program", "o=orrery; $o holder Atlas"],
		["the recorder in a list", "{orrery,holder,Atlas}"],
		["the recorder in code's list", `python3 -c 'import subprocess;subprocess.run(["orrery","holder","Atlas"])'`],
		["the recorder by a glob of the program", "~/.local/bin/orr*y holder Atlas"],
		["the recorder by a bracket glob of the program", "orre[r]y holder Atlas"],
		["the recorder by a glob of brackets", "~/.local/bin/[o]* holder Atlas"],
		["the recorder by a negated bracket naming a capital", "ORRE[!R]Y holder Atlas"],
		// Text that names both for another reason: the price of reading them in either order.
		["holder beside one of Orrery's own commands", "orrery status; echo holder"],
	])("refuses %s in every gate", (_what, command) => {
		expect(verdicts(command)).toEqual(Array(10).fill(PLUMBING));
	});

	it.each([
		["Orrery's own commands", "orrery status && orrery status Atlas --json && orrery help agent && orrery usage --days 3"],
		["the summary model's switch", "orrery compactor Atlas"],
		["the Orrery mod's view, which only reads", "orrery claude-mod view --cwd ."],
		["a holder that is not Orrery's", "cat placeholder.txt; grep -n holder notes.md; ls holder"],
		["a folder named orrery", "ls ~/src/orrery/holder.ts && cd orrery-holder"],
		["holder as a path's part beside Orrery", "ls /tmp/holder && orrery status"],
		["a hook's name inside a longer word", "npm test test/cli/codex-hook.test.ts && cat claude-hooks.md"],
		// Documented limits, as for every shell-text rule: names built at run time or read from a file.
		["a hook's name built from a variable", "o=codex; orrery $o-hook stop"],
		["arguments read from a file", "xargs -a args.txt orrery"],
	])("leaves %s alone", (_what, command) => {
		expect(verdicts(command)).toEqual(Array(10).fill(undefined));
	});
});
