/**
 * Copies pi's session entries into the lane's memory (spec §4): every user message and reply, once. Tool calls, tool results and the user's `!cmd` runs are not copied (they cost too much to summarize); usage rows still are.
 * Each pi session keeps its own cursor (the last entry id copied), so resuming an older session never copies it again;
 * a rewind moves the cursor and nothing leaves memory. Entries and cursor land in one transaction.
 */

import type { Message } from "@earendil-works/pi-ai";
import { type MemoryStore, type MemoryView, type NewMessage, type UsageRow } from "../memory/index.ts";
import { messageItems } from "../lane/messages.ts";

export interface SessionSource {
	getSessionId(): string;
	getBranch(fromId?: string): readonly { id: string; type: string; message?: unknown }[];
}

export function cursorKey(sessionId: string): string {
	return `pi.cursor.${sessionId}`;
}

export function copySession(view: MemoryView, session: SessionSource, toolCap: number): number {
	const branch = session.getBranch();
	const key = cursorKey(session.getSessionId());
	const cursor = view.store.getMeta(key);
	const tail = branch.length === 0 ? undefined : branch[branch.length - 1].id;
	let start = 0;
	if (cursor) {
		const at = branch.findIndex((entry) => entry.id === cursor);
		if (at !== -1) start = at + 1;
		else {
			// The cursor is off this branch (a rewind or fork): re-anchor at the deepest entry both paths share.
			const known = new Set(session.getBranch(cursor).map((entry) => entry.id));
			let common = -1;
			for (let i = branch.length - 1; i >= 0 && common === -1; i--) if (known.has(branch[i].id)) common = i;
			start = common === -1 ? branch.length : common + 1;
		}
	}
	if (start >= branch.length) {
		if (tail !== undefined && cursor !== tail) view.store.setMeta(key, tail);
		return 0;
	}
	const messages: NewMessage[] = [];
	const usage: UsageRow[] = [];
	for (const entry of branch.slice(start)) {
		if (entry.type !== "message" || entry.message === undefined) continue;
		if ((entry.message as { role?: unknown }).role === "bashExecution") continue;
		const items = messageItems(entry.message as Message, toolCap);
		messages.push(...items.messages.filter((m) => m.kind === "user" || m.kind === "talk"));
		usage.push(...items.usage);
	}
	view.appendBatch(messages, { [key]: tail as string }, usage);
	return messages.length;
}

export function moveCursor(store: MemoryStore, sessionId: string, entryId: string | null): void {
	store.setMeta(cursorKey(sessionId), entryId ?? "");
}

/**
 * A forked session inherits entries already in memory (same entry ids as its parent, new session id). Task 5 calls this
 * on session_start with reason "fork": it points a session with no cursor at its branch tail, and never moves one.
 * With `at`, an entry on the branch, it points there instead, so what comes after it is still copied: OMP's "branch
 * from /btw" adds the side question and its answer after the entry it branched at.
 */
export function markSessionCopied(store: MemoryStore, session: SessionSource, at?: string): void {
	const key = cursorKey(session.getSessionId());
	if (store.getMeta(key) !== undefined) return;
	const branch = session.getBranch();
	const mark = at !== undefined && branch.some((entry) => entry.id === at) ? at : branch.at(-1)?.id;
	if (mark !== undefined) store.setMeta(key, mark);
}

/**
 * A session that moved into the lane's folder (OMP's /resume of another folder's session, /move) holds turns from
 * elsewhere, which must not enter this lane's memory: its cursor goes to the branch tail, moved there even when the lane
 * recorded the session before (it may have been away since), so only what comes after the move is copied.
 */
export function startAtTail(store: MemoryStore, session: SessionSource): void {
	store.setMeta(cursorKey(session.getSessionId()), session.getBranch().at(-1)?.id ?? "");
}
