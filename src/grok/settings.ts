/**
 * A record of the Grok settings the person approved, and the check against it (spec 2026-11-10-grok-settings-check-design).
 * Grok loads hooks, MCP servers, language servers, plugins and agents from many files, and an agent can plant one through
 * a route the guard's text rules miss; so the launch and the session compare what is on disk with what the person
 * approved, whatever put it there. Which files, and each one's entries, are src/grok/settings-sources.ts's. The record is
 * <data dir>/grok-settings.json (0600, written whole), per Grok folder's real path: the approval time, the global
 * entries, and each project's entries by C's real path. The stamp reads no file (lstat only) for the status row's fast
 * path; it covers the `watched` sources too, which the snapshot skips.
 */

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writePrivate } from "../agent/private-file.ts";
import { discover, entriesOf, gone, isTable, Reader, UNREADABLE } from "./settings-sources.ts";
import type { Scope, SettingsEntry, SettingsSource } from "./settings-sources.ts";

export { grokSettingsSources } from "./settings-sources.ts";
export type { SettingsEntry, SettingsSource } from "./settings-sources.ts";

export type SettingsSnapshot = Readonly<Record<string, SettingsEntry>>;
export type SettingsChange = { readonly change: "added" | "changed" | "removed"; readonly line: string };
export type SettingsRecord = { readonly version: 1; readonly grok: Readonly<Record<string, { readonly approvedAt: string; readonly global: SettingsSnapshot; readonly projects: Readonly<Record<string, SettingsSnapshot>> }>> };
declare const shownBrand: unique symbol;
/** What a check compared (Grok's folder, the session folder, and their entries then); opaque: approve it as it came. */
export type ShownSettings = { readonly [shownBrand]: true };
/** A check's result; `shown` is what approving it saves, whatever is on disk by then. */
export type SettingsCheck =
	| { readonly state: "unchanged"; readonly shown: ShownSettings }
	| { readonly state: "first"; readonly lines: readonly string[]; readonly shown: ShownSettings }
	| { readonly state: "changed"; readonly record: "ok" | "unreadable" | "new-folder"; readonly approvedAt: string; readonly changes: readonly SettingsChange[]; readonly shown: ShownSettings };

const RECORD = "grok-settings.json";

function snapshotWith(sources: readonly SettingsSource[], reader: Reader): Record<string, SettingsEntry> {
	return Object.fromEntries(sources.flatMap((source) => entriesOf(source, reader)));
}

/** The sources' entries now: a source that isn't there, or has none of its relevant keys, has none. */
export function snapshotSettings(sources: readonly SettingsSource[]): SettingsSnapshot {
	return snapshotWith(sources, new Reader());
}

/** A path's lstat (and a link's target's stat): size, mtime, ctime, inode; `-` when it isn't there. */
function statLine(path: string): string {
	const line = (stats: { size: number; mtimeMs: number; ctimeMs: number; ino: number }) => `${stats.size} ${stats.mtimeMs} ${stats.ctimeMs} ${stats.ino}`;
	try {
		const stats = lstatSync(path);
		if (!stats.isSymbolicLink()) return line(stats);
		try {
			return `${line(stats)} > ${line(statSync(path))}`;
		} catch {
			return `${line(stats)} > -`;
		}
	} catch (error) {
		return gone(error) ? "-" : "?";
	}
}

/** A path's presence and kind and inode only (`-` when it isn't there): a `.git` folder's times move on every `git add`. */
function presenceLine(path: string): string {
	try {
		const stats = lstatSync(path);
		return `${stats.isSymbolicLink() ? "link" : stats.isDirectory() ? "dir" : "file"} ${stats.ino}`;
	} catch (error) {
		return gone(error) ? "-" : "?";
	}
}

/** A hash of the sources' keys and lstat (no file is read): it moves when a source, or a watched folder's listing, does. */
export function settingsStamp(sources: readonly SettingsSource[]): string {
	const hash = createHash("sha256");
	for (const source of sources) hash.update(`${source.key}\0${source.kind === "watched-presence" ? presenceLine(source.path) : statLine(source.path)}\n`);
	return hash.digest("hex");
}

const lineOf = (change: SettingsChange["change"], entry: SettingsEntry): SettingsChange => ({ change, line: `${change.padEnd(8)} ${entry.summary.join(" ")}` });

/** One change per entry that differs, in `now`'s order, removed ones last; a new entry that can't be read is "changed". */
export function compareSettings(approved: SettingsSnapshot, now: SettingsSnapshot): SettingsChange[] {
	const changes: SettingsChange[] = [];
	for (const [key, entry] of Object.entries(now)) {
		const was = Object.hasOwn(approved, key) ? approved[key] : undefined;
		if (was === undefined) changes.push(lineOf(entry.fingerprint === UNREADABLE ? "changed" : "added", entry));
		else if (was.fingerprint !== entry.fingerprint) changes.push(lineOf("changed", entry));
	}
	for (const [key, entry] of Object.entries(approved)) if (!Object.hasOwn(now, key)) changes.push(lineOf("removed", entry));
	return changes;
}

/** The first `max` changes' lines (without indent), then `…and <n> more (orrery grok-settings lists them all)`. */
export function changeLines(changes: readonly SettingsChange[], max = 20): string[] {
	const lines = changes.slice(0, max).map((change) => change.line);
	if (changes.length > max) lines.push(`…and ${changes.length - max} more (orrery grok-settings lists them all)`);
	return lines;
}

/** One line per source with content: its items' names, then where it is. */
function firstLines(snapshot: SettingsSnapshot): string[] {
	const groups = new Map<string, string[]>();
	for (const { summary } of Object.values(snapshot)) {
		const [what = "", where = ""] = summary;
		groups.set(where, [...(groups.get(where) ?? []), what]);
	}
	return [...groups].map(([where, whats]) => `${whats.join(", ")} ${where}`);
}

const validSnapshot = (value: unknown) => isTable(value) && Object.values(value).every((entry) => isTable(entry) && typeof entry.fingerprint === "string" && Array.isArray(entry.summary) && entry.summary.every((part) => typeof part === "string"));
const validRecord = (json: unknown): json is SettingsRecord =>
	isTable(json) && json.version === 1 && isTable(json.grok) && Object.values(json.grok).every((grok) => isTable(grok) && typeof grok.approvedAt === "string" && validSnapshot(grok.global) && isTable(grok.projects) && Object.values(grok.projects).every(validSnapshot));

/** The record; undefined when there is none; `unreadable` (`can't read <path>`) when it isn't this user's file or a record. */
export function readSettingsRecord(dataDir: string): SettingsRecord | undefined | { readonly unreadable: string } {
	const path = join(dataDir, RECORD);
	let text: string;
	try {
		// This user's own plain file, never through a link.
		const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const stats = fstatSync(fd);
			if (!stats.isFile() || (process.getuid !== undefined && stats.uid !== process.getuid())) throw new Error("not this user's file");
			text = readFileSync(fd, "utf8");
		} finally {
			closeSync(fd);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		return { unreadable: `can't read ${path}` };
	}
	try {
		const json: unknown = JSON.parse(text);
		if (validRecord(json)) return json;
	} catch {
		// not JSON: unreadable below
	}
	return { unreadable: `can't read ${path}` };
}

const writeRecord = (dataDir: string, record: SettingsRecord) => writePrivate(join(dataDir, RECORD), `${JSON.stringify(record, null, "\t")}\n`);
const scoped = (snapshot: SettingsSnapshot, scope: Scope): SettingsSnapshot => Object.fromEntries(Object.entries(snapshot).filter(([key]) => key.startsWith(`${scope} `)));

/** Inside ShownSettings: Grok's folder's real path, the session folder's (none: global only), and the entries compared. */
type Shown = ShownSettings & { readonly grok: string; readonly folder?: string; readonly global: SettingsSnapshot; readonly project: SettingsSnapshot };
const shownOf = (shown: Omit<Shown, typeof shownBrand>) => shown as Shown;

/**
 * Grok's settings now against the record. `first` only when there is no record file at all (one line per source with
 * content). Otherwise the changes against this Grok folder's global entries plus `project`'s (a project with none
 * recorded: nothing approved there), with `record` saying what they were compared with: `ok`, this folder's approval of
 * `approvedAt`; `new-folder`, a record with no entry for this Grok folder (a moved GROK_HOME), compared with nothing;
 * `unreadable`, a record that can't be read (its first line says so), compared with nothing. Neither of the last two is
 * ever `first`, which defaults to yes; their `approvedAt` is "".
 */
export function checkGrokSettings(dataDir: string, env: NodeJS.ProcessEnv, project: string | undefined): SettingsCheck {
	const reader = new Reader();
	const found = discover(env, project, reader);
	const now = snapshotWith(found.sources, reader);
	const shown = shownOf({ grok: found.grok, ...(found.folder === undefined ? {} : { folder: found.folder }), global: scoped(now, "global"), project: scoped(now, "project") });
	const record = readSettingsRecord(dataDir);
	if (record === undefined) return { state: "first", lines: firstLines(now), shown };
	if ("unreadable" in record) return { state: "changed", record: "unreadable", approvedAt: "", changes: [{ change: "changed", line: `changed  ${record.unreadable}` }, ...compareSettings({}, now)], shown };
	const approved = Object.hasOwn(record.grok, found.grok) ? record.grok[found.grok] : undefined;
	const projectEntries = approved !== undefined && found.folder !== undefined && Object.hasOwn(approved.projects, found.folder) ? approved.projects[found.folder] : undefined;
	const changes = compareSettings({ ...approved?.global, ...projectEntries }, now);
	if (changes.length === 0) return { state: "unchanged", shown };
	return approved === undefined ? { state: "changed", record: "new-folder", approvedAt: "", changes, shown } : { state: "changed", record: "ok", approvedAt: approved.approvedAt, changes, shown };
}

/**
 * Records what a check showed as approved (not what is on disk by now): its Grok folder's global entries, and its session
 * folder's when it had one; other projects' entries stay. A record that can't be read is replaced.
 */
export function approveGrokSettings(dataDir: string, shown: ShownSettings, now = new Date()): void {
	const { grok: key, folder, global, project } = shown as Shown;
	const read = readSettingsRecord(dataDir);
	const grok = read === undefined || "unreadable" in read ? {} : read.grok;
	const kept = Object.hasOwn(grok, key) ? grok[key]?.projects : undefined;
	const projects = { ...kept, ...(folder === undefined ? {} : { [folder]: project }) };
	writeRecord(dataDir, { version: 1, grok: { ...grok, [key]: { approvedAt: now.toISOString(), global, projects } } });
}

/** Whether an entry key is the source's (the source's own, or one of its keys' or servers'). */
const belongs = (entry: string, source: string) => entry === source || entry.startsWith(`${source}\0`);
const entriesFor = (snapshot: SettingsSnapshot, source: string): SettingsSnapshot => Object.fromEntries(Object.entries(snapshot).filter(([key]) => belongs(key, source)));
const sameEntries = (a: SettingsSnapshot, b: SettingsSnapshot) => JSON.stringify(Object.entries(a).map(([key, entry]) => [key, entry.fingerprint]).sort()) === JSON.stringify(Object.entries(b).map(([key, entry]) => [key, entry.fingerprint]).sort());

/**
 * Runs Orrery's own `write` to Grok's settings, then moves the record's entries for the global sources `keys` to what it
 * left, each only when it matched the record before (Orrery never approves a change it didn't make). A write that throws
 * moves nothing; with no record for this Grok folder there is nothing to move. `write` must be only the file writes
 * Orrery makes to those sources (no downloads, waits or other work): anything written to them while it runs, by
 * whatever process, is taken into the record.
 */
export function keepInStep(dataDir: string, env: NodeJS.ProcessEnv, keys: readonly string[], write: () => void): void {
	const wanted = new Set(keys);
	const take = () => {
		const reader = new Reader();
		const found = discover(env, undefined, reader);
		return { grok: found.grok, snapshot: snapshotWith(found.sources.filter((source) => wanted.has(source.key)), reader) };
	};
	const before = take();
	const read = readSettingsRecord(dataDir);
	const approved = read === undefined || "unreadable" in read ? undefined : read.grok[before.grok];
	const matching = approved === undefined ? [] : keys.filter((key) => sameEntries(entriesFor(before.snapshot, key), entriesFor(approved.global, key)));
	write();
	if (matching.length === 0) return;
	const after = take();
	const fresh = readSettingsRecord(dataDir);
	if (fresh === undefined || "unreadable" in fresh || !Object.hasOwn(fresh.grok, after.grok)) return;
	const entry = fresh.grok[after.grok] as SettingsRecord["grok"][string];
	const global: Record<string, SettingsEntry> = Object.fromEntries(Object.entries(entry.global).filter(([key]) => !matching.some((source) => belongs(key, source))));
	for (const source of matching) Object.assign(global, entriesFor(after.snapshot, source));
	writeRecord(dataDir, { version: 1, grok: { ...fresh.grok, [after.grok]: { ...entry, global } } });
}
