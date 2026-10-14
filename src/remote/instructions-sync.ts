/**
 * An agent's instructions travel with its remote memory (spec 2026-10-13-orrery-agents-design §4, "Other machines"). The
 * text rides in the memory store's metadata (INSTRUCTIONS_KEY), so every save and snapshot carries it, sealed and bound
 * to the agent's name like the rest; instructions.md stays the file the person edits. SYNCED_FILE beside it holds the
 * hash of the text this machine's file and the remote last agreed on; it never leaves the machine. Text this machine
 * sends counts as agreed only once a save carrying it is acknowledged, so a save that never landed is sent again later,
 * never mistaken for an edit made elsewhere.
 *
 * At each check-out, with the store at the remote's newest, the file is settled against the store's copy:
 * - only the remote's copy changed: the file gets it, and the person is told;
 * - only this machine's file changed: the store gets it, and the next save sends it;
 * - both changed: the remote's wins, this machine's is kept as instructions-unsaved-<time>.md beside it, and the person
 *   is told (as unsaved memory is, spec 2026-10-12-remote-lanes-design §5.9). A machine that never agreed with the
 *   remote counts as changed when its file holds other text, and as never having had any when it holds none.
 * Instructions taken away travel when the file is emptied (blank): that is "none", and another machine keeps its copy
 * aside when the empty one arrives. A deleted file does not travel: the remote's copy comes back at the next check-out,
 * with a notice. So a machine that never had instructions never clears another machine's.
 *
 * A held session's own edit goes into the store when it closes, before its last save; a first push sends the file as it
 * is (none when there is no file). Something other than a readable file in instructions.md's place is never replaced.
 */

import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readWholeInstructions, writeInstructions } from "../lane/instructions.ts";
import { writePrivate } from "../lane/private-file.ts";
import type { MemoryStore } from "../memory/store.ts";

export const INSTRUCTIONS_KEY = "instructions";
export const SYNCED_FILE = ".instructions-synced";

/** sha256 hex: the hash the store's marks give a metadata value, so an acknowledged save can be matched to sent text. */
const instructionsHash = (text: string): string => createHash("sha256").update(text).digest("hex");

const stamp = (ms: number) => new Date(ms).toISOString().replaceAll(":", "-");

/** The hash this machine last agreed on with the remote, or undefined when it never did (or the record is damaged). */
function agreed(laneDir: string): string | undefined {
	try {
		const text = readFileSync(join(laneDir, SYNCED_FILE), "utf8").trim();
		return /^[0-9a-f]{64}$/.test(text) ? text : undefined;
	} catch {
		return undefined;
	}
}

/** Records that this machine's file and the remote agree on the text with this hash. */
export function agreeOn(laneDir: string, hash: string): void {
	if (agreed(laneDir) !== hash) writePrivate(join(laneDir, SYNCED_FILE), `${hash}\n`);
}

/** The store's copy: "" when it has none (never set, or cleared on purpose). */
function storeCopy(store: MemoryStore): string {
	const kept = store.getMeta(INSTRUCTIONS_KEY);
	return kept === undefined || kept.trim() === "" ? "" : kept;
}

/** Keeps this machine's text in a new instructions-unsaved-<time>.md beside instructions.md; never replaces one. */
function keepAside(laneDir: string, text: string, now: number): string {
	const name = `instructions-unsaved-${stamp(now)}`;
	for (let n = 1; ; n++) {
		const path = join(laneDir, n === 1 ? `${name}.md` : `${name}-${n}.md`);
		try {
			closeSync(openSync(path, "wx", 0o600));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
			throw error;
		}
		writePrivate(path, text);
		return path;
	}
}

/** What a check-out settled. */
export interface SettledInstructions {
	/** The hash of the text instructions.md and the store hold now: a later edit of the file is this machine's. */
	readonly hash: string;
	/** The hash of this machine's text put into the store, agreed once a save carrying it is acknowledged. */
	readonly sent?: string;
}

/**
 * After a check-out brought the store to the remote's newest: settles instructions.md and the store's copy (see the
 * module comment). Afterwards both hold the same text. Throws when something other than a readable file is in the
 * file's place; nothing is changed then.
 */
export function settleInstructions(store: MemoryStore, laneDir: string, lane: string, now: number, report: (message: string) => void): SettledInstructions {
	const local = readWholeInstructions(laneDir);
	const remote = storeCopy(store);
	const last = agreed(laneDir);
	const take = (message?: string): SettledInstructions => {
		writeInstructions(laneDir, remote);
		agreeOn(laneDir, instructionsHash(remote));
		if (message !== undefined) report(message);
		return { hash: instructionsHash(remote) };
	};
	const send = (text: string): SettledInstructions => {
		store.setMeta(INSTRUCTIONS_KEY, text);
		return { hash: instructionsHash(text), sent: instructionsHash(text) };
	};

	if (local === undefined) {
		// No file: a machine that never had one, or one deleted here. Neither travels; the remote's copy comes (back).
		if (remote === "") {
			if (last !== undefined) agreeOn(laneDir, instructionsHash(""));
			return { hash: instructionsHash("") };
		}
		return take(last === undefined ? undefined : `Orrery: ${lane}'s instructions.md was deleted here; the copy that travels with its memory is back. To take the instructions away, empty the file instead.`);
	}
	if (local === remote) {
		agreeOn(laneDir, instructionsHash(local));
		return { hash: instructionsHash(local) };
	}
	if (last === undefined) {
		// Never agreed: a blank file is "never had any", and the remote having none leaves nothing to lose.
		if (local === "") return take();
		if (remote === "") return send(local);
	} else {
		if (instructionsHash(local) === last) {
			if (remote !== "") return take(`Orrery: ${lane}'s instructions were changed on another machine; this machine now has them.`);
			// Cleared on purpose elsewhere: this machine's copy is kept, in case that was a slip.
			const aside = keepAside(laneDir, local, now);
			return take(`Orrery: ${lane}'s instructions were cleared on another machine; this machine's copy is kept in ${aside}.`);
		}
		if (instructionsHash(remote) === last) return send(local);
	}
	// Both changed: the remote's copy wins, and this machine's is kept beside it.
	const aside = local === "" ? undefined : keepAside(laneDir, local, now);
	const theirs = remote === "" ? "the other machine cleared them" : "the other machine's are kept";
	return take(`Orrery: ${lane}'s instructions were changed both here and on another machine; ${theirs}${aside === undefined ? "." : `, and this machine's are in ${aside}.`}`);
}

/**
 * A held session's own edit of instructions.md into the store, at its close: when the file changed since the check-out
 * settled it (`settled`, a hash). Nobody else writes the store's copy while the session holds the agent, so the edit is
 * the newest. A missing file changes nothing (the next check-out brings the remote's copy back). Returns the hash put in,
 * agreed once the save carrying it is acknowledged.
 */
export function instructionsIntoStore(store: MemoryStore, laneDir: string, settled: string): string | undefined {
	const local = readWholeInstructions(laneDir);
	if (local === undefined || instructionsHash(local) === settled || local === storeCopy(store)) return undefined;
	store.setMeta(INSTRUCTIONS_KEY, local);
	return instructionsHash(local);
}

/**
 * A first push: this machine's file is the agent's instructions, and no file is none (a copy the store kept from before
 * never travels in its place). Returns the hash, agreed once the push's snapshot lands.
 */
export function pushInstructions(store: MemoryStore, laneDir: string): string {
	const local = readWholeInstructions(laneDir) ?? "";
	if ((store.getMeta(INSTRUCTIONS_KEY) ?? "") !== local) store.setMeta(INSTRUCTIONS_KEY, local);
	return instructionsHash(local);
}
