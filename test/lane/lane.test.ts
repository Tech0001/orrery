import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig, parseModelChoice } from "../../src/lane/config.ts";
import { INSTRUCTIONS_MAX_BYTES, writeInstructions } from "../../src/lane/instructions.ts";
import { Lane, readStatus } from "../../src/lane/lane.ts";
import { INSTRUCTIONS_KEY } from "../../src/remote/instructions-sync.ts";
import { statusVersion } from "../../src/lane/status-file.ts";
import { MemoryStore } from "../../src/memory/index.ts";
import { contextLines, ctx, fauxModels, laneConfigToml, tempDir } from "./support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture() {
	const dir = tempDir("orrery-lane-");
	dirs.push(dir);
	const workspace = join(dir, "ws");
	mkdirSync(workspace);
	const config = parseConfig(laneConfigToml({ dataDir: join(dir, "data"), workspace }), dir);
	// The lane's instructions are its own (instructions.md in its data folder), not the workspace's AGENTS.md.
	writeFileSync(join(workspace, "AGENTS.md"), "The workspace's own rules.");
	writeInstructions(config.lanes.get("Test")!.dir, "You are the Test lane.");
	return { dir, workspace, config };
}

describe("Lane", () => {
	it("answers, logs memory, writes status, and starts the next run from memory after a restart", async () => {
		const { config } = fixture();
		const { agent, models } = fauxModels();
		const seen: string[][] = [];
		agent.setResponses([
			(context) => {
				seen.push(contextLines(context));
				return fauxAssistantMessage("Noted: the codename is Cedar.");
			},
			(context) => {
				seen.push(contextLines(context));
				return fauxAssistantMessage("Cedar.");
			},
		]);
		const lane = await Lane.open({ config, lane: "Test", models, context: ctx });
		const first = await lane.submit("The codename is Cedar.", "r1");
		expect(first?.mode).toBe("run");
		await first?.submission.wait(ctx);
		await lane.projector.drain();
		expect(lane.store.root.map((m) => `${m.kind}: ${m.text}`)).toEqual(["user: The codename is Cedar.", "talk: Noted: the codename is Cedar."]);
		await lane.writeStatus();
		const status = readStatus(lane.config.dir);
		expect(status?.busy).toBe(false);
		expect(status?.model).toBe("faux-agent/faux-1");
		expect(status?.version).toBe("checkout");
		expect(seen[0][0]).toContain("You are the Test lane.");
		expect(seen[0][0]).not.toContain("The workspace's own rules.");
		// The store keeps no copy: neither the key older builds wrote nor the one a remote agent's copy travels under.
		expect(lane.store.getMeta("instructions")).toBeUndefined();
		expect(lane.store.getMeta(INSTRUCTIONS_KEY)).toBeUndefined();
		await lane.close();

		// A removed instructions.md takes effect: the lane runs with memory only, even with an older build's copy in the store.
		rmSync(join(config.lanes.get("Test")!.dir, "instructions.md"));
		const old = MemoryStore.open(join(config.lanes.get("Test")!.dir, "memory.sqlite"));
		old.setMeta("instructions", "You are the Test lane.");
		old.close();
		const reopened = await Lane.open({ config, lane: "Test", models, context: ctx });
		expect(reopened.store.root).toHaveLength(2);
		expect(reopened.store.getMeta(INSTRUCTIONS_KEY)).toBeUndefined();
		const second = await reopened.submit("What is the codename?", "r2");
		await second?.submission.wait(ctx);
		expect(seen[1][0]).not.toContain("You are the Test lane.");
		expect(seen[1][0]).toContain("user: The codename is Cedar.");
		expect(seen[1].slice(1)).toEqual(["user:What is the codename?"]);
		await reopened.close();
	});

	it("keeps the agent and compactor models chosen in chat across a restart, until reset", async () => {
		const { config } = fixture();
		const configured = config.lanes.get("Test")!;
		const { models } = fauxModels();
		const lane = await Lane.open({ config, lane: "Test", models, context: ctx });
		expect(lane.compactorModel).toEqual(configured.compactor.model);
		await lane.setModel(parseModelChoice("faux-compactor/faux-1", "off"));
		await lane.setCompactorModel(parseModelChoice("faux-agent/faux-1", "off"));
		await expect(lane.setCompactorModel(parseModelChoice("nobody/nothing", "off"))).rejects.toThrow(/Unknown model/);
		await lane.close();

		const reopened = await Lane.open({ config, lane: "Test", models, context: ctx });
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

		const third = await Lane.open({ config, lane: "Test", models, context: ctx });
		expect(third.model).toEqual(configured.model);
		expect(third.compactorModel).toEqual(configured.compactor.model);
		expect((await third.status()).compactor).toMatchObject({ source: "config" });
		await third.close();
	});

	it("builds new summaries with the compactor chosen in chat", async () => {
		const { config } = fixture();
		const { agent, models } = fauxModels();
		agent.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage("user: summarized by the new compactor")));
		const lane = await Lane.open({ config, lane: "Test", models, context: ctx });
		await lane.setCompactorModel(parseModelChoice("faux-agent/faux-1", "off"));
		lane.view.append("user", `A long message. ${"detail ".repeat(200)}`);
		const end = Date.now() + 5000;
		while (lane.store.nodeCount < 1 && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
		expect([...lane.store.nodes()][0]?.text).toBe("user: summarized by the new compactor");
		expect(lane.store.usageRows().filter((r) => r.role === "compactor").map((r) => r.model)).toContain("faux-agent/faux-1");
		await lane.close();
	});

	it("calls onFatal when the memory store starts refusing writes", async () => {
		const { config } = fixture();
		const { agent, models } = fauxModels();
		agent.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		const reasons: string[] = [];
		const lane = await Lane.open({ config, lane: "Test", models, context: ctx, onFatal: (r) => reasons.push(r) });
		lane.report = () => {};
		const raw = new DatabaseSync(join(lane.config.dir, "memory.sqlite"));
		raw.exec("CREATE TRIGGER fail BEFORE INSERT ON main BEGIN SELECT RAISE(ABORT, 'disk failure'); END");
		raw.close();
		const result = await lane.submit("hello", "r1");
		await result?.submission.wait(ctx);
		await lane.projector.drain().catch(() => {});
		expect(reasons.length).toBeGreaterThan(0);
		await lane.close();
	});

	it("rejects an unknown agent model at open", async () => {
		const { config } = fixture();
		const { models } = fauxModels();
		const broken = { ...config, lanes: new Map([["Test", { ...config.lanes.get("Test")!, model: { provider: "nope", modelId: "x", thinking: "off" as const } }]]) };
		await expect(Lane.open({ config: broken, lane: "Test", models, context: ctx })).rejects.toThrow(/Unknown model nope\/x/);
		// A failed open must release the memory writer lock.
		const reopened = MemoryStore.open(join(broken.lanes.get("Test")!.dir, "memory.sqlite"));
		reopened.close();
	});

	it("runs a lane without a workspace in the folder it starts in, with its own instructions", async () => {
		const { dir, workspace } = fixture();
		const config = parseConfig(laneConfigToml({ dataDir: join(dir, "data"), workspace }).replace(/^workspace = .*\n/m, ""), dir);
		expect(config.lanes.get("Test")?.workspace).toBeUndefined();
		const { agent, models } = fauxModels();
		const seen: string[][] = [];
		agent.setResponses([(context) => (seen.push(contextLines(context)), fauxAssistantMessage("Here."))]);
		vi.spyOn(process, "cwd").mockReturnValue(workspace);
		try {
			const lane = await Lane.open({ config, lane: "Test", models, context: ctx });
			const run = await lane.submit("Hello.", "r1");
			await run?.submission.wait(ctx);
			expect(seen[0][0]).toContain("You are the Test lane.");
			expect(seen[0][0]).not.toContain("The workspace's own rules.");
			await lane.close();
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("a blank instructions.md is none; over 32 KB the first 32 KB go out, with a notice", async () => {
		const { config } = fixture();
		const dir = config.lanes.get("Test")!.dir;
		const { agent, models } = fauxModels();
		const seen: string[][] = [];
		agent.setResponses([(context) => (seen.push(contextLines(context)), fauxAssistantMessage("One.")), (context) => (seen.push(contextLines(context)), fauxAssistantMessage("Two."))]);
		writeInstructions(dir, " \n\t\n");
		const blank = await Lane.open({ config, lane: "Test", models, context: ctx });
		expect(blank.store.getMeta("instructions")).toBeUndefined();
		await (await blank.submit("Hello.", "r1"))?.submission.wait(ctx);
		await blank.close();
		expect(seen[0][0]).not.toContain("You are the Test lane.");
		writeInstructions(dir, `${"a".repeat(INSTRUCTIONS_MAX_BYTES)}TAIL`);
		const said: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => (said.push(String(chunk)), true));
		try {
			const long = await Lane.open({ config, lane: "Test", models, context: ctx });
			await (await long.submit("Hello again.", "r2"))?.submission.wait(ctx);
			await long.close();
		} finally {
			vi.restoreAllMocks();
		}
		expect(said).toContain("Orrery: Test's instructions are over 32 KB; only the first 32 KB reach the model. Shorten instructions.md.\n");
		expect(seen[1][0]).toContain("a".repeat(INSTRUCTIONS_MAX_BYTES));
		expect(seen[1][0]).not.toContain("TAIL");
	});

	it("refuses to run a lane that has no agent model", async () => {
		const dir = tempDir("orrery-nomodel-");
		dirs.push(dir);
		const config = parseConfig(`data_dir = ${JSON.stringify(dir)}\n[lanes.A]\nworkspace = ${JSON.stringify(dir)}\ncompactor_model = "faux-compactor/faux-1"\n`, dir);
		await expect(Lane.open({ config, lane: "A", models: fauxModels().models })).rejects.toThrow('A has no model in the config; orrery run needs one (model = "provider/id").');
	});
});

it("reads a status file with or without the version it runs, but not one whose version is not a string", () => {
	const dir = tempDir("orrery-status-");
	dirs.push(dir);
	const status = { lane: "A", pid: 1, busy: false, model: "pi", thinking: "pi", compactor: { stopped: false, failing: 0, model: "a/b", thinking: "off", source: "config" }, lastError: null, updatedAt: "2026-10-13T10:00:00.000Z" };
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
