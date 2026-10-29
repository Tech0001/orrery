/**
 * Confirming Grok Build's prompts and replies against its own session log. Grok runs its hooks through a pipe, so the
 * agent's own shell can pipe made-up input into Orrery's hook command and nothing about the caller tells them apart;
 * Grok's record of the session is the proof, as Codex's rollout is for Codex (src/codex/rollout.ts). A prompt or reply
 * the hooks spooled is held until the log says what it was:
 * - a prompt is the person's when a run of `user_message_chunk` lines (one prompt's chunks, joined in order) with a
 *   numeric `_meta.promptIndex`, and neither `syntheticPrompt` nor `hideFromScrollback`, has its words, and the first
 *   line after it that names a turn names the hook's `promptId`. Grok 1.0.70 writes an auto-wake prompt (a scheduler
 *   fire's, or a background subagent's or task's result) with an index too, but marks it synthetic and hidden: it, and
 *   anything with no index, drops the prompt. A subagent's session is a log of its own, which is never read here;
 * - a reply is the turn's when the turn is over (`turn_completed`, `end_turn`), its prompt was the person's and was
 *   confirmed, and it has the words of the turn's final agent message (its last run of `agent_message_chunk` lines).
 *   Grok clips a Stop hook's `lastAssistantMessage` at 32,768 characters with a `… [+N chars]` marker: a clip of the
 *   final message counts too. Either way the words recorded are the log's, whole; the hook's only match them. One prompt
 *   and one reply per turn: each confirming line is used once;
 * - not seen yet: the holder waits, until the turn is over plus a grace (src/claude/holder.ts), then drops it and counts it.
 * Field names are Grok 1.0.70's, from real interactive runs: Grok writes the prompt just after UserPromptSubmit returns,
 * tags every line of the turn after it with the turn's id (`params._meta.promptId`; the end's `update.prompt_id`), and
 * writes the turn's end just after Stop.
 *
 * Which log: the session's own, `updates.jsonl` in <Grok's folder>/sessions/<the folder Grok runs in, percent-encoded>/
 * <session id>/ (Grok's folder is its $GROK_HOME, else ~/.grok). Grok writes it by appending, and opens it only to write;
 * it holds the session's events.jsonl open instead, from its start to its end. So SessionStart (src/grok/hooks.ts) takes
 * both folders from the path of the events.jsonl the grok process has open (grokHeldSession), never from the
 * environment (GROK_HOME, HOME) or the hook's input, which the agent's own shell can set. The log is read from
 * SessionStart's place on (the end of what is there: a resumed session's old turns are not read again) through
 * src/agent/appended-lines.ts.
 */

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { AppendedLines, realish, under } from "../agent/appended-lines.ts";
import type { OpenFile } from "../agent/open-files.ts";
import { validSession } from "../claude/paths.ts";

/** A spooled prompt or reply of a Grok turn. */
export interface GrokSaid {
	readonly kind: "prompt" | "reply";
	readonly text: string;
	/** The hook's promptId ("" when it had none: then nothing confirms it). */
	readonly promptId: string;
}

/** What the log says of a spooled prompt or reply: the person's (or their turn's), dropped, or not seen yet. */
export type GrokVerdict = "user" | "drop" | "wait";

/** What the log said of a prompt or reply, which line said it (its identity, for a replay's check), and the log's words. */
export interface GrokConfirmation {
	readonly verdict: GrokVerdict;
	readonly line?: string;
	readonly text?: string;
}

/** Grok's folder: $GROK_HOME, else ~/.grok. */
export function grokHome(env: NodeJS.ProcessEnv, home: string): string {
	return env.GROK_HOME ? resolve(env.GROK_HOME) : join(home, ".grok");
}

/**
 * The name of a folder's sessions folder under Grok's: the folder's absolute path with every byte but letters, digits and
 * `-_.~` percent-encoded (encodeURIComponent, and `!'()*` too: the names Grok 1.0.70 made, live).
 */
export function grokFolder(cwd: string): string {
	return encodeURIComponent(cwd).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Session `sessionId`'s log, for a Grok whose folder is `grokHome`, started in folder `cwd` (as it really is). */
export function grokSessionLog(grokHome: string, cwd: string, sessionId: string): string {
	return join(grokHome, "sessions", grokFolder(cwd), sessionId, "updates.jsonl");
}

/** A session's folder and Grok's folder, as the file Grok has open for the session names them. */
export interface GrokHeld {
	/** <Grok's folder>/sessions/<folder>/<session>. */
	readonly dir: string;
	/** Grok's folder. */
	readonly home: string;
	/** On Linux, the very file Grok has open ("device:inode"). */
	readonly file?: string;
}

/**
 * Session `session`'s folder as the grok process has it open (`open`: its open files, src/agent/open-files.ts): Grok
 * holds each live session's events.jsonl open from its start to its end, so the one whose own path is <Grok's folder>/
 * sessions/<grokFolder(cwd)>/<session>/events.jsonl names both folders. `cwd` is the folder the grok process runs in.
 * Undefined when Grok has none open.
 */
export function grokHeldSession(open: readonly OpenFile[], cwd: string, session: string): GrokHeld | undefined {
	if (!validSession(session)) return undefined;
	for (const held of open) {
		const path = held.path;
		if (!isAbsolute(path) || normalize(path) !== path || basename(path) !== "events.jsonl") continue;
		const dir = dirname(path);
		const sessions = dirname(dirname(dir));
		if (basename(dir) !== session || basename(dirname(dir)) !== grokFolder(cwd) || basename(sessions) !== "sessions") continue;
		return { dir, home: dirname(sessions), ...(held.file === undefined ? {} : { file: held.file }) };
	}
	return undefined;
}

/** Grok's sessions folder, as it really is. */
const sessionsFolder = (home: string) => realish(join(home, "sessions"));

/**
 * `path` when it names session `session`'s log under Grok's folder `home` (sessions/<folder>/<session>/updates.jsonl),
 * links followed as far as they exist; else undefined: not a string, not absolute, `..`, another name, or leading
 * elsewhere.
 */
export function grokLogIn(path: unknown, home: string, session: string): string | undefined {
	if (typeof path !== "string" || !isAbsolute(path) || normalize(path) !== path || !validSession(session)) return undefined;
	if (basename(path) !== "updates.jsonl" || basename(dirname(path)) !== session) return undefined;
	// sessions/<folder>/<session>/updates.jsonl, as the path says it and as it really is.
	if (dirname(dirname(dirname(path))) !== join(resolve(home), "sessions")) return undefined;
	return under(realish(path), sessionsFolder(home)) ? path : undefined;
}

type Line = Record<string, unknown>;
const record = (value: unknown): Line | undefined => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Line) : undefined);

/** The most of a small JSON file of Grok's read (summary.json is about 1 KB). */
const SMALL_MAX = 1024 * 1024;

/** A small regular file's text, read through no link and never waiting on a FIFO; undefined when it can't be. */
function readSmall(path: string): string | undefined {
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch {
		return undefined;
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > SMALL_MAX) return undefined;
		const buffer = Buffer.alloc(stat.size);
		const got = buffer.length === 0 ? 0 : readSync(fd, buffer, 0, buffer.length, 0);
		return buffer.toString("utf8", 0, got);
	} catch {
		return undefined;
	} finally {
		closeSync(fd);
	}
}

/**
 * What the session folder `dir` says it is, by its summary.json: "main" for a person's own session (no `session_kind`),
 * the kind it names otherwise ("subagent"); undefined when it is no session `session`'s (none, unreadable, another id).
 */
export function grokSessionKind(dir: string, session: string): string | undefined {
	const text = readSmall(join(dir, "summary.json"));
	if (text === undefined) return undefined;
	let summary: Line | undefined;
	try {
		summary = record(JSON.parse(text));
	} catch {
		return undefined;
	}
	if (record(summary?.info)?.id !== session) return undefined;
	const kind = summary?.session_kind;
	return kind === undefined || kind === null ? "main" : String(kind);
}

/** The most of a log's end SessionStart reads back for its last line's end. */
const TAIL = 4 * 1024 * 1024;

/**
 * Where a session's log is read from, at its SessionStart: the end of its last whole line, and the file it is
 * ("device:inode"); from its start when Grok hasn't made it yet (a new session). Undefined when it can't be read.
 */
export function grokLogStart(path: string): { readonly offset: number; readonly file?: string } | undefined {
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? { offset: 0 } : undefined;
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) return undefined;
		const file = `${stat.dev}:${stat.ino}`;
		const from = Math.max(0, stat.size - TAIL);
		const buffer = Buffer.alloc(stat.size - from);
		const got = buffer.length === 0 ? 0 : readSync(fd, buffer, 0, buffer.length, from);
		const end = got === 0 ? -1 : buffer.lastIndexOf(10, got - 1);
		// No line ends in what was read: the whole of a short file is one unfinished line; past a long one, its end.
		if (end < 0) return { offset: from === 0 ? 0 : stat.size, file };
		return { offset: from + end + 1, file };
	} catch {
		return undefined;
	} finally {
		closeSync(fd);
	}
}

/** What one log line says, of what the check reads. */
type Say =
	/** One chunk of a prompt: `typed` when it is a prompt the person typed (module doc). */
	| { readonly kind: "user"; readonly index: number | undefined; readonly typed: boolean; readonly text: string }
	/** One of the agent's messages in turn `promptId` (or a part of one). */
	| { readonly kind: "agent"; readonly promptId: string; readonly text: string }
	/** Another line of turn `promptId` (reasoning, a tool call): ends a message, and may be the first line of its turn. */
	| { readonly kind: "other"; readonly promptId: string }
	/** A hook's run in turn `promptId` (Stop, StopCancelled): ends a message, but is no line of the turn's own. */
	| { readonly kind: "hook"; readonly promptId: string }
	/** Turn `promptId`'s end. */
	| { readonly kind: "end"; readonly promptId: string; readonly stopReason: unknown };

/** A content part's text ("" for a part that is no text). */
const textOf = (content: unknown): string => {
	const part = record(content);
	return part?.type === "text" && typeof part.text === "string" ? part.text : "";
};

/** What a log line says, or undefined when it is nothing the check reads. */
function sayOf(text: string): Say | undefined {
	if (!text.includes('"sessionUpdate"')) return undefined;
	let line: Line | undefined;
	try {
		line = record(JSON.parse(text));
	} catch {
		return undefined;
	}
	const params = record(line?.params);
	const update = record(params?.update);
	if (update === undefined) return undefined;
	const kind = update.sessionUpdate;
	if (line?.method === "session/update") {
		if (kind === "user_message_chunk") {
			const meta = record(update._meta);
			const index = meta?.promptIndex;
			const indexed = typeof index === "number" && Number.isSafeInteger(index) && index >= 0 ? index : undefined;
			const typed = indexed !== undefined && meta?.syntheticPrompt !== true && meta?.hideFromScrollback !== true;
			return { kind: "user", index: indexed, typed, text: textOf(update.content) };
		}
		const promptId = record(params?._meta)?.promptId;
		if (typeof promptId !== "string" || promptId === "") return undefined;
		return kind === "agent_message_chunk" ? { kind: "agent", promptId, text: textOf(update.content) } : { kind: "other", promptId };
	}
	if (line?.method === "_x.ai/session/update") {
		const promptId = update.prompt_id;
		if (typeof promptId !== "string" || promptId === "") return undefined;
		if (kind === "turn_completed") return { kind: "end", promptId, stopReason: update.stop_reason };
		// A prompt's hook run comes before the prompt's own line: it names nothing the check needs.
		if (kind === "hook_execution" && update.event_name !== "user_prompt_submit") return { kind: "hook", promptId };
	}
	return undefined;
}

/** A turn, as its lines said it. */
interface Turn {
	/** Where its first line (its prompt's, when it had one) starts in the file. */
	at: number;
	/** Its prompt: the run of user lines just before its first line of its own. */
	prompt?: { readonly text: string; readonly typed: boolean };
	/** Its latest agent message so far, and whether the last line of the turn was a part of it. */
	message?: string;
	inMessage: boolean;
	over: boolean;
	stopReason?: unknown;
	/** When a line of it was last read (a turn over is let go of after a while). */
	readAt: number;
}

/** How long a turn over is kept unused, and how many turns are kept. */
const KEEP_MS = 10 * 60_000;
const TURNS_KEPT = 256;
/** How many recorded lines are remembered against a replay. */
const RECORDED_KEPT = 64;

/** The turns a log's lines said, in order: each prompt's run, matched to the turn that follows it. */
class Turns {
	/** A prompt's run of user lines that no turn's line has followed yet. */
	#pending: { at: number; index: number | undefined; typed: boolean; texts: string[] } | undefined;
	readonly turns = new Map<string, Turn>();

	get pendingAt(): number | undefined {
		return this.#pending?.at;
	}

	/** Takes in a line that starts at byte `at`, read at `now`. */
	take(text: string, at: number, now: number): void {
		const say = sayOf(text);
		if (say === undefined) return;
		if (say.kind === "user") {
			const run = this.#pending;
			if (run !== undefined && run.index === say.index && run.typed === say.typed) run.texts.push(say.text);
			else this.#pending = { at, index: say.index, typed: say.typed, texts: [say.text] };
			return;
		}
		let turn = this.turns.get(say.promptId);
		// A hook's run only ends a message of a turn already read (StopCancelled's can come after the next turn's start).
		if (turn === undefined && say.kind === "hook") return;
		if (turn === undefined) {
			turn = { at, inMessage: false, over: false, readAt: now };
			this.turns.set(say.promptId, turn);
			while (this.turns.size > TURNS_KEPT) this.turns.delete(this.turns.keys().next().value as string);
		}
		// The prompt run just before a turn's first own line is that turn's (a hook's run, which can come late, never claims it).
		const run = this.#pending;
		if (run !== undefined && say.kind !== "hook" && turn.prompt === undefined) {
			turn.prompt = { text: run.texts.join(""), typed: run.typed };
			turn.at = Math.min(turn.at, run.at);
			this.#pending = undefined;
		}
		turn.readAt = now;
		if (say.kind === "agent") {
			turn.message = turn.inMessage ? `${turn.message ?? ""}${say.text}` : say.text;
			turn.inMessage = true;
		} else turn.inMessage = false;
		if (say.kind === "end") {
			turn.over = true;
			turn.stopReason = say.stopReason;
		}
	}

	/** Lets go of turns over and unread for KEEP_MS. */
	prune(now: number): void {
		for (const [promptId, turn] of this.turns) if (turn.over && now - turn.readAt >= KEEP_MS) this.turns.delete(promptId);
	}
}

/** Whether `hook`, a hook's words, are `log`'s: the same, or Grok's clip of them (… [+N chars]). */
function matches(hook: string, log: string): boolean {
	if (hook === log) return true;
	const clip = /^([\s\S]*)(?:…|\.\.\.) ?\[\+\d+ chars?\]$/.exec(hook);
	return clip !== null && log.length > (clip[1] as string).length && log.startsWith(clip[1] as string);
}

/** A turn's lines' identities: its prompt's and its reply's. */
const promptLine = (promptId: string) => `${promptId}/prompt`;
const replyLine = (promptId: string) => `${promptId}/reply`;

/**
 * The verdict on `said` from `turns`. `used`: whether a line confirmed something already; `promptTaken`: whether a turn's
 * prompt was confirmed as the person's (a reply's needs it).
 */
function verdictIn(turns: Turns, said: GrokSaid, used: (line: string) => boolean, promptTaken: (line: string) => boolean): GrokConfirmation {
	const turn = said.promptId === "" ? undefined : turns.turns.get(said.promptId);
	if (turn === undefined) return { verdict: "wait" };
	if (said.kind === "prompt") {
		if (turn.prompt === undefined) return { verdict: turn.over ? "drop" : "wait" };
		const line = promptLine(said.promptId);
		if (!turn.prompt.typed || used(line) || !matches(said.text, turn.prompt.text)) return { verdict: "drop" };
		return { verdict: "user", line, text: turn.prompt.text };
	}
	if (!turn.over) return { verdict: "wait" };
	const line = replyLine(said.promptId);
	const theirs = turn.prompt?.typed === true && promptTaken(promptLine(said.promptId)) && turn.stopReason === "end_turn";
	if (!theirs || turn.message === undefined || used(line) || !matches(said.text, turn.message)) return { verdict: "drop" };
	return { verdict: "user", line, text: turn.message };
}

/** What Grok's session-log `lines` say a spooled prompt or reply was (module doc); a reply's prompt is taken as confirmed. */
export function confirmGrok(lines: readonly string[], said: GrokSaid): GrokVerdict {
	const turns = new Turns();
	let at = 0;
	for (const line of lines) {
		turns.take(line, at, 0);
		at += Buffer.byteLength(line) + 1;
	}
	return verdictIn(turns, said, () => false, () => true).verdict;
}

/** Where a session's log is read from, and what its reader recorded (GrokLogReader's state, kept in memory meta). */
export interface GrokLogMark {
	readonly path: string;
	/** Grok's folder the path was checked against. */
	readonly home: string;
	/** The byte the next read starts at: a line's start. */
	readonly offset: number;
	/** The lines that confirmed what was recorded lately (GrokLogReader.remember), so nothing is recorded twice. */
	readonly recorded?: readonly string[];
	/** The file the log was at SessionStart ("device:inode"): another file at the path is never read. */
	readonly file?: string;
}

/** A GrokLogMark from memory meta, or undefined when it is no mark. */
export function parseGrokLogMark(text: string | undefined): GrokLogMark | undefined {
	if (text === undefined) return undefined;
	try {
		const value = record(JSON.parse(text));
		if (value === undefined || typeof value.path !== "string" || typeof value.home !== "string") return undefined;
		const offset = value.offset;
		if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) return undefined;
		const recorded = Array.isArray(value.recorded) ? value.recorded.filter((key): key is string => typeof key === "string") : [];
		return { path: value.path, home: value.home, offset, recorded, ...(typeof value.file === "string" ? { file: value.file } : {}) };
	} catch {
		return undefined;
	}
}

/** A confirming line's key in memory meta: a digest of its identity. */
const lineKey = (line: string) => createHash("sha256").update(line).digest("hex").slice(0, 32);

/**
 * One session's log, read as Grok appends to it: only bytes from its place on, a whole line at a time, keeping its turns
 * until they are confirmed or old.
 */
export class GrokLogReader {
	readonly path: string;
	readonly home: string;
	readonly #lines: AppendedLines;
	readonly #turns = new Turns();
	/** The lines this reader confirmed something by: each confirms one prompt or reply. */
	readonly #used = new Set<string>();
	readonly #recorded: string[];

	constructor(mark: GrokLogMark) {
		this.path = mark.path;
		this.home = mark.home;
		this.#lines = new AppendedLines(mark, (opened) => under(opened, sessionsFolder(this.home)));
		this.#recorded = [...(mark.recorded ?? [])];
	}

	/**
	 * Reads what was appended since the last read. A log that isn't there, or can't be read now, is read later. `keep`: an
	 * earlier event of the session waits, so no turn read is let go for its age.
	 */
	read(now = Date.now(), keep = false): void {
		this.#lines.read((text, at) => this.#turns.take(text, at, now));
		if (!keep) this.#turns.prune(now);
	}

	/** What the lines read so far say of `said`, which line confirmed it, and the log's words; that line is used up. */
	confirm(said: GrokSaid): GrokConfirmation {
		const confirmed = verdictIn(
			this.#turns,
			said,
			(line) => this.#used.has(line),
			(line) => this.#used.has(line) || this.recordedBefore(line),
		);
		if (confirmed.verdict === "user" && confirmed.line !== undefined) this.#used.add(confirmed.line);
		return confirmed;
	}

	/** Whether what `line` says was recorded before: a restarted reader reads a turn it kept again. */
	recordedBefore(line: string): boolean {
		return this.#recorded.includes(lineKey(line));
	}

	/** Remembers that what `line` says was recorded. */
	remember(line: string): void {
		this.#recorded.push(lineKey(line));
		this.#recorded.splice(0, Math.max(0, this.#recorded.length - RECORDED_KEPT));
	}

	/**
	 * Where a reader started afresh picks up without losing a turn this one still keeps: a prompt run no turn followed yet,
	 * a turn still running, or one whose prompt or reply may still be confirmed.
	 */
	mark(): GrokLogMark {
		const open = (promptId: string, turn: Turn) => {
			if (!turn.over) return true;
			if (turn.prompt?.typed !== true) return false;
			const prompt = promptLine(promptId);
			if (!this.#used.has(prompt) && !this.recordedBefore(prompt)) return true;
			const reply = replyLine(promptId);
			return turn.stopReason === "end_turn" && turn.message !== undefined && !this.#used.has(reply) && !this.recordedBefore(reply);
		};
		const starts = [...this.#turns.turns].filter(([promptId, turn]) => open(promptId, turn)).map(([, turn]) => turn.at);
		const offset = Math.min(this.#lines.offset, this.#turns.pendingAt ?? Number.POSITIVE_INFINITY, ...starts);
		const file = this.#lines.file;
		return { path: this.path, home: this.home, offset, recorded: [...this.#recorded], ...(file === undefined ? {} : { file }) };
	}
}
