import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Holder } from "../../src/claude/holder.ts";
import { HOOK_EVENTS, type HookContext, runHook } from "../../src/claude/hooks.ts";
import { holderLog, sessionDir, setupMarker, viewFile } from "../../src/claude/paths.ts";
import { claudeSetup, claudeSetupMod } from "../../src/claude/setup.ts";
import { listSessions, pendingEvents, readEvent, writeMode } from "../../src/claude/spool.ts";
import { writeSetupMarker } from "../../src/claude/view-file.ts";
import type { AgentConfig } from "../../src/agent/config.ts";
import { agentModelSource } from "../../src/agent/model-source.ts";
import { fauxModels } from "../agent/support.ts";
import { brokenGit, cleanupDirs, gitIn, seed, type TestAgent, testAgent, withGit } from "./support.ts";

const holders: Holder[] = [];
afterEach(async () => {
	for (const holder of holders.splice(0)) await holder.stop("test over");
	cleanupDirs();
});

const ctx = (t: TestAgent, extra: Partial<HookContext> = {}): HookContext => ({
	config: t.config,
	env: { CLAUDE_PROJECT_DIR: t.folder },
	claudePid: 4242,
	startHolder: () => {},
	modeWaitMs: 200,
	// The guard's home: a scratch one, so no test lists or stats the real ~/.omp.
	home: join(t.dir, "home"),
	...extra,
});
const input = (t: TestAgent, extra: object = {}) => JSON.stringify({ session_id: "s1", cwd: t.folder, ...extra });
/** A startHolder that answers as a holder would, without one. */
const answer = (mode: "recording" | "read-only") => (agent: AgentConfig, session: string, nonce: string, since: number) =>
	writeMode(agent.dir, session, { mode, pid: 1, claudePid: 4242, nonce, since, ...(mode === "read-only" ? { reason: "held" } : {}) });

describe("SessionStart in mod mode", () => {
	it("says memory comes from the mod, tells the model to check, and gives no view warnings", async () => {
		const t = testAgent();
		seed(t.agent, ["Use pnpm here.", "Switched to pnpm."]);
		claudeSetupMod(t.agent);
		const out = JSON.parse(await runHook("session-start", input(t), ctx(t, { startHolder: answer("recording") }))) as { hookSpecificOutput: { additionalContext: string }; systemMessage?: string };
		const context = out.hookSpecificOutput.additionalContext;
		expect(context).toMatch(/^Orrery · .+ · \d+ msgs · recording · memory from the Orrery mod$/m);
		expect(context).toContain("If your system prompt has no Orrery memory section (its text begins \"Earlier conversation reaches you only through the view below\"), the Orrery mod is not loaded; tell the user.");
		expect(context).not.toContain("CLAUDE.md does not load");
		expect(out.systemMessage).toBeUndefined();
		expect(existsSync(viewFile(t.folder))).toBe(false);
	});
});

describe("SessionStart in mod mode with no memory yet", () => {
	it("does not tell the model to look for a memory section, which there is none of yet", async () => {
		const t = testAgent();
		claudeSetupMod(t.agent);
		const out = JSON.parse(await runHook("session-start", input(t), ctx(t, { startHolder: answer("recording") }))) as { hookSpecificOutput: { additionalContext: string } };
		const context = out.hookSpecificOutput.additionalContext;
		expect(context).toMatch(/^Orrery · .+ · no memory yet · recording · memory from the Orrery mod$/m);
		expect(context).not.toContain("# Memory");
	});
});

describe("SessionStart in mod mode with a stale view that stays", () => {
	it("warns once that the old view file could not be removed", async () => {
		const t = testAgent();
		seed(t.agent, ["a", "b"]);
		claudeSetupMod(t.agent);
		const dir = join(t.folder, ".orrery");
		mkdirSync(dir, { mode: 0o700 });
		writeFileSync(viewFile(t.folder), "old view");
		chmodSync(dir, 0o500);
		try {
			const out = JSON.parse(await runHook("session-start", input(t), ctx(t, { startHolder: answer("recording") }))) as { hookSpecificOutput: { additionalContext: string } };
			expect(out.hookSpecificOutput.additionalContext).toContain("old memory view file could not be removed");
			expect(out.hookSpecificOutput.additionalContext).toContain(`remove ${t.folder}/.orrery/view.md yourself`);
		} finally {
			chmodSync(dir, 0o700);
		}
	});
});

describe("UserPromptSubmit, Stop and SessionEnd", () => {
	it("spool the user's prompt and the turn's final reply, and nothing from subagents, slash commands or empty text", async () => {
		const t = testAgent({ setup: true });
		const c = ctx(t);
		const calls: Array<[string, object]> = [
			["user-prompt-submit", { prompt: "Ship the bridge fix." }],
			["user-prompt-submit", { prompt: "/tmp is full, clean it." }],
			["user-prompt-submit", { prompt: "/compact" }],
			["user-prompt-submit", { prompt: "/orrery:memory" }],
			["user-prompt-submit", { prompt: "/orrery:compactor openai/gpt-6.1-sol high" }],
			["user-prompt-submit", { prompt: "/orrery:memory", agent_id: "a1" }],
			["user-prompt-submit", { prompt: "/brainstorm the bridge" }],
			["user-prompt-submit", { prompt: "check it", agent_id: "a1" }],
			["user-prompt-submit", { prompt: "   " }],
			["stop", { last_assistant_message: "Fixed and pushed." }],
			["stop", { last_assistant_message: "" }],
			["stop", { last_assistant_message: "subagent done", agent_id: "a1" }],
		];
		for (const [event, extra] of calls) expect(await runHook(event, input(t, extra), c)).toBe("");
		expect(pendingEvents(t.agent.dir, "s1").map((e) => readEvent(e.path))).toEqual([
			{ kind: "prompt", at: expect.any(Number), claudePid: 4242, text: "Ship the bridge fix." },
			{ kind: "prompt", at: expect.any(Number), claudePid: 4242, text: "/tmp is full, clean it." },
			// orrery's own commands leave a text-less mark, so the holder keeps their replies out of memory.
			{ kind: "command", at: expect.any(Number), claudePid: 4242 },
			{ kind: "command", at: expect.any(Number), claudePid: 4242 },
			{ kind: "reply", at: expect.any(Number), claudePid: 4242, text: "Fixed and pushed." },
		]);
		const started = Date.now();
		expect(await runHook("session-end", input(t, { reason: "other" }), c)).toBe("");
		expect(Date.now() - started).toBeLessThan(500);
		expect(readEvent(pendingEvents(t.agent.dir, "s1").at(-1)!.path)).toMatchObject({ kind: "end", reason: "other" });
		expect(statSync(pendingEvents(t.agent.dir, "s1")[0].path).mode & 0o777).toBe(0o600);
		expect(statSync(sessionDir(t.agent.dir, "s1")).mode & 0o777).toBe(0o700);
	});

	it("spool nothing for a read-only session, or for a session id that is no id", async () => {
		const t = testAgent({ setup: true });
		writeMode(t.agent.dir, "s1", { mode: "read-only", pid: 1, claudePid: 4242, nonce: "n", since: 0 });
		await runHook("user-prompt-submit", input(t, { prompt: "not recorded" }), ctx(t));
		await runHook("user-prompt-submit", input(t, { session_id: "../../escape", prompt: "nowhere" }), ctx(t));
		expect(pendingEvents(t.agent.dir, "s1")).toEqual([]);
		expect(listSessions(t.agent.dir)).toEqual(["s1"]);
		expect(existsSync(join(t.agent.dir, "escape"))).toBe(false);
	});

	it("print nothing and write nothing outside an agent, and never echo input they cannot parse", async () => {
		const t = testAgent();
		const elsewhere = ctx(t, {
			env: { CLAUDE_PROJECT_DIR: t.dir },
			startHolder: () => {
				throw new Error("must not start");
			},
		});
		for (const event of HOOK_EVENTS) {
			const all = { cwd: t.dir, prompt: "x", last_assistant_message: "y", tool_name: "Read", tool_input: { file_path: "/x" } };
			expect(await runHook(event, input(t, all), elsewhere)).toBe("");
		}
		expect(existsSync(join(t.agent.dir, "claude"))).toBe(false);
		expect(await runHook("stop", '{"last_assistant_message": "secret words', ctx(t))).toBe("");
		await expect(runHook("nonsense", input(t), ctx(t))).rejects.toThrow(/unknown hook event nonsense/);
	});

	it("record nothing in an agent where claude-setup never ran: no holder, no spool, the guard still on, and a status that says so", async () => {
		const t = testAgent();
		seed(t.agent, ["Use pnpm here."]);
		const c = ctx(t, {
			startHolder: () => {
				throw new Error("must not start");
			},
		});
		const out = JSON.parse(await runHook("session-start", input(t, { source: "startup" }), c));
		const status = "Orrery · Test · 1 msgs · not set up for Claude Code here, so this session is not recorded; run `orrery claude-setup Test` to record it";
		expect(out).toEqual({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: status }, systemMessage: status });
		expect(await runHook("user-prompt-submit", input(t, { prompt: "An ad-hoc chat." }), c)).toBe("");
		expect(await runHook("user-prompt-submit", input(t, { prompt: "/orrery:memory" }), c)).toBe("");
		expect(await runHook("stop", input(t, { last_assistant_message: "An ad-hoc reply." }), c)).toBe("");
		expect(await runHook("session-end", input(t, { reason: "other" }), c)).toBe("");
		expect(existsSync(join(t.agent.dir, "claude"))).toBe(false);
		const denied = JSON.parse(await runHook("pre-tool-use", input(t, { tool_name: "Read", tool_input: { file_path: t.config.credentialsPath } }), c));
		expect(denied.hookSpecificOutput.permissionDecision).toBe("deny");
		// A marker that names another folder is no setup here either.
		writeSetupMarker(t.agent.dir, t.dir, "CLAUDE.md");
		await runHook("user-prompt-submit", input(t, { prompt: "Still ad hoc." }), c);
		expect(listSessions(t.agent.dir)).toEqual([]);
		expect(JSON.parse(await runHook("session-start", input(t), c)).hookSpecificOutput.additionalContext).toContain("not set up for Claude Code here");
	});
});

describe("SessionStart", () => {
	it("writes the memory view, starts the session's holder once, and tells the model whether it records", async () => {
		const t = testAgent({ setup: true });
		seed(t.agent, ["Use pnpm here.", "Switched to pnpm."]);
		const started: string[] = [];
		const c = ctx(t, {
			startHolder: (agent, session, nonce, since) => {
				started.push(session);
				void Holder.start({ agent, session, nonce, since, claudePid: 4242, models: agentModelSource(fauxModels().models), alive: () => true, tickMs: 20 }).then(
					(h) => h && holders.push(h),
				);
			},
			modeWaitMs: 5000,
		});
		const first = JSON.parse(await runHook("session-start", input(t, { source: "startup" }), c));
		expect(first).toEqual({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "Orrery · Test · 2 msgs · recording" } });
		expect(readFileSync(viewFile(t.folder), "utf8")).toContain("1+1|");
		// SessionStart writes the view itself: gone here, back once it returns. No holder tick runs in between, since
		// nothing in that SessionStart waits on a timer.
		rmSync(viewFile(t.folder));
		const again = JSON.parse(await runHook("session-start", input(t, { source: "compact" }), c));
		expect(again).toEqual({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "Orrery · Test · 2 msgs · recording" } });
		expect(readFileSync(viewFile(t.folder), "utf8")).toContain("1+1|");
		expect(started).toEqual(["s1"]);
	});

	it("brings the view file up to date itself, for a read-only session too", async () => {
		const t = testAgent();
		seed(t.agent, ["Use pnpm here."]);
		claudeSetup(t.agent);
		seed(t.agent, ["Codename Saffron."]);
		// Line 1+1 is the message added after claude-setup wrote the view.
		expect(readFileSync(viewFile(t.folder), "utf8")).not.toContain("1+1|");
		const out = JSON.parse(await runHook("session-start", input(t), ctx(t, { startHolder: answer("read-only") })));
		expect(out.hookSpecificOutput.additionalContext).toMatch(/^Orrery · Test · 2 msgs · read-only/);
		expect(readFileSync(viewFile(t.folder), "utf8")).toContain("1+1|");
	});

	it("says read-only when the agent is held elsewhere, and names the log when no holder answers", async () => {
		const t = testAgent();
		claudeSetup(t.agent);
		const readOnly = JSON.parse(await runHook("session-start", input(t), ctx(t, { startHolder: answer("read-only") })));
		expect(readOnly.hookSpecificOutput.additionalContext).toMatch(/^Orrery · Test · no memory yet · read-only/);
		expect(readOnly.systemMessage).toBe("Orrery: Test is open elsewhere (pi, or a session of another Claude Code); this session reads memory but is not recorded.");
		const silent = JSON.parse(await runHook("session-start", input(t, { session_id: "s2" }), ctx(t)));
		expect(silent.hookSpecificOutput.additionalContext).toContain("not recording yet");
		expect(silent.systemMessage).toContain(holderLog(t.agent.dir));
	});

	it("passes its own start time to the holder, the cut-off for a read-only run", async () => {
		const t = testAgent({ setup: true });
		const before = Date.now();
		let given = 0;
		const recording = answer("recording");
		await runHook("session-start", input(t), ctx(t, { startHolder: (agent, session, nonce, since) => recording(agent, session, nonce, (given = since)) }));
		expect(given).toBeGreaterThanOrEqual(before);
		expect(given).toBeLessThanOrEqual(Date.now());
	});

	it("asks for a start at the agent folder's root when Claude Code started in a subfolder", async () => {
		const t = testAgent();
		claudeSetup(t.agent);
		mkdirSync(join(t.folder, "sub"));
		const sub = join(t.folder, "sub");
		const out = JSON.parse(await runHook("session-start", input(t, { cwd: sub }), ctx(t, { env: { CLAUDE_PROJECT_DIR: sub }, startHolder: answer("recording") })));
		expect(out.systemMessage).toContain(`started in a subfolder of ${t.folder}`);
	});

	it("stops the view where git would see it: removes claude-setup's marker, deletes the view it wrote, and says why", async () => {
		const exposures: Array<[string, (git: (...args: string[]) => string, folder: string) => void, RegExp]> = [
			["a .gitignore that un-ignores .orrery/", (_git, folder) => writeFileSync(join(folder, ".gitignore"), "!.orrery/\n"), /not ignored by git/],
			["a tracked view file", (git) => git("add", "-f", ".orrery/view.md"), /git tracks .*`git rm --cached \.orrery\/view\.md`/],
		];
		for (const [, expose, reason] of exposures) {
			const t = testAgent();
			const git = gitIn(t.folder);
			git("init", "-q");
			seed(t.agent, ["Use pnpm here."]);
			claudeSetup(t.agent);
			expect(existsSync(setupMarker(t.agent.dir))).toBe(true);
			expose(git, t.folder);
			writeFileSync(viewFile(t.folder), "an older view\n");
			const out = JSON.parse(await runHook("session-start", input(t), ctx(t, { startHolder: answer("recording") })));
			expect(out.hookSpecificOutput.additionalContext).toMatch(reason);
			expect(out.systemMessage).toMatch(reason);
			expect(out.systemMessage).toContain("orrery claude-setup Test");
			expect(existsSync(setupMarker(t.agent.dir))).toBe(false);
			expect(existsSync(viewFile(t.folder))).toBe(false);
			// Setup is taken back, so this session is not recorded either.
			expect(out.hookSpecificOutput.additionalContext).toMatch(/^Orrery · Test · 1 msgs · not set up for Claude Code here/);
			expect(listSessions(t.agent.dir)).toEqual([]);
		}
	});

	it("takes the view out while git cannot say whether it would see it, and puts it back once git answers", async () => {
		const t = testAgent();
		gitIn(t.folder)("init", "-q");
		seed(t.agent, ["Use pnpm here."]);
		claudeSetup(t.agent);
		expect(existsSync(viewFile(t.folder))).toBe(true);
		const out = JSON.parse(await withGit(brokenGit(t), () => runHook("session-start", input(t), ctx(t, { startHolder: answer("recording") }))));
		expect(out.hookSpecificOutput.additionalContext).toContain("could not be checked against git this time");
		expect(out.systemMessage).toContain("git could not say");
		expect(out.systemMessage).toContain("taken out");
		expect(out.systemMessage).toContain("until git answers again");
		expect(out.systemMessage).not.toContain("orrery claude-setup");
		expect(existsSync(viewFile(t.folder))).toBe(false);
		expect(existsSync(setupMarker(t.agent.dir))).toBe(true);
		// Git works again: the next session gets its view, with nothing to fix.
		const next = JSON.parse(await runHook("session-start", input(t, { session_id: "s2" }), ctx(t, { startHolder: answer("recording") })));
		expect(next.systemMessage).toBeUndefined();
		expect(existsSync(viewFile(t.folder))).toBe(true);
	});

	it("says so when git would see the view but it cannot be removed, and keeps the marker to try again", async () => {
		const t = testAgent();
		gitIn(t.folder)("init", "-q");
		seed(t.agent, ["Use pnpm here."]);
		claudeSetup(t.agent);
		writeFileSync(join(t.folder, ".gitignore"), "!.orrery/\n");
		chmodSync(join(t.folder, ".orrery"), 0o500);
		try {
			const out = JSON.parse(await runHook("session-start", input(t), ctx(t, { startHolder: answer("recording") })));
			expect(out.systemMessage).toContain("not ignored by git");
			expect(out.systemMessage).toContain("could not be removed");
			expect(existsSync(setupMarker(t.agent.dir))).toBe(true);
		} finally {
			chmodSync(join(t.folder, ".orrery"), 0o700);
		}
	});
});

describe("summary notices", () => {
	const failing = (t: TestAgent) => {
		mkdirSync(t.agent.dir, { recursive: true });
		writeFileSync(join(t.agent.dir, "status.json"), JSON.stringify({ trouble: { state: "failing", plain: "the key was refused" } }));
	};

	it("shows a failing-summaries notice to the user once, through systemMessage only", async () => {
		const t = testAgent({ setup: true });
		failing(t);
		const c = ctx(t);
		const first = JSON.parse(await runHook("user-prompt-submit", input(t, { prompt: "hi" }), c));
		expect(first).toEqual({ systemMessage: expect.stringMatching(/^Orrery: Test's summaries are failing: the key was refused/) });
		expect(await runHook("user-prompt-submit", input(t, { prompt: "hi" }), c)).toBe("");
		expect(await runHook("stop", input(t, { last_assistant_message: "ok" }), c)).toBe("");
	});

	it("includes it in SessionStart's systemMessage, not the model's context, and the next prompt is silent", async () => {
		const t = testAgent({ setup: true });
		failing(t);
		const c = ctx(t, { startHolder: answer("recording") });
		const out = JSON.parse(await runHook("session-start", input(t, { source: "startup" }), c));
		expect(out.systemMessage).toMatch(/summaries are failing/);
		expect(out.hookSpecificOutput.additionalContext).not.toMatch(/summaries are failing/);
		expect(await runHook("user-prompt-submit", input(t, { prompt: "hi" }), c)).toBe("");
	});
});


describe("SessionStart holder reasons", () => {
	it.each([
		["read-only", "Test is open on macbook; run orrery agent takeover Test"],
		["read-only", "remote home cannot be reached"],
		["read-only", "No key for remote home on this machine: run orrery remote add home"],
		["recording", "Orrery: Test was saved from another machine; unsaved turns were kept aside."],
	] as const)("shows the %s holder's reason: %s", async (mode, reason) => {
		const t = testAgent();
		claudeSetupMod(t.agent);
		const out = JSON.parse(await runHook("session-start", input(t), ctx(t, { startHolder: (agent, session, nonce, since) => writeMode(agent.dir, session, { mode, pid: 1, claudePid: 4242, nonce, since, reason }) })));
		expect(out.systemMessage).toContain(reason);
		expect(out.hookSpecificOutput.additionalContext).toContain(reason);
		expect(out.systemMessage).not.toContain("open elsewhere");
	});
});
