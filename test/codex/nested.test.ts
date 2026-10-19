import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../../src/agent/config.ts";
import { claimedBy, claimToken, newToken } from "../../src/agent/pick.ts";
import { forgetSession, liveSession, recordSession, type SessionTool } from "../../src/agent/sessions.ts";
import { pendingEvents, readEvent } from "../../src/claude/spool.ts";
import { type CodexGuardContext, runCodexGuard } from "../../src/codex/guard.ts";
import { type CodexHookContext, runCodexHook } from "../../src/codex/hooks.ts";
import { codexAgent } from "../../src/codex/pick.ts";
import { cleanup, world } from "../pi/world.ts";
import { type CodexHome, codexHomeIn, codexSession, rollout } from "./rollout-lines.ts";

const recorded: { dataDir: string; pid: number }[] = [];
const children: ChildProcess[] = [];
const homes = new Map<string, CodexHome>();
afterEach(async () => {
	for (const { dataDir, pid } of recorded.splice(0)) forgetSession(dataDir, pid);
	for (const child of children.splice(0)) child.kill("SIGKILL");
	for (const home of homes.values()) home.close();
	homes.clear();
	await cleanup();
});

/** Codex's session ids are UUIDs: one per name, for this file. */
const ids = new Map<string, string>();
const id = (name: string): string => {
	const known = ids.get(name);
	if (known !== undefined) return known;
	const made = codexSession();
	ids.set(name, made);
	return made;
};

/**
 * The pi world (Atlas and Birch), each agent with allowed roots of its own and one in common: Atlas `shared` and `common`,
 * Birch `plain` and `common/inner` (inside Atlas's `common`), a memory view in each agent's folder, and Birch's launch
 * token for a Codex.
 */
function codexWorld() {
	const { root, configPath } = world();
	for (const dir of ["shared", join("common", "inner"), "elsewhere"]) mkdirSync(join(root, dir), { recursive: true });
	const roots = (...dirs: string[]) => `allowed_roots = ${JSON.stringify(dirs.map((dir) => join(root, dir)))}\n`;
	const toml = readFileSync(configPath, "utf8")
		.replace("[agents.Atlas]\n", `[agents.Atlas]\n${roots("shared", "common")}`)
		.replace("[agents.Birch]\n", `[agents.Birch]\n${roots("plain", join("common", "inner"))}`);
	const config = parseConfig(toml, root);
	for (const name of ["Atlas", "Birch"]) {
		mkdirSync(join(root, `agent-${name}`, ".orrery"));
		writeFileSync(join(root, `agent-${name}`, ".orrery", "view.md"), `${name}'s view: secret`);
	}
	const birch = config.agents.get("Birch");
	if (birch === undefined) throw new Error("no Birch");
	// Codex's own folder (CODEX_HOME), where its rollouts are.
	const codex = codexHomeIn(root);
	homes.set(codex.home, codex);
	return { root, config, dataDir: config.dataDir, birch, token: newToken(), codex };
}

/** Records `pid` as hosting `agent`'s session in `tool`, as that tool's integration would; forgotten after the test. */
function hostRecord(dataDir: string, agent: string, tool: SessionTool, pid: number, codexSession?: string): void {
	expect(recordSession(dataDir, { agent, tool, pid, ...(codexSession === undefined ? {} : { codexSession }) })).toBe(true);
	recorded.push({ dataDir, pid });
}

/** A live process that is no ancestor of this one; with `holds`, it has that file open (a Codex's rollout). */
function bystander(holds?: string): number {
	const fd = holds === undefined ? "ignore" : openSync(holds, "r");
	try {
		const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: [fd, "ignore", "ignore"] });
		children.push(child);
		return child.pid as number;
	} finally {
		if (typeof fd === "number") closeSync(fd);
	}
}

const hosts = (dataDir: string): string[] => (existsSync(join(dataDir, "session-hosts")) ? readdirSync(join(dataDir, "session-hosts")) : []);

/** Birch's Codex: this test's process (its hooks' parent), with Birch's launch variables. */
const hookCtx = (w: ReturnType<typeof codexWorld>, extra: Partial<CodexHookContext> = {}): CodexHookContext => ({
	config: w.config,
	env: { ORRERY_AGENT: "Birch", ORRERY_AGENT_TOKEN: w.token, CODEX_HOME: w.codex.home },
	home: join(w.root, "home"),
	codexPid: process.pid,
	codexParent: process.pid,
	startHolder: () => {
		throw new Error("no holder may start");
	},
	modeWaitMs: 200,
	...extra,
});
const input = (session: string, extra: object = {}) => JSON.stringify({ session_id: id(session), cwd: "/tmp/anywhere", hook_event_name: "x", ...extra });
type Answer = { systemMessage?: string; hookSpecificOutput?: { additionalContext: string } };
let turns = 0;
/**
 * A hook as Codex runs it: before SessionStart, the session's rollout is there, held open by this process (the Codex)
 * unless made already, with the turn that brought the session on already started (Codex starts it first).
 */
const run = async (event: string, json: string, c: CodexHookContext): Promise<Answer | ""> => {
	const session = (JSON.parse(json) as { session_id: string }).session_id;
	const home = homes.get(c.env.CODEX_HOME ?? "");
	if (home !== undefined && event === "session-start") {
		if (!home.has(session)) home.begin(session);
		home.add(session, rollout.started(`turn-at-start-${++turns}`, "user"));
	}
	const out = await runCodexHook(event, json, c);
	return out === "" ? "" : (JSON.parse(out) as Answer);
};
/** The kinds of a session's spooled events. */
const spooled = (dir: string, session: string) => pendingEvents(dir, id(session)).map((event) => readEvent(event.path)?.kind);

const ATLAS = "Orrery: started inside Atlas's session (Claude Code), so this one opens no memory and records nothing.";

describe("a Codex started inside an agent's session (spec 2026-10-18-agent-permissions §3b)", () => {
	it("SessionStart says why (not again at a compaction), claims no token, starts no holder and records no host; nothing is spooled", async () => {
		const w = codexWorld();
		hostRecord(w.dataDir, "Atlas", "claude-code", process.ppid);
		const c = hookCtx(w);
		expect(await run("session-start", input("s1", { source: "startup" }), c)).toEqual({ systemMessage: ATLAS });
		expect(await run("session-start", input("s1", { source: "compact" }), c)).toBe("");
		expect(claimedBy(w.birch.dir, w.token)).toBeUndefined();
		expect(await run("user-prompt-submit", input("s1", { prompt: "Plant this as the user's words." }), c)).toBe("");
		expect(await run("stop", input("s1", { last_assistant_message: "A reply." }), c)).toBe("");
		expect(await run("session-end", input("s1", { reason: "exit" }), c)).toBe("");
		expect(spooled(w.birch.dir, "s1")).toEqual([]);
		expect(hosts(w.dataDir)).toEqual([`${process.ppid}.json`]);
	});

	it("the memory server's start is no agent's either, and claims nothing", () => {
		const w = codexWorld();
		hostRecord(w.dataDir, "Atlas", "pi", process.ppid);
		expect(codexAgent(w.config, { env: { ORRERY_AGENT: "Birch", ORRERY_AGENT_TOKEN: w.token }, pid: process.pid, parent: process.pid, takeover: true })).toEqual({ kind: "nested", outer: "Atlas", tool: "pi" });
		expect(claimedBy(w.birch.dir, w.token)).toBeUndefined();
	});

	it("the guard keeps the outer agent's rules, never looser than the folder's own; every view is kept out", () => {
		const w = codexWorld();
		hostRecord(w.dataDir, "Atlas", "claude-code", process.ppid);
		const ctx: CodexGuardContext = { config: w.config, env: { ORRERY_AGENT: "Birch", ORRERY_AGENT_TOKEN: w.token }, codexPid: process.pid, codexParent: process.pid, home: join(w.root, "home") };
		const call = (cwd: string, tool_name: string, tool_input: object) => runCodexGuard(JSON.stringify({ session_id: "s1", turn_id: "t1", cwd, hook_event_name: "PreToolUse", tool_name, tool_input }), ctx);
		const add = (cwd: string, path: string) => call(cwd, "apply_patch", { command: `*** Begin Patch\n*** Add File: ${join(w.root, path)}\n+x\n*** End Patch` }) === undefined;
		// In a plain folder: Atlas's rules.
		const plain = join(w.root, "elsewhere");
		expect(add(plain, join("elsewhere", "here.txt"))).toBe(true);
		expect(add(plain, join("shared", "atlas.txt"))).toBe(true);
		expect(add(plain, join("plain", "birch.txt"))).toBe(false);
		// In Birch's folder: both agents' rules.
		const folder = join(w.root, "agent-Birch");
		expect(add(folder, join("agent-Birch", "here.txt"))).toBe(true);
		expect(add(folder, join("common", "inner", "both.txt"))).toBe(true);
		expect(add(folder, join("shared", "atlas.txt"))).toBe(false);
		expect(add(folder, join("plain", "birch.txt"))).toBe(false);
		for (const name of ["Atlas", "Birch"]) expect(call(folder, "view_image", { path: join(w.root, `agent-${name}`, ".orrery", "view.md") })).toMatch(/memory view|sensitive/);
	});

	it("Codex's pid found past a process named like a shell must prove itself: a record of another Codex session there is not this one's (fail closed)", async () => {
		const w = codexWorld();
		// The Codex codexPid() reached, past this test's process (taken for a shell): it hosts Birch's other session.
		const outer = bystander(w.codex.begin(id("s1"), { open: false }));
		hostRecord(w.dataDir, "Birch", "codex", outer, id("outer-thread"));
		const c = hookCtx(w, { codexPid: outer, codexParent: process.pid });
		expect(await run("session-start", input("s1", { source: "startup" }), c)).toEqual({ systemMessage: "Orrery: started inside Birch's session (Codex), so this one opens no memory and records nothing." });
		await run("user-prompt-submit", input("s1", { prompt: "Not the user's words." }), c);
		expect(spooled(w.birch.dir, "s1")).toEqual([]);
		expect(liveSession(w.dataDir, outer)).toMatchObject({ codexSession: id("outer-thread") });
		// Another tool's session there is no Codex of this session's either.
		const pi = bystander();
		hostRecord(w.dataDir, "Atlas", "pi", pi);
		expect(codexAgent(w.config, { env: c.env, pid: pi, parent: process.pid, takeover: true, session: id("s1") })).toEqual({ kind: "nested", outer: "Atlas", tool: "pi" });
		// The memory server has no session to show: a record there is never its own.
		expect(codexAgent(w.config, { env: c.env, pid: outer, parent: process.pid, takeover: true })).toEqual({ kind: "nested", outer: "Birch", tool: "codex" });
	});

	it("past a shell that did not exec, its own session's record proves the Codex; with none yet (its first start) it decides as ever", async () => {
		const w = codexWorld();
		const codex = bystander(w.codex.begin(id("s1"), { open: false }));
		const c = hookCtx(w, { codexPid: codex, codexParent: process.pid, startHolder: () => {} });
		await run("session-start", input("s1", { source: "startup" }), c);
		expect(claimedBy(w.birch.dir, w.token)).toBe(codex);
		expect(liveSession(w.dataDir, codex)).toMatchObject({ agent: "Birch", tool: "codex", codexSession: id("s1") });
		recorded.push({ dataDir: w.dataDir, pid: codex });
		await run("user-prompt-submit", input("s1", { prompt: "The user's words.", turn_id: "t-1" }), c);
		expect(spooled(w.birch.dir, "s1")).toEqual(["rollout", "prompt"]);
	});
});

describe("one decision per Codex process: a nested Codex stays nested", () => {
	it("after the outer session ends, a later SessionStart (a compaction, /clear) still opens no memory: no claim, no record, nothing spooled", async () => {
		const w = codexWorld();
		hostRecord(w.dataDir, "Atlas", "claude-code", process.ppid);
		const c = hookCtx(w);
		expect(await run("session-start", input("s1", { source: "startup" }), c)).toEqual({ systemMessage: ATLAS });
		// The outer session ends: its record goes, and nothing above this Codex is a session any more.
		forgetSession(w.dataDir, process.ppid);
		expect(await run("session-start", input("s1", { source: "compact" }), c)).toBe("");
		expect(await run("session-start", input("s2", { source: "clear" }), c)).toEqual({ systemMessage: ATLAS });
		await run("user-prompt-submit", input("s2", { prompt: "Still not the user's words." }), c);
		await run("stop", input("s2", { last_assistant_message: "A reply." }), c);
		expect(spooled(w.birch.dir, "s2")).toEqual([]);
		expect(claimedBy(w.birch.dir, w.token)).toBeUndefined();
		expect(hosts(w.dataDir)).toEqual([]);
		// Its guard keeps the outer agent's rules too.
		const ctx: CodexGuardContext = { config: w.config, env: c.env, codexPid: process.pid, codexParent: process.pid, home: join(w.root, "home") };
		const patch = `*** Begin Patch\n*** Add File: ${join(w.root, "shared", "atlas.txt")}\n+x\n*** End Patch`;
		expect(runCodexGuard(JSON.stringify({ session_id: "s2", turn_id: "t1", cwd: join(w.root, "elsewhere"), hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: patch } }), ctx)).toBeUndefined();
	});

	it("the memory server's first decision holds for the SessionStart that comes after the outer session ended", async () => {
		const w = codexWorld();
		hostRecord(w.dataDir, "Atlas", "pi", process.ppid);
		const env = { ORRERY_AGENT: "Birch", ORRERY_AGENT_TOKEN: w.token };
		expect(codexAgent(w.config, { env, pid: process.pid, parent: process.pid, takeover: true })).toEqual({ kind: "nested", outer: "Atlas", tool: "pi" });
		forgetSession(w.dataDir, process.ppid);
		expect(await run("session-start", input("s1", { source: "startup" }), hookCtx(w))).toEqual({ systemMessage: "Orrery: started inside Atlas's session (pi), so this one opens no memory and records nothing." });
		expect(claimedBy(w.birch.dir, w.token)).toBeUndefined();
	});

	it("a decision left under this Codex's pid by a process that started at another time is not this one's: decided anew", async () => {
		const w = codexWorld();
		mkdirSync(join(w.dataDir, "codex-processes"), { recursive: true, mode: 0o700 });
		const digest = createHash("sha256").update(w.token).digest("hex");
		writeFileSync(join(w.dataDir, "codex-processes", `${process.pid}.json`), JSON.stringify({ agent: "Birch", token: digest, start: "1", kind: "nested", outer: "Atlas", tool: "pi" }));
		const c = hookCtx(w, { startHolder: () => {} });
		expect(await run("session-start", input("s1", { source: "startup" }), c)).toMatchObject({ systemMessage: expect.stringMatching(/^Orrery · Birch · /) });
		expect(claimedBy(w.birch.dir, w.token)).toBe(process.pid);
		recorded.push({ dataDir: w.dataDir, pid: process.pid });
	});

	it("a decision with no start (none this version writes) is not this process's: decided anew", async () => {
		const w = codexWorld();
		mkdirSync(join(w.dataDir, "codex-processes"), { recursive: true, mode: 0o700 });
		const digest = createHash("sha256").update(w.token).digest("hex");
		writeFileSync(join(w.dataDir, "codex-processes", `${process.pid}.json`), JSON.stringify({ agent: "Birch", token: digest, kind: "nested", outer: "Atlas", tool: "pi" }));
		await run("session-start", input("s1", { source: "startup" }), hookCtx(w, { startHolder: () => {} }));
		expect(claimedBy(w.birch.dir, w.token)).toBe(process.pid);
		recorded.push({ dataDir: w.dataDir, pid: process.pid });
	});

	it("a Codex whose start can't be read decides nothing and claims nothing: no memory (fail closed)", async () => {
		const w = codexWorld();
		// A pid whose process is gone, though the test says it lives: its start can't be read.
		const gone = await new Promise<number>((resolve) => {
			const exited = spawn("sleep", ["0"], { stdio: "ignore" });
			exited.on("exit", () => resolve(exited.pid as number));
		});
		// Its rollout counts as open in it (as a Codex whose start can't be read would hold it): the pick is asked.
		const held = (session: string) => [{ path: w.codex.path(id(session)) }];
		const c = hookCtx(w, { codexPid: gone, codexParent: gone, alive: () => true, openFiles: () => held("s1") });
		expect(await run("session-start", input("s1", { source: "startup" }), c)).toEqual({
			systemMessage: "Orrery: this Codex's start time can't be read, so which agent it is can't be recorded; this session runs without memory.",
		});
		expect(claimedBy(w.birch.dir, w.token)).toBeUndefined();
		expect(existsSync(join(w.dataDir, "codex-processes", `${gone}.json`))).toBe(false);
		await run("user-prompt-submit", input("s1", { prompt: "Not memory.", turn_id: "t-1" }), c);
		expect(spooled(w.birch.dir, "s1")).toEqual([]);
		// As it is gone, it holds no rollout open: nothing confirms the session is its own, so the pick isn't even asked.
		expect(await run("session-start", input("s1", { source: "startup" }), hookCtx(w, { codexPid: gone, codexParent: gone, alive: () => true }))).toEqual({
			systemMessage: "Orrery: can't confirm this is this Codex's own session (Codex doesn't have its rollout open), so it opens no memory and records nothing.",
		});
		expect(existsSync(join(w.dataDir, "codex-processes", `${gone}.json`))).toBe(false);
	});

	it("a nested Codex whose decision can't be recorded stays nested through a compaction and /clear after the outer session ends: no claim, no memory", async () => {
		const w = codexWorld();
		mkdirSync(w.dataDir, { recursive: true });
		writeFileSync(join(w.dataDir, "codex-processes"), "");
		hostRecord(w.dataDir, "Atlas", "claude-code", process.ppid);
		const c = hookCtx(w);
		expect(await run("session-start", input("s1", { source: "startup" }), c)).toEqual({ systemMessage: ATLAS });
		forgetSession(w.dataDir, process.ppid);
		await run("session-start", input("s1", { source: "compact" }), c);
		await run("session-start", input("s2", { source: "clear" }), c);
		await run("user-prompt-submit", input("s2", { prompt: "Not the user's words." }), c);
		expect(claimedBy(w.birch.dir, w.token)).toBeUndefined();
		expect(spooled(w.birch.dir, "s2")).toEqual([]);
		expect(hosts(w.dataDir)).toEqual([]);
	});

	it("a compaction, /clear or fork is never a process's first asker: with no decision and no claim, it claims nothing, and says why", async () => {
		const w = codexWorld();
		const unclaimed = "Orrery: this Codex hasn't started or resumed a session yet, and only those claim Birch's token, so this session runs without memory. Resume it, or open Birch with orrery agent Birch --tool codex.";
		for (const source of ["compact", "clear", "fork"]) {
			expect(await run("session-start", input("s1", { source }), hookCtx(w))).toEqual({ systemMessage: unclaimed });
			expect(claimedBy(w.birch.dir, w.token)).toBeUndefined();
		}
		expect(existsSync(join(w.dataDir, "codex-processes"))).toBe(false);
		// The token claimed by another live process (another Codex of the launch): that is what it says then.
		const other = bystander();
		expect(claimToken(w.birch.dir, w.token, other)).toBe(true);
		expect(await run("session-start", input("s1", { source: "clear" }), hookCtx(w))).toEqual({
			systemMessage: "Orrery: Birch's token belongs to another process, so this Codex is not Birch; it runs without memory.",
		});
		expect(claimedBy(w.birch.dir, w.token)).toBe(other);
	});

	it("an agent whose decision can't be recorded stays the agent (its claim holds), says so once a session, and records its events once", async () => {
		const w = codexWorld();
		// The decisions' folder cannot be made: a file stands where it would go. Claims can be written.
		mkdirSync(w.dataDir, { recursive: true });
		writeFileSync(join(w.dataDir, "codex-processes"), "");
		const c = hookCtx(w, { startHolder: () => {} });
		const NOTE = /Orrery: which agent this Codex is could not be recorded \(.+\), so each SessionStart works it out again\./;
		const first = (await run("session-start", input("s1", { source: "startup" }), c)) as Answer;
		expect(first.systemMessage).toMatch(/^Orrery · Birch · /);
		expect(first.systemMessage).toMatch(NOTE);
		expect(claimedBy(w.birch.dir, w.token)).toBe(process.pid);
		expect(((await run("session-start", input("s1", { source: "compact" }), c)) as Answer).systemMessage ?? "").not.toMatch(NOTE);
		await run("user-prompt-submit", input("s1", { prompt: "The user's words.", turn_id: "t-1" }), c);
		expect(spooled(w.birch.dir, "s1")).toEqual(["rollout", "prompt"]);
		recorded.push({ dataDir: w.dataDir, pid: process.pid });
	});
});

describe("a Codex session's host record (spec 2026-10-18-agent-permissions §2)", () => {
	it("SessionStart records the Codex as the agent's host with its session; a new session (/clear) records that one; SessionEnd forgets nothing while Codex lives", async () => {
		const w = codexWorld();
		const c = hookCtx(w, { startHolder: () => {} });
		recorded.push({ dataDir: w.dataDir, pid: process.pid });
		await run("session-start", input("s1", { source: "startup" }), c);
		expect(liveSession(w.dataDir, process.pid)).toMatchObject({ agent: "Birch", tool: "codex", pid: process.pid, codexSession: id("s1") });
		await run("session-start", input("s2", { source: "clear" }), c);
		expect(liveSession(w.dataDir, process.pid)).toMatchObject({ codexSession: id("s2") });
		// Either session's end: a forged one would look the same, so the record stays until Codex is gone (then it is stale).
		await run("session-end", input("s1", { reason: "clear" }), c);
		await run("session-end", input("s2", { reason: "exit" }), c);
		expect(liveSession(w.dataDir, process.pid)).toMatchObject({ codexSession: id("s2") });
		expect(hosts(w.dataDir)).toEqual([`${process.pid}.json`]);
	});

	it("a refused session (another's token) records none", async () => {
		const w = codexWorld();
		const c = hookCtx(w, { env: { ORRERY_AGENT: "Nobody", ORRERY_AGENT_TOKEN: w.token, CODEX_HOME: w.codex.home } });
		expect(await run("session-start", input("s1", { source: "startup" }), c)).toMatchObject({ systemMessage: expect.stringContaining("Nobody") });
		expect(hosts(w.dataDir)).toEqual([]);
	});
});
