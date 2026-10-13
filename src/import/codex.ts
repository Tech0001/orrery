/**
 * Codex rollout history: user messages and each turn's final answer (spec §7). Commentary and tool traffic are
 * dropped. Rollouts older than the `phase` field fall back to the turn's last agent message.
 *
 * Codex writes what it shows as the user's and the agent's messages either as user_message and agent_message
 * events or as item_completed events carrying UserMessage and AgentMessage items. Both already leave out injected
 * context (environment, AGENTS.md, subagent notifications, aborted-turn markers) and developer messages, which the
 * raw response_item messages keep. A file is read one way only, events if it has any, else items, so nothing is
 * counted twice.
 *
 * A forked session starts with a copy of its parent's history, stamped with the fork's start time. That replay is
 * skipped, since the parent's own rollout has the real dates. It runs from the fork's session_meta to the first
 * record of a turn started after the fork was created (turn and session ids are UUIDv7, which carry their creation
 * time). Subagent sessions are skipped: their prompts come from another agent, not the user.
 */

import { readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { NewMessage } from "../memory/index.ts";
import { readLines } from "./lines.ts";
import { emptyExtract, type Extracted, type ImportTurn } from "./turns.ts";

interface CodexRecord {
	readonly timestamp?: string;
	readonly type?: string;
	readonly payload?: {
		readonly type?: string;
		readonly id?: string;
		readonly cwd?: string;
		readonly timestamp?: string;
		readonly forked_from_id?: string;
		readonly source?: unknown;
		readonly turn_id?: string;
		readonly message?: string;
		readonly phase?: string;
		readonly item?: { readonly type?: string; readonly phase?: string; readonly content?: unknown };
	};
}

function firstLine(file: string): string | undefined {
	for (const line of readLines(file)) return line;
	return undefined;
}

export function findCodexSessions(root: string, workspace: string): string[] {
	let entries: string[];
	try {
		entries = readdirSync(root, { recursive: true }) as string[];
	} catch {
		return [];
	}
	const found: string[] = [];
	for (const relative of entries.filter((entry) => /(^|\/)rollout-[^/]*\.jsonl$/.test(entry)).sort()) {
		const file = join(root, relative);
		try {
			const meta = JSON.parse(firstLine(file) ?? "") as CodexRecord;
			const cwd = meta.type === "session_meta" ? meta.payload?.cwd : undefined;
			if (cwd === workspace || cwd?.startsWith(`${workspace}/`)) found.push(file);
		} catch {
			// Not a readable session; skip it.
		}
	}
	return found;
}

/** Named rollout files: each must exist and start with a session_meta record. Returns absolute paths, no duplicates. */
export function checkCodexFiles(files: readonly string[]): string[] {
	const checked: string[] = [];
	for (const name of files) {
		const file = resolve(name);
		let type: unknown;
		try {
			type = (JSON.parse(firstLine(file) ?? "") as CodexRecord).type;
		} catch {
			throw new Error(`--codex-file ${name} is not a readable Codex rollout (its first line must be a session_meta record).`);
		}
		if (type !== "session_meta") throw new Error(`--codex-file ${name} is not a Codex rollout (its first line is not session_meta).`);
		if (!checked.includes(file)) checked.push(file);
	}
	return checked;
}

interface Reply {
	readonly text: string;
	readonly date: string;
}

/** The creation time in ms of a UUIDv7 id (Codex session and turn ids), or undefined for any other id. */
function uuidV7Time(id: unknown): number | undefined {
	if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return undefined;
	return Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}

/** A completed item's text parts, joined as Codex joins them for its message events. */
function itemText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return (content as { type?: unknown; text?: unknown }[])
		.map((part) => ((part?.type === "text" || part?.type === "Text") && typeof part.text === "string" ? part.text : ""))
		.join("");
}

/** Turns from one way of recording messages: a user message opens a turn, and its final answer is kept. */
class TurnBuilder {
	readonly turns: ImportTurn[] = [];
	/** Whether the file records its messages this way. */
	used = false;
	/** Messages of a parent's replayed history, left out. */
	replayed = 0;
	source: string;
	private open: { start: string; messages: NewMessage[]; final?: Reply; fallback?: Reply; replay: boolean } | undefined;

	constructor(source: string) {
		this.source = source;
	}

	user(message: string, date: string, replay: boolean): void {
		this.used = true;
		const text = message.trim();
		if (!text) return;
		this.flush();
		this.open = { start: date, messages: [{ kind: "user", text, date }], replay };
	}

	agent(message: string, date: string, phase: string | undefined): void {
		this.used = true;
		if (this.open === undefined || !message.trim()) return;
		const reply = { text: message, date };
		if (phase === "final_answer") this.open.final = reply;
		else if (phase === undefined) this.open.fallback = reply;
	}

	flush(): void {
		const turn = this.open;
		if (turn === undefined) return;
		this.open = undefined;
		const reply = turn.final ?? turn.fallback;
		if (reply !== undefined) turn.messages.push({ kind: "talk", text: reply.text, date: reply.date });
		if (turn.replay) this.replayed += turn.messages.length;
		else this.turns.push({ source: this.source, start: turn.start, messages: turn.messages });
	}
}

export function extractCodex(files: readonly string[]): Extracted {
	const { turns, stats, omitted } = emptyExtract();
	const sessions = new Set<string>();
	const replays: { session: string; parent: string; messages: number }[] = [];
	let subagents = 0;
	for (const file of files) {
		stats.files++;
		const events = new TurnBuilder(`codex:${basename(file)}`);
		const items = new TurnBuilder(`codex:${basename(file)}`);
		let head: { id: string; parent?: string; created: number } | undefined;
		let replaying = false;
		let subagent = false;
		for (const raw of readLines(file)) {
			if (!raw.trim()) continue;
			stats.lines++;
			let record: CodexRecord;
			try {
				record = JSON.parse(raw) as CodexRecord;
			} catch {
				stats.skipped++;
				continue;
			}
			const payload = record.payload;
			if (record.type === "session_meta") {
				// Later session_meta records are the parent's, copied into a fork's replay.
				if (head !== undefined || typeof payload?.id !== "string") continue;
				const source = payload.source;
				if (typeof source === "object" && source !== null && "subagent" in source) {
					subagent = true;
					break;
				}
				const parent = typeof payload.forked_from_id === "string" ? payload.forked_from_id : undefined;
				head = { id: payload.id, parent, created: uuidV7Time(payload.id) ?? Date.parse(payload.timestamp ?? record.timestamp ?? "") };
				events.source = items.source = `codex:${payload.id}`;
				replaying = parent !== undefined;
				continue;
			}
			if (replaying && head !== undefined) {
				const started = uuidV7Time(payload?.turn_id);
				if (started !== undefined && started >= head.created) {
					replaying = false;
					events.flush();
					items.flush();
				}
			}
			if (record.type !== "event_msg" || typeof record.timestamp !== "string") continue;
			if (typeof payload?.message === "string") {
				if (payload.type === "user_message") events.user(payload.message, record.timestamp, replaying);
				else if (payload.type === "agent_message") events.agent(payload.message, record.timestamp, payload.phase);
			} else if (payload?.type === "item_completed") {
				const item = payload.item;
				if (item?.type === "UserMessage") items.user(itemText(item.content), record.timestamp, replaying);
				else if (item?.type === "AgentMessage") items.agent(itemText(item.content), record.timestamp, item.phase);
			}
		}
		if (subagent) {
			subagents++;
			continue;
		}
		events.flush();
		items.flush();
		const read = events.used ? events : items;
		for (const turn of read.turns) turns.push(turn);
		if (head === undefined) continue;
		sessions.add(head.id);
		if (head.parent !== undefined && read.replayed > 0) replays.push({ session: head.id, parent: head.parent, messages: read.replayed });
	}
	stats.turns = turns.length;
	for (const { session, parent, messages } of replays) {
		omitted.push(
			sessions.has(parent)
				? `Skipped ${messages} messages replayed from parent ${parent} in Codex session ${session}; the parent's own rollout is imported.`
				: `Warning: ${messages} messages replayed from parent ${parent} in Codex session ${session} were skipped; add its rollout with --codex-file (look in ~/.codex/sessions or ~/.codex/archived_sessions) to import them with their real dates.`,
		);
	}
	if (subagents > 0) omitted.push(`Skipped ${subagents} Codex subagent sessions (their prompts come from another agent, not the Director).`);
	return { turns, stats, omitted };
}
