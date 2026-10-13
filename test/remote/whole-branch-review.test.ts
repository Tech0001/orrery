import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { laneRemoteCommand, pullLaneCommand, setStorageForTests } from "../../src/cli/remote.ts";
import { Lane } from "../../src/lane/lane.ts";
import { MemoryLane } from "../../src/lane/memory-lane.ts";
import { LaneHeld } from "../../src/lane/memory-lane.ts";
import { laneModelSource } from "../../src/lane/model-source.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import { checkOutLane, withBriefCheckOut } from "../../src/remote/checkout.ts";
import { unseal } from "../../src/remote/crypto.ts";
import * as remotes from "../../src/remote/index.ts";
import { RemoteError, STALE_MS } from "../../src/remote/types.ts";
import { realDeps } from "../../src/tui/deps.ts";
import { fauxModels, laneConfigToml } from "../lane/support.ts";
import { checkoutFixture } from "./checkout-fixture.ts";

let f: Awaited<ReturnType<typeof checkoutFixture>>;
let pi: MemoryLane | undefined;
let path: string;
const reports: string[] = [];
beforeEach(async () => {
	f = await checkoutFixture();
	path = join(f.root, "config.toml");
	writeFileSync(path, `${laneConfigToml({ dataDir: f.config.dataDir, workspace: f.lane.workspace, extra: 'remote = "home"' })}\n[remotes.home]\nkind = "cloudflare"\nurl = "https://example.invalid"\n`);
	reports.length = 0;
	vi.spyOn(remotes, "openStorage").mockReturnValue(f.storage);
	setStorageForTests(() => f.storage);
});
afterEach(async () => { await pi?.close(); pi = undefined; setStorageForTests(undefined); vi.restoreAllMocks(); f.close(); });
async function openPi() {
	pi = await MemoryLane.openChecked({ config: f.config, lane: f.lane, models: laneModelSource(fauxModels().models), report: (m) => reports.push(m) });
	return pi;
}

it.each(["brief", "run", "takeover", "local", "pull"])("%s refuses the live local pi before touching a stale remote lock", async (operation) => {
	const first = await openPi();
	f.clock.value += STALE_MS + 1;
	const take = vi.spyOn(f.storage, "take");
	const release = vi.spyOn(f.storage, "release");
	if (operation === "pull") writeFileSync(path, `data_dir = ${JSON.stringify(f.config.dataDir)}\n[remotes.home]\nkind = "cloudflare"\nurl = "https://example.invalid"\n`);
	const work = operation === "brief" ? withBriefCheckOut(f.config, f.lane, () => { throw new Error("must not write"); }, () => {})
		: operation === "run" ? Lane.open({ config: f.config, lane: "Test", models: fauxModels().models })
		: operation === "pull" ? pullLaneCommand(path, "Test", "home", f.lane.workspace)
		: laneRemoteCommand(path, [operation, "Test"], operation === "takeover" ? { yes: true } : {});
	await expect(work).rejects.toThrow(/already open|held locally|open on this machine/i);
	expect(take).not.toHaveBeenCalled();
	expect(release).not.toHaveBeenCalled();
	await first.remote!.renew();
	expect(first.remote!.lost).toBe(false);
	expect(first.store.writable).toBe(true);
	expect(reports.some((m) => m.includes("moved"))).toBe(false);
});

it.each(["brief", "run", "takeover", "local", "pull"])("%s keeps its local writer reservation while taking the remote lock", async (operation) => {
	if (operation === "takeover") {
		await f.storage.take("Test", { machine: "macbook", device: "other", pid: 1 });
		f.clock.value += STALE_MS + 1;
	}
	if (operation === "pull") writeFileSync(path, `data_dir = ${JSON.stringify(f.config.dataDir)}\n[remotes.home]\nkind = "cloudflare"\nurl = "https://example.invalid"\n`);
	const take = f.storage.take.bind(f.storage);
	vi.spyOn(f.storage, "take").mockImplementation(async (...args) => {
		expect(() => MemoryStore.open(join(f.lane.dir, "memory.sqlite")).close()).toThrow(/already open/i);
		return take(...args);
	});
	if (operation === "brief") await withBriefCheckOut(f.config, f.lane, () => {}, () => {});
	else if (operation === "run") { const lane = await Lane.open({ config: f.config, lane: "Test", models: fauxModels().models }); await lane.close(); }
	else if (operation === "pull") await pullLaneCommand(path, "Test", "home", f.lane.workspace);
	else await laneRemoteCommand(path, [operation, "Test"], operation === "takeover" ? { yes: true } : {});
	MemoryStore.open(join(f.lane.dir, "memory.sqlite")).close();
});

it("pi refuses a lane held by a brief writer without touching or losing the brief writer's remote lock", async () => {
	await withBriefCheckOut(f.config, f.lane, async (remote) => {
		f.clock.value += STALE_MS + 1;
		const take = vi.spyOn(f.storage, "take");
		await expect(openPi()).rejects.toBeInstanceOf(LaneHeld);
		expect(take).not.toHaveBeenCalled();
		await remote!.renew();
		expect(remote!.lost).toBe(false);
	}, (m) => reports.push(m));
	expect(reports.some((m) => m.includes("moved"))).toBe(false);
});

it.each(["CLI", "TUI"])("audits a %s takeover on the next checkout's first save, once", async (source) => {
	await f.storage.take("Test", { machine: "old laptop", device: "other", pid: 1 });
	f.clock.value += STALE_MS + 1;
	if (source === "CLI") await laneRemoteCommand(path, ["takeover", "Test"], { yes: true });
	else await realDeps({ configPath: path, tui: { requestRender: () => {} } as unknown as TUI, quit: () => {} }).takeoverLane!("Test");
	const marker = join(f.lane.dir, "takeover-from.json");
	expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({ machine: "old laptop" });
	const lane = await openPi();
	expect(existsSync(marker)).toBe(false);
	lane.store.append("talk", "first after takeover");
	await lane.remote!.save();
	lane.store.append("talk", "ordinary next save");
	await lane.remote!.save();
	const logs = (await f.storage.log("Test")).map((entry) => JSON.parse(Buffer.from(unseal(f.key, "Test", "log", entry.n, entry.file)).toString("utf8")));
	expect(logs.map((log) => log.takeover)).toEqual([{ from: "old laptop" }, undefined]);
});

it("keeps the takeover marker when checkout fails before restoring memory", async () => {
	await f.storage.take("Test", { machine: "old laptop", device: "other", pid: 1 });
	f.clock.value += STALE_MS + 1;
	await laneRemoteCommand(path, ["takeover", "Test"], { yes: true });
	const fetch = f.storage.fetch.bind(f.storage);
	vi.spyOn(f.storage, "fetch").mockImplementation(async (lane, after) => { if (after === -1) throw new RemoteError("unreachable", "offline"); return fetch(lane, after); });
	await expect(openPi()).rejects.toMatchObject({ kind: "unreachable" });
	expect(JSON.parse(readFileSync(join(f.lane.dir, "takeover-from.json"), "utf8"))).toEqual({ machine: "old laptop" });
	expect((await f.storage.list())[0].lock?.held).toBe(false);
});

it("audits locally pending rows when checkout itself sends the first save after a command takeover", async () => {
	const remote = await checkOutLane(f.config, f.lane, { report: () => {} });
	await remote!.close();
	const store = MemoryStore.open(join(f.lane.dir, "memory.sqlite"));
	store.append("talk", "pending from an offline close");
	store.close();
	await f.storage.take("Test", { machine: "old laptop", device: "other", pid: 1 });
	f.clock.value += STALE_MS + 1;
	await laneRemoteCommand(path, ["takeover", "Test"], { yes: true });
	const lane = await openPi();
	lane.store.append("talk", "after opening");
	await lane.remote!.save();
	const logs = (await f.storage.log("Test")).map((entry) => JSON.parse(Buffer.from(unseal(f.key, "Test", "log", entry.n, entry.file)).toString("utf8")));
	expect(logs[0].takeover).toEqual({ from: "old laptop" });
	expect(logs.slice(1).map((log) => log.takeover)).toEqual([undefined]);
});
