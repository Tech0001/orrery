/**
 * Where Grok loads settings from, and each source's entries now: the discovery and reading half of the settings check
 * (spec 2026-11-10-grok-settings-check-design; src/grok/settings.ts holds the record, the stamp and the compare). The
 * sources are the ones Grok 1.0.70 was seen to load (notes 2026-11-10-grok-settings-sources, whose final list's rows are
 * cited below; its `installed-plugins/` row, a guess with no program in it, is left out):
 * - Grok's folder (G: $GROK_HOME, else ~/.grok): hooks/*.json, hooks-paths and the files and folders it lists,
 *   config.toml (the keys that start a program or decide what loads), managed_config.toml, requirements.toml, lsp.json,
 *   disabled-hooks, agents/*.md, plugins/<p>/, settings.json (marketplaces, enabledPlugins); and what config.toml names
 *   ([plugins].paths, agent.definition).
 * - Claude Code's and Cursor's files Grok reads ($HOME/.claude/settings{,.local}.json, every plugin it has installed,
 *   switched on or not, and folder plugins Grok's [plugins].enabled names, $HOME/.claude.json's MCP servers, its agents,
 *   $HOME/.cursor/hooks.json and mcp.json), and /etc/grok's two org files.
 * - The project: every folder from the git root down to the session folder C (C alone outside a repository, or when the
 *   root is /, home or a parent of it); its .cursor/mcp.json, .grok/lsp.json and $HOME/.claude.json entry are read for C
 *   alone. Grok's folder trust is not asked: what C holds always counts.
 * - Programs: a file that a hook, server, language server or other command names (its program, and arguments that are
 *   paths with no space), resolved as Grok does where it can (no PATH lookup); not followed on to others. One this user
 *   can't write counts by its owner and real path, not its content (lockedProgram). Settings values that are paths (not
 *   commands) take any relative path, a bare name too, against their file's (or plugin's) folder.
 * Each source's entry is a SHA-256 of its canonical relevant content (the whole file, or one entry per relevant key and
 * per MCP server), with a summary [what, where] that names things and never holds values: server names, hook event names,
 * program basenames and paths. What can't be read is `unreadable` with its lstat (markOf), so a rewrite still shows. The
 * folders listed for new files, the links in them, a plugin's files and every Claude Code folder plugin's manifests are
 * `watched` sources, which the stamp covers and the snapshot skips; a listed folder that can't be listed is a `folder`
 * source, one can't-read entry; the folders from C upward are `watched-presence` sources at `<folder>/.git`.
 */

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, type Stats, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { parse } from "smol-toml";
import { realish } from "../agent/appended-lines.ts";
import { canonical } from "../agent/config-edit.ts";
import { safeText } from "../agent/source-labels.ts";
import { grokHome } from "./log.ts";

/** A place Grok loads settings from. `key` is stable across runs: scope, kind and real path (and, for two kinds, what in it). */
export type SettingsSource = {
	readonly key: string;
	readonly kind: "hook-file" | "hook-paths" | "config-keys" | "org-config" | "lsp" | "disabled-hooks" | "agent" | "plugin" | "claude-settings" | "compat-hooks" | "mcp-json" | "program" | "folder" | "watched" | "watched-presence";
	readonly path: string;
	readonly scope: "global" | "project";
};
/** A source's (or one of its keys' or servers') fingerprint, starting `unreadable` when it can't be read (isUnreadable), and [what, where]. */
export type SettingsEntry = { readonly fingerprint: string; readonly summary: readonly string[] };

type Kind = SettingsSource["kind"];
export type Scope = SettingsSource["scope"];

/**
 * A source's key: scope, kind, and its folder's real path (`real`) and its name; a program's by its path as named; or
 * `id`. What Orrery writes is named by it before it is there (src/grok/settings-keys.ts).
 */
export const sourceKey = (scope: Scope, kind: Kind, path: string, real: (path: string) => string = realish, id?: string): string =>
	`${scope} ${kind} ${id ?? (kind === "program" ? path : join(real(dirname(path)), basename(path)))}`;
type Table = Record<string, unknown>;

export const UNREADABLE = "unreadable";
/** Settings files past this are not read: their size, times and inode stand for them; programs past PROGRAM_MAX (1 MiB). */
const SETTINGS_MAX = 64 * 1024 * 1024;
const PROGRAM_MAX = 1024 * 1024;

/** config.toml's keys that start a program or decide what loads (notes, rows 4 and 21); Grok's and Claude's JSON keys. */
const CONFIG_KEYS: Readonly<Record<Scope, readonly string[]>> = {
	global: ["hooks", "mcp_servers", "disabled_mcp_servers", "disabled_mcp_tools", "ui.status_line", "ui.notifications.hooks", "plugins", "marketplace.sources", "agent", "auth.auth_provider_command", "grok_com_config.auth_provider_command", "auth_provider", "feedback.user.command", "folder_trust", "compat", "experiments", "version_overrides", "campaigns", "cursor_worker", "worker", "shell_environment_policy.set"],
	project: ["mcp_servers", "plugins", "experiments", "version_overrides", "campaigns"],
};
const GROK_SETTINGS_KEYS = ["extraKnownMarketplaces", "enabledPlugins"];
const CLAUDE_KEYS: Readonly<Record<Scope, readonly string[]>> = { global: ["hooks", "enabledPlugins", "extraKnownMarketplaces"], project: ["hooks", "enabledPlugins"] };
/** Config patches, which may carry servers of their own (seen: an [[experiments]] entry added one). */
const PATCHES = new Set(["experiments", "version_overrides", "campaigns"]);

/** A plugin's files (notes, row 9), the manifests that may name more, and its folders watched for new files. */
const MANIFESTS = ["plugin.json", join(".claude-plugin", "plugin.json"), join(".grok-plugin", "plugin.json")];
const PLUGIN_FILES = [...MANIFESTS, join("hooks", "hooks.json"), ".mcp.json", ".lsp.json"];
const PLUGIN_FOLDERS = ["agents", "hooks", ".claude-plugin", ".grok-plugin"];

/** Each kind's name in change lines. */
const LABEL: Readonly<Record<Kind, string>> = {
	"hook-file": "hook file", "hook-paths": "hook path list", "config-keys": "Grok config", "org-config": "org config", lsp: "language servers", "disabled-hooks": "hook switches",
	agent: "agent", plugin: "plugin", "claude-settings": "Claude Code settings", "compat-hooks": "Cursor hook file", "mcp-json": "MCP config", program: "program", folder: "folder", watched: "", "watched-presence": "",
};
const KEYED = new Set<Kind>(["config-keys", "claude-settings", "mcp-json"]);

export const isTable = (value: unknown): value is Table => typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
/** A value's SHA-256 over its canonical JSON (keys sorted; TOML dates as their text). */
const fingerprintOf = (value: unknown) => sha(JSON.stringify(canonical(JSON.parse(JSON.stringify(value ?? null, (_, inner) => (typeof inner === "bigint" ? inner.toString() : inner))))));
const unique = <T>(values: Iterable<T>): T[] => [...new Set(values)];
const strings = (value: unknown): string[] => [value].flat().filter((inner): inner is string => typeof inner === "string");
export const gone = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");

/** A table's own value at `key` (any text: a path, a plugin name with dots). */
const own = (table: unknown, key: string): unknown => (isTable(table) && Object.hasOwn(table, key) ? table[key] : undefined);

/** The value at a dotted name ("ui.status_line") in a parsed file. */
const at = (table: unknown, name: string): unknown => name.split(".").reduce(own, table);

/**
 * A file as read: gone (a dangling link too), no plain file or not readable (`mark` stands for it: markOf), or its bytes
 * (past the limit: `big`, unread).
 */
type Got = { readonly state: "absent" } | { readonly state: "other" | "unreadable"; readonly mark: string } | { readonly state: "file"; readonly link?: string; readonly bytes?: Buffer; readonly big?: string };
type File = Extract<Got, { state: "file" }>;

/** Whether a fingerprint is one of something that can't be read (markOf's, or UNREADABLE alone). */
export const isUnreadable = (fingerprint: string): boolean => fingerprint.startsWith(UNREADABLE);

/** A file's digest: its bytes' SHA-256, or past the limit its size, times and inode. Taken only when needed (a keyed file's isn't). */
const digestOf = (got: File) => got.big ?? sha(got.bytes ?? "");

/**
 * What stands for a path whose content can't be read (Grok can still run a program it can't read): `unreadable` and its
 * lstat's size, mtime, ctime and inode, so a rewrite still shows; for a link, its target's after ` > ` (`-`: none).
 */
function markOf(path: string, stats: Stats): string {
	const line = (of: Stats) => `${of.size} ${of.mtimeMs} ${of.ctimeMs} ${of.ino}`;
	if (!stats.isSymbolicLink()) return `${UNREADABLE} ${line(stats)}`;
	try {
		return `${UNREADABLE} ${line(stats)} > ${line(statSync(path))}`;
	} catch {
		return `${UNREADABLE} ${line(stats)} > -`;
	}
}

/**
 * Reads a file with lstat first: a link reads as its target's path plus the target's content. Never waits on a FIFO. A
 * file past `max` is not read: its size, mtime, ctime and inode stand for it (a rewrite moves the ctime, whatever mtime).
 */
function readFile(path: string, max: number): Got {
	let link: string | undefined;
	let first: Stats;
	try {
		first = lstatSync(path);
		if (first.isSymbolicLink()) link = readlinkSync(path);
		else if (!first.isFile()) return { state: "other", mark: markOf(path, first) };
	} catch (error) {
		// Not even its lstat: nothing but the word stands for it.
		return gone(error) ? { state: "absent" } : { state: "unreadable", mark: UNREADABLE };
	}
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
	} catch (error) {
		return gone(error) ? { state: "absent" } : { state: "unreadable", mark: markOf(path, first) };
	}
	try {
		const stats = fstatSync(fd);
		if (!stats.isFile()) return { state: "other", mark: markOf(path, first) };
		const linked = link === undefined ? {} : { link };
		if (stats.size > max) return { state: "file", big: `size ${stats.size}, modified ${stats.mtimeMs}, changed ${stats.ctimeMs}, inode ${stats.ino}`, ...linked };
		return { state: "file", bytes: readFileSync(fd), ...linked };
	} catch {
		return { state: "unreadable", mark: markOf(path, first) };
	} finally {
		closeSync(fd);
	}
}

/** A path's owner and mode, links followed: fs.statSync's, or a test's (ownership can't be given away without root). */
export type OwnerOf = (path: string) => { readonly uid: number; readonly mode: number };

/**
 * A program this user can't write, by its owner and real path (undefined: one it may write, or no plain file there).
 * "Can't write": another user owns it and it has no group or other write bit, and the same holds for its folder (as
 * named, and its real one when a link leads elsewhere). An OS update rewrites such a program, and an agent running as
 * this user can't, so its content isn't what counts (spec 2026-11-10-grok-settings-check-design, amended).
 */
function lockedProgram(path: string, ownerOf: OwnerOf, real: (path: string) => string): { readonly owner: number; readonly real: string } | undefined {
	const me = process.getuid?.();
	if (me === undefined) return undefined;
	const locked = (of: string, file: boolean) => {
		try {
			const { uid, mode } = ownerOf(of);
			return (mode & constants.S_IFMT) === (file ? constants.S_IFREG : constants.S_IFDIR) && uid !== me && (mode & 0o022) === 0 ? uid : undefined;
		} catch {
			return undefined;
		}
	};
	const owner = locked(path, true);
	if (owner === undefined) return undefined;
	const where = real(path);
	return unique([dirname(path), dirname(where)]).every((folder) => locked(folder, false) !== undefined) ? { owner, real: where } : undefined;
}

/** One check's reads, so listing the sources and fingerprinting them read and parse each file once. */
export class Reader {
	private readonly files = new Map<string, Got>();
	private readonly parsed = new Map<string, Table | undefined>();
	private readonly reals = new Map<string, string>();
	private readonly ownerOf: OwnerOf;

	constructor(ownerOf: OwnerOf = (path) => statSync(path)) {
		this.ownerOf = ownerOf;
	}

	/** A program this user can't write: its owner and real path, which count for it instead of its content (lockedProgram). */
	locked(path: string): { readonly owner: number; readonly real: string } | undefined {
		return lockedProgram(path, this.ownerOf, (inner) => this.real(inner));
	}

	file(path: string, max = SETTINGS_MAX): Got {
		const key = `${max} ${path}`;
		let got = this.files.get(key);
		if (got === undefined) this.files.set(key, (got = readFile(path, max)));
		return got;
	}

	/** The file's text when it is there and read whole. */
	text(path: string): string | undefined {
		const got = this.file(path);
		return got.state === "file" ? got.bytes?.toString("utf8") : undefined;
	}

	/** The file parsed (TOML by its name, else JSON) when it is a table; undefined when it isn't there or doesn't parse. */
	data(path: string): Table | undefined {
		if (!this.parsed.has(path)) {
			const text = this.text(path);
			let value: unknown;
			try {
				value = text === undefined ? undefined : path.endsWith(".toml") ? parse(text) : JSON.parse(text);
			} catch {
				value = undefined;
			}
			this.parsed.set(path, isTable(value) ? value : undefined);
		}
		return this.parsed.get(path);
	}

	real(path: string): string {
		let real = this.reals.get(path);
		if (real === undefined) this.reals.set(path, (real = realish(path)));
		return real;
	}
}

/** The sources found so far, each key once. */
class Found {
	readonly sources: SettingsSource[] = [];
	private readonly keys = new Set<string>();
	readonly reader: Reader;
	constructor(reader: Reader) {
		this.reader = reader;
	}

	/** Adds a source keyed by `id` (else its folder's real path and its name; a program's by its path as named). */
	add(scope: Scope, kind: Kind, path: string, id?: string): void {
		const key = sourceKey(scope, kind, path, (folder) => this.reader.real(folder), id);
		if (this.keys.has(key)) return;
		this.keys.add(key);
		this.sources.push({ key, kind, path, scope });
	}

	/** A folder watched for new files, and its files ending in `suffix` as `kind` (one that can't be listed: a `folder` source). */
	folder(scope: Scope, kind: Kind, dir: string, suffix: string): void {
		this.add(scope, "watched", dir);
		const files = filesIn(dir, suffix);
		if (files === undefined) this.add(scope, "folder", dir);
		else for (const file of files) this.add(scope, kind, file);
	}

	/** A plugin folder: one source for its content, its files and folders (those its manifests name too) watched. */
	plugin(scope: Scope, root: string, id?: string): void {
		this.add(scope, "plugin", root, id);
		const { files, folders } = pluginParts(root, this.reader);
		for (const path of [...folders, ...files]) this.add(scope, "watched", path);
	}
}

/**
 * The files (and links) in a folder whose names end in `suffix`, sorted; none when it isn't there (or is no folder);
 * undefined when it is there but can't be listed, which then reads as one can't-read entry, never as empty.
 */
function filesIn(dir: string, suffix: string): string[] | undefined {
	try {
		return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.name.endsWith(suffix) && (entry.isFile() || entry.isSymbolicLink())).map((entry) => join(dir, entry.name)).sort();
	} catch (error) {
		return gone(error) ? [] : undefined;
	}
}

const isFolder = (path: string) => {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
};

/** Whether a path names an existing regular file (links followed). */
const isFile = (path: string) => {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
};

/**
 * The folders (and links to folders) in a folder, sorted. Each link found is also a `watched` source at its own path, so
 * a target that appears or changes later moves the stamp. A folder that is there but can't be listed is a `folder`
 * source (one can't-read entry), never empty.
 */
function foldersIn(found: Found, scope: Scope, dir: string): string[] {
	try {
		const paths = readdirSync(dir, { withFileTypes: true }).map((entry) => (entry.isSymbolicLink() ? ([join(dir, entry.name), true] as const) : ([join(dir, entry.name), false] as const)));
		for (const [path, link] of paths) if (link) found.add(scope, "watched", path);
		return paths.map(([path]) => path).filter(isFolder).sort();
	} catch (error) {
		if (!gone(error)) found.add(scope, "folder", dir);
		return [];
	}
}

/**
 * A plugin's files (the fixed names, agents/*.md, and what its manifests name for hooks, servers and agents), and the
 * folders watched for new ones (the fixed ones and the folders its manifests name). A folder of it that can't be listed
 * is one of its files: it reads as can't read.
 */
function pluginParts(root: string, reader: Reader): { readonly files: string[]; readonly folders: string[] } {
	const listed = (dir: string, suffix: string) => filesIn(dir, suffix) ?? [dir];
	const files = [...PLUGIN_FILES.map((name) => join(root, name)), ...listed(join(root, "agents"), ".md")];
	const folders = PLUGIN_FOLDERS.map((name) => join(root, name));
	for (const manifest of MANIFESTS) {
		const json = reader.data(join(root, manifest));
		for (const named of ["hooks", "mcpServers", "lspServers", "agents"].flatMap((field) => strings(own(json, field)))) {
			const path = pathNamed(named, { base: root, plugin: root });
			if (path === undefined) continue;
			if (!isFolder(path)) files.push(path);
			else {
				folders.push(path);
				files.push(...listed(path, ".md"), ...listed(path, ".json"));
			}
		}
	}
	return { files: unique(files), folders: unique(folders) };
}

/** Where a command's words resolve: relative paths, a bare name (hook files only: the file beside it), and variables. */
interface Place {
	readonly base?: string;
	readonly beside?: string;
	readonly plugin?: string;
	readonly workspace?: string;
	readonly home?: string;
}

/** `${VAR}`/`$VAR` (or `~`) at a word's start, and the Place field it stands for. */
const VARIABLES: readonly [RegExp, keyof Place][] = [
	[/^\$\{?CLAUDE_PROJECT_DIR\}?(?=\/|$)/, "workspace"],
	[/^\$\{?(?:CLAUDE|GROK)_PLUGIN_ROOT\}?(?=\/|$)/, "plugin"],
	[/^(?:~|\$\{?HOME\}?)(?=\/|$)/, "home"],
];

/** The absolute path a command word names, when it can be told without PATH or the environment. */
function located(word: string, place: Place, bare = false): string | undefined {
	let path = word;
	for (const [pattern, field] of VARIABLES) {
		if (!pattern.test(path)) continue;
		const value = place[field];
		if (value === undefined) return undefined;
		path = value + path.replace(pattern, "");
		break;
	}
	if (path === "" || path.includes("$")) return undefined;
	if (isAbsolute(path)) return normalize(path);
	if (path.includes("/")) return place.base === undefined ? undefined : resolve(place.base, path);
	return bare && place.beside !== undefined ? join(place.beside, path) : undefined;
}

/** The absolute path a settings value that names a file or folder (not a command) gives: any relative one against `base`. */
const pathNamed = (value: string, place: Place) => located(value, { ...place, beside: place.base }, true);

/** A command as settings give it: with `args`, run directly; without, a shell line. */
interface Command {
	readonly command: string;
	readonly args?: unknown;
}

/** Every command in a parsed value: tables with a string `command` (hooks, servers, status line), and `*_command` strings. */
function commandsIn(value: unknown, out: Command[] = []): Command[] {
	if (Array.isArray(value)) for (const inner of value) commandsIn(inner, out);
	else if (isTable(value)) {
		if (typeof value.command === "string") out.push({ command: value.command, args: value.args });
		for (const [key, inner] of Object.entries(value)) {
			if (key.endsWith("_command") && typeof inner === "string") out.push({ command: inner });
			else commandsIn(inner, out);
		}
	}
	return out;
}

const unquote = (word: string) => word.replace(/^(['"])(.*)\1$/, "$2");
const NAME_LIKE = /^[\w.+@-]+$/;

/**
 * A shell line's first simple command in words, split as the shell splits them: a quoted part is never split, so
 * `K="a b"` is one word; quotes stay in the word. It ends at the first operator outside quotes (an unclosed quote runs
 * to the end).
 */
function shellWords(line: string): string[] {
	const words: string[] = [];
	let word = "";
	let quote: string | undefined;
	for (let i = 0; i < line.length; i++) {
		const char = line[i] as string;
		if (quote !== undefined) {
			word += char;
			if (char === quote) quote = undefined;
			else if (char === "\\" && quote === '"' && i + 1 < line.length) word += line[++i];
		} else if (char === "\\" && i + 1 < line.length) word += char + line[++i];
		else if (char === "'" || char === '"') {
			quote = char;
			word += char;
		} else if (/[;&|<>`\n]/.test(char) || (char === "$" && line[i + 1] === "(")) break;
		else if (/\s/.test(char)) {
			if (word !== "") words.push(word);
			word = "";
		} else word += char;
	}
	if (word !== "") words.push(word);
	return words;
}

/** A program word's name for summaries: its basename, only from a word with no quote and no `://`, and only a plain name. */
function nameOf(word: string | undefined): string | undefined {
	if (word === undefined || /['"]|:\/\//.test(word)) return undefined;
	const name = basename(word);
	return NAME_LIKE.test(name) ? name : undefined;
}

/**
 * A command's program word, its name for summaries (nameOf), and the other words that may name files (args that are
 * paths, never one with a space, which is text such as a shell line, not a file; a shell line's path words).
 */
function wordsOf({ command, args }: Command): { readonly program?: string; readonly name?: string; readonly paths: string[] } {
	// With args, `command` is the program alone: text with a space is a command line (it may hold a secret), never a program.
	if (Array.isArray(args)) {
		const program = /\s/.test(command) ? undefined : command;
		return { program, name: nameOf(program), paths: strings(args).filter((arg) => /^(?:\/|~\/|\$)/.test(arg) && !/\s/.test(arg)) };
	}
	// A shell line: its first simple command, with assignments (each one word, quotes and all) and `exec` dropped.
	const [raw, ...rest] = shellWords(command).filter((word) => word !== "exec" && !/^[A-Za-z_]\w*=/.test(word));
	const first = raw === undefined ? undefined : unquote(raw);
	const program = first !== undefined && (NAME_LIKE.test(first) || first.includes("/")) ? first : undefined;
	return { program, name: program === undefined ? undefined : nameOf(raw), paths: rest.map(unquote).filter((word) => word.includes("/") && !word.startsWith("-")) };
}

/** The basenames of the programs a value's commands run, for summaries: plain names only, so no value slips in. */
function programNames(value: unknown): string[] {
	return unique(commandsIn(value).flatMap((command) => wordsOf(command).name ?? []));
}

/** ` (a; runs b, c)` for the parts there are. */
const detail = (...parts: string[]) => (parts.some((part) => part !== "") ? ` (${parts.filter((part) => part !== "").join("; ")})` : "");
const runs = (value: unknown) => {
	const names = programNames(value);
	return names.length === 0 ? "" : `runs ${names.join(", ")}`;
};
const quoted = (names: Iterable<string>) => [...names].map((name) => `"${safeText(name)}"`).join(", ");

/** A hook file's (or `hooks` key's) event names and programs. */
const hooksDetail = (hooks: unknown) => detail(isTable(hooks) ? Object.keys(hooks).map(safeText).join(", ") : "", runs(hooks));

/** Agent front matter's commands (hooks and MCP servers): `command:` lines, best effort. */
function frontMatterCommands(text: string | undefined): Command[] {
	const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text ?? "")?.[1] ?? "";
	return [...front.matchAll(/^\s*(?:-\s+)?command:\s*(.+?)\s*$/gm)].map((match) => ({ command: unquote(match[1] ?? "") }));
}

/** One relevant key, or one MCP server, of a keyed source. */
interface Item {
	readonly id: string;
	readonly value: unknown;
	readonly what: string;
}

const serverItems = (servers: unknown, prefix: string): Item[] =>
	isTable(servers) ? Object.entries(servers).map(([name, spec]) => ({ id: `${prefix}${name}`, value: spec, what: `MCP server "${safeText(name)}"${detail(runs(spec) || (isTable(spec) && typeof spec.url === "string" ? "URL" : ""))}` })) : [];

/** A key's name in a change line: what it is, by name only. */
function keyLabel(name: string, value: unknown, toml: boolean): string {
	if (name === "hooks") return `hooks${hooksDetail(value)}`;
	if (name === "ui.status_line") return `status line${detail(runs(value))}`;
	if (name === "ui.notifications.hooks") return `notification hooks${detail(runs(value))}`;
	if (PATCHES.has(name)) {
		const servers = unique([value].flat().flatMap((patch) => (isTable(patch) && isTable(patch.mcp_servers) ? Object.keys(patch.mcp_servers) : [])));
		return `[[${name}]]${detail(servers.length === 0 ? "" : `MCP server${servers.length === 1 ? "" : "s"} ${quoted(servers)}`)}`;
	}
	return toml && isTable(value) ? `[${name}]` : name;
}

/** A key's parts beyond scope, kind and path: the folder spellings of a Claude MCP project entry, or a plugin's name. */
const extras = (source: SettingsSource) => source.key.split("\0").slice(1);

/** A keyed source's relevant items in its parsed content (absent keys are no items). */
function itemsOf(source: SettingsSource, data: Table): Item[] {
	// $HOME/.claude.json's entry for the session folder, as given and as it really is.
	const folders = source.kind === "mcp-json" ? extras(source) : [];
	if (folders.length > 0) return folders.flatMap((folder) => serverItems(own(own(own(data, "projects"), folder), "mcpServers"), `${folder}\0`));
	const toml = source.path.endsWith(".toml");
	const keys = source.kind === "mcp-json" ? ["mcpServers"] : source.kind === "claude-settings" ? CLAUDE_KEYS[source.scope] : toml ? CONFIG_KEYS[source.scope] : GROK_SETTINGS_KEYS;
	return keys.flatMap((name): Item[] => {
		const value = at(data, name);
		if (value === undefined) return [];
		if ((name === "mcp_servers" || name === "mcpServers") && isTable(value)) return serverItems(value, `${name}.`);
		return [{ id: name, value, what: keyLabel(name, value, toml) }];
	});
}

/** Where a keyed source's items are, in a change line. */
const whereOf = (source: SettingsSource) => `in ${safeText(source.path)}${extras(source).length > 0 && source.kind === "mcp-json" ? " (this folder's entry)" : ""}`;

/** A plugin source's name and version when it is a Claude Code install (its key names it in installed_plugins.json). */
function installed(source: SettingsSource, reader: Reader): { readonly name: string; readonly version: unknown } | undefined {
	const [head = "", name, index] = source.key.split("\0");
	if (name === undefined) return undefined;
	const list = head.slice(`${source.scope} ${source.kind} `.length);
	const entry = [own(own(reader.data(list), "plugins"), name)].flat()[Number(index)];
	return { name, version: own(entry, "version") ?? null };
}

/** A source's entries now: none when it isn't there (or has no relevant content), else its fingerprints and summaries. */
export function entriesOf(source: SettingsSource, reader: Reader): [string, SettingsEntry][] {
	const { kind, path, key } = source;
	const where = safeText(path);
	if (kind === "watched" || kind === "watched-presence") return [];
	if (kind === "plugin") {
		if (!isFolder(path)) return [];
		// Own keys whatever a file is called (a file named __proto__ too).
		const files = Object.fromEntries(
			pluginParts(path, reader).files.flatMap((file) => {
				const got = reader.file(file);
				return got.state === "absent" ? [] : [[relative(path, file), got.state === "file" ? { link: got.link ?? null, digest: digestOf(got) } : got.mark]];
			}),
		);
		const install = installed(source, reader);
		return [[key, { fingerprint: fingerprintOf({ ...install, files }), summary: [install === undefined ? "plugin" : `Claude Code plugin "${safeText(install.name)}"`, where] }]];
	}
	// A program this user can't write: its owner and real path, not its content (an OS update asks nothing).
	const locked = kind === "program" ? reader.locked(path) : undefined;
	if (locked !== undefined) return [[key, { fingerprint: fingerprintOf(locked), summary: [LABEL.program, where] }]];
	const got = reader.file(path, kind === "program" ? PROGRAM_MAX : SETTINGS_MAX);
	// A program that isn't there, or is no plain file, runs nothing; one that can't be read is listed.
	if (got.state === "absent" || (kind === "program" && got.state === "other")) return [];
	if (got.state !== "file") return [[key, { fingerprint: got.mark, summary: ["can't read", where] }]];
	const whole = (summary: string[]): [string, SettingsEntry][] => [[key, { fingerprint: fingerprintOf({ link: got.link ?? null, digest: digestOf(got) }), summary }]];
	const label = kind === "config-keys" && path.endsWith(".json") ? "Grok settings" : LABEL[kind];
	if (got.big !== undefined && kind !== "program") return whole([label, `${where} (too large)`]);
	const data = reader.data(path);
	if (KEYED.has(kind)) {
		if (data === undefined) return whole([label, `${where} (not valid ${path.endsWith(".toml") ? "TOML" : "JSON"})`]);
		return itemsOf(source, data).map((item) => [`${key}\0${item.id}`, { fingerprint: fingerprintOf(item.value), summary: [item.what, whereOf(source)] }]);
	}
	if (kind === "hook-file" || kind === "compat-hooks") return whole([LABEL[kind], `${where}${hooksDetail(data?.hooks)}`]);
	return whole([LABEL[kind], kind === "lsp" ? `in ${where}` : where]);
}

/** The commands a source runs, for its programs. */
function commandsOf(source: SettingsSource, reader: Reader): Command[] {
	const { kind, path } = source;
	if (kind === "agent") return frontMatterCommands(reader.text(path));
	if (kind === "plugin") return pluginParts(path, reader).files.flatMap((file) => (file.endsWith(".md") ? frontMatterCommands(reader.text(file)) : commandsIn(reader.data(file))));
	if (["hook-file", "compat-hooks", "org-config", "lsp"].includes(kind)) return commandsIn(reader.data(path));
	if (!KEYED.has(kind)) return [];
	const data = reader.data(path);
	return data === undefined ? [] : commandsIn(itemsOf(source, data).map((item) => item.value));
}

/** Whether `outer` is `inner` or a folder above it. */
const covers = (outer: string, inner: string) => inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : `${outer}${sep}`);

/**
 * The project's folders: from the git root (a `.git` folder or file) down to the session folder; the session folder alone
 * outside a repository, or when the root is /, or home or a parent of it (Grok reads only the launch folder there). A root
 * at or above the temp folder still counts (over-cover).
 */
function projectFolders(folder: string, home: string): string[] {
	let root: string | undefined;
	for (let dir = folder; root === undefined; dir = dirname(dir)) {
		try {
			lstatSync(join(dir, ".git"));
			root = dir;
		} catch {
			if (dirname(dir) === dir) break;
		}
	}
	if (root === undefined || dirname(root) === root || covers(root, home)) return [folder];
	const folders = [folder];
	for (let dir = folder; dir !== root; dir = dirname(dir)) folders.unshift(dirname(dir));
	return folders;
}

/** The plugin names a config's [plugins].enabled gives (a full ID's last part). */
const enabledIn = (config: Table | undefined) => strings(at(config, "plugins.enabled")).map((name) => name.split("/").pop() ?? name);

/**
 * What a config names (notes, row 27): [plugins].paths folders, and (Grok's own config) the agent.definition file; a
 * relative path, a bare name too, against the config's folder.
 */
function namedBy(found: Found, scope: Scope, config: string, home: string): void {
	const data = found.reader.data(config);
	const place = { base: dirname(config), home };
	for (const named of strings(at(data, "plugins.paths"))) {
		const root = pathNamed(named, place);
		if (root !== undefined) found.plugin(scope, root);
	}
	const definition = scope === "global" ? at(data, "agent.definition") : undefined;
	const agent = typeof definition === "string" ? pathNamed(definition, place) : undefined;
	if (agent !== undefined) found.add(scope, "agent", agent);
}

/** Every source for Grok's folder in `env` and the session folder `project`, with the folders' real paths. */
export function discover(env: NodeJS.ProcessEnv, project: string | undefined, reader: Reader): { readonly sources: SettingsSource[]; readonly grok: string; readonly folder?: string } {
	const home = env.HOME || homedir();
	const grok = grokHome(env, home);
	const found = new Found(reader);
	const g = (name: string) => join(grok, name);
	found.folder("global", "hook-file", g("hooks"), ".json");
	found.add("global", "hook-paths", g("hooks-paths"));
	// Absolute lines (Grok ignores relative ones); a ~/ line is taken against HOME (over-cover).
	for (const line of (reader.text(g("hooks-paths")) ?? "").split("\n").map((text) => text.trim())) {
		const path = line.startsWith("~/") ? join(home, line.slice(2)) : isAbsolute(line) ? line : undefined;
		if (path === undefined) continue;
		if (isFolder(path)) found.folder("global", "hook-file", path, ".json");
		else found.add("global", "hook-file", path);
	}
	found.add("global", "config-keys", g("config.toml"));
	for (const name of ["managed_config.toml", "requirements.toml"]) found.add("global", "org-config", g(name));
	found.add("global", "lsp", g("lsp.json"));
	found.add("global", "disabled-hooks", g("disabled-hooks"));
	found.folder("global", "agent", g("agents"), ".md");
	found.add("global", "watched", g("plugins"));
	for (const root of foldersIn(found, "global", g("plugins"))) found.plugin("global", root);
	found.add("global", "config-keys", g("settings.json"));
	namedBy(found, "global", g("config.toml"), home);

	const claude = join(home, ".claude");
	const settings = ["settings.json", "settings.local.json"].map((name) => join(claude, name));
	for (const file of settings) found.add("global", "claude-settings", file);
	const plugins = join(claude, "plugins");
	const list = join(plugins, "installed_plugins.json");
	found.add("global", "watched", list);
	// Every installed plugin, whatever enabledPlugins says (it is read from more files than Grok was seen to use: over-cover).
	const installedPlugins = own(reader.data(list), "plugins");
	for (const [name, installs] of Object.entries(isTable(installedPlugins) ? installedPlugins : {})) {
		[installs].flat().forEach((install, index) => {
			const root = own(install, "installPath");
			if (typeof root === "string" && isAbsolute(root)) found.plugin("global", root, `${reader.real(list)}\0${name}\0${index}`);
		});
	}
	found.add("global", "mcp-json", join(home, ".claude.json"));
	found.folder("global", "agent", join(claude, "agents"), ".md");
	found.add("global", "compat-hooks", join(home, ".cursor", "hooks.json"));
	found.add("global", "mcp-json", join(home, ".cursor", "mcp.json"));
	for (const name of ["managed_config.toml", "requirements.toml"]) found.add("global", "org-config", join("/etc", "grok", name));

	const enabled: [Scope, string[]][] = [["global", enabledIn(reader.data(g("config.toml")))]];
	let folder: string | undefined;
	let workspace: string | undefined;
	if (project !== undefined) {
		const given = resolve(project);
		folder = reader.real(given);
		const realHome = reader.real(home);
		const folders = projectFolders(folder, realHome);
		workspace = folders[0];
		// From the session folder up, below home and /: a .git made, removed or replaced in one changes the project's folders.
		for (let dir = folder; dirname(dir) !== dir && !covers(dir, realHome); dir = dirname(dir)) found.add("project", "watched-presence", join(dir, ".git"));
		for (const level of folders) {
			const config = join(level, ".grok", "config.toml");
			found.folder("project", "hook-file", join(level, ".grok", "hooks"), ".json");
			for (const name of ["settings.json", "settings.local.json"]) found.add("project", "claude-settings", join(level, ".claude", name));
			found.add("project", "compat-hooks", join(level, ".cursor", "hooks.json"));
			found.add("project", "config-keys", config);
			found.add("project", "mcp-json", join(level, ".mcp.json"));
			for (const agents of [join(level, ".grok", "agents"), join(level, ".claude", "agents")]) found.folder("project", "agent", agents, ".md");
			for (const pluginsHere of [join(level, ".grok", "plugins"), join(level, ".claude", "plugins")]) {
				found.add("project", "watched", pluginsHere);
				for (const root of foldersIn(found, "project", pluginsHere)) found.plugin("project", root);
			}
			namedBy(found, "project", config, home);
			enabled.push(["project", enabledIn(reader.data(config))]);
		}
		found.add("project", "mcp-json", join(folder, ".cursor", "mcp.json"));
		found.add("project", "lsp", join(folder, ".grok", "lsp.json"));
		const claudeJson = join(home, ".claude.json");
		found.add("project", "mcp-json", claudeJson, [join(reader.real(dirname(claudeJson)), basename(claudeJson)), ...unique([given, folder])].join("\0"));
	}
	// Claude Code folder plugins that a Grok config's [plugins].enabled names, by folder or manifest name; every folder's
	// manifests are watched, as a new name can enable one.
	found.add("global", "watched", plugins);
	for (const root of foldersIn(found, "global", plugins)) {
		const manifests = MANIFESTS.map((manifest) => join(root, manifest));
		for (const manifest of manifests) found.add("global", "watched", manifest);
		const names = [basename(root), ...manifests.flatMap((manifest) => strings(at(reader.data(manifest), "name")))];
		const scope = enabled.find(([, list]) => list.some((name) => names.includes(name)))?.[0];
		if (scope !== undefined) found.plugin(scope, root);
	}

	// Programs, each named once: first as named without the session's folders (global when a global source names it),
	// then the ones only the session's folders resolve (a global $CLAUDE_PROJECT_DIR hook's script is the project's).
	const named = new Set<string>();
	const sources = [...found.sources].sort((a, b) => (a.scope === b.scope ? 0 : a.scope === "global" ? -1 : 1));
	for (const withSession of [false, true]) {
		for (const source of sources) {
			const { kind, path } = source;
			const besideFile = kind === "hook-file" || kind === "compat-hooks";
			const sessionBase = kind === "claude-settings" || kind === "mcp-json" || kind === "lsp";
			const fixed: Place = { home, plugin: kind === "plugin" ? path : undefined, beside: besideFile ? dirname(path) : undefined, base: kind === "plugin" ? path : sessionBase ? undefined : dirname(path) };
			const place: Place = withSession ? { ...fixed, workspace, base: kind === "claude-settings" ? workspace : sessionBase ? folder : fixed.base } : fixed;
			for (const command of commandsOf(source, reader)) {
				const { program, paths } = wordsOf(command);
				for (const [word, bare] of [...(program === undefined ? [] : [[program, besideFile] as const]), ...paths.map((path) => [path, false] as const)]) {
					const file = located(word, place, bare);
					if (file === undefined || named.has(file) || !isFile(file)) continue;
					named.add(file);
					found.add(withSession ? "project" : source.scope, "program", file);
				}
			}
		}
	}
	return { sources: found.sources, grok: reader.real(grok), ...(folder === undefined ? {} : { folder }) };
}

/**
 * Every source for Grok's folder (env's GROK_HOME, else HOME's) and the session folder `project` (undefined: the global
 * ones only). It reads the files that name others (hooks-paths, configs, plugin lists, and every file that names programs).
 */
export function grokSettingsSources(env: NodeJS.ProcessEnv, project: string | undefined): SettingsSource[] {
	return discover(env, project, new Reader()).sources;
}
