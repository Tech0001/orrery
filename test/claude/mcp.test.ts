import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { handleMessage, laneTools, MAX_LINE_CHARS, runMcp } from "../../src/claude/mcp.ts";
import { MemoryStore } from "../../src/memory/index.ts";
import type { LaneTool } from "../../src/lane/memory-tools.ts";
import { seedAtlas } from "../lane/support.ts";
import { cleanup, pi, world } from "../pi/world.ts";
import { cleanEnv, cliCommand } from "./support.ts";

afterEach(cleanup);

// biome-ignore lint/suspicious/noExplicitAny: JSON-RPC replies are checked field by field.
const call = (tools: readonly LaneTool[], method: string, params: object = {}): any => JSON.parse(JSON.stringify(handleMessage({ jsonrpc: "2.0", id: 1, method, params }, tools)));

/** Feeds `chunks` to runMcp on a stream and returns the lines it printed. */
async function serve(chunks: string[], tools: readonly LaneTool[] = []): Promise<string[]> {
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

	it("lists the lane's tools as JSON Schema, long ones with Claude Code's inline-size hint, reader tools only for readers", () => {
		const { config } = world();
		const atlas = call(laneTools(config, config.lanes.get("Atlas")!), "tools/list").result.tools;
		expect(atlas.map((tool: { name: string }) => tool.name)).toEqual(["zoom", "date", "search"]);
		expect(atlas[0]).toEqual({
			name: "zoom",
			description: expect.any(String),
			inputSchema: { type: "object", required: ["id", "n"], properties: { id: { type: "integer" }, n: { type: "integer" } } },
			_meta: { "anthropic/maxResultSizeChars": 300_000 },
		});
		expect(atlas[1]._meta).toBeUndefined();
		const birch = call(laneTools(config, config.lanes.get("Birch")!), "tools/list").result.tools;
		expect(birch.map((tool: { name: string }) => tool.name)).toEqual(["zoom", "date", "search", "lanes", "lane_memory"]);
		expect(birch[4]._meta).toEqual({ "anthropic/maxResultSizeChars": 300_000 });
	});

	it("returns what pi's tools return, from a read-only snapshot taken while pi holds the lane", async () => {
		const { root, config } = world();
		seedAtlas(root);
		const run = await pi(root, join(root, "agent-Atlas"), config);
		const tools = laneTools(config, config.lanes.get("Atlas")!);
		const cases: Array<[string, object]> = [["zoom", { id: 0, n: 1 }], ["date", { id: 1 }], ["search", { query: "garden-plants" }]];
		for (const [name, params] of cases) {
			const viaPi = (await run.tool(name)!.execute("x", params)).content.map((c) => c.text ?? "").join("");
			expect(call(tools, "tools/call", { name, arguments: params }).result).toEqual({ content: [{ type: "text", text: viaPi }] });
		}
	});

	it("reports bad arguments, unknown tools and failed reads as tool errors, not protocol errors", () => {
		const { config } = world();
		const tools = laneTools(config, config.lanes.get("Birch")!);
		const bad = call(tools, "tools/call", { name: "zoom", arguments: { id: "x", n: 1 } }).result;
		expect(bad.isError).toBe(true);
		expect(bad.content[0].text).toMatch(/^Invalid arguments for zoom: \/id must be integer/);
		expect(call(tools, "tools/call", { name: "nope", arguments: {} }).result).toEqual({ content: [{ type: "text", text: "No tool nope" }], isError: true });
		expect(call(tools, "tools/call", { name: "lane_memory", arguments: { lane: "Birch", action: "view" } }).result).toEqual({
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
		mkdirSync(join(root, "data", "lanes", "Atlas"), { recursive: true });
		const store = MemoryStore.open(join(root, "data", "lanes", "Atlas", "memory.sqlite"));
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

	it("runs over stdio as `orrery mcp`, finds the lane from CLAUDE_PROJECT_DIR, and serves no tools outside a lane", { timeout: 60_000 }, async () => {
		const { root, configPath } = world();
		seedAtlas(root);
		const session = async (projectDir: string, env: Record<string, string> = { ORRERY_CONFIG: configPath }) => {
			const c = cliCommand(["mcp"]);
			const child = spawn(c.cmd, c.args, { env: cleanEnv({ ...env, CLAUDE_PROJECT_DIR: projectDir, HOME: root }), cwd: root });
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
		const inLane = (await session(join(root, "agent-Atlas"))).replies;
		expect(inLane.get(2).result.tools.map((tool: { name: string }) => tool.name)).toEqual(["zoom", "date", "search"]);
		expect(inLane.get(3).result.content[0].text).toContain("#0 2026-02-10 user");
		const outside = await session(join(root, "plain"));
		expect(outside.replies.get(2).result.tools).toEqual([]);
		expect(outside.replies.get(3).result.isError).toBe(true);
		expect(outside.err).toBe("");
		// No config anywhere: quiet, no tools.
		if (!existsSync("/etc/orrery/config.toml")) expect((await session(join(root, "agent-Atlas"), {})).replies.get(2).result.tools).toEqual([]);
	});
});
