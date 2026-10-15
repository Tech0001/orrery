import { rmSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, type EntryRecord, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore, MemoryView } from "../../src/memory/index.ts";
import { CURSOR_KEY, Projector, projectEntry } from "../../src/agent/projector.ts";
import { ctx, fauxModels, tempDir } from "./support.ts";

const T = Date.UTC(2026, 9, 5, 12);
const usage = { input: 5, output: 2, cacheRead: 3, cacheWrite: 1, totalTokens: 11, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const entry = (id: number, kind: string, model: unknown[]): EntryRecord => ({ id, conversationId: 1, kind, model }) as unknown as EntryRecord;
const assistant = (content: unknown[], stopReason = "stop") => ({ role: "assistant", content, api: "x", provider: "p", model: "m", usage, stopReason, timestamp: T });

describe("projectEntry", () => {
	it("maps user, assistant text/tool calls and tool results; never thinking", () => {
		expect(projectEntry(entry(1, "pi.user", [{ role: "user", content: "hello", timestamp: T }]), 100).messages).toEqual([
			{ kind: "user", text: "hello", date: expect.stringMatching(/^2026-10-05T/) },
		]);
		const a = projectEntry(
			entry(2, "pi.assistant", [
				assistant(
					[
						{ type: "thinking", thinking: "secret" },
						{ type: "text", text: "Let me check" },
						{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
						{ type: "text", text: "done" },
					],
					"toolUse",
				),
			]),
			100,
		);
		expect(a.messages.map((m) => [m.kind, m.text])).toEqual([
			["talk", "Let me check"],
			["tool", 'bash {"command":"ls"}'],
			["talk", "done"],
		]);
		expect(a.usage).toEqual([{ at: expect.any(String), role: "agent", model: "p/m", input: 5, cacheRead: 3, cacheWrite: 1, output: 2, ok: true }]);
		const result = projectEntry(
			entry(3, "pi.tool-result", [{ role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "x".repeat(200) }], isError: false, timestamp: T }]),
			60,
		);
		expect(result.messages[0].kind).toBe("echo");
		expect(result.messages[0].text).toMatch(/characters omitted/);
	});

	it("records usage but no memory for failed attempts, and ignores bookkeeping entries", () => {
		const failed = projectEntry(entry(4, "pi.assistant", [assistant([{ type: "text", text: "partial" }], "error")]), 100);
		expect(failed.messages).toEqual([]);
		expect(failed.usage[0].ok).toBe(false);
		expect(projectEntry(entry(5, "pi.system", [{ role: "system", content: "", timestamp: T }]), 100)).toEqual({ messages: [], usage: [] });
		expect(projectEntry(entry(6, "pi.reset", []), 100)).toEqual({ messages: [], usage: [] });
	});
});

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("Projector", () => {
	it("logs a run exactly once, in order, and resumes from its cursor", async () => {
		const dir = tempDir("orrery-projector-");
		dirs.push(dir);
		const { chat, models } = fauxModels();
		const registry = createRegistry();
		registry.install(
			defineExtension({
				name: "t",
				tools: [defineTool({ name: "probe", description: "probe", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "probe ok" }] }) })],
			}),
		);
		chat.setResponses([fauxAssistantMessage(fauxToolCall("probe", {}, { id: "p1" }), { stopReason: "toolUse" }), fauxAssistantMessage("all done")]);
		const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
		const root = await harness.root(ctx, { agent: { model: { provider: "faux-agent", modelId: "faux-1" } } });
		const store = MemoryStore.open(join(dir, "memory.sqlite"));
		const view = new MemoryView(store);
		const projector = new Projector(root, view, { toolCap: 30_000, context: ctx, report: () => {} });
		projector.start(harness);
		await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
		await projector.drain();
		const expected = ["user: go", "tool: probe {}", "echo: probe ok", "talk: all done"];
		expect(store.root.map((m) => `${m.kind}: ${m.text}`)).toEqual(expected);
		expect(Number(store.getMeta(CURSOR_KEY))).toBeGreaterThan(0);
		expect(store.usageRows().filter((r) => r.role === "agent")).toHaveLength(2);

		await projector.drain();
		const again = new Projector(root, view, { toolCap: 30_000, context: ctx, report: () => {} });
		await again.drain();
		expect(store.root.map((m) => `${m.kind}: ${m.text}`)).toEqual(expected);
		await projector.stop();
		await harness.close(ctx);
		store.close();
	});
});
