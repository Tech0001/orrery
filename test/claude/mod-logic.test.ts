import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { remoteFooter } from "../../src/remote/checkout.ts";
import type { RemoteStatus } from "../../src/remote/types.ts";
import {
	bandHasLogo,
	bandLines,
	bandShows,
	bandAsksAgain,
	bandWaitsForMode,
	compactAnswer,
	compactRoute,
	drawsSomewhere,
	EMPTY_KEEP_TEXT,
	estimateTokens,
	IMAGE_KEEP_TEXT,
	RESULT_KEEP_TEXT,
	fallbackLine,
	footerLabel,
	footerModes,
	isTurnStart,
	lastTurn,
	laterLine,
	parseViewReply,
	personPrompt,
	READ_ONLY_STATE,
	sectionFailedLine,
	shouldCompact,
	skipLine,
	stopLine,
	TURN_WAIT_MS,
	turnBusy,
	turnRefetches,
	turnReplyShown,
	viewArgs,
	type Row,
	type ViewReply,
} from "../../claude-plugin/hooks/mod-logic.ts";

const user = (text: string, extra: Partial<Row> = {}): Row => ({ role: "user", text, toolUses: [], handle: `h${text.length}`, ...extra });
const assistant = (text: string, toolUses: unknown[] = []): Row => ({ role: "assistant", text, toolUses, handle: "a" });
const MOD: ViewReply = { kind: "lane", lane: "L", mode: "mod", compactAt: 200_000, messages: 42, section: "# Memory\n\nview" };

/** Expects the turn after the first `skip` rows to be handed back as Claude Code has it: the very same rows, handles and all. */
function expectKeptAsIs(rows: readonly Row[], skip: number): void {
	const answer = compactAnswer(rows, MOD);
	expect(answer).toMatchObject({ kind: "answer", line: `Orrery compacted: kept the last turn (${rows.length - skip} messages); memory view refreshed (42 messages).` });
	if (answer.kind !== "answer") return;
	expect(answer.messages).toHaveLength(rows.length - skip);
	answer.messages.forEach((kept, i) => expect(kept).toBe(rows[i + skip]));
}

describe("viewArgs and parseViewReply", () => {
	it("runs orrery through the plugin's launcher, waiting only when asked", () => {
		expect(viewArgs("/p", "/w")).toEqual(["sh", "/p/bin/orrery-run", "claude-mod", "view", "--cwd", "/w"]);
		expect(viewArgs("/p", "/w", "s1", 30_000)).toEqual(["sh", "/p/bin/orrery-run", "claude-mod", "view", "--cwd", "/w", "--session", "s1", "--wait-ms", "30000"]);
	});
	it("asks for the spool-only wait only with a wait", () => {
		expect(viewArgs("/p", "/w", "s1", 5_000, true)).toEqual(["sh", "/p/bin/orrery-run", "claude-mod", "view", "--cwd", "/w", "--session", "s1", "--wait-ms", "5000", "--spool-only"]);
		expect(viewArgs("/p", "/w", "s1", 5_000, false)).toEqual(["sh", "/p/bin/orrery-run", "claude-mod", "view", "--cwd", "/w", "--session", "s1", "--wait-ms", "5000"]);
		expect(viewArgs("/p", "/w", "s1", undefined, true)).toEqual(["sh", "/p/bin/orrery-run", "claude-mod", "view", "--cwd", "/w", "--session", "s1"]);
	});
	it("adds the agent and its token to the view call when Claude Code has them", () => {
		expect(viewArgs("/p", "/w", "s", undefined, false, { name: "Atlas", token: "ab".repeat(16) })).toEqual(["sh", "/p/bin/orrery-run", "claude-mod", "view", "--cwd", "/w", "--session", "s", "--agent", "Atlas", "--agent-token", "ab".repeat(16)]);
		expect(viewArgs("/p", "/w", "s", undefined, false, { name: "Atlas" })).toEqual(["sh", "/p/bin/orrery-run", "claude-mod", "view", "--cwd", "/w", "--session", "s", "--agent", "Atlas"]);
		expect(viewArgs("/p", "/w", "s", 5_000, true, { name: "Atlas" })).toEqual(["sh", "/p/bin/orrery-run", "claude-mod", "view", "--cwd", "/w", "--session", "s", "--wait-ms", "5000", "--spool-only", "--agent", "Atlas"]);
	});
	it("reads each reply", () => {
		expect(parseViewReply({ exitCode: 0, stdout: "" })).toEqual({ kind: "outside" });
		expect(parseViewReply({ exitCode: 0, stdout: '{"lane":null}\n' })).toEqual({ kind: "outside" });
		expect(parseViewReply({ exitCode: 0, stdout: '{"lane":"L","mode":"mod","compactAt":200000,"messages":42,"section":"# Memory\\n\\nview"}\n' })).toEqual(MOD);
		expect(parseViewReply({ exitCode: 1, stdout: '{"error":"bad \\u001b[31mconfig"}' })).toEqual({ kind: "error", text: "bad  [31mconfig" });
		expect(parseViewReply({ exitCode: 0, stdout: "garbage" })).toMatchObject({ kind: "error" });
		expect(parseViewReply({ exitCode: 0, stdout: '{"lane":"L","mode":"weird"}' })).toMatchObject({ kind: "error" });
	});
	it("reads the instructions section, and refuses one that is not text", () => {
		const reply = (extra: object) => parseViewReply({ exitCode: 0, stdout: JSON.stringify({ lane: "Test", mode: "mod", compactAt: 200_000, messages: 2, section: "M", ...extra }) });
		expect(reply({ instructions: "# Agent: Test\n\nYou are Test." })).toMatchObject({ kind: "lane", instructions: "# Agent: Test\n\nYou are Test." });
		expect(reply({ instructions: null })).toMatchObject({ kind: "lane", instructions: null });
		expect(reply({ instructions: 7 })).toEqual({ kind: "error", text: "orrery answered something unexpected" });
		// An older orrery says nothing of instructions: none, as before.
		expect(reply({})).not.toHaveProperty("instructions");
	});
	it("reads whether the session is recorded: absent stays absent, anything but a boolean is an error", () => {
		const reply = (recording: string) => `{"lane":"L","mode":"mod","compactAt":200000,"messages":42,"section":"# Memory\\n\\nview","recording":${recording}}`;
		expect(parseViewReply({ exitCode: 0, stdout: reply("true") })).toEqual({ ...MOD, recording: true });
		expect(parseViewReply({ exitCode: 0, stdout: reply("false") })).toEqual({ ...MOD, recording: false });
		expect(parseViewReply({ exitCode: 0, stdout: reply('"yes"') })).toMatchObject({ kind: "error" });
		expect(parseViewReply({ exitCode: 0, stdout: reply("null") })).toMatchObject({ kind: "error" });
		expect(parseViewReply({ exitCode: 0, stdout: '{"lane":"L","mode":"mod","compactAt":200000,"messages":42,"section":"v"}' })).not.toHaveProperty("recording");
	});
	it("reads what the session's mode file says: absent stays absent, anything but recording or read-only is an error", () => {
		const reply = (sessionMode: string) => `{"lane":"L","mode":"mod","compactAt":200000,"messages":42,"section":"# Memory\\n\\nview","recording":false,"sessionMode":${sessionMode}}`;
		expect(parseViewReply({ exitCode: 0, stdout: reply('"recording"') })).toEqual({ ...MOD, recording: false, sessionMode: "recording" });
		expect(parseViewReply({ exitCode: 0, stdout: reply('"read-only"') })).toEqual({ ...MOD, recording: false, sessionMode: "read-only" });
		expect(parseViewReply({ exitCode: 0, stdout: reply('"busy"') })).toMatchObject({ kind: "error" });
		expect(parseViewReply({ exitCode: 0, stdout: reply("null") })).toMatchObject({ kind: "error" });
		expect(parseViewReply({ exitCode: 0, stdout: reply("true") })).toMatchObject({ kind: "error" });
		expect(parseViewReply({ exitCode: 0, stdout: '{"lane":"L","mode":"mod","compactAt":200000,"messages":42,"section":"v","recording":true}' })).not.toHaveProperty("sessionMode");
	});
});

describe("the last turn", () => {
	it("starts at the last real prompt, skipping Claude Code's own rows", () => {
		const rows = [
			user("first prompt"), assistant("first answer"),
			user("second prompt"), assistant("", [{ name: "Bash" }]), user("", { toolResults: [{ text: "ok" }] }), assistant("second answer"),
			user("<command-name>/context</command-name>\n            <command-message>context</command-message>"),
			user("<local-command-stdout>\u001b[2mContext usage\u001b[22m</local-command-stdout>"),
			user("Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages"),
			assistant(""),
		];
		expect(lastTurn(rows)).toEqual(rows.slice(2));
	});
	it("does not take Claude Code's summary row, Orrery's own row, an interruption note or a reminder-only row for a prompt", () => {
		for (const text of ["This session is being continued from a previous conversation that ran out of context.", EMPTY_KEEP_TEXT, "[Request interrupted by user]", "<system-reminder>x</system-reminder>\n"]) {
			expect(isTurnStart(user(text))).toBe(false);
		}
		expect(isTurnStart(user("<system-reminder>x</system-reminder>\nreal words"))).toBe(true);
		expect(isTurnStart(user("<task-notification>report</task-notification>"))).toBe(true);
		expect(isTurnStart(assistant("hi"))).toBe(false);
	});
	it("is empty when there is no prompt", () => {
		expect(lastTurn([assistant("x"), user("", { toolResults: [{}] })])).toEqual([]);
	});
});

describe("compaction", () => {
	it("tells a refusal for a running turn (tried again after the turn) from a lasting one", () => {
		expect(turnBusy(new Error("orrery: $.session.compact: a turn is running (f4e2); the conversation compacts between turns, so call it from turn.complete or later"))).toBe(true);
		expect(turnBusy(new Error("orrery: $.session.compact: a turn is in flight; the conversation compacts between turns"))).toBe(true);
		expect(turnBusy("a newer turn began before the compaction could be applied")).toBe(true);
		expect(turnBusy(new Error("the compaction produced no summary"))).toBe(false);
		expect(turnBusy(new Error("plugin compaction refused"))).toBe(false);
	});

	it("routes: subagents and other agents pass, precompute is skipped in a mod agent, the rest fetch", () => {
		expect(compactRoute("manual", "agent-1", MOD)).toBe("pass");
		expect(compactRoute("manual", undefined, { kind: "outside" })).toBe("pass");
		expect(compactRoute("auto", undefined, { ...MOD, mode: "file" })).toBe("pass");
		expect(compactRoute("precompute", undefined, MOD)).toBe("skip");
		expect(compactRoute("precompute", undefined, { kind: "error", text: "x" })).toBe("pass");
		expect(compactRoute("precompute", undefined, undefined)).toBe("pass");
		for (const trigger of ["manual", "auto", "plugin"]) expect(compactRoute(trigger, undefined, MOD)).toBe("fetch");
		expect(compactRoute("manual", undefined, { kind: "error", text: "x" })).toBe("fetch");
		expect(compactRoute("manual", undefined, undefined)).toBe("fetch");
	});
	it("answers with the last turn, every row built (no handle, so nothing Claude Code attached rides along), and the new section", () => {
		const rows = [user("old"), assistant("old answer"), user("new"), assistant("new answer")];
		const answer = compactAnswer(rows, MOD);
		expect(answer).toEqual({
			kind: "answer",
			messages: [
				{ role: "user", text: "new", toolUses: [] },
				{ role: "assistant", text: "new answer", toolUses: [] },
			],
			section: MOD.section,
			line: "Orrery compacted: kept the last turn (2 messages); memory view refreshed (42 messages).",
		});
		if (answer.kind === "answer") for (const kept of answer.messages) expect(kept).not.toHaveProperty("handle");
	});
	it("builds a finished tool turn's rows with their tool calls and results", () => {
		const call = { tool_use_id: "t1", tool: "Bash", input: { command: "ls" }, text: "a b" };
		const result = { tool_use_id: "t1", text: "a b", isError: false };
		const rows = [user("old"), assistant("old answer"), user("go"), assistant("", [call]), user("", { toolResults: [result] }), assistant("done")];
		expect(compactAnswer(rows, MOD)).toEqual({
			kind: "answer",
			messages: [
				{ role: "user", text: "go", toolUses: [] },
				{ role: "assistant", text: "", toolUses: [call] },
				{ role: "user", text: "", toolUses: [], toolResults: [result] },
				{ role: "assistant", text: "done", toolUses: [] },
			],
			section: MOD.section,
			line: "Orrery compacted: kept the last turn (4 messages); memory view refreshed (42 messages).",
		});
	});
	it("leaves out a row with no text, no tool calls and no tool results (a thinking-only reply), and counts only the rows handed back", () => {
		const rows = [user("go"), assistant(""), assistant("the answer")];
		expect(compactAnswer(rows, MOD)).toMatchObject({
			kind: "answer",
			messages: [
				{ role: "user", text: "go", toolUses: [] },
				{ role: "assistant", text: "the answer", toolUses: [] },
			],
			line: "Orrery compacted: kept the last turn (2 messages); memory view refreshed (42 messages).",
		});
	});
	it("keeps a turn still in progress (its last row calls tools or carries their results) as Claude Code has it, handles and all", () => {
		const call = { tool_use_id: "t1", tool: "Bash", input: { command: "ls" } };
		const calling = [user("old"), assistant("old answer"), user("go"), assistant(""), assistant("", [call])];
		const answered = [...calling, user("", { toolResults: [{ tool_use_id: "t1", text: "a b" }] })];
		for (const rows of [calling, answered]) expectKeptAsIs(rows, 2);
	});
	it("a turn stopped in its tool loop is still in progress: past interruption notes and rows that carry nothing, the last real row calls tools or carries results", () => {
		const call = { tool_use_id: "t1", tool: "Bash", input: { command: "ls" } };
		const loop = [user("old"), assistant("old answer"), user("go"), assistant(""), assistant("", [call]), user("", { toolResults: [{ tool_use_id: "t1", text: "a b" }] })];
		// Esc during the tool call: Claude Code adds its note after the tool's result.
		expectKeptAsIs([...loop, user("[Request interrupted by user for tool use]")], 2);
		// Esc while the model thinks after the result: a thinking-only reply, or the note.
		expectKeptAsIs([...loop, assistant("")], 2);
		expectKeptAsIs([...loop, user("[Request interrupted by user]")], 2);
		expectKeptAsIs([...loop, assistant(""), user("[Request interrupted by user]")], 2);
		// Esc during the call itself, before any result.
		expectKeptAsIs([...loop.slice(0, -1), user("[Request interrupted by user for tool use]")], 2);
	});
	it("a turn whose last real row is the final answer is finished, whatever notes or command rows follow it", () => {
		const call = { tool_use_id: "t1", tool: "Bash", input: { command: "ls" } };
		const result = { tool_use_id: "t1", text: "a b" };
		const done = [user("go"), assistant("", [call]), user("", { toolResults: [result] }), assistant("done")];
		const built = [
			{ role: "user", text: "go", toolUses: [] },
			{ role: "assistant", text: "", toolUses: [call] },
			{ role: "user", text: "", toolUses: [], toolResults: [result] },
			{ role: "assistant", text: "done", toolUses: [] },
		];
		const note = "[Request interrupted by user]";
		expect(compactAnswer([...done, user(note)], MOD)).toMatchObject({ kind: "answer", messages: [...built, { role: "user", text: note, toolUses: [] }] });
		const command = "<command-name>/context</command-name>";
		const output = "<local-command-stdout>Context usage</local-command-stdout>";
		expect(compactAnswer([...done, user(command), user(output)], MOD)).toMatchObject({
			kind: "answer",
			messages: [...built, { role: "user", text: command, toolUses: [] }, { role: "user", text: output, toolUses: [] }],
		});
		expect(compactAnswer(done, MOD)).toMatchObject({ kind: "answer", messages: built });
	});
	it("an image-only prompt row and a tool result with no text are built with a placeholder text, not dropped or left empty", () => {
		expect(IMAGE_KEEP_TEXT).toBe("(an image; Orrery's compaction does not keep images)");
		// A tool that printed nothing also has no text, so its placeholder does not claim an image.
		expect(RESULT_KEEP_TEXT).toBe("(no text; Orrery's compaction does not keep images)");
		const call = { tool_use_id: "t1", tool: "Read", input: { file_path: "/x.png" } };
		const rows = [user("go"), assistant("first"), user(""), assistant("", [call]), user("", { toolResults: [{ tool_use_id: "t1", text: "", isError: false }] }), assistant("a cat")];
		expect(compactAnswer(rows, MOD)).toMatchObject({
			kind: "answer",
			messages: [
				{ role: "user", text: "go", toolUses: [] },
				{ role: "assistant", text: "first", toolUses: [] },
				{ role: "user", text: IMAGE_KEEP_TEXT, toolUses: [] },
				{ role: "assistant", text: "", toolUses: [call] },
				{ role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: "t1", text: RESULT_KEEP_TEXT, isError: false }] },
				{ role: "assistant", text: "a cat", toolUses: [] },
			],
			line: "Orrery compacted: kept the last turn (6 messages); memory view refreshed (42 messages).",
		});
	});
	it("answers one built row when nothing is kept", () => {
		expect(compactAnswer([assistant("x")], MOD)).toEqual({
			kind: "answer",
			messages: [{ role: "user", text: EMPTY_KEEP_TEXT, toolUses: [] }],
			section: MOD.section,
			line: "Orrery compacted: kept the last turn (0 messages); memory view refreshed (42 messages).",
		});
	});
	it("falls back when the view cannot be read, the agent has no memory or left mod mode, or the last turn is too large", () => {
		const why = (text: string) => ({ kind: "fallback", why: text, line: fallbackLine(text), lasting: true });
		expect(compactAnswer([user("a")], { kind: "error", text: "store locked" })).toEqual(why("the memory view could not be read: store locked"));
		expect(compactAnswer([user("a")], { ...MOD, section: null })).toEqual(why("the agent has no memory yet"));
		expect(compactAnswer([user("a")], { ...MOD, mode: "file" })).toEqual(why("this folder's agent is no longer in mod mode"));
		expect(compactAnswer([user("a")], { ...MOD, recording: false })).toEqual(why("this session is not recorded"));
		expect(compactAnswer([user("a")], { ...MOD, recording: false, section: null })).toEqual(why("this session is not recorded"));
		expect(compactAnswer([user("a")], { ...MOD, recording: true })).toMatchObject({ kind: "answer" });
		const big = [user("go"), assistant("", [{ input: "x".repeat(400_004) }])];
		const tooBig = compactAnswer(big, MOD);
		// Only this cause passes with the turn: a compaction the mod started then tries again later.
		expect(tooBig).toMatchObject({ kind: "fallback", why: expect.stringMatching(/^the last turn is too large to keep \(about 100\d{3} tokens\)$/), lasting: false });
		if (tooBig.kind === "fallback") expect(tooBig.line).toBe(fallbackLine(tooBig.why));
		expect(fallbackLine("why")).toBe("Orrery could not compact this conversation (why); Claude Code compacts it its own way.");
	});
	it("passes silently when the session never had a mod agent and still has none", () => {
		const rows = [user("a")];
		const error: ViewReply = { kind: "error", text: "store locked" };
		expect(compactAnswer(rows, { kind: "outside" }, error)).toEqual({ kind: "pass" });
		expect(compactAnswer(rows, { ...MOD, mode: "file" }, error)).toEqual({ kind: "pass" });
		expect(compactAnswer(rows, { ...MOD, mode: "none" }, { kind: "outside" })).toEqual({ kind: "pass" });
		// The first fetch failed, and now the agent answers: Orrery compacts.
		expect(compactAnswer(rows, MOD, error)).toMatchObject({ kind: "answer" });
		// Still unreadable: said.
		expect(compactAnswer(rows, error, error)).toMatchObject({ kind: "fallback", why: "the memory view could not be read: store locked" });
		// A session that had a mod agent: said.
		expect(compactAnswer(rows, { kind: "outside" }, MOD)).toMatchObject({ kind: "fallback", why: "this folder's agent is no longer in mod mode", lasting: true });
	});
	it("falls back when the session's folder now belongs to another agent", () => {
		const rows = [user("a")];
		const other: ViewReply = { ...MOD, lane: "Other" };
		expect(compactAnswer(rows, other, MOD)).toEqual({ kind: "fallback", why: "this session's folder now belongs to another agent", line: fallbackLine("this session's folder now belongs to another agent"), lasting: true });
		expect(compactAnswer(rows, MOD, MOD)).toMatchObject({ kind: "answer" });
	});
	it("estimates tokens as characters / 4, tool inputs and results included", () => {
		expect(estimateTokens([user("abcd")])).toBe(1);
		expect(estimateTokens([assistant("", [{ input: "x".repeat(396) }])])).toBeGreaterThanOrEqual(100);
	});
	it("counts a tool's output once, as the model read it, whichever fields carry it", () => {
		const big = "x".repeat(100_000);
		const rows = [
			user("go"),
			assistant("", [{ tool_use_id: "t1", tool: "Bash", input: { command: "ls" }, text: big, result: { stdout: big } }]),
			user("", { toolResults: [{ tool_use_id: "t1", text: big, isError: false, result: { stdout: big } }] }),
		];
		expect(estimateTokens(rows)).toBeGreaterThanOrEqual(25_000);
		expect(estimateTokens(rows)).toBeLessThan(25_100);
		// Its result row not among the rows (the call still in flight, say): the tool use's own text counts instead.
		expect(estimateTokens(rows.slice(0, 2))).toBeGreaterThanOrEqual(25_000);
		expect(estimateTokens(rows.slice(0, 2))).toBeLessThan(25_100);
	});
	it("counts data it cannot serialize as large, not as nothing", () => {
		const loop: Record<string, unknown> = {};
		loop.self = loop;
		for (const input of [{ n: 1n }, loop]) expect(estimateTokens([assistant("", [{ tool_use_id: "t1", input }])])).toBeGreaterThanOrEqual(25_000);
	});
	it("compacts past compact_at only in a mod agent", () => {
		expect(shouldCompact(200_001, MOD)).toBe(true);
		expect(shouldCompact(200_000, MOD)).toBe(false);
		expect(shouldCompact(undefined, MOD)).toBe(false);
		expect(shouldCompact(900_000, { ...MOD, mode: "file" })).toBe(false);
		expect(shouldCompact(900_000, undefined)).toBe(false);
	});
	it("its lines carry no control characters", () => {
		expect(sectionFailedLine("x\u001b]0;y")).toBe("Orrery: no memory in this session's prompt (x ]0;y). Recording is not affected.");
		expect(stopLine("not available in a headless session")).toBe("Orrery will not start compactions in this session (not available in a headless session); /compact still uses Orrery.");
		expect(laterLine("the last turn\u001b[31m is too large")).toBe("Orrery could not compact this conversation (the last turn [31m is too large); it stays as it is for now.");
		expect(skipLine("the agent has no memory\u001b[31m yet")).toBe("Orrery could not compact this conversation (the agent has no memory [31m yet); it stays as it is, and Orrery will not start compactions in this session.");
	});
});

describe("showing that the mod is loaded (spec section 11)", () => {
	it("the band's two lines: the agent, then memory and the session's mode as its mode file says", () => {
		expect(bandLines({ ...MOD, sessionMode: "recording" })).toEqual(["Orrery · L", "memory loaded · 42 msgs · recording"]);
		expect(bandLines({ ...MOD, section: null, messages: 0, sessionMode: "recording" })).toEqual(["Orrery · L", "no memory yet · recording"]);
		expect(bandLines({ ...MOD, sessionMode: "read-only" })).toEqual(["Orrery · L", "memory loaded · 42 msgs · read-only (another window records this agent)"]);
		expect(bandLines({ ...MOD, section: null, sessionMode: "read-only" })).toEqual(["Orrery · L", "no memory yet · read-only (another window records this agent)"]);
		expect(READ_ONLY_STATE).toBe("read-only (another window records this agent)");
		// Not known yet: the mode part is left out. `recording` (whether the turns reach memory now) does not decide it.
		expect(bandLines(MOD)).toEqual(["Orrery · L", "memory loaded · 42 msgs"]);
		expect(bandLines({ ...MOD, recording: true })).toEqual(["Orrery · L", "memory loaded · 42 msgs"]);
		expect(bandLines({ ...MOD, section: null, recording: false })).toEqual(["Orrery · L", "no memory yet"]);
		expect(bandLines({ ...MOD, lane: "Bad\u001b[31mName" })).toEqual(["Orrery · Bad [31mName", "memory loaded · 42 msgs"]);
	});
	it("no band outside a mod-mode agent", () => {
		expect(bandLines(undefined)).toBeUndefined();
		expect(bandLines({ kind: "outside" })).toBeUndefined();
		expect(bandLines({ kind: "error", text: "x" })).toBeUndefined();
		expect(bandLines({ ...MOD, mode: "file", sessionMode: "recording" })).toBeUndefined();
		expect(bandLines({ ...MOD, mode: "none" })).toBeUndefined();
	});
	it("the band waits to learn the session's mode while a mod agent's session has no mode file yet", () => {
		expect(bandWaitsForMode(MOD)).toBe(true);
		expect(bandWaitsForMode({ ...MOD, section: null, recording: false })).toBe(true);
		expect(bandWaitsForMode({ ...MOD, sessionMode: "recording" })).toBe(false);
		expect(bandWaitsForMode({ ...MOD, sessionMode: "read-only" })).toBe(false);
		expect(bandWaitsForMode({ ...MOD, mode: "file" })).toBe(false);
		expect(bandWaitsForMode({ kind: "outside" })).toBe(false);
		expect(bandWaitsForMode(undefined)).toBe(false);
	});
	it("the band asks again while it has no answer, only an error, or a mod agent's session mode is not known yet", () => {
		expect(bandAsksAgain(undefined)).toBe(true);
		expect(bandAsksAgain({ kind: "error", text: "store locked" })).toBe(true);
		expect(bandAsksAgain(MOD)).toBe(true);
		expect(bandAsksAgain({ ...MOD, sessionMode: "recording" })).toBe(false);
		expect(bandAsksAgain({ ...MOD, sessionMode: "read-only" })).toBe(false);
		expect(bandAsksAgain({ ...MOD, mode: "file" })).toBe(false);
		expect(bandAsksAgain({ kind: "outside" })).toBe(false);
	});
	it("the band shows until the person's first prompt, and yields to a survey", () => {
		const lines = bandLines(MOD);
		expect(bandShows(lines, { prompted: false, hasSurvey: false })).toBe(true);
		expect(bandShows(lines, { prompted: true, hasSurvey: false })).toBe(false);
		expect(bandShows(lines, { prompted: false, hasSurvey: true })).toBe(false);
		expect(bandShows(undefined, { prompted: false, hasSurvey: false })).toBe(false);
		expect(personPrompt("composer")).toBe(true);
		expect(personPrompt("bridge")).toBe(true);
		for (const kind of ["sdk", "task-notification", "scheduled-trigger", "peer", "peer-send-message", "plugin", "unclassified"]) expect(personPrompt(kind)).toBe(false);
	});
	it("the logo goes beside the lines on the terminal with 60 columns and 5 rows, else the lines show alone", () => {
		expect(bandHasLogo("terminal", 60, 5)).toBe(true);
		expect(bandHasLogo("terminal", 200, 40)).toBe(true);
		expect(bandHasLogo("terminal", 59, 40)).toBe(false);
		expect(bandHasLogo("terminal", 200, 4)).toBe(false);
		for (const surface of ["desktop", "vscode", "mobile"]) expect(bandHasLogo(surface, 200, 40)).toBe(false);
	});
	it("the footer label reads pi's status text: Orrery, the agent and its message count, in a mod-mode agent only", () => {
		expect(footerLabel(MOD)).toBe("Orrery · L · 42 msgs");
		expect(footerLabel({ ...MOD, section: null, messages: 0, sessionMode: "read-only" })).toBe("Orrery · L · 0 msgs");
		// The agent name is made plain, as the band makes it.
		expect(footerLabel({ ...MOD, lane: "A\u001b[31mB" })).toBe("Orrery · A [31mB · 42 msgs");
		expect(footerLabel({ ...MOD, mode: "file" })).toBeUndefined();
		expect(footerLabel({ kind: "outside" })).toBeUndefined();
		expect(footerLabel({ kind: "error", text: "x" })).toBeUndefined();
		expect(footerLabel(undefined)).toBeUndefined();
	});
	it("the footer label: added to the modes in a mod-mode agent, once; elsewhere the modes stay as they are", () => {
		expect(footerModes([], MOD)).toEqual(["Orrery · L · 42 msgs"]);
		expect(footerModes(["focus"], { ...MOD, section: null })).toEqual(["focus", "Orrery · L · 42 msgs"]);
		// Already there (a re-render handed the drawn modes back), with this count or another: replaced by the current one,
		// exactly one.
		expect(footerModes(["Orrery · L · 42 msgs"], MOD)).toEqual(["Orrery · L · 42 msgs"]);
		expect(footerModes(["focus", "Orrery · L · 41 msgs"], MOD)).toEqual(["focus", "Orrery · L · 42 msgs"]);
		expect(footerModes(["Orrery", "focus", "Orrery · L · 40 msgs"], MOD)).toEqual(["focus", "Orrery · L · 42 msgs"]);
		// Another mode that only starts with the word is not Orrery's.
		expect(footerModes(["Orrery-like"], MOD)).toEqual(["Orrery-like", "Orrery · L · 42 msgs"]);
		expect(footerModes([], { ...MOD, mode: "file" })).toBeUndefined();
		expect(footerModes([], { kind: "outside" })).toBeUndefined();
		expect(footerModes([], { kind: "error", text: "x" })).toBeUndefined();
		expect(footerModes([], undefined)).toBeUndefined();
	});
	it("a turn's end asks for the count again: the main loop's turn, in a mod-mode agent; never a subagent's, nor elsewhere", () => {
		expect(turnRefetches(undefined, MOD)).toBe(true);
		expect(turnRefetches(undefined, { ...MOD, section: null, messages: 0 })).toBe(true);
		expect(turnRefetches("agent-1", MOD)).toBe(false);
		expect(turnRefetches(undefined, { ...MOD, mode: "file" })).toBe(false);
		expect(turnRefetches(undefined, { ...MOD, mode: "none" })).toBe(false);
		expect(turnRefetches(undefined, { kind: "outside" })).toBe(false);
		// No facts yet, or only an error: no run per turn (folders outside any agent must not pay one).
		expect(turnRefetches(undefined, { kind: "error", text: "x" })).toBe(false);
		expect(turnRefetches(undefined, undefined)).toBe(false);
	});
	it("a session that draws nowhere (claude -p, the SDK with no client attached) has no label to keep current", () => {
		expect(drawsSomewhere(["terminal"])).toBe(true);
		expect(drawsSomewhere(["desktop"])).toBe(true);
		expect(drawsSomewhere([])).toBe(false);
	});
	it("a turn's refetch is shown only when it is a mod-mode agent's answer; anything else keeps what the label had", () => {
		expect(turnReplyShown(MOD)).toBe(true);
		expect(turnReplyShown({ ...MOD, section: null, messages: 0 })).toBe(true);
		// orrery briefly missing (empty stdout), a plain claude-setup mid-session, or an error: the label stays.
		expect(turnReplyShown({ kind: "outside" })).toBe(false);
		expect(turnReplyShown({ ...MOD, mode: "file" })).toBe(false);
		expect(turnReplyShown({ ...MOD, mode: "none" })).toBe(false);
		expect(turnReplyShown({ kind: "error", text: "x" })).toBe(false);
	});
	it("the per-turn wait is a few seconds", () => {
		expect(TURN_WAIT_MS).toBeGreaterThanOrEqual(2_000);
		expect(TURN_WAIT_MS).toBeLessThanOrEqual(10_000);
	});
});

it("mod-logic.ts and logo.ts import nothing (mod.ts's own import check is in plugin.test.ts)", () => {
	const dir = new URL("../../claude-plugin/hooks/", import.meta.url).pathname;
	for (const file of ["mod-logic.ts", "logo.ts"]) expect(readFileSync(join(dir, file), "utf8")).not.toMatch(/^\s*import\b|\bimport\(|\brequire\(/m);
});

it("logo.ts is the one copy of the logo: the TUI's art.ts re-exports it, and the art generator writes it", async () => {
	const root = new URL("../../", import.meta.url).pathname;
	const logo = await import("../../claude-plugin/hooks/logo.ts");
	const art = await import("../../src/tui/art.ts");
	expect(art.LOGO).toBe(logo.LOGO);
	expect([art.LOGO_WIDTH, art.LOGO_HEIGHT]).toEqual([logo.LOGO_WIDTH, logo.LOGO_HEIGHT]);
	expect(readFileSync(join(root, "src", "tui", "art.ts"), "utf8")).not.toMatch(/\{ text: "/);
	expect(readFileSync(join(root, "scripts", "orrery-art.ts"), "utf8")).toContain('const OUT = join(ROOT, "claude-plugin", "hooks", "logo.ts");');
});


describe("remote footer", () => {
	it.each<RemoteStatus>([
		{ remote: "home", state: "saved", savedAt: "14:02" },
		{ remote: "home", state: "saved" },
		{ remote: "home", state: "pending" },
		{ remote: "home", state: "failing", reason: "offline" },
		{ remote: "home", state: "failing" },
		{ remote: "home", state: "lost", movedTo: "macbook" },
		{ remote: "home", state: "lost" },
	])("parses and formats $state exactly as remoteFooter", (remote) => {
		const reply = parseViewReply({ exitCode: 0, stdout: JSON.stringify({ ...MOD, remote }) });
		expect(reply).toEqual({ ...MOD, remote });
		expect(footerLabel(reply)).toBe(`Orrery · L · 42 msgs · ${remoteFooter(remote)}`);
		expect(footerModes(["Orrery · old · 1 msgs · old ✓ 12:00", "plan"], reply)).toEqual(["plan", footerLabel(reply)]);
	});
	it.each([null, {}, { remote: "home", state: "unknown" }, { remote: "home", state: "saved", savedAt: 123 }])("rejects malformed remote status %j", (remote) => {
		expect(parseViewReply({ exitCode: 0, stdout: JSON.stringify({ ...MOD, remote }) })).toMatchObject({ kind: "error" });
	});
});
