import { mkdirSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_MODEL_KEY, COMPACTOR_MODEL_KEY } from "../../src/agent/choices.ts";
import { parseConfig } from "../../src/agent/config.ts";
import { writeInstructions } from "../../src/agent/instructions.ts";
import { compactorReport, AgentHeld, MemoryAgent } from "../../src/agent/memory-agent.ts";
import { agentModelSource } from "../../src/agent/model-source.ts";
import { MemoryStore } from "../../src/memory/index.ts";
import { fauxModels, agentConfigToml, tempDir } from "./support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("MemoryAgent", () => {
	it("opens on Orrery's own logins, summarizes, says which agent holds it, and keeps a second writer out", async () => {
		const dir = tempDir("orrery-memory-agent-");
		dirs.push(dir);
		const agent = parseConfig(agentConfigToml({ dataDir: join(dir, "data"), folder: join(dir, "ws") }), dir).agents.get("Test")!;
		const models = agentModelSource(fauxModels().models);
		const reports: string[] = [];
		const open = MemoryAgent.open({ agent, models, report: (message) => reports.push(message), host: "claude-code" });
		try {
			open.view.append("user", `A long message ${"detail ".repeat(200)}`);
			expect(await open.view.settle(AbortSignal.timeout(10_000))).toBe(true);
			expect(open.view.render()).toContain("0+1|user: summarized");
			expect(open.store.usageRows().some((row) => row.role === "compactor" && row.model === "faux-compactor/faux-1")).toBe(true);
			open.writeStatus();
			expect(JSON.parse(readFileSync(join(agent.dir, "status.json"), "utf8"))).toMatchObject({ agent: "Test", model: "claude-code", open: true, version: "checkout" });
			expect(() => MemoryAgent.open({ agent, models, report: () => {} })).toThrow(AgentHeld);
		} finally {
			await open.close();
		}
		expect(reports).toEqual([]);
		const again = MemoryAgent.open({ agent, models, report: () => {} });
		again.writeStatus();
		expect(JSON.parse(readFileSync(join(agent.dir, "status.json"), "utf8")).model).toBe("pi");
		await again.close();
	});

	it("puts instructions.md's modification time when it opened in status.json, and 0 when the agent had none", async () => {
		const dir = tempDir("orrery-memory-agent-");
		dirs.push(dir);
		const agent = parseConfig(agentConfigToml({ dataDir: join(dir, "data"), folder: join(dir, "ws") }), dir).agents.get("Test")!;
		const models = agentModelSource(fauxModels().models);
		const status = () => JSON.parse(readFileSync(join(agent.dir, "status.json"), "utf8")) as { instructionsAt?: number };
		const none = MemoryAgent.open({ agent, models, report: () => {} });
		try {
			expect(none.instructionsAt).toBeUndefined();
			none.writeStatus();
			expect(status().instructionsAt).toBe(0);
		} finally {
			await none.close();
		}
		writeInstructions(agent.dir, "You are Test.\n");
		const at = statSync(join(agent.dir, "instructions.md")).mtimeMs;
		const some = MemoryAgent.open({ agent, models, report: () => {} });
		try {
			// A later edit does not change what this session read.
			writeInstructions(agent.dir, "You are Test, changed.\n");
			utimesSync(join(agent.dir, "instructions.md"), new Date(), new Date(at + 5000));
			expect(some.instructionsAt).toBe(at);
			some.writeStatus();
			expect(status().instructionsAt).toBe(at);
		} finally {
			await some.close();
		}
	});

	it("words a failing source plainly in the footer and status.json, and resumes on a new model without a restart", async () => {
		const dir = tempDir("orrery-memory-agent-");
		dirs.push(dir);
		const config = parseConfig(
			agentConfigToml({ dataDir: join(dir, "data"), folder: join(dir, "ws"), extra: "retry_seconds = 1" }),
			dir,
		).agents.get("Test")!;
		const failing = fauxProvider({ provider: "faux-broke" });
		failing.setResponses([]);
		const working = fauxProvider({ provider: "faux-ok" });
		working.setResponses(Array.from({ length: 50 }, () => fauxAssistantMessage("user: summarized")));
		const models = createModels();
		models.setProvider(failing.provider);
		models.setProvider(working.provider);
		const reports: string[] = [];
		const agent = MemoryAgent.open({ agent: config, models: agentModelSource(models), report: (message) => reports.push(message) });
		agent.setCompactorModel({ provider: "faux-broke", modelId: "faux-1", thinking: "off" });
		agent.view.append("user", `A long message ${"detail ".repeat(200)}`);
		try {
			await vi.waitFor(() => expect(agent.summaryTrouble()?.state).toBe("failing"), { timeout: 5000 });
			// The raw per-part retry line stays out of the agent's report; the state notices tell the user.
			expect(reports.filter((r) => /^Compactor |retrying every|faux responses/.test(r))).toEqual([]);
			expect(agent.statusLine()).toMatch(/^Orrery · Test · 1 msgs · SUMMARIES FAILING: .+ · \/compactor$/);
			agent.writeStatus();
			const status = JSON.parse(readFileSync(join(config.dir, "status.json"), "utf8"));
			expect(status.trouble).toEqual({ state: "failing", plain: expect.any(String) });
			expect(status.trouble.plain.length).toBeGreaterThan(0);
			expect(status.lastError).toBe(status.trouble.plain);
			// No summary has worked in this process yet: status.json says so, so no hook calls that a recovery.
			expect(status.summarized).toBe(false);
			agent.setCompactorModel({ provider: "faux-ok", modelId: "faux-1", thinking: "off" });
			await vi.waitFor(() => expect(agent.view.settled).toBe(true), { timeout: 5000 });
			expect(agent.summaryTrouble()).toBeUndefined();
			agent.writeStatus();
			expect(JSON.parse(readFileSync(join(config.dir, "status.json"), "utf8"))).toMatchObject({ trouble: null, summarized: true });
		} finally {
			await agent.close();
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

	it("keeps the stored names of models chosen in chat: a store holding lane.compactor-model opens as chosen in chat", async () => {
		expect([AGENT_MODEL_KEY, COMPACTOR_MODEL_KEY]).toEqual(["lane.model", "lane.compactor-model"]);
		const dir = tempDir("orrery-memory-agent-");
		dirs.push(dir);
		const agent = parseConfig(agentConfigToml({ dataDir: join(dir, "data"), folder: join(dir, "ws") }), dir).agents.get("Test")!;
		mkdirSync(agent.dir, { recursive: true });
		const store = MemoryStore.open(join(agent.dir, "memory.sqlite"));
		store.setMeta("lane.compactor-model", JSON.stringify({ provider: "faux-compactor", modelId: "faux-1", thinking: "high" }));
		store.close();
		const open = MemoryAgent.open({ agent, models: agentModelSource(fauxModels().models), report: () => {} });
		try {
			expect(open.compactorSource).toBe("chat");
			expect(open.compactorModel).toMatchObject({ provider: "faux-compactor", modelId: "faux-1", thinking: "high" });
		} finally {
			await open.close();
		}
	});
});

describe("MemoryAgent: summaries through an OpenCode model, opened elsewhere", () => {
	/** Agent Test, its summaries on `ref` (the config's, or chosen in chat when `chosen`). */
	function agentOn(ref: string, chosen = false) {
		const dir = tempDir("orrery-memory-agent-");
		dirs.push(dir);
		const extra = chosen ? "" : "";
		const toml = agentConfigToml({ dataDir: join(dir, "data"), folder: join(dir, "ws"), extra }).replace('compactor_model = "faux-compactor/faux-1"', `compactor_model = ${JSON.stringify(chosen ? "faux-compactor/faux-1" : ref)}`);
		const agent = parseConfig(toml, dir).agents.get("Test")!;
		if (chosen) {
			mkdirSync(agent.dir, { recursive: true });
			const store = MemoryStore.open(join(agent.dir, "memory.sqlite"));
			const slash = ref.indexOf("/");
			store.setMeta(COMPACTOR_MODEL_KEY, JSON.stringify({ provider: ref.slice(0, slash), modelId: ref.slice(slash + 1), thinking: "low" }));
			store.close();
		}
		return agent;
	}

	it.each([
		["pi", "/compactor"],
		["omp", "/compactor"],
		["claude-code", "/orrery:compactor"],
		["codex", "orrery compactor Test"],
	] as const)("opens in %s with its memory, its summaries waiting, and says how to switch there (%s)", async (host, command) => {
		for (const chosen of [false, true]) {
			const agent = agentOn("opencode/anthropic/claude-sonnet-4-5", chosen);
			const reports: string[] = [];
			const open = MemoryAgent.open({ agent, models: agentModelSource(fauxModels().models), report: (message) => reports.push(message), host });
			try {
				// A choice made in chat stays: it is no stale model here, only one that runs elsewhere.
				expect(open.compactorModel).toEqual({ provider: "opencode", modelId: "anthropic/claude-sonnet-4-5", thinking: chosen ? "low" : "off" });
				expect(open.compactorSource).toBe(chosen ? "chat" : "config");
				expect(open.summaryTrouble()).toEqual({ state: "stopped", reason: expect.any(String), plain: "opencode/anthropic/claude-sonnet-4-5 is an OpenCode model: summaries wait until Test is open in OpenCode" });
				expect(reports).toEqual([
					`Orrery: Test's summaries use an OpenCode model (opencode/anthropic/claude-sonnet-4-5), which works only while Test is open in OpenCode; they wait until then. To summarize here, choose another summary model with ${command}.`,
				]);
				open.view.append("user", `A long message ${"detail ".repeat(200)}`);
				expect(open.view.settled).toBe(false);
				// Switching to one of Orrery's sources starts them.
				open.setCompactorModel({ provider: "faux-compactor", modelId: "faux-1", thinking: "off" });
				expect(await open.view.settle(AbortSignal.timeout(10_000))).toBe(true);
			} finally {
				await open.close();
			}
		}
	});

	it("names the host's command for an unknown summary model; pi's and OMP's words are as they were", async () => {
		for (const [host, command] of [["pi", "/compactor"], ["omp", "/compactor"], ["claude-code", "/orrery:compactor"], ["codex", "orrery compactor Test"], ["opencode", "/compactor"]] as const) {
			const agent = agentOn("nowhere/model-x");
			const reports: string[] = [];
			const open = MemoryAgent.open({ agent, models: agentModelSource(fauxModels().models), report: (message) => reports.push(message), host });
			await open.close();
			expect(reports, host).toEqual([`Orrery: Test: summaries are off: unknown model nowhere/model-x. Choose a summary model with ${command} provider/id.`]);
		}
	});

	it("in OpenCode, an OpenCode model its plugin doesn't offer (gone, or OpenCode's free tier) is no model there: a chat choice falls back to the config's", async () => {
		const agent = agentOn("opencode/opencode/big-pickle", true);
		const reports: string[] = [];
		const open = MemoryAgent.open({ agent, models: agentModelSource(fauxModels().models), report: (message) => reports.push(message), host: "opencode" });
		try {
			expect(open.compactorModel).toEqual({ provider: "faux-compactor", modelId: "faux-1", thinking: "off" });
			expect(reports).toEqual(["Orrery: the summary model chosen in chat (opencode/opencode/big-pickle) is gone; using the config's."]);
		} finally {
			await open.close();
		}
	});
});
