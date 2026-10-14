import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkClaudeFiles, claudeProjectDir, extractClaude, extractClaudeFiles } from "../../src/import/claude.ts";
import { tempDir } from "../agent/support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const line = (record: object) => JSON.stringify(record);
const user = (ts: string, content: unknown, extra: object = {}) =>
	line({ type: "user", isSidechain: false, timestamp: ts, sessionId: "s1", message: { role: "user", content }, ...extra });
const assistant = (ts: string, id: string, content: unknown[]) =>
	line({ type: "assistant", isSidechain: false, timestamp: ts, sessionId: "s1", message: { id, role: "assistant", content } });

describe("claudeProjectDir", () => {
	it("mirrors Claude Code's project directory naming", () => {
		expect(claudeProjectDir("/home/alex/Documents/GitHub/agent-Atlas", "/home/alex")).toBe(
			"/home/alex/.claude/projects/-home-alex-Documents-GitHub-agent-Atlas",
		);
	});
});

describe("extractClaude", () => {
	it("keeps the user's words, subagent reports and each turn's final reply, and drops everything else", () => {
		const dir = tempDir("orrery-claude-");
		dirs.push(dir);
		writeFileSync(
			join(dir, "session.jsonl"),
			[
				line({ type: "file-history-snapshot", messageId: "x" }),
				user("2026-07-19T00:00:00.000Z", "Ship the bridge fix.<system-reminder>noise</system-reminder>"),
				assistant("2026-07-19T00:00:05.000Z", "m1", [{ type: "thinking", thinking: "" }, { type: "text", text: "Looking." }]),
				assistant("2026-07-19T00:00:06.000Z", "m1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]),
				user("2026-07-19T00:00:07.000Z", [{ type: "tool_result", tool_use_id: "t1", content: "huge tool output" }]),
				assistant("2026-07-19T00:00:08.000Z", "m2", [{ type: "tool_use", id: "a1", name: "Agent", input: { prompt: "check" } }]),
				user("2026-07-19T00:00:09.000Z", [{ type: "tool_result", tool_use_id: "a1", content: [{ type: "text", text: "Subagent: all green." }] }]),
				assistant("2026-07-19T00:00:10.000Z", "m3", [{ type: "text", text: "Fixed and pushed." }]),
				assistant("2026-07-19T00:00:10.500Z", "m3", [{ type: "text", text: "Tests pass." }]),
				user("2026-07-19T00:01:00.000Z", "caveat", { isMeta: true }),
				user("2026-07-19T00:01:01.000Z", "<command-name>/model</command-name>"),
				user("2026-07-19T00:01:02.000Z", "<local-command-stdout>Set model</local-command-stdout>"),
				user("2026-07-19T00:01:03.000Z", "summary of earlier", { isCompactSummary: true }),
				user("2026-07-19T00:01:04.000Z", "<task-notification> <task-id>b1</task-id> done</task-notification>"),
				user("2026-07-19T00:01:05.000Z", [{ type: "text", text: "[Request interrupted by user for tool use]" }]),
				line({ type: "user", isSidechain: true, timestamp: "2026-07-19T00:01:06.000Z", message: { role: "user", content: "sidechain" } }),
				'{"type":"user","timestamp":"2026-07-19T00:02:00.000Z","message":{"role":"us',
				user("2026-07-19T00:03:00.000Z", [{ type: "text", text: '<pasted_content id="f1">\nreport\n</pasted_content>\nNext: the oracle.' }]),
			].join("\n"),
		);
		const { turns, stats } = extractClaude(dir);
		expect(stats).toEqual({ files: 1, lines: 18, skipped: 1, turns: 2 });
		expect(turns[0]).toEqual({
			source: "claude:s1",
			start: "2026-07-19T00:00:00.000Z",
			messages: [
				{ kind: "user", text: "Ship the bridge fix.", date: "2026-07-19T00:00:00.000Z" },
				{ kind: "user", text: "[subagent] Subagent: all green.", date: "2026-07-19T00:00:09.000Z" },
				{ kind: "talk", text: "Fixed and pushed.\n\nTests pass.", date: "2026-07-19T00:00:10.000Z" },
			],
		});
		expect(turns[1].messages).toEqual([
			{ kind: "user", text: '<pasted_content id="f1">\nreport\n</pasted_content>\nNext: the oracle.', date: "2026-07-19T00:03:00.000Z" },
		]);
	});

	it("drops the user's ! shell commands and their output", () => {
		const dir = tempDir("orrery-claude-");
		dirs.push(dir);
		writeFileSync(
			join(dir, "s.jsonl"),
			[
				user("2026-07-19T00:00:00.000Z", "Check the build."),
				user("2026-07-19T00:00:01.000Z", "<bash-input>npm test</bash-input>"),
				user("2026-07-19T00:00:02.000Z", "<bash-stdout>1000 lines of test output</bash-stdout><bash-stderr></bash-stderr>"),
				user("2026-07-19T00:00:03.000Z", "<user-memory-input>remember this</user-memory-input>"),
			].join("\n"),
		);
		expect(extractClaude(dir).turns.flatMap((t) => t.messages.map((m) => m.text))).toEqual(["Check the build."]);
	});

	it("keeps a turn's real final reply when a slash command follows it, and drops the command's own reply", () => {
		const dir = tempDir("orrery-claude-");
		dirs.push(dir);
		writeFileSync(
			join(dir, "s.jsonl"),
			[
				user("2026-07-19T00:00:00.000Z", "Fix the bridge."),
				assistant("2026-07-19T00:00:05.000Z", "m1", [{ type: "text", text: "Fixed the bridge; tests pass." }]),
				user("2026-07-19T00:01:00.000Z", "<command-message>brainstorm is running…</command-message>\n<command-name>/brainstorm</command-name>"),
				user("2026-07-19T00:01:01.000Z", "Skill instructions.", { isMeta: true }),
				assistant("2026-07-19T00:01:05.000Z", "m2", [{ type: "text", text: "What would you like to brainstorm?" }]),
				user("2026-07-19T00:02:00.000Z", "Next: the oracle."),
				assistant("2026-07-19T00:02:05.000Z", "m3", [{ type: "text", text: "Oracle done." }]),
			].join("\n"),
		);
		const texts = extractClaude(dir).turns.map((turn) => turn.messages.map((m) => m.text));
		expect(texts).toEqual([
			["Fix the bridge.", "Fixed the bridge; tests pass."],
			["Next: the oracle.", "Oracle done."],
		]);
	});

	it("reads each record once: a uuid already read (a resumed session copies earlier history) is skipped and counted", () => {
		const dir = tempDir("orrery-claude-");
		dirs.push(dir);
		const ask = (uuid: string, ts: string, text: string, session: string) =>
			line({ type: "user", uuid, timestamp: ts, sessionId: session, message: { role: "user", content: text } });
		const reply = (uuid: string, ts: string, text: string, session: string, extra: object = {}) =>
			line({ type: "assistant", uuid, timestamp: ts, sessionId: session, message: { id: `m-${uuid}`, role: "assistant", content: [{ type: "text", text }], ...extra } });
		writeFileSync(
			join(dir, "a.jsonl"),
			[
				ask("u1", "2026-07-19T00:00:00.000Z", "First question.", "a"),
				reply("r1", "2026-07-19T00:00:05.000Z", "First answer.", "a"),
				ask("u2", "2026-07-19T00:01:00.000Z", "Second question.", "a"),
				reply("r2", "2026-07-19T00:01:05.000Z", "Second answer.", "a", { stop_reason: null }),
				reply("r2", "2026-07-19T00:01:05.000Z", "Second answer.", "a", { stop_reason: "end_turn" }),
			].join("\n"),
		);
		writeFileSync(
			join(dir, "b.jsonl"),
			[
				ask("u1", "2026-07-19T00:00:00.000Z", "First question.", "b"),
				reply("r1", "2026-07-19T00:00:05.000Z", "First answer.", "b"),
				ask("u2", "2026-07-19T00:01:00.000Z", "Second question.", "b"),
				reply("r2", "2026-07-19T00:01:05.000Z", "Second answer.", "b"),
				ask("u3", "2026-07-20T00:00:00.000Z", "Resumed question.", "b"),
				reply("r3", "2026-07-20T00:00:05.000Z", "Resumed answer.", "b"),
			].join("\n"),
		);
		const { turns, stats, omitted } = extractClaude(dir);
		expect(turns.map((t) => [t.source, t.start, ...t.messages.map((m) => m.text)])).toEqual([
			["claude:a", "2026-07-19T00:00:00.000Z", "First question.", "First answer."],
			["claude:a", "2026-07-19T00:01:00.000Z", "Second question.", "Second answer."],
			["claude:b", "2026-07-20T00:00:00.000Z", "Resumed question.", "Resumed answer."],
		]);
		expect(stats).toEqual({ files: 2, lines: 11, skipped: 0, turns: 3 });
		expect(omitted).toEqual(["Skipped 5 copied Claude Code records (a uuid already read, as when a resumed session copies earlier history)."]);
	});

	it("returns nothing for a missing directory", () => {
		expect(extractClaude("/nonexistent/orrery").turns).toEqual([]);
	});
});

describe("named Claude Code sessions", () => {
	it("reads files in the order given, skipping a record already read in an earlier one", () => {
		const dir = tempDir("orrery-claude-files-");
		dirs.push(dir);
		const first = join(dir, "a.jsonl");
		const second = join(dir, "b.jsonl");
		writeFileSync(first, [user("2026-07-20T10:00:00.000Z", "Plan the import.", { uuid: "u1" }), assistant("2026-07-20T10:00:05.000Z", "m1", [{ type: "text", text: "Planned." }])].join("\n"));
		writeFileSync(second, [user("2026-07-20T10:00:00.000Z", "Plan the import.", { uuid: "u1" }), user("2026-07-21T09:00:00.000Z", "Now run it.", { uuid: "u2" })].join("\n"));
		const extracted = extractClaudeFiles([first, second]);
		expect(extracted.stats.files).toBe(2);
		expect(extracted.turns.map((turn) => turn.messages.map((m) => m.text))).toEqual([["Plan the import.", "Planned."], ["Now run it."]]);
		expect(extracted.omitted.join("\n")).toContain("Skipped 1 copied Claude Code records");
	});

	it("accepts a session whose first records carry no sessionId, and refuses a file that is no session", () => {
		const dir = tempDir("orrery-claude-files-");
		dirs.push(dir);
		const session = join(dir, "s.jsonl");
		writeFileSync(session, [line({ type: "summary", summary: "x" }), line({ type: "file-history-snapshot", messageId: "m" }), user("2026-07-20T10:00:00.000Z", "hi")].join("\n"));
		expect(checkClaudeFiles([session, session])).toEqual([session]);
		const notes = join(dir, "notes.jsonl");
		writeFileSync(notes, line({ type: "session_meta", payload: { id: "x" } }));
		expect(() => checkClaudeFiles([notes])).toThrow(/--claude-file .*notes\.jsonl is not a Claude Code session/);
		expect(() => checkClaudeFiles([join(dir, "missing.jsonl")])).toThrow(/is not a readable Claude Code session file/);
	});
});
