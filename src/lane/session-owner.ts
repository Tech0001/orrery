/**
 * Which agent a pi or OMP session belongs to, kept outside the lanes' memory (lane privacy). Each lane keeps its own copy
 * cursors (src/pi/log.ts), so a lane that never saw a session would copy all of it, turns another agent said there
 * included: a session an agent opened by ORRERY_AGENT recorded in a lane's folder, then resumed there by that lane.
 *
 * <data>/session-owners/<session id> names the agent that first ran in the session, or NO_AGENT for a session under an
 * ORRERY_AGENT that named no agent. It is made once (exclusive create) and left alone. <session id>.visited says another
 * agent ran in the session since: the owner records it from its tail at its next open, so the visitor's turns stay out
 * of it too. Agent names only, never content; files 0600 in a 0700 folder. A session with no record (one recorded before
 * records existed) is copied as before. Node built-ins only: pi and OMP load this file.
 */

import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

/** The owner of a session that ran under an ORRERY_AGENT naming no agent: foreign to every lane. */
export const NO_AGENT = "-";
/** pi's and OMP's session ids are UUIDs; anything else could name a file elsewhere, so it has no record. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

const ownerFile = (dataDir: string, sessionId: string) => join(dataDir, "session-owners", sessionId);
const visitFile = (dataDir: string, sessionId: string) => `${ownerFile(dataDir, sessionId)}.visited`;

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

/** The session's owner, or undefined: no record (or an empty one), or an id that is no safe file name. */
function ownerOf(dataDir: string, sessionId: string): string | undefined {
	if (!SESSION_ID.test(sessionId)) return undefined;
	try {
		const name = readFileSync(ownerFile(dataDir, sessionId), "utf8").trim();
		return name === "" ? undefined : name;
	} catch {
		return undefined;
	}
}

/**
 * `agent` (a lane's name, or NO_AGENT) runs in session `sessionId`: it owns the session when it is the first to, and
 * otherwise marks the session visited when the owner is another. Called whether or not the lane's memory opened: the
 * turns said here are the agent's either way.
 */
export function noteSession(dataDir: string, sessionId: string, agent: string): void {
	if (!SESSION_ID.test(sessionId) || create(ownerFile(dataDir, sessionId), `${agent}\n`)) return;
	const owner = ownerOf(dataDir, sessionId);
	if (owner !== undefined && owner !== agent) create(visitFile(dataDir, sessionId), "");
}

/**
 * Whether lane `lane`, about to record session `sessionId`, must start at its tail: another agent (or NO_AGENT) owns
 * it, or it is the lane's own and another agent ran in it since (the mark is taken: from here on the lane records it as
 * usual). False for a session with no record. Call it only when the lane's memory is open, so a lane that could not
 * record never takes the mark.
 */
export function foreignSession(dataDir: string, sessionId: string, lane: string): boolean {
	const owner = ownerOf(dataDir, sessionId);
	if (owner === undefined) return false;
	if (owner !== lane) return true;
	try {
		rmSync(visitFile(dataDir, sessionId));
		return true;
	} catch {
		return false;
	}
}
