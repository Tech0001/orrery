import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../../src/lane/config.ts";
import { compactorReport, LaneHeld, MemoryLane } from "../../src/lane/memory-lane.ts";
import { laneModelSource } from "../../src/lane/model-source.ts";
import { fauxModels, laneConfigToml, tempDir } from "./support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("MemoryLane", () => {
	it("opens on Orrery's own logins, summarizes, says which agent holds it, and keeps a second writer out", async () => {
		const dir = tempDir("orrery-memory-lane-");
		dirs.push(dir);
		const lane = parseConfig(laneConfigToml({ dataDir: join(dir, "data"), workspace: join(dir, "ws") }), dir).lanes.get("Test")!;
		const models = laneModelSource(fauxModels().models);
		const reports: string[] = [];
		const open = MemoryLane.open({ lane, models, report: (message) => reports.push(message), agent: "claude-code" });
		try {
			open.view.append("user", `A long message ${"detail ".repeat(200)}`);
			expect(await open.view.settle(AbortSignal.timeout(10_000))).toBe(true);
			expect(open.view.render()).toContain("0+1|user: summarized");
			expect(open.store.usageRows().some((row) => row.role === "compactor" && row.model === "faux-compactor/faux-1")).toBe(true);
			open.writeStatus();
			expect(JSON.parse(readFileSync(join(lane.dir, "status.json"), "utf8"))).toMatchObject({ lane: "Test", model: "claude-code", open: true });
			expect(() => MemoryLane.open({ lane, models, report: () => {} })).toThrow(LaneHeld);
		} finally {
			await open.close();
		}
		expect(reports).toEqual([]);
		const again = MemoryLane.open({ lane, models, report: () => {} });
		again.writeStatus();
		expect(JSON.parse(readFileSync(join(lane.dir, "status.json"), "utf8")).model).toBe("pi");
		await again.close();
	});

	it("words a failing source plainly in the footer and status.json, and resumes on a new model without a restart", async () => {
		const dir = tempDir("orrery-memory-lane-");
		dirs.push(dir);
		const config = parseConfig(
			laneConfigToml({ dataDir: join(dir, "data"), workspace: join(dir, "ws"), extra: "retry_seconds = 1" }),
			dir,
		).lanes.get("Test")!;
		const failing = fauxProvider({ provider: "faux-broke" });
		failing.setResponses([]);
		const working = fauxProvider({ provider: "faux-ok" });
		working.setResponses(Array.from({ length: 50 }, () => fauxAssistantMessage("user: summarized")));
		const models = createModels();
		models.setProvider(failing.provider);
		models.setProvider(working.provider);
		const reports: string[] = [];
		const lane = MemoryLane.open({ lane: config, models: laneModelSource(models), report: (message) => reports.push(message) });
		lane.setCompactorModel({ provider: "faux-broke", modelId: "faux-1", thinking: "off" });
		lane.view.append("user", `A long message ${"detail ".repeat(200)}`);
		try {
			await vi.waitFor(() => expect(lane.summaryTrouble()?.state).toBe("failing"), { timeout: 5000 });
			// The raw per-part retry line stays out of the lane's report; the state notices tell the user.
			expect(reports.filter((r) => /^Compactor |retrying every|faux responses/.test(r))).toEqual([]);
			expect(lane.statusLine()).toMatch(/^Orrery · Test · 1 msgs · SUMMARIES FAILING: .+ · \/compactor$/);
			lane.writeStatus();
			const status = JSON.parse(readFileSync(join(config.dir, "status.json"), "utf8"));
			expect(status.trouble).toEqual({ state: "failing", plain: expect.any(String) });
			expect(status.trouble.plain.length).toBeGreaterThan(0);
			expect(status.lastError).toBe(status.trouble.plain);
			lane.setCompactorModel({ provider: "faux-ok", modelId: "faux-1", thinking: "off" });
			await vi.waitFor(() => expect(lane.view.settled).toBe(true), { timeout: 5000 });
			expect(lane.summaryTrouble()).toBeUndefined();
		} finally {
			await lane.close();
		}
	});

	it("drops the compactor's per-part retry lines and cleans what else it reports", () => {
		const reports: string[] = [];
		const report = compactorReport((message) => reports.push(message));
		const key = "sk-ant-" + "api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
		report(`Compactor 0+1: 401 \u001b[31mbad key ${key}\u001b[0m; retrying every 30s`);
		report(`Compactor 8+8: first line\nsecond line; retrying every 1.5s`);
		report(`Compactor stopped: \u001b]0;title\u0007disk full near ${key}`);
		report("Orrery: Test: summaries are off: unknown model x/y.");
		expect(reports).toHaveLength(2);
		expect(reports[0]).toMatch(/^Compactor stopped: /);
		expect(reports[0]).toContain("disk full");
		for (const line of reports) {
			expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
			expect(line).not.toContain("AAAAAAAAAAAA");
		}
		expect(reports[1]).toBe("Orrery: Test: summaries are off: unknown model x/y.");
	});
});
