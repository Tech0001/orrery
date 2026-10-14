/**
 * An agent's instructions (spec 2026-10-13-orrery-agents-design §5): who it is, in <lane folder>/instructions.md, apart
 * from any folder's project files. At most INSTRUCTIONS_MAX_BYTES reach the model; a longer file is cut there, with a
 * notice. A missing, empty or blank file is "no instructions". Node built-ins and relative imports only: pi and OMP load
 * this file.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { writePrivate } from "./private-file.ts";

export const INSTRUCTIONS_FILE = "instructions.md";
export const INSTRUCTIONS_MAX_BYTES = 32 * 1024;

export interface Instructions {
	readonly text: string;
	/** The file is longer than INSTRUCTIONS_MAX_BYTES: `text` is its first 32 KB, ending on a whole character. */
	readonly cut: boolean;
	/** The file's modification time (ms) when it was read. */
	readonly at: number;
}

export const instructionsPath = (laneDir: string): string => join(laneDir, INSTRUCTIONS_FILE);

/**
 * Where a cut at `end` bytes leaves whole UTF-8 characters: back past the continuation bytes (10xxxxxx) of a character
 * that the cut would split, to its first byte, which is left out with them.
 */
function wholeCharacters(buffer: Buffer, end: number): number {
	let at = end;
	while (at > 0 && (buffer[at] & 0xc0) === 0x80) at--;
	return at;
}

/** The lane's instructions, or undefined when the file is missing, not a file, unreadable, or blank. */
export function readInstructions(laneDir: string): Instructions | undefined {
	let fd: number;
	try {
		fd = openSync(instructionsPath(laneDir), "r");
	} catch {
		return undefined;
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) return undefined;
		// One byte past the limit tells whether the file goes on, and whether the cut splits a character.
		const buffer = Buffer.alloc(INSTRUCTIONS_MAX_BYTES + 1);
		let length = 0;
		while (length < buffer.length) {
			const read = readSync(fd, buffer, length, buffer.length - length, null);
			if (read === 0) break;
			length += read;
		}
		const cut = length > INSTRUCTIONS_MAX_BYTES;
		const text = buffer.toString("utf8", 0, cut ? wholeCharacters(buffer, INSTRUCTIONS_MAX_BYTES) : length);
		if (text.trim() === "") return undefined;
		return { text, cut, at: stat.mtimeMs };
	} catch {
		return undefined;
	} finally {
		closeSync(fd);
	}
}

/** The system-prompt section: a heading naming the agent, then its instructions. */
export function instructionsSection(name: string, instructions: Instructions): string {
	return `# Agent: ${name}\n\n${instructions.text.trimEnd()}`;
}

/** Said in the session when the file is over 32 KB. */
export function cutNotice(name: string): string {
	return `Orrery: ${name}'s instructions are over 32 KB; only the first 32 KB reach the model. Shorten instructions.md.`;
}

/** A new agent's instructions: its name, one line of purpose, and where the rest goes. */
export function instructionsTemplate(name: string, purpose = "What this agent is for, in one line."): string {
	return `# ${name}\n\n${purpose}\n\nAdd how this agent should work: its role, what it owns, how it reports.\n`;
}

/** Writes the instructions (0600, atomically) into the lane's folder (0700, made when needed). */
export function writeInstructions(laneDir: string, text: string): void {
	writePrivate(instructionsPath(laneDir), text);
}

export type InstructionsState = "ok" | "none" | "too large";

/**
 * What the Agents page says about the file ("too large": only its first 32 KB are used), and its modification time when
 * it holds instructions. It reads what readInstructions reads, so the page and the sessions agree on "none".
 */
export function instructionsFacts(laneDir: string): { readonly state: InstructionsState; readonly at?: number } {
	const found = readInstructions(laneDir);
	if (found === undefined) return { state: "none" };
	return { state: found.cut ? "too large" : "ok", at: found.at };
}
