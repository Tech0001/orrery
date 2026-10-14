/**
 * The lane guard's path judgment for any agent's tool calls, shared by pi (src/pi/guard.ts) and Claude Code
 * (src/claude/guard.ts). It judges the path the tool will actually touch: resolved the way the tool resolves it (pi's
 * way by default), then with symlinks followed. The rules themselves are src/lane/guard-rules.ts.
 *
 * Another lane's memory view (laneViews) is kept from every tool that reads, writes or searches file contents. Orrery's
 * config (the file in use, GuardOptions.configFile, and any .orrery/config.toml) and its installed program (.orrery/app)
 * are read-only: file tools may read them, no tool may write them, and shell text may not name them. Known limits:
 * - A hard link is another name for the same file, and the guard does not count links: one to another lane's view (the
 *   copy goes stale once Orrery replaces the view on its next write), or to the config file in use, made before the
 *   guard ran or by a spelling it cannot see, reads or writes the file through a name the guard does not know.
 * - The durable harness (src/lane/guard.ts, `orrery run`) has no search-root rule, for views as for credentials.
 * - Claude Code loads a subfolder's CLAUDE.md (and what it imports) by itself once the session reads files there. That
 *   is no tool call, so the hook never sees it.
 * - Shell text is a seatbelt: a view named through a variable, an escape, or a command that changes folder by its own
 *   flag (`git -C`, `tar -C`), or a shell search of a lane's whole folder, gets through. So does a config file in use at a
 *   custom path (ORRERY_CONFIG) when it is named by a relative path, through a link, or by a variable: only its exact
 *   path spellings are known (configSpellings).
 * - A deleted config is no config: Claude Code then runs plain, and so do pi and OMP sessions started after it. Deleting
 *   it takes a spelling the guard cannot see (its name and its path are refused in commands; no file tool deletes).
 * - A pi or OMP session that starts while the config cannot be read (src/pi/index.ts unreadableGuard) knows no lane, so
 *   its foreignViews is empty: other lanes' views are still refused by name in commands and paths, but a content search
 *   (grep) of a lane's folder is not, since the guard cannot know which folders hold a view.
 */

import { lstatSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { viewFile } from "../claude/paths.ts";
import { laneMode } from "../claude/view-file.ts";
import type { HarnessConfig, LaneConfig } from "./config.ts";
import {
	APP_READ_ONLY,
	CONFIG_READ_ONLY,
	checkToolCall,
	configSpellings,
	type GuardOptions,
	inOrreryHome,
	orreryAppNamed,
	orreryConfigNamed,
	sensitive,
	viewRules,
	within,
} from "./guard-rules.ts";

const UNICODE_SPACES = /[  -   　]/g;

/**
 * Mirrors pi's resolveToCwd (pi packages/coding-agent/src/core/tools/path-utils.ts, which calls resolvePath in
 * src/utils/paths.ts; neither is exported). Update this if pi changes: strip one leading "@", unicode spaces to " ",
 * "~" and "~/…" to the home directory, file:// URLs, then resolve against cwd.
 */
export function piToolPath(raw: string, cwd: string, home: string = homedir()): string {
	let path = raw.replace(UNICODE_SPACES, " ");
	if (path.startsWith("@")) path = path.slice(1);
	if (path === "~") path = home;
	else if (path.startsWith("~/")) path = join(home, path.slice(2));
	else if (/^file:\/\//.test(path)) path = fileURLToPath(path);
	return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

/** The real location of a path that may not exist yet: realpath of its deepest existing ancestor plus the remainder. */
export function realTarget(path: string, depth = 0): string {
	const full = resolve(path);
	try {
		return realpathSync(full);
	} catch {
		// fall through: missing, or a dangling symlink
	}
	try {
		if (lstatSync(full).isSymbolicLink() && depth < 40) return realTarget(resolve(dirname(full), readlinkSync(full)), depth + 1);
	} catch {
		// not there at all
	}
	const parent = dirname(full);
	if (parent === full) return full;
	return join(realTarget(parent, depth), full.slice(parent.length + (parent.endsWith("/") ? 0 : 1)));
}

const realRoot = (root: string) => realTarget(root);

/** pi's search tools: grep and find search hidden files too, and their path defaults to the cwd. */
const SEARCHES = new Set(["grep", "find", "ls"]);

/** Credential folders and files under the home directory (besides what the name patterns catch anywhere). */
const HOME_CREDENTIALS = [
	".ssh",
	".gnupg",
	".pi/agent/models.json",
	".pi/agent/auth.json",
	".omp/agent/agent.db",
	".omp/agent/models.yml",
	".omp/agent/.env",
	".omp/agent/secrets.yml",
	".omp/.env",
	".aws/credentials",
	".kube/config",
	".docker/config.json",
	".config/gh/hosts.yml",
	".netrc",
	".git-credentials",
	".pgpass",
];

/** Where a tool call runs: the lane's roots, the tool's cwd, the home folder and any more credential files. */
export interface PathGuardOptions extends GuardOptions {
	readonly cwd: string;
	/** The home directory "~" means; default: the OS's. */
	readonly home?: string;
	/** More credential files by absolute path (orrery's own credentials.json, pi's files in a moved agent dir). */
	readonly credentials?: readonly string[];
	/** Orrery's home (data_dir): refused whole, except app/ (the installed program) and config.toml (no secrets by rule). */
	readonly orreryData?: string;
	/** How the tool resolves the path it is given, to the file it will open; default: pi's (piToolPath). */
	readonly resolvePath?: (raw: string, cwd: string, home: string) => string;
}

/** The agent dir PI_CODING_AGENT_DIR moves pi's (and OMP's) to, if set. */
function movedAgentDir(env: NodeJS.ProcessEnv, home: string): string | undefined {
	const dir = env.PI_CODING_AGENT_DIR;
	if (!dir) return undefined;
	return dir === "~" ? home : dir.startsWith("~/") ? join(home, dir.slice(2)) : resolve(dir);
}

/** pi's models.json and auth.json when PI_CODING_AGENT_DIR moves pi's agent dir away from ~/.pi/agent. */
export function movedAgentDirCredentials(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
	const agentDir = movedAgentDir(env, home);
	return agentDir === undefined ? [] : [join(agentDir, "models.json"), join(agentDir, "auth.json")];
}

/** The names in folder `dir`, sorted; none when it cannot be listed. Names only: nothing under them is read. */
function namesIn(dir: string): string[] {
	try {
		return readdirSync(dir).sort();
	} catch {
		return [];
	}
}

/**
 * OMP's credential stores beyond ~/.omp (spec 2026-10-10-omp-design §2 Guard): each named profile's, the config root
 * PI_CONFIG_DIR moves ~/.omp to (joined under home as OMP joins it, utils/src/dirs.ts getBaseConfigRoot) and its
 * profiles, an agent dir moved by PI_CODING_AGENT_DIR, and agent.db under $XDG_DATA_HOME/omp and in each profile there.
 * OMP 18.8.7 moves only its data there (utils/src/dirs.ts:366-418), so models.yml, .env and secrets.yml stay in the
 * agent dir. agent.db holds OMP's logins; models.yml, the .env files OMP loads from a config root and its agent dir
 * (utils/src/env.ts:288-291) and secrets.yml (secrets/index.ts:166-168) may hold keys. Profiles are listed by folder
 * name only.
 */
export function ompCredentials(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
	const stores = (agentDir: string) => ["agent.db", "models.yml", ".env", "secrets.yml"].map((name) => join(agentDir, name));
	// A config root: its .env and its agent dir. Then each named profile's, a config root of its own.
	const root = (dir: string) => [join(dir, ".env"), ...stores(join(dir, "agent"))];
	const profiles = (base: string) => namesIn(join(base, "profiles")).flatMap((name) => root(join(base, "profiles", name)));
	const found = profiles(join(home, ".omp"));
	const configDir = env.PI_CONFIG_DIR;
	if (configDir && configDir !== ".omp") found.push(...root(join(home, configDir)), ...profiles(join(home, configDir)));
	const moved = movedAgentDir(env, home);
	if (moved !== undefined) found.push(...stores(moved));
	if (env.XDG_DATA_HOME) {
		const data = join(env.XDG_DATA_HOME, "omp");
		found.push(join(data, "agent.db"), ...namesIn(join(data, "profiles")).map((name) => join(data, "profiles", name, "agent.db")));
	}
	return found;
}

/**
 * The guard's view options (GuardOptions.foreignViews, fileModeViews and ownView) for a session of lane `own`, or of no
 * lane (a refused pick): every other lane's view file (Claude Code's file mode keeps it in the lane's folder), as its
 * folder is written and where it really is; which of them belong to lanes set up the file way (their setup marker); and
 * the session's own view, unless another lane's is the same file (two lanes in one folder, compared ignoring case as
 * the guard compares paths). A lane with no folder has no view file.
 */
export function laneViews(
	config: Pick<HarnessConfig, "lanes">,
	own?: Pick<LaneConfig, "name" | "workspace">,
): { readonly foreignViews: string[]; readonly fileModeViews: string[]; readonly ownView?: string } {
	const others = [...config.lanes.values()].filter((lane) => lane.name !== own?.name && lane.workspace !== undefined);
	const spellings = (lane: LaneConfig) => {
		const view = viewFile(lane.workspace as string);
		return [view, realTarget(view)];
	};
	const foreignViews = [...new Set(others.flatMap(spellings))];
	const fileModeViews = [...new Set(others.filter((lane) => laneMode(lane) === "file").flatMap(spellings))];
	const ownView = own?.workspace === undefined ? undefined : viewFile(own.workspace);
	const taken = new Set(foreignViews.map((view) => view.toLowerCase()));
	const shared = ownView !== undefined && [ownView, realTarget(ownView)].some((view) => taken.has(view.toLowerCase()));
	return ownView === undefined || shared ? { foreignViews, fileModeViews } : { foreignViews, fileModeViews, ownView };
}

/** Whether something is at `path` (a dangling link counts): a search that would read it is refused. */
function present(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

/** The folder a path or glob starts from: everything before the segment holding its first wildcard ("~/**\/x" → "~"). */
export function globBase(path: string): string {
	const wild = path.search(/[*?[{]/);
	if (wild === -1) return path;
	const slash = path.lastIndexOf("/", wild);
	return slash === -1 ? "." : slash === 0 ? "/" : path.slice(0, slash);
}

/** A string without the double quotes around it, as OMP's stripOuterDoubleQuotes (tools/path-utils.ts:529). */
function unquote(text: string): string {
	return text.length > 1 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text;
}

/**
 * OMP's tools read several paths from one string (tools/path-utils.ts:565, :673, :763): trimmed and unquoted, then split
 * at ;, commas or spaces, each part unquoted again. All of them, the raw string first.
 */
export function pathParts(raw: string): string[] {
	const whole = unquote(raw.trim());
	const parts = whole
		.split(/[;,\s]+/)
		.map(unquote)
		.filter((part) => part !== "");
	return [...new Set([raw, whole, ...parts])];
}

/**
 * Mirrors OMP 18.8.7's expandPath and resolveToCwd (packages/coding-agent/src/tools/path-utils.ts:110-130, :320), which
 * its tools resolve paths with. Update this if OMP changes: trimmed and unquoted (its normalizePathLikeInput, :565), a
 * stray ":" before a path dropped, a leading "@" dropped, unicode spaces to " ", file:// URLs in any case, "~", "~/…"
 * and any other "~x" under home ("~." is home), then resolved against cwd. Where OMP is looser the guard takes the
 * stricter reading: "@" goes before anything (OMP: only before "/" or "~"), and a bare "/" stays the filesystem root
 * (OMP: the cwd).
 */
export function ompToolPath(raw: string, cwd: string, home: string = homedir()): string {
	let path = unquote(raw.trim());
	if (/^:(?=[/\\~]|\.\.?[/\\]|[A-Za-z]:)/.test(path)) path = path.slice(1);
	if (path.startsWith("@")) path = path.slice(1);
	path = path.replace(UNICODE_SPACES, " ");
	if (/^file:\/\//i.test(path)) {
		try {
			path = fileURLToPath(path);
		} catch {
			// not a file URL after all: a name like any other
		}
	}
	if (path === "~") path = home;
	else if (path.startsWith("~/") || path.startsWith("~\\")) path = home + path.slice(1);
	else if (path.startsWith("~")) path = join(home, path.slice(1));
	return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

/**
 * The other reading of an edit target written "~/" + an absolute path ("~//etc/x", "~\/etc/x"): OMP's native edit
 * resolver (pi-edit path_policy.rs expand_path, :366-428) joins what follows "~/" onto home with Rust's Path::join, where
 * an absolute rest replaces home, so it writes /etc/x; its TS tools and ompToolPath read <home>/etc/x. Read after the
 * steps both take first (trimmed and unquoted, a stray ":" and "@" dropped, unicode spaces to " "). A backslash rest
 * counts as absolute too (stricter than Rust on Unix). Undefined for any other path.
 */
function nativeTildeRest(raw: string): string | undefined {
	let path = unquote(raw.trim());
	if (/^:(?=[/\\~]|\.\.?[/\\]|[A-Za-z]:)/.test(path)) path = path.slice(1);
	if (path.startsWith("@")) path = path.slice(1);
	const rest = /^~[/\\]([/\\][^]*)$/.exec(path.replace(UNICODE_SPACES, " "))?.[1];
	return rest?.replace(/^[/\\]+/, "/");
}

/** Leading or trailing whitespace as either side strips it: JS's \s, plus U+0085 (NEL), which Rust's trim() strips. */
const EDGE_SPACE = /^[\s\u0085]+|[\s\u0085]+$/g;

/** The path in a `[path#TAG]` hashline header, as OMP's write and edit read it (tools/plan-mode-guard.ts:55-72, pi-edit path_policy.rs:319-330); else `target`. */
function headerPath(target: string): string {
	const trimmed = target.replace(/[\s\u0085]+$/, "");
	if (trimmed.length < 2 || !trimmed.startsWith("[") || !trimmed.endsWith("]")) return target;
	const inner = trimmed.slice(1, -1);
	const tag = /#[0-9A-Fa-f]{4}$/.exec(inner);
	const path = tag ? inner.slice(0, tag.index) : inner;
	return path === "" || (!tag && path.includes("#")) ? target : path;
}

/** What Rust's trim() strips (Unicode White_Space): JS's \s without U+FEFF, plus U+0085. */
const RUST_SPACE = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const RUST_TRIM = new RegExp(`^[${RUST_SPACE}]+|[${RUST_SPACE}]+$`, "g");

/** apply_patch noise OMP strips from the front of a hashline path: `*** Update File:`, `add:`, `move to:`… (pi-edit hashline/input.rs:28-32). */
const PATH_NOISE = new RegExp(
	`^\\*{0,3}[${RUST_SPACE}]*(?:(?:update|add|delete|move)[^A-Za-z0-9]*(?:file|to)?[^A-Za-z0-9]*:)?[${RUST_SPACE}]*\\*{0,3}[${RUST_SPACE}]*`,
	"i",
);

/**
 * A header path or MV destination as OMP's hashline parser normalizes it (pi-edit hashline/input.rs:207-209, applied at
 * :85, :254, :288): trimmed as Rust trims, one pair of quotes dropped, then the noise above stripped.
 */
function hashlinePath(path: string): string {
	const trimmed = path.replace(RUST_TRIM, "");
	const quoted = trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'") && trimmed.endsWith(trimmed[0]);
	return (quoted ? trimmed.slice(1, -1) : trimmed).replace(PATH_NOISE, "");
}

/**
 * Every reading of an edit target OMP may write to: as written, unwrapped from a `[path#TAG]` header, and normalized as
 * the hashline parser normalizes it, in any order and as often as they change it (OMP's header recovery normalizes
 * twice, hashline/input.rs:270-288). Each step only shortens the path, so this ends.
 */
function editForms(path: string): string[] {
	const forms = [path];
	for (let at = 0; at < forms.length; at++) {
		for (const next of [headerPath(forms[at]), hashlinePath(forms[at])]) if (next !== "" && !forms.includes(next)) forms.push(next);
	}
	return forms;
}

/** A path named in an edit's text, as OMP reads it (extensibility/tool-event-input.ts:36-47): trimmed (U+0085 too), no #TAG, no quotes around it. */
function namedPath(body: string): string {
	const trimmed = body.replace(EDGE_SPACE, "");
	const tag = /#[0-9a-fA-F]{4}$/.exec(trimmed);
	const path = tag ? trimmed.slice(0, tag.index).replace(EDGE_SPACE, "") : trimmed;
	return path.length > 1 && (path[0] === '"' || path[0] === "'") && path.endsWith(path[0]) ? path.slice(1, -1) : path;
}

/**
 * A line (other than a column-0 `[` row) that OMP may read as an edit directive naming a target, at the position its
 * parsers read it (fix round 4, OMP 18.8.7):
 * - a legacy `¶` header, any indentation (OMP's event input, tool-event-input.ts:55);
 * - `MV` with OMP's boundary (end, whitespace or `:`), any indentation: hashline trims the row (tokenizer.rs:499-518);
 * - exactly three stars, then a header word (Begin/End/Update/Add/Delete/Move/Edit/Rename) and File/Patch/to/of, any
 *   indentation (apply_patch.rs:22-27 after js_trim; sloppy/parse.rs HEADER_RE and ENVELOPE_LINE_RE after trim).
 * Whitespace is JS's plus U+0085, which Rust's trim() strips. Such a line must read cleanly or the edit is refused
 * (fix round 3 ruling: fail closed with bounded rules).
 */
function directive(line: string): boolean {
	return (
		/^[\s\u0085]*(?:¶|MV(?=$|[\s\u0085:]))/.test(line) ||
		/^[\s\u0085]*\*{3}[\s\u0085]*(?:begin|end|update|add|delete|move|edit|rename)[\s\u0085]+(?:file|patch|to|of)\b/i.test(line)
	);
}

/** The directive forms the guard reads besides hashline headers: legacy header, move, apply_patch file and move, sloppy. */
const TARGET_LINES: readonly RegExp[] = [
	/^[\s\u0085]*¶+(.+)$/,
	/^[\s\u0085]*MV[\s\u0085]+(.+)$/,
	/^[\s\u0085]*\*\*\* (?:Add|Update|Delete) File: (.+)$/,
	/^[\s\u0085]*\*\*\* Move to: (.+)$/,
	/^[\s\u0085]*\*\*\*[\s\u0085]+Edit[\s\u0085]+File:(.+)$/i,
];

/** Sloppy mode's file header: a trailing " all" (any case) is a flag, not part of its path (sloppy/parse.rs:130-155). */
const SLOPPY_HEADER = TARGET_LINES[4];

/** apply_patch's and sloppy's envelope lines, which name no path: *** Begin Patch, *** End Patch, *** End of File, *** Begin edits… */
const ENVELOPE = /^[\s\u0085]*\*{3}[\s\u0085]*(?:begin|end)(?:[\s\u0085]+of)?[\s\u0085]+(?:patch|edits?|file)[\s\u0085]*$/i;

/** The markers OMP's hashline parser unwraps from the front of a bracketed row (hashline/input.rs:25-26). */
const BRACKETED_MARKERS = ["*** Begin Patch", "*** End Patch", "*** Abort"];

/**
 * A bracketed row without the markers OMP unwraps from its front, as its unbracket_envelope_markers (hashline/input.rs:
 * 308-327): "[*** Begin Patch] [a.ts#1A2B]" → "[a.ts#1A2B]"; "" when the row is nothing but markers.
 */
function unbracketMarkers(row: string): string {
	let rest = row;
	for (;;) {
		if (!rest.startsWith("[")) return rest;
		const inner = rest.slice(1).replace(/^[\s\u0085]+/, "");
		const marker = BRACKETED_MARKERS.find((name) => inner.startsWith(name));
		if (marker === undefined) return rest;
		let tail = inner.slice(marker.length).replace(/^[\s\u0085]+/, "");
		if (tail.startsWith("]")) tail = tail.slice(1).replace(/^[\s\u0085]+/, "");
		if (tail === "") return "";
		rest = tail;
	}
}

/**
 * A path the guard can judge as OMP will read it: no `*` noise, no backslash, no control characters (C1 included: U+0085
 * is whitespace to Rust). Outside a hashline header, also no nested header and no quotes left (sloppy JSON-decodes a
 * quoted path, sloppy/parse.rs:150-151); inside one, brackets and quotes are file-name characters (OMP's resolver
 * unwraps one more `[path]`, which editForms judges too).
 */
function cleanTarget(path: string, header = false): boolean {
	if (path === "" || path.startsWith("*") || path.includes("***") || /[\\\u0000-\u001f\u0080-\u009f]/.test(path)) return false;
	return header || (!path.startsWith("[") && !path.includes('"'));
}

/**
 * What an OMP edit's text says it edits, read at the positions OMP's parsers read (fix round 4):
 * - A column-0 `[` row (no OMP parser that writes reads an indented one): after the bracketed envelope markers OMP
 *   unwraps, a `[path#TAG]` header. A row not ending in `]`, or with an empty path, is content (OMP's hashline parser
 *   refuses it before writing, hashline/input.rs:247-268; sloppy and apply_patch read it as text); a bracketed marker
 *   alone names nothing.
 * - Any other directive line (above): legacy `¶path`, `MV dest`, apply_patch's `*** Add/Update/Delete File:` and
 *   `*** Move to:`, sloppy's `*** Edit File:` (with and without a trailing ` all`); envelope lines name nothing.
 * `paths` are the targets as OMP's event input names them; `forms` add each line's literal text (apply_patch and sloppy
 * keep a #TAG or quotes). `unreadable` when a directive line does not read cleanly as one of these.
 */
function readEditText(text: string): { readonly paths: string[]; readonly forms: string[]; readonly unreadable: boolean } {
	const paths: string[] = [];
	const forms: string[] = [];
	let unreadable = false;
	const take = (named: readonly string[], literal: readonly string[], header = false) => {
		if (named.every((path) => cleanTarget(path, header))) {
			paths.push(...named);
			forms.push(...named, ...literal);
		} else unreadable = true;
	};
	for (const raw of text.replace(/^\uFEFF/, "").split("\n")) {
		const line = raw.replace(/\r$/, "");
		if (line.startsWith("[")) {
			const row = line.replace(/[\s\u0085]+$/, "");
			if (!row.endsWith("]")) continue;
			const header = unbracketMarkers(row);
			if (header === "") continue;
			if (!header.startsWith("[")) {
				unreadable = true;
				continue;
			}
			// An empty header ("[ ]", "[#1a2b]") is refused by OMP's hashline parser before it writes (hashline/input.rs:254-257).
			const path = namedPath(header.slice(1, -1));
			if (path !== "") take([path], [], true);
			continue;
		}
		if (!directive(line) || ENVELOPE.test(line)) continue;
		const form = TARGET_LINES.find((pattern) => pattern.test(line));
		const body = form?.exec(line)?.[1];
		if (form === undefined || body === undefined) {
			unreadable = true;
			continue;
		}
		const literal = body.replace(EDGE_SPACE, "");
		const flagless = form === SLOPPY_HEADER ? literal.replace(/[\s\u0085]+all$/i, "") : literal;
		const named = [...new Set([literal, flagless].filter((path) => path !== "").map(namedPath))];
		take(named, [literal, flagless]);
	}
	return { paths: [...new Set(paths)], forms: [...new Set(forms)], unreadable };
}

/** The files an OMP edit's text names (readEditText), for tests and callers that only need the paths. */
export function editTargets(text: string): string[] {
	return readEditText(text).paths;
}

/** Each start of `path` that ends just before a ":" or "?": the file OMP's read opens once it peels a selector (":10-20", ":raw", a SQLite ":table", "?q="). */
function selectorPrefixes(path: string): string[] {
	const found: string[] = [];
	for (let at = 1; at < path.length; at++) if (path[at] === ":" || path[at] === "?") found.push(path.slice(0, at));
	return found;
}

/** A file:// URL Node cannot read as a path (a host such as "~", an encoded "/"): OMP's own parser may still read one somewhere. */
function unreadableFileUrl(raw: string): boolean {
	let path = unquote(raw.trim());
	if (path.startsWith("@")) path = path.slice(1);
	path = path.replace(UNICODE_SPACES, " ");
	if (!/^file:\/\//i.test(path)) return false;
	try {
		fileURLToPath(path);
		return false;
	} catch {
		return true;
	}
}

/** A glob that reaches past its base folder: brace alternatives, or a ".." segment after a wildcard ("src/*\/../../x"). */
function escapingGlob(path: string): boolean {
	if (/[{}]/.test(path)) return true;
	const segments = path.split("/");
	const wild = segments.findIndex((segment) => /[*?[]/.test(segment));
	return wild !== -1 && segments.slice(wild + 1).includes("..");
}

const SENSITIVE_FILE = (path: string) => `${path} is a sensitive file (keys, credentials or Orrery's private data).`;
const OTHER_VIEW = (path: string) => `${path} is another agent's memory view.`;

/** Which view files a command or path may name (GuardOptions.foreignViews): the session's own, as given and real. */
const viewsOf = (options: PathGuardOptions, home: string) =>
	viewRules({ ...options, home }, options.ownView === undefined ? [] : [options.ownView, realTarget(options.ownView)]);

/** pi's searches that list names only (ls, and find, which runs fd): no file's contents, so no view's. */
const LISTINGS = new Set(["ls", "find"]);

/** Why a tool call (in pi's tool names and arguments) is refused, or undefined to let it through. */
export function guardToolCall(toolName: string, input: Readonly<Record<string, unknown>>, options: PathGuardOptions): string | undefined {
	const home = options.home ?? homedir();
	const search = SEARCHES.has(toolName);
	const views = viewsOf(options, home);
	// The arguments that name files: grep's glob and find's pattern (a file-name glob). grep's pattern is the text it
	// searches for, so code that mentions auth.json can still be searched. A glob opens no view file: a path does.
	const nameKey = toolName === "grep" ? "glob" : toolName === "find" ? "pattern" : undefined;
	const names = nameKey === undefined ? undefined : input[nameKey];
	if (typeof names === "string" && sensitive(names, views.path())) return `${toolName} ${nameKey} "${names}" names sensitive files (keys, credentials or Orrery's private data).`;
	// The config file in use, as given and where it really is: named in no command, written by no tool.
	const config = configSpellings({ ...options, home }, options.configFile === undefined ? undefined : realTarget(options.configFile));
	const given = typeof input.path === "string" && input.path !== "" ? input.path : undefined;
	const raw = given ?? (search ? "." : undefined);
	if (raw === undefined) return checkToolCall({ name: toolName, arguments: input }, options, views, config);
	// All three forms: what the model wrote, where the tool resolves it, and where it really lands.
	const resolved = (options.resolvePath ?? piToolPath)(raw, options.cwd, home);
	const named = views.path(resolved);
	if (sensitive(raw, named) || sensitive(resolved, named)) return SENSITIVE_FILE(raw);
	const target = realTarget(resolved);
	if (sensitive(target, views.path(target))) return SENSITIVE_FILE(raw);
	// Orrery's config is read, never written: a lane's view and these rules come from it.
	const writes = toolName === "write" || toolName === "edit";
	const isConfig = (path: string) => orreryConfigNamed(path) || config.includes(path.toLowerCase());
	if (writes && (isConfig(resolved) || isConfig(target))) return CONFIG_READ_ONLY(raw);
	// So is Orrery's installed program (app/): the hooks and extensions every lane runs are in it.
	if (writes && (orreryAppNamed(resolved) || orreryAppNamed(target))) return APP_READ_ONLY(raw);
	// The credential locations themselves, symlinks followed (a ~/.ssh linked from a dotfiles folder, say). Compared
	// ignoring case: on a case-insensitive file system (macOS) ~/.SSH and /USERS are the same folders.
	const fold = (path: string) => path.toLowerCase();
	const where = fold(target);
	const credentials = [...HOME_CREDENTIALS.map((entry) => join(home, entry)), ...(options.credentials ?? [])].map((path) => fold(realTarget(path)));
	if (credentials.some((location) => within(where, location))) return SENSITIVE_FILE(raw);
	// Another lane's view file, as given and where it really is: no tool reads or writes it, by any spelling or link.
	const foreign = options.foreignViews.flatMap((view) => [view, realTarget(view)]);
	if (foreign.some((view) => within(where, fold(view)))) return OTHER_VIEW(raw);
	// Orrery's home, judged on its real path (inOrreryHome).
	const realData = options.orreryData === undefined ? undefined : realTarget(options.orreryData);
	const data = realData === undefined ? undefined : fold(realData);
	if (realData !== undefined && inOrreryHome(where, realData) && !(search && where === data)) return SENSITIVE_FILE(raw);
	if (writes && realData !== undefined && where === fold(join(realData, "config.toml"))) return CONFIG_READ_ONLY(raw);
	if (writes && realData !== undefined && within(where, fold(join(realData, "app")))) return APP_READ_ONLY(raw);
	// A search reads everything under its root, hidden files too, whatever its glob: judge the root, not the glob's
	// spelling. Home and above hold the credentials; /proc holds every process's environment.
	if (search && (credentials.some((location) => within(location, where)) || (data !== undefined && within(data, where)) || within(where, "/proc"))) {
		return `${toolName} on ${target} would search credential files (~/.ssh, ~/.pi and the like, or /proc); search a narrower folder.`;
	}
	// A content search whose root holds another lane's view file: one that is there, or whose lane is set up the file
	// way (it is written soon). A lane that never uses Claude Code's file mode has none to keep a folder's searches from,
	// and a listing reads names only.
	const setUp = new Set((options.fileModeViews ?? []).flatMap((view) => [view, realTarget(view)]).map(fold));
	if (search && !LISTINGS.has(toolName) && foreign.some((view) => within(fold(view), where) && (setUp.has(fold(view)) || present(view)))) {
		return `${toolName} on ${target} would search another agent's memory view; search a narrower folder.`;
	}
	return checkToolCall(
		{ name: toolName, arguments: { ...input, path: target } },
		{ workspace: realRoot(options.workspace), allowedRoots: options.allowedRoots.map(realRoot), cwd: realRoot(options.cwd), foreignViews: options.foreignViews },
		views,
		config,
	);
}

/** OMP's searches: each takes files, folders or globs in `path` and reads what is under them. */
const OMP_SEARCHES = new Set(["grep", "glob", "ast_grep", "find"]);

/** The first refusal among `paths`, each judged on its own. */
function firstRefusal(paths: readonly string[], judge: (path: string) => string | undefined): string | undefined {
	for (const path of paths) {
		const reason = judge(path);
		if (reason !== undefined) return reason;
	}
	return undefined;
}

/** The non-empty strings in a list argument. */
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item !== "") : []);

/** Why an edit whose text has a directive-looking line the guard cannot read is refused. */
const EDIT_UNREADABLE = "Orrery could not read every target of this edit; use a plain edit with explicit paths.";

/**
 * guardToolCall for OMP's tools (spec 2026-10-10-omp-design §2 Guard), with the same rules and every path resolved as
 * OMP's tools resolve it (ompToolPath). eval runs code like bash. write and edit may name a `[path#TAG]` header; edit
 * may name several files in `paths`, moves (`MV`, apply_patch's `*** Move to:`, patch mode's `rename`) and patch
 * targets in its text, which is checked whole like a command; a directive-looking line it cannot read refuses the edit,
 * and each edit target is judged in every reading OMP may write to (editForms: header unwrapped, hashline noise
 * stripped).
 * A file:// URL Node cannot read is refused. read and write are judged with any `:`/`?` selector peeled too. ast_edit
 * rewrites files, folders or globs; searches and read take several paths in one string. Each path is judged on its own
 * and the first refusal wins (fix round 3 ruling: where OMP's own parsers may read more, fail closed).
 */
export function guardOmpToolCall(toolName: string, input: Readonly<Record<string, unknown>>, options: PathGuardOptions): string | undefined {
	const omp: PathGuardOptions = { ...options, resolvePath: ompToolPath };
	if (toolName === "eval") return guardToolCall("bash", { command: typeof input.code === "string" ? input.code : "" }, omp);
	// Names in a search path and an edit's text are read like a command's words.
	const named = viewsOf(omp, omp.home ?? homedir()).command;
	const judge = (tool: string, args: Readonly<Record<string, unknown>>) =>
		typeof args.path === "string" && unreadableFileUrl(args.path) ? `${args.path}: Orrery cannot read this file:// URL; use a plain path.` : guardToolCall(tool, args, omp);
	// A write target: as written, and the path inside a [path#TAG] header; with `selectors`, each also cut before a ":" or
	// "?". An edit target: every reading of it OMP's edit modes may write to (editForms), each also as OMP's native
	// resolver reads a "~//abs" form (nativeTildeRest).
	const target = (tool: string, path: string, rest: Readonly<Record<string, unknown>> = {}, selectors = false) => {
		const forms = tool === "edit" ? editForms(path).flatMap((form) => [form, nativeTildeRest(form) ?? form]) : [path, headerPath(path)];
		return firstRefusal([...new Set(selectors ? forms.flatMap((form) => [form, ...selectorPrefixes(form)]) : forms)], (form) => judge(tool, { ...rest, path: form }));
	};
	// A glob in a search or ast_edit: one that reaches past its base folder is refused; else its base folder is judged,
	// and the path itself too, since OMP takes an existing literal path over the glob (tools/path-utils.ts:893-901).
	// `tool`: how pi's guard judges it (grep reads contents, find lists names, edit writes).
	const glob = (tool: "grep" | "find" | "edit", part: string) => {
		const path = part.replace(/\\/g, "/"); // OMP reads either slash in these (tools/path-utils.ts:559)
		if (escapingGlob(path)) return `${toolName} path "${part}": brace or parent patterns are not allowed in OMP paths.`;
		if (sensitive(part, named) || sensitive(path, named)) return tool === "edit" ? SENSITIVE_FILE(part) : `${toolName} path "${part}" names sensitive files (keys, credentials or Orrery's private data).`;
		return firstRefusal([...new Set([globBase(path), path, part])], (form) => judge(tool, { path: form }));
	};
	if (toolName === "edit") {
		const text = [input.input, input._input].filter((value): value is string => typeof value === "string").join("\n");
		// Like a bash command: an edit whose text names a credential file is refused, its content included.
		if (sensitive(text, named)) return "This edit touches sensitive files (keys, credentials or Orrery's private data).";
		const read = readEditText(text);
		if (read.unreadable) return EDIT_UNREADABLE;
		const renames = Array.isArray(input.edits) ? strings(input.edits.map((entry: unknown) => (entry as { rename?: unknown } | null)?.rename)) : [];
		// OMP's own path and paths (its reading of the text) count as much as the guard's.
		const reason = firstRefusal([...strings(input.paths), ...strings([input._path]), ...read.forms, ...renames], (path) => target("edit", path));
		if (reason !== undefined || typeof input.path !== "string" || input.path === "") return reason;
		return target("edit", input.path, input);
	}
	if (toolName === "write" && typeof input.path === "string" && input.path !== "") return target("write", input.path, input, true);
	if (toolName === "ast_edit") return firstRefusal(strings(input.paths).flatMap(pathParts), (part) => glob("edit", part));
	const raw = typeof input.path === "string" && input.path.trim() !== "" ? input.path : undefined;
	// Judged as pi's grep is: a root at home or above, or holding credentials, is refused. glob lists names only, so it is
	// judged as pi's find (a listing); grep, ast_grep and find (which takes grep_keywords) read contents.
	if (OMP_SEARCHES.has(toolName)) return firstRefusal(pathParts(raw ?? "."), (part) => glob(toolName === "glob" ? "find" : "grep", part));
	if (toolName === "read" && raw !== undefined) {
		const parts = pathParts(raw).flatMap((part) => [part, ...selectorPrefixes(part)]);
		return firstRefusal([...new Set(parts)], (part) => judge("read", { ...input, path: part }));
	}
	return judge(toolName, input);
}
