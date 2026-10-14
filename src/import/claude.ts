/**
 * Claude Code history: the user's messages and each turn's final reply (spec §7). Dropped: system reminders,
 * slash-command wrappers, output and replies (a slash command ends the turn before it), ! shell commands and output, task notifications, interrupt markers, meta and
 * sidechain records, tool calls and output, thinking and /compact summaries. Subagent final reports (Task/Agent tool
 * results) are kept as "[subagent] …". <pasted_content> tags are kept; the paste split cuts at them. A record whose
 * uuid was already read, in any file of the import, is a copy (a resumed session copies earlier history) and is skipped.
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { NewMessage } from "../memory/index.ts";
import { readLines } from "./lines.ts";
import { emptyExtract, type Extracted } from "./turns.ts";

const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const NOISE = [
	"<command-",
	"<local-command",
	"<task-notification",
	"[Request interrupted by user",
	"<bash-input",
	"<bash-stdout",
	"<bash-stderr",
	"<user-memory-input",
];
const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);

interface Block {
	readonly type?: string;
	readonly text?: string;
	readonly id?: string;
	readonly name?: string;
	readonly tool_use_id?: string;
	readonly content?: unknown;
}

interface ClaudeRecord {
	readonly type?: string;
	readonly uuid?: string;
	readonly isSidechain?: boolean;
	readonly isMeta?: boolean;
	readonly isCompactSummary?: boolean;
	readonly timestamp?: string;
	readonly sessionId?: string;
	readonly message?: { readonly id?: string; readonly content?: unknown };
}

export function claudeProjectDir(workspace: string, home: string = homedir()): string {
	return join(home, ".claude", "projects", workspace.replace(/[^A-Za-z0-9]/g, "-"));
}

function blockText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as Block[])
		.map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : ""))
		.filter(Boolean)
		.join("\n");
}

/** A user record's own words: its text without system reminders, or undefined for noise (slash-command wrappers, ! commands, notifications). */
export function promptText(content: unknown): string | undefined {
	const text = blockText(content).replace(SYSTEM_REMINDER, "").trim();
	if (!text || NOISE.some((prefix) => text.startsWith(prefix))) return undefined;
	return text;
}

/** A slash command's wrapper (`<command-name>`, `<command-message>`): what follows is the command's, not the turn's. */
function slashCommand(content: unknown): boolean {
	return blockText(content).replace(SYSTEM_REMINDER, "").trim().startsWith("<command-");
}

interface OpenTurn {
	source: string;
	start: string;
	messages: NewMessage[];
	final?: { text: string; date: string; id?: string };
}

/** A Claude Code project folder's session files, sorted. Subagent sessions sit in subfolders and are not read. */
export function claudeSessionFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((file) => file.endsWith(".jsonl"))
		.sort()
		.map((file) => resolve(dir, file));
}

/**
 * Named sessions (--claude-file): each must be readable and hold a Claude Code record (one with a sessionId) in its
 * first 50 lines. Returns absolute paths, without duplicates.
 */
export function checkClaudeFiles(files: readonly string[]): string[] {
	const checked: string[] = [];
	for (const name of files) {
		const file = resolve(name);
		let session = false;
		try {
			let seen = 0;
			for (const line of readLines(file)) {
				if (!line.trim()) continue;
				try {
					session = typeof (JSON.parse(line) as { sessionId?: unknown }).sessionId === "string";
				} catch {
					session = false;
				}
				if (session || ++seen >= 50) break;
			}
		} catch {
			throw new Error(`--claude-file ${name} is not a readable Claude Code session file.`);
		}
		if (!session) throw new Error(`--claude-file ${name} is not a Claude Code session (no record with a sessionId in its first 50 lines).`);
		if (!checked.includes(file)) checked.push(file);
	}
	return checked;
}

/** The sessions in a Claude Code project folder. */
export function extractClaude(dir: string): Extracted {
	return extractClaudeFiles(claudeSessionFiles(dir));
}

/** Claude Code sessions in the order given. A record whose uuid was already read, in any of them, is a copy. */
export function extractClaudeFiles(files: readonly string[]): Extracted {
	const { turns, stats, omitted } = emptyExtract();
	const read = new Set<string>();
	let copies = 0;
	for (const file of files) {
		stats.files++;
		const agentCalls = new Set<string>();
		let turn: OpenTurn | undefined;
		const flush = () => {
			if (turn === undefined) return;
			if (turn.final !== undefined) turn.messages.push({ kind: "talk", text: turn.final.text, date: turn.final.date });
			turns.push({ source: turn.source, start: turn.start, messages: turn.messages });
			turn = undefined;
		};
		for (const raw of readLines(file)) {
			if (!raw.trim()) continue;
			stats.lines++;
			let record: ClaudeRecord;
			try {
				record = JSON.parse(raw) as ClaudeRecord;
			} catch {
				stats.skipped++;
				continue;
			}
			if (record.isSidechain === true || (record.type !== "user" && record.type !== "assistant")) continue;
			if (typeof record.uuid === "string") {
				if (read.has(record.uuid)) {
					copies++;
					continue;
				}
				read.add(record.uuid);
			}
			const date = record.timestamp;
			if (typeof date !== "string") continue;
			const content = record.message?.content;
			if (record.type === "user") {
				if (record.isMeta === true || record.isCompactSummary === true) continue;
				if (Array.isArray(content) && turn !== undefined) {
					for (const block of content as Block[]) {
						if (block?.type === "tool_result" && typeof block.tool_use_id === "string" && agentCalls.has(block.tool_use_id)) {
							const report = blockText(block.content).trim();
							if (report) turn.messages.push({ kind: "user", text: `[subagent] ${report}`, date });
						}
					}
				}
				const text = promptText(content);
				if (text === undefined) {
					// A slash command ends the turn before it: its reply is noise, and must not stand as that turn's final reply.
					if (slashCommand(content)) flush();
					continue;
				}
				flush();
				turn = { source: `claude:${record.sessionId ?? basename(file)}`, start: date, messages: [{ kind: "user", text, date }] };
				continue;
			}
			if (turn === undefined || !Array.isArray(content)) continue;
			for (const block of content as Block[]) {
				if (block?.type === "tool_use" && typeof block.id === "string" && SUBAGENT_TOOLS.has(block.name ?? "")) agentCalls.add(block.id);
				if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
					const id = record.message?.id;
					if (turn.final !== undefined && id !== undefined && turn.final.id === id) {
						turn.final = { ...turn.final, text: `${turn.final.text}\n\n${block.text}` };
					} else turn.final = { text: block.text, date, id };
				}
			}
		}
		flush();
	}
	stats.turns = turns.length;
	if (copies > 0) omitted.push(`Skipped ${copies} copied Claude Code records (a uuid already read, as when a resumed session copies earlier history).`);
	return { turns, stats, omitted };
}
