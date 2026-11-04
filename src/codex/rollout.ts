/**
 * Confirming Codex's prompts and replies against its rollout (spec 2026-10-18-agent-permissions §3c). Codex runs its
 * hooks through a pipe, so the agent's own shell can pipe made-up input into Orrery's hook command and no caller check
 * tells them apart; Codex's own record of the session, its rollout, is the proof. A prompt or reply the hooks spooled is
 * held until the rollout says what it was:
 * - a prompt is the user's when an `event_msg` `item_completed` of `item.type` "UserMessage" has the hook's `turn_id`
 *   and the same words, in a turn whose `task_started` says `turn_attribution.turn_trigger` "user" (the TUI) or "exec"
 *   (`codex exec`) and names no parent turn or initiating agent. Another trigger (a guardian's review, `codex queue`'s
 *   "queue" from outside the session), a spawned agent's turn, or a turn whose start names no one (Codex before
 *   0.162.1, whose sessions SessionStart refuses) drops it; a `response_item` of role user proves nothing (the
 *   environment context is one too);
 * - a reply is the turn's when an `item_completed` "AgentMessage" of that person's turn has those words (a turn's Stop
 *   can come more than once: a spawned agent's report wakes the turn again), or its `task_complete` `last_agent_message`
 *   does when no agent message of the turn did; each line confirms one reply, so a made-up Stop can only repeat words
 *   the agent said in that turn, and only words no reply took yet. Once the turn is over, other words drop it;
 * - not seen yet: the holder waits, until the turn is over plus a grace (src/claude/holder.ts), then drops it and counts it.
 * Field names are Codex 0.163.0's, from real `codex exec` and TUI runs. Codex writes the user's message about 50 ms
 * after UserPromptSubmit and the turn's end just after Stop.
 *
 * Which rollout: the session's, found by its id under Codex's own folder ($CODEX_HOME, else ~/.codex: sessions/YYYY/MM/
 * DD/, then archived_sessions/), never where the hook's input says. SessionStart takes a session as this Codex's only
 * when its `session_meta` says it is a person's own thread (`thread_source` "user": a spawned agent's says "subagent")
 * and the Codex process holds that very file open (Linux: /proc/<pid>/fd, by device and inode; macOS: lsof, by path),
 * so a hook call made by any other process (the agent's shell, or another tool's) can't name a session: Codex keeps
 * each session's rollout open from its SessionStart to its end. SessionStart then says where to read from: the end of
 * what is there, but the start of a turn still running (Codex starts the turn before it runs SessionStart: at startup,
 * /clear, /resume, /fork, `codex resume` and `codex fork` alike, 0.163.0).
 *
 * The rollout is read only from that place on, a whole line at a time, through no link at its own place and never once
 * it leads out of Codex's folder (on Linux, judged by the file opened). Codex only appends to the file it holds: another
 * file at the path, or this one shorter, is not read at all. Only the lines that could confirm something are kept, for a
 * while (all of them while an earlier event of the session waits); each confirms one prompt or reply, and one recorded
 * before (by its turn and line: a resume or a fork reads history again) is not recorded again.
 *
 * Under Codex's workspace-write sandbox the shell can't write the rollout; with full access a deliberate forger who
 * writes it can still fake a turn (the design's Limits).
 */

import { createHash } from "node:crypto";
import { closeSync, constants, type Dirent, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { basename, isAbsolute, join, normalize, resolve } from "node:path";
import { AppendedLines, realish, under } from "../agent/appended-lines.ts";

/** A spooled prompt or reply of a Codex turn. */
export interface CodexSaid {
	readonly kind: "prompt" | "reply";
	/** The hook's turn_id ("" when it had none: then nothing confirms it). */
	readonly turnId: string;
	readonly text: string;
}

/** What the rollout says of a spooled prompt or reply: the user's (or the turn's), dropped, or not seen yet. */
export type CodexVerdict = "user" | "drop" | "wait";

/** The turn triggers of a person's own turn: typed in the TUI, or given to `codex exec`. */
const PERSON: ReadonlySet<unknown> = new Set(["user", "exec"]);

/** Where Codex keeps rollouts in its folder: the live ones, then those archived. */
const FOLDERS = ["sessions", "archived_sessions"] as const;

/** A Codex session id: a UUID. Part of one would name the rollout of the session it ends. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A rollout's file name: rollout-<local time>-<session id>.jsonl. */
const ROLLOUT_NAME = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f-]{36})\.jsonl$/i;

type Line = Record<string, unknown>;
const record = (value: unknown): Line | undefined => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Line) : undefined);

/**
 * The trigger of a turn another agent started (`turn_attribution.parent_turn_id` or `initiating_agent_path` set): a
 * spawned agent's turns say "exec" or "user" too (0.163.0: "exec"), so they are told by their parent, not their trigger.
 */
const SPAWNED = Symbol("spawned");
/** The trigger of a turn whose start says nothing of who started it (Codex before 0.162.1): never the person's, as known. */
const UNATTRIBUTED = Symbol("unattributed");

/** The oldest Codex that says who started a turn (`task_started.turn_attribution`): 0.153.4 to 0.161.0 don't. */
export const MIN_CODEX = "0.162.1";

/** Whether Codex `version` ("0.161.0", "0.163.0-alpha.1") says who started a turn; undefined when it is no version. */
export function attributesTurns(version: unknown): boolean | undefined {
	const parts = typeof version === "string" ? /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim())?.slice(1).map(Number) : undefined;
	if (parts === undefined) return undefined;
	const least = MIN_CODEX.split(".").map(Number);
	for (const [index, part] of parts.entries()) if (part !== least[index]) return part > (least[index] as number);
	return true;
}

/** What one rollout line says, of what the check reads. */
type Said =
	| { readonly kind: "start"; readonly turnId: string; readonly trigger: unknown }
	| { readonly kind: "user"; readonly turnId: string; readonly id: string; readonly words: readonly string[] }
	| { readonly kind: "agent"; readonly turnId: string; readonly id: string; readonly text: string }
	| { readonly kind: "final"; readonly turnId: string; readonly text: string | undefined }
	| { readonly kind: "aborted"; readonly turnId: string };

/** A user message's words: its text parts joined by a newline, or by nothing (how Codex joins them for its hook isn't known). */
function wordsOf(content: unknown): string[] | undefined {
	if (!Array.isArray(content)) return undefined;
	const texts = content.map(record).filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part?.text as string);
	if (texts.length === 0) return undefined;
	return texts.length === 1 ? texts : [texts.join("\n"), texts.join("")];
}

/** What a rollout line says: a turn's start, a user's message, a turn's end, or nothing the check reads. */
function sayOf(text: string): Said | undefined {
	if (!text.includes('"event_msg"')) return undefined;
	let line: Line | undefined;
	try {
		line = record(JSON.parse(text));
	} catch {
		return undefined;
	}
	const payload = record(line?.payload);
	if (line?.type !== "event_msg" || payload === undefined) return undefined;
	if (payload.type === "task_started") {
		const attribution = record(payload.turn_attribution);
		// An older Codex's start: the turn is known, who started it isn't.
		if (attribution === undefined) return typeof payload.turn_id === "string" ? { kind: "start", turnId: payload.turn_id, trigger: UNATTRIBUTED } : undefined;
		const turnId = attribution.turn_id;
		if (typeof turnId !== "string" || (payload.turn_id !== undefined && payload.turn_id !== turnId)) return undefined;
		const spawned = (attribution?.parent_turn_id ?? null) !== null || (attribution?.initiating_agent_path ?? null) !== null;
		return { kind: "start", turnId, trigger: spawned ? SPAWNED : attribution?.turn_trigger };
	}
	if (typeof payload.turn_id !== "string") return undefined;
	if (payload.type === "item_completed") {
		const item = record(payload.item);
		const id = typeof item?.id === "string" ? item.id : "";
		if (item?.type === "AgentMessage") {
			// The agent's words: its text parts ("Text", 0.163.0), joined.
			const texts = Array.isArray(item.content) ? item.content.map(record).filter((part) => (part?.type === "Text" || part?.type === "text") && typeof part.text === "string") : [];
			return texts.length === 0 ? undefined : { kind: "agent", turnId: payload.turn_id, id, text: texts.map((part) => part?.text as string).join("") };
		}
		const words = item?.type === "UserMessage" ? wordsOf(item.content) : undefined;
		return words === undefined ? undefined : { kind: "user", turnId: payload.turn_id, id, words };
	}
	if (payload.type === "task_complete") return { kind: "final", turnId: payload.turn_id, text: typeof payload.last_agent_message === "string" ? payload.last_agent_message : undefined };
	if (payload.type === "turn_aborted") return { kind: "aborted", turnId: payload.turn_id };
	return undefined;
}

/**
 * The verdict on `said` from what lines said (those not used yet), with the index of the line that confirmed it.
 * `triggerOf` says a turn's trigger (undefined: its start unseen); `overOf` whether the turn is over.
 */
function verdictIn(says: readonly (Said | undefined)[], said: CodexSaid, triggerOf: (turnId: string) => unknown, overOf: (turnId: string) => boolean): { verdict: CodexVerdict; index?: number } {
	if (said.turnId === "") return { verdict: "wait" };
	const trigger = triggerOf(said.turnId);
	// A turn not the person's: nothing of it is theirs, nor a reply to them.
	if (trigger !== undefined && !PERSON.has(trigger)) return { verdict: "drop" };
	for (const [index, say] of says.entries()) {
		if (say === undefined || say.turnId !== said.turnId) continue;
		const confirms = said.kind === "prompt" ? say.kind === "user" && say.words.includes(said.text) : (say.kind === "agent" || say.kind === "final") && say.text === said.text;
		if (confirms) return trigger === undefined ? { verdict: "wait" } : { verdict: "user", index };
	}
	// A reply to a turn that is over, in words the agent didn't say in it (or that a reply took already).
	return { verdict: said.kind === "reply" && overOf(said.turnId) ? "drop" : "wait" };
}

/** What Codex's rollout `lines` say a spooled prompt or reply of a turn was (module doc). */
export function confirmCodex(lines: readonly string[], said: CodexSaid): CodexVerdict {
	const says = lines.map(sayOf);
	const triggers = new Map<string, unknown>();
	const over = new Set<string>();
	for (const say of says) {
		if (say?.kind === "start") triggers.set(say.turnId, say.trigger);
		if (say?.kind === "final" || say?.kind === "aborted") over.add(say.turnId);
	}
	return verdictIn(says, said, (turnId) => (triggers.has(turnId) ? (triggers.get(turnId) ?? null) : undefined), (turnId) => over.has(turnId)).verdict;
}

/** Codex's folder: $CODEX_HOME, else ~/.codex. */
export function codexHome(env: NodeJS.ProcessEnv, home: string): string {
	return env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(home, ".codex");
}

/** The real folders of `home` where rollouts are. */
const rolloutFolders = (home: string) => FOLDERS.map((folder) => realish(join(home, folder)));

/**
 * `path` when it names session `session`'s rollout under Codex's folder `home` (sessions or archived_sessions), links
 * followed as far as they exist; else undefined: not a string, not absolute, `..`, another name, or leading elsewhere.
 */
export function rolloutIn(path: unknown, home: string, session: string): string | undefined {
	if (typeof path !== "string" || !isAbsolute(path) || normalize(path) !== path) return undefined;
	if (ROLLOUT_NAME.exec(basename(path))?.[1]?.toLowerCase() !== session.toLowerCase() || !SESSION_ID.test(session)) return undefined;
	const real = realish(path);
	return rolloutFolders(home).some((folder) => under(real, folder)) ? path : undefined;
}

/** The most folders deep a rollout sits: sessions/YYYY/MM/DD. */
const DEPTH = 3;

/** A file named `name` under `dir`, newest folders first, passing over links; undefined when there is none. */
function search(dir: string, name: (file: string) => boolean, depth: number): string | undefined {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return undefined;
	}
	const sorted = [...entries].sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
	for (const entry of sorted) if (entry.isFile() && name(entry.name)) return join(dir, entry.name);
	if (depth === 0) return undefined;
	for (const entry of sorted) {
		if (!entry.isDirectory()) continue;
		const found = search(join(dir, entry.name), name, depth - 1);
		if (found !== undefined) return found;
	}
	return undefined;
}

/**
 * Session `session`'s rollout under Codex's folder `home` (sessions/, then archived_sessions/), by the session id that
 * ends its name; never through a link. Undefined for no rollout, or an id that is no Codex session id.
 */
export function findRollout(home: string, session: string): string | undefined {
	if (!SESSION_ID.test(session)) return undefined;
	const named = (file: string) => ROLLOUT_NAME.exec(file)?.[1]?.toLowerCase() === session.toLowerCase();
	for (const folder of FOLDERS) {
		const found = search(join(home, folder), named, DEPTH);
		if (found !== undefined) return rolloutIn(found, home, session);
	}
	return undefined;
}

/**
 * A rollout's first line, its `session_meta`: the session it records, the kind of thread ("user": a person's own), and
 * the Codex that wrote it (`cli_version`, there since 0.153.4 at least).
 */
export interface RolloutThread {
	readonly id: unknown;
	readonly threadSource: unknown;
	readonly version: unknown;
}

/** The most of a rollout's first line read (its session_meta holds the session's instructions: some 20 KB). */
const META_MAX = 1024 * 1024;

/** What a rollout's `session_meta` says, or undefined when its first line is none (or can't be read). */
export function rolloutThread(path: string): RolloutThread | undefined {
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch {
		return undefined;
	}
	try {
		const buffer = Buffer.alloc(Math.min(META_MAX, fstatSync(fd).size));
		const got = buffer.length === 0 ? 0 : readSync(fd, buffer, 0, buffer.length, 0);
		const end = buffer.subarray(0, got).indexOf(10);
		if (end < 0) return undefined;
		const line = record(JSON.parse(buffer.toString("utf8", 0, end)));
		const payload = record(line?.payload);
		if (line?.type !== "session_meta" || payload === undefined) return undefined;
		return { id: payload.id, threadSource: payload.thread_source, version: payload.cli_version };
	} catch {
		return undefined;
	} finally {
		closeSync(fd);
	}
}

/** The most of a rollout's end SessionStart reads back for a turn still running. */
const TAIL = 4 * 1024 * 1024;

/**
 * Where a session's rollout is read from, at its SessionStart: the start of a turn still running (its `task_started`,
 * with no end after it; `running`, and `attributed`: whether that start says who started the turn), else the end of
 * its last whole line. Undefined when it can't be read.
 */
export function readerStart(path: string): { readonly offset: number; readonly running: boolean; readonly attributed?: boolean } | undefined {
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch {
		return undefined;
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) return undefined;
		const from = Math.max(0, stat.size - TAIL);
		const buffer = Buffer.alloc(stat.size - from);
		const got = buffer.length === 0 ? 0 : readSync(fd, buffer, 0, buffer.length, from);
		const end = buffer.lastIndexOf(10, got - 1);
		if (end < 0) return { offset: from === 0 ? 0 : stat.size, running: false };
		// Whole lines only: the first one is cut unless the read began at the file's start.
		const first = from === 0 ? 0 : buffer.indexOf(10) + 1;
		let stop = end;
		while (stop > first) {
			const start = buffer.lastIndexOf(10, stop - 1) + 1;
			const say = sayOf(buffer.toString("utf8", Math.max(start, first), stop));
			if (say?.kind === "final" || say?.kind === "aborted") break;
			if (say?.kind === "start") return { offset: from + Math.max(start, first), running: true, attributed: say.trigger !== UNATTRIBUTED };
			stop = start - 1;
		}
		return { offset: from + end + 1, running: false };
	} catch {
		return undefined;
	} finally {
		closeSync(fd);
	}
}

/** Where a session's rollout is read from, and what its reader recorded (RolloutReader's state, kept in memory meta). */
export interface RolloutMark {
	readonly path: string;
	/** Codex's folder the path was checked against. */
	readonly home: string;
	/** The byte the next read starts at: a line's start. */
	readonly offset: number;
	/** The lines that confirmed what was recorded lately (RolloutReader.remember), so a replay is recorded once. */
	readonly recorded?: readonly string[];
	/** The file Codex held open at SessionStart ("device:inode"): another file at the path is never read. */
	readonly file?: string;
}

/** A RolloutMark from memory meta, or undefined when it is no mark. */
export function parseRolloutMark(text: string | undefined): RolloutMark | undefined {
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

/** How long a line that could confirm something is kept unused, and how many are kept. */
const KEEP_MS = 10 * 60_000;
const KEEP_LINES = 1000;
/** How many turns' triggers are kept, and how many recorded lines are remembered against a replay. */
const TURNS_KEPT = 256;
const RECORDED_KEPT = 64;

interface Kept {
	readonly say: Exclude<Said, { kind: "start" | "aborted" }>;
	/** The line's identity: its turn, and its item's id, else where it starts in the file. */
	readonly id: string;
	/** Where the line starts in the file. */
	readonly at: number;
	readonly readAt: number;
}

/** What the rollout said of a prompt or reply, and which line said it (its identity, for a replay's check). */
export interface CodexConfirmation {
	readonly verdict: CodexVerdict;
	readonly line?: string;
}

/**
 * One session's rollout, read as Codex appends to it: only bytes from its place on, a whole line at a time, keeping the
 * turns' triggers and the lines that could confirm a prompt or reply until one does or they are old.
 */
export class RolloutReader {
	readonly path: string;
	readonly home: string;
	/** The rollout as read so far: its place, and the file Codex holds ("device:inode"; the first one read when SessionStart didn't say). */
	readonly #lines: AppendedLines;
	#kept: Kept[] = [];
	/** Each turn's trigger, and where its start line is. */
	#turns = new Map<string, { readonly trigger: unknown; readonly at: number }>();
	/** The turns seen over (ended or aborted), and the words of each turn's agent messages (its final one says them again). */
	readonly #over = new Set<string>();
	readonly #agentSaid = new Map<string, Set<string>>();
	/** Where the start line of a turn still running is (a reader restarted from the mark reads it again). */
	#running: number | undefined;
	readonly #recorded: string[];

	constructor(mark: RolloutMark) {
		this.path = mark.path;
		this.home = mark.home;
		this.#lines = new AppendedLines(mark, (opened) => rolloutFolders(this.home).some((folder) => under(opened, folder)));
		this.#recorded = [...(mark.recorded ?? [])];
	}

	/**
	 * Reads what was appended since the last read. A file that isn't there, or can't be read now, is read later. `keep`:
	 * an earlier event of the session waits, so no line read is let go for its age.
	 */
	read(now = Date.now(), keep = false): void {
		this.#lines.read((text, at) => this.#keep(text, at, now));
		const fresh = keep ? this.#kept : this.#kept.filter((kept) => now - kept.readAt < KEEP_MS);
		this.#kept = fresh.slice(-KEEP_LINES);
	}

	/** Takes in a line: a turn's start or end, or a line that could confirm a prompt or reply. */
	#keep(text: string, at: number, now: number): void {
		const say = sayOf(text);
		if (say === undefined) return;
		if (say.kind === "start") {
			this.#turns.set(say.turnId, { trigger: say.trigger, at });
			while (this.#turns.size > TURNS_KEPT) this.#turns.delete(this.#turns.keys().next().value as string);
			this.#running = at;
			return;
		}
		if (say.kind === "final" || say.kind === "aborted") {
			const turn = this.#turns.get(say.turnId);
			if (turn !== undefined && turn.at === this.#running) this.#running = undefined;
			this.#over.add(say.turnId);
			while (this.#over.size > TURNS_KEPT) this.#over.delete(this.#over.values().next().value as string);
			// The final message is the turn's last agent message again: one line, not a second one for the same words.
			if (say.kind === "aborted" || say.text === undefined || this.#agentSaid.get(say.turnId)?.has(say.text) === true) return;
			this.#kept.push({ say, id: `${say.turnId}/final`, at, readAt: now });
			return;
		}
		if (say.kind === "agent") {
			const said = this.#agentSaid.get(say.turnId) ?? new Set<string>();
			said.add(say.text);
			this.#agentSaid.set(say.turnId, said);
			while (this.#agentSaid.size > TURNS_KEPT) this.#agentSaid.delete(this.#agentSaid.keys().next().value as string);
		}
		this.#kept.push({ say, id: `${say.turnId}/${say.id === "" ? `at:${at}` : say.id}`, at, readAt: now });
	}

	/** What the lines read so far say of `said`, and which line confirmed it; that line is used up (one that drops it isn't). */
	confirm(said: CodexSaid): CodexConfirmation {
		const { verdict, index } = verdictIn(
			this.#kept.map((kept) => kept.say),
			said,
			(turnId) => {
				const turn = this.#turns.get(turnId);
				return turn === undefined ? undefined : (turn.trigger ?? null);
			},
			(turnId) => this.#over.has(turnId),
		);
		if (index === undefined || verdict !== "user") return { verdict };
		const [kept] = this.#kept.splice(index, 1);
		return { verdict, ...(kept === undefined ? {} : { line: kept.id }) };
	}

	/** Whether what `line` says was recorded before: a resume or a fork reads history again, ids and all. */
	recordedBefore(line: string): boolean {
		return this.#recorded.includes(lineKey(line));
	}

	/** Remembers that what `line` says was recorded. */
	remember(line: string): void {
		this.#recorded.push(lineKey(line));
		this.#recorded.splice(0, Math.max(0, this.#recorded.length - RECORDED_KEPT));
	}

	/**
	 * Where a reader started afresh picks up without losing a line this one still keeps, nor the start of a turn it may
	 * still need (a running one's, or a kept line's).
	 */
	mark(): RolloutMark {
		const starts = this.#kept.map((kept) => Math.min(kept.at, this.#turns.get(kept.say.turnId)?.at ?? kept.at));
		const offset = Math.min(this.#lines.offset, this.#running ?? Number.POSITIVE_INFINITY, ...starts);
		const file = this.#lines.file;
		return { path: this.path, home: this.home, offset, recorded: [...this.#recorded], ...(file === undefined ? {} : { file }) };
	}
}

/** A confirming line's key in memory meta: a digest of its identity. */
const lineKey = (line: string) => createHash("sha256").update(line).digest("hex").slice(0, 32);
