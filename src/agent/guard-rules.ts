/** The agent guard's pure rules (spec §6): which tool calls and paths are refused. No pi-durable here. */

import { homedir } from "node:os";
import { posix } from "node:path";
import { ALLOWED_INSIDE } from "./inside-commands.ts";

export interface GuardOptions {
	readonly folder: string;
	readonly allowedRoots: readonly string[];
	/** Where a relative path starts (pi's cwd, which may be a subfolder of the folder); default: the folder. */
	readonly cwd?: string;
	/**
	 * Every other agent's view file (the memory view Claude Code's file mode keeps at <folder>/.orrery/view.md): no
	 * tool reads, writes or content-searches it (src/agent/guard-paths.ts agentViews). Required, so no caller gets the old
	 * rule by leaving it out: a view file named in a command or a path is open only when it is `ownView`.
	 */
	readonly foreignViews: readonly string[];
	/**
	 * Of those, the ones whose agent is set up Claude Code's file way (its setup marker says so): a search under one is
	 * refused even before the file is first written.
	 */
	readonly fileModeViews?: readonly string[];
	/** The session's own agent's view file, if it has one. */
	readonly ownView?: string;
	/**
	 * The config file in use, wherever it is (ORRERY_CONFIG may name any path): file tools may read it, no tool may write
	 * it, and shell text may not name it by its path (configSpellings). ~/.orrery/config.toml is kept so by name too.
	 */
	readonly configFile?: string;
	/**
	 * [guard] protect from Orrery's config (HarnessConfig.guard, spec 2026-10-15-guard-protect), as the config writes it:
	 * more files and folders no tool reads, writes or names (protection).
	 */
	readonly protect?: readonly string[];
	/**
	 * OpenCode's config and code (openCodeRule), which no tool writes and no shell text names; default: from this
	 * process's environment and the guard's home.
	 */
	readonly openCode?: OpenCodeRule;
	/**
	 * Claude Code's and Codex's session records (transcriptRule), which no tool writes and no shell text names; default:
	 * from this process's environment and the guard's home.
	 */
	readonly transcripts?: TranscriptRule;
	/**
	 * Codex's own shell only (src/codex/guard.ts), which has no file tool to read with: shell text that is a plain read
	 * of skill files (skillShellRead) is not refused for naming a skills folder. Every other rule still applies, and the
	 * Codex gate judges each file it reads as a read.
	 */
	readonly shellReadsSkills?: boolean;
}

const SENSITIVE = [
	/(^|[\s"'=:/~])\.ssh(\/|$|[\s"'])/,
	/\bid_(rsa|ed25519|ecdsa|dsa)\b/,
	/\bauth\.json\b/,
	/\bcredentials\.json\b/,
	/\.aws\/credentials\b/,
	/\.netrc\b/,
	/(^|\/)\.gnupg(\/|$)/,
	/\.kube\/config\b/,
	/\.docker\/config\.json\b/,
	/\.config\/gh\/hosts\.yml\b/,
	/\.git-credentials\b/,
	/\.pgpass\b/,
	// pi's provider settings (API keys may sit in it) and any process's environment (/proc/self/environ and the like).
	/\.pi\/agent\/models\.json\b/,
	// OpenCode's login store: its database (provider keys and sign-ins, with its WAL and shared memory) in its data
	// folder, $XDG_DATA_HOME/opencode or ~/.local/share/opencode, a release channel's too (opencode-<channel>.db).
	/(^|[\s"'=:/])opencode\/opencode(?:-[a-z0-9._-]+)?\.db(?:-wal|-shm|-journal)?\b/,
	/(^|[\s"'=:;|&<>(])\/proc\/([^/\s"']+\/)+environ\b/,
	// OMP's credential stores: agent.db (its logins) and models.yml (API keys) in ~/.omp/agent or a profile's, and agent.db
	// under $XDG_DATA_HOME/omp once OMP moved its data there.
	/\.omp\/(?:profiles\/[^/\s"']+\/)?agent\/(?:agent\.db|models\.ya?ml)\b/,
	/(^|[\s"'=:/])omp\/(?:profiles\/[^/\s"']+\/)?agent\.db\b/,
	// The .env OMP loads from its config root and agent dir (utils/src/env.ts) and its secrets.yml (secrets/index.ts), in
	// ~/.omp, a profile's or a project's .omp.
	/\.omp\/(?:profiles\/[^/\s"']+\/)?(?:agent\/)?(?:\.env|secrets\.ya?ml)\b/,
];

// Where a protected name stands as a path segment or a word of its own in a reading (ENV_FILE, Protection.named). Before
// it: the text's start, a blank, a quote, "=", ":", "/", "~", a shell operator or redirection, a backquote, a brace or a
// comma (a group past the brace readings' caps), "*" (a glob that matches the bare name too), "@" (curl's and httpie's
// "send this file", @.env), or short options the name is glued to (curl -T.env, curl -sT.env). After it: the text's
// end, a blank, a quote, "/", ":", a shell operator, a backquote, a comma or closing brace, or a glob character. A path
// entry's spelling ends the same way (Protection.spelled), so ~/finance never stands for ~/finance-old.
const NAME_START = "(?:^|[\\s\"'=:/~<>;|&()`{,*@]|(?:^|[\\s\"'])-[a-z]+)";
const NAME_END = "(?=$|[\\s\"'/:;|&()<>`,}*?\\[])";
/** NAME_START for a name that starts with a dot: without "*", which a shell does not let match a leading dot. */
const DOT_START = "(?:^|[\\s\"'=:/~<>;|&()`{,@]|(?:^|[\\s\"'])-[a-z]+)";

/**
 * The built-in .env rule (spec 2026-10-15-guard-protect), and Cloudflare Workers' .dev.vars by the same rule (spec
 * 2026-10-16-guard-presets): .env and .env.<anything>, .dev.vars and .dev.vars.<anything>, standing as a name, but not the
 * templates meant to be shared (.env.example, .env.sample, .env.template, .env.dist and the same for .dev.vars, each
 * followed by a plain end, not a glob). As a name, so process.env, import.meta.env, prod.env and .envrc never match; nor
 * does *.env, since a shell's "*" does not match a leading dot (DOT_START). A brace group right after it ends it too:
 * .env.lo{…} is a .env file whatever the group holds. What follows ".env." holds no character a name starts or ends at,
 * so a try reads no further than the next place a name may start: the text is read in linear time.
 */
const ENV_FILE = new RegExp(
	`${DOT_START}\\.(?:env|dev\\.vars)(?!\\.(?:example|sample|template|dist)(?=$|[\\s"'/:;|&()<>\`,}]))(?:\\.[^\\s"'=:/~<>;|&()\`{,*}?\\[@]*)?(?=$|[\\s"'/:;|&()<>\`,}*?\\[{])`,
);

/**
 * The other secret files built in by name, in any folder, matched as whole names (spec 2026-10-16-guard-presets): act's
 * .secrets, Streamlit's secrets.toml, Rails' master.key and .htpasswd. secrets.toml.example and my-secrets.toml are other
 * names. Like the .env rule, not judged in an OMP edit's text, where a .gitignore line names them.
 */
const SECRET_NAMES = new RegExp(`${DOT_START}\\.(?:secrets|htpasswd)${NAME_END}|${NAME_START}(?:secrets\\.toml|master\\.key)${NAME_END}`);

/**
 * Credential files and folders under home (spec 2026-10-16-guard-presets), beside HOME_CREDENTIALS's (guard-paths.ts):
 * file tools by path, links followed, and a search whose root holds one, as HOME_CREDENTIALS. In shell text most are
 * named by HOME_NAMED anywhere, as .aws/credentials is; HOME_ONLY's are not.
 */
export const HOME_SECRETS: readonly string[] = [
	".npmrc",
	".pypirc",
	".cargo/credentials",
	".cargo/credentials.toml",
	".gem/credentials",
	".config/gcloud",
	".azure",
	".terraform.d/credentials.tfrc.json",
	".wrangler",
	".config/.wrangler",
	// wrangler's login on macOS, whose config folder is Library/Preferences.
	"Library/Preferences/.wrangler",
	".cache/huggingface/token",
	// huggingface_hub keeps every saved token here, beside the active one.
	".cache/huggingface/stored_tokens",
	".huggingface/token",
	".password-store",
	".config/op",
];

/**
 * HOME_SECRETS whose names are common in projects: a project's own .npmrc or .pypirc, an Azure Developer CLI project's
 * .azure folder, wrangler's .wrangler cache. Shell text names one only from home (Protection.secretSpelled): ~/.npmrc is
 * refused, .npmrc is not.
 */
const HOME_ONLY = [".npmrc", ".pypirc", ".azure", ".wrangler"];

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The other HOME_SECRETS, named anywhere as a whole path (not .config/opencode for .config/op), like SENSITIVE's; lower
 * case, as the readings are.
 */
const HOME_NAMED = new RegExp(`${DOT_START}(?:${HOME_SECRETS.filter((name) => !HOME_ONLY.includes(name)).map((name) => literal(name.toLowerCase())).join("|")})${NAME_END}`);

/** The credential patterns: SENSITIVE's and HOME_NAMED. */
const CREDENTIALS = [...SENSITIVE, HOME_NAMED];

/**
 * Orrery's hook plumbing, which only Orrery's own hooks run: Claude Code and Codex run them, never an agent's shell. An
 * agent that ran a hook could give it made-up input and put words in the person's mouth (a "user:" message in its own
 * memory). In any reading of shell text (readings: quotes, backslashes and empty $() or `` gone, $'…' decoded, brace
 * groups read each way, any case):
 * - a hook command, codex-hook or claude-hook, named as a word anywhere, so it is refused however Orrery is reached
 *   (orrery, a path to it, env/command/exec, $(which orrery), xargs, the source's cli/main.ts under node or bun); an
 *   expansion glued to either end (${x}codex-hook, codex-hook$x), which may be empty, does not hide it;
 * - the recorder, `orrery holder`: the word holder anywhere in text that also names Orrery's program as a word
 *   (orrery, a path ending in it, or the source's cli/main.ts), in either order, so neither an argument list fed in
 *   (`echo holder | xargs orrery`) nor a quoted separator between them (`orrery --config ';' holder`) splits them, nor
 *   a list ({orrery,holder}). A glob that could name the program counts as it does (~/.local/bin/orr*y: programGlobs).
 *   Text that names both for other reasons (`cd ~/orrery && grep holder src`) is refused too.
 * A word may also start or end at an escape that printf or echo -e turns into a separator (`printf 'A\nholder'`).
 * Orrery's other commands (orrery status, orrery help…) stay open; `orrery claude-mod view` only reads. As with every
 * shell-text rule, a name built at run time (o=orrery; $o holder, or codex-$x"hook"), read from a file (xargs -a), or a
 * link or alias of another name to Orrery's program gets through.
 */
const ESCAPE_BEFORE = "\\\\(?:[a-z]|x[0-9a-f]{1,2}|[0-7]{1,3})";
const PLUMBING_START = `(?:^|[\\s"'=:/~<>;|&()\`{},*@]|(?:^|[\\s"'])-[a-z]+|${ESCAPE_BEFORE})`;
const PLUMBING_END = "(?=$|[\\s\"'/:;|&()<>`,{}*?\\[$\\\\])";
const HOOK_COMMAND = new RegExp(`${PLUMBING_START}(?:codex|claude)-hook${PLUMBING_END}`);
const ORRERY_PROGRAM = new RegExp(`${PLUMBING_START}(?:orrery(?:\\.exe)?|cli/main\\.[cm]?[jt]s)(?=$|[\\s"';|&()<>\`{}$\\\\,])`);
const HOLDER_WORD = new RegExp(`(?:^|[\\s"'<>;|&()\`{},]|${ESCAPE_BEFORE})holder${PLUMBING_END}`);

/**
 * A pattern for `names` standing as words in a reading of shell text, with the hook plumbing's edges (PLUMBING_START,
 * PLUMBING_END): a path's last part, quotes, an escape or an expansion that may be empty around it. Lower case, as the
 * readings are.
 */
export function shellWord(names: readonly string[]): RegExp {
	return new RegExp(`${PLUMBING_START}(?:${names.map(literal).join("|")})${PLUMBING_END}`);
}

/** Whether any reading of shell text (readings: its forms and brace pieces) passes `test`. */
export function inAnyReading(text: string, test: (form: string) => boolean): boolean {
	const reading = readings(text);
	return reading.forms.some(test) || reading.pieces.some(test);
}

/** Whether a reading runs Orrery's hook plumbing (HOOK_COMMAND; ORRERY_PROGRAM, or a glob of it, with HOLDER_WORD). Linear. */
function runsPlumbing(form: string): boolean {
	return HOOK_COMMAND.test(form) || (form.includes("holder") && HOLDER_WORD.test(form) && (ORRERY_PROGRAM.test(form) || programGlobs(form).length > 0));
}

/** Why shell text that runs Orrery's hook plumbing is refused (runsPlumbing). */
export const PLUMBING_REFUSED = "This command runs Orrery's hook plumbing (codex-hook, claude-hook, orrery holder), which only Orrery's own hooks run.";

// ---- Orrery's own commands from an agent's shell (spec 2026-10-18-agent-permissions §4) ----
//
// Inside an agent session the CLI runs only the commands that read (ALLOWED_INSIDE); this rule is the second belt, in
// every gate, in the plumbing rule's blunt style. Shell text is refused where Orrery's program (orrery, orrery.exe, the
// Claude Code plugin's orrery-run, a path ending in one, or the source's cli/main.ts) is followed, as the first word
// that is no option, by a command the CLI knows that does not run inside a session (REFUSED_COMMANDS). It matches in
// any reading of the text, anywhere: a search pattern or a commit message that names one is refused too (CONTRIBUTING:
// search with a file tool, git commit -F).
// - The options main.ts knows are skipped, a valued one with its value, and so are redirections. Where the guard can't
//   tell where the options end (an option main.ts doesn't know, an expansion or a substitution, a list in code, more
//   words than a command line has), it fails closed: any refused command named as a word before the next separator
//   (;, |, & or a newline, outside quotes) refuses. Text that feeds xargs or parallel fails closed over all of it.
// - A glob counts as what it could match: one that could name the program (~/.local/bin/orr*y) is the program, and one
//   in the command's place that could name a refused command (re*ore) is that command.
// - Bare orrery, orrery before a separator, and orrery followed by a word that is no refused command pass: an agent's
//   shell has no terminal for the TUI (the CLI's gate refuses it anyway), and a checkout of Orrery is named so too
//   (cd ~/src/orrery, ls). So does a checkout named as the folder git, make or a package manager works in, by that
//   tool's own folder option (git -C ~/src/orrery remote -v, npm --prefix …), or as the repository gh works on
//   (gh pr create -R owner/orrery …): those tools run no program of that name.
// Limits, as for every shell-text rule: a name built at run time (o=orrery; $o setup), arguments read from a file
// (xargs -a) or file names a command hands on (find … -exec orrery {}), a link or alias of another name to Orrery's
// program, and scripts that run it (npm scripts, Makefile targets, git aliases made before).

/**
 * Every command the CLI knows: help and the commands with help (src/cli/help.ts HELP_COMMANDS; main.ts answers any other
 * word "Unknown command"). Pinned by test/agent/guard-orrery-commands.test.ts, so a new command can't slip past.
 */
export const ORRERY_COMMANDS: readonly string[] = [
	...["help", "agent", "run", "status", "import", "compact", "browse", "backup", "restore", "login", "logins", "logout"],
	...["compactor", "usage", "remote", "trust-host", "update", "tools", "claude-setup", "setup", "install", "uninstall"],
	...["version", "holder", "claude-mod", "mcp", "claude-hook", "codex-hook"],
];

/**
 * The commands shell text may not run: all but those that run inside an agent session (ALLOWED_INSIDE, the hook
 * plumbing's among them, which runsPlumbing refuses on its own) and version, which main prints before any command runs,
 * as it does --version.
 */
export const REFUSED_COMMANDS: readonly string[] = ORRERY_COMMANDS.filter((command) => !ALLOWED_INSIDE.has(command) && command !== "version");
const REFUSED = new Set(REFUSED_COMMANDS);

/** main.ts's options (OPTIONS), pinned by the same test: those whose next word is their value, and the flags. */
export const ORRERY_OPTIONS: { readonly valued: ReadonlySet<string>; readonly flags: ReadonlySet<string> } = {
	valued: new Set(
		[
			...["config", "key", "days", "keep", "from", "to", "commit", "claude", "claude-file", "codex", "codex-file", "notes"],
			...["paste-threshold", "out", "progress", "session", "cwd", "wait-ms", "agent", "agent-token", "claude-pid", "host-pid"],
			...["nonce", "since", "prefix", "folder", "tool", "launcher", "ori-model", "summary", "thinking", "view-kb", "summary-kb"],
			...["jobs", "compact-at", "reads", "server", "cloudflare", "token-file", "code-file"],
		].map((name) => `--${name}`),
	),
	flags: new Set([
		...[
			...["api-key", "from-pi", "delete-remote", "dry-run", "no-split", "spool-only", "open", "mod", "manual", "no-browser"],
			...["new", "json", "yes", "rollback", "list", "purge", "check", "help", "version"],
		].map((name) => `--${name}`),
		"-h",
		"-v",
	]),
};

/** Orrery's program as a word (ORRERY_PROGRAM's names and orrery-run), its name in group 1; also after "[" or "!" (code's list, a git alias). */
const PROGRAM_RUN = new RegExp(`(?:${PLUMBING_START}|[[!])(orrery(?:\\.exe|-run)?|cli/main\\.[cm]?[jt]s)(?=$|[\\s"';|&()<>\`{}$\\\\,\\]])`, "g");
/** A refused command named as a word, in group 1, with the plumbing's edges: what fails closed looks for. */
const REFUSED_WORD = new RegExp(`${PLUMBING_START}(${REFUSED_COMMANDS.map(literal).join("|")})${PLUMBING_END}`, "g");
/** Characters that end a command's words. */
const COMMAND_ENDS = new Set([";", "|", "&", "(", "\n"]);
/** A redirection operator, after a file descriptor's number or a {name} for one, at lastIndex. */
const REDIRECTION = /(?:[0-9]*|\{[a-z_][a-z0-9_]*\})(?:&>>?|>>|>&|>\||<<<|<<-?|<>|<&|>|<)/y;
/** An escape printf or echo -e turns into a blank, at lastIndex. */
const ESCAPE_AT = new RegExp(ESCAPE_BEFORE, "y");
/** Text that hands xargs or parallel the words it runs: their order is not known. */
const XARGS = /(?:^|[\s;|&(`])(?:xargs|parallel)\s/;
/** How many words a command line may hold before its command; past it the guard fails closed. */
const MAX_WORDS = 64;

/**
 * The tools whose own folder option may name a checkout of Orrery, each with those options (lower case, as the readings
 * are: git's and make's -c is their -C), and GitHub's CLI with its repository's (gh … -R owner/orrery).
 */
const FOLDER_OPTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	["git", new Set(["-c"])],
	["make", new Set(["-c", "--directory"])],
	["npm", new Set(["--prefix"])],
	["pnpm", new Set(["--dir"])],
	["yarn", new Set(["--cwd"])],
	["bun", new Set(["--cwd"])],
	["gh", new Set(["-r", "--repo"])],
]);
/** How far back the guard looks for the command a folder option belongs to. */
const LOOK_BACK = 256;

const blank = (c: string | undefined) => c === " " || c === "\t" || c === "\r";

// ---- Globs: what a word with *, ? or [ in it could match ----

/** A glob character. */
const GLOB = /[*?[]/;
/** Orrery's program by the names a glob could match. */
const PROGRAM_NAMES = ["orrery", "orrery-run", "orrery.exe"];

/** The POSIX classes a bracket expression may hold ([[:alpha:]]); one the guard doesn't know matches anything. */
const POSIX_CLASSES: Readonly<Record<string, RegExp>> = {
	alpha: /[a-z]/i,
	alnum: /[a-z0-9]/i,
	digit: /[0-9]/,
	xdigit: /[0-9a-f]/i,
	lower: /[a-z]/,
	upper: /[A-Z]/,
	space: /\s/,
	blank: /[ \t]/,
	punct: /[!-/:-@[-`{-~]/,
	word: /\w/,
	print: /[ -~]/,
	graph: /[!-~]/,
	cntrl: /[\x00-\x1f\x7f]/,
};

/** One unit of a glob: "*", or a test of one character. */
type GlobUnit = "*" | ((c: string) => boolean);

/** The bracket expression starting at `start` in a glob ([a-z], [!x], [[:alpha:]]), or undefined when it doesn't close. */
function bracketAt(glob: string, start: number): { readonly test: (c: string) => boolean; readonly end: number } | undefined {
	let i = start + 1;
	const negate = glob[i] === "!" || glob[i] === "^";
	if (negate) i++;
	const tests: ((c: string) => boolean)[] = [];
	for (let first = true; i < glob.length; first = false) {
		const c = glob.charAt(i);
		if (c === "]" && !first) return { test: (x) => tests.some((test) => test(x)) !== negate, end: i };
		if (c === "[" && (glob[i + 1] === ":" || glob[i + 1] === "." || glob[i + 1] === "=")) {
			const close = glob.indexOf(`${glob[i + 1]}]`, i + 2);
			if (close === -1) return undefined;
			const named = glob[i + 1] === ":" ? POSIX_CLASSES[glob.slice(i + 2, close)] : undefined;
			tests.push(named === undefined ? () => true : (x) => named.test(x));
			i = close + 2;
			continue;
		}
		const from = c === "\\" ? glob.charAt(++i) : c;
		const dash = i + 1;
		if (glob[dash] === "-" && dash + 1 < glob.length && glob[dash + 1] !== "]") {
			const to = glob[dash + 1] === "\\" ? glob.charAt(dash + 2) : glob.charAt(dash + 1);
			tests.push((x) => x >= from && x <= to);
			i = glob[dash + 1] === "\\" ? dash + 3 : dash + 2;
			continue;
		}
		tests.push((x) => x === from);
		i++;
	}
	return undefined;
}

/**
 * A glob read into units; a "[" that doesn't close and an escaped character stand for themselves. Once a "[" doesn't
 * close, no later one is tried, so a word is read in linear time. Undefined once it holds more than `most` units that
 * test a character: it can match no name that short.
 */
function globUnits(glob: string, most: number): GlobUnit[] | undefined {
	const units: GlobUnit[] = [];
	let tests = 0;
	let brackets = true;
	for (let i = 0; i < glob.length; i++) {
		const c = glob.charAt(i);
		if (c === "*") {
			if (units.at(-1) !== "*") units.push("*");
			continue;
		}
		if (++tests > most) return undefined;
		const bracket = c === "[" && brackets ? bracketAt(glob, i) : undefined;
		if (c === "[" && bracket === undefined) brackets = false;
		if (c === "?") units.push(() => true);
		else if (bracket !== undefined) {
			units.push(bracket.test);
			i = bracket.end;
		} else {
			const same = c === "\\" && i + 1 < glob.length ? glob.charAt(++i) : c;
			units.push((x) => x === same);
		}
	}
	return units;
}

/** Whether a glob's units match `name` whole: one pass with the last "*" to go back to, so its time is the product of their lengths at most. */
function globMatches(units: readonly GlobUnit[], name: string): boolean {
	let unit = 0;
	let at = 0;
	let star = -1;
	let starAt = 0;
	while (at < name.length) {
		const next = units[unit];
		if (next !== undefined && next !== "*" && next(name.charAt(at))) {
			unit++;
			at++;
		} else if (next === "*") {
			star = unit++;
			starAt = at;
		} else if (star !== -1) {
			unit = star + 1;
			at = ++starAt;
		} else return false;
	}
	while (units[unit] === "*") unit++;
	return unit === units.length;
}

/**
 * Which of `names` a glob (a word with a glob character) could match first, or undefined. Read in linear time; one with
 * more single-character tests than the longest name has characters matches none, so only short ones are matched.
 */
function globCouldName(glob: string, names: readonly string[]): string | undefined {
	if (!GLOB.test(glob)) return undefined;
	const units = globUnits(glob, Math.max(...names.map((name) => name.length)));
	return units === undefined ? undefined : names.find((name) => globMatches(units, name));
}

/** The words of a reading that hold a glob character: shell words split at blanks, quotes and operators. */
const GLOB_WORDS = /[^\s"';|&()<>`]+/g;

/**
 * Each word of a reading whose last path part is a glob that could name Orrery's program, spelling at least one of its
 * letters (orr*y, orre[r]y): where it and that part end. A glob of wildcards alone (*, ***, ??????) is no name: it
 * stands in a patch's headers (*** Update File:), a list's bullets and a shell's every glob.
 */
function programGlobs(form: string): { readonly start: number; readonly end: number }[] {
	if (!GLOB.test(form)) return [];
	const found: { start: number; end: number }[] = [];
	for (const match of form.matchAll(GLOB_WORDS)) {
		const word = match[0];
		const part = word.slice(word.lastIndexOf("/") + 1);
		const end = match.index + word.length;
		if (!/[a-z]/.test(part.replace(/\[[^\]]*\]?/g, ""))) continue;
		if (globCouldName(part, PROGRAM_NAMES) !== undefined) found.push({ start: end - part.length, end });
	}
	return found;
}

/** Past the blanks at `at`: blanks, a line continuation, and an escape that printf or echo -e makes a blank. */
function skipBlanks(form: string, at: number): number {
	let i = at;
	for (;;) {
		const c = form.charAt(i);
		if (blank(c)) i++;
		else if (c === "\\" && form.charAt(i + 1) === "\n") i += 2;
		else if (c === "\\" && ((ESCAPE_AT.lastIndex = i), ESCAPE_AT.test(form))) i = ESCAPE_AT.lastIndex;
		else return i;
	}
}

/** The shell word at `start`, quotes and backslashes gone; `unclear` when it holds an expansion or a substitution. */
function wordAt(form: string, start: number, work: { left: number }): { readonly text: string; readonly end: number; readonly unclear: boolean } {
	let text = "";
	let i = start;
	while (i < form.length) {
		const c = form.charAt(i);
		if (blank(c) || COMMAND_ENDS.has(c) || c === ")" || c === "<" || c === ">" || c === "`") break;
		if (c === "$") return { text, end: i, unclear: true };
		if (c === "\\") {
			text += form.charAt(i + 1) === "\n" ? "" : form.charAt(i + 1);
			i += 2;
		} else if (c === "'") {
			const close = form.indexOf("'", i + 1);
			const end = close === -1 ? form.length : close;
			text += form.slice(i + 1, end);
			work.left -= end - i;
			i = end + 1;
		} else if (c === '"') {
			let j = i + 1;
			for (; j < form.length && form[j] !== '"'; j++) {
				if (form[j] === "$" || form[j] === "`") return { text, end: j, unclear: true };
				if (form[j] === "\\") j++;
				text += form.charAt(j);
			}
			work.left -= j - i;
			i = j + 1;
		} else {
			text += c;
			i++;
		}
	}
	work.left -= i - start;
	return { text, end: i, unclear: false };
}

/**
 * The refused command a word names (the commands are plain words: setup, not setup.md or remote:/srv), or one a glob
 * could match (re*ore), or undefined.
 */
function commandName(text: string): string | undefined {
	const globbed = globCouldName(text, REFUSED_COMMANDS);
	if (globbed !== undefined) return globbed;
	const bare = text.replace(/^[[\](){},]+/, "");
	const name = /^[a-z][a-z0-9-]*/.exec(bare)?.[0];
	if (name === undefined || /^[._/=:@+~%]/.test(bare.slice(name.length))) return undefined;
	return REFUSED.has(name) ? name : undefined;
}

/** What follows Orrery's program (its name ending at `at`): the refused command it runs, where the guard can't tell, or none. */
type After = { readonly refused: string } | { readonly unclear: number } | undefined;

/**
 * The command Orrery's program runs in a reading, its name ending at `at` (above): its options and redirections skipped.
 * `work`: what the reading may still spend, so a long text is read in linear time; past it, unclear.
 */
function commandAfter(form: string, at: number, work: { left: number }): After {
	if (work.left <= 0) return { unclear: at };
	let i = at;
	// The rest of the program's word: a quote or a substitution closing around it, an empty string glued to it. A name
	// that goes on past it (orrery's, orrery"x") is another word, no program. A "," makes it one of a list (a brace
	// group, code's ["orrery","setup"]), whose next item the guard can't place: unclear.
	for (; i < form.length; i++, work.left--) {
		const c = form.charAt(i);
		if (blank(c) || c === "<" || c === ">" || (c === "&" && form[i + 1] === ">")) break;
		if (c === "\\") {
			if (form.charAt(i + 1) === "\n" || ((ESCAPE_AT.lastIndex = i), ESCAPE_AT.test(form))) break;
			return undefined;
		}
		if (c === "$" || c === "`" || c === ",") return { unclear: i };
		if (c !== "'" && c !== '"' && c !== ")" && c !== "}" && c !== "]") return undefined;
	}
	let words = 0;
	let value = false;
	let positional = false;
	for (;;) {
		i = skipBlanks(form, i);
		if (i >= form.length) return undefined;
		if (--work.left < 0) return { unclear: i };
		REDIRECTION.lastIndex = i;
		if (REDIRECTION.test(form)) {
			i = skipBlanks(form, REDIRECTION.lastIndex);
			if (i >= form.length || COMMAND_ENDS.has(form.charAt(i))) return undefined;
			i = Math.max(i + 1, wordAt(form, i, work).end);
			continue;
		}
		const c = form.charAt(i);
		if (c === ")") {
			i++;
			continue;
		}
		if (c === "`") return { unclear: i };
		if (COMMAND_ENDS.has(c)) return undefined;
		const word = wordAt(form, i, work);
		if (word.unclear || ++words > MAX_WORDS) return { unclear: i };
		const start = i;
		i = Math.max(i + 1, word.end);
		if (value) {
			value = false;
			continue;
		}
		const text = word.text;
		if (!positional && text === "--") {
			positional = true;
			continue;
		}
		if (!positional && text.length > 1 && text.startsWith("-")) {
			const equals = text.indexOf("=");
			const name = equals === -1 ? text : text.slice(0, equals);
			if (ORRERY_OPTIONS.valued.has(name)) value = equals === -1;
			else if (equals !== -1 || !ORRERY_OPTIONS.flags.has(name)) return { unclear: start };
			continue;
		}
		const refused = commandName(text);
		return refused === undefined ? undefined : { refused };
	}
}

/**
 * Whether Orrery's program, its name starting at `start`, is the folder a git, make or package manager command works in
 * (git -C ~/src/orrery, npm --prefix …, bun --cwd=…) or the repository of a gh command (-R owner/orrery): the word up to
 * the name is a path, after that tool's own option for it (FOLDER_OPTIONS), in a command of that tool. Looks back
 * LOOK_BACK characters at most, to the command's start.
 */
function folderOf(form: string, start: number): boolean {
	const from = Math.max(0, start - LOOK_BACK);
	const before = form.slice(from, start);
	const cut = Math.max(...[";", "|", "&", "\n", "(", "`"].map((end) => before.lastIndexOf(end)));
	if (cut === -1 && from > 0) return false;
	const parts = before.slice(cut + 1).split(/[ \t]+/);
	const own = parts.pop() ?? "";
	const tool = parts.find((part) => part !== "" && !/^[a-z_][a-z0-9_]*=/.test(part));
	const options = tool === undefined ? undefined : FOLDER_OPTIONS.get(tool.slice(tool.lastIndexOf("/") + 1));
	if (options === undefined) return false;
	const glued = /^["']?(--[a-z]+)=/.exec(own);
	if (!/^["']?(?:[^\s"';|&()<>`=!*?[\]]*\/)?$/.test(glued === null ? own : own.slice(glued[0].length))) return false;
	return options.has(glued === null ? (parts.at(-1) ?? "") : (glued[1] as string));
}

/** First index in an ascending list whose value is at least `at`. */
function firstFrom(list: readonly number[], at: number): number {
	let low = 0;
	let high = list.length;
	while (low < high) {
		const middle = (low + high) >> 1;
		if ((list[middle] as number) < at) low = middle + 1;
		else high = middle;
	}
	return low;
}

/**
 * Where a reading's commands end, in one pass: ;, a pipe, & (but a redirection's, 2>&1 or &>) and a newline, outside
 * quotes ('…', $'…' and "…", with their escapes). A quote left open runs to the end.
 */
function separatorsOf(form: string): number[] {
	const found: number[] = [];
	let quote: "'" | "$'" | '"' | undefined;
	for (let i = 0; i < form.length; i++) {
		const c = form.charAt(i);
		if (quote === "'") {
			if (c === "'") quote = undefined;
		} else if (c === "\\") i++;
		else if (quote === "$'") {
			if (c === "'") quote = undefined;
		} else if (quote === '"') {
			if (c === '"') quote = undefined;
		} else if (c === "'") quote = form[i - 1] === "$" ? "$'" : "'";
		else if (c === '"') quote = '"';
		else if (c === ";" || c === "\n" || (c === "|" && form[i - 1] !== ">") || (c === "&" && form[i - 1] !== ">" && form[i - 1] !== "<" && form[i + 1] !== ">")) found.push(i);
	}
	return found;
}

/**
 * Where a reading fails closed: the refused command named as a word (REFUSED_WORD) between `from` and the next
 * separator (separatorsOf), or anywhere in it (`all`). The words and separators are found once per reading.
 */
function namedAfter(form: string): (from: number, all?: boolean) => string | undefined {
	const named = [...form.matchAll(REFUSED_WORD)];
	const ends = named.map((match) => match.index + match[0].length);
	const separators = separatorsOf(form);
	return (from, all = false) => {
		const next = firstFrom(ends, from + 1);
		const stop = all ? form.length : (separators[firstFrom(separators, from)] ?? form.length);
		return next < ends.length && (ends[next] as number) <= stop ? named[next]?.[1] : undefined;
	};
}

/** The refused command a reading runs (above), or undefined. Linear in the reading's length. */
function refusedCommand(form: string): string | undefined {
	if (!form.includes("orrery") && !form.includes("cli/main.") && !GLOB.test(form)) return undefined;
	const work = { left: 4 * form.length + 4096 };
	const xargs = XARGS.test(form);
	let named: ReturnType<typeof namedAfter> | undefined;
	// Orrery's program by name, and by a glob that could match it, in the order they stand.
	const programs = [
		...[...form.matchAll(PROGRAM_RUN)].map((match) => ({ start: match.index + match[0].length - (match[1] as string).length, end: match.index + match[0].length })),
		...programGlobs(form),
	].sort((a, b) => a.end - b.end);
	for (const { start, end } of programs) {
		if (folderOf(form, start)) continue;
		const fed = xargs ? (named ??= namedAfter(form))(0, true) : undefined;
		if (fed !== undefined) return fed;
		const after = commandAfter(form, end, work);
		if (after === undefined) continue;
		if ("refused" in after) return after.refused;
		const found = (named ??= namedAfter(form))(after.unclear);
		if (found !== undefined) return found;
	}
	return undefined;
}

/** The refused command any of a text's readings runs (above), or undefined. */
function orreryCommandIn(reading: Reading): string | undefined {
	for (const form of [...reading.forms, ...reading.pieces]) {
		const refused = refusedCommand(form);
		if (refused !== undefined) return refused;
	}
	return undefined;
}

/** The Orrery command that agents may not run which shell text runs, in any reading of it (above), or undefined. */
export function runsOrreryCommand(text: string): string | undefined {
	return orreryCommandIn(readings(text));
}

/** Why shell text that runs one of them is refused (runsOrreryCommand). */
export const ORRERY_COMMAND_REFUSED = (command: string) =>
	`orrery ${command} can't run from an agent's shell: agents can't change memory or settings (only orrery help, status, usage, browse, compactor and --version run here). Run it in your own terminal or the TUI. Text that only names it is refused too: search with a file tool, and give git a message that names it from a file (git commit -F).`;

/**
 * How far around a brace group the readings look (Reading.pieces) for the built-in rules: room for the longest fixed
 * name they look for (.terraform.d/credentials.tfrc.json, .pi/agent/models.json, .dev.vars.template) and its edges.
 */
const ENV_REACH = 48;

/**
 * Case-insensitive: on a case-insensitive file system (macOS) ~/.SSH is ~/.ssh. The text is judged as written and as the
 * shell reads it (readings), each by the credential patterns, the built-in secret names (.env and the like) and
 * Orrery's own names. `views`: which agent view file the text may name (viewRules); by default none. The built-in home
 * secrets named only from home (HOME_ONLY) need the guard's home: secretText and secretPath.
 */
export function sensitive(text: string, views: ViewRule = NO_VIEW): boolean {
	return flagged(readings(text), views, false);
}

/**
 * Why an OMP edit's whole text is refused, or undefined: a credential file it names, by sensitive's rules but the
 * built-in secret names, or a built-in home secret spelt from home, then a [guard] protect path entry. Not .env, the
 * other built-in names or a protect name, which its content may name as text (a line of a .gitignore, code that loads
 * it): the edit's targets are still judged as paths, by every rule. Its readings are made once for all, as checkToolCall
 * makes a command's.
 */
export function editTextRefusal(text: string, views: ViewRule, protect: Protection): string | undefined {
	const reading = readings(text, protect.reach);
	if (flagged(reading, views, false, [], false) || secretIn(reading, protect)) return "This edit touches sensitive files (keys, credentials or Orrery's private data).";
	const entry = protect.spelled === undefined ? undefined : protectedIn(reading, protect, false);
	return entry === undefined ? undefined : `This edit touches ${entry}, ${PROTECTED_BY}.`;
}

/**
 * Whether a text's readings name a sensitive file. For `shell` text (a command line, code to run) Orrery's config is
 * refused by name too, since a command could rewrite it (an agent's view and the guard's rules come from it), and so is
 * the config file in use by any of `config`, its spellings (configSpellings); file tools may still read it. `names`:
 * the built-in secret names (.env and .dev.vars, SECRET_NAMES). The credential patterns and the secret names also read
 * the pieces of brace groups the readings could not expand (Reading.pieces), as [guard] protect does; Orrery's own names
 * have their own rule for those (readings).
 */
function flagged(reading: Reading, views: ViewRule, shell: boolean, config: readonly string[] = [], names = true): boolean {
	const builtIn = (text: string) => CREDENTIALS.some((pattern) => pattern.test(text)) || (names && (ENV_FILE.test(text) || SECRET_NAMES.test(text)));
	return reading.forms.some((form) => builtIn(form) || orreryNamed(form, views, shell) || config.some((spelling) => form.includes(spelling))) || reading.pieces.some(builtIn);
}

/** Whether a reading spells a built-in home secret from the guard's home (Protection.secretSpelled). */
function secretIn(reading: Reading, protect: Protection): boolean {
	return reading.forms.some((form) => protect.secretSpelled.test(form)) || reading.pieces.some((piece) => protect.secretSpelled.test(piece));
}

/** Whether a text (a glob, a path as written) spells a built-in home secret from the guard's home, read as shell text is. */
export function secretText(text: string, protect: Protection): boolean {
	return secretIn(readings(text, protect.reach), protect);
}

/**
 * Whether a path (one spelling of it: as written, as the tool resolves it, or real) is a built-in home secret or inside
 * one (Protection.secrets), compared ignoring case, or spells one from home as text (secretText).
 */
export function secretPath(path: string, protect: Protection): boolean {
	const folded = posix.normalize(path).toLowerCase();
	return protect.secrets.some((secret) => within(folded, secret.toLowerCase())) || secretText(path, protect);
}

/** What a refusal for a [guard] protect entry says: the entry is the user's, not a built-in rule, so it names the setting. */
export const PROTECTED_BY = "protected by [guard] protect in Orrery's config";
export const PROTECTED_FILE = (path: string) => `${path} is ${PROTECTED_BY}.`;

/** [guard] protect as the guard matches it (protection). */
export interface Protection {
	/** Each path entry as the config writes it, where it is ("~/" from the guard's home), and where it really is. */
	readonly paths: readonly { readonly entry: string; readonly path: string; readonly real: string }[];
	/** Each name entry by its lower-case name, to the entry as the config writes it. */
	readonly names: ReadonlyMap<string, string>;
	/**
	 * One pattern for every path entry's spellings, with a group per entry in `paths` order, and one for every name, so a
	 * long text is read once for all of them; none for none.
	 */
	readonly spelled?: RegExp;
	readonly named?: RegExp;
	/** How far around a brace group the readings look (Reading.pieces) to hold any spelling or name whole. */
	readonly reach: number;
	/** HOME_SECRETS where they are from the guard's home: built in, so a hit is a sensitive file. */
	readonly secrets: readonly string[];
	/**
	 * HOME_ONLY's spelt from the guard's home ("~", "~user", $HOME, ${HOME…}, the home's path) or where one really is,
	 * as a path entry is spelt (spelled): shell text names them only so.
	 */
	readonly secretSpelled: RegExp;
}

/**
 * A name or path folded for [guard] protect: lower case, and composed (NFC), since macOS file systems take "café" and
 * "cafe" with a combining accent for one name. Only the protect rules fold this way; the built-in patterns are ASCII.
 */
export const foldName = (text: string) => text.toLowerCase().normalize("NFC");

/** Room for the home part of "~user/…" or "${HOME…}/…" in a piece (Protection.reach). */
const HOME_REACH = 32;

/**
 * HOME_ONLY spelt from `home` (`base`, its path without a final "/") as a path entry under home is (protection): "~" or
 * "~user", $HOME, ${HOME…} or the home's path, then the name; and where each really is (`real`), from home the same ways
 * when it is under home, else by its path. Folded, as the readings are. The pattern and the reach a piece needs to hold
 * a spelling whole (Protection.reach).
 */
function secretSpellings(home: string, base: string, real: (path: string) => string): { readonly pattern: RegExp; readonly reach: number } {
	const folded = foldName(base);
	const rests = new Set<string>();
	const elsewhere = new Set<string>();
	for (const name of HOME_ONLY) {
		const path = posix.join(home, name);
		for (const at of [path, real(path)].map(foldName)) {
			if (folded === "" || at.startsWith(`${folded}/`)) rests.add(at.slice(folded.length));
			else elsewhere.add(at);
		}
	}
	// Home as the shell may spell it. Each home-part run stops at the next "~" or "$", so the text is read in linear time.
	// A home of "/" has no path of its own to spell: its names then need a start where a word may begin.
	const homes = ["~[^\\s\"'/;|&()<>`~]*", "\\$home", "\\$\\{home[^}\\s$]*\\}", folded === "" ? "(?:^|[\\s\"'=:<>;|&()`{,@])" : literal(folded)];
	const fromHome = `(?:${homes.join("|")})(?:${[...rests].map(literal).join("|")})`;
	const pattern = new RegExp(`(?:${[fromHome, ...[...elsewhere].map(literal)].join("|")})${NAME_END}`);
	const longest = Math.max(0, ...[...rests].map((rest) => rest.length));
	return { pattern, reach: Math.max(folded.length + longest + 2, HOME_REACH + longest, ...[...elsewhere].map((at) => at.length + 2)) };
}

/**
 * [guard] protect `entries` (GuardOptions.protect) for matching: a path entry from `home`, and where it really is by
 * `real` (a link followed; by default as written); a name entry folded to lower case, as the other rules fold. Made per
 * tool call, as configSpellings is. A path entry under home is spelt by configSpellings, and also from "~" with a user
 * name ("~alex/…") and from a ${HOME…} expansion ("${HOME%/}/…"), as the shell may spell home. The built-in home secrets
 * (HOME_SECRETS) come with it, from the same home: Protection.secrets and secretSpelled.
 */
export function protection(entries: readonly string[] = [], home: string = homedir(), real: (path: string) => string = (path) => path): Protection {
	const paths: { entry: string; path: string; real: string }[] = [];
	const names = new Map<string, string>();
	const spellings: string[] = [];
	const base = posix.normalize(home).replace(/\/+$/, "");
	const secrets = secretSpellings(home, base, real);
	let reach = Math.max(ENV_REACH, secrets.reach);
	for (const entry of entries) {
		if (!entry.includes("/")) {
			names.set(foldName(entry), entry);
			reach = Math.max(reach, entry.length + 2);
			continue;
		}
		const path = (entry.startsWith("~/") ? posix.join(home, entry.slice(2)) : posix.normalize(entry)).replace(/(.)\/+$/, "$1");
		const where = { entry, path, real: real(path) };
		paths.push(where);
		const literals = configSpellings({ configFile: path, home }, where.real).map(foldName);
		const fromHome = base === "" ? [] : [path, where.real].filter((at) => at.startsWith(`${base}/`)).map((at) => literal(foldName(at.slice(base.length))));
		// Each home-part run stops at the next "~" or "$", so the text is read in linear time.
		const patterns = [...literals.map(literal), ...fromHome.flatMap((rest) => [`~[^\\s"'/;|&()<>\`~]*${rest}`, `\\$\\{home[^}\\s$]*\\}${rest}`])];
		spellings.push(`(${patterns.join("|")})`);
		reach = Math.max(reach, ...literals.map((spelling) => spelling.length + HOME_REACH));
	}
	return {
		paths,
		names,
		reach,
		secrets: HOME_SECRETS.map((name) => posix.join(home, name)),
		secretSpelled: secrets.pattern,
		...(spellings.length === 0 ? {} : { spelled: new RegExp(`(?:${spellings.join("|")})${NAME_END}`) }),
		...(names.size === 0 ? {} : { named: new RegExp(`${NAME_START}(${[...names.keys()].map(literal).join("|")})${NAME_END}`) }),
	};
}

/**
 * The [guard] protect entry a text's readings name, or undefined: a path entry by any of its spellings, then (`names`) a
 * name entry as a path segment, the way .ssh is named. The pieces of brace groups the readings could not expand are read
 * too, so a name a group splits past the caps is still found.
 */
function protectedIn(reading: Reading, protect: Protection, names = true): string | undefined {
	for (const forms of [reading.forms, reading.pieces]) {
		// Each reading as it is and composed (foldName): the entries are composed.
		for (const form of forms.flatMap((text) => {
			const composed = text.normalize("NFC");
			return composed === text ? [text] : [text, composed];
		})) {
			const spelled = protect.spelled?.exec(form);
			// The entry whose group matched; the first entry if none can be told (never a match let through).
			if (spelled) return protect.paths[Math.max(0, spelled.findIndex((group, at) => at > 0 && group !== undefined) - 1)].entry;
			const named = names ? protect.named?.exec(form) : undefined;
			if (named) return protect.names.get(named[1]) ?? named[1];
		}
	}
	return undefined;
}

/**
 * The [guard] protect entry `text` (a glob, an OMP edit's whole text) names, read as shell text is (readings), or
 * undefined. `names` false: path entries only, for an OMP edit's text, whose content may name a file as text.
 */
export function textProtected(text: string, protect: Protection, names = true): string | undefined {
	if (protect.spelled === undefined && (!names || protect.named === undefined)) return undefined;
	return protectedIn(readings(text, protect.reach), protect, names);
}

/**
 * The [guard] protect entry a path (one spelling of it: as written, as the tool resolves it, or real) falls under, or
 * undefined: inside a path entry, where it is, where it really is, or as the config writes it (a "~/" path as written);
 * with a part a name entry names (the file, or a folder on the way); or named in it as shell text would name it
 * (textProtected), as sensitive reads a path for the built-in rules. Folded by foldName.
 */
export function pathProtected(path: string, protect: Protection): string | undefined {
	const folded = foldName(posix.normalize(path));
	for (const { entry, path: at, real } of protect.paths) if ([at, real, entry].some((root) => within(folded, foldName(root)))) return entry;
	for (const part of protect.names.size === 0 ? [] : folded.split("/")) {
		const entry = protect.names.get(part);
		if (entry !== undefined) return entry;
	}
	return textProtected(path, protect);
}

/**
 * The spellings of the config file in use (GuardOptions.configFile) that shell text may not hold: its path as given and
 * `real` (where it really is), each also from "~", "$HOME" and "${HOME}" when it is under `home`. Lower case, as the
 * readings are. A relative spelling, or one through another link, is not caught (shell text is a seatbelt).
 */
export function configSpellings(options: Pick<GuardOptions, "configFile"> & { readonly home?: string }, real?: string): string[] {
	if (options.configFile === undefined) return [];
	const home = options.home === undefined ? undefined : posix.normalize(options.home).replace(/\/+$/, "");
	const spellings = new Set<string>();
	for (const path of real === undefined ? [options.configFile] : [options.configFile, real]) {
		const file = posix.normalize(path);
		spellings.add(file.toLowerCase());
		if (home === undefined || home === "" || !file.startsWith(`${home}/`)) continue;
		for (const start of ["~", "$HOME", "${HOME}"]) spellings.add(`${start}${file.slice(home.length)}`.toLowerCase());
	}
	return [...spellings];
}

/** A text as a shell may read it (readings). */
interface Reading {
	/** The whole text, read each way. */
	readonly forms: readonly string[];
	/**
	 * Each brace group the forms could not read alternative by alternative (one past MAX_ALTERNATIVES, or any in a word
	 * past MAX_BRACE_WORD), read as each of its alternatives with up to the readings' reach of text on either side: so a
	 * name or path such a group splits is still spelt whole somewhere. For the .env and [guard] protect rules.
	 */
	readonly pieces: readonly string[];
}

/**
 * The ways a shell (or a path tool) may read a text: as written; with line continuations, quotes, backslashes and empty
 * substitutions gone (bash joins "~/.orr''ery" and "~/.orr$()ery"); with "//", "./" and "x/.." collapsed; for those two,
 * with each brace group {p,q,...} read as each of its alternatives in turn; and, when it has $'…' with an escape, with
 * those escapes read as bash reads them ($'\x2eenv' is .env). `reach`: how much text a piece holds on either side of its
 * group (Reading.pieces).
 */
function readings(text: string, reach = ENV_REACH): Reading {
	const lower = text.toLowerCase();
	const forms = [lower, ...bareForms(lower)];
	const fulls = forms.slice(1, 3);
	// $'…' decoded in the case it is written in (\U takes eight digits, \u four), then read like the rest. Brace groups are
	// read again only in the words that hold one (decodedWords): elsewhere the decoded text is the text, already read.
	if (/\$'[^']*\\/.test(text)) {
		const decoded = text.replace(ANSI_C, (_quoted, body: string) => ansiC(body)).toLowerCase();
		forms.push(decoded, ...bareForms(decoded));
		fulls.push(...bareForms(decodedWords(text).join(" ").toLowerCase()));
	}
	const pieces = new Set<string>();
	for (const full of fulls) {
		// Brace readings cost work per group, so they apply to words of at most MAX_BRACE_WORD characters. A longer word with
		// a brace group is refused if it spells "orr" anywhere (the bare name stands for it); otherwise it gets no reading.
		let base = full;
		if (full.length > MAX_BRACE_WORD) {
			for (const word of full.match(LONG_WORD) ?? []) {
				if (!BRACE_ONE.test(word)) continue;
				if (word.includes("orr")) forms.push("/.orrery");
				const padded = ` ${word} `;
				for (const group of padded.matchAll(BRACE)) piecesOf(padded, group.index, group[0], reach, pieces);
			}
			base = full.replace(LONG_WORD, " ");
		}
		let widest = 0;
		for (const group of base.matchAll(BRACE)) {
			const alternatives = group[1].split(",").length;
			widest = Math.max(widest, alternatives);
			if (alternatives > MAX_ALTERNATIVES) piecesOf(base, group.index, group[0], reach, pieces);
		}
		// Past the cap, a brace body that spells orrery is refused outright (the bare name stands for it).
		if (widest > MAX_ALTERNATIVES && /\{[^{}]*orrery/.test(base)) forms.push("/.orrery");
		for (let pick = 0; pick < Math.min(widest, MAX_ALTERNATIVES); pick++) forms.push(braces(base, pick));
	}
	return { forms: [...new Set(forms)], pieces: [...pieces] };
}

/** A text with line continuations, quotes, backslashes and empty substitutions gone, then that with its paths collapsed. */
function bareForms(text: string): [string, string] {
	let bare = text.replace(/\\\n/g, "").replace(/\$(?=['"])/g, "");
	for (let pass = 0; pass < 4; pass++) {
		const next = bare.replace(/\$\(\)|``/g, "");
		if (next === bare) break;
		bare = next;
	}
	bare = bare.replace(/[\\'"]/g, "");
	return [bare, bare.replace(/[^\s;|&()<>`]+/g, collapse)];
}

/**
 * Each alternative of brace group `group`, at `at` in `text`, with up to `reach` characters of `text` on either side,
 * into `pieces`, and each also with its paths collapsed. An end cut short gets a letter, never a word edge, so a cut
 * makes no name start or end where the text has none. Linear: each piece is at most its alternative and twice `reach`.
 */
function piecesOf(text: string, at: number, group: string, reach: number, pieces: Set<string>): void {
	const end = at + group.length;
	const before = `${at > reach ? "x" : ""}${text.slice(Math.max(0, at - reach), at)}`;
	const after = `${text.slice(end, end + reach)}${end + reach < text.length ? "x" : ""}`;
	for (const alternative of group.slice(1, -1).split(",")) {
		const piece = `${before}${alternative}${after}`;
		pieces.add(piece);
		if (/\/\.|\/\//.test(piece)) pieces.add(piece.replace(/[^\s;|&()<>`]+/g, collapse));
	}
}

/** bash's ANSI-C quoting, $'…', its body in group 1. */
const ANSI_C = /\$'((?:[^'\\]|\\[^])*)'/g;

/** The single-letter escapes of $'…'. */
const ANSI_LETTERS: Readonly<Record<string, string>> = { a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };

/**
 * A $'…' body as bash reads it, in the case it is written in: \xHH, \NNN (octal), \uHHHH, \UHHHHHHHH, \cX and the
 * letter escapes decoded; any other escaped character stands for itself. A code point past Unicode stands for nothing.
 */
function ansiC(body: string): string {
	return body.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|c[^]|[^])/g, (_escape, code: string) => {
		if (/^[xuU][0-9a-fA-F]/.test(code)) {
			const point = Number.parseInt(code.slice(1), 16);
			return point <= 0x10ffff ? String.fromCodePoint(point) : "";
		}
		if (/^[0-7]/.test(code)) return String.fromCharCode(Number.parseInt(code, 8) & 0xff);
		if (code.length === 2 && code[0] === "c") return String.fromCharCode(code.charCodeAt(1) & 0x1f);
		return ANSI_LETTERS[code] ?? code;
	});
}

/** A $'…' starting at lastIndex, to step over one whole while a word is read. */
const ANSI_C_AT = /\$'(?:[^'\\]|\\[^])*'/y;

/**
 * Each word of `text` that holds a $'…', whole (from one word edge to the next, a $'…' stepped over whole even with a
 * blank inside it), with its escapes decoded: what readings reads brace groups in again. Linear: each character of the
 * text is looked at once.
 */
function decodedWords(text: string): string[] {
	const words: string[] = [];
	let end = 0;
	for (const quoted of text.matchAll(ANSI_C)) {
		if (quoted.index < end) continue;
		let start = quoted.index;
		while (start > end && !WORD_EDGE.test(text[start - 1])) start--;
		end = quoted.index + quoted[0].length;
		while (end < text.length && !WORD_EDGE.test(text[end])) {
			ANSI_C_AT.lastIndex = end;
			end = text.startsWith("$'", end) && ANSI_C_AT.test(text) ? ANSI_C_AT.lastIndex : end + 1;
		}
		words.push(text.slice(start, end).replace(ANSI_C, (_quoted, body: string) => ansiC(body)));
	}
	return words;
}

/** One word as a path with "//" and "/." joined and "x/.." removed (a stack, so any depth, in linear time). */
function collapse(word: string): string {
	const stack: string[] = [];
	for (const part of word.split("/")) {
		if (part === "" || part === ".") continue;
		if (part !== "..") stack.push(part);
		else if (stack.length > 0 && stack[stack.length - 1] !== "..") stack.pop();
		else stack.push(part);
	}
	return `${word.startsWith("/") ? "/" : ""}${stack.join("/")}${stack.length > 0 && word.endsWith("/") ? "/" : ""}`;
}

// A brace expansion: one word with a comma inside the braces. Braces holding spaces or no comma (jq, JSON, code) are not.
const MAX_ALTERNATIVES = 64;
const MAX_BRACE_WORD = 4096;
const LONG_WORD = new RegExp(`[^\\s;|&()<>\`]{${MAX_BRACE_WORD + 1},}`, "g");
const BRACE_ONE = /\{[^{}\s,]*(?:,[^{}\s,]*)+\}/;
const BRACE = /\{([^{}\s,]*(?:,[^{}\s,]*)+)\}/g;

/** Each brace group read as alternative `pick` (the last one for a group with fewer). */
function braces(text: string, pick: number): string {
	let out = text;
	for (let pass = 0; pass < 4; pass++) {
		const next = out.replace(BRACE, (_group, body: string) => {
			const alternatives = body.split(",");
			return alternatives[Math.min(pick, alternatives.length - 1)];
		});
		if (next === out) break;
		out = next;
	}
	return out;
}

// Orrery's home is named by its folder, whatever spells the path before it: .orrery as a path segment.
const ORRERY_NAME = /(?:^|[\s/=:~,{])\.orrery(?=$|[/\s|;&)<>,}])([^\s|;&)<>,}]*)/g;
const ORRERY_GLOB = /\.orrery\/+[^\s/|;&)<>]*[*?[]/;

/** The path words after the folder; undefined when a variable or escape could still change them. */
function words(rest: string): string[] | undefined {
	const bare = rest.replace(/["']/g, "");
	return /[$\x60\\]/.test(bare) ? undefined : bare.split("/").filter(Boolean);
}

/** Orrery's program (app/ below, with no "." or ".." or glob in the way) is open. */
function program(parts: string[] | undefined): boolean {
	return parts !== undefined && parts[0] === "app" && parts.every((part) => part !== ".." && part !== "." && !/[*?[{]/.test(part));
}

const only = (parts: string[] | undefined, name: string) => parts?.length === 1 && parts[0] === name;

/**
 * Whether a reading names Orrery's home, beyond what a path may name (the program, app/, and config.toml; neither in
 * `shell` text, where a command could replace them) and the agent view file `views` opens.
 */
function orreryNamed(form: string, views: ViewRule, shell: boolean): boolean {
	if (ORRERY_GLOB.test(form)) return true;
	let opens: ((end: number) => boolean) | undefined;
	for (const match of form.matchAll(ORRERY_NAME)) {
		const parts = words(match[1]);
		if (!shell && (program(parts) || only(parts, "config.toml"))) continue;
		if (!only(parts, "view.md")) return true;
		opens ??= views(form);
		if (!opens(match.index + match[0].length)) return true;
	}
	return false;
}

/** Orrery's config by name (…/.orrery/config.toml, a path folded to lower case): agents may read it, never change it. */
export const orreryConfigNamed = (path: string) => /(^|\/)\.orrery\/config\.toml$/.test(posix.normalize(path).toLowerCase());

/** Why a write to Orrery's config is refused: an agent's view and the guard's rules come from it. */
export const CONFIG_READ_ONLY = (path: string) => `${path} is Orrery's config: agents may read it, not change it.`;

/** Orrery's installed program by name (…/.orrery/app and below, folded to lower case): agents may read it, never change it. */
export const orreryAppNamed = (path: string) => /(^|\/)\.orrery\/app(\/|$)/.test(posix.normalize(path).toLowerCase());

/** Why a write to Orrery's installed program is refused: the hooks and extensions every agent runs are in it. */
export const APP_READ_ONLY = (path: string) => `${path} is Orrery's installed program: agents may read it, not change it.`;

/** Where a gate hands what a write puts in a file to the shared rules (a key no tool's own input has). */
export const NEW_TEXT: unique symbol = Symbol("orrery.newText");

// ---- OpenCode's config and code (ruling 2026-10-17): no agent writes them, in any gate ----
//
// OpenCode 2.0.30 (source at its tag) loads code, runs commands and takes permissions from these, with no trust prompt
// and on a file's change, in its server, next to Orrery's guard. A file another tool writes there runs the next time
// OpenCode opens that folder, so every gate refuses writes to them, and shell text naming them; file tools may read them.
// - In every folder from a session's up to / (core/src/config/discovery.ts:77-85): opencode.json and opencode.jsonc
//   (plugins, MCP server commands, the shell, formatters run on every edit, provider packages imported as code,
//   permissions, agents, commands); a .opencode folder, whole (its own opencode.json(c), plugin(s)/ and the
//   node_modules they import, agent(s)/, mode(s)/, command(s)/ with !`cmd` run at invocation, skill(s)/; Markdown front
//   matter starting ---js is run by gray-matter as it loads: core/src/config/plugin/{agent,command,skill,source}.ts,
//   config/markdown.ts). The skills of .claude and .agents are loaded too (config/plugin/compatibility.ts:40), but they
//   are ordinary files people write: there only front matter that runs as code is refused (openCodeSkillRefusal, below).
//   OpenCode's Plan folder, ~/.opencode/plan, is no config: its plan files may be written (plugin/plan.ts:31); the rest
//   of ~/.opencode is a config root like any other, and holds OpenCode's own binary (bin/opencode).
// - Its own folders: the config folder ($OPENCODE_CONFIG_DIR, else $XDG_CONFIG_HOME/opencode, ~/.config/opencode: its
//   opencode.json(c), plugins/, cli.json with TUI plugins and auto-accepted permissions, service.json's server
//   environment, tui.json), the cache ($XDG_CACHE_HOME/opencode: the npm plugins it imports, bin/rg it runs), the state
//   folder ($XDG_STATE_HOME/opencode: kv.json, migrated into cli.json), its database (saved permissions, a project's
//   start command; $XDG_DATA_HOME/opencode/opencode*.db, $OPENCODE_DB), $OPENCODE_CONFIG, the system folder
//   (/etc/opencode, /Library/Application Support/opencode) and macOS's managed preferences (ai.opencode.managed.plist).
// Limits: a project's node_modules a plugin may import from, and git's hooks OpenCode runs with `git worktree add`, are
// the project's (every tool's own risk too); a spelling of these folders through a variable or a link in shell text.

/** OpenCode's config files by name, in any folder. */
const OPENCODE_FILES = new Set(["opencode.json", "opencode.jsonc", "ai.opencode.managed.plist"]);
/** OpenCode's database files by name (in its data folder). */
const OPENCODE_DATABASE = /^opencode(?:-[a-z0-9._-]+)?\.db(?:-wal|-shm|-journal)?$/;

/** OpenCode's own folders for `home` and `env` (above): absolute, as given (realTarget is the caller's). */
export function openCodeOwnFolders(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
	const xdg = (name: string, fallback: string) => (env[name] && posix.isAbsolute(env[name]) ? (env[name] as string) : posix.join(home, fallback));
	const folders = new Set<string>([
		posix.join(home, ".config", "opencode"),
		posix.join(xdg("XDG_CONFIG_HOME", ".config"), "opencode"),
		posix.join(home, ".cache", "opencode"),
		posix.join(xdg("XDG_CACHE_HOME", ".cache"), "opencode"),
		posix.join(home, ".local", "state", "opencode"),
		posix.join(xdg("XDG_STATE_HOME", ".local/state"), "opencode"),
		"/etc/opencode",
		"/Library/Application Support/opencode",
	]);
	if (env.OPENCODE_CONFIG_DIR) folders.add(posix.resolve(env.OPENCODE_CONFIG_DIR));
	if (env.OPENCODE_CONFIG) folders.add(posix.resolve(env.OPENCODE_CONFIG));
	const data = posix.join(xdg("XDG_DATA_HOME", ".local/share"), "opencode");
	for (const end of ["", "-wal", "-shm", "-journal"]) folders.add(posix.join(data, `opencode.db${end}`));
	if (env.OPENCODE_DB && env.OPENCODE_DB !== ":memory:") folders.add(posix.resolve(data, env.OPENCODE_DB));
	return [...folders].map((folder) => posix.normalize(folder));
}

/** What the OpenCode rule judges against: OpenCode's own folders and the Plan folders (each as given and real, folded). */
export interface OpenCodeRule {
	readonly own: readonly string[];
	/** Each of `own` under home as shell text may spell it from there ("~", "$HOME", "${HOME}"), folded. */
	readonly spelled?: readonly string[];
	/** ~/.opencode/plan, from each spelling of home. */
	readonly plans: readonly string[];
	/** OpenCode's data folders (its database files by name there). */
	readonly data: readonly string[];
}

/** The rule for `home` and `env`; `real` follows links (realTarget), so a root reached through one counts too. */
export function openCodeRule(env: NodeJS.ProcessEnv = process.env, home: string = homedir(), real: (path: string) => string = (path) => path): OpenCodeRule {
	const both = (paths: readonly string[]) => [...new Set(paths.flatMap((path) => [path, real(path)]).map((path) => posix.normalize(path).toLowerCase().replace(/\/+$/, "")))];
	const homes = [home, real(home)];
	const xdgData = env.XDG_DATA_HOME && posix.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : posix.join(home, ".local", "share");
	const own = both(openCodeOwnFolders(env, home));
	const homeFolded = [...new Set(homes.map((at) => posix.normalize(at).toLowerCase().replace(/\/+$/, "")))].filter((at) => at !== "");
	const spelled = own.flatMap((root) => homeFolded.filter((at) => root.startsWith(`${at}/`)).flatMap((at) => ["~", "$home", "${home}"].map((start) => `${start}${root.slice(at.length)}`)));
	return {
		own,
		spelled: [...new Set(spelled)],
		plans: [...new Set(homes.map((at) => posix.join(posix.normalize(at), ".opencode", "plan").toLowerCase()))],
		data: both([posix.join(xdgData, "opencode"), posix.join(home, ".local", "share", "opencode")]),
	};
}

/** Whether an absolute path is OpenCode's config or code (above): one spelling of it, folded and normalized here. */
export function openCodeLoads(path: string, rule: OpenCodeRule): boolean {
	const folded = posix.normalize(path).toLowerCase();
	if (rule.own.some((root) => within(folded, root))) return true;
	const parts = folded.split("/");
	const name = parts.at(-1) ?? "";
	if (OPENCODE_FILES.has(name)) return true;
	if (OPENCODE_DATABASE.test(name) && rule.data.some((data) => folded === posix.join(data, name))) return true;
	// Below the Plan folder only another config folder or file counts: the plan files are no config.
	const plan = rule.plans.find((at) => within(folded, at));
	const rest = plan === undefined ? parts : folded.slice(plan.length).split("/");
	return rest.includes(".opencode");
}

/** Why a write to OpenCode's config or code is refused. */
export const OPENCODE_READ_ONLY = (path: string) =>
	`${path} is OpenCode's config or code (a .opencode folder, opencode.json(c), or OpenCode's own config, cache, state or database), which OpenCode loads and runs: agents may read it, not change it.`;

/** Why shell text naming OpenCode's config or code is refused. */
export const OPENCODE_COMMAND =
	"This command names OpenCode's config or code (a .opencode folder, opencode.json(c), or OpenCode's own config, cache, state or database), which OpenCode loads and runs: agents may read them with file tools, not change them.";

const OC_START = "(?:^|[\\s\"'=:/~<>;|&()`{,@*])";
const OC_END = "(?=$|[\\s\"'/:;|&()<>`,}*?\\[])";
/** OpenCode's config and code named in shell text (readings are lower case): by name, and its folders by their tails. */
const OPENCODE_NAMED = new RegExp(
	[
		`${OC_START}(?:\\.opencode|opencode\\.jsonc?|ai\\.opencode\\.managed\\.plist|opencode(?:-[a-z0-9._-]+)?\\.db(?:-wal|-shm|-journal)?)${OC_END}`,
		`\\.(?:config|cache)/+opencode${OC_END}`,
		`\\.local/+state/+opencode${OC_END}`,
		`(?:^|[\\s"'=:<>;|&()\`{,@])/+etc/+opencode${OC_END}`,
		`application(?:\\\\? |%20)support/+opencode${OC_END}`,
	].join("|"),
);

/** A character that carries a name on past one of OpenCode's own folders (opencode-notes.txt beside ~/.config/opencode). */
const NAME_GOES_ON = /^[a-z0-9._-]$/;

/**
 * Whether a reading names one of OpenCode's own folders (`roots`, folded) by its path: the folder itself or a path below
 * it, not a longer name beside it. Whatever else follows (an end, "/", a space, a quote, ";", a glob, a "$") names it.
 */
function namesOpenCodeFolder(form: string, roots: readonly string[]): boolean {
	return roots.some((root) => {
		for (let at = form.indexOf(root); at !== -1; at = form.indexOf(root, at + 1)) {
			if (!NAME_GOES_ON.test(form.charAt(at + root.length))) return true;
		}
		return false;
	});
}

/** Whether text a shell may run names OpenCode's config or code, in any reading of it; `rule`'s own folders by their path too. */
export function openCodeNamed(text: string, rule?: OpenCodeRule): boolean {
	const named = (form: string) => OPENCODE_NAMED.test(form) || (rule !== undefined && namesOpenCodeFolder(form, [...rule.own, ...(rule.spelled ?? [])]));
	return inAnyReading(text, named);
}

// ---- OpenCode's skills: written as anyone writes them, never with front matter that may run as code ----
//
// OpenCode reads the Markdown of .claude/skills and .agents/skills (in every folder it walks, and home's) as skills,
// through gray-matter 4.0.3 with its default options (core/src/config/markdown.ts: `matter(content, {})`): its only
// delimiter is "---", it takes the rest of a file's first line after it as the front matter's language, and its
// javascript engine (named js or javascript, any case) runs that front matter with eval as the file loads. It registers
// no other code engine by default, but this rule is stricter than gray-matter: a file is refused when its first
// non-blank line (a BOM, blanks and blank lines before it skipped, CRLF read as LF) is "---" followed by anything but
// YAML or JSON, which is "fence-looking" (FENCE). This only ever makes the general rules stricter: a skills path is
// judged by every other rule as well (its folder, links, Orrery's and OpenCode's own files), and the skills rule can
// only refuse. It fails closed:
// - a write is allowed only with its whole text, whose start is judged;
// - an edit (exact replacements) only when the file can be read now and every replacement's old text is in it: the
//   file it would leave is judged, after either reading of a replacement (the first match, or all), and no new text may
//   hold a fence-looking line anywhere (a file changed between the read and the edit, or matched loosely, gets no
//   fence from it);
// - a patch's Add File by its whole text, an Update File only when the file can be read and neither it nor any line the
//   patch adds holds a fence-looking line (which line ends up first is not worked out); a Delete File writes nothing;
// - anything else (a Move to or a rename into a skills folder, a copy, an MCP or unknown tool, an OMP edit, a notebook
//   cell, a file that can't be read) is refused;
// - shell text naming a skills folder is refused, whatever the command (skillsNamed: the readings every protected name
//   gets, so quotes, braces, $'…', case and ".." spellings too): reading skills goes through the file tools.
// Limit (the guard is a seatbelt): two edits racing on one skill file, each judged on the file before the other.

/** Whether a path (one spelling of it) is in a .claude or .agents skills folder. */
export function openCodeSkillPath(path: string): boolean {
	const parts = posix.normalize(path).toLowerCase().split("/");
	return parts.some((part, at) => (part === ".claude" || part === ".agents") && parts[at + 1] === "skills");
}

/**
 * What a write puts in a file, as far as a gate can see: the whole file (a write, a patch's Add File), exact
 * replacements in it (an edit), or the lines a patch's Update File adds. Undefined where the gate can't see it.
 */
export type NewText =
	| { readonly whole: string }
	| { readonly edits: readonly { readonly old: string; readonly new: string }[] }
	| { readonly update: readonly string[] };

/** A line that may open front matter gray-matter runs as code: "---" and anything but YAML or JSON after it. */
const FENCE = /^[\s﻿]*-{3}[ \t]*(?!(?:ya?ml|json)?[ \t]*$)\S/i;

/** Whether a file with this text may start with front matter OpenCode runs as code (its first non-blank line). */
export function runsAsCode(text: string): boolean {
	const first = text.replace(/\r/g, "").replace(/^[\s﻿]+/, "").split("\n")[0] ?? "";
	return FENCE.test(first);
}

/** Whether text holds a fence-looking line anywhere (a patch's added line may start with its "+"). */
function holdsFence(text: string): boolean {
	return text.replace(/\r/g, "").split("\n").some((line) => FENCE.test(line));
}

/** Why a write is refused there. */
export const SKILL_CODE = (path: string) =>
	`${path} is a skill OpenCode loads (a .claude or .agents skills folder), and this would give it front matter OpenCode may run as code (a "---" line naming something other than YAML or JSON, such as ---js); give the skill YAML front matter (---) instead.`;
export const SKILL_UNSEEN = (path: string) =>
	`${path} is a skill OpenCode loads (a .claude or .agents skills folder), whose front matter may run as code, and Orrery can't see what this would leave at the file's start; write the file whole, or edit it with exact text it holds.`;
export const SKILL_SHELL =
	"This command names a skills folder OpenCode loads (.claude or .agents skills), whose front matter may run as code; read skills with the file tools (read, glob, grep) and write them with write or edit, which check them.";

/**
 * Why a write of `text` to `path` (as written or placed) or `real` (where it lands) is refused for a skill's front
 * matter, or undefined (a path in no skills folder, or a write it can judge as safe). `current`: the file's text now,
 * read by the caller (undefined: not read, missing or unreadable).
 */
export function openCodeSkillRefusal(path: string, real: string, text: NewText | undefined, current: string | undefined): string | undefined {
	if (!openCodeSkillPath(path) && !openCodeSkillPath(real)) return undefined;
	if (text === undefined) return SKILL_UNSEEN(path);
	if ("whole" in text) return runsAsCode(text.whole) ? SKILL_CODE(path) : undefined;
	if ("update" in text) {
		if (text.update.some((line) => FENCE.test(line))) return SKILL_CODE(path);
		if (current === undefined) return SKILL_UNSEEN(path);
		return holdsFence(current) ? SKILL_CODE(path) : undefined;
	}
	if (text.edits.some((edit) => holdsFence(edit.new))) return SKILL_CODE(path);
	if (current === undefined || text.edits.some((edit) => edit.old === "" || !current.includes(edit.old))) return SKILL_UNSEEN(path);
	let first = current;
	let all = current;
	for (const edit of text.edits) {
		first = first.includes(edit.old) ? first.replace(edit.old, () => edit.new) : first;
		all = all.split(edit.old).join(edit.new);
	}
	return runsAsCode(first) || runsAsCode(all) ? SKILL_CODE(path) : undefined;
}

/** What a write puts in a file: what a gate handed over (NEW_TEXT, undefined there meaning unseen), else by pi's arguments. */
export function newTextIn(tool: string, args: Readonly<Record<string, unknown>>): NewText | undefined {
	return NEW_TEXT in args ? (args as { readonly [NEW_TEXT]?: NewText })[NEW_TEXT] : piNewText(tool, args);
}

/** What pi's write and edit (and orrery run's) put in a file, by their arguments; undefined for any other shape. */
export function piNewText(tool: string, args: Readonly<Record<string, unknown>>): NewText | undefined {
	if (tool === "write") return typeof args.content === "string" ? { whole: args.content } : undefined;
	if (tool !== "edit" || !Array.isArray(args.edits) || args.edits.length === 0) return undefined;
	const edits = args.edits as { oldText?: unknown; newText?: unknown }[];
	if (!edits.every((edit) => typeof edit?.oldText === "string" && typeof edit.newText === "string")) return undefined;
	return { edits: edits.map((edit) => ({ old: edit.oldText as string, new: edit.newText as string })) };
}

const PATCH_HEADER = /^\*\*\* (Add File|Update File|Delete File|Move to): (.*)$/;

/**
 * What a patch (the *** Begin Patch format Codex and OpenCode share) puts in each of its files: an Add File's whole
 * text (its "+" lines), an Update File's added lines, nothing for a Delete File. A target the patch names in two ways,
 * a Move to target (its text is the file it moves), and one this reading doesn't find are unseen (undefined).
 */
export function patchNewText(patch: string): (target: string) => NewText | undefined {
	const files = new Map<string, NewText | "unseen">();
	let into: { readonly target: string; readonly kind: string; readonly lines: string[] } | undefined;
	const close = () => {
		if (into === undefined) return;
		const text: NewText | "unseen" = into.kind === "Add File" ? { whole: into.lines.length === 0 ? "" : `${into.lines.join("\n")}\n` } : into.kind === "Update File" ? { update: into.lines } : into.kind === "Delete File" ? { whole: "" } : "unseen";
		const before = files.get(into.target);
		files.set(into.target, before === undefined ? text : before !== "unseen" && text !== "unseen" && "update" in before && "update" in text ? { update: [...before.update, ...text.update] } : "unseen");
		into = undefined;
	};
	for (const raw of patch.split("\n")) {
		const line = raw.replace(/\r$/, "");
		const header = PATCH_HEADER.exec(line.trim());
		if (header !== null) {
			const kind = header[1] as string;
			const target = (header[2] as string).trim();
			if (kind === "Move to") {
				close();
				files.set(target, "unseen");
				continue;
			}
			close();
			into = { target, kind, lines: [] };
		} else if (into !== undefined && line.startsWith("+")) into.lines.push(line.slice(1));
	}
	close();
	return (target) => {
		const text = files.get(target.trim());
		return text === undefined || text === "unseen" ? undefined : text;
	};
}

const SKILLS_NAMED = new RegExp(`${OC_START}\\.(?:claude|agents)/+skills${OC_END}`);

/** Whether shell text names a skills folder (above), in any reading of it. */
export function skillsNamed(text: string): boolean {
	return inAnyReading(text, (form) => SKILLS_NAMED.test(form));
}

// ---- Claude Code's and Codex's session records (spec 2026-10-18-agent-permissions §3c) ----
//
// Orrery keeps a prompt as the person's words only once the tool's own record of the session has it: Claude Code's
// transcripts in its projects folder (~/.claude/projects, or $CLAUDE_CONFIG_DIR/projects) and Codex's rollouts in its
// sessions folder (~/.codex/sessions, or $CODEX_HOME/sessions). An agent that wrote a line there could fake one, so no
// file tool writes there, in any gate, and no shell text names them; file tools may read them. A project's memory folder
// there (Claude Code's auto memory, ruling C10) stays writable: it is no record of a session. In shell text they are
// named by their tails anywhere (.claude/projects, .codex/sessions, $CLAUDE_CONFIG_DIR/projects, $CODEX_HOME/sessions),
// with the readings every name gets, by a glob that could name one beside its parent's name (~/.claude/pro*,
// ~/.c*/projects; not ~/.claude/*.json), and by their paths where they are elsewhere (moved, or reached through a link,
// spelt from home too); a file tool's write by its path and by those names. Limits, as for every shell-text rule: a
// spelling through another variable, a relative one after a cd into them (cd ~/.claude && … projects/…), a tool that
// walks a parent folder (find ~/.claude -exec …), or a link the guard doesn't know.

/** The session records' folders (transcriptRule). */
export interface TranscriptRule {
	/** Claude Code's projects folders, as given and where they really are (normalized; compared ignoring case). */
	readonly claude: readonly string[];
	/** Codex's sessions folders, the same way. */
	readonly codex: readonly string[];
	/** Those of them that their tails don't name, spelt as a [guard] protect path entry is (protection); none for none. */
	readonly spelled?: Protection;
}

/** The session records for `env` and `home`; `real` follows links (realTarget), so a folder reached through one counts too. */
export function transcriptRule(env: NodeJS.ProcessEnv = process.env, home: string = homedir(), real: (path: string) => string = (path) => path): TranscriptRule {
	const claude = [posix.join(home, ".claude", "projects"), ...(env.CLAUDE_CONFIG_DIR ? [posix.join(posix.resolve(env.CLAUDE_CONFIG_DIR), "projects")] : [])];
	const codex = [posix.join(home, ".codex", "sessions"), ...(env.CODEX_HOME ? [posix.join(posix.resolve(env.CODEX_HOME), "sessions")] : [])];
	const both = (paths: readonly string[]) => [...new Set(paths.flatMap((path) => [path, real(path)]).map((path) => posix.normalize(path).replace(/(.)\/+$/, "$1")))];
	const folders = { claude: both(claude), codex: both(codex) };
	// As written (protection folds them itself, after spelling them from home, which may hold capitals).
	const elsewhere = [...folders.claude, ...folders.codex].filter((path) => !/\/\.(?:claude\/projects|codex\/sessions)$/i.test(path));
	return elsewhere.length === 0 ? folders : { ...folders, spelled: protection(elsewhere, home) };
}

/**
 * Whether a path (one spelling of it) is in the session records (above): in one of their folders, or below
 * .claude/projects or .codex/sessions anywhere; not in a project's memory folder in Claude Code's. Ignoring case.
 */
export function transcriptPath(path: string, rule: Pick<TranscriptRule, "claude" | "codex">): boolean {
	const folded = posix.normalize(path).toLowerCase();
	const parts = folded.split("/");
	for (let at = 0; at + 1 < parts.length; at++) {
		if (parts[at] === ".codex" && parts[at + 1] === "sessions") return true;
		if (parts[at] === ".claude" && parts[at + 1] === "projects" && parts[at + 3] !== "memory") return true;
	}
	// What follows a folder in the path, or undefined when the path is not in it.
	const inside = (folder: string) => {
		const root = posix.normalize(folder.toLowerCase()).replace(/(.)\/+$/, "$1");
		return within(folded, root) ? folded.slice(root.length + 1) : undefined;
	};
	if (rule.codex.some((folder) => inside(folder) !== undefined)) return true;
	return rule.claude.some((folder) => {
		const rest = inside(folder);
		return rest !== undefined && rest.split("/")[1] !== "memory";
	});
}

/** The session records named in shell text by their tails (readings are lower case). */
const TRANSCRIPTS_NAMED = new RegExp(
	`(?:${OC_START}\\.claude|\\$(?:claude_config_dir|\\{claude_config_dir[^}\\s$]*\\}))/+projects${OC_END}|(?:${OC_START}\\.codex|\\$(?:codex_home|\\{codex_home[^}\\s$]*\\}))/+sessions${OC_END}`,
);

/** The records' parents and folders as a glob may name them: the parent's name (or the variable for it) and the folder's. */
const RECORD_FOLDERS = [
	{ parent: ".claude", variable: /^\$\{?claude_config_dir\}?$/, folder: "projects" },
	{ parent: ".codex", variable: /^\$\{?codex_home\}?$/, folder: "sessions" },
];

/**
 * Whether a reading names the session records with a glob (narrowly): a path part right after .claude/, .codex/,
 * $CLAUDE_CONFIG_DIR/ or $CODEX_HOME/ that could match projects or sessions, or a part that could match .claude or
 * .codex (starting with its dot, as a shell's glob must) before /projects or /sessions. Linear: each word is read once.
 */
function recordsGlob(form: string): boolean {
	if (!GLOB.test(form)) return false;
	for (const match of form.matchAll(GLOB_WORDS)) {
		const word = match[0];
		if (!GLOB.test(word)) continue;
		const parts = word.split("/").filter((part) => part !== "");
		for (let at = 0; at + 1 < parts.length; at++) {
			const [parent, folder] = [parts[at] as string, parts[at + 1] as string];
			if (!GLOB.test(parent) && !GLOB.test(folder)) continue;
			for (const record of RECORD_FOLDERS) {
				const parentNamed = parent === record.parent || record.variable.test(parent) || (parent.startsWith(".") && globCouldName(parent, [record.parent]) !== undefined);
				if (parentNamed && (folder === record.folder || globCouldName(folder, [record.folder]) !== undefined)) return true;
			}
		}
	}
	return false;
}

/**
 * Whether shell text (`command`, with its readings `reading`, made with `reach`) names the session records (above): by
 * their tails or a glob of them, or by the paths of those elsewhere, read again with room for them when they need more.
 */
function transcriptsNamed(command: string, reading: Reading, reach: number, rule: TranscriptRule): boolean {
	const named = (form: string) => TRANSCRIPTS_NAMED.test(form) || recordsGlob(form);
	if (reading.forms.some(named) || reading.pieces.some(named)) return true;
	if (rule.spelled === undefined) return false;
	return protectedIn(rule.spelled.reach > reach ? readings(command, rule.spelled.reach) : reading, rule.spelled, false) !== undefined;
}

/** Why shell text naming the session records is refused. */
export const TRANSCRIPT_COMMAND =
	"This command names Claude Code's or Codex's session records (~/.claude/projects, ~/.codex/sessions), which Orrery checks prompts against: agents may read them with file tools, not with commands.";

/** Why a write there is refused. */
export const TRANSCRIPT_READ_ONLY = (path: string) =>
	`${path} is in Claude Code's or Codex's session records (~/.claude/projects, ~/.codex/sessions), which Orrery checks prompts against: agents may read them, not change them.`;

// ---- A plain read of skill files, for Codex's own shell ----
//
// Codex reads files only through its shell, so refusing every command that names a skills folder would leave it no way
// to read its own skills. Its shell may run one plain read instead, a grammar rather than a list of commands with open
// options: exactly `cat <file>...`, `head [-n N] <file>`, `tail [-n N] <file>`, `sed -n '<A>,<B>p' <file>` (the range
// Codex reads files with), `ls <dir>` or `wc <file>...`. One simple command: no other option, no redirection, pipe, `;`,
// `&&`, `&`, newline, comment, substitution, variable, glob, brace, escape or `~user`; a word may be quoted, its text
// only plain path characters. Every reading of the text (quotes, $'…', braces, backslashes, paths collapsed) must be
// that same read, or it is refused.

/** What a plain read of skill files reads (skillShellRead): its program, and each file (a folder, for ls) as the shell hands it over. */
export interface SkillShellRead {
	readonly program: "cat" | "head" | "tail" | "sed" | "ls" | "wc";
	readonly paths: readonly string[];
}

/** A character a plain word may hold, quoted or not. */
const PLAIN_CHAR = /^[A-Za-z0-9._/@+,=:%-]$/;

/**
 * The words of a text that is one plain command (above), as the shell hands them over: quotes gone, in their own case;
 * undefined when anything in it is more than that. A word starts with "~" only as "~" or "~/…" (home), unquoted.
 */
function plainWords(text: string): string[] | undefined {
	const words: string[] = [];
	let word: string | undefined;
	for (let at = 0; at < text.length; at++) {
		const char = text.charAt(at);
		if (char === " " || char === "\t") {
			if (word !== undefined) words.push(word);
			word = undefined;
		} else if (char === "'" || char === '"') {
			const end = text.indexOf(char, at + 1);
			if (end === -1) return undefined;
			const quoted = text.slice(at + 1, end);
			if (![...quoted].every((inner) => PLAIN_CHAR.test(inner))) return undefined;
			word = (word ?? "") + quoted;
			at = end;
		} else if (char === "~" && word === undefined && (at + 1 === text.length || [" ", "\t", "/"].includes(text.charAt(at + 1)))) {
			word = "~";
		} else if (PLAIN_CHAR.test(char)) {
			word = (word ?? "") + char;
		} else {
			return undefined;
		}
	}
	if (word !== undefined) words.push(word);
	return words;
}

/** The plain read `words` make (above), or undefined. */
function plainRead(words: readonly string[]): SkillShellRead | undefined {
	const [program, ...rest] = words;
	const file = (word: string | undefined): word is string => word !== undefined && word !== "" && !word.startsWith("-");
	const count = /^[0-9]{1,9}$/;
	switch (program) {
		case "cat":
		case "wc":
			return rest.length > 0 && rest.every(file) ? { program, paths: rest } : undefined;
		case "head":
		case "tail":
			if (rest.length === 1 && file(rest[0])) return { program, paths: rest };
			return rest.length === 3 && rest[0] === "-n" && count.test(rest[1] as string) && file(rest[2]) ? { program, paths: [rest[2]] } : undefined;
		case "sed":
			return rest.length === 3 && rest[0] === "-n" && /^[0-9]{1,9},[0-9]{1,9}p$/.test(rest[1] as string) && file(rest[2]) ? { program, paths: [rest[2]] } : undefined;
		case "ls":
			return rest.length === 1 && file(rest[0]) ? { program, paths: rest } : undefined;
		default:
			return undefined;
	}
}

/** The longest text a plain read may be. */
const PLAIN_READ_MAX = 4096;

/**
 * The plain read of files shell text is (above), when it is one in every reading of it; undefined otherwise. Its paths
 * are as the shell hands them over (the text's own case, quotes gone).
 */
export function skillShellRead(text: string): SkillShellRead | undefined {
	if (text.length > PLAIN_READ_MAX) return undefined;
	const words = plainWords(text);
	const read = words === undefined ? undefined : plainRead(words);
	if (read === undefined) return undefined;
	const fits = (form: string) => {
		const inForm = plainWords(form);
		return inForm !== undefined && plainRead(inForm) !== undefined;
	};
	return inAnyReading(text, (form) => !fits(form)) ? undefined : read;
}

/**
 * Whether a reading opens the agent view file it names, the name ending at `end`: made once per reading (`views(form)`),
 * then asked for each view file the reading names.
 */
export type ViewRule = (form: string) => (end: number) => boolean;

/** No view file is open. */
const NO_VIEW: ViewRule = () => () => false;

/** A session's view rules (GuardOptions.foreignViews): for command text and file-name globs, for OMP's tool roots, and for one path. */
export interface ViewRules {
	/** Command text's: a view file is open where a plain absolute word names the session's own (commandRule). */
	readonly command: ViewRule;
	/**
	 * OMP's tool roots' (a search path, an ast_edit target; read like a command's words): as `command`, and also a plain
	 * "~/" word from the guard's home. OMP expands "~" in its own process, which a shell's `export HOME` cannot reach.
	 */
	readonly tool: ViewRule;
	/** A path's: its view file is open when the path is a spelling of the session's own view; without a path, none is. */
	readonly path: (path?: string) => ViewRule;
}

const fold = (path: string) => posix.normalize(path).toLowerCase();

/**
 * The view rules for `options`. `own`: each spelling of the session's own view (as written, and where it really is);
 * default ownView alone. `options.home` is what "~/" means to OMP's tools (ViewRules.tool).
 */
export function viewRules(options: GuardOptions & { readonly home?: string }, own: readonly string[] = options.ownView === undefined ? [] : [options.ownView]): ViewRules {
	const mine = new Set(own.map(fold));
	return {
		command: commandRule(mine),
		tool: commandRule(mine, options.home),
		path: (path) => {
			const open = path !== undefined && mine.has(fold(path));
			return () => () => open;
		},
	};
}

/** Where the shell starts or ends a word: a blank or newline, a control operator, a redirection, a subshell, a backquote. */
const WORD_EDGE = /[ \t\n;|&()<>`]/;
/** A character of a plain path word: no word edge, quote, escape, expansion, glob, brace, "~", ",", "=", ":" or "!". */
const PLAIN = /[^ \t\n;|&()<>`"'\\$*?[\]{}~,=:!]/;

/**
 * Command text's view rule: a view file is open only where a plain word names the session's own (`own`, folded) by its
 * absolute path, or, given a `home` (OMP's tool roots, ViewRules.tool), by "~/" from it. A relative word is refused: a
 * shell may keep a folder of its own (OMP's does, across calls), so the host's cwd is no proof of where it starts. So is
 * "~/" in shell text: the shell's ~ follows its HOME, which a command may change; OMP's tools expand ~ in OMP's own
 * process, from the home the guard knows. The word must start and end where the shell's words do (an edge, not escaped)
 * and hold no ".." (a link may lead it elsewhere). The guard cannot read a word with quotes, escapes, variables, globs or
 * braces, so a view file named that way is refused.
 */
function commandRule(own: ReadonlySet<string>, home?: string): ViewRule {
	const fromHome = home === undefined ? undefined : posix.normalize(home).replace(/\/+$/, "");
	return (form) => (end) => {
		if (end < form.length && !WORD_EDGE.test(form[end])) return false;
		let start = end;
		while (start > 0 && PLAIN.test(form[start - 1])) start--;
		// With a home, "~/" may begin the word: the one "~" a plain word may hold.
		if (fromHome !== undefined && start > 0 && start < end && form[start - 1] === "~" && form[start] === "/") start--;
		const word = form.slice(start, end);
		if (start > 0 && (!WORD_EDGE.test(form[start - 1]) || form[start - 2] === "\\")) return false;
		if (word.split("/").includes("..")) return false;
		if (word.startsWith("~/")) return fromHome !== undefined && own.has(fold(fromHome + word.slice(1)));
		return word.startsWith("/") && own.has(fold(word));
	};
}

/**
 * Whether the real path `where` is inside Orrery's home (`realData`, also real) beyond what is open: app/ and config.toml.
 * Both exceptions are compared on the real path with no link followed from them, so a planted link named app or
 * config.toml cannot widen them. Case-insensitive, like the other path rules.
 */
export function inOrreryHome(where: string, realData: string): boolean {
	const path = where.toLowerCase();
	const data = realData.toLowerCase();
	return within(path, data) && path !== posix.join(data, "config.toml") && !within(path, posix.join(data, "app"));
}

export function within(path: string, root: string): boolean {
	const normalizedRoot = posix.normalize(root).replace(/\/+$/, "");
	return path === normalizedRoot || path.startsWith(`${normalizedRoot}/`);
}

/**
 * A cheap pre-filter on the raw arguments; the authoritative file check is checkResolvedPath. `views`: viewRules;
 * `config`: configSpellings; `protect`: protection, with the built-in home secrets, "~" from the OS's home by default.
 */
export function checkToolCall(
	call: { readonly name: string; readonly arguments: Readonly<Record<string, unknown>> },
	options: GuardOptions,
	views: ViewRules = viewRules(options),
	config: readonly string[] = configSpellings(options),
	protect: Protection = protection(options.protect),
): string | undefined {
	let rule = options.openCode;
	const openCode = () => (rule ??= openCodeRule(process.env, (options as { readonly home?: string }).home ?? homedir()));
	let records = options.transcripts;
	const transcripts = () => (records ??= transcriptRule(process.env, (options as { readonly home?: string }).home ?? homedir()));
	const command = call.arguments.command;
	if (call.name === "bash" && typeof command === "string") {
		// Shell text's readings, made once: sensitive by flagged's rules for shell text and the built-in home secrets spelt
		// from home, then the [guard] protect entries.
		const reading = readings(command, protect.reach);
		if (flagged(reading, views.command, true, config) || secretIn(reading, protect)) return "This command touches sensitive files (keys, credentials or Orrery's private data).";
		const entry = protectedIn(reading, protect);
		if (entry !== undefined) return `This command touches ${entry}, ${PROTECTED_BY}.`;
		if (reading.forms.some(runsPlumbing) || reading.pieces.some(runsPlumbing)) return PLUMBING_REFUSED;
		// The readings made above, once for every rule.
		const inReading = (test: (form: string) => boolean) => reading.forms.some(test) || reading.pieces.some(test);
		const own = [...openCode().own, ...(openCode().spelled ?? [])];
		if (inReading((form) => OPENCODE_NAMED.test(form) || namesOpenCodeFolder(form, own))) return OPENCODE_COMMAND;
		if (inReading((form) => SKILLS_NAMED.test(form)) && !(options.shellReadsSkills === true && skillShellRead(command) !== undefined)) return SKILL_SHELL;
		// Last, so a command refused before keeps its reason: Orrery's commands that change memory or settings, and the
		// tools' session records.
		const orrery = orreryCommandIn(reading);
		if (orrery !== undefined) return ORRERY_COMMAND_REFUSED(orrery);
		if (transcriptsNamed(command, reading, protect.reach, transcripts())) return TRANSCRIPT_COMMAND;
	}
	const raw = call.arguments.path;
	if (typeof raw !== "string") return undefined;
	const path = posix.normalize(posix.isAbsolute(raw) ? raw : posix.join(options.cwd ?? options.folder, raw));
	const named = views.path(path);
	if (sensitive(raw, named) || sensitive(path, named) || secretPath(raw, protect) || secretPath(path, protect)) return `${path} is a sensitive file (keys, credentials or Orrery's private data).`;
	if (pathProtected(raw, protect) !== undefined || pathProtected(path, protect) !== undefined) return PROTECTED_FILE(path);
	const writes = call.name === "write" || call.name === "edit";
	if (writes && (orreryConfigNamed(path) || config.includes(path.toLowerCase()))) return CONFIG_READ_ONLY(path);
	if (writes && orreryAppNamed(path)) return APP_READ_ONLY(path);
	if (writes && openCodeLoads(path, openCode())) return OPENCODE_READ_ONLY(path);
	// A whole write to a skill is judged here; an edit, which needs the file's text, by the caller that can read it.
	const written = newTextIn(call.name, call.arguments);
	const skill = writes && written !== undefined && "whole" in written ? openCodeSkillRefusal(path, path, written, undefined) : undefined;
	if (skill !== undefined) return skill;
	if (writes && ![options.folder, ...options.allowedRoots].some((root) => within(path, root))) {
		return `${path} is outside this agent's folder and allowed roots.`;
	}
	if (writes && transcriptPath(path, transcripts())) return TRANSCRIPT_READ_ONLY(path);
	return undefined;
}
