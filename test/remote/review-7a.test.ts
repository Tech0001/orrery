import { join } from "node:path";
import type { TUI } from "@earendil-works/pi-tui";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Holder } from "../../src/claude/holder.ts";
import { compactCommand } from "../../src/cli/commands.ts";
import { COMPACTOR_MODEL_KEY } from "../../src/lane/choices.ts";
import { laneCompactorTarget } from "../../src/lane/compactor-target.ts";
import { laneModelSource } from "../../src/lane/model-source.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import { attachRemoteStore, checkOutLane, remoteOpenNotice, withBriefCheckOut } from "../../src/remote/checkout.ts";
import * as remotes from "../../src/remote/index.ts";
import { RemoteError, RENEW_MS, STALE_MS } from "../../src/remote/types.ts";
import { realDeps } from "../../src/tui/deps.ts";
import { fauxModels } from "../lane/support.ts";
import { checkoutFixture } from "./checkout-fixture.ts";

let f: Awaited<ReturnType<typeof checkoutFixture>>;
let holder: Holder | undefined;
beforeEach(async () => {
	f = await checkoutFixture();
	vi.spyOn(remotes, "openStorage").mockReturnValue(f.storage);
});
afterEach(async () => {
	await holder?.stop("test cleanup");
	holder = undefined;
	vi.useRealTimers();
	vi.restoreAllMocks();
	f.close();
});

it("compact returns lock-lost when takeover interrupts a slow faux summary", async () => {
	await withBriefCheckOut(f.config, f.lane, (_remote, writer) => {
		const store = MemoryStore.open(join(f.lane.dir, "memory.sqlite"), writer);
		store.append("talk", "long history ".repeat(300));
		store.close();
	}, () => {});
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
	const started = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const { models, compactor } = fauxModels();
	compactor.setResponses([async () => { started.resolve(); await finish.promise; return fauxAssistantMessage("late summary"); }]);
	const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
	vi.spyOn(process.stderr, "write").mockReturnValue(true);
	let result: unknown;
	const command = compactCommand(f.config, "Test", models).then(() => { result = "success"; }, (error) => { result = error; });
	try {
		await started.promise;
		f.clock.value += STALE_MS + 1;
		await f.storage.take("Test", { machine: "macbook", device: "other", pid: 1 }, { force: true });
		await vi.advanceTimersByTimeAsync(RENEW_MS);
		await vi.waitFor(() => expect(result).toMatchObject({ kind: "lock-lost", message: expect.stringContaining("Test moved to macbook") }), { timeout: 300 });
		await command;
		expect(stdout.mock.calls.flat().join("")).not.toContain("Done:");
		const probe = MemoryStore.open(join(f.lane.dir, "memory.sqlite"));
		probe.close();
	} finally {
		finish.resolve();
		vi.clearAllTimers();
	}
});

it("the attached brief writer renews on the real interval, loses its writer on timer renewal, and cancels the timer", async () => {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
	const renew = vi.spyOn(f.storage, "renew");
	await expect(withBriefCheckOut(f.config, f.lane, async (remote, writer) => {
		const store = MemoryStore.open(join(f.lane.dir, "memory.sqlite"), writer);
		attachRemoteStore(remote!, store);
		await vi.advanceTimersByTimeAsync(0);
		expect(renew).toHaveBeenCalledTimes(1);
		store.append("talk", "timer saves this");
		f.clock.value += RENEW_MS;
		await vi.advanceTimersByTimeAsync(RENEW_MS);
		expect(renew).toHaveBeenCalledTimes(2);
		expect((await f.storage.fetch("Test", 0)).newestSave).toBe(1);
		f.clock.value += STALE_MS + 1;
		await f.storage.take("Test", { machine: "macbook", device: "other", pid: 1 }, { force: true });
		await vi.advanceTimersByTimeAsync(RENEW_MS);
		expect(renew).toHaveBeenCalledTimes(3);
		expect(store.writable).toBe(false);
	}, () => {})).rejects.toMatchObject({ kind: "lock-lost" });
	await vi.advanceTimersByTimeAsync(RENEW_MS * 2);
	expect(renew).toHaveBeenCalledTimes(3);
});

it("checkout preserves each local cursor prefix when initial local memory is set aside", async () => {
	const local = MemoryStore.open(join(f.lane.dir, "memory.sqlite"));
	local.append("user", "local history must be set aside");
	for (const [key, value] of Object.entries({ "projector.cursor": "10", "pi.cursor.session-a": "20", "pi.cursor.session-b": "30", "claude.spool.session-a": "event-a", "claude.spool.session-b": "event-b", "projector.cursor.not-local": "discard", "shared-setting": "discard" })) local.setMeta(key, value);
	local.close();
	const remote = await checkOutLane(f.config, f.lane, { report: () => {} });
	try {
		const restored = MemoryStore.openReadOnly(join(f.lane.dir, "memory.sqlite"));
		try {
			for (const [key, value] of Object.entries({ "projector.cursor": "10", "pi.cursor.session-a": "20", "pi.cursor.session-b": "30", "claude.spool.session-a": "event-a", "claude.spool.session-b": "event-b" })) expect(restored.getMeta(key)).toBe(value);
			expect(restored.getMeta("projector.cursor.not-local")).toBeUndefined();
			expect(restored.getMeta("shared-setting")).toBeUndefined();
		} finally { restored.close(); }
	} finally { await remote?.close(); }
});

it.each(["remote home cannot be reached", "Cannot reach remote home: connection refused", "Remote home timed out"])("says a self-contained transport notice only once: %s", (message) => {
	expect(remoteOpenNotice(f.lane, new RemoteError("unreachable", message))).toBe(message);
});

it("the TUI routes a remote checkout notice through its report callback without writing stderr", async () => {
	const local = MemoryStore.open(join(f.lane.dir, "memory.sqlite"));
	local.append("user", "local history to preserve");
	local.close();
	const report = vi.fn();
	const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
	const deps = realDeps({ configPath: join(f.root, "unused.toml"), tui: { requestRender: () => {} } as unknown as TUI, quit: () => {} });
	await deps.target(f.config, "Test", report).apply({ provider: "faux-agent", modelId: "faux-1", thinking: "off" });
	expect(report).toHaveBeenCalledWith(expect.stringContaining("was kept aside"));
	expect(stderr).not.toHaveBeenCalled();
});

it("a remote summary-model switch hands the change to the recorder already open here", async () => {
	holder = await Holder.start({ config: f.config, lane: f.lane, session: "remote-choice", claudePid: process.pid, nonce: "choice", models: laneModelSource(fauxModels().models), tickMs: 10, log: () => {} });
	expect(holder).toBeDefined();
	const takes = vi.spyOn(f.storage, "take");
	const choice = { provider: "faux-agent", modelId: "faux-1", thinking: "off" as const };
	expect(await laneCompactorTarget(f.config, "Test", { waitMs: 1000 }).apply(choice)).toContain("set in chat");
	expect(holder!.lane.store.getMeta(COMPACTOR_MODEL_KEY)).toBe(JSON.stringify(choice));
	expect(takes).not.toHaveBeenCalled();
	expect(holder!.lane.store.writable).toBe(true);
});
