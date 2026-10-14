import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Holder } from "../../src/claude/holder.ts";
import { type HookContext, runHook } from "../../src/claude/hooks.ts";
import { modView } from "../../src/claude/mod-view.ts";
import { claudeSetup, claudeSetupMod, modSetupReport } from "../../src/claude/setup.ts";
import { pendingEvents, readEvent, writeMode } from "../../src/claude/spool.ts";
import { viewFile } from "../../src/claude/paths.ts";
import { laneMode, viewGate, writeSetupMarker } from "../../src/claude/view-file.ts";
import { type HarnessConfig, type LaneConfig, parseConfig } from "../../src/lane/config.ts";
import { laneModelSource } from "../../src/lane/model-source.ts";
import { claimToken, newToken } from "../../src/lane/pick.ts";
import { fauxModels, tempDir } from "../lane/support.ts";
import { cleanupDirs, messages, seed, type TestLane, testLane } from "./support.ts";

const dirs: string[] = [];
const holders: Holder[] = [];
afterEach(async () => {
	for (const holder of holders.splice(0)) await holder.stop("test over");
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	cleanupDirs();
});

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
		expect(out.systemMessage).toBe("Orrery: Test is open outside its folder, where only the Orrery mod brings its memory into Claude Code; run `orrery claude-setup Test --mod`, then start a new session.");
	});

	it("an ORRERY_AGENT that names no lane, or a malformed token: a notice for the person (not in a subagent), and nothing recorded", async () => {
		const t = testLane({ setup: true });
		const started: string[] = [];
		const c = (env: NodeJS.ProcessEnv) => at(t, t.workspace, env, { startHolder: recording(started) });
		const out = JSON.parse(await runHook("session-start", hookInput("s1", t.workspace), c({ ORRERY_AGENT: "Nobody" })));
		expect(out).toEqual({ systemMessage: "Orrery: ORRERY_AGENT names Nobody, which is not a configured agent; this session runs without memory." });
		const bad = JSON.parse(await runHook("session-start", hookInput("s1", t.workspace), c({ ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: "not-a-token" })));
		expect(bad).toEqual({ systemMessage: "Orrery: ORRERY_AGENT_TOKEN is not 32 lowercase hex digits, so this session is not Test; it runs without memory." });
		expect(await runHook("session-start", hookInput("s1", t.workspace, { agent_id: "a1" }), c({ ORRERY_AGENT: "Nobody" }))).toBe("");
		await runHook("user-prompt-submit", hookInput("s1", t.workspace, { prompt: "Not for any lane." }), c({ ORRERY_AGENT: "Nobody" }));
		expect(started).toEqual([]);
		expect(pendingEvents(t.lane.dir, "s1")).toEqual([]);
	});

	it("a refused ORRERY_AGENT keeps the guard: the folder's lane's rules in its folder, the session's folder elsewhere", async () => {
		const t = testLane();
		const dir = elsewhere();
		const write = (where: string, path: string) =>
			runHook("pre-tool-use", hookInput("s1", where, { tool_name: "Write", tool_input: { file_path: path, content: "x" } }), at(t, where, { ORRERY_AGENT: "Nobody" }));
		const read = (where: string) => runHook("pre-tool-use", hookInput("s1", where, { tool_name: "Read", tool_input: { file_path: t.config.credentialsPath } }), at(t, where, { ORRERY_AGENT: "Nobody" }));
		expect(await write(t.workspace, join(t.workspace, "notes.md"))).toBe("");
		expect(await write(t.workspace, join(dir, "notes.md"))).toContain("Orrery guard");
		expect(await read(t.workspace)).toContain("Orrery guard");
		expect(await write(dir, join(dir, "notes.md"))).toBe("");
		expect(await write(dir, join(t.workspace, "notes.md"))).toContain("Orrery guard");
		expect(await read(dir)).toContain("Orrery guard");
		// A PreToolUse input too long to read is refused unread there too.
		expect(await runHook("pre-tool-use", undefined, at(t, dir, { ORRERY_AGENT: "Nobody" }))).toContain("Orrery guard");
		expect(await runHook("pre-tool-use", undefined, at(t, dir, {}))).toBe("");
	});

	it("a Claude Code the agent started (same variables, another Claude Code process): its folder decides", async () => {
		const t = testLane({ setup: true });
		const dir = elsewhere();
		const token = newToken();
		const env = { ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: token };
		const started: string[] = [];
		// The agent's own Claude Code (a live process) claims the token at its first hook...
		const own = JSON.parse(await runHook("session-start", hookInput("s1", dir), at(t, dir, env, { claudePid: process.pid, startHolder: recording(started) })));
		expect(own.hookSpecificOutput.additionalContext).toMatch(/^Orrery · Test · /);
		expect(started).toEqual(["Test"]);
		expect(claimToken(t.lane.dir, token, process.pid)).toBe(true);
		// ...so another Claude Code with the same variables is not the agent (a guard: outside lanes it was never one).
		const out = await runHook("session-start", hookInput("s2", dir), at(t, dir, env, { startHolder: recording(started) }));
		expect(out).toBe("");
		expect(started).toEqual(["Test"]);
		// In the lane's own folder, it is that folder's lane.
		const inFolder = JSON.parse(await runHook("session-start", hookInput("s3", t.workspace), at(t, t.workspace, env, { startHolder: recording(started) })));
		expect(inFolder.hookSpecificOutput.additionalContext).toMatch(/^Orrery · Test · /);
	});

	it("PreToolUse lets the lane write in the folder it was opened in, and refuses outside it", async () => {
		const t = testLane();
		const dir = elsewhere();
		const env = { ORRERY_AGENT: "Test" };
		const write = (path: string) => runHook("pre-tool-use", hookInput("s1", dir, { tool_name: "Write", tool_input: { file_path: path, content: "x" } }), at(t, dir, env));
		expect(await write(join(dir, "notes.md"))).toBe("");
		expect(await write(`${t.dir}-escape.txt`)).toContain("Orrery guard");
		expect(await write(join(t.workspace, "notes.md"))).toBe("");
	});
});

/** Two lanes, Atlas and Birch, each in mod mode in a folder of its own. */
function twoLanes(): { root: string; config: HarnessConfig; atlas: LaneConfig; birch: LaneConfig } {
	const root = tempDir("orrery-two-");
	dirs.push(root);
	const lane = (name: string) => {
		mkdirSync(join(root, `agent-${name}`));
		return `[lanes.${name}]\nworkspace = ${JSON.stringify(join(root, `agent-${name}`))}\nmodel = "faux-agent/faux-1"\ncompactor_model = "faux-compactor/faux-1"\ncompactor_thinking = "off"\n`;
	};
	const config = parseConfig(`data_dir = ${JSON.stringify(join(root, "data"))}\n${lane("Atlas")}${lane("Birch")}`, root);
	const atlas = config.lanes.get("Atlas") as LaneConfig;
	const birch = config.lanes.get("Birch") as LaneConfig;
	for (const l of [atlas, birch]) claudeSetupMod(l);
	return { root, config, atlas, birch };
}

describe("a Claude Code session another agent recorded, resumed by ORRERY_AGENT", () => {
	it("records only the turns said after the resume: Claude Code records through its hooks, never from the transcript", async () => {
		const { root, config, atlas, birch } = twoLanes();
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
		const { root, config, atlas, birch } = twoLanes();
		const folder = birch.workspace as string;
		claudeSetup(birch);
		const started: string[] = [];
		const c = ctx(config, join(root, "home"), folder, { ORRERY_AGENT: "Atlas" }, { startHolder: recording(started) });
		expect(JSON.parse(await runHook("session-start", hookInput("s1", folder), c))).toEqual({
			systemMessage:
				"Orrery: this folder is Birch's, set up to load Birch's memory view into Claude Code, so Atlas does not open here (Birch's memory would be in its session); this session runs without memory. Open Atlas in another folder, or switch Birch to the mod (`orrery claude-setup Birch --mod`).",
		});
		expect(started).toEqual([]);
		expect(await runHook("user-prompt-submit", hookInput("s1", folder, { prompt: "Not for any lane." }), c)).toBe("");
		expect(await runHook("stop", hookInput("s1", folder, { last_assistant_message: "Nor this." }), c)).toBe("");
		expect(await runHook("session-end", hookInput("s1", folder, { reason: "other" }), c)).toBe("");
		expect(spooled(atlas, "s1")).toEqual([]);
		expect(spooled(birch, "s1")).toEqual([]);
		expect(await modView(config, { cwd: folder, agent: "Atlas", env: {}, owner: 1 })).toEqual({ lane: null });
		expect(await modView(config, { cwd: folder, env: { ORRERY_AGENT: "Atlas" }, owner: 1 })).toEqual({ lane: null });
		const tool = (name: string, input: object) => runHook("pre-tool-use", hookInput("s1", folder, { tool_name: name, tool_input: input }), c);
		expect(await tool("Write", { file_path: join(folder, "notes.md"), content: "x" })).toBe("");
		expect(await tool("Write", { file_path: `${root}-escape.txt`, content: "x" })).toContain("Orrery guard");
		expect(await tool("Read", { file_path: config.credentialsPath })).toContain("Orrery guard");
		// With Birch in mod mode there, nothing of Birch's is loaded: Atlas opens.
		claudeSetupMod(birch);
		expect(JSON.parse(await runHook("session-start", hookInput("s2", folder), c)).hookSpecificOutput.additionalContext).toMatch(/^Orrery · Atlas · /);
		expect(started).toEqual(["Atlas"]);
	});
});

describe("a session keeps the lane its SessionStart picked", () => {
	it("a dead agent's claim is taken over only at a session's start: a Claude Code it started keeps its folder's pick until then", async () => {
		const t = testLane();
		claudeSetupMod(t.lane);
		const dir = elsewhere();
		const token = newToken();
		// The agent's Claude Code: alive, and the token's claimant.
		const agent = spawn("sleep", ["60"], { stdio: "ignore" });
		try {
			expect(claimToken(t.lane.dir, token, agent.pid as number)).toBe(true);
			// A Claude Code the agent started (pid 4242), with the same variables: not the agent.
			const started: string[] = [];
			const c = at(t, dir, { ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: token }, { startHolder: recording(started) });
			expect(await runHook("session-start", hookInput("s-child", dir), c)).toBe("");
			// The agent exits; the child's later events keep its start's pick.
			agent.kill();
			await once(agent, "exit");
			expect(await runHook("user-prompt-submit", hookInput("s-child", dir, { prompt: "The child's words." }), c)).toBe("");
			expect(await runHook("stop", hookInput("s-child", dir, { last_assistant_message: "The child's reply." }), c)).toBe("");
			expect(spooled(t.lane, "s-child")).toEqual([]);
			expect(readFileSync(join(t.lane.dir, "claims", token), "utf8")).toBe(`${agent.pid}\n`);
			// Its next SessionStart (a resume, a restart) may take the dead claim over.
			const resumed = JSON.parse(await runHook("session-start", hookInput("s-child", dir, { source: "resume" }), c));
			expect(resumed.hookSpecificOutput.additionalContext).toMatch(/^Orrery · Test · /);
			expect(started).toEqual(["Test"]);
			await runHook("user-prompt-submit", hookInput("s-child", dir, { prompt: "Now as the agent." }), c);
			expect(spooled(t.lane, "s-child")).toEqual(["prompt: Now as the agent."]);
		} finally {
			agent.kill();
		}
	});
});

describe("claude-mod view and setup without the folder", () => {
	it("answers for the lane --agent names, from any folder; without it, the folder decides", async () => {
		const t = testLane();
		seed(t.lane, ["Use pnpm here.", "Switched to pnpm."]);
		claudeSetupMod(t.lane);
		const dir = elsewhere();
		expect(await modView(t.config, { cwd: dir, agent: "Test", env: {}, owner: 1 })).toMatchObject({ lane: "Test", mode: "mod", messages: 2, section: expect.stringMatching(/^# Memory\n\nEarlier conversation reaches you only through the view below\./) });
		expect(await modView(t.config, { cwd: dir, env: {}, owner: 1 })).toEqual({ lane: null });
		// ORRERY_AGENT in the view's own environment does as well.
		expect(await modView(t.config, { cwd: dir, env: { ORRERY_AGENT: "Test" }, owner: 1 })).toMatchObject({ lane: "Test", mode: "mod" });
		expect(await modView(t.config, { cwd: dir, agent: "Nobody", env: {}, owner: 1 })).toEqual({ lane: null });
		// A malformed token, an empty one too, is refused here as in the hooks.
		expect(await modView(t.config, { cwd: dir, agent: "Test", agentToken: "", env: {}, owner: 1 })).toEqual({ lane: null });
	});

	it("the view's Claude Code is its parent, whatever CLAUDE_PID it inherited (a claude started from an agent's Bash has the agent's)", async () => {
		const t = testLane();
		claudeSetupMod(t.lane);
		const dir = elsewhere();
		const [agents, parents] = [newToken(), newToken()];
		// CLAUDE_PID names the claimant (this test), but the view's parent is another process: not the agent.
		expect(claimToken(t.lane.dir, agents, process.pid)).toBe(true);
		expect(await modView(t.config, { cwd: dir, agent: "Test", agentToken: agents, env: { CLAUDE_PID: String(process.pid) } })).toEqual({ lane: null });
		// The parent's own claim: the agent, whatever CLAUDE_PID says.
		expect(claimToken(t.lane.dir, parents, process.ppid)).toBe(true);
		expect(await modView(t.config, { cwd: dir, agent: "Test", agentToken: parents, env: { CLAUDE_PID: String(process.pid) } })).toMatchObject({ lane: "Test" });
	});

	it("--agent without --agent-token: the token in the view's own environment still counts", async () => {
		const t = testLane();
		claudeSetupMod(t.lane);
		const dir = elsewhere();
		const token = newToken();
		expect(claimToken(t.lane.dir, token, process.pid)).toBe(true);
		expect(await modView(t.config, { cwd: dir, agent: "Test", env: { ORRERY_AGENT_TOKEN: token }, owner: 4242 })).toEqual({ lane: null });
		expect(await modView(t.config, { cwd: dir, agent: "Test", env: { ORRERY_AGENT_TOKEN: token }, owner: process.pid })).toMatchObject({ lane: "Test" });
	});

	it("--agent with a token another live process claimed: not the agent, so the folder decides", async () => {
		const t = testLane();
		claudeSetupMod(t.lane);
		const dir = elsewhere();
		const token = newToken();
		expect(claimToken(t.lane.dir, token, process.pid)).toBe(true);
		expect(await modView(t.config, { cwd: dir, agent: "Test", agentToken: token, env: {}, owner: process.pid })).toMatchObject({ lane: "Test" });
		expect(await modView(t.config, { cwd: dir, agent: "Test", agentToken: token, env: {}, owner: 4242 })).toEqual({ lane: null });
		expect(await modView(t.config, { cwd: t.workspace, agent: "Test", agentToken: token, env: {}, owner: 4242 })).toMatchObject({ lane: "Test" });
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
