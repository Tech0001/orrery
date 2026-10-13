/**
 * The Orrery mod against Claude Code's own engine (`claude plugin test claude-plugin`). The test's hooks sit beneath
 * the mod and stand for the engine: they answer the session's id, project root and folder, `process.run` (the `orrery
 * claude-mod view` call, counted), `ui.log` (the transcript lines), the clock (mocked), Claude Code's own prompt,
 * compaction, measurement, turn end and `/compact` command, and the band and footer the engine would draw. Each test uses session
 * ids of its own, since the mod keeps what it learned per session id. The band's refetches are counted per session
 * start, so no test spends another's. The mod also keeps, for the whole process, whether the person has sent a prompt:
 * only the last test sends one.
 */

import type { On, RenderSurface, SessionCompactResult, SessionMessage } from "claude-code";
import { LOGO } from "../hooks/logo.ts";
import { describe, type Engine, expect, mock, type MockClock, type Plugin, test } from "claude-code/testing";

/** The session's project root, where the lane is looked up. */
const ROOT = "/work/agent-Test";
/** The session's working folder, which a shell `cd` moves; never where the lane is looked up. */
const CWD = "/work/agent-Test/src";
const COMPOSE = { model: "claude-sonnet-5-5", promptModel: "claude-sonnet-5-5", surfaces: ["terminal"], tools: [], outputStyle: null, traits: [] } as const;
const BASE = [{ id: "intro", text: "You are Claude Code.", scope: "shared" }] as const;
/** What Claude Code's own compaction answers in these tests. */
const OWN: SessionCompactResult = { messages: [{ role: "user", text: "Claude Code's own summary", toolUses: [] }] };

type Answer = string | { readonly deny: string };

/** The engine beneath the mod, as these tests stand for it. */
interface World {
	session: string;
	/** The session's project root, which `/cd` or a worktree move changes. */
	root: string;
	cwd: string;
	/** When true, `$.session.id()` rejects. */
	denyId: boolean;
	/** What `$.session.surfaces()` answers: where the session draws (none in `claude -p`). */
	surfaces: RenderSurface[];
	/** What each `process.run` answers, in order; the last one repeats. A string is stdout with exit 0. */
	readonly answers: readonly Answer[];
	/** A `process.run` for a session listed here waits for the promise before it answers. */
	readonly hold: Map<string, { readonly reached: () => void; readonly until: Promise<void> }>;
	/** What the test's own `session.compact` answers when the mod passes a compaction on. */
	own: SessionCompactResult;
	/** What runs inside the test's own compaction before it answers (Claude Code's summarizer at work). */
	duringOwn?: () => Promise<void>;
	readonly runs: string[][];
	/** The working folder each `process.run` asked for. */
	readonly cwds: (string | undefined)[];
	readonly lines: string[];
	readonly compacts: string[];
	/** The rows Claude Code's own `/compact` compacts (the test's command hook hands them to the compaction). */
	rows: readonly SessionMessage[];
	readonly clock: MockClock;
	/** The test's engine, through which Claude Code's own /compact compacts (a hook's own `$` may not). */
	engine?: Engine;
}

/** What Claude Code's `/compact` row says (the test's command hook answers it). */
const COMPACTED = "Compacted (ctrl+o to see full summary)";
/** What the engine's own band and footer draw in these tests, when the mod passes them on. */
const ENGINE_BAND = "the engine's band";

function lane(
	mode: "mod" | "file" | "none",
	section: string | null,
	extra: { compactAt?: number; messages?: number; recording?: boolean; sessionMode?: "recording" | "read-only"; name?: string; remote?: { remote: string; state: "saved" | "pending" | "failing" | "lost"; savedAt?: string; reason?: string; movedTo?: string } } = {},
): string {
	const recording = extra.recording === undefined ? {} : { recording: extra.recording };
	const sessionMode = extra.sessionMode === undefined ? {} : { sessionMode: extra.sessionMode };
	return JSON.stringify({ lane: extra.name ?? "Test", mode, compactAt: extra.compactAt ?? 200_000, messages: extra.messages ?? 10, section, ...recording, ...sessionMode, ...(extra.remote === undefined ? {} : { remote: extra.remote }) });
}

function world(on: On, session: string, answers: readonly Answer[]): World {
	const w: World = { session, root: ROOT, cwd: CWD, denyId: false, surfaces: ["terminal"], answers, hold: new Map(), own: OWN, runs: [], cwds: [], lines: [], compacts: [], rows: ROWS, clock: mock.clock(on) };
	on("session.id", () => (w.denyId ? { deny: "no session id here" } : { value: w.session }));
	on("session.root", () => ({ value: w.root }));
	on("session.cwd", () => ({ value: w.cwd }));
	on("session.surfaces", () => ({ value: [...w.surfaces] }));
	on("process.run", async ($, e) => {
		w.runs.push([...e.argv]);
		w.cwds.push(e.init?.cwd);
		const answer = w.answers[Math.min(w.runs.length, w.answers.length) - 1] ?? "";
		const session = e.argv[e.argv.indexOf("--session") + 1] ?? "";
		const held = w.hold.get(session);
		if (held !== undefined) {
			held.reached();
			await held.until;
		}
		if (typeof answer !== "string") return { deny: answer.deny };
		return { value: { exitCode: 0, stdout: answer, stderr: "", isStdoutTruncated: false, isStderrTruncated: false } };
	});
	on("ui.log", ($, e) => {
		w.lines.push(e.text);
		return { value: undefined };
	});
	on("prompt.compose", () => ({ sections: BASE }));
	on("session.compact", async ($, e) => {
		w.compacts.push(e.trigger);
		await w.duringOwn?.();
		return w.own;
	});
	on("session.measure", ($, e) => ({ changed: [...e.changed] }));
	on("turn.complete", ($, e) => ({ text: e.answer }));
	on("session.start", ($, e) => ({ cwd: e.cwd }));
	// Claude Code's /compact: it compacts the conversation (through every plugin's session.compact) and prints its row.
	on("command.run", { command: "compact" }, async () => {
		await w.engine?.session.compact({ trigger: "manual", messages: w.rows });
		return { text: COMPACTED };
	});
	on("ui.render", { component: "AbovePrompt" }, ($, e) => $.ui.resolve(e).Text({ children: ENGINE_BAND }));
	on("ui.render", { component: "SessionMode" }, ($, e) => $.ui.resolve(e).Text({ children: e.props.modes.join(" & ") }));
	return w;
}

/** The person's typed `/compact`, as the engine runs it. */
function typedCompact($: Engine, w: World) {
	w.engine = $;
	return $.command.run({ command: "compact", args: "", origin: { kind: "composer" }, presentation: { isFullscreen: false, columns: 120 } });
}

/** A turn's end, as the engine raises it: the main loop's, or a subagent's with `agentId`. */
function turnEnd($: Engine, agentId?: string) {
	return $.turn.complete({ answer: "done.", durationMs: 1200, isAborted: false, turnId: "t-1", reason: "answer", ...(agentId === undefined ? {} : { agentId }) });
}

/** The `orrery claude-mod view` arguments after `sh <plugin root>/bin/orrery-run`. */
function viewCalls(w: World): string[][] {
	for (const argv of w.runs) {
		expect(argv[0]).toBe("sh");
		expect(argv[1]?.endsWith("/bin/orrery-run")).toBe(true);
	}
	return w.runs.map((argv) => argv.slice(2));
}

function measure(tokens: number, changed: readonly ("context" | "rateLimits" | "cost")[] = ["context"]) {
	return { context: { tokens, window: 1_000_000 }, rateLimits: [], changed: [...changed] };
}

/** A measurement, and what it logs on the clock's next tick (the line of a compaction it started) logged. */
async function measured($: Engine, w: World, measurement: ReturnType<typeof measure>): Promise<void> {
	await $.session.measure(measurement);
	await w.clock.settle();
}

function row(role: "user" | "assistant", text: string, handle: string): SessionMessage {
	return { role, text, toolUses: [], handle };
}

const ROWS: SessionMessage[] = [row("user", "the old question", "h1"), row("assistant", "the old answer", "h2"), row("user", "the new question", "h3"), row("assistant", "the new answer", "h4")];
const MEMORY = (text: string) => [...BASE, { id: "orrery:memory", text, scope: "session" }];
/** ROWS' last turn as Orrery hands it back: built rows, no handles, so nothing Claude Code attached to them is kept. */
const BUILT_LAST_TURN: SessionMessage[] = [{ role: "user", text: "the new question", toolUses: [] }, { role: "assistant", text: "the new answer", toolUses: [] }];

/**
 * The kit raises a plugin's own `$.session.compact()` with no transcript and no trigger; a real session stamps both
 * (the spike saw trigger `plugin` and the rows). This plugin, loaded above the mod, adds the transcript: a hook cannot
 * add the trigger (it is pinned), so the mod sees none there.
 */
const TRANSCRIPT: Plugin = {
	name: "transcript",
	tier: "prepend",
	register(on) {
		on("session.compact", ($, e, next) => next(e.messages === undefined ? { ...e, messages: [{ role: "user", text: "the question", toolUses: [] }, { role: "assistant", text: "the answer", toolUses: [] }] } : e));
	},
};

/** Another plugin, above the mod, that refuses every compaction. */
const REFUSER: Plugin = {
	name: "refuser",
	tier: "prepend",
	register(on) {
		on("session.compact", () => ({ skip: "refused above the mod" }));
	},
};

describe("the Orrery mod's memory section", () => {
	test("a mod lane gets orrery:memory once per session id", async ($, on) => {
		const w = world(on, "s-1", [lane("mod", "MEMORY A")]);
		const first = await $.prompt.compose(COMPOSE);
		expect(first.sections).toEqual(MEMORY("MEMORY A"));
		const second = await $.prompt.compose(COMPOSE);
		expect(second.sections).toEqual(first.sections);
		expect(viewCalls(w)).toEqual([["claude-mod", "view", "--cwd", ROOT, "--session", "s-1"]]);
		expect(w.lines).toEqual([]);
	});

	test("the lane is looked up from the project root, not the folder a shell cd moved to", async ($, on) => {
		const w = world(on, "s-1r", [lane("mod", "MEMORY A"), lane("mod", "MEMORY B")]);
		w.cwd = "/somewhere/else";
		await $.prompt.compose(COMPOSE);
		w.cwd = "/work/agent-Other";
		await $.session.compact({ trigger: "manual", messages: ROWS });
		expect(viewCalls(w).map((argv) => argv[argv.indexOf("--cwd") + 1])).toEqual([ROOT, ROOT]);
	});

	test("the lane is looked up from the first project root, also after /cd or a worktree move, and orrery runs there", async ($, on) => {
		const w = world(on, "s-1m", [lane("mod", "MEMORY A"), lane("mod", "MEMORY B")]);
		await $.prompt.compose(COMPOSE);
		w.root = "/work/agent-Moved";
		await $.session.compact({ trigger: "manual", messages: ROWS });
		expect(viewCalls(w).map((argv) => argv[argv.indexOf("--cwd") + 1])).toEqual([ROOT, ROOT]);
		expect(w.cwds).toEqual([ROOT, ROOT]);
	});

	test("a new session id (as after /clear) asks orrery again", async ($, on) => {
		const w = world(on, "s-2a", [lane("mod", "MEMORY A"), lane("mod", "MEMORY B")]);
		await $.prompt.compose(COMPOSE);
		w.session = "s-2b";
		const after = await $.prompt.compose(COMPOSE);
		expect(after.sections).toEqual(MEMORY("MEMORY B"));
		expect(viewCalls(w).map((argv) => argv.at(-1))).toEqual(["s-2a", "s-2b"]);
	});

	test("a late first fetch for an old session does not take the current session's place", { plugins: [TRANSCRIPT] }, async ($, on) => {
		const w = world(on, "s-2c", [lane("mod", "MEMORY OLD"), lane("mod", "MEMORY NEW"), lane("mod", "MEMORY NEWER")]);
		let reached!: () => void;
		let release!: () => void;
		const arrived = new Promise<void>((resolve) => (reached = resolve));
		w.hold.set("s-2c", { reached: () => reached(), until: new Promise<void>((resolve) => (release = resolve)) });
		const late = $.prompt.compose(COMPOSE);
		await arrived;
		w.session = "s-2d";
		expect((await $.prompt.compose(COMPOSE)).sections).toEqual(MEMORY("MEMORY NEW"));
		release();
		await late;
		// The session that is current now still starts its compaction past compact_at.
		await measured($, w, measure(250_000));
		expect(viewCalls(w).map((argv) => argv.slice(5))).toEqual([["s-2c"], ["s-2d"], ["s-2d", "--wait-ms", "30000"]]);
		expect(w.lines).toEqual(["Orrery compacted: kept the last turn (2 messages); memory view refreshed (10 messages)."]);
	});

	test("a file lane and a folder outside any lane get nothing, and Claude Code compacts its own way", async ($, on) => {
		const w = world(on, "s-3a", [lane("file", null), JSON.stringify({ lane: null }), ""]);
		for (const session of ["s-3a", "s-3b", "s-3c"]) {
			w.session = session;
			expect((await $.prompt.compose(COMPOSE)).sections).toEqual(BASE);
			expect(await $.session.compact({ trigger: "manual", messages: ROWS })).toEqual(OWN);
		}
		expect(w.runs).toHaveLength(3);
		expect(w.compacts).toEqual(["manual", "manual", "manual"]);
		expect(w.lines).toEqual([]);
	});
});

describe("the Orrery mod's compaction", () => {
	test("a mod lane's /compact keeps the last turn and refreshes the section, with no model call", async ($, on) => {
		const w = world(on, "s-4", [lane("mod", "MEMORY A"), lane("mod", "MEMORY B", { messages: 12 })]);
		await $.prompt.compose(COMPOSE);
		const done = await $.session.compact({ trigger: "manual", messages: ROWS });
		expect(done).toEqual({ messages: BUILT_LAST_TURN });
		expect(viewCalls(w)).toEqual([
			["claude-mod", "view", "--cwd", ROOT, "--session", "s-4"],
			["claude-mod", "view", "--cwd", ROOT, "--session", "s-4", "--wait-ms", "30000"],
		]);
		const after = await $.prompt.compose(COMPOSE);
		expect(after.sections).toEqual(MEMORY("MEMORY B"));
		expect(w.runs).toHaveLength(2);
		expect(w.compacts).toEqual([]);
		expect(w.lines).toEqual(["Orrery compacted: kept the last turn (2 messages); memory view refreshed (12 messages)."]);
	});

	test("a mod lane skips Claude Code's precompute without asking orrery again", async ($, on) => {
		const w = world(on, "s-5", [lane("mod", "MEMORY A")]);
		await $.prompt.compose(COMPOSE);
		expect(await $.session.compact({ trigger: "precompute", messages: ROWS })).toEqual({ skip: "Orrery answers this lane's compactions itself" });
		expect(w.runs).toHaveLength(1);
		expect(w.compacts).toEqual([]);
	});

	test("a subagent's compaction passes on", async ($, on) => {
		const w = world(on, "s-6", [lane("mod", "MEMORY A")]);
		await $.prompt.compose(COMPOSE);
		expect(await $.session.compact({ trigger: "auto", agentId: "agent-1", messages: ROWS })).toEqual(OWN);
		expect(w.runs).toHaveLength(1);
		expect(w.compacts).toEqual(["auto"]);
	});

	test("when orrery cannot be run at a /compact, Claude Code compacts its own way and one line after the command says why", async ($, on) => {
		const w = world(on, "s-7", [lane("mod", "MEMORY A"), { deny: "no orrery here" }]);
		await $.prompt.compose(COMPOSE);
		expect(await typedCompact($, w)).toMatchObject({ text: COMPACTED });
		expect(w.compacts).toEqual(["manual"]);
		await w.clock.settle();
		expect(w.lines).toHaveLength(1);
		expect(w.lines[0]).toMatch(/^Orrery could not compact this conversation \(the memory view could not be read: orrery did not answer: .+\); Claude Code compacts it its own way\.$/);
		expect((await $.prompt.compose(COMPOSE)).sections).toEqual(MEMORY("MEMORY A"));
	});

	test("a session that is not recorded keeps its conversation: /compact is Claude Code's own, and one line after it says why", async ($, on) => {
		const w = world(on, "s-7c", [lane("mod", "MEMORY A"), lane("mod", "MEMORY B", { recording: false })]);
		await $.prompt.compose(COMPOSE);
		expect(await typedCompact($, w)).toMatchObject({ text: COMPACTED });
		expect(w.compacts).toEqual(["manual"]);
		await w.clock.settle();
		expect(w.lines).toEqual(["Orrery could not compact this conversation (this session is not recorded); Claude Code compacts it its own way."]);
		expect((await $.prompt.compose(COMPOSE)).sections).toEqual(MEMORY("MEMORY A"));
	});

	test("a session whose first fetch failed, in a folder that has no mod lane now, compacts Claude Code's way and says nothing more", async ($, on) => {
		const w = world(on, "s-7d", [JSON.stringify({ error: "the store is busy" }), JSON.stringify({ lane: null }), lane("file", null)]);
		await $.prompt.compose(COMPOSE);
		expect(w.lines).toEqual(["Orrery: no memory in this session's prompt (the store is busy). Recording is not affected."]);
		expect(await $.session.compact({ trigger: "manual", messages: ROWS })).toEqual(OWN);
		expect(await $.session.compact({ trigger: "auto", messages: ROWS })).toEqual(OWN);
		expect(w.compacts).toEqual(["manual", "auto"]);
		expect(w.lines).toHaveLength(1);
	});

	test("a session whose folder now belongs to another lane compacts Claude Code's way, and one line at the next event says why", async ($, on) => {
		const w = world(on, "s-7e", [lane("mod", "MEMORY A"), lane("mod", "MEMORY OTHER", { name: "Other" })]);
		await $.prompt.compose(COMPOSE);
		expect(await $.session.compact({ trigger: "auto", messages: ROWS })).toEqual(OWN);
		expect(w.lines).toEqual([]);
		expect((await $.prompt.compose(COMPOSE)).sections).toEqual(MEMORY("MEMORY A"));
		expect(w.lines).toEqual(["Orrery could not compact this conversation (this session's folder now belongs to another lane); Claude Code compacts it its own way."]);
	});

	test("Orrery's line about Claude Code's own compaction is kept once that compaction is done, so nothing inside it shows the line", async ($, on) => {
		const w = world(on, "s-7f", [lane("mod", "MEMORY A"), lane("mod", "MEMORY OTHER", { name: "Other" })]);
		await $.prompt.compose(COMPOSE);
		let inside: string[] | undefined;
		w.duringOwn = async () => {
			// Claude Code's summarizer composes a prompt of its own while it compacts.
			await $.prompt.compose(COMPOSE);
			inside = [...w.lines];
		};
		expect(await $.session.compact({ trigger: "auto", messages: ROWS })).toEqual(OWN);
		expect(inside).toEqual([]);
		await $.prompt.compose(COMPOSE);
		expect(w.lines).toEqual(["Orrery could not compact this conversation (this session's folder now belongs to another lane); Claude Code compacts it its own way."]);
	});

	test("when Claude Code's own compaction is skipped after all (a classic PreCompact hook blocks it), Orrery says nothing of it", async ($, on) => {
		const w = world(on, "s-7g", [lane("mod", "MEMORY A"), lane("mod", "MEMORY OTHER", { name: "Other" })]);
		w.own = { skip: "blocked by a PreCompact hook" };
		await $.prompt.compose(COMPOSE);
		expect(await $.session.compact({ trigger: "auto", messages: ROWS })).toEqual({ skip: "blocked by a PreCompact hook" });
		await $.prompt.compose(COMPOSE);
		await measured($, w, measure(10_000));
		expect(w.lines).toEqual([]);
	});

	test("when the hook fails part way through a compaction, Claude Code compacts its own way and one line at the next event says so", async ($, on) => {
		const w = world(on, "s-7b", [lane("mod", "MEMORY A")]);
		await $.prompt.compose(COMPOSE);
		w.denyId = true;
		expect(await $.session.compact({ trigger: "auto", messages: ROWS })).toEqual(OWN);
		expect(w.compacts).toEqual(["auto"]);
		expect(w.lines).toEqual([]);
		w.denyId = false;
		await measured($, w, measure(10_000));
		expect(w.lines).toEqual(["Orrery could not compact this conversation (the hook failed); Claude Code compacts it its own way."]);
	});
});

describe("the Orrery mod's compact_at", () => {
	test("past compact_at the mod starts a compaction and answers it itself, each time; under it nothing", { plugins: [TRANSCRIPT] }, async ($, on) => {
		const w = world(on, "s-8a", [lane("mod", "MEMORY A", { compactAt: 200_000 }), lane("mod", "MEMORY B"), lane("mod", "MEMORY C")]);
		await $.prompt.compose(COMPOSE);
		await measured($, w, measure(150_000));
		expect(w.runs).toHaveLength(1);
		expect(w.lines).toEqual([]);
		await measured($, w, measure(250_000));
		expect(viewCalls(w)).toEqual([
			["claude-mod", "view", "--cwd", ROOT, "--session", "s-8a"],
			["claude-mod", "view", "--cwd", ROOT, "--session", "s-8a", "--wait-ms", "30000"],
		]);
		expect(w.lines).toEqual(["Orrery compacted: kept the last turn (2 messages); memory view refreshed (10 messages)."]);
		expect(w.compacts).toEqual([]);
		expect((await $.prompt.compose(COMPOSE)).sections).toEqual(MEMORY("MEMORY B"));
		// Once that compaction is done, the next measure past compact_at starts another one.
		await measured($, w, measure(260_000));
		expect(w.runs).toHaveLength(3);
		expect(w.lines).toHaveLength(2);
		expect(w.compacts).toEqual([]);
	});

	test("a measurement where the context did not move starts nothing", { plugins: [TRANSCRIPT] }, async ($, on) => {
		const w = world(on, "s-8g", [lane("mod", "MEMORY A"), lane("mod", "MEMORY B")]);
		await $.prompt.compose(COMPOSE);
		await measured($, w, measure(250_000, ["cost"]));
		await measured($, w, measure(250_000, ["rateLimits", "cost"]));
		expect(w.runs).toHaveLength(1);
		expect(w.lines).toEqual([]);
		await measured($, w, measure(250_000, ["context", "cost"]));
		expect(w.runs).toHaveLength(2);
		expect(w.lines).toEqual(["Orrery compacted: kept the last turn (2 messages); memory view refreshed (10 messages)."]);
	});

	test("a compaction the mod started and cannot answer is skipped, not handed to Claude Code, and the mod starts no more", { plugins: [TRANSCRIPT] }, async ($, on) => {
		const w = world(on, "s-8b", [lane("mod", "MEMORY A", { compactAt: 200_000 }), JSON.stringify({ error: "the store is busy" })]);
		await $.prompt.compose(COMPOSE);
		await measured($, w, measure(250_000));
		expect(w.compacts).toEqual([]);
		expect(w.runs).toHaveLength(2);
		expect(w.lines).toEqual(["Orrery could not compact this conversation (the memory view could not be read: the store is busy); it stays as it is, and Orrery will not start compactions in this session."]);
		await measured($, w, measure(300_000));
		expect(w.compacts).toEqual([]);
		expect(w.runs).toHaveLength(2);
		expect(w.lines).toHaveLength(1);
		// A /compact still goes through the mod, and when it cannot answer, Claude Code compacts its own way.
		expect(await typedCompact($, w)).toMatchObject({ text: COMPACTED });
		expect(w.compacts).toEqual(["manual"]);
		await w.clock.settle();
		expect(w.lines.at(-1)).toBe("Orrery could not compact this conversation (the memory view could not be read: the store is busy); Claude Code compacts it its own way.");
	});

	test("a compaction the mod started in a session that is not recorded is skipped, and the mod starts no more", { plugins: [TRANSCRIPT] }, async ($, on) => {
		const w = world(on, "s-8e", [lane("mod", "MEMORY A"), lane("mod", "MEMORY B", { recording: false })]);
		await $.prompt.compose(COMPOSE);
		await measured($, w, measure(250_000));
		expect(w.compacts).toEqual([]);
		expect(w.lines).toEqual(["Orrery could not compact this conversation (this session is not recorded); it stays as it is, and Orrery will not start compactions in this session."]);
		await measured($, w, measure(300_000));
		expect(w.runs).toHaveLength(2);
		expect(w.lines).toHaveLength(1);
		expect((await $.prompt.compose(COMPOSE)).sections).toEqual(MEMORY("MEMORY A"));
	});

	test("a compaction the mod started on a last turn too large to keep is skipped for now, said once, and tried again later", { plugins: [TRANSCRIPT] }, async ($, on) => {
		// compact_at 10: the transcript's last turn (about 6 tokens) is over half of it.
		const small = { compactAt: 10 };
		const w = world(on, "s-8f", [lane("mod", "MEMORY A", small), lane("mod", "MEMORY B", small), lane("mod", "MEMORY C", small), lane("mod", "MEMORY D")]);
		await $.prompt.compose(COMPOSE);
		await measured($, w, measure(250_000));
		expect(w.compacts).toEqual([]);
		expect(w.lines).toHaveLength(1);
		expect(w.lines[0]).toMatch(/^Orrery could not compact this conversation \(the last turn is too large to keep \(about \d+ tokens\)\); it stays as it is for now\.$/);
		await measured($, w, measure(260_000));
		expect(w.runs).toHaveLength(3);
		expect(w.lines).toHaveLength(1);
		// Once the last turn fits, the mod's compaction goes through.
		await measured($, w, measure(270_000));
		expect(w.runs).toHaveLength(4);
		expect(w.lines.at(-1)).toBe("Orrery compacted: kept the last turn (2 messages); memory view refreshed (10 messages).");
		expect(w.compacts).toEqual([]);
	});

	test("a compaction the mod started and its hook fails on is skipped too", async ($, on) => {
		// Without the transcript plugin, the kit's empty compaction makes the mod's hook throw part way through.
		const w = world(on, "s-8c", [lane("mod", "MEMORY A", { compactAt: 200_000 }), lane("mod", "MEMORY B")]);
		await $.prompt.compose(COMPOSE);
		await measured($, w, measure(250_000));
		expect(w.compacts).toEqual([]);
		expect(w.lines).toEqual(["Orrery could not compact this conversation (the hook failed); it stays as it is, and Orrery will not start compactions in this session."]);
		await measured($, w, measure(300_000));
		expect(w.runs).toHaveLength(2);
		expect(w.lines).toHaveLength(1);
	});

	test("a compaction another plugin refuses stops the mod starting more in that session", { plugins: [REFUSER] }, async ($, on) => {
		const w = world(on, "s-8d", [lane("mod", "MEMORY A", { compactAt: 200_000 })]);
		await $.prompt.compose(COMPOSE);
		await $.session.measure(measure(250_000));
		expect(w.lines).toEqual([]);
		await w.clock.settle();
		expect(w.lines).toEqual(["Orrery will not start compactions in this session (refused above the mod); /compact still uses Orrery."]);
		await measured($, w, measure(300_000));
		expect(w.lines).toHaveLength(1);
		expect(w.runs).toHaveLength(1);
		expect(w.compacts).toEqual([]);
	});
});

/** What OBSERVER logs as a compaction resolves beneath it. */
const RESOLVED = "(observer: the compaction resolved)";

/**
 * Above the mod: hands the kit's empty mod-started compaction a transcript (as TRANSCRIPT does) and logs a line of its
 * own once the compaction has resolved beneath it, so the lines' order shows what was logged from inside.
 */
const OBSERVER: Plugin = {
	name: "observer",
	tier: "prepend",
	register(on) {
		on("session.compact", async ($, e, next) => {
			const done = await next(e.messages === undefined ? { ...e, messages: [{ role: "user", text: "the question", toolUses: [] }, { role: "assistant", text: "the answer", toolUses: [] }] } : e);
			$.ui.log("(observer: the compaction resolved)");
			return done;
		});
	},
};

/** A session's start, as the engine raises it in an interactive terminal. */
const START = { cwd: ROOT, surface: "terminal", isInteractive: true } as const;

/** A session's start, and the band's fetch it starts without waiting on it, landed. */
async function start($: Engine, w: World): Promise<void> {
	await $.session.start(START);
	await w.clock.settle();
}

/** The band's props on a roomy terminal, unless told otherwise. */
function bandProps(extra: { hasSurvey?: boolean; bodyColumns?: number; maxRows?: number } = {}) {
	return { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 115, scroll: { offset: 0, bodyRows: 19 }, view: {}, ...extra };
}

/** The texts the band shows (each Text's own), drawn afresh on `surface`. */
async function band($: Engine, extra: Parameters<typeof bandProps>[0] = {}, surface: RenderSurface = "terminal"): Promise<string[]> {
	const ui = await $.ui.mount({ plugin: "orrery", surface, component: "AbovePrompt", props: bandProps(extra), viewport: { columns: 120, rows: 40 } });
	const texts = (await ui.findAll({ type: "Text" })).map((t) => t.text);
	await ui.unmount();
	return texts;
}

/** The footer's mode labels, drawn afresh on `surface`. */
async function footer($: Engine, modes: readonly string[], surface: RenderSurface = "terminal"): Promise<string | undefined> {
	const ui = await $.ui.mount({ plugin: "orrery", surface, component: "SessionMode", props: { modes } });
	const text = (await ui.find({ type: "Text" }))?.text;
	await ui.unmount();
	return text;
}

const LOGO_ROWS = LOGO.map((line) => line.map((s) => s.text).join(""));

describe("showing that the mod is loaded (spec section 11)", () => {
	test("remote status refreshes after each turn and no more than once a minute while idle", async ($, on) => {
		const w = world(on, "remote-idle", [
			lane("mod", "MEMORY", { sessionMode: "recording", remote: { remote: "home", state: "saved", savedAt: "14:02" } }),
			lane("mod", "MEMORY", { messages: 12, sessionMode: "recording", remote: { remote: "home", state: "pending" } }),
			lane("mod", "MEMORY", { messages: 12, sessionMode: "recording", remote: { remote: "home", state: "failing", reason: "offline" } }),
			lane("mod", "MEMORY", { messages: 12, sessionMode: "recording", remote: { remote: "home", state: "saved", savedAt: "14:03" } }),
			lane("mod", "MEMORY", { messages: 12, sessionMode: "read-only", remote: { remote: "home", state: "lost", movedTo: "macbook" } }),
		]);
		await start($, w);
		await turnEnd($);
		await w.clock.settle();
		expect(await footer($, [])).toBe("Orrery · Test · 12 msgs · home · not saved yet");
		for (const suffix of ["home ⚠ not saved: offline", "home ✓ 14:03", "home: moved to macbook"]) {
			const calls = w.runs.length;
			await w.clock.advance(59_999);
			expect(w.runs.length).toBe(calls);
			await w.clock.advance(1);
			expect(await footer($, [])).toBe(`Orrery · Test · 12 msgs · ${suffix}`);
		}
		const calls = w.runs.length;
		await w.clock.advance(20_000);
		expect(w.runs.length).toBe(calls);
		expect(w.lines).toEqual([]);
		expect(w.compacts).toEqual([]);
	});

	test("remote polling runs no commands while headless and stops after switching to a local session", async ($, on) => {
		const w = world(on, "remote-headless", [
			lane("mod", "MEMORY", { sessionMode: "recording", remote: { remote: "home", state: "saved", savedAt: "14:02" } }),
			lane("mod", "MEMORY", { sessionMode: "recording", remote: { remote: "home", state: "failing", reason: "offline" } }),
			lane("mod", "LOCAL", { sessionMode: "recording" }),
		]);
		await start($, w);
		w.surfaces = [];
		await w.clock.advance(60_000);
		expect(w.runs.length).toBe(1);
		w.surfaces = ["terminal"];
		await w.clock.advance(60_000);
		expect(await footer($, [])).toBe("Orrery · Test · 10 msgs · home ⚠ not saved: offline");
		w.session = "local-after-remote";
		await start($, w);
		const calls = w.runs.length;
		await w.clock.advance(20_000);
		expect(w.runs.length).toBe(calls);
		expect(await footer($, [])).toBe("Orrery · Test · 10 msgs");
	});

	test("a turn near the idle deadline resets the minute before the next background command", async ($, on) => {
		const reply = lane("mod", "MEMORY", { sessionMode: "recording", remote: { remote: "home", state: "saved", savedAt: "14:02" } });
		const w = world(on, "remote-turn-resets", [reply, reply, reply]);
		await start($, w);
		await w.clock.advance(55_000);
		expect(w.runs.length).toBe(1);
		await turnEnd($);
		await w.clock.settle();
		expect(w.runs.length).toBe(2);
		await w.clock.advance(59_999);
		expect(w.runs.length).toBe(2);
		await w.clock.advance(1);
		expect(w.runs.length).toBe(3);
	});

	test("remote footer follows saved, failing and moved state on terminal and desktop", async ($, on) => {
		const w = world(on, "remote-footer", [
			lane("mod", "MEMORY", { remote: { remote: "home", state: "saved", savedAt: "14:02" } }),
			lane("mod", "MEMORY", { messages: 12, remote: { remote: "home", state: "failing", reason: "offline" } }),
			lane("mod", "MEMORY", { messages: 12, sessionMode: "read-only", remote: { remote: "home", state: "lost", movedTo: "macbook" } }),
		]);
		await start($, w);
		for (const label of ["10 msgs · home ✓ 14:02", "12 msgs · home ⚠ not saved: offline", "12 msgs · home: moved to macbook"]) {
			for (const surface of ["terminal", "desktop"] as const) {
				expect(await footer($, ["Orrery · old · 1 msgs", "plan"], surface)).toBe(`plan & Orrery · Test · ${label}`);
			}
			await turnEnd($);
			await w.clock.settle();
		}
	});

	test("a typed /compact Orrery answered: Claude Code's row stays, and Orrery's line follows the command, once", async ($, on) => {
		const w = world(on, "s-9a", [lane("mod", "MEMORY A"), lane("mod", "MEMORY B", { messages: 12, recording: true })]);
		await $.prompt.compose(COMPOSE);
		expect(await typedCompact($, w)).toMatchObject({ text: COMPACTED });
		expect(w.compacts).toEqual([]);
		// Not from inside the command: Claude Code draws its row after the command's hooks settle.
		expect(w.lines).toEqual([]);
		await w.clock.settle();
		expect(w.lines).toEqual(["Orrery compacted: kept the last turn (2 messages); memory view refreshed (12 messages)."]);
		expect((await $.prompt.compose(COMPOSE)).sections).toEqual(MEMORY("MEMORY B"));
		await measured($, w, measure(10_000));
		await w.clock.settle();
		expect(w.lines).toHaveLength(1);
	});

	test("a /compact Orrery has nothing to do with (a file lane, outside any lane) shows nothing of Orrery's", async ($, on) => {
		const w = world(on, "s-9b", [lane("file", null), JSON.stringify({ lane: null })]);
		for (const session of ["s-9b", "s-9c"]) {
			w.session = session;
			await $.prompt.compose(COMPOSE);
			expect(await typedCompact($, w)).toMatchObject({ text: COMPACTED });
			await w.clock.settle();
		}
		expect(w.compacts).toEqual(["manual", "manual"]);
		expect(w.lines).toEqual([]);
	});

	test("Claude Code's own threshold: Orrery's line is logged at the next event, once", async ($, on) => {
		const w = world(on, "s-9e", [lane("mod", "MEMORY A"), lane("mod", "MEMORY B", { messages: 14 })]);
		await $.prompt.compose(COMPOSE);
		expect(await $.session.compact({ trigger: "auto", messages: ROWS })).toEqual({ messages: BUILT_LAST_TURN });
		expect(w.lines).toEqual([]);
		expect((await $.prompt.compose(COMPOSE)).sections).toEqual(MEMORY("MEMORY B"));
		expect(w.lines).toEqual(["Orrery compacted: kept the last turn (2 messages); memory view refreshed (14 messages)."]);
		await $.prompt.compose(COMPOSE);
		await measured($, w, measure(10_000));
		expect(w.lines).toHaveLength(1);
	});

	test("a compaction the mod started: its line is logged on the clock's next tick after $.session.compact() resolves, not from inside it", { plugins: [OBSERVER] }, async ($, on) => {
		const w = world(on, "s-9g", [lane("mod", "MEMORY A"), lane("mod", "MEMORY B")]);
		await $.prompt.compose(COMPOSE);
		await $.session.measure(measure(250_000));
		// Not yet: Claude Code draws the compaction after the call resolves, over a line logged before.
		expect(w.lines).toEqual([RESOLVED]);
		await w.clock.settle();
		expect(w.lines).toEqual([RESOLVED, "Orrery compacted: kept the last turn (2 messages); memory view refreshed (10 messages)."]);
	});

	test("the footer label: Orrery, the lane and its count among the modes in a mod lane from session start, on the terminal and the desktop", async ($, on) => {
		const w = world(on, "s-9h", [lane("mod", "MEMORY A", { sessionMode: "recording" }), lane("mod", "MEMORY A", { sessionMode: "recording" })]);
		await start($, w);
		for (const surface of ["terminal", "desktop"] as const) {
			expect(await footer($, [], surface)).toBe("Orrery · Test · 10 msgs");
			expect(await footer($, ["focus"], surface)).toBe("focus & Orrery · Test · 10 msgs");
		}
		// Exactly one, and the current one, when the modes handed in carry an Orrery label already.
		expect(await footer($, ["Orrery · Test · 9 msgs"])).toBe("Orrery · Test · 10 msgs");
		expect(await footer($, ["Orrery", "focus", "Orrery · Test · 9 msgs"])).toBe("focus & Orrery · Test · 10 msgs");
		// It stays for the session: after the section's own fetch too.
		await $.prompt.compose(COMPOSE);
		expect(await footer($, ["focus"])).toBe("focus & Orrery · Test · 10 msgs");
	});

	test("after each turn of the main loop the count is asked again, waiting for the session's spool alone, and the label shows it", async ($, on) => {
		const w = world(on, "s-9x", [lane("mod", "MEMORY A", { sessionMode: "recording" }), lane("mod", "MEMORY A", { sessionMode: "recording" }), lane("mod", "MEMORY B", { messages: 12, sessionMode: "recording" })]);
		await start($, w);
		expect((await $.prompt.compose(COMPOSE)).sections).toEqual(MEMORY("MEMORY A"));
		expect(await footer($, [])).toBe("Orrery · Test · 10 msgs");
		await turnEnd($);
		await w.clock.settle();
		expect(await footer($, [])).toBe("Orrery · Test · 12 msgs");
		expect(viewCalls(w).at(-1)).toEqual(["claude-mod", "view", "--cwd", ROOT, "--session", "s-9x", "--wait-ms", "5000", "--spool-only"]);
		// Display only: the section still changes only at a compaction, and nothing is said or compacted.
		expect((await $.prompt.compose(COMPOSE)).sections).toEqual(MEMORY("MEMORY A"));
		expect(w.runs).toHaveLength(3);
		expect(w.lines).toEqual([]);
		expect(w.compacts).toEqual([]);
		// A subagent's turn asks nothing.
		await turnEnd($, "agent-1");
		await w.clock.settle();
		expect(w.runs).toHaveLength(3);
	});

	test("a turn's refetch that fails keeps the count the label had", async ($, on) => {
		const w = world(on, "s-9y", [lane("mod", "MEMORY A", { messages: 30, sessionMode: "recording" }), JSON.stringify({ error: "the store is busy" }), { deny: "no orrery here" }]);
		await start($, w);
		for (let turn = 0; turn < 2; turn++) {
			await turnEnd($);
			await w.clock.settle();
			expect(await footer($, [])).toBe("Orrery · Test · 30 msgs");
		}
		expect(w.runs).toHaveLength(3);
		expect(w.lines).toEqual([]);
	});

	test("a turn's refetch that answers outside any lane, or a lane out of mod mode, keeps the label and the refetches after later turns", async ($, on) => {
		const w = world(on, "s-9xa", [lane("mod", "MEMORY A", { sessionMode: "recording" }), "", lane("file", null, { sessionMode: "recording" }), lane("mod", "MEMORY A", { messages: 14, sessionMode: "recording" })]);
		await start($, w);
		// orrery briefly not there (empty stdout), then a plain claude-setup mid-session: the label stays as it was.
		for (const runs of [2, 3]) {
			await turnEnd($);
			await w.clock.settle();
			expect(w.runs).toHaveLength(runs);
			expect(await footer($, [])).toBe("Orrery · Test · 10 msgs");
		}
		await turnEnd($);
		await w.clock.settle();
		expect(w.runs).toHaveLength(4);
		expect(await footer($, [])).toBe("Orrery · Test · 14 msgs");
		expect(w.lines).toEqual([]);
	});

	test("a session that draws nowhere (claude -p, the SDK with no client) runs nothing at a turn's end, until a client attaches", async ($, on) => {
		const w = world(on, "s-9xb", [lane("mod", "MEMORY A", { sessionMode: "recording" }), lane("mod", "MEMORY A", { messages: 12, sessionMode: "recording" })]);
		w.surfaces = [];
		await $.session.start({ ...START, surface: null, isInteractive: false });
		expect((await $.prompt.compose(COMPOSE)).sections).toEqual(MEMORY("MEMORY A"));
		await turnEnd($);
		await w.clock.settle();
		expect(w.runs).toHaveLength(1);
		w.surfaces = ["desktop"];
		await turnEnd($);
		await w.clock.settle();
		expect(w.runs).toHaveLength(2);
		expect(await footer($, [], "desktop")).toBe("Orrery · Test · 12 msgs");
	});

	test("at most one turn refetch runs at a time; turns that end meanwhile get one more run after it", async ($, on) => {
		const w = world(on, "s-9z", [lane("mod", "MEMORY A", { sessionMode: "recording" }), lane("mod", "MEMORY A", { messages: 12, sessionMode: "recording" }), lane("mod", "MEMORY A", { messages: 16, sessionMode: "recording" })]);
		await start($, w);
		let reached!: () => void;
		let release!: () => void;
		const arrived = new Promise<void>((resolve) => (reached = resolve));
		w.hold.set("s-9z", { reached: () => reached(), until: new Promise<void>((resolve) => (release = resolve)) });
		// The turn's end resolves without waiting on orrery.
		await turnEnd($);
		await arrived;
		await turnEnd($);
		await turnEnd($);
		await w.clock.settle();
		expect(w.runs).toHaveLength(2);
		w.hold.delete("s-9z");
		release();
		await w.clock.settle();
		expect(w.runs).toHaveLength(3);
		expect(await footer($, [])).toBe("Orrery · Test · 16 msgs");
	});

	test("no footer label, no band and no run per turn in a file lane or outside any lane", async ($, on) => {
		const w = world(on, "s-9i", [lane("file", null, { sessionMode: "recording" }), JSON.stringify({ lane: null }), ""]);
		for (const session of ["s-9i", "s-9j", "s-9k"]) {
			w.session = session;
			await start($, w);
			await turnEnd($);
			await w.clock.settle();
			expect(await footer($, ["focus"])).toBe("focus");
			expect(await band($)).toEqual([ENGINE_BAND]);
		}
		expect(w.runs).toHaveLength(3);
	});

	test("the band before the first prompt: the logo with the lane and its state; the session's mode joins once its mode file exists", async ($, on) => {
		const w = world(on, "s-9l", [lane("mod", "MEMORY A"), lane("mod", "MEMORY A", { sessionMode: "recording" }), lane("mod", "MEMORY C", { sessionMode: "recording" })]);
		await start($, w);
		// The holder had not written the session's mode file yet: the mode part is left out.
		let texts = await band($);
		expect(texts).toContain("Orrery · Test");
		expect(texts).toContain("memory loaded · 10 msgs");
		for (const row of LOGO_ROWS) expect(texts).toContain(row);
		// A display-only refetch, on the clock.
		await w.clock.advance(2_000);
		texts = await band($);
		expect(texts).toContain("memory loaded · 10 msgs · recording");
		expect(texts).not.toContain("memory loaded · 10 msgs");
		// The section keeps its own fetch: the band's never set it.
		expect((await $.prompt.compose(COMPOSE)).sections).toEqual(MEMORY("MEMORY C"));
		expect(viewCalls(w)).toEqual([0, 1, 2].map(() => ["claude-mod", "view", "--cwd", ROOT, "--session", "s-9l"]));
		// Once the mode is known, no more refetches.
		await w.clock.advance(20_000);
		expect(w.runs).toHaveLength(3);
	});

	test("the band's states: no memory yet, and a read-only window", async ($, on) => {
		const w = world(on, "s-9m", [lane("mod", null, { messages: 0, sessionMode: "recording" }), lane("mod", "MEMORY A", { sessionMode: "read-only" }), lane("mod", null, { messages: 0, sessionMode: "read-only" })]);
		const states: string[] = [];
		for (const session of ["s-9m", "s-9n", "s-9o"]) {
			w.session = session;
			await start($, w);
			const texts = await band($);
			states.push(texts.find((t) => t.startsWith("memory") || t.startsWith("no memory")) ?? "");
		}
		expect(states).toEqual(["no memory yet · recording", "memory loaded · 10 msgs · read-only (another window records this lane)", "no memory yet · read-only (another window records this lane)"]);
	});

	test("without room for the logo (59 columns, 4 rows) or off the terminal, the band shows the two lines alone", async ($, on) => {
		const w = world(on, "s-9p", [lane("mod", "MEMORY A", { sessionMode: "recording" })]);
		await start($, w);
		const alone = ["Orrery · Test", "memory loaded · 10 msgs · recording"];
		expect(await band($, { bodyColumns: 59 })).toEqual(alone);
		expect(await band($, { maxRows: 4 })).toEqual(alone);
		expect(await band($, {}, "desktop")).toEqual(alone);
		expect(await band($, { bodyColumns: 60, maxRows: 5 })).toEqual(expect.arrayContaining([...LOGO_ROWS, ...alone]));
	});

	test("session.start does not wait for the band's fetch: a stalled orrery holds nothing, and the band draws once it answers", async ($, on) => {
		const w = world(on, "s-9t", [lane("mod", "MEMORY A", { name: "Started", sessionMode: "recording" })]);
		let reached!: () => void;
		let release!: () => void;
		const arrived = new Promise<void>((resolve) => (reached = resolve));
		w.hold.set("s-9t", { reached: () => reached(), until: new Promise<void>((resolve) => (release = resolve)) });
		let released = false;
		const started = $.session.start(START).then(() => released);
		await arrived;
		await w.clock.settle();
		expect(await band($)).not.toContain("Orrery · Started");
		released = true;
		release();
		// The start had resolved before orrery answered.
		expect(await started).toBe(false);
		await w.clock.settle();
		expect(await band($)).toContain("Orrery · Started");
		expect(w.runs).toHaveLength(1);
	});

	test("a band fetch that fails at session start is tried again 2 s later, within the same cap", async ($, on) => {
		const w = world(on, "s-9u", [JSON.stringify({ error: "the store is busy" }), lane("mod", "MEMORY A", { name: "Retried", sessionMode: "recording" })]);
		await start($, w);
		expect(await band($)).not.toContain("Orrery · Retried");
		await w.clock.advance(2_000);
		expect(w.runs).toHaveLength(2);
		expect(await band($)).toContain("Orrery · Retried");
		expect(w.lines).toEqual([]);
	});

	test("while the session's mode stays unknown, the band asks again every 2 s, at most 10 times after a session start", async ($, on) => {
		const w = world(on, "s-9v", [lane("mod", "MEMORY A")]);
		await start($, w);
		expect(w.runs).toHaveLength(1);
		await w.clock.advance(2_000);
		expect(w.runs).toHaveLength(2);
		await w.clock.advance(60_000);
		expect(w.runs).toHaveLength(11);
		expect(viewCalls(w).every((argv) => argv.at(-1) === "s-9v")).toBe(true);
	});

	test("a session started without a terminal (claude -p, the SDK) fetches nothing for the band", async ($, on) => {
		const w = world(on, "s-9w", [lane("mod", "MEMORY A")]);
		await $.session.start({ ...START, isInteractive: false });
		await w.clock.settle();
		await w.clock.advance(30_000);
		expect(w.runs).toEqual([]);
	});

	test("the band yields to a survey", async ($, on) => {
		const w = world(on, "s-9q", [lane("mod", "MEMORY A", { sessionMode: "recording" })]);
		await start($, w);
		expect(await band($, { hasSurvey: true })).toEqual([ENGINE_BAND]);
		expect(await band($)).toContain("Orrery · Test");
	});

	// The person's first prompt ends the band for the whole process: this test runs last.
	test("the band leaves at the person's first prompt and does not come back, and its refetch stops; a peer's prompt leaves it", async ($, on) => {
		// The session's mode is not known yet, so a refetch waits on the clock.
		const w = world(on, "s-9r", [lane("mod", "MEMORY A")]);
		on("prompt.submit", ($, e) => ({ text: e.text }));
		await start($, w);
		expect(await band($)).toContain("Orrery · Test");
		await $.prompt.submit({ text: "a subagent's report", wait: false, origin: { kind: "peer" } });
		expect(await band($)).toContain("Orrery · Test");
		await $.prompt.submit({ text: "hello", wait: false, origin: { kind: "composer" } });
		expect(await band($)).toEqual([ENGINE_BAND]);
		await w.clock.advance(30_000);
		expect(w.runs).toHaveLength(1);
		// A /clear (a new session id) brings no band back; the footer label stays.
		w.session = "s-9s";
		await $.prompt.compose(COMPOSE);
		expect(await band($)).toEqual([ENGINE_BAND]);
		expect(await footer($, [])).toBe("Orrery · Test · 10 msgs");
		// The band's refetch stopped at the first prompt; the count's refetch after a turn's end does not.
		await turnEnd($);
		await w.clock.settle();
		expect(viewCalls(w).at(-1)).toEqual(["claude-mod", "view", "--cwd", ROOT, "--session", "s-9s", "--wait-ms", "5000", "--spool-only"]);
	});
});
