import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { Holder } from "../../src/claude/holder.ts";
import { compactorCliCommand } from "../../src/cli/commands.ts";
import { type HarnessConfig, parseModelChoice } from "../../src/lane/config.ts";
import { FileCredentialStore } from "../../src/lane/credentials.ts";
import { sessionDir } from "../../src/claude/paths.ts";
import { writeSetupMarker } from "../../src/claude/view-file.ts";
import { writeHolder } from "../../src/lane/handover.ts";
import { takeRequest } from "../../src/lane/settings-request.ts";
import { laneModelSource } from "../../src/lane/model-source.ts";
import { claimToken, newToken } from "../../src/lane/pick.ts";
import { MemoryStore } from "../../src/memory/index.ts";
import { cleanEnv, cleanupDirs, cliCommand, testLane } from "../claude/support.ts";
import { fauxModels, tempDir } from "../lane/support.ts";

const holders: Holder[] = [];
const dirs: string[] = [];
afterEach(async () => {
	for (const holder of holders.splice(0)) await holder.stop("test over");
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	cleanupDirs();
});

function fauxSources(config: HarnessConfig) {
	const faux = fauxModels();
	faux.agent.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage("OK")));
	return { sources: { config, credentials: new FileCredentialStore(join(config.dataDir, "c.json")), models: faux.models }, faux };
}

const NO_KEYS = { OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", OPENROUTER_API_KEY: "" };

const orrery = (args: string[], env: Record<string, string>, cwd?: string) => {
	const c = cliCommand(args);
	return spawnSync(c.cmd, c.args, { env: cleanEnv(env), encoding: "utf8", ...(cwd ? { cwd } : {}) });
};

describe("orrery compactor", () => {
	it("shows, switches (where pi's /compactor keeps it) and resets the summary model, refusing what fails its test", async () => {
		const t = testLane();
		const { sources } = fauxSources(t.config);
		expect((await compactorCliCommand(t.config, "Test", [], { sources })).split("\n")[0]).toBe("summaries: faux-compactor/faux-1 (off) · from config");
		expect(await compactorCliCommand(t.config, "test", ["faux-agent/faux-1", "low"], { sources })).toBe("summaries: faux-agent/faux-1 (low) · set in chat\n");
		const store = MemoryStore.openReadOnly(join(t.lane.dir, "memory.sqlite"));
		expect(store.getMeta("lane.compactor-model")).toBe(JSON.stringify({ provider: "faux-agent", modelId: "faux-1", thinking: "low" }));
		store.close();
		await expect(compactorCliCommand(t.config, "Test", ["nobody/nothing"], { sources })).rejects.toThrow("Not switched: unknown model nobody/nothing. Still on faux-agent/faux-1.");
		expect(await compactorCliCommand(t.config, "Test", ["reset"], { sources })).toBe("summaries: faux-compactor/faux-1 (off) · from config\n");
	});

	it("hands the choice to the Claude Code holder that records the lane, and points to pi's /compactor when pi holds it", async () => {
		const t = testLane();
		const models = laneModelSource(fauxModels().models);
		const { sources } = fauxSources(t.config);
		const holder = (await Holder.start({ lane: t.lane, session: "s1", claudePid: 111, nonce: "n", models, alive: () => true, tickMs: 20 }))!;
		holders.push(holder);
		expect(await compactorCliCommand(t.config, "Test", ["faux-agent/faux-1"], { sources, waitMs: 5000 })).toBe("summaries: faux-agent/faux-1 (off) · set in chat\n");
		expect(holder.lane.compactorSource).toBe("chat");
		// The holder stores exactly the resolved choice, thinking level included.
		const held = MemoryStore.openReadOnly(join(t.lane.dir, "memory.sqlite"));
		expect(held.getMeta("lane.compactor-model")).toBe(JSON.stringify({ provider: "faux-agent", modelId: "faux-1", thinking: "off" }));
		held.close();
		await holder.stop("test");
		const pi = MemoryStore.open(join(t.lane.dir, "memory.sqlite"));
		try {
			await expect(compactorCliCommand(t.config, "Test", ["reset"], { sources, waitMs: 300 })).rejects.toThrow("Test (open in another Orrery process (an import or build?)) didn't answer within 0.3 s; the change was not applied.");
			expect(existsSync(join(t.lane.dir, "request.json"))).toBe(false);
		} finally {
			pi.close();
		}
	});

	it("names pi when its status is fresh, and withdraws a spooled event nobody consumed", async () => {
		const t = testLane();
		const { sources } = fauxSources(t.config);
		const store = MemoryStore.open(join(t.lane.dir, "memory.sqlite"));
		try {
			writeFileSync(join(t.lane.dir, "status.json"), JSON.stringify({ lane: "Test", pid: process.pid, busy: false, model: "faux-agent/faux-1", compactor: { stopped: false, failing: 0, model: "faux-compactor/faux-1", thinking: "off", source: "config" }, updatedAt: new Date().toISOString() }));
			await expect(compactorCliCommand(t.config, "Test", ["reset"], { sources, waitMs: 300 })).rejects.toThrow("Test (open in pi) didn't answer within 0.3 s; the change was not applied.");
			// A fresh holder.json with nobody consuming the spool.
			writeHolder(t.lane.dir, { pid: process.pid, session: "s9", claudePid: 111, state: "recording", startedAt: Date.now(), updatedAt: Date.now() });
			await expect(compactorCliCommand(t.config, "Test", ["reset"], { sources, waitMs: 300 })).rejects.toThrow(/^Test \(open in Claude Code\) didn't answer within 0\.3 s; the change was not applied\. See /);
			expect(readdirSync(sessionDir(t.lane.dir, "s9"))).toEqual([]);
		} finally {
			store.close();
		}
	});

	it("hands the choice to pi through request.json, as pi's tick would take it", async () => {
		const t = testLane();
		const { sources } = fauxSources(t.config);
		const pi = MemoryStore.open(join(t.lane.dir, "memory.sqlite"));
		const timer = setInterval(() => {
			const { request } = takeRequest(t.lane.dir, "Test");
			if (request === undefined) return;
			const [ref, thinking] = request.args.split(" ");
			pi.setMeta("lane.compactor-model", JSON.stringify(parseModelChoice(ref ?? "", thinking ?? "off")));
		}, 20);
		try {
			expect(await compactorCliCommand(t.config, "Test", ["faux-agent/faux-1", "low"], { sources, waitMs: 5000 })).toBe("summaries: faux-agent/faux-1 (low) · set in chat\n");
		} finally {
			clearInterval(timer);
			pi.close();
		}
	});

	it("checks models against Orrery's own logins and finds the lane from the project folder", () => {
		const dir = tempDir("orrery-compactor-");
		dirs.push(dir);
		const workspace = join(dir, "ws");
		mkdirSync(workspace);
		const config = join(dir, "config.toml");
		writeFileSync(
			config,
			`data_dir = ${JSON.stringify(join(dir, "data"))}\ncredentials = ${JSON.stringify(join(dir, "credentials.json"))}\n\n[lanes.Test]\nworkspace = ${JSON.stringify(workspace)}\nmodel = "openai/gpt-6.1-sol"\ncompactor_model = "openai/gpt-6.1-sol"\n`,
		);
		const set = orrery(["compactor", ".", "anthropic/claude-opus-4-7", "low"], { ORRERY_CONFIG: config, CLAUDE_PROJECT_DIR: workspace, ...NO_KEYS });
		expect([set.status, set.stderr]).toEqual([1, expect.stringContaining("Not switched: no login saved for Anthropic; orrery login --key anthropic")]);
		const list = orrery(["compactor", ".", "key", "openrouter", "claude", "haiku"], { ORRERY_CONFIG: config, CLAUDE_PROJECT_DIR: workspace, ...NO_KEYS });
		expect([list.status, list.stdout]).toEqual([0, expect.stringMatching(/anthropic\/claude-haiku-4\.5/)]);
		const hint = orrery(["compactor", ".", "--prefix", "/orrery:compactor", "key"], { ORRERY_CONFIG: config, CLAUDE_PROJECT_DIR: workspace, ...NO_KEYS });
		expect([hint.status, hint.stdout]).toEqual([0, expect.stringContaining("Models:  /orrery:compactor key openrouter")]);
		// Nothing was switched, so the lane has no memory file yet; browse needs one.
		mkdirSync(join(dir, "data", "lanes", "Test"), { recursive: true });
		MemoryStore.open(join(dir, "data", "lanes", "Test", "memory.sqlite")).close();
		const status = orrery(["status", "."], { ORRERY_CONFIG: config }, workspace);
		expect(status.stdout).toMatch(/^Test\s/);
		// ORRERY_NO_OPEN stops the page opening in a real browser during tests, even with a display.
		const page = orrery(["browse", ".", "--open"], { ORRERY_CONFIG: config, CLAUDE_PROJECT_DIR: workspace, ORRERY_NO_OPEN: "1", DISPLAY: ":0", WAYLAND_DISPLAY: "" });
		expect(page.stdout).toBe(`Wrote ${join(dir, "data", "lanes", "Test", "memory.html")} (no display here: open it yourself)\n`);
		expect(statSync(join(dir, "data", "lanes", "Test", "memory.html")).mode & 0o777).toBe(0o600);
		const nowhere = orrery(["usage", "."], { ORRERY_CONFIG: config, CLAUDE_PROJECT_DIR: dir });
		expect([nowhere.status, nowhere.stderr]).toEqual([1, `${dir} is in no lane's workspace.\n`]);
	}, 60_000);
});

describe("`.`, this session's lane (Claude Code's commands)", () => {
	it("is the lane ORRERY_AGENT names, in any folder; with a token, only for the Claude Code that claimed it; else the folder's", () => {
		const t = testLane();
		const elsewhere = join(t.dir, "elsewhere");
		mkdirSync(elsewhere);
		const status = (env: Record<string, string>) => orrery(["status", "."], { ORRERY_CONFIG: t.configPath, CLAUDE_PROJECT_DIR: elsewhere, ...env });
		expect(status({ ORRERY_AGENT: "Test" }).stdout).toMatch(/^Test\s/);
		expect(status({ ORRERY_AGENT: "test" }).stdout).toMatch(/^Test\s/);
		const nowhere = status({});
		expect([nowhere.status, nowhere.stderr]).toEqual([1, `${elsewhere} is in no lane's workspace.\n`]);
		const unknown = status({ ORRERY_AGENT: "Nobody" });
		expect([unknown.status, unknown.stderr]).toEqual([1, "Orrery: ORRERY_AGENT names Nobody, which is not a configured agent; this session runs without memory.\n"]);
		const token = newToken();
		expect(claimToken(t.lane.dir, token, process.pid)).toBe(true);
		// A skill's command runs with Claude Code's CLAUDE_PID; without one, its parent (here this test, the claimant) stands in.
		expect(status({ ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: token, CLAUDE_PID: String(process.pid) }).stdout).toMatch(/^Test\s/);
		expect(status({ ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: token }).stdout).toMatch(/^Test\s/);
		const child = status({ ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: token, CLAUDE_PID: String(process.ppid) });
		expect([child.status, child.stderr]).toEqual([1, `${elsewhere} is in no lane's workspace.\n`]);
		expect(orrery(["status", "."], { ORRERY_CONFIG: t.configPath, CLAUDE_PROJECT_DIR: t.workspace, ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: token, CLAUDE_PID: String(process.ppid) }).stdout).toMatch(/^Test\s/);
		// A command runs within a session: a dead agent's claim is not taken over here (only at a session's start).
		const dead = newToken();
		writeFileSync(join(t.lane.dir, "claims", dead), `${spawnSync("true").pid}\n`);
		const late = status({ ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: dead, CLAUDE_PID: String(process.pid) });
		expect([late.status, late.stderr]).toEqual([1, `${elsewhere} is in no lane's workspace.\n`]);
		// In another lane's folder set up the file way, the agent is refused, as in the hooks.
		const other = join(t.dir, "other");
		mkdirSync(other);
		writeFileSync(t.configPath, `${readFileSync(t.configPath, "utf8")}\n[lanes.Other]\nworkspace = ${JSON.stringify(other)}\ncompactor_model = "faux-compactor/faux-1"\n`);
		writeSetupMarker(join(t.dir, "data", "lanes", "Other"), other, "CLAUDE.md");
		const refused = orrery(["status", "."], { ORRERY_CONFIG: t.configPath, CLAUDE_PROJECT_DIR: other, ORRERY_AGENT: "Test" });
		expect([refused.status, refused.stderr]).toEqual([
			1,
			"Orrery: this folder is Other's, set up to load Other's memory view into Claude Code, so Test does not open here (Other's memory would be in its session); this session runs without memory. Open Test in another folder, or switch Other to the mod (`orrery claude-setup Other --mod`).\n",
		]);
	}, 60_000);
});
