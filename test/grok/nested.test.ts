import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claimedBy, claimToken, newToken } from "../../src/agent/pick.ts";
import { processArgv } from "../../src/agent/process.ts";
import { forgetSession, liveSession, recordSession, type SessionTool } from "../../src/agent/sessions.ts";
import { pendingEvents, readEvent } from "../../src/claude/spool.ts";
import { grokAgent, grokNested } from "../../src/codex/pick.ts";
import { type GrokHookContext, runGrokHook } from "../../src/grok/hooks.ts";
import { plainDeps, STARTS } from "../agent/plain-support.ts";
import { cleanup, world } from "../pi/world.ts";
import { type GrokHome, grokHomeIn, grokSession } from "./log-lines.ts";

const recorded: { dataDir: string; pid: number }[] = [];
const children: ChildProcess[] = [];
const homes: GrokHome[] = [];
afterEach(async () => {
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
	// The environment the grok process was started with: its sessions are under its GROK_HOME.
	envOf: () => ({ GROK_HOME: w.grok.home }),
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
