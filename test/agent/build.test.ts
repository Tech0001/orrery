import { EventEmitter } from "node:events";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { compactCommand } from "../../src/cli/commands.ts";
import { parseConfig } from "../../src/agent/config.ts";
import { BUILD_FILE, BUILD_STALE_MS, type BuildState, buildRunning, readBuild, startBuild, writeBuild } from "../../src/agent/build.ts";
import { launchPlan } from "../../src/agent/launch.ts";
import { buildText, agentOverview } from "../../src/agent/overview.ts";
import { MemoryStore } from "../../src/memory/index.ts";
import { fauxModels, agentConfigToml, tempDir } from "./support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function agent() {
	const dir = tempDir("orrery-build-");
	dirs.push(dir);
	const config = parseConfig(agentConfigToml({ dataDir: join(dir, "data"), folder: dir }), dir);
	const test = config.agents.get("Test")!;
	return { dir, config, agentDir: test.dir, file: join(test.dir, BUILD_FILE) };
}

/** Six long messages, not yet summarized. */
function seed(agentDir: string): void {
	const store = MemoryStore.open(join(agentDir, "memory.sqlite"));
	store.appendBatch(Array.from({ length: 6 }, (_, i) => ({ kind: i % 2 === 0 ? ("user" as const) : ("talk" as const), text: `message ${i} ${"x".repeat(3000)}`, date: `2026-10-0${i + 1}T10:00:00.000Z` })));
	store.close();
}

const DEAD = () => false;

describe("the memory build", () => {
	it("blocks opening while it runs; the row says how far it is and what it cost; done, it says nothing", () => {
		const { config, file } = agent();
		writeBuild(file, { pid: process.pid, startedAt: Date.now(), messages: 800, summaries: 120, dollars: 0.42 });
		const row = agentOverview(config)[0]!;
		expect(row.building).toBe("building memory: 120 summaries for 800 messages · $0.42 so far");
		const pi = { id: "pi" as const, label: "pi", path: "/bin/pi", wiring: "installed" as const, detail: "" };
		expect(launchPlan(config, row, [pi]).blocked).toBe("Test's memory is still being built (120 summaries for 800 messages); open it when the build finishes.");
		writeBuild(file, { pid: process.pid, startedAt: Date.now(), messages: 800, summaries: 800, done: true });
		expect(agentOverview(config)[0]!.building).toBeUndefined();
		expect(launchPlan(config, agentOverview(config)[0]!, [pi]).blocked).toBeUndefined();
	});

	it("a build that stopped short is named while summaries still wait, with its error, and never blocks opening", () => {
		const { config, agentDir, file } = agent();
		writeBuild(file, { pid: process.pid, startedAt: Date.now(), messages: 6, summaries: 0 });
		// No memory waits for summaries: nothing to say once its process is gone.
		expect(agentOverview(config, { alive: DEAD })[0]!.building).toBeUndefined();
		seed(agentDir);
		expect(agentOverview(config, { alive: DEAD })[0]!.building).toBe("memory build stopped: see build.log, or run orrery compact again");
		writeBuild(file, { pid: process.pid, startedAt: Date.now(), messages: 6, summaries: 0, error: "Unknown model faux-compactor/nope" });
		expect(agentOverview(config)[0]!.building).toBe("memory build stopped (Unknown model faux-compactor/nope): see build.log, or run orrery compact again");
		const pi = { id: "pi" as const, label: "pi", path: "/bin/pi", wiring: "installed" as const, detail: "" };
		expect(launchPlan(config, agentOverview(config)[0]!, [pi]).blocked).toBeUndefined();
	});

	it("stops counting as running when build.json is not rewritten for a while, whatever its pid", () => {
		const { file, agentDir } = agent();
		writeBuild(file, { pid: process.pid, startedAt: Date.now(), messages: 6, summaries: 1 });
		const state = readBuild(agentDir) as BuildState;
		expect(state.updatedAt).toBeTypeOf("number");
		const at = state.updatedAt as number;
		expect(buildRunning(state, () => true, at + BUILD_STALE_MS - 1)).toBe(true);
		expect(buildRunning(state, () => true, at + BUILD_STALE_MS)).toBe(false);
		expect(buildText(state, () => true, at + BUILD_STALE_MS)).toBe("memory build stopped: see build.log, or run orrery compact again");
	});

	it("reads only a build.json Orrery wrote", () => {
		const { agentDir, file } = agent();
		expect(readBuild(agentDir)).toBeUndefined();
		writeBuild(file, { pid: 1.5, startedAt: 1, messages: 1, summaries: 1 });
		expect(readBuild(agentDir)).toBeUndefined();
	});

	it("orrery compact --progress writes build.json while it runs and once it is done", async () => {
		const { config, agentDir } = agent();
		seed(agentDir);
		const { models, compactor } = fauxModels();
		const during: (BuildState | undefined)[] = [];
		compactor.setResponses([
			() => {
				during.push(readBuild(agentDir));
				return fauxAssistantMessage("user: summarized");
			},
			...Array.from({ length: 100 }, () => fauxAssistantMessage("user: summarized")),
		]);
		await compactCommand(config, "Test", models, { progress: join(agentDir, BUILD_FILE) });
		expect(during).toEqual([expect.objectContaining({ pid: process.pid, messages: 6, summaries: 0 })]);
		expect(during[0]?.done).toBeUndefined();
		const state = readBuild(agentDir);
		expect(state).toMatchObject({ pid: process.pid, messages: 6, done: true });
		expect(state!.summaries).toBeGreaterThan(0);
	});

	it("orrery compact --progress records why the build failed", async () => {
		const { dir, agentDir } = agent();
		seed(agentDir);
		const bad = parseConfig(agentConfigToml({ dataDir: join(dir, "data"), folder: dir }).replace('compactor_model = "faux-compactor/faux-1"', 'compactor_model = "faux-compactor/nope"'), dir);
		await expect(compactCommand(bad, "Test", fauxModels().models, { progress: join(agentDir, BUILD_FILE) })).rejects.toThrow(/nope/);
		expect(readBuild(agentDir)?.error).toMatch(/nope/);
	});

	it("startBuild runs orrery compact --progress detached, its output in build.log, and notes its pid", () => {
		const { agentDir, file } = agent();
		const calls: { cmd: string; args: readonly string[]; options: Record<string, unknown> }[] = [];
		const child = Object.assign(new EventEmitter(), { pid: 4242, unrefs: 0, unref() { child.unrefs++; } });
		const spawn = ((cmd: string, args: readonly string[], options: Record<string, unknown>) => (calls.push({ cmd, args, options }), child)) as never;
		startBuild("Test", agentDir, { configPath: "/c/config.toml", spawn });
		expect(calls).toHaveLength(1);
		expect(calls[0]!.args.slice(-6)).toEqual(["compact", "Test", "--progress", file, "--config", "/c/config.toml"]);
		expect(calls[0]!.options).toMatchObject({ detached: true });
		expect((calls[0]!.options.stdio as unknown[])[0]).toBe("ignore");
		expect(child.unrefs).toBe(1);
		expect(readBuild(agentDir)).toMatchObject({ pid: 4242, messages: 0, summaries: 0 });
		expect(existsSync(join(agentDir, "build.log"))).toBe(true);
		child.emit("error", new Error("spawn orrery ENOENT"));
		expect(readBuild(agentDir)?.error).toBe("spawn orrery ENOENT");
		expect(readFileSync(join(agentDir, "build.log"), "utf8")).toContain("spawn orrery ENOENT");
	});
});
