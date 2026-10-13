import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compactCommand } from "../../src/cli/commands.ts";
import { parseConfig } from "../../src/lane/config.ts";
import { MemoryStore } from "../../src/memory/index.ts";
import { fauxModels, laneConfigToml, tempDir } from "../lane/support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("compactCommand", () => {
	it("builds every summary with the lane's compactor and records its usage", async () => {
		const dir = tempDir("orrery-compact-");
		dirs.push(dir);
		const config = parseConfig(laneConfigToml({ dataDir: join(dir, "data"), workspace: join(dir, "ws") }), dir);
		const laneDir = config.lanes.get("Test")!.dir;
		mkdirSync(laneDir, { recursive: true });
		const store = MemoryStore.open(join(laneDir, "memory.sqlite"));
		store.appendBatch([0, 1, 2].map((i) => ({ kind: "user" as const, text: `${i} ${"long history ".repeat(80)}` })));
		store.close();
		const { models } = fauxModels();
		await compactCommand(config, "test", models);
		const reopened = MemoryStore.openReadOnly(join(laneDir, "memory.sqlite"));
		expect(reopened.nodeCount).toBe(4);
		expect(reopened.usageRows().filter((r) => r.role === "compactor").length).toBeGreaterThan(0);
		reopened.close();
	});
});
