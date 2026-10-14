import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { Holder } from "../../src/claude/holder.ts";
import { runHook } from "../../src/claude/hooks.ts";
import { compactorCliCommand } from "../../src/cli/commands.ts";
import { type HarnessConfig, parseModelChoice } from "../../src/agent/config.ts";
import { FileCredentialStore } from "../../src/agent/credentials.ts";
import { sessionDir } from "../../src/claude/paths.ts";
import { writeSetupMarker } from "../../src/claude/view-file.ts";
import { writeHolder } from "../../src/agent/handover.ts";
import { takeRequest } from "../../src/agent/settings-request.ts";
import { agentModelSource } from "../../src/agent/model-source.ts";
import { newToken } from "../../src/agent/pick.ts";
import { MemoryStore } from "../../src/memory/index.ts";
import { cleanEnv, cleanupDirs, cliCommand, testAgent } from "../claude/support.ts";
import { fauxModels, tempDir } from "../agent/support.ts";

const holders: Holder[] = [];
const dirs: string[] = [];
afterEach(async () => {
	for (const holder of holders.splice(0)) await holder.stop("test over");
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	cleanupDirs();
});

function fauxSources(config: HarnessConfig) {
	const faux = fauxModels();
	faux.chat.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage("OK")));
	return { sources: { config, credentials: new FileCredentialStore(join(config.dataDir, "c.json")), models: faux.models }, faux };
}

const NO_KEYS = { OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", OPENROUTER_API_KEY: "" };

const orrery = (args: string[], env: Record<string, string>, cwd?: string) => {
	const c = cliCommand(args);
	return spawnSync(c.cmd, c.args, { env: cleanEnv(env), encoding: "utf8", ...(cwd ? { cwd } : {}) });
};

describe("orrery compactor", () => {
	it("shows, switches (where pi's /compactor keeps it) and resets the summary model, refusing what fails its test", async () => {
		const t = testAgent();
		const { sources } = fauxSources(t.config);
		expect((await compactorCliCommand(t.config, "Test", [], { sources })).split("\n")[0]).toBe("summaries: faux-compactor/faux-1 (off) · from config");
		expect(await compactorCliCommand(t.config, "test", ["faux-agent/faux-1", "low"], { sources })).toBe("summaries: faux-agent/faux-1 (low) · set in chat\n");
		const store = MemoryStore.openReadOnly(join(t.agent.dir, "memory.sqlite"));
		expect(store.getMeta("lane.compactor-model")).toBe(JSON.stringify({ provider: "faux-agent", modelId: "faux-1", thinking: "low" }));
		store.close();
		await expect(compactorCliCommand(t.config, "Test", ["nobody/nothing"], { sources })).rejects.toThrow("Not switched: unknown model nobody/nothing. Still on faux-agent/faux-1.");
		expect(await compactorCliCommand(t.config, "Test", ["reset"], { sources })).toBe("summaries: faux-compactor/faux-1 (off) · from config\n");
	});

	it("hands the choice to the Claude Code holder that records the agent, and points to pi's /compactor when pi holds it", async () => {
		const t = testAgent();
		const models = agentModelSource(fauxModels().models);
		const { sources } = fauxSources(t.config);
		const holder = (await Holder.start({ agent: t.agent, session: "s1", claudePid: 111, nonce: "n", models, alive: () => true, tickMs: 20 }))!;
		holders.push(holder);
		expect(await compactorCliCommand(t.config, "Test", ["faux-agent/faux-1"], { sources, waitMs: 5000 })).toBe("summaries: faux-agent/faux-1 (off) · set in chat\n");
		expect(holder.agent.compactorSource).toBe("chat");
		// The holder stores exactly the resolved choice, thinking level included.
		const held = MemoryStore.openReadOnly(join(t.agent.dir, "memory.sqlite"));
		expect(held.getMeta("lane.compactor-model")).toBe(JSON.stringify({ provider: "faux-agent", modelId: "faux-1", thinking: "off" }));
		held.close();
		await holder.stop("test");
		const pi = MemoryStore.open(join(t.agent.dir, "memory.sqlite"));
		try {
			await expect(compactorCliCommand(t.config, "Test", ["reset"], { sources, waitMs: 300 })).rejects.toThrow("Test (open in another Orrery process (an import or build?)) didn't answer within 0.3 s; the change was not applied.");
			expect(existsSync(join(t.agent.dir, "request.json"))).toBe(false);
		} finally {
			pi.close();
		}
	});

	it("names pi when its status is fresh, and withdraws a spooled event nobody consumed", async () => {
		const t = testAgent();
		const { sources } = fauxSources(t.config);
		const store = MemoryStore.open(join(t.agent.dir, "memory.sqlite"));
		try {
			writeFileSync(join(t.agent.dir, "status.json"), JSON.stringify({ agent: "Test", pid: process.pid, busy: false, model: "faux-agent/faux-1", compactor: { stopped: false, failing: 0, model: "faux-compactor/faux-1", thinking: "off", source: "config" }, updatedAt: new Date().toISOString() }));
			await expect(compactorCliCommand(t.config, "Test", ["reset"], { sources, waitMs: 300 })).rejects.toThrow("Test (open in pi) didn't answer within 0.3 s; the change was not applied.");
			// A fresh holder.json with nobody consuming the spool.
			writeHolder(t.agent.dir, { pid: process.pid, session: "s9", claudePid: 111, state: "recording", startedAt: Date.now(), updatedAt: Date.now() });
			await expect(compactorCliCommand(t.config, "Test", ["reset"], { sources, waitMs: 300 })).rejects.toThrow(/^Test \(open in Claude Code\) didn't answer within 0\.3 s; the change was not applied\. See /);
			expect(readdirSync(sessionDir(t.agent.dir, "s9"))).toEqual([]);
		} finally {
			store.close();
		}
	});

	it("hands the choice to pi through request.json, as pi's tick would take it", async () => {
		const t = testAgent();
		const { sources } = fauxSources(t.config);
		const pi = MemoryStore.open(join(t.agent.dir, "memory.sqlite"));
		const timer = setInterval(() => {
			const { request } = takeRequest(t.agent.dir, "Test");
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

	it("checks models against Orrery's own logins and finds the agent from the project folder", () => {
		const dir = tempDir("orrery-compactor-");
		dirs.push(dir);
		const folder = join(dir, "ws");
		mkdirSync(folder);
		const config = join(dir, "config.toml");
		writeFileSync(
			config,
			`data_dir = ${JSON.stringify(join(dir, "data"))}\ncredentials = ${JSON.stringify(join(dir, "credentials.json"))}\n\n[agents.Test]\nfolder = ${JSON.stringify(folder)}\nmodel = "openai/gpt-6.1-sol"\ncompactor_model = "openai/gpt-6.1-sol"\n`,
		);
		const set = orrery(["compactor", ".", "anthropic/claude-opus-4-7", "low"], { ORRERY_CONFIG: config, CLAUDE_PROJECT_DIR: folder, ...NO_KEYS });
		expect([set.status, set.stderr]).toEqual([1, expect.stringContaining("Not switched: no login saved for Anthropic; orrery login --key anthropic")]);
		const list = orrery(["compactor", ".", "key", "openrouter", "claude", "haiku"], { ORRERY_CONFIG: config, CLAUDE_PROJECT_DIR: folder, ...NO_KEYS });
		expect([list.status, list.stdout]).toEqual([0, expect.stringMatching(/anthropic\/claude-haiku-4\.5/)]);
		const hint = orrery(["compactor", ".", "--prefix", "/orrery:compactor", "key"], { ORRERY_CONFIG: config, CLAUDE_PROJECT_DIR: folder, ...NO_KEYS });
		expect([hint.status, hint.stdout]).toEqual([0, expect.stringContaining("Models:  /orrery:compactor key openrouter")]);
		// Nothing was switched, so the agent has no memory file yet; browse needs one.
		mkdirSync(join(dir, "data", "agents", "Test"), { recursive: true });
		MemoryStore.open(join(dir, "data", "agents", "Test", "memory.sqlite")).close();
		const status = orrery(["status", "."], { ORRERY_CONFIG: config }, folder);
		expect(status.stdout).toMatch(/^Test\s/);
		// ORRERY_NO_OPEN stops the page opening in a real browser during tests, even with a display.
		const page = orrery(["browse", ".", "--open"], { ORRERY_CONFIG: config, CLAUDE_PROJECT_DIR: folder, ORRERY_NO_OPEN: "1", DISPLAY: ":0", WAYLAND_DISPLAY: "" });
		expect(page.stdout).toBe(`Wrote ${join(dir, "data", "agents", "Test", "memory.html")} (no display here: open it yourself)\n`);
		expect(statSync(join(dir, "data", "agents", "Test", "memory.html")).mode & 0o777).toBe(0o600);
		const nowhere = orrery(["usage", "."], { ORRERY_CONFIG: config, CLAUDE_PROJECT_DIR: dir });
		expect([nowhere.status, nowhere.stderr]).toEqual([1, `${dir} is in no agent's folder.\n`]);
	}, 60_000);
});

describe("`.`, this session's agent (Claude Code's commands)", () => {
	it("is the agent ORRERY_AGENT names, in any folder: in Claude Code the one its process decided on; else the folder's", async () => {
		const t = testAgent();
		const elsewhere = join(t.dir, "elsewhere");
		mkdirSync(elsewhere);
		const status = (env: Record<string, string>) => orrery(["status", "."], { ORRERY_CONFIG: t.configPath, CLAUDE_PROJECT_DIR: elsewhere, ...env });
		expect(status({ ORRERY_AGENT: "Test" }).stdout).toMatch(/^Test\s/);
		expect(status({ ORRERY_AGENT: "test" }).stdout).toMatch(/^Test\s/);
		const nowhere = status({});
		expect([nowhere.status, nowhere.stderr]).toEqual([1, `${elsewhere} is in no agent's folder.\n`]);
		const unknown = status({ ORRERY_AGENT: "Nobody" });
		expect([unknown.status, unknown.stderr]).toEqual([1, "Orrery: ORRERY_AGENT names Nobody, which is not a configured agent; this session runs without memory.\n"]);
		// A skill's command runs with Claude Code's CLAUDE_PID: "." is what that process decided (here this test's
		// SessionStart) under the same ORRERY_AGENT and token; a command never decides.
		const token = newToken();
		const record = join(t.config.dataDir, "claude-processes", `${process.pid}.json`);
		try {
			await runHook("session-start", JSON.stringify({ session_id: "s1", cwd: elsewhere }), {
				config: t.config,
				env: { ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: token, CLAUDE_PROJECT_DIR: elsewhere },
				claudePid: process.pid,
				startHolder: () => {},
				modeWaitMs: 100,
				home: join(t.dir, "home"),
			});
			expect(status({ ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: token, CLAUDE_PID: String(process.pid) }).stdout).toMatch(/^Test\s/);
			const refusedHere = [1, "Orrery: ORRERY_AGENT is set, but no choice of agent is recorded for this Claude Code under this ORRERY_AGENT; this session runs without memory.\n"];
			// A descendant that inherited CLAUDE_PID but runs under another ORRERY_AGENT, or without the token: the record is
			// not its own, so it is refused rather than given the ancestor's agent.
			const descendant = status({ ORRERY_AGENT: "Other", CLAUDE_PID: String(process.pid) });
			expect([descendant.status, descendant.stderr]).toEqual(refusedHere);
			const tokenless = status({ ORRERY_AGENT: "Test", CLAUDE_PID: String(process.pid) });
			expect([tokenless.status, tokenless.stderr]).toEqual(refusedHere);
			// A Claude Code process that decided nothing: refused, never its folder's.
			const undecided = status({ ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: token, CLAUDE_PID: String(process.ppid) });
			expect([undecided.status, undecided.stderr]).toEqual(refusedHere);
			// Outside Claude Code "." is picked there, and its parent (this test, which claimed the token) is the claimant.
			expect(status({ ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: token }).stdout).toMatch(/^Test\s/);
			// It never takes a dead agent's claim over (only a Claude Code process's first decision may).
			const dead = newToken();
			writeFileSync(join(t.agent.dir, "claims", dead), `${spawnSync("true").pid}\n`);
			const late = status({ ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: dead });
			expect([late.status, late.stderr]).toEqual([1, `${elsewhere} is in no agent's folder.\n`]);
		} finally {
			rmSync(record, { force: true });
		}
		// In another agent's folder set up the file way, the agent is refused, as in the hooks.
		const other = join(t.dir, "other");
		mkdirSync(other);
		writeFileSync(t.configPath, `${readFileSync(t.configPath, "utf8")}\n[agents.Other]\nfolder = ${JSON.stringify(other)}\ncompactor_model = "faux-compactor/faux-1"\n`);
		writeSetupMarker(join(t.dir, "data", "agents", "Other"), other, "CLAUDE.md");
		const refused = orrery(["status", "."], { ORRERY_CONFIG: t.configPath, CLAUDE_PROJECT_DIR: other, ORRERY_AGENT: "Test" });
		expect([refused.status, refused.stderr]).toEqual([
			1,
			"Orrery: this folder is Other's, set up to load Other's memory view into Claude Code, so Test does not open here (Other's memory would be in its session); this session runs without memory. Open Test in another folder, or switch Other to the mod (`orrery claude-setup Other --mod`).\n",
		]);
	}, 60_000);
});
