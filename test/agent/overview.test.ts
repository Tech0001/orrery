import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../../src/agent/config.ts";
import { writeHolder } from "../../src/agent/handover.ts";
import { ago, dollarText, agentOverview, agentUsage, OverviewCache, summaryText, TOOL_LABELS, totalCost, usageCost } from "../../src/agent/overview.ts";
import { localIso, MemoryStore } from "../../src/memory/index.ts";
import { tempDir } from "./support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NOW = Date.parse("2026-10-08T12:00:00.000Z");

function setup(extra = "") {
	const dir = tempDir("orrery-overview-");
	dirs.push(dir);
	const config = parseConfig(
		`data_dir = ${JSON.stringify(join(dir, "data"))}\n[agents.A]\nfolder = "/w/a"\ncompactor_model = "openai/gpt-6.1-sol"\n${extra}\n[agents.B]\nfolder = "/w/b"\ntool = "codex"\ncompactor_model = "anthropic/claude-haiku-4-5"\ncompactor_thinking = "off"\n`,
		dir,
	);
	const agentDir = config.agents.get("A")!.dir;
	mkdirSync(agentDir, { recursive: true });
	return { config, agentDir };
}

const status = (fields: Record<string, unknown>) => ({
	agent: "A", pid: 4242, open: true, busy: false, model: "pi", thinking: "pi",
	compactor: { stopped: false, failing: 0, model: "openai/gpt-6.1-sol", thinking: "low", source: "config" },
	trouble: null, lastError: null, updatedAt: localIso(new Date(NOW - 2000)), ...fields,
});

const alive = (pid: number) => pid === 4242;

describe("agentOverview", () => {
	it("shows closed agents without memory, with the config's summary model and a guessed tool", () => {
		const { config } = setup();
		const [a, b] = agentOverview(config, { now: NOW, alive });
		expect(a).toMatchObject({ name: "A", tool: "pi", toolSet: false, state: "closed", hasMemory: false, messages: 0, summary: { state: "ok", waiting: 0 } });
		expect(a.summaryModel).toEqual({ ref: "openai/gpt-6.1-sol", thinking: "low", source: "config" });
		expect(a.summaryContextBytes).toBe(32_000);
		expect(b).toMatchObject({ name: "B", tool: "codex", toolSet: true, state: "closed" });
	});

	it("gives an agent without a folder a row without one", () => {
		const dir = tempDir("orrery-overview-");
		dirs.push(dir);
		const config = parseConfig(`data_dir = ${JSON.stringify(join(dir, "data"))}\n[agents.Nomad]\ncompactor_model = "openai/gpt-6.1-sol"\n`, dir);
		const [nomad] = agentOverview(config, { now: NOW, alive });
		expect(nomad).toMatchObject({ name: "Nomad", state: "closed", hasMemory: false });
		expect(Object.keys(nomad)).not.toContain("folder");
	});

	it("reads a fresh pi status as open or working, with its trouble in plain words", () => {
		const { config, agentDir } = setup();
		writeFileSync(join(agentDir, "status.json"), JSON.stringify(status({ busy: true, trouble: { state: "failing", plain: "quota\x1b]0;x\x07 reached" } })));
		const [a] = agentOverview(config, { now: NOW, alive });
		expect(a).toMatchObject({ state: "working", openIn: "pi" });
		expect(a.summary).toEqual({ state: "failing", waiting: 0, plain: "quota reached" });
		expect(summaryText(a)).toBe("failing: quota reached");
	});

	it("counts a pi status as closed when it is stale, says open: false, or its process is gone", () => {
		const { config, agentDir } = setup();
		for (const fields of [{ updatedAt: localIso(new Date(NOW - 60_000)) }, { open: false }, { pid: 999_999 }]) {
			writeFileSync(join(agentDir, "status.json"), JSON.stringify(status(fields)));
			expect(agentOverview(config, { now: NOW, alive })[0].state, JSON.stringify(fields)).toBe("closed");
		}
		writeFileSync(join(agentDir, "status.json"), "{not json");
		expect(agentOverview(config, { now: NOW, alive })[0].state).toBe("closed");
	});

	it("reads a fresh OMP status as open in OMP, and guesses OMP as the tool when the config names none", () => {
		const { config, agentDir } = setup();
		writeFileSync(join(agentDir, "status.json"), JSON.stringify(status({ model: "omp", thinking: "omp" })));
		expect(agentOverview(config, { now: NOW, alive })[0]).toMatchObject({ state: "open", openIn: "omp", tool: "omp", toolSet: false });
		expect(TOOL_LABELS.omp).toBe("OMP");
	});

	it("reads a fresh OpenCode status as open in OpenCode, and guesses OpenCode as the tool when the config names none", () => {
		const { config, agentDir } = setup();
		writeFileSync(join(agentDir, "status.json"), JSON.stringify(status({ model: "opencode", thinking: "opencode", busy: true })));
		expect(agentOverview(config, { now: NOW, alive })[0]).toMatchObject({ state: "working", openIn: "opencode", tool: "opencode", toolSet: false });
		expect(TOOL_LABELS.opencode).toBe("OpenCode");
	});

	it("reads Claude Code's heartbeat: recording is open (working when busy), finishing is finishing", () => {
		const { config, agentDir } = setup();
		writeHolder(agentDir, { pid: 1, session: "s", claudePid: 2, state: "recording", startedAt: NOW - 5000, updatedAt: NOW - 1000 });
		writeFileSync(join(agentDir, "status.json"), JSON.stringify(status({ model: "claude-code", busy: true, updatedAt: localIso(new Date(NOW - 600_000)) })));
		expect(agentOverview(config, { now: NOW, alive })[0]).toMatchObject({ state: "working", openIn: "claude-code", tool: "claude-code" });
		writeHolder(agentDir, { pid: 1, session: "s", claudePid: 2, state: "finishing", startedAt: NOW - 5000, updatedAt: NOW - 1000 });
		expect(agentOverview(config, { now: NOW, alive })[0].state).toBe("finishing");
		writeHolder(agentDir, { pid: 1, session: "s", claudePid: 2, state: "recording", startedAt: NOW - 50_000, updatedAt: NOW - 40_000 });
		expect(agentOverview(config, { now: NOW, alive })[0].state).toBe("closed");
	});

	it("reads a Codex session's heartbeat as open in Codex (working when busy), and guesses Codex as the tool", () => {
		const { config, agentDir } = setup();
		writeHolder(agentDir, { pid: 1, session: "s", claudePid: 2, host: "codex", state: "recording", startedAt: NOW - 5000, updatedAt: NOW - 1000 });
		writeFileSync(join(agentDir, "status.json"), JSON.stringify(status({ model: "codex", thinking: "codex", busy: true, updatedAt: localIso(new Date(NOW - 600_000)) })));
		expect(agentOverview(config, { now: NOW, alive })[0]).toMatchObject({ state: "working", openIn: "codex", tool: "codex", toolSet: false });
		writeFileSync(join(agentDir, "status.json"), JSON.stringify(status({ model: "codex", thinking: "codex", busy: false })));
		expect(agentOverview(config, { now: NOW, alive })[0]).toMatchObject({ state: "open", openIn: "codex" });
		// The heartbeat gone, a fresh status of the holder's still says Codex.
		writeHolder(agentDir, { pid: 1, session: "s", claudePid: 2, host: "codex", state: "recording", startedAt: NOW - 50_000, updatedAt: NOW - 40_000 });
		expect(agentOverview(config, { now: NOW, alive })[0]).toMatchObject({ state: "open", openIn: "codex", tool: "codex" });
	});

	it("reads memory read-only: counts, last message, waiting summaries, and a model chosen in chat", () => {
		const { config, agentDir } = setup();
		const store = MemoryStore.open(join(agentDir, "memory.sqlite"));
		store.appendBatch([
			{ kind: "user", text: "one", date: "2026-10-08T10:00:00.000Z" },
			{ kind: "talk", text: "two", date: "2026-10-08T11:00:00.000Z" },
		]);
		store.setMeta("lane.compactor-model", JSON.stringify({ provider: "anthropic", modelId: "claude-haiku-4-5", thinking: "off" }));
		store.close();
		const cache = new OverviewCache();
		const [a] = agentOverview(config, { now: NOW, alive, cache });
		expect(a).toMatchObject({ hasMemory: true, messages: 2, lastMessageAt: "2026-10-08T11:00:00.000Z" });
		expect(a.summaryModel).toEqual({ ref: "anthropic/claude-haiku-4-5", thinking: "off", source: "chat" });
		expect(a.summary.state).toBe("waiting");
		expect(summaryText(a)).toBe(`waiting (${a.summary.waiting})`);
		expect(agentOverview(config, { now: NOW, alive, cache })[0]).toEqual(a);
	});

	it("shows an agent whose memory cannot be read as unreadable, and keeps going", () => {
		const { config, agentDir } = setup();
		writeFileSync(join(agentDir, "memory.sqlite"), "this is not sqlite");
		const rows = agentOverview(config, { now: NOW, alive });
		expect(rows[0].unreadable).toBeTruthy();
		// Never "ok" for an agent whose memory orrery cannot read (orrery status --json reports this).
		expect(rows[0].summary).toEqual({ state: "stopped", waiting: 0, plain: `memory unreadable: ${rows[0].unreadable}` });
		expect(summaryText(rows[0])).toMatch(/^stopped: memory unreadable: /);
		expect(rows[1].name).toBe("B");
	});

	it("treats a live, fresh status.json without the compactor's model, or with a trouble without words, as no status", () => {
		const { config, agentDir } = setup();
		const { model: _gone, ...noModel } = status({}).compactor;
		for (const fields of [{ compactor: noModel }, { trouble: { state: "failing" } }, { trouble: "failing" }, { compactor: { ...noModel, model: 7 } }, { compactor: { ...status({}).compactor, source: 3 } }]) {
			writeFileSync(join(agentDir, "status.json"), JSON.stringify(status(fields)));
			const rows = agentOverview(config, { now: NOW, alive });
			expect(rows.map((r) => [r.name, r.state]), JSON.stringify(fields)).toEqual([["A", "closed"], ["B", "closed"]]);
			expect(rows[0].unreadable).toBeUndefined();
			expect(rows[0].summaryModel).toEqual({ ref: "openai/gpt-6.1-sol", thinking: "low", source: "config" });
		}
	});

	it("shows an agent that throws while being read as unreadable; the other agents still show", () => {
		const { config, agentDir } = setup();
		writeFileSync(join(agentDir, "status.json"), JSON.stringify(status({})));
		const rows = agentOverview(config, { now: NOW, alive: () => { throw new Error("no \x1b[31mprocess table"); } });
		expect(rows.map((r) => r.name)).toEqual(["A", "B"]);
		expect(rows[0]).toMatchObject({ name: "A", state: "closed", unreadable: "no process table", summary: { state: "stopped", waiting: 0, plain: "memory unreadable: no process table" } });
		expect(rows[1]).toMatchObject({ name: "B", tool: "codex", state: "closed" });
		expect(rows[1].unreadable).toBeUndefined();
	});

	it("shows a thinking level it does not know as ? and an unknown source as the config", () => {
		const { config, agentDir } = setup();
		writeFileSync(join(agentDir, "status.json"), JSON.stringify(status({ compactor: { ...status({}).compactor, thinking: "ultra\x1b[31m", source: "elsewhere" } })));
		const [a] = agentOverview(config, { now: NOW, alive });
		expect(a.state).toBe("open");
		expect(a.summaryModel).toEqual({ ref: "openai/gpt-6.1-sol", thinking: "?", source: "config" });
	});

	it("gives each agent the day of its newest backup, read once per overview", () => {
		const { config } = setup();
		mkdirSync(join(config.dataDir, "backups", "2026-10-07", "A"), { recursive: true });
		mkdirSync(join(config.dataDir, "backups", "2026-10-08", "B"), { recursive: true });
		const [a, b] = agentOverview(config, { now: NOW, alive });
		expect(a.lastBackup).toBe("2026-10-07");
		expect(b.lastBackup).toBe("2026-10-08");
		rmSync(join(config.dataDir, "backups"), { recursive: true });
		expect(agentOverview(config, { now: NOW, alive })[0].lastBackup).toBeUndefined();
		expect("lastBackup" in agentOverview(config, { now: NOW, alive })[0]).toBe(false);
	});

	it("says how long ago, in rough units", () => {
		expect(ago(undefined, NOW)).toBe("—");
		expect(ago(new Date(NOW - 20_000).toISOString(), NOW)).toBe("just now");
		expect(ago(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe("5 min");
		expect(ago(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe("3 h");
		expect(ago(new Date(NOW - 2 * 86_400_000).toISOString(), NOW)).toBe("2 d");
	});
});

describe("agentUsage", () => {
	it("keeps the last N days per agent with memory", () => {
		const { config, agentDir } = setup();
		const store = MemoryStore.open(join(agentDir, "memory.sqlite"));
		store.recordUsage({ at: "2026-10-08T09:00:00.000Z", role: "compactor", model: "openai/gpt-6.1-sol", input: 100, cacheRead: 40, cacheWrite: 0, output: 5, ok: true });
		store.recordUsage({ at: "2026-09-01T09:00:00.000Z", role: "compactor", model: "openai/gpt-6.1-sol", input: 9, cacheRead: 0, cacheWrite: 0, output: 1, ok: true });
		store.close();
		const usage = agentUsage(config, 7, undefined, NOW);
		expect(usage).toHaveLength(1);
		expect(usage[0].name).toBe("A");
		expect(usage[0].rows.map((r) => r.input)).toEqual([100]);
	});
});

describe("summary cost", () => {
	const row = (model: string, input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({ at: "2026-10-08T09:00:00.000Z", role: "compactor" as const, model, input, cacheRead, cacheWrite, output, ok: true });
	const config = parseConfig(`[[providers]]\nid = "bonsai"\nbase_url = "http://127.0.0.1:8000/v1"\nmodels = [{ id = "q", context_window = 1000, max_tokens = 100 }]\n`, "/d");
	const price = (provider: string, id: string) => (`${provider}/${id}` === "openrouter/acme/m-1" ? { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2.5 } : undefined);

	it("prices a row from the catalog, splitting the provider at the first slash; the sign-in is plan, a local server is local", () => {
		expect(usageCost(row("openrouter/acme/m-1", 1_000_000, 100_000, 200_000, 40_000), config, price)).toEqual({ kind: "api", dollars: 2 + 0.8 + 0.1 + 0.1 });
		expect(usageCost(row("openai/gpt-6.1-sol", 1, 1), config, price)).toEqual({ kind: "plan" });
		expect(usageCost(row("bonsai/q", 1, 1), config, price)).toEqual({ kind: "local" });
		expect(usageCost(row("anthropic/unknown", 1, 1), config, price)).toEqual({ kind: "unknown" });
		expect(usageCost(row("no-slash", 1, 1), config, price)).toEqual({ kind: "unknown" });
		expect(usageCost(row("x/y", 1, 1), config, () => { throw new Error("no catalog"); })).toEqual({ kind: "unknown" });
	});

	it("adds rows up: unknown wins, then dollars, then plan, then local", () => {
		expect(totalCost([])).toBeUndefined();
		expect(totalCost([{ kind: "api", dollars: 1 }, { kind: "unknown" }])).toEqual({ kind: "unknown" });
		expect(totalCost([{ kind: "api", dollars: 1 }, { kind: "plan" }, { kind: "api", dollars: 0.5 }])).toEqual({ kind: "api", dollars: 1.5 });
		expect(totalCost([{ kind: "local" }, { kind: "plan" }])).toEqual({ kind: "plan" });
		expect(totalCost([{ kind: "local" }])).toEqual({ kind: "local" });
	});

	it("writes dollars with two decimals, and less than a cent as <$0.01", () => {
		expect([0, 0.0001, 0.0099, 0.01, 0.114, 12.345].map(dollarText)).toEqual(["$0.00", "<$0.01", "<$0.01", "$0.01", "$0.11", "$12.35"]);
	});
});
