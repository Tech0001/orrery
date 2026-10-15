/**
 * The chats a person can turn into an agent (spec 2026-10-13-orrery-agents-design §6): every Claude Code chat
 * (<claude>/projects/<project>/<session>.jsonl) and Codex chat (<codex>/sessions/**\/rollout-*.jsonl and
 * <codex>/archived_sessions/), newest first. A row comes from the file's head and tail only: the head is read in
 * CHUNK_BYTES steps and stops once the row has what it needs (at most HEAD_BYTES, or the whole first line up to
 * FIRST_LINE_BYTES: a Codex session_meta can carry long instructions), and the tail is TAIL_BYTES. Claude Code appends a
 * chat's titles as it names it and again at its end. So a folder of very large chats lists in about a second. Nothing
 * is written.
 */

import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promptText } from "./claude.ts";
import { itemText } from "./codex.ts";

export type ChatTool = "claude-code" | "codex";

export interface Chat {
	readonly tool: ChatTool;
	/** The chat's file, absolute: what the importer reads. */
	readonly file: string;
	/** Claude Code's session id, or Codex's thread id. */
	readonly id: string;
	/** Safe to show: no control or bidi characters. UNTITLED when the chat names nothing usable. */
	readonly title: string;
	/** The folder the chat ran in, when the file says: the real path, for opening. Show it through `folderLabel`. */
	readonly folder?: string;
	/** When the file was last written (ms). */
	readonly lastActive: number;
	readonly size: number;
	/** Written in the last IN_USE_MS: an import is a snapshot, and anything said after it is not in the agent. */
	readonly inUse: boolean;
}

export interface ChatList {
	readonly chats: Chat[];
	/** Bytes read to make the list. */
	readonly bytesRead: number;
}

export const IN_USE_MS = 10 * 60 * 1000;
export const HEAD_BYTES = 256 * 1024;
export const TAIL_BYTES = 64 * 1024;
export const FIRST_LINE_BYTES = 4 * 1024 * 1024;
/** How much of the end of Codex's session_index.jsonl is read; later lines win, so the newest names are kept. */
const INDEX_BYTES = 4 * 1024 * 1024;
const CHUNK_BYTES = 32 * 1024;
const TITLE_CHARS = 80;
/** A chat with no usable title (none, or blank once made safe to show) is listed under this, never left out. */
export const UNTITLED = "(untitled)";

interface Counter {
	bytes: number;
}

function readRange(fd: number, start: number, length: number, counter: Counter): Buffer {
	const buffer = Buffer.alloc(length);
	let done = 0;
	while (done < length) {
		const read = readSync(fd, buffer, done, length - done, start + done);
		if (read === 0) break;
		done += read;
	}
	counter.bytes += done;
	return buffer.subarray(0, done);
}

/**
 * Feeds the file's first whole lines (blank ones skipped) to `onLine`, reading a chunk at a time, until it returns true
 * or the head is used up: HEAD_BYTES past the end of the first line (which may itself run to FIRST_LINE_BYTES). A file
 * within HEAD_BYTES is read through to its end, so its last line counts too.
 */
function scanHead(fd: number, size: number, counter: Counter, onLine: (line: string) => boolean): void {
	let offset = 0;
	let pending = Buffer.alloc(0);
	let limit = FIRST_LINE_BYTES;
	let sawLine = false;
	let consumed = 0;
	while (offset < size) {
		if (offset >= limit) return;
		const chunk = readRange(fd, offset, Math.min(CHUNK_BYTES, size - offset, limit - offset), counter);
		if (chunk.length === 0) return;
		offset += chunk.length;
		pending = Buffer.concat([pending, chunk]);
		let newline = pending.indexOf(10);
		while (newline !== -1) {
			if (!sawLine) limit = Math.min(size, consumed + newline + 1 + HEAD_BYTES); // HEAD_BYTES more after the first line
			sawLine = true;
			const line = pending.subarray(0, newline).toString("utf8");
			consumed += newline + 1;
			pending = pending.subarray(newline + 1);
			if (line.trim() !== "" && onLine(line)) return;
			newline = pending.indexOf(10);
		}
	}
	if (pending.length > 0 && offset >= size) {
		const line = pending.toString("utf8");
		if (line.trim() !== "") onLine(line);
	}
}

/** The file's last whole lines: TAIL_BYTES of it, or none when the head already covered the whole file. */
function tail(fd: number, size: number, counter: Counter): string[] {
	if (size <= HEAD_BYTES) return [];
	const start = Math.max(0, size - TAIL_BYTES);
	const lines = readRange(fd, start, size - start, counter).toString("utf8").split("\n");
	lines.shift(); // the first piece may be cut
	return lines.filter((line) => line.trim() !== "");
}

function parse(line: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(line);
		return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

const words = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value : undefined);

/** Control characters (C0, DEL, C1), bidi controls and line/paragraph separators: nothing a terminal should be sent from a file. */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/g;

/** Text safe to show: whitespace becomes spaces, then control and bidi characters go. */
export function displayText(text: string): string {
	return text.replace(/\s+/g, " ").replace(UNSAFE, "").trim();
}

/** A displayed title from text: its first non-blank line, made safe to show, cut to fit on a code-point boundary. */
export function titleLine(text: string): string {
	const first = displayText(text.split("\n").find((line) => displayText(line) !== "") ?? "");
	const points = Array.from(first);
	return points.length > TITLE_CHARS ? `${points.slice(0, TITLE_CHARS - 1).join("")}…` : first;
}

/** The list's title: the first that is there, as titleLine shows it, else UNTITLED. */
const rowTitle = (title: string | undefined): string => (title === undefined ? "" : titleLine(title)) || UNTITLED;

/** A folder as the list shows it: "~/…" under the home, made safe to show. `Chat.folder` stays the real path, for opening. */
export function folderLabel(folder: string, home: string): string {
	if (folder === home) return "~";
	return displayText(folder.startsWith(`${home}/`) ? `~${folder.slice(home.length)}` : folder);
}

/** Whether every word of `filter` is in the chat's title or its folder (as the list shows it). */
export function chatMatches(chat: Chat, filter: string, home: string): boolean {
	const haystack = `${chat.title} ${chat.folder === undefined ? "" : folderLabel(chat.folder, home)}`.toLowerCase();
	return filter.toLowerCase().split(/\s+/).filter(Boolean).every((word) => haystack.includes(word));
}

/** Context Codex injects ahead of a person's words: not a first message. */
const INJECTED = ["<environment_context>", "<user_instructions>", "<INSTRUCTIONS>", "# AGENTS.md", "<subagent_notification>", "<turn_aborted>", "<permissions instructions>"];
const injected = (text: string | undefined): boolean => text !== undefined && INJECTED.some((prefix) => text.trimStart().startsWith(prefix));

const TITLE_MARKERS = ['"custom-title"', '"ai-title"', '"summary"'];

function claudeChat(file: string, fd: number, size: number, mtime: number, now: number, counter: Counter): Chat | undefined {
	let id = basename(file, ".jsonl");
	let folder: string | undefined;
	let prompt: string | undefined;
	// The last title of each kind wins; a custom title beats an AI one, which beats an old-style summary.
	let custom: string | undefined;
	let ai: string | undefined;
	let summary: string | undefined;
	// A file with no record at all is no chat; any record makes it one, listed even when it names nothing.
	let records = false;
	const titles = (line: string): void => {
		if (!TITLE_MARKERS.some((marker) => line.includes(marker))) return;
		const record = parse(line);
		if (record !== undefined) records = true;
		if (record?.type === "custom-title") custom = words(record.customTitle) ?? custom;
		else if (record?.type === "ai-title") ai = words(record.aiTitle) ?? ai;
		else if (record?.type === "summary") summary = words(record.summary) ?? summary;
	};
	// A file within the head is read through, so its titles are found here; a larger one is read until it names a
	// folder and a first prompt, and its titles come from the tail.
	const whole = size <= HEAD_BYTES;
	scanHead(fd, size, counter, (line) => {
		titles(line);
		const record = parse(line);
		if (record === undefined) return false;
		records = true;
		if (typeof record.sessionId === "string") id = record.sessionId;
		folder ??= words(record.cwd);
		if (prompt === undefined && record.type === "user" && record.isMeta !== true && record.isSidechain !== true && record.isCompactSummary !== true) {
			prompt = promptText((record.message as { content?: unknown } | undefined)?.content);
		}
		return !whole && folder !== undefined && prompt !== undefined;
	});
	for (const line of tail(fd, size, counter)) titles(line);
	if (!records) return undefined;
	return { tool: "claude-code", file, id, title: rowTitle(custom ?? ai ?? summary ?? prompt), ...(folder === undefined ? {} : { folder }), lastActive: mtime, size, inUse: now - mtime < IN_USE_MS };
}

interface CodexPayload {
	readonly id?: unknown;
	readonly cwd?: unknown;
	readonly source?: unknown;
	readonly type?: unknown;
	readonly message?: unknown;
	readonly item?: { readonly type?: unknown; readonly content?: unknown };
}

function codexChat(file: string, fd: number, size: number, mtime: number, now: number, counter: Counter, names: ReadonlyMap<string, string>): Chat | undefined {
	let first = true;
	let skip = false;
	let id = basename(file, ".jsonl");
	let folder: string | undefined;
	let prompt: string | undefined;
	scanHead(fd, size, counter, (line) => {
		const record = parse(line);
		if (first) {
			first = false;
			const payload = record?.payload as CodexPayload | undefined;
			if (record?.type !== "session_meta") skip = true;
			// A subagent's session: its prompts come from another agent (the importer leaves these out too).
			else if (typeof payload?.source === "object" && payload.source !== null && "subagent" in payload.source) skip = true;
			else {
				if (typeof payload?.id === "string") id = payload.id;
				folder = words(payload?.cwd);
			}
			return skip;
		}
		if (!line.includes('"user_message"') && !line.includes('"UserMessage"')) return false;
		if (record?.type !== "event_msg") return false;
		const p = record.payload as CodexPayload | undefined;
		const text = p?.type === "user_message" ? words(p.message) : p?.type === "item_completed" && p.item?.type === "UserMessage" ? words(itemText(p.item.content)) : undefined;
		if (text === undefined || injected(text)) return false;
		prompt = text;
		return true;
	});
	if (skip) return undefined;
	return { tool: "codex", file, id, title: rowTitle(names.get(id) ?? prompt), ...(folder === undefined ? {} : { folder }), lastActive: mtime, size, inUse: now - mtime < IN_USE_MS };
}

/** Codex's thread names: <codex>/session_index.jsonl lines of id, thread_name and updated_at; the last for an id wins. */
export function codexThreadNames(codexHome: string, counter: Counter = { bytes: 0 }): Map<string, string> {
	const names = new Map<string, string>();
	let raw = "";
	const file = join(codexHome, "session_index.jsonl");
	if (!isRegularFile(file)) return names;
	let fd: number;
	try {
		fd = openSync(file, "r");
	} catch {
		return names;
	}
	try {
		const size = fstatSync(fd).size;
		const start = Math.max(0, size - INDEX_BYTES);
		raw = readRange(fd, start, size - start, counter).toString("utf8");
		if (start > 0) raw = raw.slice(raw.indexOf("\n") + 1); // the first piece may be cut
	} catch {
		return names;
	} finally {
		closeSync(fd);
	}
	for (const line of raw.split("\n")) {
		const record = parse(line);
		const name = words(record?.thread_name);
		if (typeof record?.id === "string" && name !== undefined) names.set(record.id, name.trim());
	}
	return names;
}

/** Whether `file` is a regular file: a FIFO named like a chat must not be opened (it blocks). */
function isRegularFile(file: string): boolean {
	try {
		return statSync(file).isFile();
	} catch {
		return false;
	}
}

/** One file's row, or undefined when it cannot be read or says nothing. */
function readChat(file: string, make: (fd: number, size: number, mtime: number) => Chat | undefined): Chat | undefined {
	if (!isRegularFile(file)) return undefined;
	let fd: number;
	try {
		fd = openSync(file, "r");
	} catch {
		return undefined;
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size === 0) return undefined;
		return make(fd, stat.size, stat.mtimeMs);
	} catch {
		return undefined;
	} finally {
		closeSync(fd);
	}
}

const entries = (dir: string): string[] => {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
};

export function listChats(options: { env?: NodeJS.ProcessEnv; home?: string; now?: number } = {}): ChatList {
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	const now = options.now ?? Date.now();
	const counter: Counter = { bytes: 0 };
	const chats: Chat[] = [];
	const projects = join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "projects");
	for (const project of entries(projects)) {
		for (const name of entries(join(projects, project))) {
			if (!name.endsWith(".jsonl")) continue;
			const file = join(projects, project, name);
			const chat = readChat(file, (fd, size, mtime) => claudeChat(file, fd, size, mtime, now, counter));
			if (chat !== undefined) chats.push(chat);
		}
	}
	const codexHome = env.CODEX_HOME || join(home, ".codex");
	const names = codexThreadNames(codexHome, counter);
	const codexChats = new Map<string, Chat>();
	for (const root of [join(codexHome, "sessions"), join(codexHome, "archived_sessions")]) {
		let found: string[];
		try {
			found = (readdirSync(root, { recursive: true }) as string[]).filter((entry) => /(^|\/)rollout-[^/]*\.jsonl$/.test(entry));
		} catch {
			found = [];
		}
		for (const relative of found) {
			const file = join(root, relative);
			const chat = readChat(file, (fd, size, mtime) => codexChat(file, fd, size, mtime, now, counter, names));
			// The same thread may sit in sessions and archived_sessions: the newest file wins.
			const same = chat === undefined ? undefined : codexChats.get(chat.id);
			if (chat !== undefined && (same === undefined || chat.lastActive > same.lastActive)) codexChats.set(chat.id, chat);
		}
	}
	chats.push(...codexChats.values());
	chats.sort((a, b) => b.lastActive - a.lastActive);
	return { chats, bytesRead: counter.bytes };
}
