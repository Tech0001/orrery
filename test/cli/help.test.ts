import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HELP_COMMANDS, PLUGIN_COMMANDS, SHORT_WIDTH, shortHelp, WIDTH } from "../../src/cli/help.ts";
import { cleanEnv, cliCommand } from "../claude/support.ts";
import { systemCommand } from "../install/support.ts";
import { agentConfigToml, tempDir } from "../agent/support.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const VERSION = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
const SCRIPT = systemCommand("script");
const hasScript = process.platform === "linux" && SCRIPT !== undefined && spawnSync(SCRIPT, ["--version"]).status === 0;
const quote = (part: string) => `'${part.replace(/'/g, `'\\''`)}'`;

/** The commands main.ts dispatches (`command === "x"`, `case "x":`), read from its source; help itself aside. */
const DISPATCHED = [
	...new Set([...readFileSync(join(ROOT, "src", "cli", "main.ts"), "utf8").matchAll(/command === "([a-z-]+)"|case "([a-z-]+)":/g)].map((m) => (m[1] ?? m[2]) as string)),
]
	.filter((command) => command !== "help")
	.sort();

/** Commands people use that only `orrery help all` shows: the short page is the one the user approved. */
const DETAIL_ONLY = ["trust-host", "version"];

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A scratch HOME with no config anywhere. */
function emptyHome(): NodeJS.ProcessEnv {
	const home = tempDir("orrery-help-");
	dirs.push(home);
	return cleanEnv({ HOME: home, ORRERY_HOME: join(home, ".orrery"), ORRERY_CONFIG: join(home, "missing.toml") });
}

/** What HOME holds after the runs, less what the runtime makes in any HOME (Bun's .bun, macOS's Library). */
const made = (env: NodeJS.ProcessEnv) => readdirSync(env.HOME as string).filter((name) => name !== ".bun" && name !== "Library");

function orrery(env: NodeJS.ProcessEnv, ...args: string[]) {
	const c = cliCommand(args);
	return spawnSync(c.cmd, c.args, { env, encoding: "utf8", timeout: 20_000 });
}

/** The words of a line's usage column (the whole line when its usage runs past the text column). */
const usageWords = (line: string) => (line.length > 28 && line.slice(26, 28) === "  " ? line.slice(0, 28) : line).split(/[\s,|]+/).filter(Boolean);

describe("orrery help", () => {
	it("finds the dispatcher's commands, and has help for each of them and no other", () => {
		expect(DISPATCHED.length).toBeGreaterThan(20);
		expect([...HELP_COMMANDS].sort()).toEqual(DISPATCHED);
	});

	it("prints the short page for --help, -h, help and a plain orrery off a terminal: within 80 columns, every command people use, none the plugins run", () => {
		const env = emptyHome();
		const page = orrery(env, "--help");
		expect(page.status, page.stderr).toBe(0);
		for (const args of [["-h"], ["help"], []]) expect(orrery(env, ...args).stdout, args.join(" ")).toBe(page.stdout);
		const lines = page.stdout.trimEnd().split("\n");
		expect(lines[0]).toMatch(new RegExp(`^Orrery ${VERSION.replace(/\./g, "\\.")}(-[0-9a-f]+)?: long-lived memory for coding agents$`));
		expect(lines.filter((line) => line.length > SHORT_WIDTH)).toEqual([]);
		expect(shortHelp(undefined).split("\n").filter((line) => line.length > SHORT_WIDTH)).toEqual([]);
		const shown = new Set(lines.flatMap(usageWords));
		const people = DISPATCHED.filter((command) => !PLUGIN_COMMANDS.includes(command) && !DETAIL_ONLY.includes(command));
		expect(people.filter((command) => !shown.has(command))).toEqual([]);
		expect([...PLUGIN_COMMANDS].sort()).toEqual(["claude-hook", "claude-mod", "codex-hook", "holder", "mcp"]);
		expect(PLUGIN_COMMANDS.filter((command) => new RegExp(`(^|[^\\w-])${command}([^\\w-]|$)`, "m").test(page.stdout))).toEqual([]);
		expect(page.stdout).toContain("\norrery help <command>       every option for one command\norrery help all             the full list, incl. what the plugins run\n");
	});

	it("help all lists every command the CLI dispatches, the plugins' last, wrapped at 100 columns and aligned", () => {
		const all = orrery(emptyHome(), "help", "all");
		expect(all.status, all.stderr).toBe(0);
		const lines = all.stdout.trimEnd().split("\n");
		expect(lines.filter((line) => line.length > WIDTH)).toEqual([]);
		const starts = new Set(lines.filter((line) => /^ {2}\S/.test(line)).map((line) => usageWords(line)[0]));
		expect(DISPATCHED.filter((command) => !starts.has(command))).toEqual([]);
		const plugins = lines.indexOf("Run by the plugins");
		expect(plugins).toBeGreaterThan(lines.indexOf("Install"));
		for (const command of PLUGIN_COMMANDS) expect(lines.findIndex((line) => line.startsWith(`  ${command} `) || line === `  ${command}`), command).toBeGreaterThan(plugins);
		// A text line continues at the text column; a usage line at 2, or 6 when it wraps.
		for (const line of lines) if (line.startsWith(" ")) expect([2, 6, 28], line).toContain(line.length - line.trimStart().length);
		expect(all.stdout).toContain('An agent named "." (status, usage, browse, compactor, claude-setup)');
		expect(all.stdout).toContain("Config: --config FILE, $ORRERY_CONFIG");
		expect(all.stdout).toContain("Inside an agent's session (its shell, or a ! command typed in its tool) only help, --version,");
		// The notes as one text, whatever the wrapping.
		const text = all.stdout.replace(/\s+/g, " ");
		expect(text).toContain("the agent it was opened as; elsewhere (in your own terminal) ORRERY_AGENT, else the agent whose folder holds the current folder.");
		expect(text).toContain(
			"In a coding tool's session that is no agent's (Claude Code, Codex, pi or another coding tool started outside your agents) only help, --version, status and usage run, and they show no agent; run the rest in your own terminal or the TUI.",
		);
	});

	it("help <command> and <command> --help print every line of that command, and nothing runs", () => {
		const env = emptyHome();
		const remote = orrery(env, "help", "remote");
		expect(remote.status, remote.stderr).toBe(0);
		expect(remote.stdout).toContain("  remote add <name> --server <host>:<folder> | --cloudflare <url>");
		expect(remote.stdout).toContain("  remote remove <name> --yes");
		expect(remote.stdout).not.toContain("agent push");
		for (const args of [["remote", "--help"], ["remote", "add", "home", "--server", "h:f", "--help"], ["--config", "x.toml", "remote", "-h"]]) {
			expect(orrery(env, ...args).stdout, args.join(" ")).toBe(remote.stdout);
		}
		const agent = orrery(env, "agent", "Atlas", "--help");
		expect(agent.status, agent.stderr).toBe(0);
		for (const usage of ["agent <Name> [--tool", "agent add <Name>", "agent set <Name>", "agent push <Name>", "agent local <Name>"]) expect(agent.stdout).toContain(`  ${usage}`);
		expect(agent.stdout).toContain("--reads all|none|A,B");
		expect(orrery(env, "help", "status").stdout).toContain('An agent named "."');
		expect(orrery(env, "help", "compact").stdout).not.toContain('An agent named "."');
		// No config was read or written, no folder made.
		expect(made(env)).toEqual([]);
	});

	it("an unknown command or help topic says so and prints the short page", () => {
		const env = emptyHome();
		for (const args of [["help", "nope"], ["nope"], ["nope", "--help"]]) {
			const r = orrery(env, ...args);
			expect(r.status, args.join(" ")).toBe(2);
			expect(r.stdout).toBe("");
			expect(r.stderr).toMatch(/^Unknown command nope\.\n\nOrrery /);
			expect(r.stderr).toContain("orrery help all");
		}
	});

	it("a command used the wrong way prints its message, then that command's help", () => {
		const env = emptyHome();
		const dir = tempDir("orrery-help-config-");
		dirs.push(dir);
		const config = join(dir, "config.toml");
		writeFileSync(config, agentConfigToml({ dataDir: join(dir, "data"), folder: join(dir, "ws") }));
		const compact = orrery(env, "compact", "--config", config);
		expect(compact.status).toBe(1);
		expect(compact.stderr).toMatch(/^Missing agent\.\n\n {2}compact <Name> \[--progress FILE\]\n/);
		const remote = orrery(env, "remote");
		expect(remote.status).toBe(1);
		expect(remote.stderr).toMatch(/^Use orrery remote add\|test\|key\|log\|agents\|remove <name>\. Lists and logs accept --json\.\n\n {2}remote add /);
		const restore = orrery(env, "restore", "Test", "--config", config);
		expect(restore.stderr).toContain("restore needs --from DATE (YYYY-MM-DD) or --from DIR.\n\n  restore <Name> --from DATE|DIR");
	});

	it.skipIf(!hasScript)("--help and help in a terminal print the page, never the TUI", () => {
		const env = emptyHome();
		for (const args of [["--help"], ["help"]]) {
			const c = cliCommand(args);
			const r = spawnSync(SCRIPT as string, ["-qec", [c.cmd, ...c.args].map(quote).join(" "), "/dev/null"], { env, encoding: "utf8", input: "", timeout: 20_000 });
			expect(r.status, `${args.join(" ")}: ${r.stdout}`).toBe(0);
			expect(r.stdout).toContain("orrery help all");
			expect(r.stdout).not.toContain("\x1b[");
		}
		expect(made(env)).toEqual([]);
	});
});
