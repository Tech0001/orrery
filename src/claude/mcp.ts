/**
 * orrery's MCP server for Claude Code (spec §4 "Memory tools"), run as `orrery mcp` over stdio. It speaks
 * newline-delimited JSON-RPC 2.0, as Phase 0 verified.
 * - It serves the shared memory tools (src/lane/memory-tools.ts) for the lane of the project folder
 *   (CLAUDE_PROJECT_DIR, else its cwd).
 * - Each call reads a fresh read-only snapshot, so the server works while the holder or pi writes.
 * - Outside a lane it serves no tools.
 * - Long results declare _meta["anthropic/maxResultSizeChars"] in tools/list, so Claude Code keeps them inline
 *   instead of saving them to a file.
 */

import { readFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { Value } from "typebox/value";
import type { HarnessConfig, LaneConfig } from "../lane/config.ts";
import { type LaneTool, memoryTools, readerTools, withLaneView } from "../lane/memory-tools.ts";

/** Claude Code saves a result over 50,000 characters to a file unless the tool raises this; its ceiling is 500,000. */
export const LONG_RESULT_CHARS = 300_000;

/** The longest input line served (1 MB); a longer one is refused with an error instead of buffered. */
export const MAX_LINE_CHARS = 1_000_000;

const VERSION = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

/** The lane's own tools, plus the reader tools for a lane that reads others (Birch). */
export function laneTools(config: HarnessConfig, lane: LaneConfig): LaneTool[] {
	const own = memoryTools((use) => withLaneView(lane, use, config));
	return lane.reads.length > 0 ? [...own, ...readerTools(() => lane, config)] : own;
}

type Id = string | number | null;
const reply = (id: Id, result: object) => ({ jsonrpc: "2.0", id, result });
const failure = (id: Id, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
const text = (value: string, isError = false) => ({ content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) });

/** A tool as tools/list shows it. */
function describe(tool: LaneTool): object {
	return {
		name: tool.name,
		description: tool.description,
		// A typebox schema is JSON Schema already; JSON.stringify leaves out typebox's symbol keys.
		inputSchema: tool.parameters,
		...(tool.long ? { _meta: { "anthropic/maxResultSizeChars": LONG_RESULT_CHARS } } : {}),
	};
}

/** The reply to one JSON-RPC message, or undefined for a notification (a message without an id). */
export function handleMessage(message: unknown, tools: readonly LaneTool[]): object | undefined | Promise<object> {
	if (typeof message !== "object" || message === null || Array.isArray(message)) return failure(null, -32600, "Invalid request");
	const { id, method, params } = message as { id?: Id; method?: unknown; params?: unknown };
	if (id === undefined) return undefined;
	if (typeof method !== "string") return failure(id, -32600, "Invalid request");
	const p = typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
	switch (method) {
		case "initialize":
			return reply(id, {
				protocolVersion: typeof p.protocolVersion === "string" ? p.protocolVersion : "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "orrery", version: VERSION },
			});
		case "ping":
			return reply(id, {});
		case "tools/list":
			return reply(id, { tools: tools.map(describe) });
		case "tools/call": {
			const tool = tools.find((t) => t.name === p.name);
			if (typeof p.name !== "string") return reply(id, text("Invalid arguments: name must be a string", true));
			if (tool === undefined) return reply(id, text(`No tool ${p.name}`, true));
			const args = typeof p.arguments === "object" && p.arguments !== null ? (p.arguments as Record<string, unknown>) : {};
			if (!Value.Check(tool.parameters, args)) {
				const why = [...Value.Errors(tool.parameters, args)].map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ");
				return reply(id, text(`Invalid arguments for ${tool.name}: ${why}`, true));
			}
			try {
				const result = tool.run(args);
				// Keep local calls synchronous; a remote result must settle before it becomes a JSON-RPC reply.
				if (result instanceof Promise) return asyncToolReply(id, result);
				return reply(id, text(result));
			} catch (error) {
				return reply(id, text(error instanceof Error ? error.message : String(error), true));
			}
		}
		default:
			return failure(id, -32601, `Method not found: ${method}`);
	}
}

async function asyncToolReply(id: Id, result: Promise<string>): Promise<object> {
	try { return reply(id, text(await result)); }
	catch (error) { return reply(id, text(error instanceof Error ? error.message : String(error), true)); }
}

/** The reply to one input line: a parse error for bad JSON (never quoting it), else handleMessage's. */
async function handleLine(line: string, tools: readonly LaneTool[]): Promise<object | undefined> {
	let message: unknown;
	try {
		message = JSON.parse(line);
	} catch {
		return failure(null, -32700, "Parse error");
	}
	try {
		return await handleMessage(message, tools);
	} catch {
		// Whatever threw, the session keeps its tools: answer the request, quoting nothing of it.
		const id = typeof message === "object" && message !== null ? (message as { id?: unknown }).id : undefined;
		return typeof id === "string" || typeof id === "number" ? failure(id, -32603, "Internal error") : undefined;
	}
}

/**
 * Serves `tools` on newline-delimited JSON-RPC until `input` ends. A line over MAX_LINE_CHARS gets one error and is
 * dropped as it arrives, so an input that never ends a line cannot grow memory.
 */
export async function runMcp(input: NodeJS.ReadableStream, output: NodeJS.WritableStream, tools: readonly LaneTool[]): Promise<void> {
	const decoder = new StringDecoder("utf8");
	let pending = "";
	let skipping = false; // inside an over-long line, up to its newline
	const send = (response: object | undefined) => {
		if (response !== undefined) output.write(`${JSON.stringify(response)}\n`);
	};
	const take = async (piece: string, ended: boolean) => {
		let rest = piece;
		for (let newline = rest.indexOf("\n"); newline >= 0; newline = rest.indexOf("\n")) {
			const line = pending + rest.slice(0, newline);
			rest = rest.slice(newline + 1);
			pending = "";
			if (skipping) skipping = false;
			else if (line.length > MAX_LINE_CHARS) send(failure(null, -32600, "Line too long"));
			else if (line.trim()) send(await handleLine(line, tools));
		}
		if (skipping) return;
		pending += rest;
		if (pending.length > MAX_LINE_CHARS) {
			send(failure(null, -32600, "Line too long"));
			pending = "";
			skipping = true;
		} else if (ended && pending.trim()) {
			send(await handleLine(pending, tools));
			pending = "";
		}
	};
	for await (const chunk of input) await take(typeof chunk === "string" ? chunk : decoder.write(chunk as Buffer), false);
	await take(decoder.end(), true);
	// The caller may exit as soon as this returns: wait until everything written has left.
	await new Promise<void>((resolve) => output.write("", () => resolve()));
}
