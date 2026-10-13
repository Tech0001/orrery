/**
 * Edits config.toml as text (spec 2026-10-08-orrery-tui-design §4.4): one lane key, one new lane block, or one lane
 * archived (its block moved to comments at the end). Every other line stays byte for byte, comments and blank lines
 * included. Each edit is checked before it is returned: the text must parse, and the parsed config must differ from
 * the old one by exactly the change.
 */

import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse } from "smol-toml";
import { ConfigError, type HarnessConfig, type LaneTool, type LaneLauncher, parseConfig, type ThinkingLevel } from "./config.ts";
import { orreryHome } from "./home.ts";

/** The lane keys the TUI and `orrery lane set` may change. */
export const EDITABLE_KEYS = ["remote", "launcher", "ori_model", "tool", "workspace", "view_bytes", "compactor_context_bytes", "compactor_jobs", "compact_at", "compactor_model", "compactor_thinking"] as const;
export type EditableKey = (typeof EDITABLE_KEYS)[number];
export type ConfigValue = string | number;

export interface NewLane {
	readonly name: string;
	readonly workspace: string;
	readonly tool?: LaneTool;
	readonly remote?: string;
	readonly launcher?: LaneLauncher;
	readonly compactorModel: string;
	readonly compactorThinking: ThinkingLevel;
	readonly viewBytes?: number;
	readonly nodeBytes?: number;
	readonly contextBytes?: number;
	readonly compactorJobs?: number;
	readonly compactAt?: number;
	readonly instructions?: string;
	readonly reads?: readonly string[];
}

const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
type Table = Record<string, unknown>;

function tomlValue(value: ConfigValue | readonly string[]): string {
	if (typeof value === "number") {
		if (!Number.isInteger(value) || value < 1) throw new ConfigError("a number setting must be a positive whole number");
		return String(value);
	}
	// JSON's string escapes (\" \\ \n \t \uXXXX) are all valid in a TOML basic string.
	return JSON.stringify(value);
}

/** The lane a `[lanes.Name]` header line names, or undefined. */
function laneHeader(line: string): string | undefined {
	const m = /^\s*\[\s*lanes\s*\.\s*(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*\]\s*(?:#.*)?\r?$/.exec(line);
	return m === null ? undefined : (m[1] ?? m[2]);
}

/** Splits what follows `key = ` into the value and the rest of the line (spaces and a comment). */
function splitValue(rest: string): { value: string; tail: string } {
	let end: number;
	if (rest.startsWith('"')) {
		end = 1;
		while (end < rest.length && rest[end] !== '"') end += rest[end] === "\\" ? 2 : 1;
		end = Math.min(end + 1, rest.length);
	} else if (rest.startsWith("'")) {
		const close = rest.indexOf("'", 1);
		end = close === -1 ? rest.length : close + 1;
	} else {
		end = (/^[^\s#]*/.exec(rest)?.[0] ?? "").length;
	}
	return { value: rest.slice(0, end), tail: rest.slice(end) };
}

/** Sorts object keys at every depth, so two parsed configs compare by content. */
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Table)[key])]));
	}
	return value;
}

/** Whether `text` is valid TOML (whatever orrery thinks of its values). */
function tomlParses(text: string): boolean {
	try {
		parse(text);
		return true;
	} catch {
		return false;
	}
}

/** The parsed config without an empty `lanes` table, so a config whose last lane was archived compares equal. */
function withoutEmptyLanes(config: Table): Table {
	const out = { ...config };
	for (const key of ["lanes", "remotes"]) {
		const value = out[key];
		if (typeof value === "object" && value !== null && Object.keys(value).length === 0) delete out[key];
	}
	return out;
}

/**
 * Returns `next` once it parses and differs from `old` by exactly `lanes[lane] = table` (or, when `table` gives
 * undefined, by the lane taken out); throws otherwise. When the old text is valid TOML and the new one is not, orrery
 * put the line in the wrong place (inside a multi-line value): that is said as orrery's failure, never as a fault in the
 * user's file.
 */
function checked(old: string, next: string, configDir: string, lane: string, table: (before: Table | undefined) => Table | undefined, group = "lanes"): string {
	if (!tomlParses(old)) parseConfig(old, configDir); // throws: the file itself is not valid TOML
	if (!tomlParses(next)) throw new ConfigError("Orrery couldn't place this change safely; the config is unchanged — edit it by hand.");
	const want = parse(old) as Table;
	const lanes = { ...((want[group] as Table | undefined) ?? {}) };
	const after = table(lanes[lane] as Table | undefined);
	if (after === undefined) delete lanes[lane];
	else lanes[lane] = after;
	want[group] = lanes;
	if (JSON.stringify(canonical(withoutEmptyLanes(parse(next) as Table))) !== JSON.stringify(canonical(withoutEmptyLanes(want)))) {
		throw new ConfigError("That edit would change more than intended; the config is left as it was.");
	}
	parseConfig(next, configDir); // throws a ConfigError naming a value Orrery refuses
	return next;
}

/** Sets one key of one lane: replaces its value (keeping the comment after it) or adds the line after the block's last key. */
export function setLaneKey(text: string, configDir: string, lane: string, key: EditableKey, value: ConfigValue): string {
	const cr = text.includes("\r\n") ? "\r" : "";
	// Edit as if the file ended with a newline; take it off again at the end when it did not.
	const noFinal = text !== "" && !text.endsWith("\n");
	const lines = (noFinal ? `${text}${cr}\n` : text).split("\n");
	const finish = (next: string) => (noFinal ? next.slice(0, -(cr.length + 1)) : next);
	const start = lines.findIndex((line) => laneHeader(line) === lane);
	if (start === -1) throw new ConfigError(`No lane named ${lane} in the config.`);
	let end = start + 1;
	while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
	const clear = value === "" && (key === "launcher" || key === "ori_model" || key === "remote");
	const written = tomlValue(value);
	const keyLine = new RegExp(`^(\\s*)${key}(\\s*=\\s*)(.*)$`);
	const change = (before: Table | undefined) => {
		const next = { ...before, [key]: value };
		if (clear) delete next[key];
		return next;
	};
	let lastKey = start;
	for (let i = start + 1; i < end; i++) {
		const bare = lines[i].replace(/\r$/, "");
		if (/^\s*[A-Za-z0-9_"'-]+\s*=/.test(bare)) lastKey = i;
		const m = keyLine.exec(bare);
		if (m === null) continue;
		if (/^("""|'''|\[|\{)/.test(m[3])) throw new ConfigError(`lanes.${lane}.${key} spans several lines or is not a single value; change it by hand.`);
		if (clear) {
			const comment = splitValue(m[3]).tail.trimStart();
			if (comment) lines[i] = `${m[1]}${comment}${cr}`;
			else lines.splice(i, 1);
			return checked(text, finish(lines.join("\n")), configDir, lane, change);
		}
		lines[i] = `${m[1]}${key}${m[2]}${written}${splitValue(m[3]).tail}${lines[i].endsWith("\r") ? "\r" : ""}`;
		return checked(text, finish(lines.join("\n")), configDir, lane, change);
	}
	if (clear) return checked(text, text, configDir, lane, change);
	lines.splice(lastKey + 1, 0, `${key} = ${written}${cr}`);
	return checked(text, finish(lines.join("\n")), configDir, lane, change);
}

/**
 * Appends a new lane's block, after one blank line. It also writes `model` (the summary model): only `orrery run` uses
 * it, but orrery versions before the TUI require it in every lane, and one lane without it makes them refuse the config.
 */
export function addLane(text: string, configDir: string, lane: NewLane): string {
	if (!NAME.test(lane.name)) throw new ConfigError("Lane names use letters, digits, - and _ (at most 32), starting with a letter.");
	if (!isAbsolute(lane.workspace)) throw new ConfigError("The folder must be an absolute path.");
	const before = parseConfig(text, configDir);
	if ([...before.lanes.keys()].some((name) => name.toLowerCase() === lane.name.toLowerCase())) throw new ConfigError(`A lane named ${lane.name} already exists.`);
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const table = { workspace: lane.workspace, ...(lane.tool === undefined ? {} : { tool: lane.tool }), ...(lane.launcher === "ori" ? { launcher: "ori" } : {}), model: lane.compactorModel, compactor_model: lane.compactorModel, compactor_thinking: lane.compactorThinking,
		...(lane.remote === undefined ? {} : { remote: lane.remote }),
		...(lane.viewBytes === undefined ? {} : { view_bytes: lane.viewBytes }),
		...(lane.nodeBytes === undefined ? {} : { node_bytes: lane.nodeBytes }),
		...(lane.contextBytes === undefined ? {} : { compactor_context_bytes: lane.contextBytes }),
		...(lane.compactorJobs === undefined ? {} : { compactor_jobs: lane.compactorJobs }),
		...(lane.compactAt === undefined ? {} : { compact_at: lane.compactAt }),
		...(lane.instructions === undefined ? {} : { instructions: lane.instructions }),
		...(lane.reads === undefined ? {} : { reads: lane.reads }),
	};
	const block = [`[lanes.${lane.name}]`, ...Object.entries(table).map(([key, value]) => `${key} = ${tomlValue(value)}`)].join(eol);
	const sep = text === "" ? "" : text.endsWith("\n") ? eol : eol + eol;
	return checked(text, `${text}${sep}${block}${eol}`, configDir, lane.name, () => table);
}

/**
 * Takes a lane out of the config and keeps its block as comments at the end, so it can come back by uncommenting; its
 * memory folder is not touched. The block runs from its `[lanes.Name]` line through its last key line: comment and
 * blank lines after that stay with the next block. Refused when another lane's `reads` names it, and when the
 * commented copy would not read back as the same lane.
 */
export function archiveLane(text: string, configDir: string, lane: string, day: string): string {
	const before = parseConfig(text, configDir);
	const archived = before.lanes.get(lane);
	if (archived === undefined) throw new ConfigError(`No lane named ${lane} in the config.`);
	const reader = [...before.lanes.values()].find((other) => other.name !== lane && other.reads.includes(lane));
	if (reader !== undefined) throw new ConfigError(`${reader.name} reads it; take it out of ${reader.name}'s reads first.`);
	const cr = text.includes("\r\n") ? "\r" : "";
	const eol = `${cr}\n`;
	const noFinal = text !== "" && !text.endsWith("\n");
	// Split as if the file ended with a newline: the last piece is then always "" (no line).
	const lines = (noFinal ? `${text}${eol}` : text).split("\n");
	const bare = (i: number) => lines[i].replace(/\r$/, "");
	const start = lines.findIndex((line) => laneHeader(line) === lane);
	if (start === -1) throw new ConfigError(`${lane} is not written as a [lanes.${lane}] block; archive it by hand.`);
	let next = start + 1;
	while (next < lines.length && !/^\s*\[/.test(lines[next])) next++;
	let end = start;
	for (let i = start + 1; i < next; i++) if (bare(i).trim() !== "" && !bare(i).trim().startsWith("#")) end = i;
	const block = lines.slice(start, end + 1).map((_, k) => bare(start + k));
	lines.splice(start, end - start + 1);
	// A blank line before and after the block would become two: keep one.
	const blank = (i: number) => i >= 0 && i < lines.length - 1 && bare(i).trim() === "";
	if (blank(start - 1) && blank(start)) lines.splice(start, 1);
	const rest = lines.join("\n").replace(/(\r?\n[ \t]*)+$/, "");
	// The memory folder's path on one comment line, whatever characters it has.
	const memory = archived.dir.replace(/[\x00-\x1f\x7f]/g, "?");
	const commented = block.map((line) => (line === "" ? "#" : `# ${line}`));
	// Uncommented, the copy must read back as exactly this lane (a multi-line value whose last line starts with "#"
	// would otherwise be cut short, and the copy could not be brought back).
	const restored = commented.map((line) => (line === "#" ? "" : line.slice(2))).join("\n");
	const want = { lanes: { [lane]: ((parse(text) as Table).lanes as Table)[lane] } };
	let back: unknown;
	try {
		back = parse(restored);
	} catch {
		back = undefined;
	}
	if (back === undefined || JSON.stringify(canonical(back)) !== JSON.stringify(canonical(want))) {
		throw new ConfigError(`${lane}'s block can't be archived safely; edit the config by hand.`);
	}
	const note = [`# Archived ${day} (orrery lane archive ${lane}). Its memory is still in ${memory}. Uncomment to bring it back:`, ...commented].join(eol);
	const out = `${rest === "" ? "" : `${rest}${eol}${eol}`}${note}${noFinal ? "" : eol}`;
	return checked(text, out, configDir, lane, () => undefined);
}

/** A new config's first lines: what the file is, and data_dir only when memory lives somewhere other than beside it. */
export function newConfigText(dataDir?: string): string {
	const head = "# Orrery's config: one [lanes.<Name>] block per lane. Memory lives beside this file unless you point it elsewhere.\n# The Orrery TUI (run `orrery`) edits this file in place and keeps your comments.\n";
	return dataDir === undefined ? head : `${head}data_dir = ${tomlValue(dataDir)}\n`;
}

/** Writes the config atomically (a temporary file, then rename), keeping its mode, and keeps the old text as config.toml.bak. */
export function saveConfigText(path: string, next: string): void {
	const target = existsSync(path) ? realpathSync(path) : path;
	let mode = 0o600;
	if (existsSync(target)) {
		mode = statSync(target).mode & 0o777;
		copyFileSync(target, `${target}.bak`);
		chmodSync(`${target}.bak`, mode);
	} else {
		mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
	}
	const temp = `${target}.tmp-${process.pid}`;
	writeFileSync(temp, next, { mode });
	chmodSync(temp, mode);
	renameSync(temp, target);
}

/** Re-reads the config, applies `edit`, checks and saves the result; returns the new config. A missing file starts from newConfigText(). */
export function editConfigFile(path: string, edit: (text: string, configDir: string) => string): HarnessConfig {
	const configDir = dirname(resolve(path));
	const text = existsSync(path) ? readFileSync(path, "utf8") : newConfigText();
	const next = edit(text, configDir);
	saveConfigText(path, next);
	return parseConfig(next, configDir);
}

/** What the TUI and the CLI say when the config can't be written. */
export function readOnlyConfigText(path: string): string {
	return `The config can't be written here (${path}); edit it by hand.`;
}

/** Whether the TUI may write this config (the file, or its folder when the file does not exist yet). */
export function configWritable(path: string): boolean {
	let at = resolve(path);
	while (!existsSync(at)) at = dirname(at);
	try {
		accessSync(at, constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

/** Where a new config goes: $ORRERY_CONFIG, else <home>/config.toml. */
export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
	return env.ORRERY_CONFIG || join(orreryHome(env), "config.toml");
}


/** A remote's public settings; credentials are written separately, never to TOML. */
export type NewRemote =
	| { readonly name: string; readonly kind: "server"; readonly host: string; readonly folder: string }
	| { readonly name: string; readonly kind: "cloudflare"; readonly url: string };

/** Appends a remote without touching any existing config text. */
export function addRemote(text: string, configDir: string, remote: NewRemote): string {
	if (!NAME.test(remote.name)) throw new ConfigError("Remote names use letters, digits, - and _ (at most 32), starting with a letter.");
	parseConfig(text, configDir);
	const remotes = (parse(text).remotes ?? {}) as Table;
	if (Object.keys(remotes).some((name) => name.toLowerCase() === remote.name.toLowerCase())) throw new ConfigError(`A remote named ${remote.name} already exists.`);
	const table = remote.kind === "server" ? { kind: remote.kind, host: remote.host, folder: remote.folder } : { kind: remote.kind, url: remote.url };
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const block = [`[remotes.${remote.name}]`, ...Object.entries(table).map(([key, value]) => `${key} = ${tomlValue(value)}`)].join(eol);
	const sep = text === "" ? "" : text.endsWith("\n") ? eol : eol + eol;
	return checked(text, `${text}${sep}${block}${eol}`, configDir, remote.name, () => table, "remotes");
}

/** Removes one unused remote, preserving every line outside its block. */
export function removeRemote(text: string, configDir: string, name: string): string {
	parseConfig(text, configDir);
	const parsed = parse(text) as Table;
	if ((parsed.remotes as Table | undefined)?.[name] === undefined) throw new ConfigError(`No remote named ${name} in the config.`);
	const users = Object.entries((parsed.lanes ?? {}) as Table).filter(([, value]) => (value as Table).remote === name).map(([lane]) => lane);
	if (users.length > 0) throw new ConfigError(`${users.join(", ")} uses remote ${name}; run orrery lane local first.`);
	const lines = text.split("\n");
	const start = lines.findIndex((line) => {
		const m = /^\s*\[\s*remotes\s*\.\s*(?:"([^"\n]+)"|'([^'\n]+)'|([A-Za-z0-9_-]+))\s*\]\s*(?:#.*)?\r?$/.exec(line);
		return m !== null && (m[1] ?? m[2] ?? m[3]) === name;
	});
	if (start === -1) throw new ConfigError(`${name} is not written as a [remotes.${name}] block; remove it by hand.`);
	let end = start + 1;
	while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
	while (end > start + 1 && (lines[end - 1].trim() === "" || lines[end - 1].trim().startsWith("#"))) end--;
	lines.splice(start, end - start);
	return checked(text, lines.join("\n"), configDir, name, () => undefined, "remotes");
}
