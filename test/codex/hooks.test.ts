import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentConfig } from "../../src/agent/config.ts";
import { readHolder } from "../../src/agent/handover.ts";
import { agentModelSource } from "../../src/agent/model-source.ts";
import { newToken } from "../../src/agent/pick.ts";
import { Holder } from "../../src/claude/holder.ts";
import { holderLog, sessionDir } from "../../src/claude/paths.ts";
import { listSessions, pendingEvents, readEvent, writeMode } from "../../src/claude/spool.ts";
import { CODEX_RECORD_EVENTS, type CodexHookContext, runCodexHook } from "../../src/codex/hooks.ts";
import { fauxModels } from "../agent/support.ts";
import { cleanupDirs, messages, seed, type TestAgent, testAgent, waitUntil } from "../claude/support.ts";

const holders: Holder[] = [];
afterEach(async () => {
	for (const holder of holders.splice(0)) await holder.stop("test over");
	cleanupDirs();
});

/** This test's Codex: a pid no process has, alive by the test's word. */
const CODEX = 4343;

const ctx = (t: TestAgent, extra: Partial<CodexHookContext> = {}, token = tokens.get(t) ?? tokenOf(t)): CodexHookContext => ({
	config: t.config,
	env: { ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: token },
	codexPid: CODEX,
	startHolder: () => {},
	modeWaitMs: 200,
	alive: (pid) => pid === CODEX,
	...extra,
});
const tokens = new Map<TestAgent, string>();
const tokenOf = (t: TestAgent) => {
	const token = newToken();
	tokens.set(t, token);
	return token;
};
const input = (extra: object = {}) => JSON.stringify({ session_id: "s1", cwd: "/tmp/anywhere", hook_event_name: "x", ...extra });
/** A startHolder that answers as a holder would, without one. */
const answer = (mode: "recording" | "read-only", started: string[] = []) => (agent: AgentConfig, session: string, nonce: string, since: number) => {
	started.push(session);
	writeMode(agent.dir, session, { mode, pid: 1, claudePid: CODEX, nonce, since, ...(mode === "read-only" ? { reason: "held" } : {}) });
};
/** A startHolder that starts a real holder in this process, recording for Codex. */
const realHolder = (started: string[] = [], tickMs = 20) => (agent: AgentConfig, session: string, nonce: string, since: number) => {
	started.push(session);
	void Holder.start({ agent, session, nonce, since, claudePid: CODEX, host: "codex", models: agentModelSource(fauxModels().models), alive: (pid) => pid === CODEX, tickMs }).then((h) => h && holders.push(h));
};

type Answer = { systemMessage?: string; hookSpecificOutput?: { hookEventName: string; additionalContext: string } };
const run = async (event: string, json: string, c: CodexHookContext): Promise<Answer | ""> => {
	const out = await runCodexHook(event, json, c);
	return out === "" ? "" : (JSON.parse(out) as Answer);
};

describe("SessionStart for a Codex session", () => {
	it("starts the holder and gives the model the status and the memory section, and the person the status", async () => {
		const t = testAgent();
		seed(t.agent, ["Use pnpm here.", "Switched to pnpm."]);
		const started: string[] = [];
		const out = (await run("session-start", input({ source: "startup" }), ctx(t, { startHolder: answer("recording", started) }))) as Answer;
		expect(started).toEqual(["s1"]);
		expect(out.systemMessage).toBe("Orrery · Test · 2 msgs · recording");
		const context = out.hookSpecificOutput?.additionalContext ?? "";
		expect(out.hookSpecificOutput?.hookEventName).toBe("SessionStart");
		expect(context.startsWith("Orrery · Test · 2 msgs · recording\n\n# Memory\n\nEarlier conversation reaches you only through the view below.")).toBe(true);
		expect(context).toContain("if you don't see them, look for the zoom, date and search tools.");
		// The view: one line per message, not summarized yet.
		expect(context).toContain("<chat>\n0+1|");
		expect(context).toContain("\n1+1|");
		// Codex reads no view file: nothing is written into the folder.
		expect(existsSync(join(t.folder, ".orrery"))).toBe(false);
	});

	it("says there is no memory yet, with no section, for an agent never used", async () => {
		const t = testAgent();
		const out = (await run("session-start", input(), ctx(t, { startHolder: answer("recording") }))) as Answer;
		expect(out).toEqual({ systemMessage: "Orrery · Test · no memory yet · recording", hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "Orrery · Test · no memory yet · recording" } });
	});

	it("gives the view again at clear and after a compaction, keeping the holder that records the session", async () => {
		const t = testAgent();
		seed(t.agent, ["a", "b"]);
		const started: string[] = [];
		// A slow holder: the compaction's view has the turn's prompt only because SessionStart waits for it.
		const c = ctx(t, { startHolder: realHolder(started, 600), modeWaitMs: 5000 });
		const first = (await run("session-start", input({ source: "startup" }), c)) as Answer;
		expect(first.hookSpecificOutput?.additionalContext).toContain("# Memory");
		// The turn before the compaction: its prompt is spooled, and the compaction's view waits for the holder to take it.
		await run("user-prompt-submit", input({ prompt: "Codename Juniper." }), c);
		const compact = (await run("session-start", input({ source: "compact" }), c)) as Answer;
		expect(compact.systemMessage).toBe("Orrery · Test · 3 msgs · recording");
		expect(compact.hookSpecificOutput?.additionalContext).toContain("\n2+1|user: Codename Juniper.\n");
		expect(started).toEqual(["s1"]);
		// /clear starts a new session in the same Codex: a holder of its own, and the view.
		const clear = (await run("session-start", input({ session_id: "s2", source: "clear" }), c)) as Answer;
		expect(clear.hookSpecificOutput?.additionalContext).toContain("\n2+1|user: Codename Juniper.\n");
		expect(started).toEqual(["s1", "s2"]);
	});

	it("at resume and fork records as ever but says only the status: the session's history already holds a view", async () => {
		const t = testAgent();
		seed(t.agent, ["a", "b"]);
		for (const source of ["resume", "fork"]) {
			const started: string[] = [];
			const out = (await run("session-start", input({ session_id: `s-${source}`, source }), ctx(t, { startHolder: answer("recording", started) }))) as Answer;
			expect(out).toEqual({ systemMessage: "Orrery · Test · 2 msgs · recording" });
			expect(started).toEqual([`s-${source}`]);
		}
	});

	it("says read-only when the agent is held elsewhere, and names the log when no holder answers", async () => {
		const t = testAgent();
		const readOnly = (await run("session-start", input(), ctx(t, { startHolder: answer("read-only") }))) as Answer;
		expect(readOnly.systemMessage).toBe(
			"Orrery · Test · no memory yet · read-only: this session is not recorded\nOrrery: Test is open elsewhere (pi, Claude Code, or another Codex session); this session reads memory but is not recorded.",
		);
		expect(readOnly.hookSpecificOutput?.additionalContext).toBe(readOnly.systemMessage);
		// A read-only session spools nothing.
		await run("user-prompt-submit", input({ prompt: "Not memory." }), ctx(t));
		expect(pendingEvents(t.agent.dir, "s1")).toEqual([]);
		const silent = (await run("session-start", input({ session_id: "s2" }), ctx(t))) as Answer;
		expect(silent.systemMessage).toContain("not recording yet");
		expect(silent.systemMessage).toContain(holderLog(t.agent.dir));
	});

	it("tells the person of summary trouble with Orrery's command for it, once", async () => {
		const t = testAgent();
		mkdirSync(t.agent.dir, { recursive: true });
		writeFileSync(join(t.agent.dir, "status.json"), JSON.stringify({ trouble: { state: "stopped", plain: "no key for the summary model" } }));
		const c = ctx(t, { startHolder: answer("recording") });
		const out = (await run("session-start", input(), c)) as Answer;
		expect(out.systemMessage).toBe("Orrery · Test · no memory yet · recording\nOrrery: Test's summaries stopped: no key for the summary model. Switch with orrery compactor Test.");
		// Not the model's: its context has the status only.
		expect(out.hookSpecificOutput?.additionalContext).toBe("Orrery · Test · no memory yet · recording");
		expect(await run("stop", input({ last_assistant_message: "ok" }), c)).toBe("");
	});

	it("is said nothing by a subagent's start, and nothing is started", async () => {
		const t = testAgent();
		const started: string[] = [];
		expect(await run("session-start", input({ agent_id: "sub-1" }), ctx(t, { startHolder: answer("recording", started) }))).toBe("");
		expect(started).toEqual([]);
	});
});

describe("the agent of a Codex session: ORRERY_AGENT and its token, never a folder", () => {
	it("refuses with a notice at SessionStart, starts nothing, and records nothing after", async () => {
		const t = testAgent();
		const cases: [Record<string, string>, string][] = [
			[{}, "Orrery: ORRERY_AGENT is not set in this Codex, so it is no agent's; this session runs without memory. Open an agent with orrery agent <Name> --tool codex."],
			[{ ORRERY_AGENT: "Nobody", ORRERY_AGENT_TOKEN: newToken() }, "Orrery: ORRERY_AGENT names Nobody, which is not a configured agent; this session runs without memory."],
			[{ ORRERY_AGENT: "Test" }, "Orrery: ORRERY_AGENT_TOKEN is not set, so this Codex is not Test; it runs without memory. Open it with orrery agent Test --tool codex."],
			[{ ORRERY_AGENT: "test", ORRERY_AGENT_TOKEN: "not-a-token" }, "Orrery: ORRERY_AGENT_TOKEN is not 32 lowercase hex digits, so this session is not Test; it runs without memory."],
		];
		for (const [env, notice] of cases) {
			const started: string[] = [];
			const c = { ...ctx(t, { startHolder: answer("recording", started) }), env };
			expect(await run("session-start", input(), c), JSON.stringify(env)).toEqual({ systemMessage: notice });
			await run("user-prompt-submit", input({ prompt: "Not memory." }), c);
			await run("stop", input({ last_assistant_message: "Not memory either." }), c);
			await run("session-end", input(), c);
			expect(started).toEqual([]);
		}
		// Even inside the agent's own folder: no folder decides.
		expect(listSessions(t.agent.dir)).toEqual([]);
	});

	it("claims the token for this Codex at its start: another process with the same variables is not the agent", async () => {
		const t = testAgent();
		const token = newToken();
		const mine = ctx(t, { startHolder: answer("recording") }, token);
		expect(((await run("session-start", input(), mine)) as Answer).systemMessage).toBe("Orrery · Test · no memory yet · recording");
		// A Codex the agent's own shell started inherits both variables; its pid is another, and the claim is not its.
		const other = { ...mine, codexPid: 5151, alive: (pid: number) => pid === CODEX || pid === 5151 };
		expect(await run("session-start", input({ session_id: "s9" }), other)).toEqual({
			systemMessage: "Orrery: Test's token belongs to another process, so this Codex is not Test; it runs without memory.",
		});
		await run("user-prompt-submit", input({ session_id: "s9", prompt: "Not memory." }), other);
		expect(listSessions(t.agent.dir)).toEqual(["s1"]);
		// A later event of this Codex only finds its own claim: one made by no one is not taken by a prompt.
		const late = ctx(t, {}, newToken());
		await run("user-prompt-submit", input({ session_id: "s8", prompt: "Not memory." }), late);
		expect(listSessions(t.agent.dir)).toEqual(["s1"]);
	});
});

describe("recording a Codex session", () => {
	it("spools the prompt, the last reply and the end, each with Codex's pid, and leaves subagents' out", async () => {
		const t = testAgent();
		const c = ctx(t, { startHolder: answer("recording") });
		await run("session-start", input(), c);
		expect(await run("user-prompt-submit", input({ prompt: "Codename Saffron.", turn_id: "t1" }), c)).toBe("");
		expect(await run("stop", input({ last_assistant_message: "Noted: Saffron.", stop_hook_active: false }), c)).toBe("");
		await run("user-prompt-submit", input({ prompt: "   " }), c);
		await run("user-prompt-submit", input({ prompt: "A subagent's task.", agent_id: "sub-1" }), c);
		await run("stop", input({ last_assistant_message: "A subagent's answer.", agent_id: "sub-1" }), c);
		expect(await run("session-end", input({ reason: "other" }), c)).toBe("");
		const events = pendingEvents(t.agent.dir, "s1").map((event) => readEvent(event.path));
		expect(events.map((event) => ({ ...event, at: 0 }))).toEqual([
			{ kind: "prompt", at: 0, claudePid: CODEX, text: "Codename Saffron." },
			{ kind: "reply", at: 0, claudePid: CODEX, text: "Noted: Saffron." },
			{ kind: "end", at: 0, claudePid: CODEX, reason: "other" },
		]);
	});

	it("records a session into the agent's memory through a real holder, and a second session sees it in its view", async () => {
		const t = testAgent();
		const c = ctx(t, { startHolder: realHolder(), modeWaitMs: 5000 });
		const first = (await run("session-start", input({ session_id: "s1" }), c)) as Answer;
		expect(first.systemMessage).toMatch(/^Orrery · Test · (no memory yet|0 msgs) · recording$/);
		await run("user-prompt-submit", input({ session_id: "s1", prompt: "Codename Saffron." }), c);
		await run("stop", input({ session_id: "s1", last_assistant_message: "Noted: Saffron." }), c);
		await waitUntil(() => messages(t.agent).length === 2);
		expect(messages(t.agent)).toEqual(["user: Codename Saffron.", "talk: Noted: Saffron."]);
		// The holder names Codex wherever it says whose session it records.
		expect(readHolder(t.agent.dir)).toMatchObject({ session: "s1", claudePid: CODEX, host: "codex" });
		expect(JSON.parse(readFileSync(join(t.agent.dir, "status.json"), "utf8"))).toMatchObject({ model: "codex" });
		await run("session-end", input({ session_id: "s1", reason: "other" }), c);
		await waitUntil(() => !existsSync(sessionDir(t.agent.dir, "s1")));
		const second = (await run("session-start", input({ session_id: "s2" }), c)) as Answer;
		expect(second.systemMessage).toBe("Orrery · Test · 2 msgs · recording");
		expect(second.hookSpecificOutput?.additionalContext.endsWith("<chat>\n0+1|user: Codename Saffron.\n1+1|talk: Noted: Saffron.\n</chat>")).toBe(true);
	});
});

describe("runCodexHook", () => {
	it("answers unreadable input with nothing, and refuses an event it does not record", async () => {
		const t = testAgent();
		for (const event of CODEX_RECORD_EVENTS) {
			expect(await runCodexHook(event, "not json", ctx(t))).toBe("");
			expect(await runCodexHook(event, "[1]", ctx(t))).toBe("");
		}
		await expect(runCodexHook("pre-tool-use", input(), ctx(t))).rejects.toThrow("unknown hook event pre-tool-use");
		await expect(runCodexHook("post-compact", input(), ctx(t))).rejects.toThrow("unknown hook event post-compact");
	});
});
