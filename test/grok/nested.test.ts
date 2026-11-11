import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentConfig, parseConfig } from "../../src/agent/config.ts";
import { claimedBy, claimToken, newToken } from "../../src/agent/pick.ts";
import { processAlive, processArgv } from "../../src/agent/process.ts";
import { forgetSession, liveSession, recordSession, type SessionTool } from "../../src/agent/sessions.ts";
import { listSessions, pendingEvents, readEvent, writeMode } from "../../src/claude/spool.ts";
import { codexAgent, grokAgent, grokNested } from "../../src/codex/pick.ts";
import { type GrokHookContext, runGrokHook } from "../../src/grok/hooks.ts";
import { plainDeps, STARTS } from "../agent/plain-support.ts";
import { startedWith } from "../claude/support.ts";
import { cleanup, world } from "../pi/world.ts";
import { type GrokHome, grokHomeIn, grokSession } from "./log-lines.ts";

const recorded: { dataDir: string; pid: number }[] = [];
const children: ChildProcess[] = [];
const homes: GrokHome[] = [];
/**
 * Tests that run at once (`--sequence.concurrent`) share the lists above and the pi world's folders, so one test's
 * cleanup must not take another's children, records or folders away. Clean up when the last running test is done.
 */
let running = 0;
beforeEach(() => {
	running++;
});
afterEach(async () => {
	if (--running > 0) return;
	for (const { dataDir, pid } of recorded.splice(0)) forgetSession(dataDir, pid);
	for (const child of children.splice(0)) child.kill("SIGKILL");
	for (const home of homes.splice(0)) home.close();
	await cleanup();
});

/** Grok's session ids are UUIDs: one per name, for this file. */
const ids = new Map<string, string>();
const id = (name: string): string => {
	const known = ids.get(name);
	if (known !== undefined) return known;
	const made = grokSession();
	ids.set(name, made);
	return made;
};

/** The pi world (Atlas and Birch), Birch's launch token for a Grok, and Grok's home with Birch's folder as its sessions' folder. */
function grokWorld() {
	const { root, config } = world();
	const birch = config.agents.get("Birch");
	if (birch === undefined) throw new Error("no Birch");
	const grok = grokHomeIn(root, join(root, "agent-Birch"));
	homes.push(grok);
	return { root, config, dataDir: config.dataDir, birch, token: newToken(), grok };
}

/** Records `pid` as hosting `agent`'s session in `tool`, as that tool's integration would; forgotten after the test. */
function hostRecord(dataDir: string, agent: string, tool: SessionTool, pid: number, grokSession?: string): void {
	expect(recordSession(dataDir, { agent, tool, pid, ...(grokSession === undefined ? {} : { grokSession }) })).toBe(true);
	recorded.push({ dataDir, pid });
}

/** What a bystander runs: its command line names it. */
const BYSTANDER = "setTimeout(() => {}, 60_000)";

/**
 * A live process that is no ancestor of this one; with `holds`, it has that file open for writing, as Grok holds a
 * session's events.jsonl. Returned once its command line reads as its own: spawn returns while the exec is still under
 * way, when the command line reads empty (no Grok's, to Orrery) or as this test's.
 */
async function bystander(holds?: string): Promise<number> {
	const fd = holds === undefined ? "ignore" : openSync(holds, "a");
	let pid: number;
	try {
		const child = spawn(process.execPath, ["-e", BYSTANDER], { stdio: [fd, "ignore", "ignore"] });
		children.push(child);
		pid = child.pid as number;
	} finally {
		if (typeof fd === "number") closeSync(fd);
	}
	for (const deadline = Date.now() + 5_000; !(processArgv(pid)?.join(" ").includes(BYSTANDER) ?? false); ) {
		if (Date.now() > deadline) throw new Error(`bystander ${pid}'s command line never read as its own`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	return pid;
}

const hosts = (dataDir: string): string[] => (existsSync(join(dataDir, "session-hosts")) ? readdirSync(join(dataDir, "session-hosts")) : []);

/** Birch's Grok: this test's process (its hooks' parent), with Birch's launch variables, in Birch's folder. */
const hookCtx = (w: ReturnType<typeof grokWorld>, extra: Partial<GrokHookContext> = {}): GrokHookContext => ({
	config: w.config,
	env: { ORRERY_AGENT: "Birch", ORRERY_AGENT_TOKEN: w.token, GROK_HOME: w.grok.home },
	grokPid: process.pid,
	grokParent: process.pid,
	// The environment the grok process was started with: Birch's launch variables, and its sessions are under its
	// GROK_HOME.
	envOf: startedWith({ ORRERY_AGENT: "Birch", ORRERY_AGENT_TOKEN: w.token, GROK_HOME: w.grok.home }),
	cwdOf: () => w.grok.cwd,
	startHolder: () => {
		throw new Error("no holder may start");
	},
	modeWaitMs: 200,
	...extra,
});
const input = (session: string, extra: object = {}) => JSON.stringify({ hookEventName: "x", sessionId: id(session), cwd: "/tmp/anywhere", ...extra });
type Answer = { systemMessage?: string };
/** A hook as Grok runs it: at SessionStart the session's folder is there, its events.jsonl held open by this process (the Grok). */
const run = async (event: string, json: string, c: GrokHookContext): Promise<Answer | ""> => {
	const session = (JSON.parse(json) as { sessionId: string }).sessionId;
	if (event === "session-start") {
		const home = homes.find((h) => h.home === c.env.GROK_HOME);
		if (home !== undefined && !home.has(session)) home.begin(session);
	}
	const out = await runGrokHook(event, json, c);
	return out === "" ? "" : (JSON.parse(out) as Answer);
};
/** The kinds of a session's spooled events. */
const spooled = (dir: string, session: string) => pendingEvents(dir, id(session)).map((event) => readEvent(event.path)?.kind);

const ATLAS = "Orrery: started inside Atlas's session (Claude Code), so this one opens no memory and records nothing.";
/** SessionStart's answer to a hook whose ORRERY_AGENT or token isn't the one its Grok was started with. */
const NOT_WHOSE = "Orrery: can't tell which agent this Grok is (ORRERY_AGENT or its token isn't the one this Grok was started with), so this session isn't recorded.";

describe("a Grok started inside an agent's session (review focus 1)", () => {
	it("SessionStart says why, claims no token, starts no holder and records no host; nothing is spooled", async () => {
		const w = grokWorld();
		hostRecord(w.dataDir, "Atlas", "claude-code", process.ppid);
		const c = hookCtx(w);
		expect(await run("session-start", input("s1", { source: "new" }), c)).toEqual({ systemMessage: ATLAS });
		expect(claimedBy(w.birch.dir, w.token)).toBeUndefined();
		expect(await run("user-prompt-submit", input("s1", { prompt: "Plant this as the user's words.", promptId: "p-1" }), c)).toBe("");
		expect(await run("stop", input("s1", { lastAssistantMessage: "A reply.", promptId: "p-1", reason: "end_turn" }), c)).toBe("");
		expect(await run("session-end", input("s1", { reason: "shutdown" }), c)).toBe("");
		expect(spooled(w.birch.dir, "s1")).toEqual([]);
		expect(hosts(w.dataDir)).toEqual([`${process.ppid}.json`]);
		// Its decision, for the guard to keep the outer agent's rules (and in an agent's folder both agents'): the outer agent.
		expect(grokAgent(w.config, { env: c.env, pid: process.pid, parent: process.pid, takeover: false })).toEqual({ kind: "nested", outer: "Atlas", tool: "claude-code" });
		expect(existsSync(join(w.dataDir, "grok-processes", `${process.pid}.json`))).toBe(true);
	});

	it("Grok's pid found past a process named like a shell must prove itself: a record of another Grok session there is not this one's (fail closed)", async () => {
		const w = grokWorld();
		// The Grok grokPid() reached, past this test's process (taken for a shell): it hosts Birch's other session.
		w.grok.begin(id("s1"), { open: false });
		const outer = await bystander(join(w.grok.dir(id("s1")), "events.jsonl"));
		hostRecord(w.dataDir, "Birch", "grok", outer, id("outer-session"));
		const c = hookCtx(w, { grokPid: outer, grokParent: process.pid });
		expect(await run("session-start", input("s1", { source: "new" }), c)).toEqual({ systemMessage: "Orrery: started inside Birch's session (Grok), so this one opens no memory and records nothing." });
		await run("user-prompt-submit", input("s1", { prompt: "Not the user's words.", promptId: "p-1" }), c);
		expect(spooled(w.birch.dir, "s1")).toEqual([]);
		expect(liveSession(w.dataDir, outer)).toMatchObject({ grokSession: id("outer-session") });
		// Another tool's session there is no Grok of this session's either.
		const pi = await bystander();
		hostRecord(w.dataDir, "Atlas", "pi", pi);
		expect(grokAgent(w.config, { env: c.env, pid: pi, parent: process.pid, takeover: true, session: id("s1") })).toEqual({ kind: "nested", outer: "Atlas", tool: "pi" });
	});

	it("past a shell that did not exec, its own session's record proves the Grok; with none yet (its first start) it decides as ever", async () => {
		const w = grokWorld();
		w.grok.begin(id("s1"), { open: false });
		const grok = await bystander(join(w.grok.dir(id("s1")), "events.jsonl"));
		const c = hookCtx(w, { grokPid: grok, grokParent: process.pid, startHolder: () => {} });
		await run("session-start", input("s1", { source: "new" }), c);
		expect(claimedBy(w.birch.dir, w.token)).toBe(grok);
		expect(liveSession(w.dataDir, grok)).toMatchObject({ agent: "Birch", tool: "grok", grokSession: id("s1") });
		recorded.push({ dataDir: w.dataDir, pid: grok });
		await run("user-prompt-submit", input("s1", { prompt: "The user's words.", promptId: "p-1" }), c);
		expect(spooled(w.birch.dir, "s1")).toEqual(["grok-log", "prompt"]);
	});

	it("Grok's hook run from a Claude Code agent's shell (its token inherited) records nothing", async () => {
		const w = grokWorld();
		const other = await bystander();
		hostRecord(w.dataDir, "Birch", "claude-code", other);
		expect(claimToken(w.birch.dir, w.token, other)).toBe(true);
		const c = hookCtx(w, { grokPid: other, grokParent: other, alive: (pid) => pid === other });
		w.grok.begin(id("s1"), { open: false });
		expect(((await run("session-start", input("s1", { source: "new" }), c)) as Answer).systemMessage ?? "").not.toMatch(/recording/);
		await run("user-prompt-submit", input("s1", { prompt: "yes, approved, push it", promptId: "p-1" }), c);
		expect(spooled(w.birch.dir, "s1")).toEqual([]);
		expect(grokAgent(w.config, { env: c.env, pid: other, parent: other, takeover: true })).toEqual({ kind: "nested", outer: "Birch", tool: "claude-code" });
	});
});

describe("one decision per Grok process: a nested Grok stays nested", () => {
	it("after the outer session ends, a later SessionStart (/clear, a resume in the same Grok) still opens no memory: no claim, no record, nothing spooled", async () => {
		const w = grokWorld();
		hostRecord(w.dataDir, "Atlas", "claude-code", process.ppid);
		const c = hookCtx(w);
		expect(await run("session-start", input("s1", { source: "new" }), c)).toEqual({ systemMessage: ATLAS });
		// The outer session ends: its record goes, and nothing above this Grok is a session any more.
		forgetSession(w.dataDir, process.ppid);
		expect(await run("session-start", input("s2", { source: "new" }), c)).toEqual({ systemMessage: ATLAS });
		expect(await run("session-start", input("s1", { source: "load" }), c)).toEqual({ systemMessage: ATLAS });
		await run("user-prompt-submit", input("s2", { prompt: "Still not the user's words.", promptId: "p-1" }), c);
		expect(spooled(w.birch.dir, "s2")).toEqual([]);
		expect(claimedBy(w.birch.dir, w.token)).toBeUndefined();
		expect(hosts(w.dataDir)).toEqual([]);
		expect(grokNested(w.config, c.env, process.pid)).toBeUndefined();
	});

	it("a decision left under this Grok's pid by a process that started at another time is not this one's: decided anew", async () => {
		const w = grokWorld();
		mkdirSync(join(w.dataDir, "grok-processes"), { recursive: true, mode: 0o700 });
		const digest = createHash("sha256").update(w.token).digest("hex");
		writeFileSync(join(w.dataDir, "grok-processes", `${process.pid}.json`), JSON.stringify({ agent: "Birch", token: digest, start: "1", kind: "nested", outer: "Atlas", tool: "pi" }));
		const c = hookCtx(w, { startHolder: () => {} });
		expect(await run("session-start", input("s1", { source: "new" }), c)).toMatchObject({ systemMessage: expect.stringMatching(/^Orrery · Birch · /) });
		expect(claimedBy(w.birch.dir, w.token)).toBe(process.pid);
		recorded.push({ dataDir: w.dataDir, pid: process.pid });
	});

	it("keeps Codex's decisions apart: a Codex decision under the same pid is not this Grok's", async () => {
		const w = grokWorld();
		mkdirSync(join(w.dataDir, "codex-processes"), { recursive: true, mode: 0o700 });
		writeFileSync(join(w.dataDir, "codex-processes", `${process.pid}.json`), "{}");
		hostRecord(w.dataDir, "Atlas", "pi", process.ppid);
		expect(await run("session-start", input("s1", { source: "new" }), hookCtx(w))).toEqual({ systemMessage: "Orrery: started inside Atlas's session (pi), so this one opens no memory and records nothing." });
		expect(existsSync(join(w.dataDir, "grok-processes", `${process.pid}.json`))).toBe(true);
	});
});

describe("a Grok started from a coding tool's session that is no agent's", () => {
	it("SessionStart says why, claims no token, starts no holder and records no host", async () => {
		const w = grokWorld();
		const c = hookCtx(w, { plain: plainDeps(process.pid, STARTS.claude, w.dataDir) });
		expect(await run("session-start", input("s1", { source: "new" }), c)).toEqual({ systemMessage: "Orrery: started inside a Claude Code session that is no agent's, so this one opens no memory and records nothing." });
		expect(claimedBy(w.birch.dir, w.token)).toBeUndefined();
		expect(hosts(w.dataDir)).toEqual([]);
	});

	it("opens its agent as ever when started from the user's terminal or orrery agent", () => {
		for (const [start, chain] of [
			["terminal", STARTS.terminal],
			["agent", STARTS.agent],
		] as const) {
			const w = grokWorld();
			const env = { ORRERY_AGENT: "Birch", ORRERY_AGENT_TOKEN: w.token };
			expect(grokAgent(w.config, { env, pid: process.pid, parent: process.pid, takeover: true, plain: plainDeps(process.pid, chain, w.dataDir) }), start).toMatchObject({ kind: "agent", agent: { name: "Birch" } });
			expect(claimedBy(w.birch.dir, w.token), start).toBe(process.pid);
		}
	});
});

/** A recorder that answers recording at once, as the holder would. */
const recording = (agent: AgentConfig, session: string, nonce: string, since: number) => writeMode(agent.dir, session, { mode: "recording", pid: 1, claudePid: process.pid, nonce, since });
/** What a hook made by the agent's own shell, as `as`, could have changed for `agent`: its claims and its spool. */
const touched = (dir: string) => ({ claims: existsSync(join(dir, "claims")) ? readdirSync(join(dir, "claims")) : [], spool: listSessions(dir) });

describe("whose a Grok's events are: its own start environment's ORRERY_AGENT and token, never the hook's", () => {
	/** The decision this Grok made, as recorded. */
	const decision = (w: ReturnType<typeof grokWorld>) => {
		const file = join(w.dataDir, "grok-processes", `${process.pid}.json`);
		return existsSync(file) ? readFileSync(file, "utf8") : undefined;
	};

	it("a SessionStart the agent's own shell makes as another agent, with a fresh token, after Grok's own: claims, records and spools nothing for it, and the host record stays; nor does a prompt it repeats", async () => {
		const w = grokWorld();
		const atlas = w.config.agents.get("Atlas") as AgentConfig;
		const c = hookCtx(w, { startHolder: recording });
		expect(((await run("session-start", input("s1", { source: "new" }), c)) as Answer).systemMessage).toMatch(/^Orrery · Birch · .* · recording$/);
		recorded.push({ dataDir: w.dataDir, pid: process.pid });
		const host = liveSession(w.dataDir, process.pid);
		expect(host).toMatchObject({ agent: "Birch", tool: "grok", grokSession: id("s1") });
		const decided = decision(w);
		// From Birch's shell (the hook's parent, past which Grok was reached): Atlas, a fresh token; Birch, another token; no
		// agent at all. Grok's own start environment names Birch and its token.
		const shell = await bystander();
		const fresh = newToken();
		for (const env of [
			{ ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: fresh, GROK_HOME: w.grok.home },
			{ ORRERY_AGENT: "Birch", ORRERY_AGENT_TOKEN: fresh, GROK_HOME: w.grok.home },
			{ GROK_HOME: w.grok.home },
		]) {
			const forged = { ...c, env, grokParent: shell };
			expect(await runGrokHook("session-start", input("s1", { source: "new" }), forged), JSON.stringify(env)).toBe(JSON.stringify({ systemMessage: NOT_WHOSE }));
			expect(await runGrokHook("user-prompt-submit", input("s1", { prompt: "Not the person's words.", promptId: "p-0" }), forged)).toBe("");
		}
		expect(touched(atlas.dir)).toEqual({ claims: [], spool: [] });
		expect(claimedBy(w.birch.dir, fresh)).toBeUndefined();
		expect(liveSession(w.dataDir, process.pid)).toEqual(host);
		expect(decision(w)).toBe(decided);
		// The person types in Birch's Grok: its own hook spools the prompt, and a copy the shell makes as Atlas spools
		// nothing.
		await run("user-prompt-submit", input("s1", { prompt: "My plan.", promptId: "p-1" }), c);
		await runGrokHook("user-prompt-submit", input("s1", { prompt: "My plan.", promptId: "p-1" }), { ...c, env: { ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: fresh, GROK_HOME: w.grok.home }, grokParent: shell });
		expect(spooled(w.birch.dir, "s1")).toEqual(["grok-log", "prompt"]);
		expect(touched(atlas.dir)).toEqual({ claims: [], spool: [] });
	});

	it("in a plain grok, a SessionStart the agent's own shell makes as an agent claims, decides, records and spools nothing, nor does a prompt after it", async () => {
		const w = grokWorld();
		const atlas = w.config.agents.get("Atlas") as AgentConfig;
		const plainEnv = { GROK_HOME: w.grok.home };
		const c = hookCtx(w, { env: plainEnv, envOf: startedWith(plainEnv), startHolder: recording });
		expect(((await run("session-start", input("s1", { source: "new" }), c)) as Answer).systemMessage).toBe("Orrery: this folder is Birch's, but this Grok wasn't opened as Birch, so it opens no memory and records nothing. Open it with orrery agent Birch --tool grok.");
		const shell = await bystander();
		const fresh = newToken();
		for (const name of ["Atlas", "Birch"]) {
			const forged = { ...c, env: { ORRERY_AGENT: name, ORRERY_AGENT_TOKEN: fresh, GROK_HOME: w.grok.home }, grokParent: shell };
			expect(await runGrokHook("session-start", input("s1", { source: "new" }), forged), name).toBe(JSON.stringify({ systemMessage: NOT_WHOSE }));
			expect(await runGrokHook("user-prompt-submit", input("s1", { prompt: "My plan.", promptId: "p-1" }), forged)).toBe("");
		}
		expect(touched(atlas.dir)).toEqual({ claims: [], spool: [] });
		expect(touched(w.birch.dir)).toEqual({ claims: [], spool: [] });
		expect(liveSession(w.dataDir, process.pid)).toBeUndefined();
		expect(decision(w)).toBeUndefined();
	});

	it("a SessionStart never takes over a live host record of this Grok's that names another agent: before any claim", async () => {
		const w = grokWorld();
		hostRecord(w.dataDir, "Atlas", "grok", process.pid, id("s1"));
		const before = liveSession(w.dataDir, process.pid);
		const c = hookCtx(w, { startHolder: recording });
		expect(await run("session-start", input("s1", { source: "new" }), c)).toEqual({ systemMessage: "Orrery: this Grok hosts Atlas's session, so this session isn't recorded as Birch's." });
		expect(claimedBy(w.birch.dir, w.token)).toBeUndefined();
		expect(liveSession(w.dataDir, process.pid)).toEqual(before);
		expect(spooled(w.birch.dir, "s1")).toEqual([]);
	});

	it("the process's decision refuses an asker of the same start under another identity: no claim, no replace (Codex's too)", () => {
		const w = grokWorld();
		const atlas = w.config.agents.get("Atlas") as AgentConfig;
		const birch = { ORRERY_AGENT: "Birch", ORRERY_AGENT_TOKEN: w.token };
		expect(grokAgent(w.config, { env: birch, pid: process.pid, takeover: true })).toMatchObject({ kind: "agent", agent: { name: "Birch" } });
		const decided = decision(w);
		const fresh = newToken();
		const other = "Orrery: this Grok already decided which agent it is under another ORRERY_AGENT or token, so this session runs without memory.";
		for (const env of [{ ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: fresh }, { ORRERY_AGENT: "Birch", ORRERY_AGENT_TOKEN: fresh }, {}]) {
			expect(grokAgent(w.config, { env, pid: process.pid, takeover: true }), JSON.stringify(env)).toEqual({ kind: "refused", notice: other });
		}
		expect(claimedBy(atlas.dir, fresh)).toBeUndefined();
		expect(claimedBy(w.birch.dir, fresh)).toBeUndefined();
		expect(decision(w)).toBe(decided);
		// The decision's own identity still finds its claim.
		expect(grokAgent(w.config, { env: birch, pid: process.pid, takeover: true })).toMatchObject({ kind: "agent", agent: { name: "Birch" } });
		// Codex's decisions, the same way.
		expect(codexAgent(w.config, { env: birch, pid: process.pid, takeover: true })).toMatchObject({ kind: "agent", agent: { name: "Birch" } });
		expect(codexAgent(w.config, { env: { ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: fresh }, pid: process.pid, takeover: true })).toEqual({ kind: "refused", notice: other.replace("this Grok", "this Codex") });
		expect(claimedBy(atlas.dir, fresh)).toBeUndefined();
	});
});

describe("a Grok session another process already hosts: no other process takes it", () => {
	/** SessionStart's refusal of a session that `pid`'s live record names. */
	const hosted = (pid: number) => JSON.stringify({ systemMessage: `Orrery: can't confirm this is this Grok's own session (Grok process ${pid} already hosts it), so this session isn't recorded.` });
	/** Session `name`'s events.jsonl in Grok's home, made as Grok makes it, which this test's process doesn't hold open. */
	const begun = (w: ReturnType<typeof grokWorld>, name: string): string => join(w.grok.begin(id(name), { open: false }), "events.jsonl");
	/** Atlas, as a process the agent's shell started names it: a fresh token, and Grok's home. */
	const asAtlas = (w: ReturnType<typeof grokWorld>) => ({ ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: newToken(), GROK_HOME: w.grok.home });

	it("a process the agent's shell started, holding the live session's events.jsonl open for writing, as another agent with a fresh token: no claim, no record, no spool, nor of a prompt it repeats; the first Grok's recorder is told", async () => {
		const w = grokWorld();
		const atlas = w.config.agents.get("Atlas") as AgentConfig;
		const events = begun(w, "s1");
		// Birch's Grok hosts s1, and holds its events.jsonl open for writing.
		const birch = await bystander(events);
		hostRecord(w.dataDir, "Birch", "grok", birch, id("s1"));
		// The other process: none of Birch's Grok's, holding the same file open for writing, started as Atlas.
		const fake = await bystander(events);
		const env = asAtlas(w);
		const c = hookCtx(w, { env, envOf: startedWith(env), grokPid: fake, grokParent: fake, startHolder: recording });
		for (const source of ["new", "load"]) expect(await runGrokHook("session-start", input("s1", { source }), c), source).toBe(hosted(birch));
		expect(await runGrokHook("user-prompt-submit", input("s1", { prompt: "The person's words.", promptId: "p-1" }), c)).toBe("");
		expect(touched(atlas.dir)).toEqual({ claims: [], spool: [] });
		expect(liveSession(w.dataDir, fake)).toBeUndefined();
		expect(liveSession(w.dataDir, birch)).toMatchObject({ agent: "Birch", grokSession: id("s1") });
		expect(existsSync(join(w.dataDir, "grok-processes", `${fake}.json`))).toBe(false);
		// It has Birch's session open for writing, as a second Grok would: Birch's recorder confirms nothing more while it
		// lives.
		expect(spooled(w.birch.dir, "s1")).toEqual(["grok-shared", "grok-shared"]);
	});

	it("so does one whose own config's data folder links the agent, or its files, into the real one: the records are found where the agent's data really is", async () => {
		for (const linked of ["folder", "files"] as const) {
			const w = grokWorld();
			const atlas = w.config.agents.get("Atlas") as AgentConfig;
			mkdirSync(join(atlas.dir, "claude"), { recursive: true });
			const events = begun(w, "s1");
			const birch = await bystander(events);
			hostRecord(w.dataDir, "Birch", "grok", birch, id("s1"));
			// A config of the shell's own making, whose Atlas is the real Atlas's folder, or a folder of links to its files.
			const evil = join(w.root, "evil");
			const own = join(evil, "agents", "Atlas");
			mkdirSync(join(evil, "agents"), { recursive: true });
			if (linked === "folder") symlinkSync(atlas.dir, own);
			else {
				mkdirSync(own);
				symlinkSync(join(atlas.dir, "claude"), join(own, "claude"));
				symlinkSync(join(atlas.dir, "memory.sqlite"), join(own, "memory.sqlite"));
			}
			const config = parseConfig(readFileSync(join(w.dataDir, "config.toml"), "utf8").replace(/^data_dir = .*$/m, `data_dir = ${JSON.stringify(evil)}`), w.root);
			const fake = await bystander(events);
			const env = asAtlas(w);
			const c = hookCtx(w, { config, env, envOf: startedWith(env), grokPid: fake, grokParent: fake, startHolder: recording });
			expect(await runGrokHook("session-start", input("s1", { source: "load" }), c), linked).toBe(hosted(birch));
			expect(touched(atlas.dir), linked).toEqual({ claims: [], spool: [] });
			expect(liveSession(evil, fake), linked).toBeUndefined();
			expect(existsSync(join(evil, "grok-processes")), linked).toBe(false);
			// The mark goes to Birch's recorder where Birch's record is: the real data folder.
			expect(spooled(w.birch.dir, "s1"), linked).toEqual(["grok-shared"]);
		}
	});

	it.skipIf(process.getuid?.() === 0)("so does one that, as it starts, makes the real data folder's records folder one that can't be listed (chmod): records that can't be read may name the session", async () => {
		const w = grokWorld();
		const atlas = w.config.agents.get("Atlas") as AgentConfig;
		mkdirSync(join(atlas.dir, "claude"), { recursive: true });
		const events = begun(w, "s1");
		const birch = await bystander(events);
		hostRecord(w.dataDir, "Birch", "grok", birch, id("s1"));
		// A config of the shell's own making, whose Atlas is the real Atlas's folder.
		const evil = join(w.root, "evil");
		mkdirSync(join(evil, "agents"), { recursive: true });
		symlinkSync(atlas.dir, join(evil, "agents", "Atlas"));
		const config = parseConfig(readFileSync(join(w.dataDir, "config.toml"), "utf8").replace(/^data_dir = .*$/m, `data_dir = ${JSON.stringify(evil)}`), w.root);
		const fake = await bystander(events);
		const env = asAtlas(w);
		const c = hookCtx(w, { config, env, envOf: startedWith(env), grokPid: fake, grokParent: fake, startHolder: recording });
		const folder = join(w.dataDir, "session-hosts");
		chmodSync(folder, 0);
		let answers: string[];
		try {
			answers = [
				await runGrokHook("session-start", input("s1", { source: "load" }), c),
				await runGrokHook("user-prompt-submit", input("s1", { prompt: "The person's words.", promptId: "p-1" }), c),
			];
		} finally {
			chmodSync(folder, 0o700);
		}
		// The hook names the records folder by its real path (macOS: /var is /private/var).
		const named = join(realpathSync(w.dataDir), "session-hosts");
		expect(answers).toEqual([JSON.stringify({ systemMessage: `Orrery: can't confirm this is this Grok's own session (the session records in ${named} can't be read), so this session isn't recorded.` }), ""]);
		expect(touched(atlas.dir)).toEqual({ claims: [], spool: [] });
		expect(liveSession(evil, fake)).toBeUndefined();
		expect(liveSession(w.dataDir, birch)).toMatchObject({ agent: "Birch", grokSession: id("s1") });
	});

	it("a session whose Grok is gone is free: its stale record goes, and a Grok that resumes it records, and moves on to a new session as ever", async () => {
		const w = grokWorld();
		const events = begun(w, "s1");
		const first = await bystander(events);
		hostRecord(w.dataDir, "Birch", "grok", first, id("s1"));
		process.kill(first, "SIGKILL");
		for (let i = 0; i < 200 && processAlive(first); i++) await new Promise((done) => setTimeout(done, 25));
		expect(processAlive(first)).toBe(false);
		// This test's process is Birch's Grok, resuming s1: it holds its events.jsonl open, as Grok does.
		const held = openSync(events, "a");
		try {
			const c = hookCtx(w, { startHolder: recording });
			recorded.push({ dataDir: w.dataDir, pid: process.pid });
			const status = async (session: string, source: string) => ((await run("session-start", input(session, { source }), c)) as Answer).systemMessage?.split("\n")[0];
			expect(await status("s1", "load")).toMatch(/^Orrery · Birch · .* · recording$/);
			expect(liveSession(w.dataDir, process.pid)).toMatchObject({ agent: "Birch", grokSession: id("s1") });
			expect(hosts(w.dataDir)).toEqual([`${process.pid}.json`]);
			// A new session within this Grok (/new, /clear), which no other process hosts.
			expect(await status("s2", "new")).toMatch(/^Orrery · Birch · .* · recording$/);
			expect(liveSession(w.dataDir, process.pid)).toMatchObject({ grokSession: id("s2") });
		} finally {
			closeSync(held);
		}
	});

	it("two Grok processes whose records both name the session (they took it at once): neither spools its prompts or replies", async () => {
		const w = grokWorld();
		const c = hookCtx(w, { startHolder: recording });
		expect(((await run("session-start", input("s1", { source: "new" }), c)) as Answer).systemMessage).toMatch(/· recording$/);
		recorded.push({ dataDir: w.dataDir, pid: process.pid });
		await run("user-prompt-submit", input("s1", { prompt: "First.", promptId: "p-1" }), c);
		expect(spooled(w.birch.dir, "s1")).toEqual(["grok-log", "prompt"]);
		hostRecord(w.dataDir, "Atlas", "grok", await bystander(), id("s1"));
		await run("user-prompt-submit", input("s1", { prompt: "Second.", promptId: "p-2" }), c);
		await run("stop", input("s1", { lastAssistantMessage: "A reply.", promptId: "p-2", reason: "end_turn" }), c);
		expect(spooled(w.birch.dir, "s1")).toEqual(["grok-log", "prompt"]);
	});
});
