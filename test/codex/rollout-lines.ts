/**
 * Codex rollout lines, in the shapes Codex 0.163.0 writes them (field names from real `codex exec` and TUI runs; the
 * words and ids are made up), and a scratch Codex home that keeps them as Codex does. For the rollout check's tests
 * (src/codex/rollout.ts).
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const at = () => new Date().toISOString();
const event = (payload: object) => JSON.stringify({ timestamp: at(), type: "event_msg", payload });

export const rollout = {
	/** The first line: the session's own record, a person's own thread ("user": the TUI and `codex exec` alike). */
	meta: (session: string) =>
		JSON.stringify({ timestamp: at(), type: "session_meta", payload: { session_id: session, id: session, timestamp: at(), cwd: "/w", originator: "codex_exec", cli_version: "0.163.0", source: "exec", thread_source: "user" } }),
	/**
	 * The first line as an older Codex writes it (0.161.0, captured: `cli_version` its own; with `version` null, a line
	 * that names no version at all).
	 */
	oldMeta: (session: string, version: string | null = "0.161.0") =>
		JSON.stringify({
			timestamp: at(),
			type: "session_meta",
			payload: { session_id: session, id: session, timestamp: at(), cwd: "/w", originator: "codex_exec", ...(version === null ? {} : { cli_version: version }), source: "exec", thread_source: "user", model_provider: "fake", history_mode: "paginated" },
		}),
	/** A turn's start as Codex 0.153.4 to 0.161.0 write it (captured): no `turn_attribution`, so nothing says who started it. */
	oldStarted: (turnId: string) => event({ type: "task_started", turn_id: turnId, root_turn_id: turnId, started_at: 1, model_context_window: 258400, collaboration_mode_kind: "default" }),
	/** The first line of a spawned agent's thread (spawn_agent), as 0.163.0 writes it. */
	subagentMeta: (session: string, parent: string) =>
		JSON.stringify({
			timestamp: at(),
			type: "session_meta",
			payload: {
				session_id: session,
				id: session,
				parent_thread_id: parent,
				timestamp: at(),
				cwd: "/w",
				originator: "codex_exec",
				cli_version: "0.163.0",
				source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_path: null, agent_nickname: "Plato", agent_role: null } } },
				thread_source: "subagent",
			},
		}),
	/**
	 * A turn's start: `trigger` is "user" in the TUI, "exec" for `codex exec` (and for a spawned agent's turn, whose
	 * `parent_turn_id` names the turn that spawned it), "queue" for `codex queue`, "guardian_review" for a guardian's turn.
	 */
	started: (turnId: string, trigger = "exec", attribution: { parent_turn_id?: string | null; initiating_agent_path?: string | null } = {}) =>
		event({
			type: "task_started",
			turn_attribution: { turn_id: turnId, turn_trigger: trigger, parent_turn_id: null, initiating_agent_path: null, root_turn_id: turnId, ...attribution },
			turn_id: turnId,
			root_turn_id: turnId,
			started_at: 1,
			model_context_window: 258400,
			collaboration_mode_kind: "default",
		}),
	/** The user's message, as the turn's item: what confirms a prompt. */
	user: (turnId: string, text: string, id: string = randomUUID()) =>
		event({ type: "item_completed", thread_id: "thread", turn_id: turnId, item: { type: "UserMessage", id, content: [{ type: "text", text, text_elements: [] }] }, started_at_ms: 1, completed_at_ms: 1 }),
	/** One of the agent's messages in a turn (not necessarily its last). */
	agent: (turnId: string, text: string) =>
		event({ type: "item_completed", thread_id: "thread", turn_id: turnId, item: { type: "AgentMessage", id: randomUUID(), content: [{ type: "Text", text }] }, started_at_ms: 1, completed_at_ms: 1 }),
	/** A model-input item of role user (the environment context uses it too): no proof of anything. */
	responseUser: (turnId: string, text: string) =>
		JSON.stringify({ timestamp: at(), type: "response_item", payload: { type: "message", id: randomUUID(), role: "user", content: [{ type: "input_text", text }], internal_chat_message_metadata_passthrough: { turn_id: turnId } } }),
	/** The turn's end, with its final agent message: what confirms a reply. */
	complete: (turnId: string, last: string | null) =>
		event({ type: "task_complete", root_turn_id: turnId, turn_id: turnId, last_agent_message: last, started_at: 1, completed_at: 1, duration_ms: 1 }),
	/** An interrupted turn's end. */
	aborted: (turnId: string) => event({ type: "turn_aborted", turn_id: turnId, reason: "interrupted" }),
	/** A whole turn as Codex writes it, in its order: start, input, the user's message, the reply, the end. */
	turn: (turnId: string, prompt: string, reply: string, trigger = "exec") => [
		rollout.started(turnId, trigger),
		rollout.responseUser(turnId, prompt),
		rollout.user(turnId, prompt),
		rollout.agent(turnId, reply),
		rollout.complete(turnId, reply),
	],
};

/** A Codex session id: a UUID, as Codex's are. */
export const codexSession = (): string => randomUUID();

/** A scratch Codex home (CODEX_HOME) whose rollouts sit where Codex keeps them: sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl. */
export interface CodexHome {
	readonly home: string;
	/** Session `session`'s rollout (made by `begin`). */
	path(session: string): string;
	/** Whether the session's rollout was made. */
	has(session: string): boolean;
	/**
	 * Makes the session's rollout with its first line (`meta`, default a person's own thread's); `open` (default): this
	 * process holds it open, as Codex does.
	 */
	begin(session: string, options?: { readonly open?: boolean; readonly archived?: boolean; readonly meta?: string }): string;
	/** Appends lines to the session's rollout, as Codex does. */
	add(session: string, ...lines: string[]): void;
	/** Closes what this process holds open. */
	close(): void;
}

export function codexHomeIn(dir: string): CodexHome {
	const home = join(dir, "codex-home");
	const paths = new Map<string, string>();
	const open: number[] = [];
	const path = (session: string) => {
		const known = paths.get(session);
		if (known === undefined) throw new Error(`no rollout begun for ${session}`);
		return known;
	};
	return {
		home,
		path,
		has: (session) => paths.has(session),
		begin: (session, options = {}) => {
			const folder = options.archived === true ? join(home, "archived_sessions") : join(home, "sessions", "2026", "10", "18");
			mkdirSync(folder, { recursive: true, mode: 0o700 });
			const file = join(folder, `rollout-2026-10-18T22-34-55-${session}.jsonl`);
			writeFileSync(file, `${options.meta ?? rollout.meta(session)}\n`, { mode: 0o600 });
			paths.set(session, file);
			if (options.open !== false) open.push(openSync(file, "a"));
			return file;
		},
		add: (session, ...lines) => appendFileSync(path(session), lines.map((l) => `${l}\n`).join("")),
		close: () => {
			for (const fd of open.splice(0)) closeSync(fd);
		},
	};
}
