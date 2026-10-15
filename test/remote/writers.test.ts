import { existsSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compactCommand, importCommitCommand } from "../../src/cli/commands.ts";
import { restoreAgent } from "../../src/agent/backup.ts";
import { COMPACTOR_MODEL_KEY } from "../../src/agent/choices.ts";
import { agentCompactorTarget } from "../../src/agent/compactor-target.ts";
import { INSTRUCTIONS_MAX_BYTES, writeInstructions } from "../../src/agent/instructions.ts";
import { readStatus } from "../../src/agent/status-file.ts";
import { agentOpenHere } from "../../src/remote/read-copy.ts";
import { Agent } from "../../src/agent/agent.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import { attachRemoteStore, withBriefCheckOut } from "../../src/remote/checkout.ts";
import { INSTRUCTIONS_KEY } from "../../src/remote/instructions-sync.ts";
import * as remotes from "../../src/remote/index.ts";
import { decodeRows, encodeSnapshot, agentSettings, snapshotBytes } from "../../src/remote/save-format.ts";
import { seal, unseal } from "../../src/remote/crypto.ts";
import { RemoteSession } from "../../src/remote/session.ts";
import { RemoteError, STALE_MS } from "../../src/remote/types.ts";
import { ctx, fauxModels } from "../agent/support.ts";
import { checkoutFixture } from "./checkout-fixture.ts";

let f: Awaited<ReturnType<typeof checkoutFixture>>;
let agent: Agent | undefined;
beforeEach(async () => { f = await checkoutFixture(); vi.spyOn(remotes, "openStorage").mockImplementation(() => f.storage); });
afterEach(async () => { await agent?.close(); agent = undefined; vi.restoreAllMocks(); f.close(); });
async function rows() {
	return (await f.storage.fetch("Test", 0)).saves.map((s) => decodeRows(unseal(f.key, "Test", "save", s.n, s.file)));
}
async function held() { await f.storage.take("Test", { machine: "macbook", device: "other", pid: 1 }); }

describe("brief writers", () => {
	it("saves and releases an unattached writer, including partial writes before an error", async () => {
		await expect(withBriefCheckOut(f.config, f.agent, (_remote, writer) => {
			const store = MemoryStore.open(join(f.agent.dir, "memory.sqlite"), writer);
			try { store.append("talk", "before error"); } finally { store.close(); }
			throw new Error("write failed");
		}, () => {})).rejects.toThrow("write failed");
		expect(JSON.stringify(await rows())).toContain("before error");
		expect((await f.storage.list())[0].lock?.held).toBe(false);
	});
	it("refuses success when takeover is discovered by the final save", async () => {
		await expect(withBriefCheckOut(f.config, f.agent, async (remote, writer) => {
			const store = MemoryStore.open(join(f.agent.dir, "memory.sqlite"), writer);
			attachRemoteStore(remote!, store);
			store.append("talk", "local only");
			f.clock.value += STALE_MS + 1;
			await f.storage.take("Test", { machine: "macbook", device: "other", pid: 1 }, { force: true });
			return "success";
		}, () => {})).rejects.toMatchObject({ kind: "lock-lost" });
		expect((await f.storage.fetch("Test", 0)).newestSave).toBe(0);
	});

	it("keeps renewal active during a long write and closes the writer on loss", async () => {
		let writable = true;
		await expect(withBriefCheckOut(f.config, f.agent, async (remote, writer) => {
			const store = MemoryStore.open(join(f.agent.dir, "memory.sqlite"), writer);
			attachRemoteStore(remote!, store);
			await remote!.renew();
			f.clock.value += STALE_MS + 1;
			await f.storage.take("Test", { machine: "macbook", device: "other", pid: 1 }, { force: true });
			await remote!.renew();
			writable = store.writable;
		}, () => {})).rejects.toMatchObject({ kind: "lock-lost" });
		expect(writable).toBe(false);
	});
	it("compaction refuses a remotely held agent before opening a local writer", async () => {
		await held();
		await expect(compactCommand(f.config, "Test", fauxModels().models)).rejects.toThrow(/Test is open on macbook \(last seen/);
		expect(existsSync(join(f.agent.dir, "memory.sqlite"))).toBe(false);
	});
	it("compaction restores, summarizes, saves and releases", async () => {
		await withBriefCheckOut(f.config, f.agent, (_remote, writer) => {
			const store = MemoryStore.open(join(f.agent.dir, "memory.sqlite"), writer);
			store.append("talk", "a long answer ".repeat(300));
			store.close();
		}, () => {});
		await compactCommand(f.config, "Test", fauxModels().models);
		expect(JSON.stringify(await rows())).toContain("user: summarized");
		expect((await f.storage.list())[0].lock?.held).toBe(false);
	});
	it("a compactor startup failure releases both the local writer and the remote lock", async () => {
		const { models } = fauxModels();
		const bad = { ...f.config, agents: new Map([["Test", { ...f.agent, compactor: { ...f.agent.compactor, model: { provider: "missing", modelId: "missing", thinking: "off" as const } } }]]) };
		await expect(compactCommand(bad, "Test", models)).rejects.toThrow("Unknown model");
		expect((await f.storage.list())[0].lock?.held).toBe(false);
		const probe = MemoryStore.open(join(f.agent.dir, "memory.sqlite"));
		probe.close();
	});

	it("a closed agent's summary-model switch saves the choice remotely", async () => {
		const choice = { provider: "faux-agent", modelId: "faux-1", thinking: "off" as const };
		await agentCompactorTarget(f.config, "Test").apply(choice);
		expect(JSON.stringify(await rows())).toContain(COMPACTOR_MODEL_KEY);
		expect(JSON.stringify(await rows())).toContain("faux-agent");
		expect((await f.storage.list())[0].lock?.held).toBe(false);
	});
	it("a closed summary-model switch cannot bypass a remote holder", async () => {
		await held();
		await expect(agentCompactorTarget(f.config, "Test").apply(undefined)).rejects.toThrow("Test is open on macbook");
		expect(existsSync(join(f.agent.dir, "memory.sqlite"))).toBe(false);
	});
});

it("import --commit and restore refuse remote agents before reading inputs or changing memory", () => {
	const message = "Test keeps its memory on remote home; run orrery agent local Test first";
	expect(() => importCommitCommand(f.config, "Test", "/missing-preview")).toThrow(message);
	expect(() => restoreAgent(f.config, "Test", { from: "/missing-backup" })).toThrow(message);
	expect(existsSync(join(f.agent.dir, "memory.sqlite"))).toBe(false);
});

describe("orrery run", () => {
	it("checks out before starting, sends the completed turn and releases on stop", async () => {
		const { chat, models } = fauxModels();
		chat.setResponses([fauxAssistantMessage("remote run reply")]);
		agent = await Agent.open({ config: f.config, agent: "Test", models, context: ctx });
		expect(agent.store.root[0].text).toBe("from the remote");
		const result = await agent.submit("hello", "remote-run");
		await result?.submission.wait(ctx);
		await vi.waitFor(async () => expect(JSON.stringify(await rows())).toContain("remote run reply"));
		await agent.close(); agent = undefined;
		expect((await f.storage.list())[0].lock?.held).toBe(false);
	});
	it("sends the whole instructions.md, never only the 32 KB that reach the model", async () => {
		const long = `${"a".repeat(INSTRUCTIONS_MAX_BYTES)}TAIL\n`;
		writeInstructions(f.agent.dir, long);
		agent = await Agent.open({ config: f.config, agent: "Test", models: fauxModels().models, context: ctx });
		await agent.close(); agent = undefined;
		expect((await rows()).map((r) => r.meta[INSTRUCTIONS_KEY]).filter((text) => text !== undefined)).toEqual([long]);
	});
	it("refuses a remotely held agent before starting the harness", async () => {
		await held();
		await expect(Agent.open({ config: f.config, agent: "Test", models: fauxModels().models })).rejects.toThrow("Test is open on macbook");
		expect(existsSync(join(f.agent.dir, "session.sqlite"))).toBe(false);
	});
	it("continues running without recording after another machine takes over", async () => {
		const { chat, models } = fauxModels();
		chat.setResponses([fauxAssistantMessage("after takeover")]);
		const fatal = vi.fn();
		agent = await Agent.open({ config: f.config, agent: "Test", models, context: ctx, onFatal: fatal });
		f.clock.value += STALE_MS + 1;
		await f.storage.take("Test", { machine: "macbook", device: "other", pid: 1 }, { force: true });
		await agent.remote!.renew();
		const result = await agent.submit("continue", "after-takeover");
		await result?.submission.wait(ctx);
		expect(agent.store.writable).toBe(false);
		expect(agent.store.root.map((m) => m.text)).toEqual(["from the remote"]);
		expect(fatal).not.toHaveBeenCalled();
		await agent.close(); agent = undefined;
		expect((await f.storage.fetch("Test", 0)).newestSave).toBe(0);
	});

	it("marks a lost durable agent closed before returning from renewal and keeps it closed", async () => {
		agent = await Agent.open({ config: f.config, agent: "Test", models: fauxModels().models, context: ctx });
		expect(agentOpenHere(f.agent)).toBe(true);
		f.clock.value += STALE_MS + 1;
		await f.storage.take("Test", { machine: "macbook", device: "other", pid: 1 }, { force: true });
		await agent.remote!.renew();
		expect(agent.store.writable).toBe(false);
		expect(readStatus(f.agent.dir)).toMatchObject({ open: false, busy: false });
		expect(agentOpenHere(f.agent)).toBe(false);
		await agent.writeStatus();
		expect(readStatus(f.agent.dir)).toMatchObject({ open: false, busy: false });
	});

	it.each([false, true])("does not replay local history after a snapshot (split history: %s)", async (split) => {
		const { chat, models } = fauxModels();
		chat.setResponses([fauxAssistantMessage("one reply")]);
		agent = await Agent.open({ config: f.config, agent: "Test", models, context: ctx });
		const result = await agent.submit("one prompt", "one");
		await result?.submission.wait(ctx);
		await agent.projector.drain();
		await agent.close(); agent = undefined;
		if (split) {
			chat.setResponses([fauxAssistantMessage("discarded reply")]);
			agent = await Agent.open({ config: f.config, agent: "Test", models, context: ctx });
			const offline = vi.spyOn(f.storage, "save").mockRejectedValue(new RemoteError("unreachable", "offline"));
			const unsaved = await agent.submit("discarded prompt", "unsaved");
			await unsaved?.submission.wait(ctx);
			await agent.projector.drain();
			await agent.close(); agent = undefined;
			offline.mockRestore();
		}
		const otherDir = join(f.root, "other-machine");
		const other = await RemoteSession.checkOut({ agent: "Test", agentDir: otherDir, storage: f.storage, key: f.key, holder: { machine: "macbook", device: "other", pid: 1 }, report: () => {}, settings: agentSettings(f.agent) });
		const writer = MemoryStore.open(join(otherDir, "memory.sqlite"));
		other.attach(writer);
		writer.append("user", "other machine");
		await other.save();
		const entry = (await f.storage.list())[0];
		await f.storage.snapshot("Test", entry.lock!.lock, entry.newestSave, seal(f.key, "Test", "snapshot", entry.newestSave, encodeSnapshot({ v: 1, n: entry.newestSave, lock: entry.lock!.lock, machine: "macbook", at: new Date().toISOString(), settings: agentSettings(f.agent) }, snapshotBytes(writer.path))));
		await other.close(); writer.close();
		agent = await Agent.open({ config: f.config, agent: "Test", models, context: ctx });
		expect(agent.store.root.map((m) => m.text)).toEqual(["from the remote", "one prompt", "one reply", "other machine"]);
	});
	it("unblocks a pending submit without memory when loss interrupts summary settling", async () => {
		const { chat, models } = fauxModels();
		chat.setResponses([fauxAssistantMessage("continued")]);
		agent = await Agent.open({ config: f.config, agent: "Test", models, context: ctx });
		agent.compactor.summarizer = { summarize: () => new Promise(() => {}) };
		agent.view.append("talk", "long waiting answer ".repeat(5000));
		expect(agent.view.settled).toBe(false);
		let finished = false;
		const submission = agent.submit("continue", "waiting").then((result) => { finished = true; return result; });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(finished).toBe(false);
		f.clock.value += STALE_MS + 1;
		await f.storage.take("Test", { machine: "macbook", device: "other", pid: 1 }, { force: true });
		await agent.remote!.renew();
		await vi.waitFor(() => expect(finished).toBe(true));
		await (await submission)?.submission.wait(ctx);
		expect(agent.store.root.at(-1)?.text).not.toBe("continued");
	});

	it("unblocks a pending submit when loss interrupts projector catch-up", async () => {
		const { chat, models } = fauxModels();
		chat.setResponses([fauxAssistantMessage("continued")]);
		agent = await Agent.open({ config: f.config, agent: "Test", models, context: ctx });
		await new Promise((resolve) => setTimeout(resolve, 20));
		let release!: () => void;
		const stalled = new Promise<void>((resolve) => { release = resolve; });
		const drain = vi.spyOn(agent.projector, "drain").mockReturnValue(stalled);
		let finished = false;
		const submission = agent.submit("continue", "projector-wait").then((result) => { finished = true; return result; });
		try {
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(finished).toBe(false);
			f.clock.value += STALE_MS + 1;
			await f.storage.take("Test", { machine: "macbook", device: "other", pid: 1 }, { force: true });
			await agent.remote!.renew();
			await vi.waitFor(() => expect(finished).toBe(true));
			await (await submission)?.submission.wait(ctx);
		} finally { release(); drain.mockRestore(); await submission.catch(() => {}); }
	});

	it("releases checkout if the configured model cannot open", async () => {
		const broken = { ...f.config, agents: new Map([["Test", { ...f.agent, model: { provider: "missing", modelId: "missing", thinking: "off" as const } }]]) };
		await expect(Agent.open({ config: broken, agent: "Test", models: fauxModels().models })).rejects.toThrow("Unknown model");
		expect((await f.storage.list())[0].lock?.held).toBe(false);
	});
});
