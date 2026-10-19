import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../../src/agent/config.ts";
import { agentModelSource } from "../../src/agent/model-source.ts";
import { forgetSession, HOST_ENV, liveSession, recordSession, type SessionTool } from "../../src/agent/sessions.ts";
import { Holder } from "../../src/claude/holder.ts";
import { createOrrery } from "../../src/pi/index.ts";
import { fauxModels } from "../agent/support.ts";
import { cleanup, scratchHome, world } from "../pi/world.ts";
import { type FakeOmp, fakeOmp, ompCleanup, ompOrrery, track } from "./world.ts";

const recorded: { dataDir: string; pid: number }[] = [];
afterEach(async () => {
	for (const { dataDir, pid } of recorded.splice(0)) forgetSession(dataDir, pid);
	await ompCleanup();
	await cleanup();
});

/**
 * The pi world (Atlas and Birch), each agent with allowed roots of its own and one in common: Atlas `shared` and `common`,
 * Birch `plain` and `common/inner` (see test/pi/nested.test.ts).
 */
function nestedWorld() {
	const { root, configPath } = world();
	for (const dir of ["shared", join("common", "inner")]) mkdirSync(join(root, dir), { recursive: true });
	const roots = (...dirs: string[]) => `allowed_roots = ${JSON.stringify(dirs.map((dir) => join(root, dir)))}\n`;
	const toml = readFileSync(configPath, "utf8")
		.replace("[agents.Atlas]\n", `[agents.Atlas]\n${roots("shared", "common")}`)
		.replace("[agents.Birch]\n", `[agents.Birch]\n${roots("plain", join("common", "inner"))}`);
	const config = parseConfig(toml, root);
	return { root, config, dataDir: config.dataDir };
}

function hostRecord(dataDir: string, agent: string, tool: SessionTool, pid: number): void {
	expect(recordSession(dataDir, { agent, tool, pid })).toBe(true);
	recorded.push({ dataDir, pid });
}

const hosts = (dataDir: string): string[] => (existsSync(join(dataDir, "session-hosts")) ? readdirSync(join(dataDir, "session-hosts")) : []);
const write = async (omp: FakeOmp, path: string) => (await omp.emit("tool_call", { toolName: "write", toolCallId: "t1", input: { path, content: "x" } }))[0];
const refusedOutside = { block: true, reason: expect.stringMatching(/outside/) };

/** One turn as OMP runs it (test/omp/extension.test.ts). */
async function turn(omp: FakeOmp, user: string, reply: string) {
	omp.say("user", user);
	const [result] = await omp.emit("before_agent_start", { prompt: user, systemPrompt: ["OMP base"] });
	omp.say("assistant", reply);
	await omp.emit("message_end", { message: {} });
	await omp.emit("agent_end", { messages: [] });
	return result;
}

/** /resume of a saved session from `cwd`: OMP moves the session there, then says session_switch "resume". */
async function resume(omp: FakeOmp, cwd: string, id: string) {
	omp.cwd = cwd;
	omp.session = { id, entries: [] };
	await omp.emit("session_switch", { reason: "resume", previousSessionFile: "/sessions/s1.jsonl" });
}

describe("an OMP started inside an agent's session (spec 2026-10-18-agent-permissions §3b)", () => {
	it("under a recorded ancestor: no memory, no tools, nothing recorded, one notice, the outer agent's guard; a switch or a move keeps it so", async () => {
		const { root, config, dataDir } = nestedWorld();
		hostRecord(dataDir, "Atlas", "pi", process.ppid);
		const omp = await ompOrrery(join(root, "agent-Birch"), config);
		expect(omp.notices).toEqual([{ type: "warning", message: "Orrery: started inside Atlas's session (pi), so this one opens no memory and records nothing." }]);
		expect(omp.tools.size).toBe(0);
		expect(omp.status("orrery")).toBeUndefined();
		// Atlas's rules and Birch's at once in Birch's folder: a write goes only where both allow it.
		expect(await write(omp, join(root, "agent-Birch", "x.txt"))).toBeUndefined();
		expect(await write(omp, join(root, "common", "inner", "x.txt"))).toBeUndefined();
		expect(await write(omp, join(root, "shared", "x.txt"))).toEqual(refusedOutside);
		expect(await write(omp, join(root, "common", "x.txt"))).toEqual(refusedOutside);
		expect(await write(omp, join(root, "plain", "x.txt"))).toEqual(refusedOutside);
		expect(await turn(omp, "Question.", "Answer.")).toBeUndefined();
		await omp.run("orrery");
		expect(omp.notices.at(-1)).toEqual({ message: "Orrery: no agent memory is open in this OMP", type: "warning" });

		// /resume of a session in Atlas's own folder: still inside Atlas's session, Atlas's guard alone following the folder.
		await resume(omp, join(root, "agent-Atlas"), "s2");
		expect(omp.tools.size).toBe(0);
		expect(await write(omp, join(root, "agent-Atlas", "x.txt"))).toBeUndefined();
		expect(await write(omp, join(root, "shared", "x.txt"))).toBeUndefined();
		expect(await write(omp, join(root, "agent-Birch", "x.txt"))).toEqual(refusedOutside);
		// /move (no session event) into a plain folder: the next message finds it, and nothing opens.
		omp.cwd = join(root, "plain");
		expect(await turn(omp, "Moved.", "Answer.")).toBeUndefined();
		expect(await write(omp, join(root, "plain", "y.txt"))).toBeUndefined();
		expect(await write(omp, join(root, "agent-Atlas", "y.txt"))).toEqual(refusedOutside);

		expect(omp.notices.filter((notice) => notice.message.includes("started inside"))).toHaveLength(1);
		expect(existsSync(join(dataDir, "agents"))).toBe(false);
		expect(existsSync(join(dataDir, "session-owners"))).toBe(false);
		await omp.emit("session_shutdown");
		expect(hosts(dataDir)).toEqual([`${process.ppid}.json`]);
	});

	it("an OMP subagent of a nested session gets the same guard and says nothing", async () => {
		const { root, config, dataDir } = nestedWorld();
		hostRecord(dataDir, "Atlas", "pi", process.ppid);
		const sub = await ompOrrery(join(root, "agent-Birch"), config, { agent: "sub" });
		expect(sub.notices).toEqual([]);
		expect(sub.tools.size).toBe(0);
		expect(await write(sub, join(root, "plain", "x.txt"))).toEqual(refusedOutside);
		expect(hosts(dataDir)).toEqual([`${process.ppid}.json`]);
	});

	it("is decided once for the process: after the outer session ended, a new session, a subagent and a reload stay nested", async () => {
		const { root, config, dataDir } = nestedWorld();
		hostRecord(dataDir, "Atlas", "pi", process.ppid);
		const notice = { type: "warning", message: "Orrery: started inside Atlas's session (pi), so this one opens no memory and records nothing." };
		const omp = await ompOrrery(join(root, "agent-Birch"), config);
		expect(omp.notices).toEqual([notice]);
		// The outer session ends; this OMP outlives it and starts a new session.
		forgetSession(dataDir, process.ppid);
		omp.session = { id: "n1", entries: [] };
		await omp.emit("session_switch", { reason: "new" });
		expect(omp.tools.size).toBe(0);
		expect(omp.status("orrery")).toBeUndefined();
		expect(await turn(omp, "Question.", "Answer.")).toBeUndefined();
		// Atlas's rules and Birch's at once, as before: Birch's own root alone is refused.
		expect(await write(omp, join(root, "plain", "x.txt"))).toEqual(refusedOutside);
		// A subagent the OMP starts now (the extension loaded again in this process) keeps that guard.
		const sub = await ompOrrery(join(root, "agent-Birch"), config, { agent: "sub" });
		expect(sub.tools.size).toBe(0);
		expect(await write(sub, join(root, "plain", "x.txt"))).toEqual(refusedOutside);
		// So does the extension loaded again for the main session.
		const again = await ompOrrery(join(root, "agent-Birch"), config);
		expect(again.notices).toEqual([notice]);
		expect(again.tools.size).toBe(0);
		expect(existsSync(join(dataDir, "agents"))).toBe(false);
		expect(hosts(dataDir)).toEqual([]);
	});

	it("pi's entry loaded in OMP (mismatched): nested, it says so instead and notes nothing", async () => {
		const { root, config, dataDir } = nestedWorld();
		hostRecord(dataDir, "Atlas", "pi", process.ppid);
		const omp = track(fakeOmp(join(root, "agent-Birch"), [createOrrery({ config, ...scratchHome(dirname(config.dataDir)) })]));
		await omp.emit("session_start");
		expect(omp.notices).toEqual([{ type: "warning", message: "Orrery: started inside Atlas's session (pi), so this one opens no memory and records nothing." }]);
		expect(await write(omp, join(root, "plain", "x.txt"))).toEqual(refusedOutside);
		await omp.emit("message_end", { message: {} });
		await omp.emit("session_shutdown");
		expect(existsSync(join(dataDir, "session-owners"))).toBe(false);
		expect(hosts(dataDir)).toEqual([`${process.ppid}.json`]);
	});

	it("pi's entry loaded in OMP fails closed when the session lookup throws: a session whose agent is unknown", async () => {
		const { root, config, dataDir } = nestedWorld();
		const markers = new Set(["ORRERY_AGENT", "ORRERY_AGENT_TOKEN", "ORRERY_HOST", "CLAUDE_PID", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "OPENCODE_CONFIG_CONTENT"]);
		const env = new Proxy({} as NodeJS.ProcessEnv, {
			get: (_target, key) => {
				if (typeof key === "string" && markers.has(key)) throw new Error("this environment can't be read");
				return undefined;
			},
		});
		const omp = track(fakeOmp(join(root, "agent-Birch"), [createOrrery({ config, ...scratchHome(dirname(config.dataDir)), env })]));
		await omp.emit("session_start");
		expect(omp.notices).toEqual([{ type: "warning", message: "Orrery: started inside an agent's session, so this one opens no memory and records nothing." }]);
		expect(await write(omp, join(root, "shared", "x.txt"))).toEqual(refusedOutside);
		await omp.emit("session_shutdown");
		expect(hosts(dataDir)).toEqual([]);
		expect(existsSync(join(dataDir, "session-owners"))).toBe(false);
	});
});

describe("an OMP session's host record (spec 2026-10-18-agent-permissions §2)", () => {
	it("records OMP as the agent's host, follows a switch into another agent's folder (same pid), and forgets it when the session leaves agents", async () => {
		const { root, config } = world();
		const pid = String(process.pid);
		expect(process.env[HOST_ENV]).toBeUndefined();
		const omp = await ompOrrery(join(root, "agent-Atlas"), config);
		expect(omp.notices).toEqual([]);
		expect(liveSession(config.dataDir, process.pid)).toMatchObject({ agent: "Atlas", tool: "omp", pid: process.pid });
		// Its shell gets the host pid (ORRERY_HOST) while the session is the agent's.
		expect(process.env[HOST_ENV]).toBe(pid);
		await resume(omp, join(root, "agent-Birch"), "birch-1");
		expect(omp.status("orrery")).toMatch(/^Orrery · Birch/);
		expect(liveSession(config.dataDir, process.pid)).toMatchObject({ agent: "Birch", tool: "omp", pid: process.pid });
		expect(hosts(config.dataDir)).toEqual([`${process.pid}.json`]);
		expect(process.env[HOST_ENV]).toBe(pid);
		await resume(omp, join(root, "plain"), "plain-1");
		expect(liveSession(config.dataDir, process.pid)).toBeUndefined();
		expect(process.env[HOST_ENV]).toBeUndefined();
		// Back into an agent's folder by /move: the next message opens it, and records the host again.
		omp.cwd = join(root, "agent-Atlas");
		await turn(omp, "Back.", "Yes.");
		expect(liveSession(config.dataDir, process.pid)).toMatchObject({ agent: "Atlas", tool: "omp" });
		expect(process.env[HOST_ENV]).toBe(pid);
		await omp.emit("session_shutdown");
		expect(liveSession(config.dataDir, process.pid)).toBeUndefined();
		expect(process.env[HOST_ENV]).toBeUndefined();
	});

	it("a switch into an agent held elsewhere records that agent, which this OMP runs without memory", async () => {
		const { root, config } = world();
		const birch = config.agents.get("Birch")!;
		const holder = await Holder.start({ agent: birch, session: "s1", claudePid: 111, nonce: "n", models: agentModelSource(fauxModels().models), alive: () => true, tickMs: 20 });
		try {
			const omp = await ompOrrery(join(root, "agent-Atlas"), config);
			await resume(omp, join(root, "agent-Birch"), "birch-1");
			expect(omp.notices).toContainEqual({ message: "Birch is open in Claude Code; this OMP runs without memory.", type: "warning" });
			expect(omp.tools.size).toBe(3); // registered once per runtime, when Atlas opened
			expect(liveSession(config.dataDir, process.pid)).toMatchObject({ agent: "Birch", tool: "omp" });
			await omp.emit("session_shutdown");
			expect(liveSession(config.dataDir, process.pid)).toBeUndefined();
		} finally {
			await holder?.stop("test over");
		}
	});

	it("an ORRERY_AGENT session keeps its record wherever OMP moves it", async () => {
		const { root, config } = world();
		const omp = await ompOrrery(join(root, "plain"), config, { env: { ORRERY_AGENT: "Atlas" } });
		expect(liveSession(config.dataDir, process.pid)).toMatchObject({ agent: "Atlas", tool: "omp" });
		await resume(omp, join(root, "agent-Birch"), "s2");
		expect(liveSession(config.dataDir, process.pid)).toMatchObject({ agent: "Atlas", tool: "omp" });
	});

	it("a subagent records nothing, and its end leaves the main session's record", async () => {
		const { root, config } = world();
		await ompOrrery(join(root, "agent-Atlas"), config);
		const sub = await ompOrrery(join(root, "agent-Atlas"), config, { agent: "sub" });
		await sub.emit("session_shutdown");
		expect(liveSession(config.dataDir, process.pid)).toMatchObject({ agent: "Atlas", tool: "omp" });
	});

	it("pi's entry loaded in OMP records OMP as the folder agent's host, and forgets it at shutdown", async () => {
		const { root, config } = world();
		const omp = track(fakeOmp(join(root, "agent-Atlas"), [createOrrery({ config, ...scratchHome(dirname(config.dataDir)) })]));
		await omp.emit("session_start");
		expect(liveSession(config.dataDir, process.pid)).toMatchObject({ agent: "Atlas", tool: "omp" });
		await omp.emit("session_shutdown");
		expect(liveSession(config.dataDir, process.pid)).toBeUndefined();
	});
});
