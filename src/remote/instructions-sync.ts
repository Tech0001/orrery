/**
 * An agent's instructions travel with its remote memory (spec 2026-10-13-orrery-agents-design §4, "Other machines"). The
 * text rides in the memory store's metadata (INSTRUCTIONS_KEY), so every save and snapshot carries it, sealed and bound
 * to the agent's name like the rest; instructions.md stays the file the person edits. SYNCED_FILE beside it holds the
 * hash of the text this machine's file and the remote last agreed on; it never leaves the machine. Text this machine
 * sends counts as agreed only once the remote has it (a save acknowledged, or this machine's unsaved rows sent or found
 * there at a check-out), so a save that never landed is sent again later, never mistaken for an edit made elsewhere. An
 * agreement holds only for the history it was made with: a push (which starts a new history) and a check-out that sets
 * this machine's memory aside as foreign forget it.
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
 * is (none when there is no file). A file over TRAVEL_MAX_BYTES stays on its machine: it is never sent and never
 * replaced, and each check-out says to shorten it. Something other than a readable file in instructions.md's place is
 * never replaced either.
 *
 * Older builds' `orrery run` kept the workspace's AGENTS.md under the store key "instructions" and wrote it at every
 * start; that key travels too, with a meaning of its own, so this copy has a key of its own, and "instructions" is
 * neither read nor written.
 */

import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readWholeInstructions, writeInstructions } from "../lane/instructions.ts";
import { writePrivate } from "../lane/private-file.ts";
import type { MemoryStore, StoreMarks } from "../memory/store.ts";

export const INSTRUCTIONS_KEY = "agent.instructions";
export const SYNCED_FILE = ".instructions-synced";
/** Over this, instructions.md stays on its machine: a save that large could be refused, and hold back every later one. */
export const TRAVEL_MAX_BYTES = 256 * 1024;

/** sha256 hex: the hash the store's marks give a metadata value, so a save the remote has can be matched to sent text. */
const instructionsHash = (text: string): string => createHash("sha256").update(text).digest("hex");

const stamp = (ms: number) => new Date(ms).toISOString().replaceAll(":", "-");

const tooLargeNotice = (lane: string) =>
	`Orrery: ${lane}'s instructions.md is over 256 KB, so it stays on this machine and does not travel with its memory; shorten it to share it.`;

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

/** This machine's memory was set aside as foreign: what it agreed on belongs to another history. */
export function forgetAgreement(laneDir: string): void {
	rmSync(join(laneDir, SYNCED_FILE), { force: true });
}

/**
 * This machine's own unsaved rows reached the remote at a check-out (sent, or a save found there whose reply was lost):
 * the instructions they changed came from this machine's file, and count as agreed before the file is settled.
 */
export function agreeOnOwnRows(laneDir: string, before: StoreMarks, after: StoreMarks): void {
	const sent = after.meta[INSTRUCTIONS_KEY];
	if (sent === undefined || sent === before.meta[INSTRUCTIONS_KEY]) return;
	try {
		agreeOn(laneDir, sent);
	} catch {
		// Not recorded: the settling compares the texts as before; at worst this machine's newer edit is kept aside.
	}
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
 * module comment). Afterwards both hold the same text, or undefined is returned: the file is over TRAVEL_MAX_BYTES and
 * stays this machine's alone (a shortened one goes up at a later check-out). Throws when something other than a
 * readable file is in the file's place; nothing is changed then.
 *
 * `foreign`: this check-out set the memory on this machine aside as another history's (or a rolled-back one's). The
 * file came with that memory, so it is never sent: the remote's copy is taken, and this machine's is kept aside.
 */
export function settleInstructions(store: MemoryStore, laneDir: string, lane: string, now: number, report: (message: string) => void, foreign = false): SettledInstructions | undefined {
	const found = readWholeInstructions(laneDir, TRAVEL_MAX_BYTES);
	if (found !== undefined && "tooLarge" in found) {
		report(tooLargeNotice(lane));
		return undefined;
	}
	const local = found?.text;
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

	if (foreign) {
		if (local === remote) {
			agreeOn(laneDir, instructionsHash(local));
			return { hash: instructionsHash(local) };
		}
		if (local === undefined && remote === "") return { hash: instructionsHash("") };
		if (local === undefined || local === "") return take();
		const aside = keepAside(laneDir, local, now);
		const used = remote === "" ? "this memory has none, so the file is now empty" : "the copy that travels with this memory is used now";
		return take(`Orrery: ${lane}'s instructions.md here came with the memory set aside; ${used}, and this machine's is kept in ${aside}.`);
	}
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
	// Both changed (or this machine never agreed with this history): the remote's copy wins, and this machine's is kept.
	const aside = local === "" ? undefined : keepAside(laneDir, local, now);
	if (last === undefined && aside !== undefined) {
		return take(`Orrery: ${lane}'s instructions.md here is not the copy that travels with its memory; that copy is used now, and this machine's is kept in ${aside}.`);
	}
	const theirs = remote === "" ? "the other machine cleared them" : "the other machine's are kept";
	return take(`Orrery: ${lane}'s instructions were changed both here and on another machine; ${theirs}${aside === undefined ? "." : `, and this machine's are in ${aside}.`}`);
}

/**
 * A held session's own edit of instructions.md into the store, at its close: when the file changed since the check-out
 * settled it (`settled`, a hash). Nobody else writes the store's copy while the session holds the agent, so the edit is
 * the newest. A missing file changes nothing (the next check-out brings the remote's copy back); one grown over
 * TRAVEL_MAX_BYTES is not sent, and the person is told. Returns the hash put in, agreed once the save carrying it is
 * acknowledged.
 */
export function instructionsIntoStore(store: MemoryStore, laneDir: string, settled: string, lane: string, report: (message: string) => void): string | undefined {
	const found = readWholeInstructions(laneDir, TRAVEL_MAX_BYTES);
	if (found === undefined) return undefined;
	if ("tooLarge" in found) {
		report(tooLargeNotice(lane));
		return undefined;
	}
	const local = found.text;
	if (instructionsHash(local) === settled || local === storeCopy(store)) return undefined;
	store.setMeta(INSTRUCTIONS_KEY, local);
	return instructionsHash(local);
}

/**
 * A first push: this machine's file is the agent's instructions, and no file is none (a copy the store kept from before
 * never travels in its place); a file over TRAVEL_MAX_BYTES is none too, and the person is told. Nothing is written: the
 * push puts `text` into its snapshot, and into the store once it has landed, then agrees on `hash` (undefined when the
 * file stays this machine's alone).
 */
export function pushInstructions(laneDir: string, lane: string, report: (message: string) => void): { readonly text: string; readonly hash?: string } {
	const found = readWholeInstructions(laneDir, TRAVEL_MAX_BYTES);
	if (found !== undefined && "tooLarge" in found) {
		report(tooLargeNotice(lane));
		return { text: "" };
	}
	const text = found?.text ?? "";
	return { text, hash: instructionsHash(text) };
}
