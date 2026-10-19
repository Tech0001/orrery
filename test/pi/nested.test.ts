import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../../src/agent/config.ts";
import { agentModelSource } from "../../src/agent/model-source.ts";
import { forgetSession, liveSession, recordSession, type SessionTool } from "../../src/agent/sessions.ts";
import { Holder } from "../../src/claude/holder.ts";
import { fauxModels } from "../agent/support.ts";
import type { PiRun } from "./harness.ts";
import { cleanup, close, isolatedHome, pi, world } from "./world.ts";

const recorded: { dataDir: string; pid: number }[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
	for (const { dataDir, pid } of recorded.splice(0)) forgetSession(dataDir, pid);
	for (const child of children.splice(0)) child.kill("SIGKILL");
	await cleanup();
});
// These sessions run pi's real tools: a call the guard lets through runs, under a scratch HOME.
isolatedHome();

/**
 * The pi world (Atlas and Birch), with Atlas allowed one more folder, `shared`, and no other: a write under Atlas's rules
 * differs from one under Birch's (whose allowed root is the world's folder). Each agent has a memory view in its folder.
 */
function nestedWorld() {
	const { root, configPath } = world();
	mkdirSync(join(root, "shared"));
	const toml = readFileSync(configPath, "utf8").replace("[agents.Atlas]\n", `[agents.Atlas]\nallowed_roots = [${JSON.stringify(join(root, "shared"))}]\n`);
	const config = parseConfig(toml, root);
	for (const name of ["Atlas", "Birch"]) {
		mkdirSync(join(root, `agent-${name}`, ".orrery"));
		writeFileSync(join(root, `agent-${name}`, ".orrery", "view.md"), `${name}'s view: secret`);
	}
	return { root, config, dataDir: config.dataDir };
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

/** One tool call in `run`, as the model makes it: its result's text. */
async function call(run: PiRun, name: string, args: Parameters<typeof fauxToolCall>[1]): Promise<string> {
	run.setResponses([fauxAssistantMessage([fauxToolCall(name, args)]), fauxAssistantMessage("done")]);
	await run.session.prompt(`${name}, please`);
	const results = run.session.messages.filter((m: { role: string }) => m.role === "toolResult") as { content: { text?: string }[] }[];
	return results.at(-1)?.content.map((c) => c.text ?? "").join("") ?? "";
}

/** The session records in the data folder: one file per host process. */
const hosts = (dataDir: string): string[] => (existsSync(join(dataDir, "session-hosts")) ? readdirSync(join(dataDir, "session-hosts")) : []);

describe("a pi started inside an agent's session (spec 2026-10-18-agent-permissions §3b)", () => {
	it("under a recorded ancestor: opens no memory, registers no tools, records nothing, says why once, and keeps the guard on with the outer agent's rules", async () => {
		const { root, config, dataDir } = nestedWorld();
		hostRecord(dataDir, "Atlas", "claude-code", process.ppid);
		// In Birch's folder, where Birch (who reads every agent) would open with the memory and reader tools.
		const run = await pi(root, join(root, "agent-Birch"), config);
		expect(run.notices).toEqual([{ type: "warning", message: "Orrery: started inside Atlas's session (Claude Code), so this one opens no memory and records nothing." }]);
		for (const tool of ["zoom", "date", "search", "agents", "agent_memory"]) expect(run.tool(tool)).toBeUndefined();
		expect(run.status("orrery")).toBeUndefined();

		// Atlas's rules: Birch's folder (the session's), and Atlas's one allowed root; not the world's folder, Birch's root.
		expect(await call(run, "write", { path: join(root, "agent-Birch", "here.txt"), content: "x" })).not.toMatch(/outside/);
		expect(readFileSync(join(root, "agent-Birch", "here.txt"), "utf8")).toBe("x");
		expect(await call(run, "write", { path: join(root, "shared", "atlas.txt"), content: "x" })).not.toMatch(/outside/);
		expect(existsSync(join(root, "shared", "atlas.txt"))).toBe(true);
		expect(await call(run, "write", { path: join(root, "plain", "birch.txt"), content: "x" })).toMatch(/outside/);
		expect(existsSync(join(root, "plain", "birch.txt"))).toBe(false);
		// No memory, the outer agent's view among it: every agent's view is another's.
		for (const name of ["Atlas", "Birch"]) {
			const text = await call(run, "read", { path: join(root, `agent-${name}`, ".orrery", "view.md") });
			expect(text).toMatch(/sensitive|memory view/);
			expect(text).not.toContain("secret");
		}

		// Nothing recorded: no memory, no session owner, no host record of its own; the notice was said once.
		expect(existsSync(join(dataDir, "agents"))).toBe(false);
		expect(existsSync(join(dataDir, "session-owners"))).toBe(false);
		expect(hosts(dataDir)).toEqual([`${process.ppid}.json`]);
		expect(liveSession(dataDir, process.pid)).toBeUndefined();
		expect(run.notices).toHaveLength(1);
		await close(run);
		expect(hosts(dataDir)).toEqual([`${process.ppid}.json`]);
	}, 30_000);

	it("in a plain folder too, the outer agent's guard is on, where plain pi has none", async () => {
		const { root, config, dataDir } = nestedWorld();
		hostRecord(dataDir, "Atlas", "pi", process.ppid);
		const run = await pi(root, join(root, "plain"), config);
		expect(run.notices).toEqual([{ type: "warning", message: "Orrery: started inside Atlas's session (pi), so this one opens no memory and records nothing." }]);
		expect(await call(run, "write", { path: `${root}-escape.txt`, content: "x" })).toMatch(/outside/);
		expect(existsSync(`${root}-escape.txt`)).toBe(false);
		expect(existsSync(join(dataDir, "session-owners"))).toBe(false);
	}, 20_000);

	it("by markers alone, whose session unknown: the rules of a session with no agent, the stricter of plain pi's (none) and a refused one's", async () => {
		const { root, config, dataDir } = nestedWorld();
		// CLAUDE_PID naming a live Claude Code session that is no ancestor: a session, whose nobody can say (src/agent/sessions.ts).
		const claude = bystander();
		hostRecord(dataDir, "Atlas", "claude-code", claude);
		const run = await pi(root, join(root, "plain"), config, undefined, { env: { CLAUDE_PID: String(claude) } });
		expect(run.notices).toEqual([{ type: "warning", message: "Orrery: started inside an agent's session (Claude Code), so this one opens no memory and records nothing." }]);
		expect(run.tool("zoom")).toBeUndefined();
		// No agent's rules: the session's folder, no allowed roots, every view another's.
		expect(await call(run, "write", { path: join(root, "plain", "here.txt"), content: "x" })).not.toMatch(/outside/);
		expect(await call(run, "write", { path: join(root, "shared", "atlas.txt"), content: "x" })).toMatch(/outside/);
		expect(await call(run, "read", { path: join(root, "agent-Atlas", ".orrery", "view.md") })).toMatch(/sensitive|memory view/);
		expect(hosts(dataDir)).toEqual([`${claude}.json`]);
		expect(existsSync(join(dataDir, "session-owners"))).toBe(false);
	}, 20_000);
});

describe("a pi session's host record (spec 2026-10-18-agent-permissions §2)", () => {
	it("with no recorded ancestor: opens as before, records this pi as the agent's host in the config's data folder, and forgets it at shutdown", async () => {
		const { root, config } = world();
		const run = await pi(root, join(root, "agent-Atlas"), config);
		expect(run.status("orrery")).toBe("Orrery · Atlas · 0 msgs");
		expect(run.notices).toEqual([]);
		expect(liveSession(config.dataDir, process.pid)).toMatchObject({ agent: "Atlas", tool: "pi", pid: process.pid });
		await close(run);
		expect(liveSession(config.dataDir, process.pid)).toBeUndefined();
		expect(hosts(config.dataDir)).toEqual([]);
	});

	it("records an agent opened by ORRERY_AGENT outside its folder", async () => {
		const { root, config } = world();
		const run = await pi(root, join(root, "plain"), config, undefined, { env: { ORRERY_AGENT: "Birch" } });
		expect(liveSession(config.dataDir, process.pid)).toMatchObject({ agent: "Birch", tool: "pi" });
		await close(run);
		expect(liveSession(config.dataDir, process.pid)).toBeUndefined();
	});

	it("still records the host when the agent is held elsewhere and this pi runs without memory", async () => {
		const { root, config } = world();
		const agent = config.agents.get("Atlas")!;
		const holder = await Holder.start({ agent, session: "s1", claudePid: 111, nonce: "n", models: agentModelSource(fauxModels().models), alive: () => true, tickMs: 20 });
		try {
			const run = await pi(root, join(root, "agent-Atlas"), config);
			expect(run.notices).toContainEqual({ message: "Atlas is open in Claude Code; this pi runs without memory.", type: "warning" });
			expect(run.tool("zoom")).toBeUndefined();
			expect(liveSession(config.dataDir, process.pid)).toMatchObject({ agent: "Atlas", tool: "pi" });
			await close(run);
			expect(liveSession(config.dataDir, process.pid)).toBeUndefined();
		} finally {
			await holder?.stop("test over");
		}
	});

	it("records nothing in a plain folder, or under a refused ORRERY_AGENT", async () => {
		const { root, config } = world();
		await pi(root, join(root, "plain"), config);
		await pi(root, join(root, "agent-Atlas"), config, undefined, { env: { ORRERY_AGENT: "Nobody" } });
		expect(hosts(config.dataDir)).toEqual([]);
	});
});
