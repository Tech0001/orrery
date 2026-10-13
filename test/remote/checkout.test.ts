import { existsSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { unseal } from "../../src/remote/crypto.ts";
import { decodeRows } from "../../src/remote/save-format.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readStatus } from "../../src/lane/status-file.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import { laneOpenHere, readCopyPath } from "../../src/remote/read-copy.ts";
import { LaneHeld, MemoryLane } from "../../src/lane/memory-lane.ts";
import { laneModelSource } from "../../src/lane/model-source.ts";
import { checkOutLane, remoteFooter, remoteOpenNotice } from "../../src/remote/checkout.ts";
import * as remotes from "../../src/remote/index.ts";
import { removeRemoteSecret } from "../../src/remote/secrets.ts";
import { RemoteError, STALE_MS } from "../../src/remote/types.ts";
import { fauxModels } from "../lane/support.ts";
import { checkoutFixture } from "./checkout-fixture.ts";

let f: Awaited<ReturnType<typeof checkoutFixture>>;
const opened: MemoryLane[] = [];
beforeEach(async () => { f = await checkoutFixture(); vi.spyOn(remotes, "openStorage").mockImplementation(() => f.storage); });
afterEach(async () => { await Promise.all(opened.splice(0).map((m) => m.close())); vi.restoreAllMocks(); f.close(); });
const reports: string[] = [];
async function open() {
	const lane = await MemoryLane.openChecked({ config: f.config, lane: f.lane, models: laneModelSource(fauxModels().models), report: (m) => reports.push(m) });
	opened.push(lane);
	return lane;
}

describe("the writer checkout door", () => {
	it("refuses a second local pi before touching even a stale remote lock", async () => {
		const first = await open();
		f.clock.value += STALE_MS + 1;
		const take = vi.spyOn(f.storage, "take");
		const fetch = vi.spyOn(f.storage, "fetch");
		await expect(open()).rejects.toBeInstanceOf(LaneHeld);
		expect(take).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
		expect(first.store.writable).toBe(true);
		expect((await f.storage.list())[0].lock?.stale).toBe(true);
	});
	it("holds the local writer continuously while checkout fetches the working copy", async () => {
		const fetch = f.storage.fetch.bind(f.storage);
		vi.spyOn(f.storage, "fetch").mockImplementation(async (lane, after) => {
			expect(() => MemoryStore.open(join(f.lane.dir, "memory.sqlite")).close()).toThrow(/already open/);
			return fetch(lane, after);
		});
		const lane = await open();
		expect(lane.store.root[0].text).toBe("from the remote");
	});
	it("names another live holder on this machine without presenting it as another machine", async () => {
		await f.storage.take("Test", { ...remotes.holderFor(f.config), pid: process.ppid });
		await expect(open()).rejects.toThrow(/open in another pi or Claude Code on this machine \(last seen/);
	});
	it("returns immediately for a local lane without secrets, device identity or storage", async () => {
		removeRemoteSecret(f.config, "home");
		expect(await checkOutLane(f.config, { ...f.lane, remote: undefined }, { report: () => {} })).toBeUndefined();
		expect(remotes.openStorage).not.toHaveBeenCalled();
		expect(existsSync(f.config.deviceIdPath)).toBe(false);
	});
	it("requires a recovery key before opening the working copy", async () => {
		removeRemoteSecret(f.config, "home");
		await expect(checkOutLane(f.config, f.lane, { storage: f.storage, report: () => {} })).rejects.toMatchObject({ kind: "key-missing", message: expect.stringContaining("orrery remote add home") });
		expect(existsSync(join(f.lane.dir, "memory.sqlite"))).toBe(false);
	});
	it("checks out before opening memory, saves a turn and releases on close", async () => {
		const lane = await open();
		expect(lane.store.root.map((m) => m.text)).toEqual(["from the remote"]);
		expect((await f.storage.list())[0].lock).toMatchObject({ held: true, holder: { machine: f.config.machineName, pid: process.pid } });
		lane.view.append("talk", "new reply");
		lane.afterTurn();
		await vi.waitFor(async () => expect((await f.storage.fetch("Test", 0)).newestSave).toBe(1));
		expect(lane.statusLine()).toMatch(/ · home ✓ \d\d:\d\d$/);
		lane.store.setMeta("test-final", "final save");
		await lane.close();
		expect((await f.storage.list())[0].lock?.held).toBe(false);
		expect((await f.storage.fetch("Test", 0)).newestSave).toBe(2);
	});
	it("refuses a held lane without creating a writable local database", async () => {
		await f.storage.take("Test", { machine: "macbook", device: "other", pid: 1 });
		await expect(open()).rejects.toMatchObject({ kind: "held" });
		expect(existsSync(join(f.lane.dir, "memory.sqlite"))).toBe(false);
	});
	it("closes the writer on lock loss, reports the move and skips a final save", async () => {
		const lane = await open();
		f.clock.value += STALE_MS + 1;
		await f.storage.take("Test", { machine: "macbook", device: "other", pid: 1 }, { force: true });
		await lane.remote!.renew();
		expect(lane.store.writable).toBe(false);
		expect(lane.statusLine()).toContain("home: moved to macbook");
		expect(reports.some((m) => m.includes("runs without memory"))).toBe(true);
		const save = vi.spyOn(f.storage, "save");
		await lane.close();
		expect(save).not.toHaveBeenCalled();
	});
	it("marks lost memory closed immediately and readers stop using its working copy", async () => {
		const lane = await open();
		lane.store.append("talk", "unsaved local reply");
		lane.writeStatus(true, true);
		expect(laneOpenHere(f.lane)).toBe(true);
		f.clock.value += STALE_MS + 1;
		await f.storage.take("Test", { machine: "macbook", device: "other", pid: 1 }, { force: true });
		await lane.remote!.renew();
		expect(lane.store.writable).toBe(false);
		expect(readStatus(f.lane.dir)).toMatchObject({ open: false, busy: false });
		expect(laneOpenHere(f.lane)).toBe(false);
		const copy = await readCopyPath(f.config, f.lane, { storage: f.storage });
		expect(copy.path).not.toBe(lane.store.path);
		const reader = MemoryStore.openReadOnly(copy.path);
		try { expect(reader.root.map((m) => m.text)).toEqual(["from the remote"]); }
		finally { reader.close(); }
		// A queued heartbeat must not advertise the fenced-out working copy as open again.
		lane.writeStatus(true, true);
		expect(readStatus(f.lane.dir)).toMatchObject({ open: false, busy: false });
		expect(laneOpenHere(f.lane)).toBe(false);
	});
	it("lets RemoteSession retake this machine's own stale lock without confirmation", async () => {
		await f.storage.take("Test", remotes.holderFor(f.config));
		f.clock.value += STALE_MS + 1;
		const confirmTakeover = vi.fn(async () => false);
		const remote = await checkOutLane(f.config, f.lane, { report: () => {}, confirmTakeover, storage: f.storage });
		try {
			expect(confirmTakeover).not.toHaveBeenCalled();
			expect((await f.storage.list())[0].lock).toMatchObject({ held: true, stale: false });
		} finally { await remote?.close(); }
	});
	it("passes confirmation through and leaves takeover audit records to RemoteSession", async () => {
		await f.storage.take("Test", { machine: "macbook", device: "other", pid: 1 });
		f.clock.value += STALE_MS + 1;
		const confirmTakeover = vi.fn(async () => true);
		const lane = await MemoryLane.openChecked({ config: f.config, lane: f.lane, models: laneModelSource(fauxModels().models), report: () => {}, confirmTakeover });
		opened.push(lane);
		lane.store.append("talk", "after takeover");
		await lane.remote!.save();
		expect(confirmTakeover).toHaveBeenCalledOnce();
		const entries = await f.storage.log("Test");
		expect(entries).toHaveLength(1);
		const header = JSON.parse(Buffer.from(unseal(f.key, "Test", "log", entries[0].n, entries[0].file)).toString("utf8"));
		expect(header.takeover).toEqual({ from: "macbook" });
	});

	it("wakes a memory-lane summary waiter when the remote lock is lost", async () => {
		const lane = await open();
		lane.compactor.summarizer = { summarize: () => new Promise(() => {}) };
		lane.view.append("talk", "long waiting answer ".repeat(5000));
		let finished = false;
		void lane.awaitSummaries(new AbortController().signal).then(() => { finished = true; });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(finished).toBe(false);
		f.clock.value += STALE_MS + 1;
		await f.storage.take("Test", { machine: "macbook", device: "other", pid: 1 }, { force: true });
		await lane.remote!.renew();
		await vi.waitFor(() => expect(finished).toBe(true));
	});

	it("includes the last compactor usage in the final save before releasing the lock", async () => {
		let started!: () => void;
		const running = new Promise<void>((resolve) => { started = resolve; });
		const source = laneModelSource(fauxModels().models);
		source.streamSimple = (_model, _context, options) => ({ result: () => new Promise((resolve) => {
			started();
			options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("summary")), { once: true });
		}) });
		const lane = await MemoryLane.openChecked({ config: f.config, lane: f.lane, models: source, report: () => {} });
		opened.push(lane);
		lane.view.append("talk", "long answer ".repeat(300));
		await running;
		await lane.close();
		const saves = (await f.storage.fetch("Test", 0)).saves;
		expect(saves.flatMap((s) => decodeRows(unseal(f.key, "Test", "save", s.n, s.file)).usage)).toHaveLength(1);
	});

	it("releases the checkout when opening the writer fails", async () => {
		const models = { find: () => { throw new Error("model failure"); }, streamSimple: () => { throw new Error("unused"); } };
		await expect(MemoryLane.openChecked({ config: f.config, lane: f.lane, models, report: () => {} })).rejects.toThrow("model failure");
		expect((await f.storage.list())[0].lock?.held).toBe(false);
	});
});

it("formats plain remote errors and footer states without terminal escapes", () => {
	expect(remoteOpenNotice(f.lane, new RemoteError("held", "Test is open on macbook (last seen 14:02)"))).toBe("Test is open on macbook (last seen 14:02)");
	expect(remoteOpenNotice(f.lane, new RemoteError("unreachable", "connection refused"))).toBe("remote home is unreachable: connection refused");
	expect(remoteFooter({ remote: "home", state: "saved", savedAt: "14:02" })).toBe("home ✓ 14:02");
	expect(remoteFooter({ remote: "home", state: "failing", reason: "offline" })).toBe("home ⚠ not saved: offline");
	expect(remoteFooter({ remote: "home", state: "lost", movedTo: "\u001b[31mmacbook\u001b[0m" })).toBe("home: moved to macbook");
});
