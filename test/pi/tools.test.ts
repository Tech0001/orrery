import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/memory/index.ts";
import { cleanup, close, isolatedHome, pi, world } from "./world.ts";

afterEach(cleanup);
isolatedHome();

const text = (r: { content: { text?: string }[] }) => r.content.map((c) => c.text ?? "").join("");

async function seedAtlas(root: string) {
	mkdirSync(join(root, "data", "agents", "Atlas"), { recursive: true });
	const store = MemoryStore.open(join(root, "data", "agents", "Atlas", "memory.sqlite"));
	store.appendBatch([
		{ kind: "user", text: "In February we chose garden-plants as a plant group.", date: "2026-02-10T10:00:00.000Z" },
		{ kind: "talk", text: "Noted.", date: "2026-02-10T10:01:00.000Z" },
	]);
	store.close();
}

describe("memory tools", () => {
	it("zoom, date and search read the agent's own memory", async () => {
		const { root, config } = world();
		await seedAtlas(root);
		const run = await pi(root, join(root, "agent-Atlas"), config);
		expect(text(await run.tool("zoom")!.execute("1", { id: 0, n: 1 }))).toContain("garden-plants");
		expect(text(await run.tool("date")!.execute("2", { id: 0 }))).toContain("2026-02-10");
		expect(text(await run.tool("search")!.execute("3", { query: "garden-plants" }))).toContain("#0 2026-02-10 user");
		expect(run.tool("agent_memory")).toBeUndefined();
	});

	it("lets Birch list agents and read Atlas's memory read-only, while Atlas's pi is open", async () => {
		const { root, config } = world();
		await seedAtlas(root);
		await pi(root, join(root, "agent-Atlas"), config);
		const birch = await pi(root, join(root, "agent-Birch"), config);
		const agents = text(await birch.tool("agents")!.execute("1", {}));
		expect(agents).toMatch(/Atlas: 2 messages, last 2026-02-10, open/);
		expect(text(await birch.tool("agent_memory")!.execute("2", { agent: "atlas", action: "view" }))).toContain("<chat>");
		expect(text(await birch.tool("agent_memory")!.execute("3", { agent: "Atlas", action: "search", query: "plant group" }))).toContain("#0");
		expect(text(await birch.tool("agent_memory")!.execute("4", { agent: "Atlas", action: "zoom", id: 0, n: 1 }))).toContain("garden-plants");
		await expect(birch.tool("agent_memory")!.execute("5", { agent: "Nobody", action: "view" })).rejects.toThrow(/No agent named Nobody/);
	});

	it("lists an agent as closed once its pi closed it, and survives an unreadable store", async () => {
		const { root, config } = world();
		await seedAtlas(root);
		const atlas = await pi(root, join(root, "agent-Atlas"), config);
		const birch = await pi(root, join(root, "agent-Birch"), config);
		await close(atlas);
		expect(text(await birch.tool("agents")!.execute("1", {}))).toMatch(/Atlas: 2 messages, last 2026-02-10, closed/);
		writeFileSync(join(root, "data", "agents", "Atlas", "memory.sqlite"), "not a database at all, just garbage bytes".repeat(50));
		const listing = text(await birch.tool("agents")!.execute("2", {}));
		expect(listing).toMatch(/Atlas: unreadable \(.+\)/);
		expect(listing).toContain("Birch:");
	});
});
