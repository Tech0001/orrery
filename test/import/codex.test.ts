import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractCodex, findCodexSessions } from "../../src/import/codex.ts";
import { tempDir } from "../agent/support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const rec = (timestamp: string, type: string, payload: object) => JSON.stringify({ timestamp, type, payload });

function session(root: string, name: string, cwd: string, body: string[], meta: object = {}): string {
	const dir = join(root, "2026", "08", "01");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, name);
	writeFileSync(file, [rec("2026-08-01T10:00:00.000Z", "session_meta", { id: `id-${name}`, cwd, ...meta }), ...body].join("\n"));
	return file;
}

/** A response_item message: what the model saw, including injected context. */
const said = (timestamp: string, role: string, text: string, extra: object = {}) =>
	rec(timestamp, "response_item", { type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }], ...extra });
/** Codex's own view of a message, in rollouts that record completed items instead of user and agent message events. */
const userItem = (timestamp: string, turn: string, text: string, extra: object[] = []) =>
	rec(timestamp, "event_msg", { type: "item_completed", turn_id: turn, item: { type: "UserMessage", id: "u", content: [{ type: "text", text, text_elements: [] }, ...extra] } });
const agentItem = (timestamp: string, turn: string, text: string, phase?: string) =>
	rec(timestamp, "event_msg", { type: "item_completed", turn_id: turn, item: { type: "AgentMessage", id: "a", content: [{ type: "Text", text }], phase } });
const texts = (turns: { messages: { text: string }[] }[]) => turns.flatMap((t) => t.messages.map((m) => m.text));

function root(): string {
	const dir = tempDir("orrery-codex-");
	dirs.push(dir);
	return dir;
}

describe("findCodexSessions", () => {
	it("finds rollout files whose session ran in the folder or below it", () => {
		const r = root();
		const a = session(r, "rollout-a.jsonl", "/w/agent-Atlas", []);
		const b = session(r, "rollout-b.jsonl", "/w/agent-Atlas/sub", []);
		session(r, "rollout-c.jsonl", "/w/agent-AtlasX", []);
		session(r, "rollout-d.jsonl", "/w/agent-Cedar", []);
		writeFileSync(join(r, "2026", "08", "01", "rollout-e.jsonl"), "{not json");
		expect(findCodexSessions(r, "/w/agent-Atlas")).toEqual([a, b]);
		expect(findCodexSessions(join(r, "missing"), "/w/agent-Atlas")).toEqual([]);
	});
});

describe("extractCodex", () => {
	it("keeps user messages and final answers, never commentary or tool traffic", () => {
		const file = session(root(), "rollout-a.jsonl", "/w/agent-Atlas", [
			rec("2026-08-01T10:00:01.000Z", "event_msg", { type: "user_message", message: "Audit the registry." }),
			rec("2026-08-01T10:00:02.000Z", "event_msg", { type: "agent_message", message: "Checking now.", phase: "commentary" }),
			rec("2026-08-01T10:00:03.000Z", "response_item", { type: "function_call", name: "shell", arguments: "{}" }),
			rec("2026-08-01T10:00:04.000Z", "response_item", { type: "function_call_output", output: "lots" }),
			rec("2026-08-01T10:00:05.000Z", "event_msg", { type: "agent_message", message: "Registry audit: 3 issues.", phase: "final_answer" }),
			"{broken",
			rec("2026-08-01T10:05:00.000Z", "event_msg", { type: "user_message", message: "Fix them." }),
			rec("2026-08-01T10:05:01.000Z", "event_msg", { type: "agent_message", message: "Starting.", phase: "commentary" }),
			rec("2026-08-01T10:05:02.000Z", "event_msg", { type: "turn_aborted", reason: "interrupted" }),
		]);
		const { turns, stats } = extractCodex([file]);
		expect(stats).toEqual({ files: 1, lines: 10, skipped: 1, turns: 2 });
		expect(turns).toEqual([
			{
				source: "codex:id-rollout-a.jsonl",
				start: "2026-08-01T10:00:01.000Z",
				messages: [
					{ kind: "user", text: "Audit the registry.", date: "2026-08-01T10:00:01.000Z" },
					{ kind: "talk", text: "Registry audit: 3 issues.", date: "2026-08-01T10:00:05.000Z" },
				],
			},
			{ source: "codex:id-rollout-a.jsonl", start: "2026-08-01T10:05:00.000Z", messages: [{ kind: "user", text: "Fix them.", date: "2026-08-01T10:05:00.000Z" }] },
		]);
	});

	it("falls back to the last unphased agent message in rollouts that predate phases", () => {
		const file = session(root(), "rollout-old.jsonl", "/w/agent-Atlas", [
			rec("2026-08-01T09:00:01.000Z", "event_msg", { type: "user_message", message: "Old question." }),
			rec("2026-08-01T09:00:02.000Z", "event_msg", { type: "agent_message", message: "Thinking aloud." }),
			rec("2026-08-01T09:00:03.000Z", "event_msg", { type: "agent_message", message: "Old answer." }),
		]);
		expect(extractCodex([file]).turns[0].messages.map((m) => m.text)).toEqual(["Old question.", "Old answer."]);
	});

	it("reads rollouts that record completed items, keeping what Codex shows as the user's words and each final answer", () => {
		const T1 = "01900000-1000-7000-8000-000000000001";
		const T2 = "01900000-2000-7000-8000-000000000002";
		const file = session(root(), "rollout-items.jsonl", "/w/agent-Atlas", [
			said("2026-08-01T10:00:01.000Z", "developer", "<permissions instructions>sandboxed</permissions instructions>"),
			said("2026-08-01T10:00:01.000Z", "user", "# AGENTS.md instructions for /w/agent-Atlas\n\nrules"),
			said("2026-08-01T10:00:01.000Z", "user", "<environment_context>cwd</environment_context>"),
			rec("2026-08-01T10:00:01.500Z", "event_msg", { type: "task_started", turn_id: T1 }),
			rec("2026-08-01T10:00:01.600Z", "turn_context", { turn_id: T1 }),
			said("2026-08-01T10:00:02.000Z", "user", "Audit the registry."),
			userItem("2026-08-01T10:00:02.001Z", T1, "Audit the registry."),
			agentItem("2026-08-01T10:00:03.000Z", T1, "Checking now.", "commentary"),
			said("2026-08-01T10:00:03.001Z", "assistant", "Checking now.", { phase: "commentary" }),
			rec("2026-08-01T10:00:03.500Z", "response_item", { type: "function_call", name: "shell", arguments: "{}" }),
			rec("2026-08-01T10:00:04.000Z", "response_item", { type: "function_call_output", output: "lots" }),
			said("2026-08-01T10:00:04.100Z", "user", "<subagent_notification>agent done</subagent_notification>"),
			said("2026-08-01T10:00:04.200Z", "user", "A notice injected mid-turn."),
			said("2026-08-01T10:00:04.300Z", "developer", "Model changed."),
			agentItem("2026-08-01T10:00:05.000Z", T1, "Registry audit: 3 issues.", "final_answer"),
			said("2026-08-01T10:00:05.001Z", "assistant", "Registry audit: 3 issues.", { phase: "final_answer" }),
			rec("2026-08-01T10:00:05.100Z", "event_msg", { type: "task_complete", turn_id: T1 }),
			said("2026-08-01T10:04:00.000Z", "user", "<turn_aborted>interrupted</turn_aborted>"),
			rec("2026-08-01T10:05:00.000Z", "event_msg", { type: "task_started", turn_id: T2 }),
			said("2026-08-01T10:05:01.000Z", "user", "See this. "),
			userItem("2026-08-01T10:05:01.002Z", T2, "See this. ", [{ type: "local_image", path: "/tmp/shot.png" }]),
			agentItem("2026-08-01T10:05:02.000Z", T2, "Looks fine."),
		]);
		const { turns, stats, omitted } = extractCodex([file]);
		expect(stats).toEqual({ files: 1, lines: 23, skipped: 0, turns: 2 });
		expect(omitted).toEqual([]);
		expect(turns).toEqual([
			{
				source: "codex:id-rollout-items.jsonl",
				start: "2026-08-01T10:00:02.001Z",
				messages: [
					{ kind: "user", text: "Audit the registry.", date: "2026-08-01T10:00:02.001Z" },
					{ kind: "talk", text: "Registry audit: 3 issues.", date: "2026-08-01T10:00:05.000Z" },
				],
			},
			{
				source: "codex:id-rollout-items.jsonl",
				start: "2026-08-01T10:05:01.002Z",
				messages: [
					{ kind: "user", text: "See this.", date: "2026-08-01T10:05:01.002Z" },
					{ kind: "talk", text: "Looks fine.", date: "2026-08-01T10:05:02.000Z" },
				],
			},
		]);
	});

	it("reads a file in one format: message events win over completed items, so nothing is counted twice", () => {
		const T1 = "01900000-1000-7000-8000-000000000001";
		const file = session(root(), "rollout-both.jsonl", "/w/agent-Atlas", [
			rec("2026-08-01T10:00:01.000Z", "event_msg", { type: "user_message", message: "Hello." }),
			userItem("2026-08-01T10:00:01.001Z", T1, "Hello."),
			agentItem("2026-08-01T10:00:02.000Z", T1, "Hi.", "final_answer"),
			rec("2026-08-01T10:00:02.001Z", "event_msg", { type: "agent_message", message: "Hi.", phase: "final_answer" }),
		]);
		const { turns } = extractCodex([file]);
		expect(turns.map((t) => t.start)).toEqual(["2026-08-01T10:00:01.000Z"]);
		expect(texts(turns)).toEqual(["Hello.", "Hi."]);
	});

	it("skips subagent sessions: their prompts come from another agent, not the user", () => {
		const file = session(
			root(),
			"rollout-sub.jsonl",
			"/w/agent-Atlas",
			[userItem("2026-08-01T10:00:01.000Z", "t", "Review this diff."), agentItem("2026-08-01T10:00:02.000Z", "t", "Looks good.", "final_answer")],
			{ source: { subagent: { thread_spawn: { parent_thread_id: "p", depth: 1 } } } },
		);
		const { turns, stats, omitted } = extractCodex([file]);
		expect(turns).toEqual([]);
		expect(stats.files).toBe(1);
		expect(omitted).toEqual(["Skipped 1 Codex subagent sessions (their prompts come from another agent, not the user)."]);
	});
});

describe("extractCodex on forked sessions", () => {
	// Codex ids are UUIDv7: the first 48 bits are the creation time, so the parent's turns predate the fork.
	const PARENT = "01900000-0000-7000-8000-00000000000a";
	const PARENT_TURN_1 = "01900000-1000-7000-8000-00000000000b";
	const PARENT_TURN_2 = "01900000-2000-7000-8000-00000000000c";
	const FORK = "01910000-0000-7000-8000-00000000000d";
	const FORK_TURN = "01910000-1000-7000-8000-00000000000e";
	const AT_FORK = "2026-08-21T18:41:08.000Z";

	function fork(r: string): string {
		return session(
			r,
			"rollout-fork.jsonl",
			"/w/agent-Cedar",
			[
				rec(AT_FORK, "session_meta", { id: PARENT, cwd: "/w/agent-Cedar" }),
				said(AT_FORK, "developer", "<permissions instructions>sandboxed</permissions instructions>"),
				said(AT_FORK, "user", "<environment_context>cwd</environment_context>"),
				rec(AT_FORK, "event_msg", { type: "task_started", turn_id: PARENT_TURN_1 }),
				rec(AT_FORK, "event_msg", { type: "user_message", message: "Old question." }),
				rec(AT_FORK, "turn_context", { turn_id: PARENT_TURN_1 }),
				rec(AT_FORK, "event_msg", { type: "agent_message", message: "Looking.", phase: "commentary" }),
				rec(AT_FORK, "event_msg", { type: "agent_message", message: "Old answer.", phase: "final_answer" }),
				rec(AT_FORK, "event_msg", { type: "task_complete", turn_id: PARENT_TURN_1 }),
				rec(AT_FORK, "event_msg", { type: "task_started", turn_id: PARENT_TURN_2 }),
				rec(AT_FORK, "event_msg", { type: "user_message", message: "Second old question." }),
				rec(AT_FORK, "event_msg", { type: "agent_message", message: "Second old answer.", phase: "final_answer" }),
				rec(AT_FORK, "event_msg", { type: "task_complete", turn_id: PARENT_TURN_2 }),
				rec(AT_FORK, "event_msg", { type: "thread_settings_applied" }),
				rec("2026-08-26T22:34:14.000Z", "event_msg", { type: "task_started", turn_id: FORK_TURN }),
				said("2026-08-26T22:34:15.000Z", "user", "<environment_context>cwd</environment_context>"),
				rec("2026-08-26T22:34:15.100Z", "event_msg", { type: "user_message", message: "New question." }),
				rec("2026-08-26T22:34:20.000Z", "event_msg", { type: "agent_message", message: "New answer.", phase: "final_answer" }),
			],
			{ id: FORK, forked_from_id: PARENT, timestamp: "2026-08-21T18:41:07.900Z" },
		);
	}

	function parent(r: string): string {
		return session(r, "rollout-parent.jsonl", "/w/agent-Cedar", [
			rec("2026-03-01T09:00:00.000Z", "event_msg", { type: "task_started", turn_id: PARENT_TURN_1 }),
			userItem("2026-03-01T09:00:01.000Z", PARENT_TURN_1, "Old question."),
			agentItem("2026-03-01T09:00:05.000Z", PARENT_TURN_1, "Old answer.", "final_answer"),
			rec("2026-03-02T09:00:00.000Z", "event_msg", { type: "task_started", turn_id: PARENT_TURN_2 }),
			userItem("2026-03-02T09:00:01.000Z", PARENT_TURN_2, "Second old question."),
			agentItem("2026-03-02T09:00:05.000Z", PARENT_TURN_2, "Second old answer.", "final_answer"),
		], { id: PARENT });
	}

	it("keeps only the fork's own messages and says how many it skipped from which parent", () => {
		const { turns, omitted } = extractCodex([fork(root())]);
		expect(turns).toEqual([
			{
				source: `codex:${FORK}`,
				start: "2026-08-26T22:34:15.100Z",
				messages: [
					{ kind: "user", text: "New question.", date: "2026-08-26T22:34:15.100Z" },
					{ kind: "talk", text: "New answer.", date: "2026-08-26T22:34:20.000Z" },
				],
			},
		]);
		expect(omitted).toEqual([
			`Warning: 4 messages replayed from parent ${PARENT} in Codex session ${FORK} were skipped; add its rollout with --codex-file (look in ~/.codex/sessions or ~/.codex/archived_sessions) to import them with their real dates.`,
		]);
	});

	it("imports the parent's messages once, with their real dates, when the parent's rollout is imported too", () => {
		const r = root();
		const { turns, omitted } = extractCodex([fork(r), parent(r)]);
		expect(texts(turns)).toEqual(["New question.", "New answer.", "Old question.", "Old answer.", "Second old question.", "Second old answer."]);
		expect(turns.map((t) => [t.source, t.start])).toEqual([
			[`codex:${FORK}`, "2026-08-26T22:34:15.100Z"],
			[`codex:${PARENT}`, "2026-03-01T09:00:01.000Z"],
			[`codex:${PARENT}`, "2026-03-02T09:00:01.000Z"],
		]);
		expect(omitted).toEqual([`Skipped 4 messages replayed from parent ${PARENT} in Codex session ${FORK}; the parent's own rollout is imported.`]);
	});

	it("skips a replay that has no copy of the parent's session_meta, and a fork with no history at all", () => {
		const r = root();
		const bare = session(
			r,
			"rollout-bare.jsonl",
			"/w/agent-Cedar",
			[
				userItem(AT_FORK, PARENT_TURN_1, "Old question."),
				agentItem(AT_FORK, PARENT_TURN_1, "Old answer.", "final_answer"),
				userItem("2026-08-22T08:00:00.000Z", FORK_TURN, "New question."),
				agentItem("2026-08-22T08:00:05.000Z", FORK_TURN, "New answer.", "final_answer"),
			],
			{ id: FORK, forked_from_id: PARENT },
		);
		const fresh = session(r, "rollout-fresh.jsonl", "/w/agent-Cedar", [userItem("2026-08-22T09:00:00.000Z", FORK_TURN, "Hi.")], {
			id: "01910000-0000-7000-8000-00000000000f",
			forked_from_id: PARENT,
		});
		const { turns, omitted } = extractCodex([bare, fresh]);
		expect(texts(turns)).toEqual(["New question.", "New answer.", "Hi."]);
		expect(omitted).toEqual([
			`Warning: 2 messages replayed from parent ${PARENT} in Codex session ${FORK} were skipped; add its rollout with --codex-file (look in ~/.codex/sessions or ~/.codex/archived_sessions) to import them with their real dates.`,
		]);
	});
});
