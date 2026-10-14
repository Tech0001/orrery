import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync, execFile } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemo, demoDeps, demoEnvironment, withDemoHome } from "../../src/demo.ts";
import { MemoryStore } from "../../src/memory/index.ts";
import { PAGES } from "../../src/tui/run.ts";
import { makeApp, screen, settle } from "./support.ts";

vi.mock("node:child_process", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:child_process")>();
	const refuse = () => { throw new Error("Demo must not run tools"); };
	return { ...original, spawn: vi.fn(refuse), spawnSync: vi.fn(refuse), execFile: vi.fn(refuse) };
});

const dirs: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const home = () => { const dir = mkdtempSync(join(tmpdir(), "orrery-demo-test-")); dirs.push(dir); return dir; };
const controls = { rows: () => 40, quit: () => {}, requestRender: () => {} };

describe("throwaway demo", () => {
	it("seeds five fictional agents, mixed tools, summary trees, live states and priced usage", async () => {
		const root = home();
		const demo = createDemo(root);
		const deps = demoDeps(demo, controls);
		const config = deps.loadConfig();
		expect(config.agents.size).toBe(5);
		expect(new Set([...config.agents.values()].map((agent) => agent.tool))).toEqual(new Set(["pi", "claude-code", "omp", "codex"]));
		for (const path of [demo.configPath, config.dataDir, config.credentialsPath, config.deviceIdPath, ...[...config.agents.values()].flatMap((agent) => [agent.dir, agent.folder ?? "(no folder)"])]) expect(path.startsWith(`${root}/`)).toBe(true);
		const rows = deps.overview(config);
		expect(new Set(rows.map((row) => row.state))).toEqual(new Set(["working", "open", "closed"]));
		// Each fictional agent has instructions, so the page shows no "no instructions" note.
		expect(rows.map((row) => row.instructions)).toEqual(["ok", "ok", "ok", "ok", "ok"]);
		expect(rows.filter((row) => row.summary.state === "failing")).toHaveLength(1);
		for (const row of rows.filter((row) => row.tool !== "codex")) {
			expect(row.messages).toBeGreaterThan(20);
			expect(row.summaries).toBeGreaterThan(10);
			const store = MemoryStore.openReadOnly(join(row.dataDir, "memory.sqlite"));
			try { expect([...store.nodes()].some((node) => node.l > 1)).toBe(true); } finally { store.close(); }
		}
		const app = makeApp(deps, PAGES);
		expect(screen(app)).toContain("Bellwick");
		expect(screen(app)).toContain("failing:");
		// No instructions note in a state cell (the hint line names E instructions).
		expect(screen(app)).not.toMatch(/no instructions|instructions over 32 KB|new instructions/);
		app.handleInput("3"); await settle();
		expect(screen(app)).toMatch(/\$\d+\.\d{2}/);
		expect(deps.usage(config, 7).flatMap((agent) => agent.rows).some((row) => row.cacheRead > 0 && row.role === "compactor")).toBe(true);
	});

	it("renders all pages and blocks external actions without model calls, probes or saved secrets", async () => {
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Demo must stay offline"));
		const demo = createDemo(home());
		const deps = demoDeps(demo, controls);
		const config = deps.loadConfig();
		const app = makeApp(deps, PAGES);
		for (const key of ["1", "2", "3", "4"]) { app.handleInput(key); await settle(); expect(screen(app)).not.toContain("unreadable"); }
		expect(deps.configWritable()).toBe(false);
		expect(() => deps.editConfig(() => "")).toThrow(/demo/i);
		expect(() => deps.target(config, "Bellwick")).toThrow(/demo/i);
		const sources = await deps.sources(config);
		await expect(deps.signIn(sources, { notify: () => {}, prompt: async () => "" }, "openrouter")).rejects.toThrow(/demo/i);
		await expect(deps.saveKey(sources, "openrouter", "synthetic-value")).rejects.toThrow(/demo/i);
		await expect(deps.testChoice(sources, { provider: "demo-api", modelId: "paper-summary", thinking: "off" })).rejects.toThrow(/demo/i);
		expect(() => deps.install([])).toThrow(/demo/i);
		expect(deps.openUrl("https://example.invalid")).toBeUndefined();
		const exported = deps.browse(config, "Bellwick");
		expect(exported.path.startsWith(`${demo.home}/`)).toBe(true);
		expect(readFileSync(exported.path, "utf8")).toContain("Bellwick");
		expect(existsSync(config.credentialsPath)).toBe(false);
		expect(fetch).not.toHaveBeenCalled();
		for (const probe of [spawn, spawnSync, execFile]) expect(probe).not.toHaveBeenCalled();
	});

	it("E writes nothing, not even the template for an agent without instructions", async () => {
		const demo = createDemo(home());
		const deps = demoDeps(demo, controls);
		const file = join(deps.loadConfig().agents.get("Bellwick")!.dir, "instructions.md");
		rmSync(file);
		const app = makeApp(deps, PAGES);
		app.handleInput("E");
		await app.idle();
		expect(screen(app)).toContain("Editing instructions is unavailable here.");
		expect(existsSync(file)).toBe(false);
	});

	it("drops inherited config, credentials, agent settings and PATH", () => {
		const root = home();
		const env = demoEnvironment(root, { HOME: "/real", XDG_CONFIG_HOME: "/real-config", ORRERY_CONFIG: "/real/config.toml", PI_CODING_AGENT_DIR: "/real/pi", ANTHROPIC_API_KEY: "synthetic", PATH: "/real/bin", TERM: "xterm-256color" });
		expect(env.HOME).toBe(root);
		for (const name of ["ORRERY_HOME", "ORRERY_CONFIG"]) expect(env[name]?.startsWith(`${root}/`)).toBe(true);
		for (const name of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) expect(env[name]).toBeUndefined();
		expect(env.TERM).toBe("xterm-256color");
		expect(env.PATH).not.toBe("/real/bin");
		expect(env.PI_CODING_AGENT_DIR).toBeUndefined();
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
	});

	it.each([false, true])("removes the entire temporary home after the session (failure=%s)", async (fail) => {
		let root = "";
		const run = withDemoHome(async (dir) => {
			root = dir; createDemo(dir);
			expect(existsSync(dir)).toBe(true);
			if (fail) throw new Error("synthetic TUI failure");
			return 0;
		});
		if (fail) await expect(run).rejects.toThrow("synthetic TUI failure"); else expect(await run).toBe(0);
		expect(existsSync(root)).toBe(false);
	});
});
