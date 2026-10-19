/**
 * Confirming Claude Code's prompts against its own transcript (spec 2026-10-18-agent-permissions §3c). A prompt that
 * UserPromptSubmit spooled is held until the transcript Claude Code writes says what it was:
 * - the user's: a `type:"user"` line under the hook's promptId, with the same words and no tool result's marks, typed or
 *   queued (promptSource typed or queued, origin human) or sent by `-p` (promptSource sdk, no origin, or a human one). A
 *   queued command's attachment is never the user's: it names no promptId, so a person's earlier words could stand for
 *   an injection's later ones;
 * - a report: a message from a peer (a subagent's report, or anything sent to the session's inbox, the agent's own shell
 *   included), recorded as "[subagent] …" as the importer records subagent reports (src/import/claude.ts), never as the
 *   user's words;
 * - dropped: a task notification;
 * - not seen yet: the holder waits, until the turn's Stop plus a grace (src/claude/holder.ts), then drops it and counts it
 *   (unconfirmed.json, shown by `orrery status`).
 * Claude Code writes the line within a moment of the hook (2.1.302: not there at UserPromptSubmit, there 200 ms later).
 *
 * The transcript's path comes only from a SessionStart whose caller was checked (src/claude/peer.ts), and only under
 * Claude Code's projects folder ($CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects), links followed as far as they
 * exist; it is read only from the offset SessionStart saw on, a line at a time, through no link at its own place and
 * never once it leads out of that folder (on Linux, judged by the file it opened). A file replaced, or written anew
 * shorter, is read from its start. Lines are kept only when they could confirm a prompt, for a while; each confirms one
 * prompt, and one recorded before (by its uuid: a resume replays history) is not recorded again.
 */

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, sep } from "node:path";
import { writePrivate } from "../agent/private-file.ts";
import { unconfirmedFile } from "./paths.ts";

/** What a spooled prompt was, by the transcript: the user's, a peer's report, dropped, or not seen yet. */
export type PromptVerdict = "user" | "report" | "drop" | "wait";

/** A spooled prompt: the hook's promptId and words. */
export interface SpooledPrompt {
	readonly promptId: string;
	readonly text: string;
}

/** The promptSource values of a person's own prompt: typed, queued while a turn ran, or `claude -p`'s. */
const HUMAN_SOURCES: ReadonlySet<unknown> = new Set(["typed", "queued", "sdk"]);
const notification = (kind: unknown) => kind === "task_notification" || kind === "task-notification";

type Line = Record<string, unknown>;
const record = (value: unknown): Line | undefined => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Line) : undefined);
const kindOf = (origin: unknown): unknown => record(origin)?.kind;

/**
 * A user line's words: its string content, or the text of content that holds only text and images (a prompt with an
 * image attached). A tool result's content names its tool call: no words of the user's.
 */
function wordsOf(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content) || content.length === 0) return undefined;
	const blocks = content.map(record);
	if (blocks.some((block) => block === undefined || (block.type !== "text" && block.type !== "image"))) return undefined;
	return blocks
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block?.text as string)
		.join("\n");
}

/** What one transcript line says of `prompt`. */
function verdictOf(line: Line, prompt: SpooledPrompt): PromptVerdict {
	if (line.type === "user") {
		if (typeof line.promptId !== "string" || line.promptId !== prompt.promptId) return "wait";
		const message = record(line.message);
		if (message === undefined || wordsOf(message.content) !== prompt.text) return "wait";
		// A tool's result is a user line under the turn's promptId too.
		if (line.toolUseResult !== undefined || line.sourceToolAssistantUUID !== undefined) return "wait";
		const origin = kindOf(line.origin);
		if (notification(line.turnOrigin) || notification(origin) || prompt.text.trimStart().startsWith("<task-notification")) return "drop";
		if (origin === "peer" || line.turnOrigin === "peer") return "report";
		if (line.isMeta === true || line.isCompactSummary === true || !HUMAN_SOURCES.has(line.promptSource)) return "wait";
		// Typed and queued prompts carry a human origin; only `-p`'s (sdk) come without one (2.1.302).
		if (line.origin === undefined) return line.promptSource === "sdk" ? "user" : "wait";
		return origin === "human" ? "user" : "wait";
	}
	// A queued command names no promptId: its words alone may make a prompt a report or nothing, never the user's.
	const attachment = line.type === "attachment" ? record(line.attachment) : undefined;
	if (attachment?.type === "queued_command" && attachment.prompt === prompt.text) {
		const origin = kindOf(attachment.origin);
		if (notification(origin)) return "drop";
		if (origin === "peer") return "report";
	}
	return "wait";
}

/** What Claude Code's transcript `lines` say `prompt` was (module doc): the first line that says anything decides. */
export function confirmPrompt(lines: readonly string[], prompt: SpooledPrompt): PromptVerdict {
	for (const text of lines) {
		let line: Line | undefined;
		try {
			line = record(JSON.parse(text));
		} catch {
			continue;
		}
		if (line === undefined) continue;
		const verdict = verdictOf(line, prompt);
		if (verdict !== "wait") return verdict;
	}
	return "wait";
}

/** Claude Code's projects folder: $CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects. */
export function projectsFolder(env: NodeJS.ProcessEnv, home: string): string {
	return join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "projects");
}

/**
 * Why a transcript can't be read here, or undefined when it can: on Linux the reader judges the file it opened by
 * /proc/self/fd (TranscriptReader.read), so without /proc it could read none, and every prompt would go unconfirmed.
 * `proc`: the folder asked (tests pass another).
 */
export function unreadableHere(proc = "/proc/self/fd"): string | undefined {
	if (process.platform !== "linux") return undefined;
	try {
		readdirSync(proc);
		return undefined;
	} catch {
		return `${proc} can't be read, and Orrery reads Claude Code's transcript only through it`;
	}
}

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

/** Whether `path` lies under `folder` (both as they really are). */
const under = (path: string, folder: string) => path.startsWith(folder.endsWith(sep) ? folder : `${folder}${sep}`);

/**
 * `path` when it names a transcript (a .jsonl file) under Claude Code's projects folder `projects`, there already or not
 * yet, links followed as far as they exist; else undefined: not a string, not absolute, `..`, or leading elsewhere.
 */
export function transcriptIn(path: unknown, projects: string): string | undefined {
	if (typeof path !== "string" || !isAbsolute(path) || normalize(path) !== path || !path.endsWith(".jsonl")) return undefined;
	return under(realish(path), realish(projects)) ? path : undefined;
}

/** Where a session's transcript is read from, and what its reader recorded (TranscriptReader's state, kept in memory meta). */
export interface TranscriptMark {
	readonly path: string;
	/** Claude Code's projects folder the path was checked against. */
	readonly projects: string;
	/** The byte the next read starts at: a line's start. */
	readonly offset: number;
	/** The lines that confirmed what was recorded lately (TranscriptReader.remember), so a replay is recorded once. */
	readonly recorded?: readonly string[];
	/** The file read so far ("device:inode"): another file at the path is read from its start. */
	readonly file?: string;
}

/** A TranscriptMark from memory meta, or undefined when it is no mark. */
export function parseMark(text: string | undefined): TranscriptMark | undefined {
	if (text === undefined) return undefined;
	try {
		const value = record(JSON.parse(text));
		if (value === undefined || typeof value.path !== "string" || typeof value.projects !== "string") return undefined;
		const offset = value.offset;
		if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) return undefined;
		const recorded = Array.isArray(value.recorded) ? value.recorded.filter((key): key is string => typeof key === "string") : [];
		return { path: value.path, projects: value.projects, offset, recorded, ...(typeof value.file === "string" ? { file: value.file } : {}) };
	} catch {
		return undefined;
	}
}

/** The most read in one go; a longer line is passed over. */
const CHUNK = 8 * 1024 * 1024;
/** How long a line that could confirm a prompt is kept unused, and how many are kept. */
const KEEP_MS = 10 * 60_000;
const KEEP_LINES = 1000;
/** How many recorded prompts' lines are remembered against a replay. */
const RECORDED_KEPT = 64;

interface Kept {
	readonly text: string;
	/** The line's own identity: its uuid, else where it starts in the file. */
	readonly id: string;
	/** Where the line starts in the file. */
	readonly at: number;
	readonly readAt: number;
}

/** What the transcript said of a prompt, and which line said it (its identity, for a replay's check). */
export interface Confirmation {
	readonly verdict: PromptVerdict;
	readonly line?: string;
}

/**
 * One session's transcript, read as Claude Code appends to it: only bytes from its offset on, a whole line at a time,
 * keeping the lines that could confirm a prompt until one does or they are old.
 */
export class TranscriptReader {
	readonly path: string;
	readonly projects: string;
	#offset: number;
	/** Mid-way through a line longer than CHUNK: the rest of it is passed over. */
	#skipping = false;
	#kept: Kept[] = [];
	readonly #recorded: string[];
	/** The file read so far, "device:inode". */
	#file: string | undefined;

	constructor(mark: TranscriptMark) {
		this.path = mark.path;
		this.projects = mark.projects;
		this.#offset = mark.offset;
		this.#recorded = [...(mark.recorded ?? [])];
		this.#file = mark.file;
	}

	/** Starts over at the file's start: another file at the path, or this one written anew. */
	#restart(): void {
		this.#offset = 0;
		this.#skipping = false;
		this.#kept = [];
	}

	/** Reads what was appended since the last read. A file that isn't there yet, or can't be read now, is read later. */
	read(now = Date.now()): void {
		let fd: number;
		try {
			// Never through a link at the transcript's own place, and never waiting on a FIFO put there.
			fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		} catch {
			return;
		}
		try {
			const stat = fstatSync(fd);
			// On Linux, the file this opened, whatever was swapped in on the way; elsewhere (macOS), the path as it is now.
			const opened = process.platform === "linux" ? readlinkSync(`/proc/self/fd/${fd}`) : realpathSync(this.path);
			if (!stat.isFile() || !under(opened, realish(this.projects))) return;
			// A transcript is only appended to: another file, or a shorter one, was written anew; read from its start.
			const file = `${stat.dev}:${stat.ino}`;
			if ((this.#file !== undefined && this.#file !== file) || stat.size < this.#offset) this.#restart();
			this.#file = file;
			while (this.#offset < stat.size) {
				const want = Math.min(stat.size - this.#offset, CHUNK);
				const buffer = Buffer.alloc(want);
				const got = readSync(fd, buffer, 0, want, this.#offset);
				if (got <= 0) break;
				const end = buffer.lastIndexOf(10, got - 1);
				if (end < 0) {
					// No line ends here: wait for the rest, unless the line is longer than a read.
					if (got < CHUNK) break;
					this.#offset += got;
					this.#skipping = true;
					continue;
				}
				let start = 0;
				for (let newline = buffer.indexOf(10, start); newline >= 0 && newline <= end; newline = buffer.indexOf(10, start)) {
					if (this.#skipping) this.#skipping = false;
					else this.#keep(buffer.toString("utf8", start, newline), this.#offset + start, now);
					start = newline + 1;
				}
				this.#offset += end + 1;
			}
		} catch {
			// read again next time
		} finally {
			closeSync(fd);
		}
		const fresh = this.#kept.filter((kept) => now - kept.readAt < KEEP_MS);
		this.#kept = fresh.slice(-KEEP_LINES);
	}

	/** Keeps a line that could confirm a prompt: a user line under a promptId, or a queued command. */
	#keep(text: string, at: number, now: number): void {
		if (!text.includes('"promptId"') && !text.includes('"queued_command"')) return;
		let line: Line | undefined;
		try {
			line = record(JSON.parse(text));
		} catch {
			return;
		}
		const user = line?.type === "user" && typeof line.promptId === "string" && line.toolUseResult === undefined;
		const queued = line?.type === "attachment" && record(line.attachment)?.type === "queued_command";
		if (line !== undefined && (user || queued)) this.#kept.push({ text, id: typeof line.uuid === "string" ? `uuid:${line.uuid}` : `at:${at}`, at, readAt: now });
	}

	/** What the lines read so far say `prompt` was, and which line said it; that line is used up. */
	confirm(prompt: SpooledPrompt): Confirmation {
		for (const [index, kept] of this.#kept.entries()) {
			const verdict = confirmPrompt([kept.text], prompt);
			if (verdict === "wait") continue;
			this.#kept.splice(index, 1);
			return { verdict, line: kept.id };
		}
		return { verdict: "wait" };
	}

	/** Whether what `line` says was recorded before: a resume or a fork replays history, uuids and all. */
	recordedBefore(line: string): boolean {
		return this.#recorded.includes(lineKey(line));
	}

	/** Remembers that what `line` says was recorded. */
	remember(line: string): void {
		this.#recorded.push(lineKey(line));
		this.#recorded.splice(0, Math.max(0, this.#recorded.length - RECORDED_KEPT));
	}

	/** Where a reader started afresh picks up without losing a line this one still keeps. */
	mark(): TranscriptMark {
		const offset = Math.min(this.#offset, ...this.#kept.map((kept) => kept.at));
		return { path: this.path, projects: this.projects, offset, recorded: [...this.#recorded], ...(this.#file === undefined ? {} : { file: this.#file }) };
	}
}

/** A confirming line's key in memory meta: a digest of its identity. */
const lineKey = (line: string) => createHash("sha256").update(line).digest("hex").slice(0, 32);

/** How many Claude Code prompts were dropped because the transcript never confirmed them (`orrery status`). */
export function readUnconfirmed(agentDir: string): number {
	try {
		const value = record(JSON.parse(readFileSync(unconfirmedFile(agentDir), "utf8")));
		const dropped = value?.dropped;
		return typeof dropped === "number" && Number.isSafeInteger(dropped) && dropped > 0 ? dropped : 0;
	} catch {
		return 0;
	}
}

/** Counts `count` more unconfirmed prompts dropped (the holder, which alone writes the agent's memory, calls it). */
export function addUnconfirmed(agentDir: string, count = 1): void {
	writePrivate(unconfirmedFile(agentDir), `${JSON.stringify({ dropped: readUnconfirmed(agentDir) + count, at: new Date().toISOString() })}\n`);
}
