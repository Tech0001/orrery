/**
 * Which agent a pi or OMP session belongs to, kept outside the lanes' memory (lane privacy). Each lane keeps its own copy
 * cursors (src/pi/log.ts), so a lane that never saw a session would copy all of it, turns another agent said there
 * included: a session an agent opened by ORRERY_AGENT recorded in a lane's folder, then resumed there by that lane.
 *
 * In <data>/session-owners/, files are named by the sha256 (hex) of the session id, so every id pi or OMP accepts
 * (dots, any length) has a record, and no id can name another session's mark:
 * - <hash> names the agent that first ran in the session, or NO_AGENT for a session under an ORRERY_AGENT that was
 *   refused. It is made once (exclusive create) and left alone.
 * - <hash>.visited says another agent ran in the session since. A visitor writes it afresh (its time is the visit's)
 *   when it starts, at each run's end and at shutdown. The owner, once its tail is written, removes it only when it is
 *   older than the owner's load of the session: a visitor turn that ended after that load is not in what the owner
 *   loaded, so its mark stays for the owner's next open.
 * Agent names only, never content; files 0600 in a 0700 folder.
 *
 * Another agent's session, or the owner's own once marked, is recorded from its tail (src/pi/index.ts). The cost of a
 * mark: the owner's next open skips all of its own uncopied turns too, those from before the visit and those from its
 * runs whose memory did not open (held elsewhere, a failed remote open). Renaming an agent makes its old sessions
 * foreign to it.
 *
 * A session with no record is copied as before: one recorded before records existed, and every session when the data
 * folder cannot be written (no record is made). Tailing every session instead would drop a lane's own turns on a broken
 * setup. Node built-ins only: pi and OMP load this file.
 */

import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

/** The owner of a session that ran under a refused ORRERY_AGENT: foreign to every lane. */
export const NO_AGENT = "-";

/** How a lane about to record a session stands to it. */
export type Standing =
	/** No record, or the lane's own and nobody else ran in it since: copy as usual. */
	| "own"
	/** Another agent's, or NO_AGENT's: record from its tail. */
	| "foreign"
	/** The lane's own, and another agent ran in it since: record from its tail, then settleVisit. */
	| "visited";

const ownerFile = (dataDir: string, sessionId: string) => join(dataDir, "session-owners", createHash("sha256").update(sessionId).digest("hex"));
const visitFile = (dataDir: string, sessionId: string) => `${ownerFile(dataDir, sessionId)}.visited`;
/** An id pi or OMP gave: any non-empty string. */
const recordable = (sessionId: unknown): sessionId is string => typeof sessionId === "string" && sessionId !== "";

/** Makes `file` holding `text` unless it exists; false when it exists or cannot be made. */
function create(file: string, text: string): boolean {
	try {
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		const fd = openSync(file, "wx", 0o600);
		try {
			writeSync(fd, text);
		} finally {
			closeSync(fd);
		}
		return true;
	} catch {
		return false;
	}
}

/** The session's owner, or undefined: no record (or an empty one). */
function ownerOf(dataDir: string, sessionId: string): string | undefined {
	try {
		const name = readFileSync(ownerFile(dataDir, sessionId), "utf8").trim();
		return name === "" ? undefined : name;
	} catch {
		return undefined;
	}
}

/** Writes the visit mark afresh, timed `now` (its mtime), so the owner can tell it from one it already settled. */
function mark(file: string, now: number): void {
	try {
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		writeFileSync(file, "", { mode: 0o600 });
		utimesSync(file, new Date(now), new Date(now));
	} catch {
		// No mark where nothing can be written: the visit is unmarked, as when there is no record.
	}
}

/**
 * `agent` (a lane's name, or NO_AGENT) runs in session `sessionId` at `now`: it owns the session when it is the first
 * to, and otherwise marks the session visited, afresh, when the owner is another. Called whether or not the lane's
 * memory opened, since the turns said here are the agent's either way: when a session opens, and again at each run's
 * end and at shutdown.
 */
export function noteSession(dataDir: string, sessionId: string, agent: string, now: number = Date.now()): void {
	if (!recordable(sessionId) || create(ownerFile(dataDir, sessionId), `${agent}\n`)) return;
	const owner = ownerOf(dataDir, sessionId);
	if (owner !== undefined && owner !== agent) mark(visitFile(dataDir, sessionId), now);
}

/**
 * How lane `lane`, about to record session `sessionId`, stands to it. It reads only: a "visited" session keeps its mark
 * until settleVisit, which the caller runs once the tail is written, so a failed write leaves the mark for next time.
 */
export function sessionStanding(dataDir: string, sessionId: string, lane: string): Standing {
	if (!recordable(sessionId)) return "own";
	const owner = ownerOf(dataDir, sessionId);
	if (owner === undefined) return "own";
	if (owner !== lane) return "foreign";
	try {
		statSync(visitFile(dataDir, sessionId));
		return "visited";
	} catch {
		return "own";
	}
}

/**
 * The owner has written its tail of a visited session it loaded at `loadedAt`: the mark goes when it is older than that
 * load, so the session is recorded as usual again. A mark written at or after the load stays: the visit it marks ended
 * after the owner read the session, so its turns are not under the owner's tail, and its next open starts at the tail
 * again.
 */
export function settleVisit(dataDir: string, sessionId: string, loadedAt: number): void {
	if (!recordable(sessionId)) return;
	const file = visitFile(dataDir, sessionId);
	try {
		if (statSync(file).mtimeMs < loadedAt) rmSync(file, { force: true });
	} catch {
		// no mark
	}
}
