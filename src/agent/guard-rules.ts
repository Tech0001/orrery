/** The agent guard's pure rules (spec §6): which tool calls and paths are refused. No pi-durable here. */

import { homedir } from "node:os";
import { posix } from "node:path";

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
// comma (a group past the brace readings' caps), or "*" (a glob that matches the bare name too). After it: the text's
// end, a blank, a quote, "/", ":", a shell operator, a backquote, a comma or closing brace, or a glob character. A path
// entry's spelling ends the same way (Protection.spelled), so ~/finance never stands for ~/finance-old.
const NAME_START = "(?:^|[\\s\"'=:/~<>;|&()`{,*])";
const NAME_END = "(?=$|[\\s\"'/:;|&()<>`,}*?\\[])";

/**
 * The built-in .env rule (spec 2026-10-15-guard-protect): .env and .env.<anything> standing as a name, but not the
 * examples meant to be shared (.env.example, .env.sample, .env.template, each followed by a plain end, not a glob). As a
 * name, so process.env, import.meta.env, prod.env and .envrc never match. What follows ".env." holds no character a name
 * starts or ends at, so a try reads no further than the next place a name may start: the text is read in linear time.
 */
const ENV_FILE = new RegExp(
	`${NAME_START}\\.env(?!\\.(?:example|sample|template)(?=$|[\\s"'/:;|&()<>\`,}]))(?:\\.[^\\s"'=:/~<>;|&()\`{,*}?\\[]*)?${NAME_END}`,
);

/**
 * Case-insensitive: on a case-insensitive file system (macOS) ~/.SSH is ~/.ssh. The text is judged as written and as the
 * shell reads it (readings), each by the credential patterns, the built-in .env rule and Orrery's own names. `views`:
 * which agent view file the text may name (viewRules); by default none.
 */
export function sensitive(text: string, views: ViewRule = NO_VIEW): boolean {
	return flagged(readings(text.toLowerCase()), views, false);
}

/**
 * sensitive without the built-in .env rule: for an OMP edit's whole text, whose content may name .env as text (a line of
 * a .gitignore, code that loads it). The edit's targets are still judged as paths, .env included.
 */
export function credentialNamed(text: string, views: ViewRule = NO_VIEW): boolean {
	return flagged(readings(text.toLowerCase()), views, false, [], false);
}

/**
 * Whether readings `forms` name a sensitive file. For `shell` text (a command line, code to run) Orrery's config is
 * refused by name too, since a command could rewrite it (an agent's view and the guard's rules come from it), and so is
 * the config file in use by any of `config`, its spellings (configSpellings); file tools may still read it. `env`: the
 * built-in .env rule.
 */
function flagged(forms: readonly string[], views: ViewRule, shell: boolean, config: readonly string[] = [], env = true): boolean {
	return forms.some(
		(form) =>
			SENSITIVE.some((pattern) => pattern.test(form)) ||
			(env && ENV_FILE.test(form)) ||
			orreryNamed(form, views, shell) ||
			config.some((spelling) => form.includes(spelling)),
	);
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
	/** Each spelling shell text may name a path entry by (configSpellings), to its entry. */
	readonly spellings: ReadonlyMap<string, string>;
	/** One pattern for every spelling, and one for every name, so a long text is read once for all of them; none for none. */
	readonly spelled?: RegExp;
	readonly named?: RegExp;
}

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * [guard] protect `entries` (GuardOptions.protect) for matching: a path entry from `home`, and where it really is by
 * `real` (a link followed; by default as written); a name entry folded to lower case, as the other rules fold. Made per
 * tool call, as configSpellings is.
 */
export function protection(entries: readonly string[] = [], home: string = homedir(), real: (path: string) => string = (path) => path): Protection {
	const paths: { entry: string; path: string; real: string }[] = [];
	const names = new Map<string, string>();
	const spellings = new Map<string, string>();
	for (const entry of entries) {
		if (!entry.includes("/")) {
			names.set(entry.toLowerCase(), entry);
			continue;
		}
		const path = (entry.startsWith("~/") ? posix.join(home, entry.slice(2)) : posix.normalize(entry)).replace(/(.)\/+$/, "$1");
		const where = { entry, path, real: real(path) };
		paths.push(where);
		for (const spelling of configSpellings({ configFile: path, home }, where.real)) if (!spellings.has(spelling)) spellings.set(spelling, entry);
	}
	return {
		paths,
		names,
		spellings,
		...(spellings.size === 0 ? {} : { spelled: new RegExp(`(?:${[...spellings.keys()].map(literal).join("|")})${NAME_END}`) }),
		...(names.size === 0 ? {} : { named: new RegExp(`${NAME_START}(${[...names.keys()].map(literal).join("|")})${NAME_END}`) }),
	};
}

/**
 * The [guard] protect entry readings `forms` name, or undefined: a path entry by any of its spellings, then (`names`) a
 * name entry as a path segment, the way .ssh is named.
 */
function protectedIn(forms: readonly string[], protect: Protection, names = true): string | undefined {
	for (const form of forms) {
		const spelled = protect.spelled?.exec(form);
		if (spelled) return protect.spellings.get(spelled[0]);
		const named = names ? protect.named?.exec(form) : undefined;
		if (named) return protect.names.get(named[1]);
	}
	return undefined;
}

/**
 * The [guard] protect entry `text` (a glob, an OMP edit's whole text) names, read as shell text is (readings), or
 * undefined. `names` false: path entries only, for an OMP edit's text, whose content may name a file as text.
 */
export function textProtected(text: string, protect: Protection, names = true): string | undefined {
	if (protect.spelled === undefined && (!names || protect.named === undefined)) return undefined;
	return protectedIn(readings(text.toLowerCase()), protect, names);
}

/**
 * The [guard] protect entry a path (one spelling of it: as written, as the tool resolves it, or real) falls under, or
 * undefined: inside a path entry, where it is, where it really is, or as the config writes it (a "~/" path as written);
 * or with a part a name entry names (the file, or a folder on the way). Folded, as the other path rules are.
 */
export function pathProtected(path: string, protect: Protection): string | undefined {
	const folded = posix.normalize(path).toLowerCase();
	for (const { entry, path: at, real } of protect.paths) if ([at, real, entry].some((root) => within(folded, root.toLowerCase()))) return entry;
	if (protect.names.size === 0) return undefined;
	for (const part of folded.split("/")) {
		const entry = protect.names.get(part);
		if (entry !== undefined) return entry;
	}
	return undefined;
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

/**
 * The ways a shell (or a path tool) may read a text: as written; with line continuations, quotes, backslashes and empty
 * substitutions gone (bash joins "~/.orr''ery" and "~/.orr$()ery"); with "//", "./" and "x/.." collapsed; and, for those
 * two, with each brace group {p,q,...} read as each of its alternatives in turn.
 */
function readings(lower: string): string[] {
	let bare = lower.replace(/\\\n/g, "").replace(/\$(?=['"])/g, "");
	for (let pass = 0; pass < 4; pass++) {
		const next = bare.replace(/\$\(\)|``/g, "");
		if (next === bare) break;
		bare = next;
	}
	bare = bare.replace(/[\\'"]/g, "");
	const collapsed = bare.replace(/[^\s;|&()<>`]+/g, collapse);
	const forms = [lower, bare, collapsed];
	for (const full of [bare, collapsed]) {
		// Brace readings cost work per group, so they apply to words of at most MAX_BRACE_WORD characters. A longer word with
		// a brace group is refused if it spells "orr" anywhere (the bare name stands for it); otherwise it gets no reading.
		let base = full;
		if (full.length > MAX_BRACE_WORD) {
			for (const word of full.match(LONG_WORD) ?? []) {
				if (word.includes("orr") && BRACE_ONE.test(word)) forms.push("/.orrery");
			}
			base = full.replace(LONG_WORD, " ");
		}
		let widest = 0;
		for (const group of base.matchAll(BRACE)) widest = Math.max(widest, group[1].split(",").length);
		// Past the cap, a brace body that spells orrery is refused outright (the bare name stands for it).
		if (widest > MAX_ALTERNATIVES && /\{[^{}]*orrery/.test(base)) forms.push("/.orrery");
		for (let pick = 0; pick < Math.min(widest, MAX_ALTERNATIVES); pick++) forms.push(braces(base, pick));
	}
	return [...new Set(forms)];
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
 * `config`: configSpellings; `protect`: protection, "~" from the OS's home by default.
 */
export function checkToolCall(
	call: { readonly name: string; readonly arguments: Readonly<Record<string, unknown>> },
	options: GuardOptions,
	views: ViewRules = viewRules(options),
	config: readonly string[] = configSpellings(options),
	protect: Protection = protection(options.protect),
): string | undefined {
	const command = call.arguments.command;
	if (call.name === "bash" && typeof command === "string") {
		// Shell text's readings, made once: sensitive by flagged's rules for shell text, then the [guard] protect entries.
		const forms = readings(command.toLowerCase());
		if (flagged(forms, views.command, true, config)) return "This command touches sensitive files (keys, credentials or Orrery's private data).";
		const entry = protectedIn(forms, protect);
		if (entry !== undefined) return `This command touches ${entry}, ${PROTECTED_BY}.`;
	}
	const raw = call.arguments.path;
	if (typeof raw !== "string") return undefined;
	const path = posix.normalize(posix.isAbsolute(raw) ? raw : posix.join(options.cwd ?? options.folder, raw));
	const named = views.path(path);
	if (sensitive(raw, named) || sensitive(path, named)) return `${path} is a sensitive file (keys, credentials or Orrery's private data).`;
	if (pathProtected(raw, protect) !== undefined || pathProtected(path, protect) !== undefined) return PROTECTED_FILE(path);
	const writes = call.name === "write" || call.name === "edit";
	if (writes && (orreryConfigNamed(path) || config.includes(path.toLowerCase()))) return CONFIG_READ_ONLY(path);
	if (writes && orreryAppNamed(path)) return APP_READ_ONLY(path);
	if (writes && ![options.folder, ...options.allowedRoots].some((root) => within(path, root))) {
		return `${path} is outside this agent's folder and allowed roots.`;
	}
	return undefined;
}
