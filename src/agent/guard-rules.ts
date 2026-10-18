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
	/**
	 * OpenCode's config and code (openCodeRule), which no tool writes and no shell text names; default: from this
	 * process's environment and the guard's home.
	 */
	readonly openCode?: OpenCodeRule;
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
 *   (`echo holder | xargs orrery`) nor a quoted separator between them (`orrery --config ';' holder`) splits them.
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
const ORRERY_PROGRAM = new RegExp(`${PLUMBING_START}(?:orrery(?:\\.exe)?|cli/main\\.[cm]?[jt]s)(?=$|[\\s"';|&()<>\`{}$\\\\])`);
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

/** Whether a reading runs Orrery's hook plumbing (HOOK_COMMAND; ORRERY_PROGRAM with HOLDER_WORD). Linear. */
function runsPlumbing(form: string): boolean {
	return HOOK_COMMAND.test(form) || (form.includes("holder") && ORRERY_PROGRAM.test(form) && HOLDER_WORD.test(form));
}

/** Why shell text that runs Orrery's hook plumbing is refused (runsPlumbing). */
export const PLUMBING_REFUSED = "This command runs Orrery's hook plumbing (codex-hook, claude-hook, orrery holder), which only Orrery's own hooks run.";

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
	return {
		own: both(openCodeOwnFolders(env, home)),
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

/** Whether text a shell may run names OpenCode's config or code, in any reading of it; `rule`'s own folders by their spelling too. */
export function openCodeNamed(text: string, rule?: OpenCodeRule): boolean {
	const named = (form: string) => OPENCODE_NAMED.test(form) || (rule?.own.some((root) => form.includes(root)) ?? false);
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
		const own = openCode().own;
		if (inReading((form) => OPENCODE_NAMED.test(form) || own.some((root) => form.includes(root)))) return OPENCODE_COMMAND;
		if (inReading((form) => SKILLS_NAMED.test(form))) return SKILL_SHELL;
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
	return undefined;
}
