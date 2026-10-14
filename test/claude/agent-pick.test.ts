import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Holder } from "../../src/claude/holder.ts";
import { type HookContext, runHook } from "../../src/claude/hooks.ts";
import { modView } from "../../src/claude/mod-view.ts";
import { viewFile } from "../../src/claude/paths.ts";
import { claudeSetup, claudeSetupMod, modSetupReport } from "../../src/claude/setup.ts";
import { pendingEvents, readEvent, writeMode } from "../../src/claude/spool.ts";
import { laneMode, viewGate, writeSetupMarker } from "../../src/claude/view-file.ts";
import { type HarnessConfig, type LaneConfig, parseConfig } from "../../src/lane/config.ts";
import { laneModelSource } from "../../src/lane/model-source.ts";
import { claimToken, newToken } from "../../src/lane/pick.ts";
import { fauxModels, tempDir } from "../lane/support.ts";
import { cleanupDirs, messages, seed, type TestLane, testLane } from "./support.ts";

const dirs: string[] = [];
const holders: Holder[] = [];
const sleepers: ChildProcess[] = [];
afterEach(async () => {
	for (const holder of holders.splice(0)) await holder.stop("test over");
	for (const sleeper of sleepers.splice(0)) sleeper.kill();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	cleanupDirs();
});

/**
 * A live process standing for a Claude Code (or an agent's): a process's decision is kept while its pid lives
 * (src/claude/pick.ts prunes the records of dead ones), so tests that have several give each a live pid.
 */
function live(): ChildProcess & { pid: number } {
	const sleeper = spawn("sleep", ["120"], { stdio: "ignore" });
	sleepers.push(sleeper);
	return sleeper as ChildProcess & { pid: number };
}
async function kill(process: ChildProcess): Promise<void> {
	process.kill();
	if (process.exitCode === null && process.signalCode === null) await once(process, "exit");
}

/** A hook's context in `dir` (CLAUDE_PROJECT_DIR), with `env` added and Claude Code's pid 4242. */
const ctx = (config: HarnessConfig, home: string, dir: string, env: NodeJS.ProcessEnv, extra: Partial<HookContext> = {}): HookContext => ({
	config,
	env: { CLAUDE_PROJECT_DIR: dir, ...env },
	claudePid: 4242,
	startHolder: () => {},
	modeWaitMs: 200,
	home,
	...extra,
});
const at = (t: TestLane, dir: string, env: NodeJS.ProcessEnv, extra: Partial<HookContext> = {}) => ctx(t.config, join(t.dir, "home"), dir, env, extra);
/** A startHolder that answers as a recording holder would, and notes which lane it was for. */
const recording = (started: string[]) => (lane: LaneConfig, session: string, nonce: string, since: number) => {
	started.push(lane.name);
	writeMode(lane.dir, session, { mode: "recording", pid: 1, claudePid: 4242, nonce, since });
};
/** A folder of no lane's, in a temp folder of its own (so no lane's allowed roots hold it). */
const elsewhere = () => {
	const dir = tempDir("orrery-elsewhere-");
	dirs.push(dir);
	return dir;
};
const hookInput = (session: string, cwd: string, extra: object = {}) => JSON.stringify({ session_id: session, cwd, ...extra });
/** What is spooled for `session` in `lane`, oldest first: "kind: text", or the kind alone. */
const spooled = (lane: LaneConfig, session: string) =>
	pendingEvents(lane.dir, session).map((pending) => {
		const event = readEvent(pending.path);
		return event !== undefined && "text" in event ? `${event.kind}: ${event.text}` : event?.kind;
	});
const statMode = (path: string) => statSync(path).mode & 0o777;
/** The Claude Code processes with a recorded decision (src/claude/pick.ts), by pid. */
const decided = (config: HarnessConfig) => {
	try {
		return readdirSync(join(config.dataDir, "claude-processes")).sort();
	} catch {
		return [];
	}
};

describe("Claude Code outside the lane's folder, by ORRERY_AGENT", () => {
	it("in mod mode: starts the lane's holder, memory comes from the mod, and the turns go to the lane", async () => {
		const t = testLane();
		seed(t.lane, ["Use pnpm here.", "Switched to pnpm."]);
		claudeSetupMod(t.lane);
		const dir = elsewhere();
		const started: string[] = [];
		const c = at(t, dir, { ORRERY_AGENT: "Test" }, { startHolder: recording(started) });
		const out = JSON.parse(await runHook("session-start", hookInput("s1", dir), c)) as { hookSpecificOutput: { additionalContext: string }; systemMessage?: string };
		expect(started).toEqual(["Test"]);
		expect(out.hookSpecificOutput.additionalContext).toMatch(/^Orrery · Test · 2 msgs · recording · memory from the Orrery mod$/m);
		expect(out.systemMessage).toBeUndefined();
		await runHook("user-prompt-submit", hookInput("s1", dir, { prompt: "A question asked elsewhere." }), c);
		await runHook("stop", hookInput("s1", dir, { last_assistant_message: "An answer given elsewhere." }), c);
		expect(spooled(t.lane, "s1")).toEqual(["prompt: A question asked elsewhere.", "reply: An answer given elsewhere."]);
	});

	it("in file mode: records, and says only the mod brings memory into this folder", async () => {
		const t = testLane({ setup: true });
		seed(t.lane, ["Use pnpm here.", "Switched to pnpm."]);
		const dir = elsewhere();
		const started: string[] = [];
		const out = JSON.parse(await runHook("session-start", hookInput("s1", dir), at(t, dir, { ORRERY_AGENT: "Test" }, { startHolder: recording(started) }))) as { systemMessage?: string };
		expect(started).toEqual(["Test"]);
		expect(out.systemMessage).toBe("Orrery: Test is open outside its folder, where only the Orrery mod brings its memory and instructions into Claude Code; run `orrery claude-setup Test --mod`, then start a new session.");
	});

	it("an ORRERY_AGENT that names no lane, or a malformed token: a notice for the person (not in a subagent), and nothing recorded", async () => {
		const t = testLane({ setup: true });
		const started: string[] = [];
		const c = (claudePid: number, env: NodeJS.ProcessEnv) => at(t, t.workspace, env, { claudePid, startHolder: recording(started) });
		const [one, two] = [live().pid, live().pid];
		const out = JSON.parse(await runHook("session-start", hookInput("s1", t.workspace), c(one, { ORRERY_AGENT: "Nobody" })));
		expect(out).toEqual({ systemMessage: "Orrery: ORRERY_AGENT names Nobody, which is not a configured agent; this session runs without memory." });
		expect(await runHook("session-start", hookInput("s1", t.workspace, { agent_id: "a1" }), c(one, { ORRERY_AGENT: "Nobody" }))).toBe("");
		await runHook("user-prompt-submit", hookInput("s1", t.workspace, { prompt: "Not for any lane." }), c(one, { ORRERY_AGENT: "Nobody" }));
		const bad = JSON.parse(await runHook("session-start", hookInput("s2", t.workspace), c(two, { ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: "not-a-token" })));
		expect(bad).toEqual({ systemMessage: "Orrery: ORRERY_AGENT_TOKEN is not 32 lowercase hex digits, so this session is not Test; it runs without memory." });
		expect(started).toEqual([]);
		expect(pendingEvents(t.lane.dir, "s1")).toEqual([]);
	});

	it("a refused ORRERY_AGENT keeps the guard: the folder's lane's rules in its folder, the session's folder elsewhere", async () => {
		const t = testLane();
		const dir = elsewhere();
		const [inLane, outside] = [live().pid, live().pid];
		const c = (where: string) => at(t, where, { ORRERY_AGENT: "Nobody" }, { claudePid: where === dir ? outside : inLane });
		const write = (where: string, path: string) => runHook("pre-tool-use", hookInput("s1", where, { tool_name: "Write", tool_input: { file_path: path, content: "x" } }), c(where));
		const read = (where: string) => runHook("pre-tool-use", hookInput("s1", where, { tool_name: "Read", tool_input: { file_path: t.config.credentialsPath } }), c(where));
		for (const where of [t.workspace, dir]) await runHook("session-start", hookInput("s1", where), c(where));
		expect(await write(t.workspace, join(t.workspace, "notes.md"))).toBe("");
		expect(await write(t.workspace, join(dir, "notes.md"))).toContain("Orrery guard");
		expect(await read(t.workspace)).toContain("Orrery guard");
		expect(await write(dir, join(dir, "notes.md"))).toBe("");
		expect(await write(dir, join(t.workspace, "notes.md"))).toContain("Orrery guard");
		expect(await read(dir)).toContain("Orrery guard");
		// A PreToolUse input too long to read is refused unread there too.
		expect(await runHook("pre-tool-use", undefined, c(dir))).toContain("Orrery guard");
		expect(await runHook("pre-tool-use", undefined, at(t, dir, {}))).toBe("");
	});

	it("a Claude Code the agent started (same variables, another Claude Code process): its folder decides", async () => {
		const t = testLane({ setup: true });
		const dir = elsewhere();
		const token = newToken();
		const env = { ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: token };
		const started: string[] = [];
		const [agent, child, other] = [live().pid, live().pid, live().pid];
		// The agent's own Claude Code claims the token at its start...
		const own = JSON.parse(await runHook("session-start", hookInput("s1", dir), at(t, dir, env, { claudePid: agent, startHolder: recording(started) })));
		expect(own.hookSpecificOutput.additionalContext).toMatch(/^Orrery · Test · /);
		expect(started).toEqual(["Test"]);
		expect(claimToken(t.lane.dir, token, agent)).toBe(true);
		// ...so another Claude Code with the same variables is not the agent (a guard: outside lanes it was never one).
		const out = await runHook("session-start", hookInput("s2", dir), at(t, dir, env, { claudePid: child, startHolder: recording(started) }));
		expect(out).toBe("");
		expect(started).toEqual(["Test"]);
		// In the lane's own folder, it is that folder's lane.
		const inFolder = JSON.parse(await runHook("session-start", hookInput("s3", t.workspace), at(t, t.workspace, env, { claudePid: other, startHolder: recording(started) })));
		expect(inFolder.hookSpecificOutput.additionalContext).toMatch(/^Orrery · Test · /);
	});

	it("PreToolUse lets the lane write in the folder it was opened in, and refuses outside it", async () => {
		const t = testLane();
		const dir = elsewhere();
		const c = at(t, dir, { ORRERY_AGENT: "Test" });
		await runHook("session-start", hookInput("s1", dir), c);
		const write = (path: string) => runHook("pre-tool-use", hookInput("s1", dir, { tool_name: "Write", tool_input: { file_path: path, content: "x" } }), c);
		expect(await write(join(dir, "notes.md"))).toBe("");
		expect(await write(`${t.dir}-escape.txt`)).toContain("Orrery guard");
		expect(await write(join(t.workspace, "notes.md"))).toBe("");
	});
});

/** Lanes, each in mod mode in a folder of its own: Atlas and Birch, and any `more` (name and folder under the root). */
function lanes(more: Record<string, string> = {}): { root: string; config: HarnessConfig; lane: (name: string) => LaneConfig } {
	const root = tempDir("orrery-lanes-");
	dirs.push(root);
	const folders: Record<string, string> = { Atlas: "agent-Atlas", Birch: "agent-Birch", ...more };
	let toml = `data_dir = ${JSON.stringify(join(root, "data"))}\n`;
	for (const [name, folder] of Object.entries(folders)) {
		mkdirSync(join(root, folder), { recursive: true });
		toml += `[lanes.${name}]\nworkspace = ${JSON.stringify(join(root, folder))}\nmodel = "faux-agent/faux-1"\ncompactor_model = "faux-compactor/faux-1"\ncompactor_thinking = "off"\n`;
	}
	const config = parseConfig(toml, root);
	for (const lane of config.lanes.values()) claudeSetupMod(lane);
	return { root, config, lane: (name) => config.lanes.get(name) as LaneConfig };
}

describe("a Claude Code session another agent recorded, resumed by ORRERY_AGENT", () => {
	it("records only the turns said after the resume: Claude Code records through its hooks, never from the transcript", async () => {
		const { root, config, lane } = lanes();
		const [atlas, birch] = [lane("Atlas"), lane("Birch")];
		const folder = birch.workspace as string;
		const home = join(root, "home");
		// Birch's own session in its folder: spooled into Birch's lane.
		const byFolder = ctx(config, home, folder, {}, { startHolder: recording([]) });
		await runHook("session-start", hookInput("s-b", folder), byFolder);
		await runHook("user-prompt-submit", hookInput("s-b", folder, { prompt: "Birch secret question." }), byFolder);
		await runHook("stop", hookInput("s-b", folder, { last_assistant_message: "Birch secret answer." }), byFolder);
		// `claude --resume s-b` with ORRERY_AGENT=Atlas, in Birch's folder.
		const started: string[] = [];
		const asAtlas = ctx(config, home, folder, { ORRERY_AGENT: "Atlas" }, {
			startHolder: (lane, session, nonce, since) => {
				started.push(lane.name);
				void Holder.start({ lane, session, nonce, since, claudePid: 4242, models: laneModelSource(fauxModels().models), alive: () => true, tickMs: 20 }).then((h) => h && holders.push(h));
			},
			modeWaitMs: 5000,
		});
		await runHook("session-start", hookInput("s-b", folder, { source: "resume" }), asAtlas);
		expect(started).toEqual(["Atlas"]);
		await runHook("user-prompt-submit", hookInput("s-b", folder, { prompt: "Atlas question." }), asAtlas);
		await runHook("stop", hookInput("s-b", folder, { last_assistant_message: "Atlas answer." }), asAtlas);
		await runHook("session-end", hookInput("s-b", folder, { reason: "other" }), asAtlas);
		for (const holder of holders.splice(0)) await holder.stop("test over");
		expect(messages(atlas)).toEqual(["user: Atlas question.", "talk: Atlas answer."]);
		// Birch's spool holds only Birch's own turn; Atlas's never went there.
		expect(spooled(birch, "s-b")).toEqual(["prompt: Birch secret question.", "reply: Birch secret answer."]);
	});
});

describe("Claude Code by ORRERY_AGENT in another lane's folder", () => {
	it("set up the file way there: refused (that lane's view would be in the session), nothing recorded, no view; the guard keeps that folder's rules", async () => {
		const { root, config, lane } = lanes();
		const [atlas, birch] = [lane("Atlas"), lane("Birch")];
		const folder = birch.workspace as string;
		claudeSetup(birch);
		const started: string[] = [];
		const [first, second] = [live().pid, live().pid];
		const c = ctx(config, join(root, "home"), folder, { ORRERY_AGENT: "Atlas" }, { claudePid: first, startHolder: recording(started) });
		expect(JSON.parse(await runHook("session-start", hookInput("s1", folder), c))).toEqual({
			systemMessage:
				"Orrery: this folder is Birch's, set up to load Birch's memory view into Claude Code, so Atlas does not open here (Birch's memory would be in its session); this session runs without memory. Open Atlas in another folder, or switch Birch to the mod (`orrery claude-setup Birch --mod`).",
		});
		expect(started).toEqual([]);
		expect(await runHook("user-prompt-submit", hookInput("s1", folder, { prompt: "Not for any lane." }), c)).toBe("");
		expect(await runHook("stop", hookInput("s1", folder, { last_assistant_message: "Nor this." }), c)).toBe("");
		expect(spooled(atlas, "s1")).toEqual([]);
		expect(spooled(birch, "s1")).toEqual([]);
		expect(await modView(config, { cwd: folder, agent: "Atlas", env: {}, owner: first })).toEqual({ lane: null });
		const tool = (name: string, input: object) => runHook("pre-tool-use", hookInput("s1", folder, { tool_name: name, tool_input: input }), c);
		expect(await tool("Write", { file_path: join(folder, "notes.md"), content: "x" })).toBe("");
		expect(await tool("Write", { file_path: `${root}-escape.txt`, content: "x" })).toContain("Orrery guard");
		expect(await tool("Read", { file_path: config.credentialsPath })).toContain("Orrery guard");
		// With Birch in mod mode there, nothing of Birch's is loaded: a new Claude Code opens Atlas.
		claudeSetupMod(birch);
		const opened = JSON.parse(await runHook("session-start", hookInput("s2", folder), { ...c, claudePid: second }));
		expect(opened.hookSpecificOutput.additionalContext).toMatch(/^Orrery · Atlas · /);
		expect(started).toEqual(["Atlas"]);
	});

	it("in a lane's folder inside another lane's folder set up the file way: refused, since Claude Code loads every ancestor's CLAUDE.md", async () => {
		const { root, config, lane } = lanes({ Outer: "outer", Inner: "outer/inner" });
		claudeSetup(lane("Outer"));
		const inner = lane("Inner").workspace as string;
		expect(laneMode(lane("Inner"))).toBe("mod");
		const started: string[] = [];
		const start = (env: NodeJS.ProcessEnv) => runHook("session-start", hookInput("s1", inner), ctx(config, join(root, "home"), inner, env, { claudePid: live().pid, startHolder: recording(started) }));
		expect(JSON.parse(await start({ ORRERY_AGENT: "Atlas" })).systemMessage).toContain("this folder is Outer's, set up to load Outer's memory view into Claude Code, so Atlas does not open here");
		expect(JSON.parse(await start({ ORRERY_AGENT: "Inner" })).systemMessage).toContain("so Inner does not open here");
		// Outer itself, whose own view that is, opens there.
		expect(JSON.parse(await start({ ORRERY_AGENT: "Outer" })).hookSpecificOutput.additionalContext).toMatch(/^Orrery · Outer · /);
		expect(started).toEqual(["Outer"]);
	});
});

describe("one decision per Claude Code process (src/claude/pick.ts)", () => {
	it("a later SessionStart (compact, clear, resume) of the same process keeps its first pick after the agent died; a new process may take the dead claim over", async () => {
		const t = testLane();
		claudeSetupMod(t.lane);
		const dir = elsewhere();
		const token = newToken();
		const agent = live();
		expect(claimToken(t.lane.dir, token, agent.pid)).toBe(true);
		// A Claude Code the agent started, with the same variables: not the agent.
		const started: string[] = [];
		const env = { ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: token };
		const child = at(t, dir, env, { claudePid: live().pid, startHolder: recording(started) });
		expect(await runHook("session-start", hookInput("s1", dir, { source: "startup" }), child)).toBe("");
		await kill(agent);
		expect(await runHook("session-start", hookInput("s1", dir, { source: "compact" }), child)).toBe("");
		expect(await runHook("session-end", hookInput("s1", dir, { reason: "clear" }), child)).toBe("");
		expect(await runHook("session-start", hookInput("s2", dir, { source: "clear" }), child)).toBe("");
		expect(await runHook("session-end", hookInput("s2", dir, { reason: "resume" }), child)).toBe("");
		expect(await runHook("session-start", hookInput("s1", dir, { source: "resume" }), child)).toBe("");
		expect(await runHook("user-prompt-submit", hookInput("s1", dir, { prompt: "The child's words." }), child)).toBe("");
		expect(spooled(t.lane, "s1")).toEqual([]);
		expect(started).toEqual([]);
		expect(readFileSync(join(t.lane.dir, "claims", token), "utf8")).toBe(`${agent.pid}\n`);
		// `claude --resume` starts a new process: its first decision may take the dead claim over.
		const resumed = at(t, dir, env, { claudePid: live().pid, startHolder: recording(started) });
		expect(JSON.parse(await runHook("session-start", hookInput("s1", dir, { source: "resume" }), resumed)).hookSpecificOutput.additionalContext).toMatch(/^Orrery · Test · /);
		expect(started).toEqual(["Test"]);
	});

	it("a stale record left under a reused pid is never this session's: another agent's gets nothing spooled, a stale none keeps the guard on, and SessionStart replaces it", async () => {
		const { root, config, lane } = lanes();
		const [atlas, birch] = [lane("Atlas"), lane("Birch")];
		const dir = elsewhere();
		const pid = live().pid;
		const record = join(config.dataDir, "claude-processes", `${pid}.json`);
		mkdirSync(dirname(record), { recursive: true, mode: 0o700 });
		const started: string[] = [];
		const c = ctx(config, join(root, "home"), dir, { ORRERY_AGENT: "Atlas" }, { claudePid: pid, startHolder: recording(started) });
		// Birch's decision, from a process that died without SessionEnd and whose pid this Claude Code now has.
		writeFileSync(record, JSON.stringify({ agent: "Birch", token: "", kind: "lane", name: "Birch", by: "env" }));
		await runHook("user-prompt-submit", hookInput("s1", dir, { prompt: "Atlas's words." }), c);
		expect(spooled(birch, "s1")).toEqual([]);
		expect(spooled(atlas, "s1")).toEqual([]);
		// One from before records named their agent: Birch's, read as Birch's under the old format.
		writeFileSync(record, JSON.stringify({ kind: "lane", name: "Birch", by: "env" }));
		await runHook("user-prompt-submit", hookInput("s1", dir, { prompt: "Atlas's words." }), c);
		expect(spooled(birch, "s1")).toEqual([]);
		// A stale "none" would turn the guard off outside lanes.
		writeFileSync(record, JSON.stringify({ kind: "none" }));
		expect(await runHook("pre-tool-use", hookInput("s1", dir, { tool_name: "Read", tool_input: { file_path: config.credentialsPath } }), c)).toContain("Orrery guard");
		// This process's SessionStart replaces the stale record with its own decision.
		expect(JSON.parse(await runHook("session-start", hookInput("s1", dir), c)).hookSpecificOutput.additionalContext).toMatch(/^Orrery · Atlas · /);
		expect(started).toEqual(["Atlas"]);
		expect(JSON.parse(readFileSync(record, "utf8"))).toEqual({ agent: "Atlas", token: "", kind: "lane", name: "Atlas", by: "env" });
	});

	it("a decision that cannot be recorded refuses the session: nothing recorded, and the guard on", async () => {
		const t = testLane();
		claudeSetupMod(t.lane);
		const dir = elsewhere();
		// The records' folder cannot be made: a file stands where it would go.
		mkdirSync(t.config.dataDir, { recursive: true });
		writeFileSync(join(t.config.dataDir, "claude-processes"), "");
		const started: string[] = [];
		const c = at(t, dir, { ORRERY_AGENT: "Test" }, { claudePid: live().pid, startHolder: recording(started) });
		const out = JSON.parse(await runHook("session-start", hookInput("s1", dir), c)) as { systemMessage: string };
		expect(out.systemMessage).toMatch(/^Orrery: ORRERY_AGENT is set, but which agent this Claude Code is could not be recorded \(.+\); this session runs without memory\.$/);
		expect(started).toEqual([]);
		await runHook("user-prompt-submit", hookInput("s1", dir, { prompt: "Not for any lane." }), c);
		expect(spooled(t.lane, "s1")).toEqual([]);
		expect(await runHook("pre-tool-use", hookInput("s1", dir, { tool_name: "Read", tool_input: { file_path: t.config.credentialsPath } }), c)).toContain("Orrery guard");
		expect(await modView(t.config, { cwd: dir, agent: "Test", env: {}, owner: c.claudePid })).toEqual({ lane: null });
	});

	it("a token claim that cannot be recorded: the recorded decision still holds for every later event (the guard stays on)", async () => {
		const t = testLane();
		claudeSetupMod(t.lane);
		const dir = elsewhere();
		// The claims folder cannot be made: a file stands where it would go.
		mkdirSync(t.lane.dir, { recursive: true });
		writeFileSync(join(t.lane.dir, "claims"), "");
		const started: string[] = [];
		const c = at(t, dir, { ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: newToken() }, { claudePid: live().pid, startHolder: recording(started) });
		expect(JSON.parse(await runHook("session-start", hookInput("s1", dir), c)).hookSpecificOutput.additionalContext).toMatch(/^Orrery · Test · /);
		expect(await runHook("pre-tool-use", hookInput("s1", dir, { tool_name: "Read", tool_input: { file_path: t.config.credentialsPath } }), c)).toContain("Orrery guard");
		await runHook("user-prompt-submit", hookInput("s1", dir, { prompt: "Kept by the agent." }), c);
		expect(spooled(t.lane, "s1")).toEqual(["prompt: Kept by the agent."]);
	});

	it("SessionEnd at the process's end removes its decision (not at /clear); a new decision prunes a dead process's", async () => {
		const t = testLane();
		const dir = elsewhere();
		const [first, second] = [live(), live()];
		const c = (claudePid: number) => at(t, dir, { ORRERY_AGENT: "Test" }, { claudePid });
		await runHook("session-start", hookInput("s1", dir), c(first.pid));
		expect(decided(t.config)).toEqual([`${first.pid}.json`]);
		await runHook("session-end", hookInput("s1", dir, { reason: "clear" }), c(first.pid));
		expect(decided(t.config)).toEqual([`${first.pid}.json`]);
		await runHook("session-end", hookInput("s1", dir, { reason: "prompt_input_exit" }), c(first.pid));
		expect(decided(t.config)).toEqual([]);
		// A process that died without SessionEnd: its record goes at the next decision.
		await runHook("session-start", hookInput("s2", dir), c(first.pid));
		await kill(first);
		await runHook("session-start", hookInput("s3", dir), c(second.pid));
		expect(decided(t.config)).toEqual([`${second.pid}.json`]);
		// Files 0600 in a 0700 folder.
		expect(statMode(join(t.config.dataDir, "claude-processes"))).toBe(0o700);
		expect(statMode(join(t.config.dataDir, "claude-processes", `${second.pid}.json`))).toBe(0o600);
	});
});

describe("claude-mod view and setup without the folder", () => {
	it("answers for the lane the process decided on, from any folder; without ORRERY_AGENT, the folder decides", async () => {
		const t = testLane();
		seed(t.lane, ["Use pnpm here.", "Switched to pnpm."]);
		claudeSetupMod(t.lane);
		const dir = elsewhere();
		const [agent, nobody] = [live().pid, live().pid];
		// The process's SessionStart (or the MCP server) decided first.
		await runHook("session-start", hookInput("s1", dir), at(t, dir, { ORRERY_AGENT: "Test" }, { claudePid: agent, startHolder: recording([]) }));
		await runHook("session-start", hookInput("s2", dir), at(t, dir, { ORRERY_AGENT: "Nobody" }, { claudePid: nobody }));
		expect(await modView(t.config, { cwd: dir, agent: "Test", env: {}, owner: agent })).toMatchObject({ lane: "Test", mode: "mod", messages: 2, section: expect.stringMatching(/^# Memory\n\nEarlier conversation reaches you only through the view below\./) });
		expect(await modView(t.config, { cwd: dir, env: { ORRERY_AGENT: "Test" }, owner: agent })).toMatchObject({ lane: "Test", mode: "mod" });
		expect(await modView(t.config, { cwd: dir, agent: "Test", env: {}, owner: nobody })).toEqual({ lane: null });
		expect(await modView(t.config, { cwd: dir, env: {}, owner: agent })).toEqual({ lane: null });
		expect(await modView(t.config, { cwd: t.workspace, env: {}, owner: nobody })).toMatchObject({ lane: "Test" });
		// The view never decides: a process with no decision gets no lane.
		expect(await modView(t.config, { cwd: dir, agent: "Test", env: {}, owner: live().pid })).toEqual({ lane: null });
	});

	it("the view's Claude Code is its parent, whatever CLAUDE_PID it inherited (a claude started from an agent's Bash has the agent's)", async () => {
		const t = testLane();
		claudeSetupMod(t.lane);
		const dir = elsewhere();
		const decide = (claudePid: number) => runHook("session-start", hookInput("s1", dir), at(t, dir, { ORRERY_AGENT: "Test" }, { claudePid, startHolder: recording([]) }));
		// CLAUDE_PID's process decided on the agent; the view's parent (here this test's parent) decided nothing.
		await decide(process.pid);
		expect(await modView(t.config, { cwd: dir, agent: "Test", env: { CLAUDE_PID: String(process.pid) } })).toEqual({ lane: null });
		// The parent's own decision counts, whatever CLAUDE_PID says.
		await decide(process.ppid);
		expect(await modView(t.config, { cwd: dir, agent: "Test", env: { CLAUDE_PID: String(process.pid) } })).toMatchObject({ lane: "Test" });
	});

	it("switches a lane with no workspace to the mod; the file setup refuses it", () => {
		const dir = tempDir("orrery-nomad-");
		dirs.push(dir);
		const config = parseConfig(`data_dir = ${JSON.stringify(join(dir, "data"))}\n[lanes.Nomad]\ncompactor_model = "faux-compactor/faux-1"\n`, dir);
		const nomad = config.lanes.get("Nomad") as LaneConfig;
		const result = claudeSetupMod(nomad);
		expect(result).toMatchObject({ lane: "Nomad", removedFrom: [], viewDeleted: false });
		expect(modSetupReport(result).split("\n").at(-2)).toBe("Open it with `orrery agent Nomad` in any folder (Claude Code 2.1.287 or newer, Orrery plugin 0.3.0).");
		const t = testLane();
		expect(modSetupReport(claudeSetupMod(t.lane)).split("\n").at(-2)).toBe(
			"Open it with `orrery agent Test` in any folder, or start Claude Code in its folder (Claude Code 2.1.287 or newer, Orrery plugin 0.3.0). `orrery claude-setup Test` switches back.",
		);
		expect(laneMode(nomad)).toBe("mod");
		expect(JSON.parse(readFileSync(join(nomad.dir, "claude", "setup.json"), "utf8"))).toMatchObject({ workspace: "", file: "mod" });
		expect(() => claudeSetup(nomad)).toThrow("Nomad has no workspace; Claude Code's file setup needs one. Use orrery claude-setup Nomad --mod.");
	});

	it("an empty marker workspace (a lane switched to the mod with no folder) names no folder: a view in the workspace it gains stays", () => {
		const t = testLane();
		writeSetupMarker(t.lane.dir, "", "mod");
		expect(laneMode(t.lane)).toBe("mod");
		mkdirSync(dirname(viewFile(t.workspace)), { mode: 0o700 });
		writeFileSync(viewFile(t.workspace), "a view Orrery did not write for this lane");
		// "" resolves to the process's folder: in the workspace it must still name no folder.
		const cwd = process.cwd();
		process.chdir(t.workspace);
		try {
			expect(viewGate(t.lane)).toEqual({ open: false, mod: true });
		} finally {
			process.chdir(cwd);
		}
		expect(existsSync(viewFile(t.workspace))).toBe(true);
	});
});
