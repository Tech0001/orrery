/**
 * The command line's help. `orrery` (off a terminal), `orrery help` and `--help` print the short page; `orrery help
 * <command>` and `orrery <command> --help` every option of one command; `orrery help all` everything, with the commands
 * the plugins run in a last group. GROUPS is the one table behind all of them: each group's lines for the short page,
 * then its detailed lines. A detailed line belongs to the command its usage starts with.
 */

/** A command used the wrong way: main prints the message, then that command's help. */
export class UsageError extends Error {}

/** A usage and what it does; an empty text leaves the usage alone on its line. */
type Line = readonly [usage: string, text: string];

interface Group {
	readonly title: string;
	/** The short page's lines; none for the plugins' group, which only `orrery help all` shows. */
	readonly short: readonly Line[];
	readonly detail: readonly Line[];
}

const GROUPS: readonly Group[] = [
	{
		title: "Agents",
		short: [
			["agent <Name>", "open it in this folder (--tool pi|omp|claude-code|codex|opencode)"],
			["agent add <Name>", "add an agent"],
			["agent edit <Name>", "edit its instructions"],
			["agent set <Name> …", "change a setting"],
			["agent archive <Name>", "take a closed agent out of the config"],
			["run <Name>", "start it in Orrery's own runtime, in this terminal"],
			["status [<Name>]", "state, tool, memory and summaries"],
		],
		detail: [
			[
				"agent <Name> [--tool pi|omp|claude-code|codex|opencode] [--yes] [-- <tool arguments>]",
				"open the agent here: its tool starts in this folder with its instructions and memory (--tool: another tool this time; --yes: answers its questions yes; what follows -- goes to the tool). Codex gets Orrery's hooks, memory tools and instructions on its command line, after a check that the hooks load in that Codex; OpenCode gets Orrery's plugin for this launch (opencode --standalone, nothing written to OpenCode's config), after a check that it loads in that OpenCode; only a person at a terminal can start either without them",
			],
			[
				"agent add <Name> --folder DIR --tool pi|omp|claude-code|codex|opencode --summary provider/id [--thinking L] [--reads all|none|A,B]",
				"add an agent to the config (the TUI's N); --thinking is the summary model's thinking level (default low); --reads: the other agents it may read through the memory tools (default none)",
			],
			["agent edit <Name>", "open the agent's instructions in $EDITOR (else nano, else vi); needs a terminal"],
			[
				"agent set <Name> [--tool T] [--folder DIR] [--view-kb N] [--summary-kb N] [--jobs N] [--compact-at TOKENS] [--reads all|none|A,B]",
				"change an agent's settings in the config, keeping its comments; they apply when it next opens (--view-kb: the memory view's size; --summary-kb: the most one summary call reads; --jobs: summary calls at once; --compact-at: where Claude Code compacts; --reads: the other agents it may read, all, none or a comma list; an agent always reads itself)",
			],
			["agent set <Name> launcher direct|ori | ori_model <id>", "launch it through Ori or not, and Ori's model; an empty value clears it (also --launcher, --ori-model)"],
			[
				"agent archive <Name>",
				"take a closed agent out of the config (its settings kept as comments at the end); its memory stays in its data folder (the TUI's A)",
			],
			["run <Name>", "start the agent in Orrery's own runtime, in this terminal (one process per agent)"],
			["status [<Name>] [--json]", "every agent (or one): state, tool, memory, summaries"],
		],
	},
	{
		title: "Memory",
		short: [
			["import <Name>", "turn Claude Code or Codex history into memory"],
			["compact <Name>", "build missing summaries"],
			["browse <Name>", "open the memory explorer"],
			["backup, restore", "snapshot memory, put it back"],
		],
		detail: [
			[
				"import <Name> --dry-run [--claude DIR|none] [--claude-file FILE]... [--codex DIR|none] [--codex-file FILE]... [--notes FILE]... [--paste-threshold N] [--no-split] [--out DIR]",
				"preview a history import for review, in DIR (default ./import-<Name>). It reads the Claude Code project of the agent's folder and that folder's Codex sessions in ~/.codex/sessions (--claude, --codex: another folder, or none); --claude-file adds a Claude Code session that lives under another project folder, --codex-file a rollout that started elsewhere and was resumed in the agent's folder, --notes a notes file. The summary model splits pastes over N bytes (default 1200); --no-split skips that model pass",
			],
			["import <Name> --commit FILE", "append a reviewed preview to the agent's memory, which must be empty"],
			["compact <Name> [--progress FILE]", "build every missing summary (the agent must not be running; an OpenCode summary model builds only in OpenCode); --progress: write how far it is to FILE"],
			[
				"browse <Name> [--out FILE] [--open]",
				"write an HTML explorer of the agent's memory to FILE, else ./<Name>-memory.html (--open: else into the agent's data folder, then open it)",
			],
			["backup [--keep N]", "snapshot every agent's memory and export it as JSONL (keeps N days, default 14)"],
			["restore <Name> --from DATE|DIR", "put a backup back (the agent must be stopped); DATE is YYYY-MM-DD, DIR an absolute path"],
		],
	},
	{
		title: "Summaries",
		short: [
			["login, logins, logout", "ChatGPT sign-in, API keys"],
			["compactor <Name>", "show or switch the summary model"],
			["usage [<Name>]", "tokens per day"],
		],
		detail: [
			["login openai|openrouter [--manual]", "sign in for summaries; openai is ChatGPT (--manual, or --no-browser: paste the URL or code, no browser)"],
			["login --key <openai|anthropic|openrouter> [--from-pi]", "save an API key (typed hidden, or copied from pi's /login)"],
			["logins [--json]", "what is saved (never the keys)"],
			["logout openai|openrouter | --key <openai|anthropic|openrouter>", "remove one sign-in or key"],
			[
				"compactor <Name> [signin|key|local [name [words] | name/model [thinking]] | provider/id [thinking] | reset]",
				"show, list or switch the agent's summary model (shared with pi's /compactor); a switch tests the model first. OpenCode's models (opencode/<provider>/<model>) are chosen inside OpenCode, with its /compactor",
			],
			["usage [<Name>] [--days N] [--json]", "token usage per day, role and model (default 7 days)"],
		],
	},
	{
		title: "Other machines",
		short: [
			["remote …", "add, test, key, log, agents, remove"],
			["agent push|pull|takeover|local <Name>", ""],
		],
		detail: [
			[
				"remote add <name> --server <host>:<folder> | --cloudflare <url> [--token-file FILE] [--code-file FILE]",
				"add a memory remote; the Cloudflare token and the recovery code are typed hidden, or read from the files (--server: a host from [hosts])",
			],
			[
				"remote add <name> [--token-file FILE] [--code-file FILE] [--new]",
				"recover this machine's key for an already configured remote (--new: make the key of a configured remote that has none)",
			],
			["remote test <name>", "test reachability, lock and key"],
			["remote key <name>", "show the secret recovery code"],
			["remote log <Name> [--json]", "show an agent's decrypted saves and recorded takeovers"],
			["remote agents <name> [--json]", "list the agents stored on a remote and where each is open"],
			["remote remove <name> --yes", "remove an unused remote and its saved key (save the recovery code first)"],
			["agent push <Name> --to <remote>", "upload a closed agent's memory, then use that remote"],
			["agent pull <Name> --from <remote> [--folder <dir>]", "add a remote agent here and fetch its memory and instructions"],
			["agent takeover <Name> [--yes]", "confirm taking a stale lock, then release it for the next open"],
			["agent local <Name> [--delete-remote]", "fetch the newest memory and keep it locally (deleting the remote copy asks first)"],
			["trust-host <host>", "check and trust the key of an SSH host from [hosts] (a server remote's, or one an agent runs on)"],
		],
	},
	{
		title: "Install",
		short: [
			["update [--check]", "install the newest release"],
			["tools", "coding tools found, and Orrery's side in each"],
			["claude-setup <Name>", "load memory in Claude Code"],
			["setup, install, uninstall", ""],
		],
		detail: [
			["update [--check] [--version V] [--yes]", "install the newest release (or V); --check only says whether one is out; --yes answers setup's questions yes"],
			["tools [--json]", "pi, Claude Code, Codex, OMP, OpenCode and Ori: found, version, Orrery's side installed (Codex's and OpenCode's come with each launch)"],
			["tools install <pi|claude-code|omp> [--yes]", "install or update Orrery's side of a tool (shows what it does first)"],
			[
				"claude-setup <Name> [--mod]",
				"make Claude Code load the agent's memory view (CLAUDE.md, or CLAUDE.local.md in a repo); --mod: from the Orrery mod, in the system prompt",
			],
			[
				"setup [--yes]",
				"wire the orrery command, pi, OMP, Claude Code and the backup service to the installed version; asks on the terminal before connecting a tool or replacing anything that is not Orrery's (--yes: answers yes)",
			],
			["install --from DIR [--yes]", "install an unpacked release folder, then run setup (install.sh and orrery update run this)"],
			["install --rollback [--yes] | --list", "switch back to the previous installed version and run setup, or list versions and which agents run them"],
			[
				"uninstall [--purge]",
				"unwire pi, OMP and Claude Code, remove the command, the backup service and the installed versions; agents' memory, config and logins stay (--purge: delete them too, after typing delete)",
			],
			["version, --version, -v", "the running version (a checkout's also names its folder)"],
		],
	},
	{
		title: "Run by the plugins",
		short: [],
		detail: [
			[
				"holder <Name> --session ID --claude-pid PID [--nonce N] [--since MS]",
				"record a Claude Code session into the agent (the plugin's SessionStart hook starts it; --since is when SessionStart ran, in ms since the epoch)",
			],
			["holder <Name> --session ID --host-pid PID --tool codex [--nonce N] [--since MS]", "record a Codex session into the agent (Orrery's SessionStart hook in Codex starts it)"],
			[
				"claude-mod view [--cwd DIR] [--session ID] [--agent NAME [--agent-token T]] [--wait-ms N [--spool-only]]",
				"the Orrery mod's call: the session's agent's memory section as JSON (--agent: the ORRERY_AGENT Claude Code has; --wait-ms: up to 120000; --spool-only waits for the session's spool alone, not for summaries)",
			],
			["mcp", "the Claude Code plugin's MCP server: memory tools for the session's agent (ORRERY_AGENT's, else the project folder's)"],
			["mcp --tool codex", "the MCP server orrery agent gives Codex: memory tools for ORRERY_AGENT's agent, with its token"],
			["claude-hook <event>", "a Claude Code plugin hook (session-start, user-prompt-submit, stop, session-end, pre-tool-use)"],
			["codex-hook <event>", "a hook orrery agent gives Codex (session-start, user-prompt-submit, stop, session-end, pre-tool-use)"],
		],
	},
];

const TOP: Line = ["orrery", "open the TUI (agents, logins, usage, tools)"];

const FOOTER: readonly Line[] = [
	["orrery help <command>", "every option for one command"],
	["orrery help all", "the full list, incl. what the plugins run"],
];

/** The commands that take "." for this session's agent (main's agentArg). */
const DOT_COMMANDS = ["status", "usage", "browse", "compactor", "claude-setup"];

const DOT_NOTE = `An agent named "." (${DOT_COMMANDS.join(", ")}) is this session's agent: inside an agent's session, the agent it was opened as; elsewhere ORRERY_AGENT, else the agent whose folder holds the current folder.`;

const CONFIG_NOTE = "Config: --config FILE, $ORRERY_CONFIG, ~/.orrery/config.toml (or under $ORRERY_HOME), or /etc/orrery/config.toml.";

/** What runs inside an agent's session (src/cli/gate.ts): `orrery help all` says it last. */
const INSIDE_NOTE =
	"Inside an agent's session (its shell, or a ! command typed in its tool) only help, --version, status, usage, browse (no --out) and compactor run, as that agent and for the agents it may read, besides what the plugins run; run the rest in your own terminal or the TUI.";

/** Where a line's text starts, on every page. */
const COLUMN = 28;
/** The short page fits a terminal of 80 columns; the detailed pages wrap at 100. */
export const SHORT_WIDTH = 80;
export const WIDTH = 100;

/** The command a detailed line belongs to: its usage's first word ("version, --version" → "version"). */
const commandOf = (usage: string): string => (usage.split(" ")[0] as string).replace(/,$/, "");

/** Every command with help, in the order `orrery help all` shows them. */
export const HELP_COMMANDS: readonly string[] = [...new Set(GROUPS.flatMap((group) => group.detail.map(([usage]) => commandOf(usage))))];

/** The commands of the "Run by the plugins" group. */
export const PLUGIN_COMMANDS: readonly string[] = [...new Set((GROUPS.at(-1) as Group).detail.map(([usage]) => commandOf(usage)))];

/** Whether `command` is one of the CLI's commands (help, and the ones with help). */
export function isCommand(command: string): boolean {
	return command === "help" || HELP_COMMANDS.includes(command);
}

/**
 * The words of `text`; in a usage (`usage`), a part in brackets ("[--claude DIR|none]", "<tool arguments>") stays one
 * word.
 */
function words(text: string, usage: boolean): string[] {
	if (!usage) return text.split(" ").filter((word) => word !== "");
	const out: string[] = [];
	let word = "";
	let depth = 0;
	for (const ch of text) {
		if (ch === " " && depth === 0) {
			if (word !== "") out.push(word);
			word = "";
			continue;
		}
		if (ch === "[" || ch === "<") depth++;
		if (ch === "]" || ch === ">") depth = Math.max(0, depth - 1);
		word += ch;
	}
	if (word !== "") out.push(word);
	return out;
}

/** `text` in lines of at most `first` characters, then `rest`; a word longer than that stands alone. */
function fill(text: string, usage: boolean, first: number, rest = first): string[] {
	const lines: string[] = [];
	let line = "";
	for (const word of words(text, usage)) {
		const width = lines.length === 0 ? first : rest;
		if (line !== "" && line.length + 1 + word.length > width) {
			lines.push(line);
			line = word;
		} else line = line === "" ? word : `${line} ${word}`;
	}
	if (line !== "") lines.push(line);
	return lines;
}

/**
 * One line of help, wrapped at `width`: the usage from column `indent` (continued 4 further in), the text from COLUMN,
 * beside a one-line usage that leaves it two spaces, else below the usage.
 */
function render([usage, text]: Line, width: number, indent = 2): string[] {
	const pad = " ".repeat(indent);
	const lines = fill(usage, true, width - indent, width - indent - 4).map((part, i) => `${pad}${i === 0 ? "" : "    "}${part}`);
	if (text === "") return lines;
	const body = fill(text, false, width - COLUMN);
	if (lines.length === 1 && (lines[0] as string).length + 2 <= COLUMN) lines[0] = `${(lines[0] as string).padEnd(COLUMN)}${body.shift() as string}`;
	return [...lines, ...body.map((part) => `${" ".repeat(COLUMN)}${part}`)];
}

function header(version: string | undefined): string {
	return `Orrery${version === undefined ? "" : ` ${version}`}: long-lived memory for coding agents`;
}

const page = (lines: readonly string[]): string => `${lines.join("\n")}\n`;

/** `orrery help`: the short page, grouped, within 80 columns; the commands the plugins run are left out. */
export function shortHelp(version: string | undefined): string {
	const lines = [header(version), "", ...render(TOP, SHORT_WIDTH)];
	for (const group of GROUPS) {
		if (group.short.length > 0) lines.push("", group.title, ...group.short.flatMap((line) => render(line, SHORT_WIDTH)));
	}
	lines.push("", ...FOOTER.flatMap((line) => render(line, SHORT_WIDTH, 0)));
	return page(lines);
}

/** `orrery help all`: every command's every option, grouped as the short page, then the plugins' commands and the notes. */
export function allHelp(version: string | undefined): string {
	const lines = [header(version), "", ...render(TOP, WIDTH)];
	for (const group of GROUPS) lines.push("", group.title, ...group.detail.flatMap((line) => render(line, WIDTH)));
	lines.push("", ...FOOTER.flatMap((line) => render(line, WIDTH, 0)), "", ...fill(DOT_NOTE, false, WIDTH), ...fill(CONFIG_NOTE, false, WIDTH), ...fill(INSIDE_NOTE, false, WIDTH));
	return page(lines);
}

/** `orrery help <command>`, `orrery <command> --help`: every line of one command; undefined for no such command. */
export function commandHelp(command: string | undefined): string | undefined {
	const lines = GROUPS.flatMap((group) => group.detail.filter(([usage]) => commandOf(usage) === command)).flatMap((line) => render(line, WIDTH));
	if (lines.length === 0) return undefined;
	if (DOT_COMMANDS.includes(command as string)) lines.push("", ...fill(DOT_NOTE, false, WIDTH));
	return page(lines);
}
