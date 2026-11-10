/**
 * The status row's check of Grok's settings (spec 2026-11-10-grok-settings-check-design, "In a session"): whether they
 * differ from the approved record, cheap enough for a row Grok runs at every state change and continuously during a turn
 * (src/grok/status.ts). The full compare (src/grok/settings.ts checkGrokSettings) reads every source; the row runs it
 * only when the stamp of what the last one read has moved.
 * - A cache at <data dir>/grok-settings-stamp.json (0600, written whole) keeps, per Grok folder and session folder (their
 *   real paths), the sources the last full check listed, their stamp, and whether it found a change; at most 32 entries,
 *   the oldest dropped. The stamp is settingsStamp's of those sources and of the record file (an approval, or a record
 *   edited outside Orrery, moves it). Every file and folder the source list is derived from is itself a source, so a
 *   change that would change the list moves the stamp too.
 * - The cache only ever holds a full check's answer. One that is gone, can't be read, has no entry for the folders, or
 *   whose stamp no longer holds runs the full check again, from the record: it can't turn a change into none. (One forged
 *   with the current stamp could: that takes a write to Orrery's data folder, where the record itself is.)
 * - With no record at all (the first run, which the launch asks about) there is nothing to say, and nothing is written.
 * The launch and `orrery grok-settings` never read the cache.
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { realish } from "../agent/appended-lines.ts";
import { writePrivate } from "../agent/private-file.ts";
import { grokHome } from "./log.ts";
import { checkGrokSettings, grokSettingsSources, type SettingsSource, settingsRecordPath, settingsStamp } from "./settings.ts";
import { isTable } from "./settings-sources.ts";

const CACHE = "grok-settings-stamp.json";
const MOST_ENTRIES = 32;
/** A cache past this is not read (the full check runs, and writes a smaller one). */
const CACHE_MAX = 16 * 1024 * 1024;

/** One full check's answer, for a Grok folder and session folder (none: the global entries only). */
interface RowEntry {
	readonly grok: string;
	readonly folder?: string;
	readonly stamp: string;
	readonly sources: readonly SettingsSource[];
	readonly changed: boolean;
}

const validSource = (value: unknown): value is SettingsSource => isTable(value) && ["key", "kind", "path", "scope"].every((name) => typeof value[name] === "string");
const validEntry = (value: unknown): value is RowEntry =>
	isTable(value) && typeof value.grok === "string" && (value.folder === undefined || typeof value.folder === "string") && typeof value.stamp === "string" && typeof value.changed === "boolean" && Array.isArray(value.sources) && value.sources.every(validSource);

/** The cache's entries: none when it isn't there, isn't this user's own plain file, or isn't one. */
function readEntries(path: string): RowEntry[] {
	try {
		const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const stats = fstatSync(fd);
			if (!stats.isFile() || (process.getuid !== undefined && stats.uid !== process.getuid()) || stats.size > CACHE_MAX) return [];
			const json: unknown = JSON.parse(readFileSync(fd, "utf8"));
			return isTable(json) && json.version === 1 && Array.isArray(json.entries) ? json.entries.filter(validEntry) : [];
		} finally {
			closeSync(fd);
		}
	} catch {
		return [];
	}
}

/**
 * The stamp of `sources` and of the record, for HOME `home` (the sources a Grok folder shares between two HOMEs differ, so
 * one's answer is never the other's). The record is stamped as a source whose key names that HOME.
 */
const stampOf = (dataDir: string, home: string, sources: readonly SettingsSource[]): string => settingsStamp([...sources, { key: `record ${home}`, kind: "watched", path: settingsRecordPath(dataDir), scope: "global" }]);

/** Whether the record file is there (one that can't be told counts as there: the full check says it can't be read). */
function recordThere(dataDir: string): boolean {
	try {
		lstatSync(settingsRecordPath(dataDir));
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ENOENT";
	}
}

/**
 * Whether Grok's settings (Grok's folder and HOME as `env` has them, and the session folder `folder()` gives, asked only
 * when there is a record; undefined: the global entries only) aren't the ones approved in `dataDir`'s record: a full check
 * changed state of any kind (module doc). Errors of the cache's are a miss, and a cache that can't be written leaves the
 * answer as it is.
 */
export function grokSettingsChanged(dataDir: string, env: NodeJS.ProcessEnv, folder: () => string | undefined): boolean {
	if (!recordThere(dataDir)) return false;
	const project = folder();
	const home = env.HOME || homedir();
	const grok = realish(grokHome(env, home));
	const at = project === undefined ? undefined : realish(resolve(project));
	const path = join(dataDir, CACHE);
	const entries = readEntries(path);
	const cached = entries.find((entry) => entry.grok === grok && entry.folder === at);
	if (cached !== undefined && stampOf(dataDir, home, cached.sources) === cached.stamp) return cached.changed;
	// Stamped before the check reads anything: whatever changes meanwhile moves the stamp, so the next row checks again.
	const sources = grokSettingsSources(env, project);
	const stamp = stampOf(dataDir, home, sources);
	const changed = checkGrokSettings(dataDir, env, project).state === "changed";
	const entry: RowEntry = { grok, ...(at === undefined ? {} : { folder: at }), stamp, sources, changed };
	const kept = entries.filter((one) => one.grok !== grok || one.folder !== at);
	try {
		writePrivate(path, `${JSON.stringify({ version: 1, entries: [...kept, entry].slice(-MOST_ENTRIES) })}\n`);
	} catch {
		// The answer stands; the next row checks in full again.
	}
	return changed;
}
