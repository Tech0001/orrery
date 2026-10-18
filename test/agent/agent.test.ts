import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig, parseModelChoice } from "../../src/agent/config.ts";
import { INSTRUCTIONS_MAX_BYTES, writeInstructions } from "../../src/agent/instructions.ts";
import { Agent, readStatus } from "../../src/agent/agent.ts";
import { INSTRUCTIONS_KEY } from "../../src/remote/instructions-sync.ts";
import { statusVersion } from "../../src/agent/status-file.ts";
import { MemoryStore } from "../../src/memory/index.ts";
import { contextLines, ctx, fauxModels, agentConfigToml, tempDir } from "./support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture() {
	const dir = tempDir("orrery-agent-");
	dirs.push(dir);
	const folder = join(dir, "ws");
	mkdirSync(folder);
	const config = parseConfig(agentConfigToml({ dataDir: join(dir, "data"), folder }), dir);
	// The agent's instructions are its own (instructions.md in its data folder), not the folder's AGENTS.md.
	writeFileSync(join(folder, "AGENTS.md"), "The folder's own rules.");
	writeInstructions(config.agents.get("Test")!.dir, "You are the Test agent.");
	return { dir, folder, config };
}

describe("Agent", () => {
	it("answers, logs memory, writes status, and starts the next run from memory after a restart", async () => {
		const { config } = fixture();
		const { chat, models } = fauxModels();
		const seen: string[][] = [];
		chat.setResponses([
			(context) => {
				seen.push(contextLines(context));
				return fauxAssistantMessage("Noted: the codename is Cedar.");
			},
			(context) => {
				seen.push(contextLines(context));
				return fauxAssistantMessage("Cedar.");
			},
		]);
		const agent = await Agent.open({ config, agent: "Test", models, context: ctx });
		const first = await agent.submit("The codename is Cedar.", "r1");
		expect(first?.mode).toBe("run");
		await first?.submission.wait(ctx);
		await agent.projector.drain();
		expect(agent.store.root.map((m) => `${m.kind}: ${m.text}`)).toEqual(["user: The codename is Cedar.", "talk: Noted: the codename is Cedar."]);
		await agent.writeStatus();
		const status = readStatus(agent.config.dir);
		expect(status?.busy).toBe(false);
		expect(status?.model).toBe("faux-agent/faux-1");
		expect(status?.version).toBe("checkout");
		expect(seen[0][0]).toContain("You are the Test agent.");
		expect(seen[0][0]).not.toContain("The folder's own rules.");
		// The store keeps no copy: neither the key older builds wrote nor the one a remote agent's copy travels under.
		expect(agent.store.getMeta("instructions")).toBeUndefined();
		expect(agent.store.getMeta(INSTRUCTIONS_KEY)).toBeUndefined();
		await agent.close();

		// A removed instructions.md takes effect: the agent runs with memory only, even with an older build's copy in the store.
		rmSync(join(config.agents.get("Test")!.dir, "instructions.md"));
		const old = MemoryStore.open(join(config.agents.get("Test")!.dir, "memory.sqlite"));
		old.setMeta("instructions", "You are the Test agent.");
		old.close();
		const reopened = await Agent.open({ config, agent: "Test", models, context: ctx });
		expect(reopened.store.root).toHaveLength(2);
		expect(reopened.store.getMeta(INSTRUCTIONS_KEY)).toBeUndefined();
		const second = await reopened.submit("What is the codename?", "r2");
		await second?.submission.wait(ctx);
		expect(seen[1][0]).not.toContain("You are the Test agent.");
		expect(seen[1][0]).toContain("user: The codename is Cedar.");
		expect(seen[1].slice(1)).toEqual(["user:What is the codename?"]);
		await reopened.close();
	});

	it("keeps the agent and compactor models chosen in chat across a restart, until reset", async () => {
		const { config } = fixture();
		const configured = config.agents.get("Test")!;
		const { models } = fauxModels();
		const agent = await Agent.open({ config, agent: "Test", models, context: ctx });
		expect(agent.compactorModel).toEqual(configured.compactor.model);
		await agent.setModel(parseModelChoice("faux-compactor/faux-1", "off"));
		await agent.setCompactorModel(parseModelChoice("faux-agent/faux-1", "off"));
		await expect(agent.setCompactorModel(parseModelChoice("nobody/nothing", "off"))).rejects.toThrow(/Unknown model/);
		await agent.close();

		const reopened = await Agent.open({ config, agent: "Test", models, context: ctx });
		expect(reopened.model).toMatchObject({ provider: "faux-compactor", modelId: "faux-1" });
		expect(reopened.compactorModel).toMatchObject({ provider: "faux-agent", modelId: "faux-1", thinking: "off" });
		expect((await reopened.status()).compactor).toMatchObject({ model: "faux-agent/faux-1", thinking: "off", source: "chat" });
		// The restored agent model really answers: the faux compactor provider always says "user: summarized".
		const run = await reopened.submit("hello", "r1");
		await run?.submission.wait(ctx);
		await reopened.projector.drain();
		expect(reopened.store.root.at(-1)?.text).toBe("user: summarized");
		await reopened.setModel(undefined);
		await reopened.setCompactorModel(undefined);
		await reopened.close();

		const third = await Agent.open({ config, agent: "Test", models, context: ctx });
		expect(third.model).toEqual(configured.model);
		expect(third.compactorModel).toEqual(configured.compactor.model);
		expect((await third.status()).compactor).toMatchObject({ source: "config" });
		await third.close();
	});

	it("builds new summaries with the compactor chosen in chat", async () => {
		const { config } = fixture();
		const { chat, models } = fauxModels();
		chat.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage("user: summarized by the new compactor")));
		const agent = await Agent.open({ config, agent: "Test", models, context: ctx });
		await agent.setCompactorModel(parseModelChoice("faux-agent/faux-1", "off"));
		agent.view.append("user", `A long message. ${"detail ".repeat(200)}`);
		const end = Date.now() + 5000;
		while (agent.store.nodeCount < 1 && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
		expect([...agent.store.nodes()][0]?.text).toBe("user: summarized by the new compactor");
		expect(agent.store.usageRows().filter((r) => r.role === "compactor").map((r) => r.model)).toContain("faux-agent/faux-1");
		await agent.close();
	});

	it("calls onFatal when the memory store starts refusing writes", async () => {
		const { config } = fixture();
		const { chat, models } = fauxModels();
		chat.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		const reasons: string[] = [];
		const agent = await Agent.open({ config, agent: "Test", models, context: ctx, onFatal: (r) => reasons.push(r) });
		agent.report = () => {};
		const raw = new DatabaseSync(join(agent.config.dir, "memory.sqlite"));
		raw.exec("CREATE TRIGGER fail BEFORE INSERT ON main BEGIN SELECT RAISE(ABORT, 'disk failure'); END");
		raw.close();
		const result = await agent.submit("hello", "r1");
		await result?.submission.wait(ctx);
		await agent.projector.drain().catch(() => {});
		expect(reasons.length).toBeGreaterThan(0);
		await agent.close();
	});

	it("rejects an unknown agent model at open", async () => {
		const { config } = fixture();
		const { models } = fauxModels();
		const broken = { ...config, agents: new Map([["Test", { ...config.agents.get("Test")!, model: { provider: "nope", modelId: "x", thinking: "off" as const } }]]) };
		await expect(Agent.open({ config: broken, agent: "Test", models, context: ctx })).rejects.toThrow(/Unknown model nope\/x/);
		// A failed open must release the memory writer lock.
		const reopened = MemoryStore.open(join(broken.agents.get("Test")!.dir, "memory.sqlite"));
		reopened.close();
	});

	it("refuses to open (orrery run) with an OpenCode summary model in the config, in orrery compact's words, not as an unknown model", async () => {
		const { config } = fixture();
		const { models } = fauxModels();
		const agent = config.agents.get("Test")!;
		const onOpenCode = { ...config, agents: new Map([["Test", { ...agent, compactor: { ...agent.compactor, model: { provider: "opencode", modelId: "anthropic/claude-sonnet-4-5", thinking: "off" as const } } }]]) };
		await expect(Agent.open({ config: onOpenCode, agent: "Test", models, context: ctx })).rejects.toThrow(
			"Test's summary model in the config (opencode/anthropic/claude-sonnet-4-5) is an OpenCode model, which works only while Test is open in OpenCode: open it there, or set another compactor_model in Orrery's config to run it here.",
		);
		MemoryStore.open(join(agent.dir, "memory.sqlite")).close();
	});

	it("runs an agent without a folder in the folder it starts in, with its own instructions", async () => {
		const { dir, folder } = fixture();
		const config = parseConfig(agentConfigToml({ dataDir: join(dir, "data"), folder }).replace(/^folder = .*\n/m, ""), dir);
		expect(config.agents.get("Test")?.folder).toBeUndefined();
		const { chat, models } = fauxModels();
		const seen: string[][] = [];
		chat.setResponses([(context) => (seen.push(contextLines(context)), fauxAssistantMessage("Here."))]);
		vi.spyOn(process, "cwd").mockReturnValue(folder);
		try {
			const agent = await Agent.open({ config, agent: "Test", models, context: ctx });
			const run = await agent.submit("Hello.", "r1");
			await run?.submission.wait(ctx);
			expect(seen[0][0]).toContain("You are the Test agent.");
			expect(seen[0][0]).not.toContain("The folder's own rules.");
			await agent.close();
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("a blank instructions.md is none; over 32 KB the first 32 KB go out, with a notice", async () => {
		const { config } = fixture();
		const dir = config.agents.get("Test")!.dir;
		const { chat, models } = fauxModels();
		const seen: string[][] = [];
		chat.setResponses([(context) => (seen.push(contextLines(context)), fauxAssistantMessage("One.")), (context) => (seen.push(contextLines(context)), fauxAssistantMessage("Two."))]);
		writeInstructions(dir, " \n\t\n");
		const blank = await Agent.open({ config, agent: "Test", models, context: ctx });
		expect(blank.store.getMeta("instructions")).toBeUndefined();
		await (await blank.submit("Hello.", "r1"))?.submission.wait(ctx);
		await blank.close();
		expect(seen[0][0]).not.toContain("You are the Test agent.");
		writeInstructions(dir, `${"a".repeat(INSTRUCTIONS_MAX_BYTES)}TAIL`);
		const said: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => (said.push(String(chunk)), true));
		try {
			const long = await Agent.open({ config, agent: "Test", models, context: ctx });
			await (await long.submit("Hello again.", "r2"))?.submission.wait(ctx);
			await long.close();
		} finally {
			vi.restoreAllMocks();
		}
		expect(said).toContain("Orrery: Test's instructions are over 32 KB; only the first 32 KB reach the model. Shorten instructions.md.\n");
		expect(seen[1][0]).toContain("a".repeat(INSTRUCTIONS_MAX_BYTES));
		expect(seen[1][0]).not.toContain("TAIL");
	});

	it("refuses to run an agent that has no agent model", async () => {
		const dir = tempDir("orrery-nomodel-");
		dirs.push(dir);
		const config = parseConfig(`data_dir = ${JSON.stringify(dir)}\n[agents.A]\nfolder = ${JSON.stringify(dir)}\ncompactor_model = "faux-compactor/faux-1"\n`, dir);
		await expect(Agent.open({ config, agent: "A", models: fauxModels().models })).rejects.toThrow('A has no model in the config; orrery run needs one (model = "provider/id").');
	});
});

it("reads a status file with or without the version it runs, but not one whose version is not a string", () => {
	const dir = tempDir("orrery-status-");
	dirs.push(dir);
	const status = { agent: "A", pid: 1, busy: false, model: "pi", thinking: "pi", compactor: { stopped: false, failing: 0, model: "a/b", thinking: "off", source: "config" }, lastError: null, updatedAt: "2026-10-13T10:00:00.000Z" };
	const read = (extra: object) => {
		writeFileSync(join(dir, "status.json"), JSON.stringify({ ...status, ...extra }));
		return readStatus(dir);
	};
	expect(read({})?.version).toBeUndefined();
	expect(read({ version: "0.6.0-abc1234" })?.version).toBe("0.6.0-abc1234");
	expect(read({ version: 6 })).toBeUndefined();
	// A status write never throws over the home: an ORRERY_HOME orrery cannot use records "unknown".
	const before = process.env.ORRERY_HOME;
	process.env.ORRERY_HOME = "relative/home";
	try {
		expect(statusVersion()).toBe("unknown");
	} finally {
		if (before === undefined) delete process.env.ORRERY_HOME;
		else process.env.ORRERY_HOME = before;
	}
});
