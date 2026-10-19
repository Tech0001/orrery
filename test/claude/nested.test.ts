import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type HarnessConfig, parseConfig } from "../../src/agent/config.ts";
import { claimedBy, newToken } from "../../src/agent/pick.ts";
import { forgetSession, liveSession, nestedNotice, processStart, recordSession, type SessionTool } from "../../src/agent/sessions.ts";
import { type HookContext, runHook } from "../../src/claude/hooks.ts";
import { modView } from "../../src/claude/mod-view.ts";
import { claudeHookPid, claudeRefusedNotice, claudeSession, forgetProcess, UNCONFIRMED_NOTICE } from "../../src/claude/pick.ts";
import { pendingEvents, readMode } from "../../src/claude/spool.ts";
import { claudeSetupMod } from "../../src/claude/setup.ts";
import { seed } from "./support.ts";
import { cleanup, world } from "../pi/world.ts";

const recorded: { dataDir: string; pid: number }[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
	for (const { dataDir, pid } of recorded.splice(0)) forgetSession(dataDir, pid);
	for (const child of children.splice(0)) child.kill("SIGKILL");
	await cleanup();
});

/**
 * The pi world (Atlas and Birch), each agent with allowed roots of its own and one in common: Atlas `shared` and `common`,
 * Birch `plain` and `common/inner` (inside Atlas's `common`), and a memory view in each agent's folder.
 */
function nestedWorld() {
	const { root, configPath } = world();
	for (const dir of ["shared", join("common", "inner"), "elsewhere"]) mkdirSync(join(root, dir), { recursive: true });
	const roots = (...dirs: string[]) => `allowed_roots = ${JSON.stringify(dirs.map((dir) => join(root, dir)))}\n`;
	const toml = readFileSync(configPath, "utf8")
		.replace("[agents.Atlas]\n", `[agents.Atlas]\n${roots("shared", "common")}`)
		.replace("[agents.Birch]\n", `[agents.Birch]\n${roots("plain", join("common", "inner"))}`);
	writeFileSync(configPath, toml);
	const config = parseConfig(toml, root);
	for (const name of ["Atlas", "Birch"]) {
		mkdirSync(join(root, `agent-${name}`, ".orrery"));
		writeFileSync(join(root, `agent-${name}`, ".orrery", "view.md"), `${name}'s view: secret`);
	}
	return { root, config, configPath, dataDir: config.dataDir };
}

/** Records `pid` as hosting `agent`'s session in `tool`, as that tool's integration would; forgotten after the test. */
function hostRecord(dataDir: string, agent: string, tool: SessionTool, pid: number): void {
	expect(recordSession(dataDir, { agent, tool, pid })).toBe(true);
	recorded.push({ dataDir, pid });
}

/** A live process that is no ancestor of this one. */
function bystander(): number {
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
	children.push(child);
	return child.pid as number;
}

/** The session records in the data folder: one file per host process. */
const hosts = (dataDir: string): string[] => (existsSync(join(dataDir, "session-hosts")) ? readdirSync(join(dataDir, "session-hosts")) : []);
/** The Claude Code processes with a recorded decision (src/claude/pick.ts). */
const decided = (dataDir: string): string[] => (existsSync(join(dataDir, "claude-processes")) ? readdirSync(join(dataDir, "claude-processes")) : []);

const ATLAS_PI = "Orrery: started inside Atlas's session (pi), so this one opens no memory and records nothing.";

/** A hook's context: this test's process is the Claude Code (CLAUDE_PID), in `dir`. */
const hookCtx = (config: HarnessConfig, root: string, dir: string, extra: Partial<HookContext> = {}): HookContext => ({
	config,
	env: { CLAUDE_PROJECT_DIR: dir },
	claudePid: process.pid,
	startHolder: () => {
		throw new Error("no holder may start");
	},
	modeWaitMs: 200,
	home: join(root, "home"),
	...extra,
});
const hookInput = (session: string, cwd: string, extra: object = {}) => JSON.stringify({ session_id: session, cwd, ...extra });

describe("a Claude Code started inside an agent's session (spec 2026-10-18-agent-permissions §3b)", () => {
	it("is nested by its folder (no ORRERY_AGENT): decided once for the process, read by every consumer, nothing recorded for it", () => {
		const { root, config, dataDir } = nestedWorld();
		hostRecord(dataDir, "Atlas", "pi", process.ppid);
		const asking = { env: {}, cwd: join(root, "agent-Birch"), pid: process.pid };
		expect(claudeSession(config, { ...asking, decide: true })).toEqual({ kind: "nested", outer: "Atlas", tool: "pi" });
		// Decided: the hooks, the view and "." read it, and the outer session's end changes nothing for this process.
		forgetSession(dataDir, process.ppid);
		expect(claudeSession(config, { ...asking, decide: false })).toEqual({ kind: "nested", outer: "Atlas", tool: "pi" });
		expect(claudeSession(config, { ...asking, decide: true })).toEqual({ kind: "nested", outer: "Atlas", tool: "pi" });
		expect(decided(dataDir)).toEqual([`${process.pid}.json`]);
		expect(hosts(dataDir)).toEqual([]);
		expect(existsSync(join(dataDir, "agents"))).toBe(false);
		expect(claudeRefusedNotice({ kind: "nested", outer: "Atlas", tool: "pi" })).toBe(ATLAS_PI);
		forgetProcess(config, process.pid);
		expect(decided(dataDir)).toEqual([]);
	});

	it("is nested by ORRERY_AGENT too, before its token is claimed: the token stays unclaimed", () => {
		const { root, config, dataDir } = nestedWorld();
		hostRecord(dataDir, "Atlas", "claude-code", process.ppid);
		const token = newToken();
		const env = { ORRERY_AGENT: "Birch", ORRERY_AGENT_TOKEN: token };
		expect(claudeSession(config, { env, cwd: join(root, "plain"), pid: process.pid, decide: true })).toEqual({ kind: "nested", outer: "Atlas", tool: "claude-code" });
		expect(claudeSession(config, { env, cwd: join(root, "plain"), pid: process.pid, decide: false })).toEqual({ kind: "nested", outer: "Atlas", tool: "claude-code" });
		expect(claimedBy(join(dataDir, "agents", "Birch"), token)).toBeUndefined();
		expect(hosts(dataDir)).toEqual([`${process.ppid}.json`]);
		forgetProcess(config, process.pid);
	});

	it("a consumer that may not decide, with nothing decided for its process, judges it all the same and records nothing", () => {
		const { root, config, dataDir } = nestedWorld();
		hostRecord(dataDir, "Atlas", "pi", process.ppid);
		expect(claudeSession(config, { env: {}, cwd: join(root, "agent-Atlas"), pid: process.pid, decide: false })).toEqual({ kind: "nested", outer: "Atlas", tool: "pi" });
		expect(decided(dataDir)).toEqual([]);
	});

	it("a decider whose pid another tool's live session holds is no Claude Code of its own (fail closed)", () => {
		const { root, config, dataDir } = nestedWorld();
		const pi = bystander();
		hostRecord(dataDir, "Atlas", "pi", pi);
		expect(claudeSession(config, { env: {}, cwd: join(root, "agent-Birch"), pid: pi, decide: true })).toEqual({ kind: "nested", outer: "Atlas", tool: "pi" });
		// pi's record stays pi's.
		expect(liveSession(dataDir, pi)).toMatchObject({ agent: "Atlas", tool: "pi" });
	});

	it("fails closed when the session lookup throws: nested, whose session unknown", () => {
		const { root, config } = nestedWorld();
		// Only the session lookup reads these (the pick reads ORRERY_AGENT and its token); reading one throws.
		const markers = new Set(["ORRERY_HOST", "CLAUDE_PID", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "OPENCODE_CONFIG_CONTENT"]);
		const env = new Proxy({} as NodeJS.ProcessEnv, {
			get: (_target, key) => {
				if (typeof key === "string" && markers.has(key)) throw new Error("this environment can't be read");
				return undefined;
			},
		});
		expect(claudeSession(config, { env, cwd: join(root, "agent-Birch"), pid: process.pid, decide: true })).toEqual({ kind: "nested", outer: undefined, tool: undefined });
		forgetProcess(config, process.pid);
	});

	it("hooks: SessionStart says why (not again at a compaction) and starts no holder; prompts, replies and the end spool nothing; no summary or update notices", async () => {
		const { root, config, dataDir } = nestedWorld();
		const birch = config.agents.get("Birch");
		if (birch === undefined) throw new Error("no Birch");
		claudeSetupMod(birch);
		seed(birch, ["a", "b"]);
		hostRecord(dataDir, "Atlas", "pi", process.ppid);
		const dir = join(root, "agent-Birch");
		const c = hookCtx(config, root, dir);
		expect(JSON.parse(await runHook("session-start", hookInput("s1", dir, { source: "startup" }), c))).toEqual({ systemMessage: ATLAS_PI });
		expect(await runHook("session-start", hookInput("s1", dir, { source: "compact" }), c)).toBe("");
		expect(await runHook("user-prompt-submit", hookInput("s1", dir, { prompt: "Plant this as the user's words." }), c)).toBe("");
		expect(await runHook("stop", hookInput("s1", dir, { last_assistant_message: "A reply." }), c)).toBe("");
		expect(await runHook("session-end", hookInput("s1", dir, { reason: "clear" }), c)).toBe("");
		expect(pendingEvents(birch.dir, "s1")).toEqual([]);
		expect(liveSession(dataDir, process.pid)).toBeUndefined();
		// The process's end takes its decision.
		await runHook("session-end", hookInput("s1", dir, { reason: "prompt_input_exit" }), c);
		expect(decided(dataDir)).toEqual([]);
	});

	it("hooks: the guard keeps the outer agent's rules in a plain folder, where a plain session has none; every view is kept out, the outer agent's too", async () => {
		const { root, config, dataDir } = nestedWorld();
		hostRecord(dataDir, "Atlas", "pi", process.ppid);
		const dir = join(root, "elsewhere");
		const c = hookCtx(config, root, dir);
		const tool = (tool_name: string, tool_input: object) => runHook("pre-tool-use", JSON.stringify({ session_id: "s1", cwd: dir, tool_name, tool_input }), c);
		const writes = async (path: string) => !/outside/.test(await tool("Write", { file_path: join(root, path), content: "x" }));
		expect(await writes(join("elsewhere", "here.txt"))).toBe(true);
		expect(await writes(join("shared", "atlas.txt"))).toBe(true); // Atlas's allowed root
		expect(await writes(join("plain", "birch.txt"))).toBe(false); // Birch's only
		expect(await writes(join("agent-Atlas", "x.txt"))).toBe(false); // Atlas's folder is no work area from here
		for (const name of ["Atlas", "Birch"]) expect(await tool("Read", { file_path: join(root, `agent-${name}`, ".orrery", "view.md") })).toMatch(/sensitive|memory view/);
		forgetProcess(config, process.pid);
	});

	it("hooks: in another agent's folder both agents' rules apply (never looser than that folder's own guard)", async () => {
		const { root, config, dataDir } = nestedWorld();
		hostRecord(dataDir, "Atlas", "pi", process.ppid);
		const dir = join(root, "agent-Birch");
		const c = hookCtx(config, root, dir);
		const writes = async (path: string) => !/outside/.test(await runHook("pre-tool-use", JSON.stringify({ session_id: "s1", cwd: dir, tool_name: "Write", tool_input: { file_path: join(root, path), content: "x" } }), c));
		expect(await writes(join("agent-Birch", "here.txt"))).toBe(true);
		expect(await writes(join("common", "inner", "both.txt"))).toBe(true); // Birch's root, inside Atlas's
		expect(await writes(join("shared", "atlas.txt"))).toBe(false); // Atlas's only
		expect(await writes(join("common", "atlas.txt"))).toBe(false); // Atlas's, outside Birch's
		expect(await writes(join("plain", "birch.txt"))).toBe(false); // Birch's only
		forgetProcess(config, process.pid);
	});

	it("the mod's view gives the notice, not memory", async () => {
		const { root, config, dataDir } = nestedWorld();
		const birch = config.agents.get("Birch");
		if (birch === undefined) throw new Error("no Birch");
		claudeSetupMod(birch);
		seed(birch, ["a", "b"]);
		hostRecord(dataDir, "Atlas", "pi", process.ppid);
		const dir = join(root, "agent-Birch");
		// Before any decision, and after one.
		expect(await modView(config, { cwd: dir, env: {}, owner: process.pid })).toEqual({ lane: null, notice: ATLAS_PI });
		claudeSession(config, { env: {}, cwd: dir, pid: process.pid, decide: true });
		expect(await modView(config, { cwd: dir, env: {}, owner: process.pid, session: "s1" })).toEqual({ lane: null, notice: ATLAS_PI });
		forgetProcess(config, process.pid);
	});
});

describe("a Claude Code session's host record (spec 2026-10-18-agent-permissions §2)", () => {
	it("by its folder: the deciding consumer records the Claude Code as the agent's host; SessionEnd at the process's end forgets it", async () => {
		const { root, config, dataDir } = nestedWorld();
		const dir = join(root, "agent-Atlas");
		expect(claudeSession(config, { env: {}, cwd: dir, pid: process.pid, decide: true })).toMatchObject({ kind: "agent", by: "folder", agent: { name: "Atlas" } });
		expect(liveSession(dataDir, process.pid)).toMatchObject({ agent: "Atlas", tool: "claude-code", pid: process.pid });
		// The folder still decides at each event; a reader records nothing.
		expect(claudeSession(config, { env: {}, cwd: join(root, "agent-Birch"), pid: process.pid, decide: false })).toMatchObject({ kind: "agent", agent: { name: "Birch" } });
		const c = hookCtx(config, root, dir, { startHolder: () => {} });
		await runHook("session-end", hookInput("s1", dir, { reason: "clear" }), c);
		expect(liveSession(dataDir, process.pid)).toBeDefined();
		await runHook("session-end", hookInput("s1", dir, { reason: "prompt_input_exit" }), c);
		expect(liveSession(dataDir, process.pid)).toBeUndefined();
		expect(hosts(dataDir)).toEqual([]);
		expect(decided(dataDir)).toEqual([]);
	});

	it("by ORRERY_AGENT: recorded as that agent's, in any folder; a SessionStart records it too", async () => {
		const { root, config, dataDir } = nestedWorld();
		const dir = join(root, "elsewhere");
		const c = hookCtx(config, root, dir, { env: { CLAUDE_PROJECT_DIR: dir, ORRERY_AGENT: "Birch" }, startHolder: () => {} });
		await runHook("session-start", hookInput("s1", dir, { source: "startup" }), c);
		expect(liveSession(dataDir, process.pid)).toMatchObject({ agent: "Birch", tool: "claude-code" });
		forgetProcess(config, process.pid);
		expect(liveSession(dataDir, process.pid)).toBeUndefined();
		expect(hosts(dataDir)).toEqual([]);
	});

	it("a plain folder records no host, and forgets one a former pick left", () => {
		const { root, config, dataDir } = nestedWorld();
		expect(claudeSession(config, { env: {}, cwd: join(root, "agent-Atlas"), pid: process.pid, decide: true })).toMatchObject({ kind: "agent" });
		expect(claudeSession(config, { env: {}, cwd: join(root, "elsewhere"), pid: process.pid, decide: true })).toEqual({ kind: "none" });
		expect(hosts(dataDir)).toEqual([]);
		forgetProcess(config, process.pid);
	});

	it("forgetProcess forgets only a Claude Code's host record: another tool's session at that pid stays", () => {
		const { config, dataDir } = nestedWorld();
		const pi = bystander();
		hostRecord(dataDir, "Atlas", "pi", pi);
		forgetProcess(config, pi);
		expect(liveSession(dataDir, pi)).toMatchObject({ agent: "Atlas", tool: "pi" });
	});

	it("a Claude Code whose start can't be read at SessionStart: the honest notice, and nothing of the session is recorded, even once the start can be read", async () => {
		const { root, config } = nestedWorld();
		for (const [dir, env, agent] of [
			[join(root, "agent-Atlas"), {}, "Atlas"],
			[join(root, "elsewhere"), { ORRERY_AGENT: "Birch" }, "Birch"],
		] as const) {
			const memory = config.agents.get(agent);
			if (memory === undefined) throw new Error(`no ${agent}`);
			claudeSetupMod(memory);
			const at = (extra: Partial<HookContext> = {}) => hookCtx(config, root, dir, { env: { CLAUDE_PROJECT_DIR: dir, ...env }, ...extra });
			// Both reads fail at SessionStart.
			expect(JSON.parse(await runHook("session-start", hookInput("s1", dir, { source: "startup" }), at({ processStart: () => undefined })))).toEqual({ systemMessage: UNCONFIRMED_NOTICE });
			// From here on the start can be read: the session stays unrecorded, and no holder starts for it (startHolder throws).
			await runHook("user-prompt-submit", hookInput("s1", dir, { prompt: "Not recorded." }), at());
			expect(await runHook("session-start", hookInput("s1", dir, { source: "compact" }), at())).toBe("");
			expect(JSON.parse(await runHook("session-start", hookInput("s1", dir, { source: "resume" }), at()))).toEqual({ systemMessage: UNCONFIRMED_NOTICE });
			await runHook("user-prompt-submit", hookInput("s1", dir, { prompt: "Still not recorded." }), at());
			await runHook("stop", hookInput("s1", dir, { last_assistant_message: "A reply." }), at());
			expect(pendingEvents(memory.dir, "s1")).toEqual([]);
			expect(readMode(memory.dir, "s1")).toMatchObject({ mode: "read-only", claudePid: process.pid, reason: UNCONFIRMED_NOTICE });
			// Another session of the process (/clear) is decided as ever.
			expect(JSON.parse(await runHook("session-start", hookInput("s2", dir, { source: "clear" }), at({ startHolder: () => {} }))).hookSpecificOutput.additionalContext).toMatch(new RegExp(`^Orrery · ${agent} · `));
			forgetProcess(config, process.pid);
		}
	});

	it("a SessionStart whose first read of the start fails and second succeeds decides as ever", async () => {
		const { root, config } = nestedWorld();
		const dir = join(root, "agent-Atlas");
		let reads = 0;
		const flaky = (pid: number) => (reads++ === 0 ? undefined : processStart(pid));
		const out = JSON.parse(await runHook("session-start", hookInput("s1", dir, { source: "startup" }), hookCtx(config, root, dir, { processStart: flaky, startHolder: () => {} })));
		expect(out.hookSpecificOutput.additionalContext).toMatch(/^Orrery · Atlas · /);
		forgetProcess(config, process.pid);
	});

	it("a folder decision that can't be written: SessionStart says so (not again at a compaction); every hook then judges for itself", async () => {
		const { root, config, dataDir } = nestedWorld();
		// The decisions' folder cannot be made: a file stands where it would go.
		mkdirSync(dataDir, { recursive: true });
		writeFileSync(join(dataDir, "claude-processes"), "");
		const dir = join(root, "agent-Atlas");
		const c = hookCtx(config, root, dir, { startHolder: () => {} });
		const first = JSON.parse(await runHook("session-start", hookInput("s1", dir, { source: "startup" }), c)) as { systemMessage: string };
		expect(first.systemMessage).toMatch(/Orrery: which agent this Claude Code is could not be recorded \(.+\), so each of its hooks works it out again\./);
		const again = JSON.parse(await runHook("session-start", hookInput("s1", dir, { source: "compact" }), c)) as { systemMessage?: string };
		expect(again.systemMessage ?? "").not.toContain("could not be recorded");
		// The guard judges by the folder's agent all the same.
		const write = (path: string) => runHook("pre-tool-use", JSON.stringify({ session_id: "s1", cwd: dir, tool_name: "Write", tool_input: { file_path: join(root, path), content: "x" } }), c);
		expect(await write(join("agent-Atlas", "here.txt"))).toBe("");
		expect(await write(join("plain", "birch.txt"))).toMatch(/outside/);
		forgetSession(dataDir, process.pid);
	});
});

describe("claudeHookPid: Claude Code's process for a hook", () => {
	const config = () => nestedWorld().config;

	it("is CLAUDE_PID when it is the hook's parent (Claude Code sets it to its own pid for its hooks), or the parent with none", () => {
		const c = config();
		expect(claudeHookPid(c, { CLAUDE_PID: "500" }, 500, () => 1)).toBe(500);
		expect(claudeHookPid(c, {}, 500, () => 1)).toBe(500);
		expect(claudeHookPid(c, { CLAUDE_PID: "" }, 500, () => 1)).toBe(500);
	});

	it("passes over one shell that did not exec, unless that process is a session's host or a Claude Code's decided process", () => {
		const { config: c, dataDir } = nestedWorld();
		const parentOf = (pid: number) => (pid === 600 ? 500 : 1);
		expect(claudeHookPid(c, { CLAUDE_PID: "500" }, 600, parentOf)).toBe(500);
		// A process with a decision of its own is a Claude Code: CLAUDE_PID above it is another's, inherited.
		mkdirSync(join(dataDir, "claude-processes"), { recursive: true });
		writeFileSync(join(dataDir, "claude-processes", "600.json"), "{}");
		expect(claudeHookPid(c, { CLAUDE_PID: "500" }, 600, parentOf)).toBeUndefined();
	});

	it("is none when CLAUDE_PID names another process (set, or inherited by a hook some other process runs): fail closed", () => {
		const c = config();
		expect(claudeHookPid(c, { CLAUDE_PID: "500" }, 700, () => 650)).toBeUndefined();
		expect(claudeHookPid(c, { CLAUDE_PID: "x" }, 700, () => 1)).toBeUndefined();
	});

	it("a hook whose host is unverified opens no memory and keeps the guard: nested, whose session unknown", async () => {
		const { root, config: c } = nestedWorld();
		const dir = join(root, "agent-Atlas");
		const ctx = hookCtx(c, root, dir, { hostUnverified: true });
		expect(JSON.parse(await runHook("session-start", hookInput("s1", dir, { source: "startup" }), ctx))).toEqual({ systemMessage: nestedNotice({ agent: undefined, tool: undefined, via: "marker", dataDir: "" }) });
		expect(await runHook("pre-tool-use", JSON.stringify({ session_id: "s1", cwd: dir, tool_name: "Read", tool_input: { file_path: join(root, "agent-Atlas", ".orrery", "view.md") } }), ctx)).toMatch(/sensitive|memory view/);
	});
});
