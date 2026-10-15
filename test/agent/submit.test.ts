import { rmSync } from "node:fs";
import { join } from "node:path";
import { type AssistantMessage, Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, type FauxResponseFactory, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { memoryExtension } from "../../src/agent/extension.ts";
import { agentSubmit, type SubmitDeps } from "../../src/agent/submit.ts";
import { MemoryStore, MemoryView } from "../../src/memory/index.ts";
import { contextLines, ctx, fauxModels, tempDir } from "./support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function deferred() {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

async function setup(settings: Record<string, unknown> = {}) {
	const dir = tempDir("orrery-submit-");
	dirs.push(dir);
	const store = MemoryStore.open(join(dir, "memory.sqlite"));
	const view = new MemoryView(store);
	const { chat, models } = fauxModels();
	const gate = deferred();
	const running = deferred();
	const registry = createRegistry();
	registry.install(memoryExtension({ view, instructions: () => "" }));
	registry.install(
		defineExtension({
			name: "hold",
			tools: [
				defineTool({
					name: "hold",
					description: "hold",
					parameters: Type.Object({}),
					execute: async () => {
						running.resolve();
						await gate.promise;
						return { content: [{ type: "text", text: "held" }] };
					},
				}),
			],
		}),
	);
	const harness = await Harness.open(new MemoryStorage(), { models, registry, settings }, ctx);
	const conversation = await harness.root(ctx, { agent: { model: { provider: "faux-agent", modelId: "faux-1" } } });
	let views = 0;
	const deps: SubmitDeps = { harness, conversation, context: ctx, renderView: async () => `<chat>\nVIEW@${++views}\n</chat>` };
	return { chat, harness, conversation, deps, gate, running, store };
}

describe("agentSubmit", () => {
	it("starts each idle run fresh from the view and steers input into a busy run", async () => {
		const { chat, harness, deps, gate, running, store } = await setup();
		const seen: string[][] = [];
		const record =
			(reply: AssistantMessage): FauxResponseFactory =>
			(context) => {
				seen.push(contextLines(context));
				return reply;
			};
		chat.setResponses([
			record(fauxAssistantMessage(fauxToolCall("hold", {}, { id: "h1" }), { stopReason: "toolUse" })),
			record(fauxAssistantMessage("answer one")),
			record(fauxAssistantMessage("answer two")),
		]);
		const a = await agentSubmit(deps, "task one", "r1");
		expect(a?.mode).toBe("run");
		await running.promise;
		const b = await agentSubmit(deps, "also X", "r2");
		expect(b?.mode).toBe("steer");
		gate.resolve();
		expect((await a?.submission.wait(ctx))?.status).toBe("done");
		expect((await b?.submission.wait(ctx))?.status).toBe("done");
		const c = await agentSubmit(deps, "task two", "r3");
		expect(c?.mode).toBe("run");
		await c?.submission.wait(ctx);

		expect(seen[0][0]).toContain("VIEW@1");
		expect(seen[0][1]).toBe("user:task one");
		expect(seen[1].at(-1)).toBe("user:also X");
		expect(seen[2][0]).toContain("VIEW@2");
		expect(seen[2].slice(1)).toEqual(["user:task two"]);
		await harness.close(ctx);
		store.close();
	});

	it("returns undefined and sends nothing when the view wait is cancelled", async () => {
		const { harness, conversation, deps, store } = await setup();
		const result = await agentSubmit({ ...deps, renderView: async () => undefined }, "never", "r9");
		expect(result).toBeUndefined();
		const page = await conversation.entries({}, 10, undefined, ctx);
		expect(page.items.filter((e) => e.kind === "pi.user")).toEqual([]);
		await harness.close(ctx);
		store.close();
	});

	it("never submits the same requestId twice", async () => {
		const { chat, harness, deps, store } = await setup();
		chat.setResponses([fauxAssistantMessage("once")]);
		const first = await agentSubmit(deps, "hello", "same");
		await first?.submission.wait(ctx);
		const second = await agentSubmit(deps, "hello", "same");
		expect(second?.mode).toBe("existing");
		expect(second?.submission.id).toBe(first?.submission.id);
		await harness.close(ctx);
		store.close();
	});

	it("recovers when a failed run left a queued steer in the inbox", async () => {
		const { chat, harness, deps, store } = await setup({ retry: { enabled: false } });
		const release = deferred();
		const generating = deferred();
		chat.setResponses([
			async () => {
				generating.resolve();
				await release.promise;
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider exploded" });
			},
			fauxAssistantMessage("back on track"),
			fauxAssistantMessage("and the new message too"),
		]);
		const first = await agentSubmit(deps, "first", "e1");
		await generating.promise;
		const queued = await agentSubmit(deps, "follow-up while generating", "e2");
		expect(queued?.mode).toBe("steer");
		release.resolve();
		expect((await first?.submission.wait(ctx))?.status).toBe("unanswered");
		const next = await agentSubmit(deps, "try again", "e3");
		const settled = await Promise.race([next?.submission.wait(ctx), new Promise((r) => setTimeout(() => r("stuck"), 3000))]);
		expect(settled).not.toBe("stuck");
		expect(JSON.stringify(settled)).toContain('"status":"done"');
		expect((await queued?.submission.wait(ctx))?.status).toBe("done"); // the stranded steer is answered too
		await harness.close(ctx);
		store.close();
	});
});
