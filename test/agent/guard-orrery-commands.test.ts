import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { describe, expect, it } from "vitest";
import { checkResolvedPath, durablePreCheck } from "../../src/agent/guard.ts";
import { guardOmpToolCall, guardToolCall, type PathGuardOptions, realTarget } from "../../src/agent/guard-paths.ts";
import {
	ORRERY_COMMAND_REFUSED,
	ORRERY_COMMANDS,
	ORRERY_OPTIONS,
	REFUSED_COMMANDS,
	runsOrreryCommand,
	TRANSCRIPT_COMMAND,
	transcriptRule,
} from "../../src/agent/guard-rules.ts";
import { ALLOWED_INSIDE } from "../../src/agent/inside-commands.ts";
import { claudeGuard } from "../../src/claude/guard.ts";
import { HELP_COMMANDS } from "../../src/cli/help.ts";
import { codexGuard } from "../../src/codex/guard.ts";
import { openCodeGuard } from "../../src/opencode/guard.ts";
import { ctx, tempDir } from "./support.ts";

/**
 * Orrery's commands that change memory or settings (spec 2026-10-18-agent-permissions §4) are refused in shell text in
 * every gate, as a second belt beside the CLI's own gate: Orrery's program followed, as the first word that is no
 * option, by one the CLI knows that does not run inside an agent session. Shell text naming Claude Code's or Codex's
 * session records (what Orrery checks a prompt against, §3c) is refused too, and so are file-tool writes there; reads
 * stay open.
 */

const SESSION_RECORDS = /Claude Code's or Codex's session records/;

/**
 * A scratch home, an agent's folder, a moved Claude Code config folder and Codex home (the gate's CLAUDE_CONFIG_DIR and
 * CODEX_HOME), and the guard's options: writes allowed under home, so only the session-records rule refuses one there.
 * `linked`: a home with capitals, as macOS's (/Users/Alex), the moved folders under it, and its ~/.claude a link to a
 * folder elsewhere (store), the rule made with links followed, as the gates make it.
 */
function world(linked = false) {
	const root = realpathSync(tempDir("orrery-commands-"));
	const folder = join(root, "ws");
	const home = linked ? join(root, "Users", "Alex") : join(root, "home");
	const store = join(root, "Store", "Claude");
	const claudeConfig = linked ? join(home, ".config", "claude") : join(root, "cc");
	const codexHome = linked ? join(home, ".config", "codex") : join(root, "codex-home");
	for (const dir of [folder, home, join(store, "projects"), join(claudeConfig, "projects"), join(codexHome, "sessions")]) mkdirSync(dir, { recursive: true });
	if (linked) symlinkSync(store, join(home, ".claude"));
	const transcripts = transcriptRule({ CLAUDE_CONFIG_DIR: claudeConfig, CODEX_HOME: codexHome }, home, linked ? realTarget : undefined);
	const options: PathGuardOptions = { folder, allowedRoots: [home, claudeConfig, codexHome, join(root, "Store")], cwd: folder, home, foreignViews: [], transcripts };
	return { root, folder, home, store, claudeConfig, codexHome, options };
}

type World = ReturnType<typeof world>;

/**
 * Every gate's verdict on one command line: pi's bash (with and without a path), OMP's bash and eval, Claude Code's Bash
 * and an MCP shell, Codex's shell, orrery run, OpenCode's shell, Code Mode program and an MCP shell.
 */
function verdicts(command: string | ((w: World) => string), make: () => World = world): (string | undefined)[] {
	const w = make();
	const text = typeof command === "string" ? command : command(w);
	const { options } = w;
	try {
		return [
			guardToolCall("bash", { command: text }, options),
			guardToolCall("bash", { command: text, path: "." }, options),
			guardOmpToolCall("bash", { command: text }, options),
			guardOmpToolCall("eval", { language: "sh", code: text }, options),
			claudeGuard("Bash", { command: text }, options),
			claudeGuard("mcp__shell__run", { command: text }, options),
			codexGuard("Bash", { command: text }, options),
			durablePreCheck({ name: "bash", arguments: { command: text } }, options),
			openCodeGuard("shell", { command: text }, options),
			openCodeGuard("execute", { code: text }, options),
			openCodeGuard("box_run", { command: text }, options),
		];
	} finally {
		rmSync(w.root, { recursive: true, force: true });
	}
}

const GATES = 11;

/** Every file tool's write of `path` in every gate: pi's write and edit, OMP's write, Claude Code's Write and Edit, Codex's patch, orrery run's, OpenCode's write. */
function writes(path: string | ((w: World) => string), make: () => World = world): (string | undefined)[] {
	const w = make();
	const file = typeof path === "string" ? path : path(w);
	const { options } = w;
	try {
		return [
			guardToolCall("write", { path: file, content: "x" }, options),
			guardToolCall("edit", { path: file, edits: [{ oldText: "a", newText: "b" }] }, options),
			guardOmpToolCall("write", { path: file, content: "x" }, options),
			claudeGuard("Write", { file_path: file, content: "x" }, options),
			claudeGuard("Edit", { file_path: file, old_string: "a", new_string: "b" }, options),
			codexGuard("apply_patch", { command: ["*** Begin Patch", `*** Add File: ${file}`, "+x", "*** End Patch"].join("\n") }, options),
			durablePreCheck({ name: "write", arguments: { path: file, content: "x" } }, options),
			openCodeGuard("write", { path: file, content: "x" }, options),
		];
	} finally {
		rmSync(w.root, { recursive: true, force: true });
	}
}

/** Every file tool's read of `path` in every gate. */
function reads(path: (w: World) => string): (string | undefined)[] {
	const w = world();
	const file = path(w);
	const { options } = w;
	try {
		return [
			guardToolCall("read", { path: file }, options),
			guardOmpToolCall("read", { path: file }, options),
			claudeGuard("Read", { file_path: file }, options),
			durablePreCheck({ name: "read", arguments: { path: file } }, options),
			openCodeGuard("read", { path: file }, options),
		];
	} finally {
		rmSync(w.root, { recursive: true, force: true });
	}
}

describe("the commands the guard knows", () => {
	it("are the CLI's: help and every command with help (main.ts sends any other word to Unknown command)", () => {
		expect([...ORRERY_COMMANDS].sort()).toEqual(["help", ...HELP_COMMANDS].sort());
	});

	it("hold every command main.ts dispatches", () => {
		const main = readFileSync(join(import.meta.dirname, "../../src/cli/main.ts"), "utf8");
		const dispatched = [...main.matchAll(/\bcommand === "([a-z-]+)"|\bcase "([a-z-]+)":/g)].map((match) => match[1] ?? match[2]);
		expect(dispatched.length).toBeGreaterThan(20);
		for (const command of dispatched) expect(ORRERY_COMMANDS).toContain(command);
	});

	it("refuse every one that does not run inside an agent session, but version, which prints before any command runs", () => {
		expect([...REFUSED_COMMANDS].sort()).toEqual(
			["agent", "backup", "claude-setup", "compact", "import", "install", "login", "logins", "logout", "remote", "restore", "run", "setup", "tools", "trust-host", "uninstall", "update"].sort(),
		);
		expect(ORRERY_COMMANDS.filter((command) => !REFUSED_COMMANDS.includes(command)).sort()).toEqual([...ALLOWED_INSIDE, "version"].sort());
	});

	it("know main.ts's options: which take the next word as their value, and which are flags", () => {
		const main = readFileSync(join(import.meta.dirname, "../../src/cli/main.ts"), "utf8");
		const block = /const OPTIONS = \{([^]*?)\n\} as const;/.exec(main)?.[1] ?? "";
		const valued = [...block.matchAll(/^\t"?([a-z-]+)"?: \{ type: "string"/gm)].map((match) => `--${match[1]}`);
		const flags = [...block.matchAll(/^\t"?([a-z-]+)"?: \{ type: "boolean"(?:, short: "([a-z])")?/gm)].flatMap((match) => [`--${match[1]}`, ...(match[2] ? [`-${match[2]}`] : [])]);
		expect(valued.length).toBeGreaterThan(30);
		expect([...ORRERY_OPTIONS.valued].sort()).toEqual(valued.sort());
		expect([...ORRERY_OPTIONS.flags].sort()).toEqual(flags.sort());
	});
});

describe("runsOrreryCommand", () => {
	it("names the command shell text runs that agents may not", () => {
		expect(runsOrreryCommand("orrery restore Atlas --from /tmp/x")).toBe("restore");
		expect(runsOrreryCommand("cd /w && ORRERY_HOME=/tmp/x orrery --config /tmp/c.toml setup --yes")).toBe("setup");
		expect(runsOrreryCommand("orrery status; orrery remote key home")).toBe("remote");
	});

	it("names none for Orrery's own commands that run inside a session, or for no command", () => {
		for (const text of ["orrery", "orrery status", "orrery help setup", "ls ~/src/orrery", "git status"]) expect([text, runsOrreryCommand(text)]).toEqual([text, undefined]);
	});
});

describe("Orrery's commands in shell text", () => {
	it.each([
		// The brief's cases.
		["orrery restore Atlas --from /tmp/x", "restore"],
		["orrery agent set Atlas --reads all", "agent"],
		["orrery remote key home", "remote"],
		["ORRERY_HOME=/tmp/x orrery setup --yes", "setup"],
		["/home/u/.local/bin/orrery import --commit f", "import"],
		["x; orrery run Atlas", "run"],
		// Every one of them.
		["orrery agent Atlas", "agent"],
		["orrery compact Atlas", "compact"],
		["orrery import Atlas --dry-run", "import"],
		["orrery backup --keep 3", "backup"],
		["orrery login openai", "login"],
		["orrery logins --json", "logins"],
		["orrery logout openai", "logout"],
		["orrery trust-host mac", "trust-host"],
		["orrery remote test home", "remote"],
		["orrery update --check", "update"],
		["orrery tools install pi", "tools"],
		["orrery claude-setup Atlas", "claude-setup"],
		["orrery install --from /tmp/r --yes", "install"],
		["orrery uninstall --purge", "uninstall"],
		// After options main.ts knows, their values skipped.
		["orrery --config /tmp/c.toml restore Atlas", "restore"],
		["orrery --config=/tmp/c.toml setup", "setup"],
		["orrery --json --yes remote agents home", "remote"],
		["orrery -- install --yes", "install"],
		["orrery --config 'a b' update", "update"],
		["orrery --config ';' setup", "setup"],
		["orrery --config 'a|b' setup", "setup"],
		["orrery --tool codex agent Atlas", "agent"],
		["orrery setup --help", "setup"],
		// Redirections before the command.
		["orrery 2>&1 setup", "setup"],
		["orrery >/dev/null 2>&1 uninstall", "uninstall"],
		["orrery < /dev/null update", "update"],
		// However Orrery's program is reached.
		["orrery-run agent set Atlas --reads all", "agent"],
		["~/.claude/plugins/x/bin/orrery-run remote key home", "remote"],
		["orrery.exe tools install pi", "tools"],
		["node src/cli/main.ts import Atlas --dry-run", "import"],
		["bun cli/main.ts setup", "setup"],
		["env ORRERY_CONFIG=/x orrery update", "update"],
		["command orrery login openai", "login"],
		["exec orrery logout openai", "logout"],
		["sudo -u me orrery backup", "backup"],
		["$(which orrery) restore Atlas --from x", "restore"],
		['"$(command -v orrery)" backup', "backup"],
		["`which orrery` compact Atlas", "compact"],
		["echo setup | xargs orrery", "setup"],
		["printf 'Atlas\\n' | xargs orrery restore", "restore"],
		["python3 -c \"import subprocess; subprocess.run(['orrery', 'setup'])\"", "setup"],
		["sh -c 'orrery update'", "update"],
		["git -c alias.x='!orrery setup' x", "setup"],
		// By any spelling the readings know.
		["'orrery' \"setup\"", "setup"],
		["orrery se''tup", "setup"],
		["orrery s\\etup", "setup"],
		["orrery $'\\x73etup'", "setup"],
		["Orrery SETUP", "setup"],
		["orrery {setup,x}", "setup"],
		['orrery"" setup', "setup"],
		["orrery setup;ls", "setup"],
		["orrery setup&", "setup"],
		["(orrery update)", "update"],
		// Where the guard can't tell where the options end, any refused command word before the next separator.
		["orrery --unknown x setup", "setup"],
		["orrery $x setup", "setup"],
		["orrery --config $c setup", "setup"],
		["orrery $(echo) setup", "setup"],
		["orrery ${x}setup", "setup"],
		["orrery `true` setup", "setup"],
		["orrery --config ';' $x setup", "setup"],
		// Text that only names one: the price of the blunt style (CONTRIBUTING: the Grep tool, git commit -F).
		['git commit -m "orrery setup now asks first"', "setup"],
		['grep -rn "orrery update" docs', "update"],
	])("refuses %s in every gate", (command, refused) => {
		expect(verdicts(command)).toEqual(Array(GATES).fill(ORRERY_COMMAND_REFUSED(refused)));
	});

	it.each([
		// The brief's and the ruling's cases.
		["orrery status"],
		["orrery browse . --open"],
		["orrery --version"],
		["orrery help"],
		["ls"],
		["git status"],
		["cat README.md"],
		// Bare orrery has no terminal in an agent's shell: it prints help (and the CLI's gate refuses the TUI).
		["orrery"],
		["orrery; ls"],
		["cd ~/src/orrery && npm run check"],
		["git -C ~/src/orrery log"],
		["ls ~/src/orrery"],
		// Orrery's commands that run inside a session, and help on any.
		["orrery status Atlas --json && orrery usage --days 3 && orrery compactor ."],
		["orrery claude-mod view --cwd ."],
		["orrery mcp --tool codex"],
		["orrery help setup && orrery help all"],
		["orrery version && orrery -v && orrery -h"],
		["orrery --config /tmp/c.toml status ."],
		["orrery-run status . && orrery-run browse . --open"],
		// A word that is no command, an option's value, or a later command that is not Orrery's.
		["orrery setup.md"],
		["orrery foo setup"],
		["orrery --config setup status"],
		["orrery status; echo setup"],
		["orrery status | grep update"],
		["orrery\nsetup"],
		// Orrery named for other reasons: a folder, a file, a word.
		["which orrery && file $(which orrery) && orrery --version"],
		["cat claude-plugin/bin/orrery-run"],
		["npm test -- test/agent/guard-orrery-commands.test.ts"],
		["grep -rn 'orrery (setup|install)' docs"],
		["echo \"Orrery's agent set is in the TUI\""],
		["git log --oneline -- src/cli/main.ts src/agent/backup.ts"],
		["ls ~/src/orrery/setup"],
		["rsync -a ~/src/orrery remote:/srv"],
		// A checkout of Orrery as the folder git, make or a package manager works in.
		["git -C ~/src/orrery remote -v"],
		["git -C ~/src/orrery restore src/x.ts"],
		["npm --prefix ~/src/orrery run check"],
		["bun --cwd=/w/orrery run test"],
		["make -C orrery install"],
		['gh pr create -R owner/orrery --title "Agent permissions" --body-file pr.md'],
		// Documented limits, as for every shell-text rule: a name built at run time, arguments read from a file.
		["o=orrery; $o setup"],
		["xargs -a args.txt orrery"],
	])("leaves %s alone", (command) => {
		expect(verdicts(command)).toEqual(Array(GATES).fill(undefined));
	});

	it("keeps the hook plumbing's own message for the plumbing", () => {
		expect(verdicts("orrery codex-hook stop")).toEqual(Array(GATES).fill(expect.stringMatching(/hook plumbing/)));
		expect(verdicts("orrery holder Atlas --session s")).toEqual(Array(GATES).fill(expect.stringMatching(/hook plumbing/)));
	});

	it.each([
		// A folder option takes Orrery's name only as the tool's own: git's and make's -C, npm's --prefix, pnpm's --dir,
		// yarn's and bun's --cwd, gh's -R and --repo. Another tool's -c runs a command (npm exec -c, pnpm exec -c).
		["git -C x orrery setup", "setup"],
		["npm --prefix x exec orrery setup", "setup"],
		["env -C /tmp orrery setup", "setup"],
		["npm exec -c 'orrery restore Atlas --from x'", "restore"],
		['npm exec -c "orrery remote key home"', "remote"],
		["npm -c 'orrery setup --yes' exec", "setup"],
		["pnpm exec -c 'orrery restore Atlas'", "restore"],
		["pnpm exec -c orrery restore Atlas", "restore"],
		["pnpm exec -r orrery restore Atlas", "restore"],
		["bun -r orrery restore", "restore"],
		["yarn -c orrery restore", "restore"],
		["make -r orrery restore", "restore"],
		["npm -C ~/src/orrery run check", "run"],
		["pnpm --prefix ~/src/orrery run check", "run"],
		["gh --cwd owner/orrery run list", "run"],
	])("refuses %s past a folder option that is not that tool's, in every gate", (command, refused) => {
		expect(verdicts(command)).toEqual(Array(GATES).fill(ORRERY_COMMAND_REFUSED(refused)));
	});

	it.each([
		["pnpm --dir ~/src/orrery install"],
		["yarn --cwd ~/src/orrery run build"],
		["make --directory=orrery install"],
		["gh pr view 12 --repo owner/orrery"],
		["gh run list -R owner/orrery"],
	])("leaves %s alone (the tool's own folder option)", (command) => {
		expect(verdicts(command)).toEqual(Array(GATES).fill(undefined));
	});

	it.each([
		// A list: a brace group, or code's list of arguments without a blank after the comma.
		["{orrery,restore}", "restore"],
		["{~/.local/bin/orrery,remote,key,home}", "remote"],
		["{orrery,--config,x,setup,--yes}", "setup"],
		[`python3 -c 'import subprocess;subprocess.run(["orrery","restore"])'`, "restore"],
		[`node -e 'require("child_process").execFileSync("orrery",["restore"])'`, "restore"],
		[`python3 -c 'import os;os.execvp("orrery",["orrery","restore"])'`, "restore"],
		[`perl -e 'exec "orrery","restore"'`, "restore"],
		[`ruby -e 'system("orrery","restore")'`, "restore"],
		// A glob that could name the program, or a refused command in the command's place.
		["~/.local/bin/orr*y restore", "restore"],
		["orre[r]y restore", "restore"],
		["orrer? restore", "restore"],
		["/usr/local/bin/orrery-r?n setup", "setup"],
		["orrery re*ore", "restore"],
		["orrery rest?re Atlas", "restore"],
		["orrery [r]estore Atlas", "restore"],
		["orrery --config x upd[a-z]te", "update"],
		// A separator in quotes is no separator where the guard fails closed.
		["orrery --config $x ';' restore", "restore"],
		["orrery $x '|' restore", "restore"],
		// A redirection from a named file descriptor; parallel, as xargs.
		["orrery {fd}>/dev/null restore", "restore"],
		["parallel orrery ::: restore", "restore"],
	])("refuses %s in every gate", (command, refused) => {
		expect(verdicts(command)).toEqual(Array(GATES).fill(ORRERY_COMMAND_REFUSED(refused)));
	});

	it.each([
		["ls *.ts && orrery status"],
		["orrery status *"],
		["tr '[:upper:]' '[:lower:]' < setup.txt"],
		["grep -n '[[:space:]]$' install.sh"],
		["jq '.[] | .name' setup.json"],
		["ls ~/.local/bin/orrery* && orrery --version"],
		["cp * backup/"],
		// Wildcards alone are no name of the program: a patch's headers (Codex sends its patches through the shell), bullets.
		["apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: notes.md\n@@\n-a\n+b\n*** End Patch\nEOF"],
		["printf '%s\\n' '* install the tools' '* update the docs'"],
		["ls ?????? run"],
	])("leaves %s alone (globs that can't name a refused command)", (command) => {
		expect(verdicts(command)).toEqual(Array(GATES).fill(undefined));
	});

	it("refuses the plumbing by a list or a glob of the program, with its own message", () => {
		for (const command of ["{orrery,holder,Atlas}", "~/.local/bin/orr*y holder Atlas"]) {
			expect(verdicts(command)).toEqual(Array(GATES).fill(expect.stringMatching(/hook plumbing/)));
		}
	});

	it("names --version among what runs, in its message", () => {
		expect(ORRERY_COMMAND_REFUSED("setup")).toMatch(/help, status, usage, browse, compactor and --version run here/);
	});

	it("judges a long command line in time: the rule, and one gate's whole call (Claude Code's hook gives a call 2 s)", () => {
		const star = "*a".repeat(127);
		const w = world();
		try {
			for (const long of [
				`${"orrery --config orrery ".repeat(2000)}status; ${"orrery '".repeat(2000)}; ${"orrery $(orrery ".repeat(1500)}`,
				`${star} `.repeat(250),
				`${"[".repeat(256)} `.repeat(250),
				`${"[[:".repeat(20000)}`,
				`${"o* ".repeat(20000)}`,
				`orrery ${"[a]".repeat(20000)}`,
				`~/.c*/${star}/`.repeat(250),
			]) {
				let started = performance.now();
				expect(runsOrreryCommand(long)).toBeUndefined();
				expect(performance.now() - started).toBeLessThan(2000);
				started = performance.now();
				expect(guardToolCall("bash", { command: long }, w.options)).toBeUndefined();
				expect(performance.now() - started).toBeLessThan(2000);
			}
		} finally {
			rmSync(w.root, { recursive: true, force: true });
		}
		// Past the length any name has, a glob still names the program where it could.
		expect(runsOrreryCommand(`${"x/".repeat(30000)}orr${"*".repeat(300)}y setup`)).toBe("setup");
	});
});

describe("Claude Code's and Codex's session records", () => {
	it.each([
		["echo hi >> ~/.claude/projects/p/s.jsonl"],
		["cat > ~/.codex/sessions/2026/x.jsonl"],
		["cat $HOME/.claude/projects/p/s.jsonl"],
		["ls ${HOME}/.codex/sessions"],
		["tail -f /home/u/.claude/projects/-w/s.jsonl"],
		["grep -r prompt ~/.claude/projects/"],
		["cd ~ && cat .claude/projects/p/s.jsonl"],
		["ls ~/.claude/proj''ects"],
		["ls ~/.Claude/Projects"],
		["ls ~/.claude/{projects,x}"],
		["ls ~/.claude//projects"],
		["ls ~/.codex/sessions*"],
		["cat $CLAUDE_CONFIG_DIR/projects/p/s.jsonl"],
		["ls ${CODEX_HOME}/sessions"],
		["ls ${CODEX_HOME:-~/.codex}/sessions"],
	])("refuses shell text naming them, %s, in every gate", (command) => {
		expect(verdicts(command)).toEqual(Array(GATES).fill(TRANSCRIPT_COMMAND));
	});

	it("refuses shell text naming the moved folders by their paths (the gate's CLAUDE_CONFIG_DIR and CODEX_HOME)", () => {
		expect(verdicts((w) => `cat ${w.claudeConfig}/projects/p/s.jsonl`)).toEqual(Array(GATES).fill(TRANSCRIPT_COMMAND));
		expect(verdicts((w) => `echo x >> ${w.codexHome}/sessions/2026/r.jsonl`)).toEqual(Array(GATES).fill(TRANSCRIPT_COMMAND));
		expect(verdicts((w) => `ls ${w.claudeConfig} ${w.codexHome}`)).toEqual(Array(GATES).fill(undefined));
	});

	it.each([["ls ~/.claude/plans ~/.claude ~/.codex"], ["cat docs/projects.md src/sessions.ts"], ["ls ~/.claude/projects-old"], ["grep -rn sessions src"]])("leaves %s alone", (command) => {
		expect(verdicts(command)).toEqual(Array(GATES).fill(undefined));
	});

	it.each([
		["cat ~/.claude/pro*/p/s.jsonl"],
		["echo x >> ~/.c*/projects/p/s.jsonl"],
		["ls ~/.codex/sess*"],
		["ls ~/.claude/*"],
		["ls ~/.claude/[p]rojects"],
		["ls ~/.cl?ude/projects"],
		["ls ~/.c*/sess*"],
		["ls $CLAUDE_CONFIG_DIR/proj?cts"],
		["ls ${CODEX_HOME}/s*"],
	])("refuses a glob that could name them beside their parent's name, %s, in every gate", (command) => {
		expect(verdicts(command)).toEqual(Array(GATES).fill(TRANSCRIPT_COMMAND));
	});

	it.each([
		["ls ~/.claude/*.json ~/.codex/*.toml"],
		["ls ~/*/projects"],
		["ls ~/.claude/plans/*"],
		["ls ~/projects/* ~/sessions/*"],
		["ls ~/.claude/pro*.md"],
	])("leaves %s alone (a glob that can't name them there; text naming both is no reason)", (command) => {
		expect(verdicts(command)).toEqual(Array(GATES).fill(undefined));
	});

	it("spells moved folders from a home with capitals (macOS's /Users/…), and a ~/.claude that is a link by where it leads", () => {
		const linked = () => world(true);
		for (const command of [
			"cat ~/.config/claude/projects/p/s.jsonl",
			"cat $HOME/.config/codex/sessions/x.jsonl",
			"cat ${HOME}/.config/claude/projects/p/s.jsonl",
			(w: World) => `cat ${w.home}/.config/codex/sessions/x.jsonl`,
			(w: World) => `echo x >> ${w.store}/projects/p/s.jsonl`,
		]) {
			expect(verdicts(command, linked)).toEqual(Array(GATES).fill(TRANSCRIPT_COMMAND));
		}
		expect(verdicts((w: World) => `ls ${w.store} ~/.config`, linked)).toEqual(Array(GATES).fill(undefined));
		for (const path of [(w: World) => join(w.store, "projects", "-w", "s.jsonl"), (w: World) => join(w.claudeConfig, "projects", "-w", "s.jsonl"), (w: World) => join(w.home, ".claude", "projects", "-w", "s.jsonl")]) {
			expect(writes(path, linked)).toEqual(Array(8).fill(expect.stringMatching(SESSION_RECORDS)));
		}
		expect(writes((w: World) => join(w.store, "projects", "-w", "memory", "MEMORY.md"), linked)).toEqual(Array(8).fill(undefined));
	});

	it("refuses a write through a linked ~/.claude in orrery run's own check, where it leads", async () => {
		const w = world(true);
		try {
			const env = new NodeExecutionEnv({ cwd: w.folder });
			// No rule handed in: orrery run makes its own, the folders followed where they lead.
			const { transcripts: _, ...options } = w.options;
			expect(await checkResolvedPath(env, join(w.store, "projects", "-w", "s.jsonl"), "write", options, ctx)).toMatch(SESSION_RECORDS);
			expect(await checkResolvedPath(env, join(w.store, "projects", "-w", "memory", "MEMORY.md"), "write", options, ctx)).toBeUndefined();
		} finally {
			rmSync(w.root, { recursive: true, force: true });
		}
	});

	it("refuses a file tool's write there in every gate", () => {
		for (const path of [
			(w: World) => join(w.home, ".claude", "projects", "-w", "s.jsonl"),
			(w: World) => join(w.home, ".codex", "sessions", "2026", "x.jsonl"),
			(w: World) => join(w.claudeConfig, "projects", "-w", "s.jsonl"),
			(w: World) => join(w.codexHome, "sessions", "2026", "x.jsonl"),
			(w: World) => join(w.home, ".claude", "projects", "-w", "memory", "..", "s.jsonl"),
		]) {
			expect(writes(path)).toEqual(Array(8).fill(expect.stringMatching(SESSION_RECORDS)));
		}
	});

	it("leaves a file tool's read there open, and a project's memory folder (Claude Code's auto memory) writable", () => {
		expect(reads((w) => join(w.home, ".claude", "projects", "-w", "s.jsonl"))).toEqual(Array(5).fill(undefined));
		expect(reads((w) => join(w.codexHome, "sessions", "2026", "x.jsonl"))).toEqual(Array(5).fill(undefined));
		expect(writes((w) => join(w.home, ".claude", "projects", "-w", "memory", "MEMORY.md"))).toEqual(Array(8).fill(undefined));
		expect(writes((w) => join(w.claudeConfig, "projects", "-w", "memory", "notes.md"))).toEqual(Array(8).fill(undefined));
	});

	it("keeps a write outside the agent's roots refused as outside them", () => {
		const outside = writes((w) => join(w.root, "elsewhere", ".claude", "projects", "-w", "memory", "MEMORY.md"));
		expect(outside).toEqual(Array(8).fill(expect.stringMatching(/outside this agent's folder/)));
	});

	it("refuses the write in orrery run's own check too (checkResolvedPath), and leaves the read", async () => {
		const w = world();
		try {
			const env = new NodeExecutionEnv({ cwd: w.folder });
			const transcript = join(w.home, ".claude", "projects", "-w", "s.jsonl");
			expect(await checkResolvedPath(env, transcript, "write", w.options, ctx)).toMatch(SESSION_RECORDS);
			expect(await checkResolvedPath(env, join(w.codexHome, "sessions", "x.jsonl"), "write", w.options, ctx)).toMatch(SESSION_RECORDS);
			expect(await checkResolvedPath(env, transcript, "read", w.options, ctx)).toBeUndefined();
			expect(await checkResolvedPath(env, join(w.home, ".claude", "projects", "-w", "memory", "MEMORY.md"), "write", w.options, ctx)).toBeUndefined();
		} finally {
			rmSync(w.root, { recursive: true, force: true });
		}
	});
});
