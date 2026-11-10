/**
 * A record of the Grok settings the person approved, and the check against it (spec 2026-11-10-grok-settings-check-design).
 * Grok loads hooks, MCP servers, language servers, plugins and agents from many files, and an agent can plant one through
 * a route the guard's text rules miss; so the launch and the session compare what is on disk with what the person
 * approved, whatever put it there. Which files, and each one's entries, are src/grok/settings-sources.ts's. The record is
 * <data dir>/grok-settings.json (0600, written whole), per Grok folder's real path: the approval time, the global
 * entries, and each project's entries by C's real path. The stamp reads no file (lstat only) for the status row's fast
 * path; it covers the `watched` sources too (and the `watched-presence` ones at <folder>/.git, from C upward), which the snapshot
 * skips.
 */

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { realish } from "../agent/appended-lines.ts";
import { writePrivate } from "../agent/private-file.ts";
import { safeText } from "../agent/source-labels.ts";
import { grokHome } from "./log.ts";
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
/** A check's result; `shown` is what approving it saves, whatever is on disk by then. An unchanged one's `approvedAt` is its approval's (none when nothing was approved, nor loaded). */
export type SettingsCheck =
	| { readonly state: "unchanged"; readonly approvedAt?: string; readonly shown: ShownSettings }
	| { readonly state: "first"; readonly lines: readonly string[]; readonly shown: ShownSettings }
	| { readonly state: "changed"; readonly record: "ok" | "unreadable" | "new-folder"; readonly approvedAt: string; readonly changes: readonly SettingsChange[]; readonly shown: ShownSettings };

const RECORD = "grok-settings.json";
/** The record's file in a data folder (the status row stamps it: src/grok/settings-row.ts). */
export const settingsRecordPath = (dataDir: string): string => join(dataDir, RECORD);

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

/** The first `max` lines, then `…and <n> more (orrery grok-settings lists them all)`. */
const capped = (lines: readonly string[], max: number): string[] => (lines.length > max ? [...lines.slice(0, max), `…and ${lines.length - max} more (orrery grok-settings lists them all)`] : [...lines]);

/** The first `max` changes' lines (without indent), then `…and <n> more (orrery grok-settings lists them all)`. */
export function changeLines(changes: readonly SettingsChange[], max = 20): string[] {
	return capped(
		changes.map((change) => change.line),
		max,
	);
}

/** A day in local time, YYYY-MM-DD: an approval's (approvalDate), a file set aside's (src/agent/tools.ts setAside). */
export function localDay(at: Date = new Date()): string {
	const two = (n: number) => String(n).padStart(2, "0");
	return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;
}

/** An approval's day (`approvedAt`, an ISO time) in local time, YYYY-MM-DD: the launch's question, orrery grok-settings. */
export function approvalDate(approvedAt: string): string {
	const at = new Date(approvedAt);
	return Number.isNaN(at.getTime()) ? safeText(approvedAt.slice(0, 10)) : localDay(at);
}

/** Where the person reviews Grok's settings when there is no terminal to ask on (the launch, orrery grok-settings). */
export const REVIEW_IN_TERMINAL = "Run orrery grok-settings in your own terminal to review them.";

/** What the launch and `orrery grok-settings` ask about a check: the list (a header, then its lines two spaces in), and the question. */
export interface SettingsQuestion {
	readonly lines: readonly string[];
	/** Its last line, naming the answer Enter gives: `[Y/n]` (`defaultYes`) or `[y/N]`. */
	readonly question: string;
	readonly defaultYes: boolean;
}

/**
 * The question about a check that isn't `unchanged` (spec "Change list copy"), with at most `max` lines before the "…and
 * <n> more" line (orrery grok-settings lists them all). The first run's lists what Grok loads, default yes; a change's
 * lists the changes since the approval, default no, under a header that says what they were compared with.
 */
export function settingsQuestion(check: SettingsCheck, max = 20): SettingsQuestion | undefined {
	if (check.state === "unchanged") return undefined;
	const indented = (lines: readonly string[]) => lines.map((line) => `  ${line}`);
	if (check.state === "first") return { lines: ["Orrery now checks Grok's settings at each launch. Grok loads these now:", ...indented(capped(check.lines, max))], question: "Approve Grok's current settings? [Y/n]", defaultYes: true };
	const header =
		check.record === "ok"
			? `Grok's settings changed since you approved them on ${approvalDate(check.approvedAt)}:`
			: check.record === "unreadable"
				? "Orrery can't read its record of Grok's settings, so it lists them all:"
				: "Orrery has no record of approving this Grok folder's settings, so it lists them all:";
	return { lines: [header, ...indented(changeLines(check.changes, max))], question: "Approve these changes to Grok's settings? [y/N]", defaultYes: false };
}

/**
 * What an agent's Grok session says at its start (src/grok/hooks.ts sessionStart) when its settings aren't the ones
 * approved: one line by what they were compared with. None when unchanged, nor for the first run, which the launch asked.
 */
export function grokSettingsNotice(check: SettingsCheck): string | undefined {
	if (check.state !== "changed") return undefined;
	const review = "run orrery grok-settings in your own terminal to review them.";
	if (check.record === "unreadable") return `Orrery can't read its record of Grok's settings; ${review}`;
	if (check.record === "new-folder") return `Orrery has no record of approving this Grok folder's settings; ${review}`;
	const count = check.changes.length;
	return `Grok's settings changed since you approved them on ${approvalDate(check.approvedAt)} (${count} ${count === 1 ? "change" : "changes"}). Orrery still records and guards this session; ${review}`;
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
	const path = settingsRecordPath(dataDir);
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

const writeRecord = (dataDir: string, record: SettingsRecord) => writePrivate(settingsRecordPath(dataDir), `${JSON.stringify(record, null, "\t")}\n`);
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
	if (changes.length === 0) return { state: "unchanged", ...(approved === undefined ? {} : { approvedAt: approved.approvedAt }), shown };
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

/**
 * A test of the entry keys an Orrery write may move, made just before the write: `covers`, of what was there and
 * recorded then; `after()`, made once the write has run, of what it left. A program at a place the write chose (a
 * plugin's new copy) is named only after it; an entry the write left somewhere it may not vouch for (a folder that was
 * there before it) is left out after it.
 */
export interface StepTest {
	readonly covers: (entry: string) => boolean;
	readonly after: () => (entry: string) => boolean;
}

/** The global entries Orrery's own write may move: entry keys, with the source keys that cover them, or a StepTest's maker. */
export type StepKeys = readonly string[] | (() => StepTest);

/**
 * Runs Orrery's own `write` to Grok's settings, then moves the record's global entries that `keys` cover to what it left,
 * each only when it matched the record before (Orrery never approves a change it didn't make): one there before and
 * recorded alike, or one neither there nor recorded (a new one, then, is taken in). `keys` are source keys (each covers
 * its entries) or entry keys (an entry key is `<source key>\0…`), or a StepTest's maker, asked just before the write; an
 * entry the write left that its `after()` leaves out stays as recorded. A write that throws moves nothing, and its error
 * is the caller's. The bookkeeping never fails a write: when it can't be done (before the write or after it), the record
 * is left as it was, so the next check asks (the safe direction). With no record for this Grok folder there is nothing to
 * move. `write` must be only the file writes Orrery makes to those sources (no downloads, waits or other work): anything
 * written to them while it runs, by whatever process, is taken into the record.
 */
export function keepInStep(dataDir: string, env: NodeJS.ProcessEnv, keys: StepKeys, write: () => void): void {
	// This Grok folder's real path, as the record keys it (discover's `grok`), and its approval: none, nothing to move.
	const grok = realish(grokHome(env, env.HOME || homedir()));
	const approvedOf = () => {
		const record = readSettingsRecord(dataDir);
		return record === undefined || "unreadable" in record || !Object.hasOwn(record.grok, grok) ? undefined : { record, entry: record.grok[grok] as SettingsRecord["grok"][string] };
	};
	let ready: ReturnType<typeof beforeWrite> | undefined;
	try {
		ready = beforeWrite(env, keys, approvedOf);
	} catch {
		// What was there can't be told: the write runs, and nothing moves.
	}
	write();
	if (ready === undefined) return;
	try {
		afterWrite(ready, approvedOf, (record) => writeRecord(dataDir, record), grok);
	} catch {
		// The write is done and stays: the record is left as it was.
	}
}

type Approved = { readonly record: SettingsRecord; readonly entry: SettingsRecord["grok"][string] };

/** Entry keys, and source keys that cover theirs, as a StepTest: the same before the write and after it. */
function listTest(keys: readonly string[]): StepTest {
	const covers = (entry: string) => keys.some((key) => belongs(entry, key));
	return { covers, after: () => covers };
}

/** keepInStep before its write: what `keys` cover there and in the record, and how to read it again; undefined with no approval. */
function beforeWrite(env: NodeJS.ProcessEnv, keys: StepKeys, approvedOf: () => Approved | undefined) {
	const approved = approvedOf();
	if (approved === undefined) return undefined;
	const test = typeof keys === "function" ? keys() : listTest(keys);
	// Only the sources a key names, or one of whose entries it names, are read for a list; every global one for a test.
	const read = typeof keys === "function" ? () => true : (source: string) => keys.some((key) => belongs(key, source));
	const take = (): SettingsSnapshot => {
		const reader = new Reader();
		return snapshotWith(discover(env, undefined, reader).sources.filter((source) => read(source.key)), reader);
	};
	const before = take();
	const recorded = approved.entry.global;
	const asked = [...Object.keys(before), ...Object.keys(recorded)].filter(test.covers);
	return { test, take, before, recorded, asked };
}

const fingerprint = (snapshot: SettingsSnapshot, key: string) => (Object.hasOwn(snapshot, key) ? snapshot[key]?.fingerprint : undefined);

/** keepInStep after its write: each entry covered that matched the record before moves to what the write left. */
function afterWrite(ready: NonNullable<ReturnType<typeof beforeWrite>>, approvedOf: () => Approved | undefined, save: (record: SettingsRecord) => void, grok: string): void {
	const { test, take, before, recorded, asked } = ready;
	const covers = test.after();
	const after = take();
	// The record as it is now: another approval may have been saved meanwhile.
	const fresh = approvedOf();
	if (fresh === undefined) return;
	/** Whether the entry was there before as the record has it, or neither there nor recorded. */
	const matched = (key: string) => fingerprint(before, key) === fingerprint(recorded, key);
	const global: Record<string, SettingsEntry> = { ...fresh.entry.global };
	let moved = false;
	for (const key of new Set([...asked, ...Object.keys(after).filter(covers)])) {
		if (!matched(key)) continue;
		const now = Object.hasOwn(after, key) ? after[key] : undefined;
		// What the write left there must be its own too: an entry it now names elsewhere (a folder that was there before) stays.
		if (now !== undefined && !covers(key)) continue;
		if (fingerprint(global, key) === now?.fingerprint && (now === undefined || JSON.stringify(global[key]?.summary) === JSON.stringify(now.summary))) continue;
		moved = true;
		if (now === undefined) delete global[key];
		else global[key] = now;
	}
	// Nothing to move: the record is left as it is.
	if (moved) save({ version: 1, grok: { ...fresh.record.grok, [grok]: { ...fresh.entry, global } } });
}
