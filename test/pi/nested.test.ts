import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../../src/agent/config.ts";
import { agentModelSource } from "../../src/agent/model-source.ts";
import { forgetSession, HOST_ENV, liveSession, recordSession, type SessionTool } from "../../src/agent/sessions.ts";
import { Holder } from "../../src/claude/holder.ts";
import { above, plainDeps, realHomeOf, STARTS } from "../agent/plain-support.ts";
import { ompCleanup, ompOrrery } from "../omp/world.ts";
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
 * The pi world (Atlas and Birch), each agent with allowed roots of its own and one in common: Atlas `shared` and `common`,
 * Birch `plain` and `common/inner` (inside Atlas's `common`). A write under Atlas's rules differs from one under Birch's.
 * Each agent has a memory view in its folder.
 */
function nestedWorld() {
	const { root, configPath } = world();
	for (const dir of ["shared", join("common", "inner")]) mkdirSync(join(root, dir), { recursive: true });
	const roots = (...dirs: string[]) => `allowed_roots = ${JSON.stringify(dirs.map((dir) => join(root, dir)))}\n`;
	const toml = readFileSync(configPath, "utf8")
		.replace("[agents.Atlas]\n", `[agents.Atlas]\n${roots("shared", "common")}`)
		.replace("[agents.Birch]\n", `[agents.Birch]\n${roots("plain", join("common", "inner"))}`);
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
	it("under a recorded ancestor: opens no memory, registers no tools, records nothing, says why once, and keeps the guard on with the outer agent's rules and the folder's", async () => {
		const { root, config, dataDir } = nestedWorld();
		hostRecord(dataDir, "Atlas", "claude-code", process.ppid);
		// In Birch's folder, where Birch (who reads every agent) would open with the memory and reader tools.
		const run = await pi(root, join(root, "agent-Birch"), config);
		expect(run.notices).toEqual([{ type: "warning", message: "Orrery: started inside Atlas's session (Claude Code), so this one opens no memory and records nothing." }]);
		for (const tool of ["zoom", "date", "search", "agents", "agent_memory"]) expect(run.tool(tool)).toBeUndefined();
		expect(run.status("orrery")).toBeUndefined();

		// Atlas's rules and Birch's at once (never looser than Birch's own guard here): a write goes where both allow it.
		const writes = async (path: string) => !/outside/.test(await call(run, "write", { path: join(root, path), content: "x" }));
		expect(await writes(join("agent-Birch", "here.txt"))).toBe(true); // the session's folder, in both
		expect(readFileSync(join(root, "agent-Birch", "here.txt"), "utf8")).toBe("x");
		expect(await writes(join("common", "inner", "both.txt"))).toBe(true); // Birch's root, inside Atlas's
		expect(await writes(join("shared", "atlas.txt"))).toBe(false); // Atlas's root only
		expect(await writes(join("common", "atlas.txt"))).toBe(false); // Atlas's root, outside Birch's
		expect(await writes(join("plain", "birch.txt"))).toBe(false); // Birch's root only
		for (const path of [join("shared", "atlas.txt"), join("common", "atlas.txt"), join("plain", "birch.txt")]) expect(existsSync(join(root, path))).toBe(false);
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

	it("given a config whose data folder is inside the outer session's: still nested, and records nothing there", async () => {
		const { root, dataDir } = nestedWorld();
		hostRecord(dataDir, "Atlas", "claude-code", process.ppid);
		// A config of the agent's making, to open and record into a data folder of its own inside the real one.
		const inner = join(dataDir, "agents", "Birch");
		const planted = parseConfig(readFileSync(join(dataDir, "config.toml"), "utf8").replace(JSON.stringify(dataDir), JSON.stringify(inner)), root);
		expect(planted.dataDir).toBe(inner);
		const run = await pi(root, join(root, "agent-Birch"), planted);
		expect(run.notices).toEqual([{ type: "warning", message: "Orrery: started inside Atlas's session (Claude Code), so this one opens no memory and records nothing." }]);
		for (const tool of ["zoom", "date", "search", "agents", "agent_memory"]) expect(run.tool(tool)).toBeUndefined();
		await close(run);
		expect(hosts(inner)).toEqual([]);
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

	it("in an agent's folder inside the outer agent's folder: no wider than that agent's own guard, the outer folder refused", async () => {
		// Atlas's folder holds Birch's: p and p/sub. Birch is allowed nothing beyond its folder; Atlas, the world's folder.
		const { root, configPath } = world();
		mkdirSync(join(root, "p", "sub"), { recursive: true });
		const toml = readFileSync(configPath, "utf8")
			.replace(JSON.stringify(join(root, "agent-Atlas")), JSON.stringify(join(root, "p")))
			.replace(JSON.stringify(join(root, "agent-Birch")), JSON.stringify(join(root, "p", "sub")))
			.replace("[agents.Birch]\n", "[agents.Birch]\nallowed_roots = []\n");
		const config = parseConfig(toml, root);
		hostRecord(config.dataDir, "Atlas", "pi", process.ppid);
		const run = await pi(root, join(root, "p", "sub"), config);
		expect(run.notices).toEqual([{ type: "warning", message: "Orrery: started inside Atlas's session (pi), so this one opens no memory and records nothing." }]);
		const writes = async (path: string) => !/outside/.test(await call(run, "write", { path: join(root, path), content: "x" }));
		expect(await writes(join("p", "sub", "here.txt"))).toBe(true);
		expect(await writes(join("p", "atlas.txt"))).toBe(false); // Atlas's folder, outside Birch's
		expect(await writes(join("plain", "atlas.txt"))).toBe(false); // Atlas's allowed root, not Birch's
		expect(existsSync(join(root, "p", "atlas.txt"))).toBe(false);
	}, 20_000);

	it("fails closed when the session lookup throws: a session whose agent is unknown, with the no-agent rules", async () => {
		const { root, config, dataDir } = nestedWorld();
		// Only the session lookup reads these; reading one throws.
		const markers = new Set(["ORRERY_AGENT", "ORRERY_AGENT_TOKEN", "ORRERY_HOST", "CLAUDE_PID", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "OPENCODE_CONFIG_CONTENT"]);
		const env = new Proxy({} as NodeJS.ProcessEnv, {
			get: (_target, key) => {
				if (typeof key === "string" && markers.has(key)) throw new Error("this environment can't be read");
				return undefined;
			},
		});
		const run = await pi(root, join(root, "agent-Birch"), config, undefined, { env });
		expect(run.notices).toEqual([{ type: "warning", message: "Orrery: started inside an agent's session, so this one opens no memory and records nothing." }]);
		expect(run.tool("zoom")).toBeUndefined();
		// Birch's folder, without Birch: its rules, as for a refused ORRERY_AGENT.
		expect(await call(run, "write", { path: join(root, "agent-Birch", "here.txt"), content: "x" })).not.toMatch(/outside/);
		expect(await call(run, "write", { path: join(root, "shared", "atlas.txt"), content: "x" })).toMatch(/outside/);
		expect(hosts(dataDir)).toEqual([]);
		expect(existsSync(join(dataDir, "session-owners"))).toBe(false);
	}, 20_000);

	it("detached from the agent's session (no ancestry), found by the ORRERY_HOST its shell left it: no memory, no record", async () => {
		const { root, config, dataDir } = nestedWorld();
		const host = bystander();
		hostRecord(dataDir, "Atlas", "pi", host);
		const run = await pi(root, join(root, "agent-Birch"), config, undefined, { env: { ORRERY_HOST: String(host) } });
		// A pid is anyone's to copy: it says there is a session, never whose.
		expect(run.notices).toEqual([{ type: "warning", message: "Orrery: started inside an agent's session (pi), so this one opens no memory and records nothing." }]);
		expect(run.tool("zoom")).toBeUndefined();
		expect(run.status("orrery")).toBeUndefined();
		expect(existsSync(join(dataDir, "agents"))).toBe(false);
		expect(hosts(dataDir)).toEqual([`${host}.json`]);
	});

	it("is decided once for the process: a new session after the outer one ended stays nested, and one started outside stays outside", async () => {
		const { root, config, dataDir } = nestedWorld();
		hostRecord(dataDir, "Atlas", "claude-code", process.ppid);
		const run = await pi(root, join(root, "agent-Birch"), config);
		const notice = { type: "warning", message: "Orrery: started inside Atlas's session (Claude Code), so this one opens no memory and records nothing." };
		expect(run.notices).toEqual([notice]);
		// The outer session ends; this pi outlives it and starts a new session (/new).
		forgetSession(dataDir, process.ppid);
		await run.runtime.newSession();
		expect(run.notices).toEqual([notice, notice]);
		for (const tool of ["zoom", "date", "search", "agents", "agent_memory"]) expect(run.tool(tool)).toBeUndefined();
		expect(run.status("orrery")).toBeUndefined();
		expect(existsSync(join(dataDir, "agents"))).toBe(false);
		expect(hosts(dataDir)).toEqual([]);
		await close(run);

		// A pi started outside every session stays outside, whatever is recorded around it later.
		const { root: other, config: plain, dataDir: data } = nestedWorld();
		const outside = await pi(other, join(other, "agent-Birch"), plain);
		expect(outside.status("orrery")).toBe("Orrery · Birch · 0 msgs");
		hostRecord(data, "Atlas", "claude-code", process.ppid);
		await outside.runtime.newSession();
		expect(outside.status("orrery")).toBe("Orrery · Birch · 0 msgs");
		expect(outside.notices.filter((n) => n.message.includes("started inside"))).toEqual([]);
		await close(outside);
	}, 30_000);
});

describe("a pi started from a coding tool's session that is no agent's (spec 2026-10-19-no-agent-sessions §4c)", () => {
	const PLAIN_CLAUDE = { type: "warning", message: "Orrery: started inside a Claude Code session that is no agent's, so this one opens no memory and records nothing." };

	it("in an agent's folder: opens no memory, registers no tools, records nothing, says why once, and keeps that agent's guard", async () => {
		const { root, config, dataDir } = nestedWorld();
		// A clean environment: this test's own (a Claude Code's, maybe) carries markers of its own.
		const run = await pi(root, join(root, "agent-Birch"), config, undefined, { env: {}, plain: plainDeps(process.pid, STARTS.claude, dataDir) });
		expect(run.notices).toEqual([PLAIN_CLAUDE]);
		for (const tool of ["zoom", "date", "search", "agents", "agent_memory"]) expect(run.tool(tool)).toBeUndefined();
		expect(run.status("orrery")).toBeUndefined();
		// Birch's rules: its folder and its allowed roots, nothing else; every view kept out.
		const writes = async (path: string) => !/outside/.test(await call(run, "write", { path: join(root, path), content: "x" }));
		expect(await writes(join("agent-Birch", "here.txt"))).toBe(true);
		expect(await writes(join("common", "inner", "birch.txt"))).toBe(true);
		expect(await writes(join("shared", "atlas.txt"))).toBe(false);
		for (const name of ["Atlas", "Birch"]) expect(await call(run, "read", { path: join(root, `agent-${name}`, ".orrery", "view.md") })).toMatch(/sensitive|memory view/);
		expect(existsSync(join(dataDir, "agents"))).toBe(false);
		expect(existsSync(join(dataDir, "session-owners"))).toBe(false);
		expect(hosts(dataDir)).toEqual([]);
		expect(process.env[HOST_ENV]).toBeUndefined();
		await close(run);
	}, 30_000);

	it("by ORRERY_AGENT outside its folder: the same, its token never claimed", async () => {
		const { root, config, dataDir } = nestedWorld();
		const run = await pi(root, join(root, "plain"), config, undefined, { env: { ORRERY_AGENT: "Birch" }, plain: plainDeps(process.pid, STARTS.codex, dataDir) });
		expect(run.notices).toEqual([{ ...PLAIN_CLAUDE, message: PLAIN_CLAUDE.message.replace("a Claude Code", "a Codex") }]);
		expect(run.tool("zoom")).toBeUndefined();
		expect(hosts(dataDir)).toEqual([]);
		await close(run);
	}, 20_000);

	it("outside every agent's folder: a plain session, Orrery's own guard alone and no notice", async () => {
		const { root, config, dataDir } = nestedWorld();
		const run = await pi(root, join(root, "plain"), config, undefined, { env: {}, plain: plainDeps(process.pid, STARTS.claude, dataDir) });
		expect(run.notices).toEqual([]);
		// No folder rule: outside its own folder too, as plain pi.
		expect(await call(run, "write", { path: join(root, "shared", "anywhere.txt"), content: "x" })).not.toMatch(/outside|Orrery guard/);
		expect(readFileSync(join(root, "shared", "anywhere.txt"), "utf8")).toBe("x");
		expect(await call(run, "write", { path: join(dataDir, "agents", "Atlas", "x.txt"), content: "x" })).toMatch(/Orrery guard|sensitive/);
		expect(existsSync(join(dataDir, "session-owners"))).toBe(false);
		await close(run);
	}, 20_000);

	it("found by another tool's variable (left over in the terminal, Ori in a tmux a Claude Code shell started): the notice names it", async () => {
		const { root, config, dataDir } = nestedWorld();
		const run = await pi(root, join(root, "agent-Birch"), config, undefined, { env: { CLAUDECODE: "1" }, plain: plainDeps(process.pid, STARTS.ori, dataDir) });
		expect(run.notices).toEqual([
			{ type: "warning", message: 'Orrery: started inside a Claude Code session that is no agent\'s (found CLAUDECODE; see "Leftover markers" in the README), so this one opens no memory and records nothing.' },
		]);
		expect(run.tool("zoom")).toBeUndefined();
		await close(run);
	}, 20_000);

	it("is decided once for the process: a new session stays without memory", async () => {
		const { root, config, dataDir } = nestedWorld();
		const run = await pi(root, join(root, "agent-Birch"), config, undefined, { env: {}, plain: plainDeps(process.pid, STARTS.pi, dataDir) });
		const notice = { ...PLAIN_CLAUDE, message: PLAIN_CLAUDE.message.replace("a Claude Code", "a pi") };
		expect(run.notices).toEqual([notice]);
		await run.runtime.newSession();
		expect(run.notices).toEqual([notice, notice]);
		expect(run.tool("zoom")).toBeUndefined();
		expect(hosts(dataDir)).toEqual([]);
		await close(run);
	}, 30_000);

	it("opens its agent as today when started from the user's terminal, the TUI, orrery agent or Ori", async () => {
		for (const start of ["terminal", "tui", "agent", "ori"] as const) {
			const { root, config, dataDir } = nestedWorld();
			const run = await pi(root, join(root, "agent-Birch"), config, undefined, { env: {}, plain: plainDeps(process.pid, STARTS[start], dataDir) });
			expect(run.status("orrery"), start).toBe("Orrery · Birch · 0 msgs");
			expect(run.notices, start).toEqual([]);
			expect(liveSession(dataDir, process.pid), start).toMatchObject({ agent: "Birch", tool: "pi" });
			await close(run);
		}
	}, 60_000);

	it("OMP started in a plain folder stays without memory when it moves into an agent's folder, under that agent's guard", async () => {
		const { root, config, dataDir } = nestedWorld();
		const host = await ompOrrery(join(root, "plain"), config, { env: {}, plain: plainDeps(process.pid, STARTS.claude, dataDir) });
		const tool = async (toolName: string, input: object) => (await host.emit("tool_call", { toolName, toolCallId: "t1", input }))[0];
		expect(host.notices).toEqual([]);
		expect(await tool("write", { path: join(root, "shared", "x.txt"), content: "x" })).toBeUndefined();
		// OMP's /move into Birch's folder: still no memory, and Birch's guard from the next message on.
		host.cwd = join(root, "agent-Birch");
		await host.emit("before_agent_start", { systemPrompt: [] });
		expect(host.status("orrery")).toBeUndefined();
		expect(host.tools.has("zoom")).toBe(false);
		expect(await tool("write", { path: join(root, "shared", "x.txt"), content: "x" })).toEqual({ block: true, reason: expect.stringMatching(/outside this agent's folder/) });
		expect(existsSync(join(dataDir, "agents"))).toBe(false);
		expect(hosts(dataDir)).toEqual([]);
		await ompCleanup();
	}, 20_000);

	it("a scratch home is not judged: under a plain Claude Code it opens as ever", async () => {
		const { root, config } = nestedWorld();
		const run = await pi(root, join(root, "agent-Birch"), config, undefined, { env: {}, plain: { sessions: above(process.pid, STARTS.claude), realHome: realHomeOf(join(root, "real-data")) } });
		expect(run.status("orrery")).toBe("Orrery · Birch · 0 msgs");
		await close(run);
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
		expect(process.env[HOST_ENV]).toBeUndefined();
	});

	it("leaves its host pid to its shell while recorded (ORRERY_HOST): a command it runs sees it; taken back at shutdown", async () => {
		const { root, config } = world();
		expect(process.env[HOST_ENV]).toBeUndefined();
		const run = await pi(root, join(root, "agent-Atlas"), config);
		expect(process.env[HOST_ENV]).toBe(String(process.pid));
		// pi's own bash, as the agent runs it.
		expect(await call(run, "bash", { command: `echo "host=$${HOST_ENV}"` })).toContain(`host=${process.pid}`);
		await close(run);
		expect(process.env[HOST_ENV]).toBeUndefined();
	});

	it("says when its session can't be recorded, and opens its memory all the same", async () => {
		const { root, config } = world();
		// A file where the records' folder goes: nothing can be written there.
		mkdirSync(config.dataDir, { recursive: true });
		writeFileSync(join(config.dataDir, "session-hosts"), "");
		const run = await pi(root, join(root, "agent-Atlas"), config);
		expect(run.notices).toEqual([{ type: "warning", message: "Orrery: this session could not be recorded as Atlas's, so tools and commands started from it are not known as Atlas's." }]);
		expect(run.status("orrery")).toBe("Orrery · Atlas · 0 msgs");
		expect(process.env[HOST_ENV]).toBeUndefined();
		await close(run);
	});
});
