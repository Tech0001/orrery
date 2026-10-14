import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { LaneViewDoc, memoryExtension, memoryTools, systemFirst } from "../../src/lane/extension.ts";
import { MASTER, MemoryStore, MemoryView } from "../../src/memory/index.ts";
import { contextLines, ctx, fauxModels, tempDir } from "./support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sys = { role: "system", content: "", timestamp: 1 } as Message;
const user = (t: string) => ({ role: "user", content: t, timestamp: 1 }) as Message;
const asst = { role: "assistant", content: [], timestamp: 1 } as unknown as Message;

describe("systemFirst", () => {
	it("moves the run's leading system messages before the first user message", () => {
		expect(systemFirst([user("a"), sys, asst, user("b")])).toEqual([sys, user("a"), asst, user("b")]);
		const already = [sys, user("a")];
		expect(systemFirst(already)).toBe(already);
		const noSystem = [user("a"), asst];
		expect(systemFirst(noSystem)).toBe(noSystem);
	});
});

describe("memoryExtension", () => {
	it("sends system prompt, instructions and view first, then the user message, and serves zoom", async () => {
		const dir = tempDir("orrery-ext-");
		dirs.push(dir);
		const store = MemoryStore.open(join(dir, "memory.sqlite"));
		const view = new MemoryView(store);
		view.append("user", "remember Cedar");
		const { chat, models } = fauxModels();
		const requests: string[][] = [];
		chat.setResponses([
			(context) => {
				requests.push(contextLines(context));
				return fauxAssistantMessage(fauxToolCall("zoom", { id: 0, n: 1 }, { id: "z" }), { stopReason: "toolUse" });
			},
			(context) => {
				requests.push(contextLines(context));
				return fauxAssistantMessage("Cedar it is");
			},
		]);
		const registry = createRegistry();
		registry.install(memoryExtension({ view, instructions: () => "LANE RULES" }));
		const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
		const root = await harness.root(ctx, { agent: { model: { provider: "faux-agent", modelId: "faux-1" } } });
		await root.commit(async (tx) => {
			(await tx.doc(LaneViewDoc, root.id)).text = "<chat>\n0+1|user: remember Cedar\n</chat>";
		}, ctx);
		await (await root.submit({ type: "input", content: "what codename?" }, ctx)).wait(ctx);

		const first = requests[0];
		expect(first[0].startsWith("system:")).toBe(true);
		expect(first[0]).toContain(MASTER.slice(0, 40));
		expect(first[0]).toContain("LANE RULES");
		expect(first[0]).toContain("0+1|user: remember Cedar");
		expect(first[0].indexOf("LANE RULES")).toBeLessThan(first[0].indexOf("0+1|user: remember Cedar"));
		expect(first[1]).toBe("user:what codename?");
		expect(requests[1].at(-1)).toBe("toolResult:0+0|user: remember Cedar");
		await harness.close(ctx);
		store.close();
	});

	it("declares zoom and date as replay-safe", () => {
		const dir = tempDir("orrery-ext-");
		dirs.push(dir);
		const store = MemoryStore.open(join(dir, "memory.sqlite"));
		const tools = memoryTools(new MemoryView(store));
		expect(tools.map((t) => [t.name, t.replay])).toEqual([
			["zoom", "safe"],
			["date", "safe"],
		]);
		store.close();
	});
});
