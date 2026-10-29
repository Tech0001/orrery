/**
 * Grok Build session-log lines (`updates.jsonl`), in the shapes Grok 1.0.70 writes them (field names from real
 * interactive runs; the words and ids are made up), and a scratch Grok home that keeps them where Grok does:
 * `<home>/sessions/<the folder, percent-encoded>/<session id>/`. For the log check's tests (src/grok/log.ts).
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { grokFolder } from "../../src/grok/log.ts";

let events = 0;
const meta = (session: string) => ({ eventId: `${session}-${++events}`, agentTimestampMs: 1_793_295_676_661 });
/** A `session/update` line: what the conversation shows. `promptId`: the turn it belongs to, as Grok tags a turn's lines. */
const acp = (session: string, update: object, promptId?: string) =>
	JSON.stringify({ timestamp: 1_793_295_676, method: "session/update", params: { sessionId: session, update, _meta: { ...meta(session), ...(promptId === undefined ? {} : { promptId, updateType: "AgentMessageChunk" }) } } });
/** An `_x.ai/session/update` line: Grok's own record (hook runs, a turn's end, subagents). */
const xai = (session: string, update: object) => JSON.stringify({ timestamp: 1_793_295_676, method: "_x.ai/session/update", params: { sessionId: session, update, _meta: meta(session) } });

export const grokLog = {
	/** The record of a hook run; `promptId` for a turn's events (UserPromptSubmit, Stop). */
	hookRun: (session: string, event: string, promptId?: string) =>
		xai(session, { sessionUpdate: "hook_execution", event_name: event, ...(promptId === undefined ? {} : { prompt_id: promptId }), runs: [{ name: "project/orrery:x[0].hooks[0]", status: { status: "success", elapsed_ms: 20 } }] }),
	/** A prompt the person typed: its text, with the prompt's index in the session (and no promptId: the turn's lines after it carry that). */
	typed: (session: string, text: string, index: number) => acp(session, { sessionUpdate: "user_message_chunk", content: { type: "text", text }, _meta: { modelId: "grok-4.7", promptIndex: index } }),
	/**
	 * A prompt Grok wrote itself to wake the session (a scheduler fire's or a background subagent's result), as 1.0.70
	 * writes both: an index like a typed one, but hidden from the scrollback and marked synthetic.
	 */
	wake: (session: string, text: string, index: number) =>
		acp(session, { sessionUpdate: "user_message_chunk", content: { type: "text", text }, _meta: { modelId: "grok-4.7", promptIndex: index, hideFromScrollback: true, syntheticPrompt: true } }),
	/** The model's reasoning in turn `promptId`. */
	thought: (session: string, promptId: string, text = "Thinking it over.") => acp(session, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text } }, promptId),
	/** One of the agent's messages in turn `promptId` (Grok writes a message whole, on one line). */
	agent: (session: string, promptId: string, text: string) => acp(session, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } }, promptId),
	/** A tool call in turn `promptId`. */
	tool: (session: string, promptId: string, name = "run_terminal_command") => acp(session, { sessionUpdate: "tool_call", toolCallId: randomUUID(), title: name, rawInput: { command: "ls" } }, promptId),
	/** A turn's end: `end_turn`, or `cancelled` for an interrupted one. */
	completed: (session: string, promptId: string, stopReason = "end_turn") => xai(session, { sessionUpdate: "turn_completed", prompt_id: promptId, stop_reason: stopReason, elapsed_ms: 2913 }),
	/** A background subagent started, and its end (its own session is another folder). */
	spawned: (session: string, subagent: string) => xai(session, { sessionUpdate: "subagent_spawned", subagent_id: subagent, parent_session_id: session, child_session_id: subagent, subagent_type: "general-purpose" }),
	finished: (session: string, subagent: string) => xai(session, { sessionUpdate: "subagent_finished", subagent_id: subagent, child_session_id: subagent, status: "completed", output: "SUB-OK", will_wake: true }),
	/** A whole typed turn as Grok writes it: the prompt hook's run, the prompt, reasoning, a tool call, the reply, the Stop hook's run, the end. */
	turn: (session: string, promptId: string, prompt: string, reply: string, index: number) => [
		grokLog.hookRun(session, "user_prompt_submit", promptId),
		grokLog.typed(session, prompt, index),
		grokLog.thought(session, promptId),
		grokLog.agent(session, promptId, "On it."),
		grokLog.tool(session, promptId),
		grokLog.agent(session, promptId, reply),
		grokLog.hookRun(session, "stop", promptId),
		grokLog.completed(session, promptId),
	],
	/** A whole auto-wake turn: a background subagent's result wakes the session (its promptId is Grok's own). */
	wakeTurn: (session: string, subagent: string, reply: string, index: number) => {
		const promptId = `subagent-completed-${subagent}`;
		return [
			grokLog.finished(session, subagent),
			grokLog.hookRun(session, "user_prompt_submit", promptId),
			grokLog.wake(session, `<system-reminder>\nWhile you were idle, 1 background subagent completed:\n=== Output ===\nSUB-OK\n</system-reminder>`, index),
			grokLog.thought(session, promptId),
			grokLog.agent(session, promptId, reply),
			grokLog.hookRun(session, "stop", promptId),
			grokLog.completed(session, promptId),
		];
	},
};

/** A Grok session id: Grok's are UUIDs (v7). */
export const grokSession = (): string => randomUUID();

/** A scratch Grok home (GROK_HOME) whose sessions sit where Grok keeps them, for sessions started in folder `cwd`. */
export interface GrokHome {
	readonly home: string;
	readonly cwd: string;
	/** Session `session`'s folder. */
	dir(session: string): string;
	/** Session `session`'s log, updates.jsonl. */
	path(session: string): string;
	/** Whether the session's folder was made. */
	has(session: string): boolean;
	/**
	 * Makes the session's folder as Grok does at its start: summary.json (`kind`: a subagent's session says so), events.jsonl,
	 * which this process holds open as Grok does (`open`, default), and with `log` (default) an updates.jsonl.
	 */
	begin(session: string, options?: { readonly kind?: string; readonly open?: boolean; readonly log?: boolean }): string;
	/** Appends lines to the session's log, as Grok does. */
	add(session: string, ...lines: string[]): void;
	/** Closes what this process holds open. */
	close(): void;
}

export function grokHomeIn(dir: string, cwd: string): GrokHome {
	const home = join(dir, "grok-home");
	const folder = (session: string) => join(home, "sessions", grokFolder(cwd), session);
	const made = new Set<string>();
	const open: number[] = [];
	return {
		home,
		cwd,
		dir: folder,
		path: (session) => join(folder(session), "updates.jsonl"),
		has: (session) => made.has(session),
		begin: (session, options = {}) => {
			const at = folder(session);
			mkdirSync(at, { recursive: true, mode: 0o700 });
			writeFileSync(join(at, "summary.json"), JSON.stringify({ info: { id: session, cwd }, agent_id: "ag1.x", ...(options.kind === undefined ? {} : { session_kind: options.kind }), num_messages: 0 }), { mode: 0o600 });
			writeFileSync(join(at, "events.jsonl"), `${JSON.stringify({ ts: "2026-10-29T17:40:48.545Z", type: "mcp_config_resolved", servers: [] })}\n`, { mode: 0o600 });
			if (options.log !== false) writeFileSync(join(at, "updates.jsonl"), "", { mode: 0o600 });
			if (options.open !== false) open.push(openSync(join(at, "events.jsonl"), "a"));
			made.add(session);
			return at;
		},
		add: (session, ...lines) => appendFileSync(join(folder(session), "updates.jsonl"), lines.map((line) => `${line}\n`).join("")),
		close: () => {
			for (const fd of open.splice(0)) closeSync(fd);
		},
	};
}
