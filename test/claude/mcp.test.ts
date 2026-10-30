import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { handleMessage, agentTools, MAX_LINE_CHARS, runMcp } from "../../src/claude/mcp.ts";
import { MemoryStore } from "../../src/memory/index.ts";
import type { ReaderTool } from "../../src/agent/memory-tools.ts";
import { claimedBy, claimToken, newToken } from "../../src/agent/pick.ts";
import { forgetSession, liveSession, recordSession } from "../../src/agent/sessions.ts";
import { processStartedAt } from "../../src/agent/process.ts";
import { runHook } from "../../src/claude/hooks.ts";
import { claudeSession, forgetProcess, UNCONFIRMED_NOTICE } from "../../src/claude/pick.ts";
import { writeMode } from "../../src/claude/spool.ts";
import { writeSetupMarker } from "../../src/claude/view-file.ts";
import { seedAtlas } from "../agent/support.ts";
import { cleanup, isolatedHome, pi, world } from "../pi/world.ts";
import { cleanEnv, cliCommand, grokLaunch, grokLeaderFolder, grokLeaderLaunch, grokWorkerLaunch } from "./support.ts";

afterEach(cleanup);
// One test starts a real pi; the MCP processes below get a scratch HOME of their own (the world's root).
isolatedHome();

// biome-ignore lint/suspicious/noExplicitAny: JSON-RPC replies are checked field by field.
const call = (tools: readonly ReaderTool[], method: string, params: object = {}): any => JSON.parse(JSON.stringify(handleMessage({ jsonrpc: "2.0", id: 1, method, params }, tools)));

/** Feeds `chunks` to runMcp on a stream and returns the lines it printed. */
async function serve(chunks: string[], tools: readonly ReaderTool[] = []): Promise<string[]> {
	const input = new PassThrough();
	const output = new PassThrough();
	let out = "";
	output.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
	const done = runMcp(input, output, tools);
	for (const chunk of chunks) input.write(chunk);
	input.end();
	await done;
	return out.split("\n").filter((line) => line !== "");
}

describe("Orrery's MCP server", () => {
	it("answers the handshake Claude Code sends", () => {
		const init = call([], "initialize", { protocolVersion: "2025-06-18", capabilities: { roots: {} } });
		expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "orrery" } });
		expect(handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, [])).toBeUndefined();
		expect(call([], "server/discover").error.code).toBe(-32601);
		expect(call([], "ping").result).toEqual({});
	});

	it("lists the agent's tools as JSON Schema, long ones with Claude Code's inline-size hint, reader tools only for readers", () => {
		const { config } = world();
		const atlas = call(agentTools(config, config.agents.get("Atlas")!), "tools/list").result.tools;
		expect(atlas.map((tool: { name: string }) => tool.name)).toEqual(["zoom", "date", "search"]);
		expect(atlas[0]).toEqual({
			name: "zoom",
			description: expect.any(String),
			inputSchema: { type: "object", required: ["id", "n"], properties: { id: { type: "integer" }, n: { type: "integer" } } },
			_meta: { "anthropic/maxResultSizeChars": 300_000 },
		});
		expect(atlas[1]._meta).toBeUndefined();
		const birch = call(agentTools(config, config.agents.get("Birch")!), "tools/list").result.tools;
		expect(birch.map((tool: { name: string }) => tool.name)).toEqual(["zoom", "date", "search", "agents", "agent_memory"]);
		expect(birch[4]._meta).toEqual({ "anthropic/maxResultSizeChars": 300_000 });
	});

	it("returns what pi's tools return, from a read-only snapshot taken while pi holds the agent", async () => {
		const { root, config } = world();
		seedAtlas(root);
		const run = await pi(root, join(root, "agent-Atlas"), config);
		const tools = agentTools(config, config.agents.get("Atlas")!);
		const cases: Array<[string, object]> = [["zoom", { id: 0, n: 1 }], ["date", { id: 1 }], ["search", { query: "garden-plants" }]];
		for (const [name, params] of cases) {
			const viaPi = (await run.tool(name)!.execute("x", params)).content.map((c) => c.text ?? "").join("");
			expect(call(tools, "tools/call", { name, arguments: params }).result).toEqual({ content: [{ type: "text", text: viaPi }] });
		}
	});

	it("reports bad arguments, unknown tools and failed reads as tool errors, not protocol errors", () => {
		const { config } = world();
		const tools = agentTools(config, config.agents.get("Birch")!);
		const bad = call(tools, "tools/call", { name: "zoom", arguments: { id: "x", n: 1 } }).result;
		expect(bad.isError).toBe(true);
		expect(bad.content[0].text).toMatch(/^Invalid arguments for zoom: \/id must be integer/);
		expect(call(tools, "tools/call", { name: "nope", arguments: {} }).result).toEqual({ content: [{ type: "text", text: "No tool nope" }], isError: true });
		expect(call(tools, "tools/call", { name: "agent_memory", arguments: { agent: "Birch", action: "view" } }).result).toEqual({
			content: [{ type: "text", text: "Birch has no memory yet" }],
			isError: true,
		});
	});

	it("answers malformed JSON with a parse error and a line over the size limit with an error, and keeps serving", async () => {
		const secret = "SECRET-TEXT";
		const lines = await serve([
			`{"jsonrpc": ${secret}\n`,
			`${"x".repeat(MAX_LINE_CHARS + 10)}\n`,
			`{"jsonrpc":"2.0","id":7,"method":"ping"}\n`,
			`{"jsonrpc":"2.0","id":8,`,
			`"method":"ping"}\n`,
			"[1]\n",
		]);
		const replies = lines.map((line) => JSON.parse(line));
		expect(replies.map((r) => r.error?.code ?? r.id)).toEqual([-32700, -32600, 7, 8, -32600]);
		expect(lines.join("")).not.toContain(secret);
	});

	it("answers a tool name that is not a string with an error, and keeps serving", async () => {
		const lines = await serve([
			`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":{"toString":1}}}\n`,
			`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":["a"]}}\n`,
			`{"jsonrpc":"2.0","id":3,"method":"ping"}\n`,
		]);
		const replies = lines.map((line) => JSON.parse(line));
		expect(replies.map((r) => r.id)).toEqual([1, 2, 3]);
		expect(replies[0].result.isError).toBe(true);
		expect(replies[2].result).toEqual({});
	});

	it("does not buffer a line that never ends", async () => {
		const lines = await serve(["y".repeat(MAX_LINE_CHARS), "y".repeat(MAX_LINE_CHARS), "y".repeat(MAX_LINE_CHARS)]);
		expect(lines.map((line) => JSON.parse(line).error.code)).toEqual([-32600]);
	});

	it("delivers a long reply in full when stdin closes right after the request", { timeout: 60_000 }, async () => {
		const { root, configPath } = world();
		mkdirSync(join(root, "data", "agents", "Atlas"), { recursive: true });
		const store = MemoryStore.open(join(root, "data", "agents", "Atlas", "memory.sqlite"));
		const big = "word ".repeat(200_000);
		store.appendBatch([{ kind: "user", text: big, date: "2026-02-10T10:00:00.000Z" }]);
		store.close();
		const c = cliCommand(["mcp"]);
		const child = spawn(c.cmd, c.args, { env: cleanEnv({ ORRERY_CONFIG: configPath, CLAUDE_PROJECT_DIR: join(root, "agent-Atlas"), HOME: root }), cwd: root });
		const chunks: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
		child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "zoom", arguments: { id: 0, n: 1 } } })}\n`);
		expect(await exited).toBe(0);
		const reply = JSON.parse(Buffer.concat(chunks).toString("utf8").trim());
		expect(reply.result.content[0].text.length).toBeGreaterThan(100_000);
	});

	it("runs over stdio as `orrery mcp`, finds the agent by ORRERY_AGENT or from CLAUDE_PROJECT_DIR, and serves no tools outside an agent", { timeout: 60_000 }, async () => {
		const { root, config, configPath } = world();
		seedAtlas(root);
		/** `orrery mcp`, started by this test, or (`viaShell`) by a shell this test starts, which is then its parent. */
		const session = async (projectDir: string, env: Record<string, string> = { ORRERY_CONFIG: configPath }, viaShell = false) => {
			const c = cliCommand(["mcp"]);
			const [cmd, args] = viaShell ? ["sh", ["-c", '"$@"; exit $?', "sh", c.cmd, ...c.args]] : [c.cmd, c.args];
			const child = spawn(cmd, args, { env: cleanEnv({ ...env, CLAUDE_PROJECT_DIR: projectDir, HOME: root }), cwd: root });
			let out = "";
			let err = "";
			child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
			child.stderr.setEncoding("utf8").on("data", (chunk: string) => (err += chunk));
			const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
			const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
			send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
			send({ jsonrpc: "2.0", method: "notifications/initialized" });
			send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
			send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search", arguments: { query: "garden-plants" } } });
			child.stdin.end();
			expect(await exited).toBe(0);
			return { replies: new Map(out.trim().split("\n").map((line) => JSON.parse(line)).map((reply) => [reply.id, reply])), err };
		};
		// The server's parent (this test) records the process's decision, and for an agent its host record; each case below
		// is a new Claude Code process, so the last one's decision and record go first, as its SessionEnd would take them.
		// (A recorded host is an agent's session: a server it starts again only reads its decision.)
		const ended = () => forgetProcess(config, process.pid);
		const inAgent = (await session(join(root, "agent-Atlas"))).replies;
		expect(inAgent.get(2).result.tools.map((tool: { name: string }) => tool.name)).toEqual(["zoom", "date", "search"]);
		expect(inAgent.get(3).result.content[0].text).toContain("#0 2026-02-10 user");
		ended();
		const outside = await session(join(root, "plain"));
		expect(outside.replies.get(2).result.tools).toEqual([]);
		expect(outside.replies.get(3).result.isError).toBe(true);
		expect(outside.err).toBe("");
		ended();
		// ORRERY_AGENT names the agent wherever Claude Code runs; one that names no agent serves none, in an agent folder too.
		const named = await session(join(root, "plain"), { ORRERY_CONFIG: configPath, ORRERY_AGENT: "Atlas" });
		expect(named.replies.get(2).result.tools.map((tool: { name: string }) => tool.name)).toEqual(["zoom", "date", "search"]);
		expect(named.replies.get(3).result.content[0].text).toContain("#0 2026-02-10 user");
		ended();
		expect((await session(join(root, "agent-Atlas"), { ORRERY_CONFIG: configPath, ORRERY_AGENT: "Nobody" })).replies.get(2).result.tools).toEqual([]);
		ended();
		// With a token, only the Claude Code that claimed it is the agent: the server's parent (Claude Code starts it), not
		// CLAUDE_PID, which a claude started from an agent's Bash inherits from the agent.
		const token = newToken();
		expect(claimToken(join(root, "data", "agents", "Atlas"), token, process.pid)).toBe(true);
		const asAgent = { ORRERY_CONFIG: configPath, ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: token };
		expect((await session(join(root, "plain"), { ...asAgent, CLAUDE_PID: String(process.ppid) })).replies.get(2).result.tools).toHaveLength(3);
		ended();
		expect((await session(join(root, "plain"), { ...asAgent, CLAUDE_PID: String(process.pid) }, true)).replies.get(2).result.tools).toEqual([]);
		// In another agent's folder set up the file way (its CLAUDE.md loads that agent's view), the agent is refused.
		writeSetupMarker(join(root, "data", "agents", "Birch"), join(root, "agent-Birch"), "CLAUDE.md");
		expect((await session(join(root, "agent-Birch"), { ORRERY_CONFIG: configPath, ORRERY_AGENT: "Atlas" })).replies.get(2).result.tools).toEqual([]);
		ended();
		expect((await session(join(root, "agent-Birch"))).replies.get(2).result.tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining(["zoom", "date", "search"]));
		// No config anywhere: quiet, no tools.
		if (!existsSync("/etc/orrery/config.toml")) expect((await session(join(root, "agent-Atlas"), {})).replies.get(2).result.tools).toEqual([]);
	});

	it("serves no tools in a Claude Code started inside an agent's session, in an agent's folder too (spec 2026-10-18-agent-permissions §3b)", { timeout: 60_000 }, async () => {
		const { root, config, configPath } = world();
		seedAtlas(root);
		// The server's parent (this test) stands for the Claude Code; its parent hosts Birch's pi session.
		expect(recordSession(config.dataDir, { agent: "Birch", tool: "pi", pid: process.ppid })).toBe(true);
		try {
			const c = cliCommand(["mcp"]);
			const child = spawn(c.cmd, c.args, { env: cleanEnv({ ORRERY_CONFIG: configPath, CLAUDE_PROJECT_DIR: join(root, "agent-Atlas"), HOME: root }), cwd: root });
			let out = "";
			child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
			const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
			child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search", arguments: { query: "garden-plants" } } })}\n`);
			expect(await exited).toBe(0);
			const replies = new Map(out.trim().split("\n").map((line) => JSON.parse(line)).map((reply) => [reply.id, reply]));
			expect(replies.get(2).result.tools).toEqual([]);
			expect(replies.get(3).result.isError).toBe(true);
			// The process's decision, which its hooks read.
			expect(JSON.parse(readFileSync(join(config.dataDir, "claude-processes", `${process.pid}.json`), "utf8"))).toMatchObject({ kind: "nested", outer: "Birch", tool: "pi" });
		} finally {
			forgetSession(config.dataDir, process.ppid);
			forgetProcess(config, process.pid);
		}
	});

	it("inside an agent's session serves only that agent: another ORRERY_AGENT is refused, another folder gets no tools and changes no record (spec 2026-10-18-agent-permissions §3)", { timeout: 60_000 }, async () => {
		const { root, config, configPath } = world();
		seedAtlas(root);
		// This test process stands for Atlas's Claude Code, decided by its folder: its MCP server's parent, recorded as its host.
		expect(claudeSession(config, { env: {}, cwd: join(root, "agent-Atlas"), pid: process.pid, decide: true })).toMatchObject({ kind: "agent", agent: { name: "Atlas" } });
		try {
			/** `orrery mcp` with this test as its parent: Claude Code's own server, or the agent's shell exec'ing one. */
			const run = async (env: Record<string, string>, projectDir: string) => {
				const c = cliCommand(["mcp"]);
				const child = spawn(c.cmd, c.args, { env: cleanEnv({ ORRERY_CONFIG: configPath, ...env, CLAUDE_PROJECT_DIR: projectDir, HOME: root }), cwd: root });
				let out = "";
				let err = "";
				child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
				child.stderr.setEncoding("utf8").on("data", (chunk: string) => (err += chunk));
				const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
				child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
				const code = await exited;
				const tools = out.trim() === "" ? undefined : (JSON.parse(out.trim()).result.tools as { name: string }[]).map((tool) => tool.name);
				return { code, tools, err };
			};
			expect(await run({ ORRERY_AGENT: "Birch" }, join(root, "agent-Atlas"))).toEqual({ code: 1, tools: undefined, err: "orrery mcp serves only this session's agent, Atlas, not Birch.\n" });
			// In Birch's folder: Birch's pick is no session's, so no tools, and the session stays Atlas's.
			expect(await run({}, join(root, "agent-Birch"))).toEqual({ code: 0, tools: [], err: "" });
			expect(liveSession(config.dataDir, process.pid)).toMatchObject({ agent: "Atlas", tool: "claude-code" });
			// Its own server, restarted: Atlas's tools, as before.
			expect(await run({}, join(root, "agent-Atlas"))).toEqual({ code: 0, tools: ["zoom", "date", "search"], err: "" });
		} finally {
			forgetProcess(config, process.pid);
		}
	});

	it("serves no tools to a Claude Code a SessionStart found unconfirmed, even once its start can be read", { timeout: 60_000 }, async () => {
		const { root, config, configPath } = world();
		seedAtlas(root);
		const atlas = config.agents.get("Atlas")!;
		/** `orrery mcp` with this test as its parent (the Claude Code), in Atlas's folder, and the tools it serves. */
		const served = async () => {
			const c = cliCommand(["mcp"]);
			const child = spawn(c.cmd, c.args, { env: cleanEnv({ ORRERY_CONFIG: configPath, CLAUDE_PROJECT_DIR: join(root, "agent-Atlas"), HOME: root }), cwd: root });
			let out = "";
			child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
			const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
			child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
			expect(await exited).toBe(0);
			return (JSON.parse(out.trim()).result.tools as { name: string }[]).map((tool) => tool.name);
		};
		try {
			expect(await served()).toEqual(["zoom", "date", "search"]);
			forgetProcess(config, process.pid);
			// Its SessionStart marked a session read-only as unconfirmed (src/claude/hooks.ts markUnconfirmed).
			const session = "33333333-3333-4333-8333-333333333333";
			const mark = { mode: "read-only" as const, pid: process.pid, claudePid: process.pid, nonce: "u", since: Date.now(), reason: UNCONFIRMED_NOTICE };
			writeMode(atlas.dir, session, mark);
			expect(await served()).toEqual([]);
			forgetProcess(config, process.pid);
			// Another Claude Code's mark is not this one's.
			writeMode(atlas.dir, session, { ...mark, claudePid: process.ppid });
			expect(await served()).toEqual(["zoom", "date", "search"]);
			forgetProcess(config, process.pid);
			// Nor is one made before this Claude Code started: a gone one's, whose pid this one reuses.
			writeMode(atlas.dir, session, { ...mark, since: (processStartedAt(process.pid) as number) - 60_000 });
			expect(await served()).toEqual(["zoom", "date", "search"]);
		} finally {
			forgetProcess(config, process.pid);
		}
	});

	it("shares one decision per Claude Code process with the hooks: a restarted server, and a SessionStart before or after it, keep the first pick after the agent died", { timeout: 60_000 }, async () => {
		const { root, config, configPath } = world();
		seedAtlas(root);
		const plain = join(root, "plain");
		/** `orrery mcp` started by this test (its parent: the Claude Code process), and the tools it serves. */
		const served = async (env: Record<string, string>) => {
			const c = cliCommand(["mcp"]);
			const child = spawn(c.cmd, c.args, { env: cleanEnv({ ...env, CLAUDE_PROJECT_DIR: plain, HOME: root }), cwd: root });
			let out = "";
			child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
			const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
			child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
			expect(await exited).toBe(0);
			return (JSON.parse(out.trim()).result.tools as { name: string }[]).map((tool) => tool.name);
		};
		/** This process's SessionStart hook, in-process, as Claude Code (CLAUDE_PID: this test) runs it. */
		const sessionStart = (env: Record<string, string>) =>
			runHook("session-start", JSON.stringify({ session_id: "s1", cwd: plain, source: "startup" }), {
				config,
				env: { ...env, CLAUDE_PROJECT_DIR: plain },
				claudePid: process.pid,
				// On its stdin's other end: its Claude Code (src/claude/peer.ts).
				peer: () => process.pid,
				startHolder: () => {},
				modeWaitMs: 200,
				home: join(root, "home"),
			});
		/** The agent's Claude Code: a live process holding a new token's claim. */
		const agent = () => {
			const sleeper = spawn("sleep", ["120"], { stdio: "ignore" });
			const token = newToken();
			expect(claimToken(join(root, "data", "agents", "Atlas"), token, sleeper.pid as number)).toBe(true);
			const gone = async () => {
				sleeper.kill();
				await once(sleeper, "exit");
			};
			return { env: { ORRERY_CONFIG: configPath, ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: token }, gone };
		};
		// The server first: the agent lives, so this Claude Code was started inside its session (its variables, the token
		// another live process claimed). After the agent's exit, a restarted server and a SessionStart of the same process
		// read that decision; neither takes the dead claim over.
		const nested = JSON.stringify({ systemMessage: "Orrery: started inside Atlas's session, so this one opens no memory and records nothing." });
		const first = agent();
		expect(await served(first.env)).toEqual([]);
		await first.gone();
		expect(await served(first.env)).toEqual([]);
		expect(await sessionStart(first.env)).toBe(nested);
		rmSync(join(config.dataDir, "claude-processes", `${process.pid}.json`), { force: true });
		// SessionStart first: the server started after the agent's exit reads its decision.
		const second = agent();
		expect(await sessionStart(second.env)).toBe(nested);
		await second.gone();
		expect(await served(second.env)).toEqual([]);
		rmSync(join(config.dataDir, "claude-processes", `${process.pid}.json`), { force: true });
	});
});

describe("the memory tools in Grok Build (spec 2026-10-29-grok-build)", () => {
	/** `orrery mcp [args]`, run by `launch` (default: this test), in `cwd` (default `root`): its exit, the tool names it lists, a search's text, and stderr. */
	const serve = async (root: string, args: string[], env: Record<string, string>, launch: (cmd: string, args: string[]) => [string, string[]] = (cmd, rest) => [cmd, rest], cwd = root) => {
		const c = cliCommand(["mcp", ...args]);
		const [cmd, rest] = launch(c.cmd, c.args);
		const child = spawn(cmd, rest, { env: cleanEnv({ HOME: root, ...env }), cwd });
		let out = "";
		let err = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => (err += chunk));
		const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
		child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search", arguments: { query: "garden-plants" } } })}\n`);
		const code = await exited;
		const replies = new Map(out.trim().split("\n").filter((line) => line !== "").map((line) => JSON.parse(line)).map((reply) => [reply.id, reply]));
		return { code, tools: (replies.get(2)?.result?.tools as { name: string }[] | undefined)?.map((tool) => tool.name), found: replies.get(3)?.result?.content?.[0]?.text as string | undefined, err };
	};

	it("`mcp --tool claude-code` under Grok lists no tools: Grok loads the plugin's server too, and Orrery's own serves Grok", { timeout: 60_000 }, async () => {
		const { root, config, configPath } = world();
		seedAtlas(root);
		const token = newToken();
		// What would serve Atlas anywhere else: its token, its folder.
		const env = { ORRERY_CONFIG: configPath, ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: token, CLAUDE_PROJECT_DIR: join(root, "agent-Atlas") };
		for (const args of [[], ["--tool", "claude-code"]]) {
			const served = await serve(root, args, env, grokLaunch);
			expect(served.code, served.err).toBe(0);
			expect([served.tools, served.err]).toEqual([[], ""]);
		}
		// Nothing decided or claimed for the Grok, so its own server takes the token.
		expect(existsSync(join(config.dataDir, "claude-processes"))).toBe(false);
		expect(existsSync(join(root, "data", "agents", "Atlas", "claims", token))).toBe(false);
	});

	it("`mcp --tool grok` serves the agent named by ORRERY_AGENT and a valid token, and the plain window's none without one", { timeout: 60_000 }, async () => {
		const { root, config, configPath } = world();
		seedAtlas(root);
		// A Grok stand-in, started with the launch's environment, starts the server (each case a new one).
		const ended = () => rmSync(join(config.dataDir, "grok-processes"), { recursive: true, force: true });
		const token = newToken();
		const agent = await serve(root, ["--tool", "grok"], { ORRERY_CONFIG: configPath, ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: token }, grokLaunch);
		expect([agent.code, agent.tools]).toEqual([0, ["zoom", "date", "search"]]);
		expect(agent.found).toContain("#0 2026-02-10 user");
		// The token is that Grok's now (gone since): not this test's, nor the server's.
		const claimant = claimedBy(join(root, "data", "agents", "Atlas"), token);
		expect(claimant).toBeDefined();
		expect(claimant).not.toBe(process.pid);
		ended();
		// A plain window: no ORRERY_AGENT (Grok expands the config's ${ORRERY_AGENT:-} to nothing), in Atlas's folder too.
		for (const env of [{ ORRERY_AGENT: "", ORRERY_AGENT_TOKEN: "" }, {}] as Record<string, string>[]) {
			const plain = await serve(join(root, "agent-Atlas"), ["--tool", "grok"], { ORRERY_CONFIG: configPath, CLAUDE_PROJECT_DIR: join(root, "agent-Atlas"), ...env }, grokLaunch, join(root, "agent-Atlas"));
			expect([plain.code, plain.tools]).toEqual([0, []]);
			// A plain grok decides nothing for its process, as its hooks don't (src/grok/hooks.ts).
			expect(existsSync(join(config.dataDir, "grok-processes"))).toBe(false);
			ended();
		}
		// ORRERY_AGENT without a token, or with one another live process claimed: no memory.
		const other = newToken();
		const sleeper = spawn("sleep", ["60"], { stdio: "ignore" });
		try {
			expect(claimToken(join(root, "data", "agents", "Atlas"), other, sleeper.pid as number)).toBe(true);
			for (const env of [{ ORRERY_AGENT: "Atlas" }, { ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: "not-a-token" }, { ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: other }] as Record<string, string>[]) {
				const refused = await serve(root, ["--tool", "grok"], { ORRERY_CONFIG: configPath, ...env }, grokLaunch);
				expect([JSON.stringify(env), refused.code, refused.tools]).toEqual([JSON.stringify(env), 0, []]);
				ended();
			}
		} finally {
			sleeper.kill();
		}
		// No config at all: quiet, no tools.
		if (!existsSync("/etc/orrery/config.toml")) expect(await serve(root, ["--tool", "grok"], { ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: newToken() })).toMatchObject({ code: 0, tools: [] });
	});

	it("`mcp --tool grok` started by Grok's shared leader (leader mode) serves no tools and decides and claims nothing, whatever agent and token it is given", { timeout: 60_000 }, async () => {
		const { root, config, configPath } = world();
		seedAtlas(root);
		const token = newToken();
		// The leader starts every session's server: Grok gives each one its own client's ORRERY_AGENT and token. Leader
		// mode's, and one `grok worker start` runs in its own process.
		for (const launch of [grokLeaderLaunch, grokWorkerLaunch]) {
			const served = await serve(root, ["--tool", "grok"], { ORRERY_CONFIG: configPath, ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: token }, launch, grokLeaderFolder());
			expect([launch.name, served.code, served.tools]).toEqual([launch.name, 0, []]);
			expect(served.err).toBe("Orrery: Grok runs this session's hooks and memory tools in its shared leader process (leader mode), where one session's agent can't be told from another's; Orrery opens its agents with --no-leader. This session records nothing and gets no memory tools.\n");
			expect(existsSync(join(config.dataDir, "grok-processes"))).toBe(false);
			expect(claimedBy(join(root, "data", "agents", "Atlas"), token)).toBeUndefined();
		}
		// The same server started by a session's own grok serves Atlas.
		expect((await serve(root, ["--tool", "grok"], { ORRERY_CONFIG: configPath, ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: token }, grokLaunch)).tools).toEqual(["zoom", "date", "search"]);
	});

	it("`mcp --tool grok` takes the agent and token its Grok was started with: a server whose own name another agent or token serves nothing and claims nothing", { timeout: 60_000 }, async () => {
		const { root, config, configPath } = world();
		seedAtlas(root);
		const token = newToken();
		const fresh = newToken();
		// Atlas's Grok (a stand-in started with Atlas's launch variables); a server its shell starts as Birch, with a fresh
		// token, or with Atlas and another token, or with none: run through env, which execs it, so the Grok is still its
		// parent.
		const launch = { ORRERY_CONFIG: configPath, ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: token };
		for (const own of [["ORRERY_AGENT=Birch", `ORRERY_AGENT_TOKEN=${fresh}`], ["ORRERY_AGENT=Atlas", `ORRERY_AGENT_TOKEN=${fresh}`], ["-u", "ORRERY_AGENT", "-u", "ORRERY_AGENT_TOKEN"]]) {
			const viaEnv = (cmd: string, args: string[]) => grokLaunch("/usr/bin/env", [...own, cmd, ...args]);
			const served = await serve(root, ["--tool", "grok"], launch, viaEnv);
			expect([own.join(" "), served.code, served.tools]).toEqual([own.join(" "), 0, []]);
			expect(served.err).toMatch(/^orrery: mcp serves no agent here: ORRERY_AGENT or its token isn't the one this Grok was started with\.\n$/);
			expect(claimedBy(join(root, "data", "agents", "Birch"), fresh)).toBeUndefined();
			expect(claimedBy(join(root, "data", "agents", "Atlas"), fresh)).toBeUndefined();
			expect(existsSync(join(config.dataDir, "grok-processes"))).toBe(false);
		}
		// The honest one, with the Grok's own: Atlas.
		expect((await serve(root, ["--tool", "grok"], launch, grokLaunch)).tools).toEqual(["zoom", "date", "search"]);
	});
});
