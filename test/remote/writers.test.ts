import { existsSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compactCommand, importCommitCommand } from "../../src/cli/commands.ts";
import { restoreLane } from "../../src/lane/backup.ts";
import { COMPACTOR_MODEL_KEY } from "../../src/lane/choices.ts";
import { laneCompactorTarget } from "../../src/lane/compactor-target.ts";
import { INSTRUCTIONS_MAX_BYTES, writeInstructions } from "../../src/lane/instructions.ts";
import { readStatus } from "../../src/lane/status-file.ts";
import { laneOpenHere } from "../../src/remote/read-copy.ts";
import { Lane } from "../../src/lane/lane.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import { attachRemoteStore, withBriefCheckOut } from "../../src/remote/checkout.ts";
import { INSTRUCTIONS_KEY } from "../../src/remote/instructions-sync.ts";
import * as remotes from "../../src/remote/index.ts";
import { decodeRows, encodeSnapshot, laneSettings, snapshotBytes } from "../../src/remote/save-format.ts";
import { seal, unseal } from "../../src/remote/crypto.ts";
import { RemoteSession } from "../../src/remote/session.ts";
import { RemoteError, STALE_MS } from "../../src/remote/types.ts";
import { ctx, fauxModels } from "../lane/support.ts";
import { checkoutFixture } from "./checkout-fixture.ts";

let f: Awaited<ReturnType<typeof checkoutFixture>>;
let lane: Lane | undefined;
beforeEach(async () => { f = await checkoutFixture(); vi.spyOn(remotes, "openStorage").mockImplementation(() => f.storage); });
afterEach(async () => { await lane?.close(); lane = undefined; vi.restoreAllMocks(); f.close(); });
async function rows() {
	return (await f.storage.fetch("Test", 0)).saves.map((s) => decodeRows(unseal(f.key, "Test", "save", s.n, s.file)));
}
async function held() { await f.storage.take("Test", { machine: "macbook", device: "other", pid: 1 }); }

describe("brief writers", () => {
	it("saves and releases an unattached writer, including partial writes before an error", async () => {
		await expect(withBriefCheckOut(f.config, f.lane, (_remote, writer) => {
			const store = MemoryStore.open(join(f.lane.dir, "memory.sqlite"), writer);
			try { store.append("talk", "before error"); } finally { store.close(); }
			throw new Error("write failed");
		}, () => {})).rejects.toThrow("write failed");
		expect(JSON.stringify(await rows())).toContain("before error");
		expect((await f.storage.list())[0].lock?.held).toBe(false);
	});
	it("refuses success when takeover is discovered by the final save", async () => {
		await expect(withBriefCheckOut(f.config, f.lane, async (remote, writer) => {
			const store = MemoryStore.open(join(f.lane.dir, "memory.sqlite"), writer);
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
		await expect(withBriefCheckOut(f.config, f.lane, async (remote, writer) => {
			const store = MemoryStore.open(join(f.lane.dir, "memory.sqlite"), writer);
			attachRemoteStore(remote!, store);
			await remote!.renew();
			f.clock.value += STALE_MS + 1;
			await f.storage.take("Test", { machine: "macbook", device: "other", pid: 1 }, { force: true });
			await remote!.renew();
			writable = store.writable;
		}, () => {})).rejects.toMatchObject({ kind: "lock-lost" });
		expect(writable).toBe(false);
	});
	it("compaction refuses a remotely held lane before opening a local writer", async () => {
		await held();
		await expect(compactCommand(f.config, "Test", fauxModels().models)).rejects.toThrow(/Test is open on macbook \(last seen/);
		expect(existsSync(join(f.lane.dir, "memory.sqlite"))).toBe(false);
	});
	it("compaction restores, summarizes, saves and releases", async () => {
		await withBriefCheckOut(f.config, f.lane, (_remote, writer) => {
			const store = MemoryStore.open(join(f.lane.dir, "memory.sqlite"), writer);
			store.append("talk", "a long answer ".repeat(300));
			store.close();
		}, () => {});
		await compactCommand(f.config, "Test", fauxModels().models);
		expect(JSON.stringify(await rows())).toContain("user: summarized");
		expect((await f.storage.list())[0].lock?.held).toBe(false);
	});
	it("a compactor startup failure releases both the local writer and the remote lock", async () => {
		const { models } = fauxModels();
		const bad = { ...f.config, lanes: new Map([["Test", { ...f.lane, compactor: { ...f.lane.compactor, model: { provider: "missing", modelId: "missing", thinking: "off" as const } } }]]) };
		await expect(compactCommand(bad, "Test", models)).rejects.toThrow("Unknown model");
		expect((await f.storage.list())[0].lock?.held).toBe(false);
		const probe = MemoryStore.open(join(f.lane.dir, "memory.sqlite"));
		probe.close();
	});

	it("a closed lane's summary-model switch saves the choice remotely", async () => {
		const choice = { provider: "faux-agent", modelId: "faux-1", thinking: "off" as const };
		await laneCompactorTarget(f.config, "Test").apply(choice);
		expect(JSON.stringify(await rows())).toContain(COMPACTOR_MODEL_KEY);
		expect(JSON.stringify(await rows())).toContain("faux-agent");
		expect((await f.storage.list())[0].lock?.held).toBe(false);
	});
	it("a closed summary-model switch cannot bypass a remote holder", async () => {
		await held();
		await expect(laneCompactorTarget(f.config, "Test").apply(undefined)).rejects.toThrow("Test is open on macbook");
		expect(existsSync(join(f.lane.dir, "memory.sqlite"))).toBe(false);
	});
});

it("import --commit and restore refuse remote lanes before reading inputs or changing memory", () => {
	const message = "Test keeps its memory on remote home; run orrery lane local Test first";
	expect(() => importCommitCommand(f.config, "Test", "/missing-preview")).toThrow(message);
	expect(() => restoreLane(f.config, "Test", { from: "/missing-backup" })).toThrow(message);
	expect(existsSync(join(f.lane.dir, "memory.sqlite"))).toBe(false);
});

describe("orrery run", () => {
	it("checks out before starting, sends the completed turn and releases on stop", async () => {
		const { chat, models } = fauxModels();
		chat.setResponses([fauxAssistantMessage("remote run reply")]);
		lane = await Lane.open({ config: f.config, lane: "Test", models, context: ctx });
		expect(lane.store.root[0].text).toBe("from the remote");
		const result = await lane.submit("hello", "remote-run");
		await result?.submission.wait(ctx);
		await vi.waitFor(async () => expect(JSON.stringify(await rows())).toContain("remote run reply"));
		await lane.close(); lane = undefined;
		expect((await f.storage.list())[0].lock?.held).toBe(false);
	});
	it("sends the whole instructions.md, never only the 32 KB that reach the model", async () => {
		const long = `${"a".repeat(INSTRUCTIONS_MAX_BYTES)}TAIL\n`;
		writeInstructions(f.lane.dir, long);
		lane = await Lane.open({ config: f.config, lane: "Test", models: fauxModels().models, context: ctx });
		await lane.close(); lane = undefined;
		expect((await rows()).map((r) => r.meta[INSTRUCTIONS_KEY]).filter((text) => text !== undefined)).toEqual([long]);
	});
	it("refuses a remotely held lane before starting the harness", async () => {
		await held();
		await expect(Lane.open({ config: f.config, lane: "Test", models: fauxModels().models })).rejects.toThrow("Test is open on macbook");
		expect(existsSync(join(f.lane.dir, "session.sqlite"))).toBe(false);
	});
	it("continues running without recording after another machine takes over", async () => {
		const { chat, models } = fauxModels();
		chat.setResponses([fauxAssistantMessage("after takeover")]);
		const fatal = vi.fn();
		lane = await Lane.open({ config: f.config, lane: "Test", models, context: ctx, onFatal: fatal });
		f.clock.value += STALE_MS + 1;
		await f.storage.take("Test", { machine: "macbook", device: "other", pid: 1 }, { force: true });
		await lane.remote!.renew();
		const result = await lane.submit("continue", "after-takeover");
		await result?.submission.wait(ctx);
		expect(lane.store.writable).toBe(false);
		expect(lane.store.root.map((m) => m.text)).toEqual(["from the remote"]);
		expect(fatal).not.toHaveBeenCalled();
		await lane.close(); lane = undefined;
		expect((await f.storage.fetch("Test", 0)).newestSave).toBe(0);
	});

	it("marks a lost durable lane closed before returning from renewal and keeps it closed", async () => {
		lane = await Lane.open({ config: f.config, lane: "Test", models: fauxModels().models, context: ctx });
		expect(laneOpenHere(f.lane)).toBe(true);
		f.clock.value += STALE_MS + 1;
		await f.storage.take("Test", { machine: "macbook", device: "other", pid: 1 }, { force: true });
		await lane.remote!.renew();
		expect(lane.store.writable).toBe(false);
		expect(readStatus(f.lane.dir)).toMatchObject({ open: false, busy: false });
		expect(laneOpenHere(f.lane)).toBe(false);
		await lane.writeStatus();
		expect(readStatus(f.lane.dir)).toMatchObject({ open: false, busy: false });
	});

	it.each([false, true])("does not replay local history after a snapshot (split history: %s)", async (split) => {
		const { chat, models } = fauxModels();
		chat.setResponses([fauxAssistantMessage("one reply")]);
		lane = await Lane.open({ config: f.config, lane: "Test", models, context: ctx });
		const result = await lane.submit("one prompt", "one");
		await result?.submission.wait(ctx);
		await lane.projector.drain();
		await lane.close(); lane = undefined;
		if (split) {
			chat.setResponses([fauxAssistantMessage("discarded reply")]);
			lane = await Lane.open({ config: f.config, lane: "Test", models, context: ctx });
			const offline = vi.spyOn(f.storage, "save").mockRejectedValue(new RemoteError("unreachable", "offline"));
			const unsaved = await lane.submit("discarded prompt", "unsaved");
			await unsaved?.submission.wait(ctx);
			await lane.projector.drain();
			await lane.close(); lane = undefined;
			offline.mockRestore();
		}
		const otherDir = join(f.root, "other-machine");
		const other = await RemoteSession.checkOut({ lane: "Test", laneDir: otherDir, storage: f.storage, key: f.key, holder: { machine: "macbook", device: "other", pid: 1 }, report: () => {}, settings: laneSettings(f.lane) });
		const writer = MemoryStore.open(join(otherDir, "memory.sqlite"));
		other.attach(writer);
		writer.append("user", "other machine");
		await other.save();
		const entry = (await f.storage.list())[0];
		await f.storage.snapshot("Test", entry.lock!.lock, entry.newestSave, seal(f.key, "Test", "snapshot", entry.newestSave, encodeSnapshot({ v: 1, n: entry.newestSave, lock: entry.lock!.lock, machine: "macbook", at: new Date().toISOString(), settings: laneSettings(f.lane) }, snapshotBytes(writer.path))));
		await other.close(); writer.close();
		lane = await Lane.open({ config: f.config, lane: "Test", models, context: ctx });
		expect(lane.store.root.map((m) => m.text)).toEqual(["from the remote", "one prompt", "one reply", "other machine"]);
	});
	it("unblocks a pending submit without memory when loss interrupts summary settling", async () => {
		const { chat, models } = fauxModels();
		chat.setResponses([fauxAssistantMessage("continued")]);
		lane = await Lane.open({ config: f.config, lane: "Test", models, context: ctx });
		lane.compactor.summarizer = { summarize: () => new Promise(() => {}) };
		lane.view.append("talk", "long waiting answer ".repeat(5000));
		expect(lane.view.settled).toBe(false);
		let finished = false;
		const submission = lane.submit("continue", "waiting").then((result) => { finished = true; return result; });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(finished).toBe(false);
		f.clock.value += STALE_MS + 1;
		await f.storage.take("Test", { machine: "macbook", device: "other", pid: 1 }, { force: true });
		await lane.remote!.renew();
		await vi.waitFor(() => expect(finished).toBe(true));
		await (await submission)?.submission.wait(ctx);
		expect(lane.store.root.at(-1)?.text).not.toBe("continued");
	});

	it("unblocks a pending submit when loss interrupts projector catch-up", async () => {
		const { chat, models } = fauxModels();
		chat.setResponses([fauxAssistantMessage("continued")]);
		lane = await Lane.open({ config: f.config, lane: "Test", models, context: ctx });
		await new Promise((resolve) => setTimeout(resolve, 20));
		let release!: () => void;
		const stalled = new Promise<void>((resolve) => { release = resolve; });
		const drain = vi.spyOn(lane.projector, "drain").mockReturnValue(stalled);
		let finished = false;
		const submission = lane.submit("continue", "projector-wait").then((result) => { finished = true; return result; });
		try {
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(finished).toBe(false);
			f.clock.value += STALE_MS + 1;
			await f.storage.take("Test", { machine: "macbook", device: "other", pid: 1 }, { force: true });
			await lane.remote!.renew();
			await vi.waitFor(() => expect(finished).toBe(true));
			await (await submission)?.submission.wait(ctx);
		} finally { release(); drain.mockRestore(); await submission.catch(() => {}); }
	});

	it("releases checkout if the configured model cannot open", async () => {
		const broken = { ...f.config, lanes: new Map([["Test", { ...f.lane, model: { provider: "missing", modelId: "missing", thinking: "off" as const } }]]) };
		await expect(Lane.open({ config: broken, lane: "Test", models: fauxModels().models })).rejects.toThrow("Unknown model");
		expect((await f.storage.list())[0].lock?.held).toBe(false);
	});
});
