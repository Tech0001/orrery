/**
 * Antigravity CLI's record of a conversation, as Orrery reads it (spec 2026-11-20-antigravity-design, "Recording"):
 * `<Antigravity's folder>/brain/<conversation>/.system_generated/logs/transcript_full.jsonl`, one JSON step per line.
 * Each step has a `step_index`, a `source` and a `type` (seen in agy 1.5.13):
 * - `USER_EXPLICIT` `USER_INPUT`: what the person typed, wrapped in `<USER_REQUEST>`, then `<ADDITIONAL_METADATA>` and
 *   sometimes `<USER_SETTINGS_CHANGE>`. The only steps recorded as prompts.
 * - `SYSTEM_SDK`: what a hook injected (a SessionStart or PreInvocation systemMessage, Orrery's view among them, and a
 *   hook's userMessage, typed `USER_INPUT` but no person's).
 * - `SYSTEM`: Antigravity's own messages (a subagent's result, a Stop hook's continue) and `CHECKPOINT`, a compaction's
 *   summary, after which the model sees no earlier step.
 * - `MODEL`: `PLANNER_RESPONSE` (the model's words, empty while it only calls tools) and `GENERIC` (tool results).
 * A subagent's conversation has its own transcript, whose first step is a SYSTEM message, never a typed prompt.
 *
 * Words are only ever taken from this file, which only Antigravity writes (the guard refuses every tool's write there).
 */

import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, sep } from "node:path";
import { agyTranscript } from "./names.ts";

/** `path` with its longest existing part's links followed: where it is, or would be once made. */
function realish(path: string): string {
	const rest: string[] = [];
	for (let at = path; ; at = dirname(at)) {
		try {
			return join(realpathSync(at), ...rest.reverse());
		} catch {
			if (dirname(at) === at) return path;
			rest.push(basename(at));
		}
	}
}

/**
 * `path` when it is conversation `conversation`'s transcript under Antigravity's folder `folder` (as names.ts
 * agyTranscript makes it), and lies there once links are followed; else undefined.
 */
export function agyTranscriptIn(path: unknown, folder: unknown, conversation: string): string | undefined {
	if (typeof path !== "string" || typeof folder !== "string" || !isAbsolute(path) || !isAbsolute(folder) || normalize(path) !== path) return undefined;
	if (path !== agyTranscript(folder, conversation)) return undefined;
	const top = realish(folder);
	return realish(path).startsWith(top.endsWith(sep) ? top : `${top}${sep}`) ? path : undefined;
}

/** One step of the transcript, as Orrery reads it. */
export interface AgyStep {
	readonly index: number;
	readonly source: string;
	readonly type: string;
	readonly content: string;
	/** When the step was made (ms), when it says so. */
	readonly at?: number;
}

/** A transcript line as a step, or undefined when it is none. */
export function parseStep(line: string): AgyStep | undefined {
	let value: Record<string, unknown>;
	try {
		value = JSON.parse(line) as Record<string, unknown>;
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const index = value.step_index;
	if (!Number.isSafeInteger(index) || (index as number) < 0) return undefined;
	const at = typeof value.created_at === "string" ? Date.parse(value.created_at) : Number.NaN;
	return {
		index: index as number,
		source: typeof value.source === "string" ? value.source : "",
		type: typeof value.type === "string" ? value.type : "",
		content: typeof value.content === "string" ? value.content : "",
		...(Number.isFinite(at) ? { at } : {}),
	};
}

/** Whether the person typed this step. */
export const isPrompt = (step: AgyStep): boolean => step.source === "USER_EXPLICIT" && step.type === "USER_INPUT";

/** Whether this step is a compaction's checkpoint. */
export const isCheckpoint = (step: AgyStep): boolean => step.type === "CHECKPOINT";

const REQUEST = /^<USER_REQUEST>\n([\s\S]*?)\n<\/USER_REQUEST>(?:\n|$)/;

/** What the person typed, from a prompt step's content: the `<USER_REQUEST>` body. Undefined when it has none. */
export function promptText(content: string): string | undefined {
	const match = REQUEST.exec(content);
	return match === null ? undefined : (match[1] as string);
}

/** A slash command (`/compact`, `/model`): not recorded, nor its reply. */
export const isCommand = (text: string): boolean => text.trimStart().startsWith("/");

/** A message for memory, from the transcript. */
export interface AgySaid {
	readonly kind: "user" | "talk";
	readonly text: string;
	readonly at?: number;
	/** The step it came from. */
	readonly step: number;
}

/**
 * The messages of the turns in `steps` (in order, from a turn's prompt on) and where the next read starts: each turn
 * whose end is known (a later prompt, or `over`: the conversation is idle, or Antigravity is gone) gives its prompt and
 * its last non-empty reply; a slash command's turn gives nothing. `next` is the open turn's prompt step (read again
 * next time), else the step after the last one.
 */
export function turnsOf(steps: readonly AgyStep[], over: boolean): { readonly said: AgySaid[]; readonly next: number | undefined } {
	const said: AgySaid[] = [];
	let open: { step: AgyStep; text: string | undefined; reply: AgyStep | undefined } | undefined;
	const close = () => {
		if (open === undefined) return;
		const { step, text, reply } = open;
		if (text !== undefined && text.trim() !== "" && !isCommand(text)) {
			said.push({ kind: "user", text, step: step.index, ...(step.at === undefined ? {} : { at: step.at }) });
			if (reply !== undefined) said.push({ kind: "talk", text: reply.content, step: reply.index, ...(reply.at === undefined ? {} : { at: reply.at }) });
		}
		open = undefined;
	};
	for (const step of steps) {
		if (isPrompt(step)) {
			close();
			open = { step, text: promptText(step.content), reply: undefined };
		} else if (open !== undefined && step.source === "MODEL" && step.type === "PLANNER_RESPONSE" && step.content.trim() !== "") {
			open.reply = step;
		}
	}
	if (over) close();
	const last = steps.at(-1);
	return { said, next: open !== undefined ? open.step.index : last === undefined ? undefined : last.index + 1 };
}

/** The most read at once from a transcript (its tool results can be large). */
const READ_MAX = 64 * 1024 * 1024;

/**
 * The steps of the file at `path` from byte `offset` on, each with the byte where its line starts, and where the last
 * whole line ends. Read through no link and never waiting on a FIFO; undefined when it can't be read, or when it is
 * shorter than `offset` (rewritten: the caller reads it again from 0).
 */
export function readSteps(path: string, offset: number): { readonly steps: Array<AgyStep & { readonly byte: number }>; readonly end: number } | undefined {
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? { steps: [], end: 0 } : undefined;
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size < offset) return undefined;
		const length = Math.min(stat.size - offset, READ_MAX);
		const buffer = Buffer.alloc(length);
		let got = 0;
		while (got < length) {
			const n = readSync(fd, buffer, got, length - got, offset + got);
			if (n === 0) break;
			got += n;
		}
		const steps: Array<AgyStep & { readonly byte: number }> = [];
		let start = 0;
		for (;;) {
			const newline = buffer.indexOf(10, start);
			if (newline === -1 || newline >= got) break;
			const step = parseStep(buffer.toString("utf8", start, newline));
			if (step !== undefined) steps.push({ ...step, byte: offset + start });
			start = newline + 1;
		}
		return { steps, end: offset + start };
	} catch {
		return undefined;
	} finally {
		closeSync(fd);
	}
}

/** Where a reader stands: the next step to record, and the byte its line starts at (or the file's end). */
export interface AgyMark {
	readonly path: string;
	readonly step: number;
	readonly byte: number;
}

/** A mark from memory meta, or undefined. */
export function parseAgyMark(text: string | undefined): AgyMark | undefined {
	if (text === undefined) return undefined;
	try {
		const value = JSON.parse(text) as Record<string, unknown>;
		if (typeof value.path === "string" && Number.isSafeInteger(value.step) && Number.isSafeInteger(value.byte) && (value.step as number) >= 0 && (value.byte as number) >= 0) {
			return { path: value.path, step: value.step as number, byte: value.byte as number };
		}
	} catch {
		// none
	}
	return undefined;
}

/**
 * One conversation's transcript as the recorder reads it: from its mark on, the turns that are over. A file shorter than
 * the mark's byte (rewritten) is read again from its start, steps before the mark's skipped.
 */
export class AgyTranscriptReader {
	#mark: AgyMark;

	constructor(mark: AgyMark) {
		this.#mark = mark;
	}

	mark(): AgyMark {
		return this.#mark;
	}

	/** The messages of the turns over since the mark, moving it; undefined when the file can't be read. */
	read(over: boolean): AgySaid[] | undefined {
		let read = readSteps(this.#mark.path, this.#mark.byte);
		if (read === undefined) {
			read = readSteps(this.#mark.path, 0);
			if (read === undefined) return undefined;
		}
		const steps = read.steps.filter((step) => step.index >= this.#mark.step);
		const { said, next } = turnsOf(steps, over);
		if (next !== undefined) {
			const at = steps.find((step) => step.index === next);
			this.#mark = { path: this.#mark.path, step: next, byte: at === undefined ? read.end : at.byte };
		}
		return said;
	}
}

/** What PreInvocation needs to know of a conversation (spec "Hooks"), read on from where it last stopped. */
export interface AgyScan {
	/** The byte read up to, and the steps seen. */
	readonly byte: number;
	readonly steps: number;
	/** Whether the first step is a typed prompt: the person's own conversation, not a subagent's. Undefined: none yet. */
	readonly own?: boolean;
	/** The last checkpoint's step (-1: none). */
	readonly checkpoint: number;
	/** The last step of Orrery's view (-1: none). */
	readonly view: number;
	/** The step of the last typed prompt (-1: none): where recording starts in a resumed conversation. */
	readonly prompt: number;
}

export const EMPTY_SCAN: AgyScan = { byte: 0, steps: 0, checkpoint: -1, view: -1, prompt: -1 };

/** The marker Orrery's view chunks carry, by which a scan finds them. */
export const VIEW_MARK = "Orrery memory view";

/**
 * `scan` carried on over the transcript at `path` (from its byte on; from the start when the file was rewritten).
 * Undefined when the file can't be read.
 */
export function scanOn(path: string, scan: AgyScan): AgyScan | undefined {
	let from = scan;
	let read = readSteps(path, scan.byte);
	if (read === undefined) {
		from = EMPTY_SCAN;
		read = readSteps(path, 0);
		if (read === undefined) return undefined;
	}
	let { own, checkpoint, view, prompt, steps } = from;
	for (const step of read.steps) {
		if (own === undefined && step.index === 0) own = isPrompt(step);
		if (isCheckpoint(step)) checkpoint = step.index;
		if (step.source === "SYSTEM_SDK" && step.content.includes(VIEW_MARK)) view = step.index;
		if (isPrompt(step)) prompt = step.index;
		steps = Math.max(steps, step.index + 1);
	}
	return { byte: read.end, steps, checkpoint, view, prompt, ...(own === undefined ? {} : { own }) };
}

/**
 * `text` in chunks of at most `max` UTF-8 bytes, split after a line's end where one fits, else at a character's edge.
 * Antigravity cuts an injected step past about 48,000 bytes.
 */
export function chunksOf(text: string, max: number): string[] {
	const chunks: string[] = [];
	let rest = text;
	while (Buffer.byteLength(rest, "utf8") > max) {
		const bytes = Buffer.from(rest, "utf8");
		let cut = max;
		// Back to a character's first byte.
		while (cut > 0 && ((bytes[cut] as number) & 0xc0) === 0x80) cut--;
		const head = bytes.toString("utf8", 0, cut);
		const newline = head.lastIndexOf("\n");
		const piece = newline > 0 ? head.slice(0, newline + 1) : head;
		chunks.push(piece);
		rest = rest.slice(piece.length);
	}
	if (rest !== "" || chunks.length === 0) chunks.push(rest);
	return chunks;
}
