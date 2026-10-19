import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { AgentConfig } from "../../src/agent/config.ts";
import { readHolder } from "../../src/agent/handover.ts";
import { agentModelSource } from "../../src/agent/model-source.ts";
import { newToken } from "../../src/agent/pick.ts";
import { Holder } from "../../src/claude/holder.ts";
import { type HookContext, runHook } from "../../src/claude/hooks.ts";
import { listSessions, pendingEvents, readMode } from "../../src/claude/spool.ts";
import { type CodexHookContext, runCodexHook } from "../../src/codex/hooks.ts";
import { fauxModels } from "../agent/support.ts";
import { cleanupDirs, messages, spool, type TestAgent, testAgent, waitUntil } from "../claude/support.ts";
import { line, transcriptIn } from "../claude/transcript-lines.ts";
import { codexHomeIn, codexSession, rollout } from "./rollout-lines.ts";

const holders: Holder[] = [];
afterEach(async () => {
	for (const holder of holders.splice(0)) await holder.stop("test over");
	cleanupDirs();
});

/** This test's processes: two Claude Codes and one Codex, live ones (Orrery reads their start times), alive to the recorders while the test says so. */
const sleepers = [0, 1].map(() => spawn("sleep", ["600"], { stdio: "ignore" }));
afterAll(() => {
	for (const sleeper of sleepers) sleeper.kill();
});
const [CLAUDE, CLAUDE_2] = sleepers.map((sleeper) => sleeper.pid as number) as [number, number];
/** The Codex's two sessions (a /clear between them). */
const [X1, X2] = [codexSession(), codexSession()];

type Answer = { systemMessage?: string; hookSpecificOutput?: { additionalContext: string } };

/** One agent, recorded from Claude Code (set up the file way, in its folder) and from Codex (ORRERY_AGENT and a token). */
function scene(t: TestAgent) {
	// Codex's rollouts of its two sessions, which it holds open (here: a stand-in that has them as its stdin and fd 3).
	const codexHome = codexHomeIn(t.dir);
	const fds = [codexHome.begin(X1, { open: false }), codexHome.begin(X2, { open: false })].map((file) => openSync(file, "r"));
	const codexProcess = spawn("sleep", ["600"], { stdio: [fds[0], "ignore", "ignore", fds[1]] });
	for (const fd of fds) closeSync(fd);
	sleepers.push(codexProcess);
	const CODEX = codexProcess.pid as number;
	const alive = new Set([CLAUDE, CLAUDE_2, CODEX]);
	const isAlive = (pid: number) => alive.has(pid);
	const models = agentModelSource(fauxModels().models);
	/** A startHolder that starts a real recorder in this process for `host`'s process `pid`. */
	const holderFor = (pid: number, host: "claude-code" | "codex") => (agent: AgentConfig, session: string, nonce: string, since: number) => {
		void Holder.start({ agent, session, nonce, since, claudePid: pid, ...(host === "codex" ? { host } : {}), models, alive: isAlive, tickMs: 20 }).then((h) => h && holders.push(h));
	};
	// Claude Code's transcripts, which confirm its prompts (src/claude/transcript.ts).
	const transcript = transcriptIn(t.dir);
	const claude = (pid: number): HookContext => ({
		config: t.config,
		env: { CLAUDE_PROJECT_DIR: t.folder, CLAUDE_CONFIG_DIR: transcript.configDir },
		claudePid: pid,
		// On its hooks' stdin's other end: the Claude Code (src/claude/peer.ts).
		peer: () => pid,
		startHolder: holderFor(pid, "claude-code"),
		modeWaitMs: 5000,
		home: join(t.dir, "home"),
	});
	const codex: CodexHookContext = {
		config: t.config,
		env: { ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: newToken(), CODEX_HOME: codexHome.home },
		home: join(t.dir, "home"),
		codexPid: CODEX,
		startHolder: holderFor(CODEX, "codex"),
		modeWaitMs: 5000,
		compactWaitMs: 0,
		alive: isAlive,
	};
	const inClaude = async (pid: number, event: string, input: { session_id: string } & Record<string, unknown>): Promise<Answer> => {
		const out = await runHook(event, JSON.stringify({ cwd: t.folder, transcript_path: transcript.path(input.session_id), ...input }), claude(pid));
		// Claude Code writes a prompt into its transcript once its hook has run.
		if (event === "user-prompt-submit" && typeof input.prompt_id === "string") transcript.add(input.session_id, line.typed(input.prompt_id, String(input.prompt)));
		return out === "" ? {} : (JSON.parse(out) as Answer);
	};
	const inCodex = async (event: string, input: { session_id: string } & Record<string, unknown>): Promise<Answer> => {
		const out = await runCodexHook(event, JSON.stringify({ cwd: t.folder, ...input }), codex);
		// Codex writes a turn into its rollout as it goes.
		const turn = input.turn_id;
		if (typeof turn === "string" && event === "user-prompt-submit") codexHome.add(input.session_id, rollout.started(turn), rollout.user(turn, String(input.prompt)));
		if (typeof turn === "string" && event === "stop") codexHome.add(input.session_id, rollout.agent(turn, String(input.last_assistant_message)), rollout.complete(turn, String(input.last_assistant_message)));
		return out === "" ? {} : (JSON.parse(out) as Answer);
	};
	return { alive, inClaude, inCodex, transcript, CODEX };
}

describe("one agent in Claude Code and in Codex", () => {
	it("records from one at a time; the other reads memory, says which tool holds it, and records nothing; leftovers go to the next recorder", async () => {
		const t = testAgent({ setup: true });
		const { alive, inClaude, inCodex, transcript, CODEX } = scene(t);

		// Claude Code records first.
		const c1 = await inClaude(CLAUDE, "session-start", { session_id: "c1", source: "startup" });
		expect(c1.hookSpecificOutput?.additionalContext).toMatch(/· recording$/m);
		await inClaude(CLAUDE, "user-prompt-submit", { session_id: "c1", prompt: "From Claude Code.", prompt_id: "p-1" });
		await inClaude(CLAUDE, "stop", { session_id: "c1", last_assistant_message: "Claude Code's reply." });
		await waitUntil(() => messages(t.agent).length === 2);
		expect(readHolder(t.agent.dir)).toMatchObject({ session: "c1", claudePid: CLAUDE, state: "recording" });
		expect(readHolder(t.agent.dir)?.host).toBeUndefined();

		// A Codex session meanwhile: read-only, with the memory Claude Code recorded, and it says Claude Code holds the agent.
		const x1 = await inCodex("session-start", { session_id: X1, source: "startup" });
		expect(x1.systemMessage).toBe(
			"Orrery · Test · 2 msgs · read-only: this session is not recorded\nOrrery: Test is open in Claude Code; this session reads memory but is not recorded.",
		);
		expect(x1.hookSpecificOutput?.additionalContext).toContain("|user: From Claude Code.\n");
		expect(readMode(t.agent.dir, X1)).toMatchObject({ mode: "read-only", claudePid: CODEX });
		await inCodex("user-prompt-submit", { session_id: X1, prompt: "Not memory: Codex is read-only.", turn_id: "t-1" });
		await inCodex("stop", { session_id: X1, last_assistant_message: "Not memory either.", turn_id: "t-1" });
		expect(pendingEvents(t.agent.dir, X1)).toEqual([]);
		// Only Codex's own recorder writes the agent while it is read-only: an event that slipped in after it turned
		// read-only is never recorded by anyone.
		spool(t.agent, X1, { kind: "prompt", text: "Raced past read-only.", host: "codex", turnId: "t-2" }, CODEX);

		// Claude Code's recorder dies; Claude Code spools one more prompt, then exits too: a leftover in its session.
		const recorder = holders.find((h) => h.session === "c1");
		await recorder?.stop("test: the recorder crashed");
		spool(t.agent, "c1", { kind: "prompt", text: "Left by Claude Code.", promptId: "p-2" }, CLAUDE);
		transcript.add("c1", line.typed("p-2", "Left by Claude Code."));
		alive.delete(CLAUDE);

		// Codex's next session (a /clear) finds the agent free: it records, and takes Claude Code's leftover first.
		const x2 = await inCodex("session-start", { session_id: X2, source: "clear" });
		// (Its recorder may have taken the leftover in before the count is read.)
		expect(x2.systemMessage).toMatch(/^Orrery · Test · [23] msgs · recording$/);
		await waitUntil(() => messages(t.agent).length === 3);
		await inCodex("user-prompt-submit", { session_id: X2, prompt: "From Codex.", turn_id: "t-3" });
		await inCodex("stop", { session_id: X2, last_assistant_message: "Codex's reply.", turn_id: "t-3" });
		await waitUntil(() => messages(t.agent).length === 5);
		expect(readHolder(t.agent.dir)).toMatchObject({ session: X2, claudePid: CODEX, host: "codex", state: "recording" });

		// Now a Claude Code session is the read-only one, and it says Codex holds the agent.
		const c2 = await inClaude(CLAUDE_2, "session-start", { session_id: "c2", source: "startup" });
		expect(c2.hookSpecificOutput?.additionalContext).toMatch(/^Orrery · Test · 5 msgs · read-only: this session is not recorded$/m);
		expect(c2.systemMessage).toBe("Orrery: Test is open in Codex; this session reads memory but is not recorded.");
		await inClaude(CLAUDE_2, "user-prompt-submit", { session_id: "c2", prompt: "Not memory: Claude Code is read-only.", prompt_id: "p-3" });
		expect(pendingEvents(t.agent.dir, "c2")).toEqual([]);

		// Codex ends (its SessionEnd, then its exit); its recorder only finishes, so the next Claude Code session takes the
		// agent over and records.
		await inCodex("session-end", { session_id: X2, reason: "other" });
		alive.delete(CODEX);
		await waitUntil(() => readHolder(t.agent.dir)?.state !== "recording", 10_000);
		const c3 = await inClaude(CLAUDE_2, "session-start", { session_id: "c3", source: "clear" });
		expect(c3.hookSpecificOutput?.additionalContext).toMatch(/^Orrery · Test · 5 msgs · recording$/m);
		await inClaude(CLAUDE_2, "user-prompt-submit", { session_id: "c3", prompt: "Claude Code again.", prompt_id: "p-4" });
		await inClaude(CLAUDE_2, "stop", { session_id: "c3", last_assistant_message: "Claude Code's second reply." });
		await waitUntil(() => messages(t.agent).length === 7);

		expect(messages(t.agent)).toEqual([
			"user: From Claude Code.",
			"talk: Claude Code's reply.",
			"user: Left by Claude Code.",
			"user: From Codex.",
			"talk: Codex's reply.",
			"user: Claude Code again.",
			"talk: Claude Code's second reply.",
		]);
		// Claude Code's spent session is swept; the read-only ones hold nothing that will ever be recorded.
		await waitUntil(() => !listSessions(t.agent.dir).includes("c1"));
		expect(pendingEvents(t.agent.dir, "c2")).toEqual([]);
	}, 60_000);
});
