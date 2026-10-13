import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { MemoryStore } from "../../src/memory/store.ts";
import { createOrrery, type OrreryOptions } from "../../src/pi/index.ts";
import type { PiLane } from "../../src/pi/lane.ts";
import { remoteOpenNotice } from "../../src/remote/checkout.ts";
import { unseal } from "../../src/remote/crypto.ts";
import { decodeRows } from "../../src/remote/save-format.ts";
import { RemoteError, STALE_MS } from "../../src/remote/types.ts";
import { fakeOmp, ompCleanup, track, type FakeOmp } from "../omp/world.ts";
import { checkoutFixture } from "../remote/checkout-fixture.ts";
import { scratchHome, summarySourcesFor } from "./world.ts";

let f: Awaited<ReturnType<typeof checkoutFixture>>;
beforeEach(async () => { f = await checkoutFixture(); });
afterEach(async () => { vi.useRealTimers(); await ompCleanup(); vi.restoreAllMocks(); f.close(); });

function hostFor(host: "pi" | "omp", ui: Record<string, unknown> = {}, extra: Partial<OrreryOptions> = {}) {
	let lane: PiLane | undefined;
	const patchUi: ExtensionFactory = (api) => { api.on("session_start", (_event, ctx) => { Object.assign(ctx.ui, ui); }); };
	const run = track(fakeOmp(f.lane.workspace, [patchUi, createOrrery({
		config: f.config, host, ...scratchHome(f.root),
		summarySources: async (config) => summarySourcesFor(config),
		remoteStorage: () => f.storage,
		...extra,
		onLane: (opened) => { lane = opened; },
	})], { omp: host === "omp" }));
	return { run, lane: () => lane };
}

async function turn(run: FakeOmp, host: "pi" | "omp", text = "new remote turn") {
	await run.emit("before_agent_start", { prompt: text, systemPrompt: host === "pi" ? "base" : ["base"] });
	run.say("user", text);
	await run.emit("message_end");
	run.say("assistant", "remote reply");
	await run.emit("message_end");
	await run.emit("agent_end");
}

describe.each(["pi", "omp"] as const)("%s remote checkout", (host) => {
	it("opens, records a turn, saves on agent_end, and releases on shutdown", async () => {
		const { run, lane } = hostFor(host);
		await run.emit("session_start");
		expect(lane()?.remote).toBeDefined();
		expect(lane()?.store.root[0].text).toBe("from the remote");
		const save = vi.spyOn(f.storage, "save");
		await turn(run, host);
		await vi.waitFor(async () => expect((await f.storage.list())[0].newestSave).toBe(1));
		expect(save).toHaveBeenCalledTimes(1);
		const fetched = await f.storage.fetch(f.lane.name, 0);
		expect(decodeRows(unseal(f.key, f.lane.name, "save", 1, fetched.saves[0].file)).main.map((row) => row.text)).toEqual(["new remote turn", "remote reply"]);
		await run.emit("session_shutdown");
		expect((await f.storage.list())[0].lock?.held).toBe(false);
		expect(save).toHaveBeenCalledTimes(1);
		expect(lane()).toBeUndefined();
		expect(JSON.parse(readFileSync(join(f.lane.dir, "status.json"), "utf8")).open).toBe(false);
	});

	it.each(["held", "unreachable", "key-missing"] as const)("keeps running without memory and keeps the guard after %s", async (kind) => {
		const failure = new RemoteError(kind, "remote refused\u001b[31m this open");
		vi.spyOn(f.storage, "take").mockRejectedValue(failure);
		const { run, lane } = hostFor(host);
		await run.emit("session_start");
		expect(lane()).toBeUndefined();
		expect(run.tools.has("zoom")).toBe(false);
		expect(run.notices).toContainEqual({ message: expect.stringContaining(remoteOpenNotice(f.lane, failure)), type: "warning" });
		expect(run.notices.some((notice) => notice.message.includes("\u001b"))).toBe(false);
		expect(await run.emit("tool_call", { toolName: "write", input: { path: "/etc/escape", content: "no" } })).toContainEqual({ block: true, reason: expect.stringContaining("outside this lane's workspace") });
		await expect(turn(run, host)).resolves.toBeUndefined();
		expect(run.notices.filter((notice) => notice.type === "warning")).toHaveLength(1);
	});

	it.each([
		{ kind: "confirm", answer: true }, { kind: "confirm", answer: false },
		{ kind: "select", answer: "Take over" }, { kind: "select", answer: "Keep it closed" }, { kind: "select", answer: undefined },
	])("asks with $kind before a stale takeover ($answer)", async ({ kind, answer }) => {
		await f.storage.take(f.lane.name, { machine: "macbook", device: "other", pid: 1 });
		f.clock.value += STALE_MS + 1;
		const prompt = vi.fn(async () => answer);
		const { run, lane } = hostFor(host, kind === "confirm" ? { confirm: prompt } : { confirm: undefined, select: prompt });
		await run.emit("session_start");
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(prompt.mock.calls)).toContain("macbook");
		expect(JSON.stringify(prompt.mock.calls)).toContain("last seen");
		if (kind === "select") expect(prompt).toHaveBeenCalledWith(expect.any(String), ["Take over", "Keep it closed"], expect.objectContaining({ timeout: 60_000 }));
		else expect(prompt).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ timeout: 60_000 }));
		expect(lane()?.remote !== undefined).toBe(answer === true || answer === "Take over");
	});

	it("stops recording after lock loss, leaves a moved footer and keeps the session and guard running", async () => {
		const { run, lane } = hostFor(host);
		await run.emit("session_start");
		const opened = lane()!;
		expect(opened.remote).toBeDefined();
		await turn(run, host);
		await vi.waitFor(async () => expect((await f.storage.list())[0].newestSave).toBe(1));
		f.clock.value += STALE_MS + 1;
		await f.storage.take(f.lane.name, { machine: "new laptop", device: "new", pid: 3 }, { force: true });
		const close = vi.spyOn(opened, "close");
		await opened.remote!.renew();
		const save = vi.spyOn(f.storage, "save");
		await expect(run.emit("agent_end")).resolves.toBeDefined();
		await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
		expect(run.status("orrery")).toContain("home: moved to new laptop");
		await expect(turn(run, host, "after loss")).resolves.toBeUndefined();
		expect(await run.emit("context", { messages: [{ role: "user", content: "keep normal history", timestamp: 0 }] })).toEqual([undefined]);
		await expect(run.emit("session_tree", { newLeafId: "missing" })).resolves.toBeDefined();
		expect(await run.emit("session_before_compact", { reason: "manual" })).toEqual([undefined]);
		expect(await run.emit("tool_call", { toolName: "write", input: { path: "/etc/escape", content: "no" } })).toContainEqual({ block: true, reason: expect.any(String) });
		await run.emit("session_shutdown");
		expect(save).not.toHaveBeenCalled();
		expect(run.notices.filter((notice) => notice.message.includes("moved to new laptop"))).toHaveLength(1);
		const copy = MemoryStore.open(join(f.lane.dir, "memory.sqlite"));
		try { expect(copy.root.map((row) => row.text)).not.toContain("after loss"); } finally { copy.close(); }
	});

	it.each(["hook", "tick"])("stops through a %s while the lost-lock report is still pending", async (trigger) => {
		const { run, lane } = hostFor(host, {}, { tickMs: 10 });
		await run.emit("session_start");
		const opened = lane()!;
		const close = vi.spyOn(opened, "close");
		f.clock.value += STALE_MS + 1;
		await f.storage.take(f.lane.name, { machine: "slow laptop", device: "new", pid: 3 }, { force: true });
		const entries = await f.storage.list();
		let finish!: () => void;
		vi.spyOn(f.storage, "list").mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve(entries); }));
		const renewal = opened.remote!.renew();
		await vi.waitFor(() => expect(opened.remote!.lost).toBe(true));
		try {
			if (trigger === "hook") expect(await run.emit("before_agent_start", { systemPrompt: "base" })).toEqual([undefined]);
			await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
			expect(run.notices.filter((notice) => notice.message.includes("moved to"))).toHaveLength(0);
			expect(lane()).toBeUndefined();
			expect(run.status("orrery")).toContain("home: moved to");
		} finally { finish(); await renewal; }
		expect(run.status("orrery")).toContain("home: moved to slow laptop");
		expect(run.notices.filter((notice) => notice.message.includes("moved to"))).toHaveLength(1);
	});
});

describe("OMP remote leave and move", () => {
	it.each(["session_switch", "session_shutdown", "no further hook"])("cancels a slow open on %s after the folder moved, including a late successful take", async (event) => {
		let finish!: () => void;
		const take = f.storage.take.bind(f.storage);
		vi.spyOn(f.storage, "take").mockImplementationOnce(async (...args) => {
			await new Promise<void>((resolve) => { finish = resolve; });
			return take(...args);
		});
		const { run, lane } = hostFor("omp");
		const opening = run.emit("session_start");
		await vi.waitFor(() => expect(finish).toBeDefined());
		run.cwd = join(f.root, "outside");
		const leaving = event === "no further hook" ? Promise.resolve() : run.emit(event, { reason: "resume" });
		finish();
		await Promise.all([opening, leaving]);
		await vi.waitFor(async () => expect((await f.storage.list())[0].lock?.held).toBe(false));
		expect(lane()).toBeUndefined();
		const renew = vi.spyOn(f.storage, "renew");
		await run.emit("agent_end");
		expect(renew).not.toHaveBeenCalled();
		const local = MemoryStore.open(join(f.lane.dir, "memory.sqlite"));
		local.close();
	});
	it("shutdown cancels an in-progress open in the same folder before its take replies", async () => {
		let finish!: () => void;
		const take = f.storage.take.bind(f.storage);
		vi.spyOn(f.storage, "take").mockImplementationOnce(async (...args) => {
			await new Promise<void>((resolve) => { finish = resolve; });
			return take(...args);
		});
		const { run, lane } = hostFor("pi");
		const opening = run.emit("session_start");
		await vi.waitFor(() => expect(finish).toBeDefined());
		const closing = run.emit("session_shutdown");
		let closed = false;
		void closing.then(() => { closed = true; });
		try {
			await vi.waitFor(() => expect(closed).toBe(true), { timeout: 300 });
			expect(lane()).toBeUndefined();
		} finally { finish(); await Promise.all([opening, closing]); }
		await vi.waitFor(async () => expect((await f.storage.list())[0].lock?.held).toBe(false));
	});
	it.each(["take", "fetch"] as const)("gives up at 25 s during %s, releases a late lock and warns once", async (step) => {
		let finish!: () => void;
		const gate = new Promise<void>((resolve) => { finish = resolve; });
		if (step === "take") {
			const take = f.storage.take.bind(f.storage);
			vi.spyOn(f.storage, "take").mockImplementationOnce(async (...args) => { await gate; return take(...args); });
		} else {
			const fetch = f.storage.fetch.bind(f.storage);
			vi.spyOn(f.storage, "fetch").mockImplementation(async (...args) => { if (args[1] === -1) await gate; return fetch(...args); });
		}
		vi.useFakeTimers();
		const { run, lane } = hostFor("omp");
		const opening = run.emit("session_start");
		let done = false;
		void opening.then(() => { done = true; });
		try {
			await vi.advanceTimersByTimeAsync(24_999);
			expect(done).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			expect(done).toBe(true);
			expect(lane()).toBeUndefined();
			expect(run.notices).toEqual([{ message: expect.stringMatching(/25 seconds.*without memory/), type: "warning" }]);
			expect(await run.emit("tool_call", { toolName: "write", input: { path: "/etc/escape", content: "no" } })).toContainEqual({ block: true, reason: expect.any(String) });
		} finally { finish(); vi.useRealTimers(); await opening; }
		await vi.waitFor(async () => expect((await f.storage.list())[0].lock?.held).toBe(false));
		const local = MemoryStore.open(join(f.lane.dir, "memory.sqlite"));
		local.close();
	});
	it("does not extend the OMP open deadline while releasing a taken lock after failure", async () => {
		const fetch = f.storage.fetch.bind(f.storage);
		vi.spyOn(f.storage, "fetch").mockImplementation(async (...args) => {
			if (args[1] === -1) throw new RemoteError("unreachable", "offline during restore");
			return fetch(...args);
		});
		const release = f.storage.release.bind(f.storage);
		let finish!: () => Promise<void>;
		vi.spyOn(f.storage, "release").mockImplementation((...args) => new Promise<void>((resolve) => {
			finish = async () => { await release(...args); resolve(); };
		}));
		vi.useFakeTimers();
		const { run, lane } = hostFor("omp");
		const opening = run.emit("session_start");
		let done = false;
		void opening.then(() => { done = true; });
		try {
			await vi.advanceTimersByTimeAsync(25_000);
			expect(done).toBe(true);
			expect(lane()).toBeUndefined();
			expect(run.notices).toEqual([{ message: expect.stringContaining("without memory"), type: "warning" }]);
			const local = MemoryStore.open(join(f.lane.dir, "memory.sqlite"));
			local.close();
		} finally { await finish(); vi.useRealTimers(); await opening; }
		expect((await f.storage.list())[0].lock?.held).toBe(false);
	});
	it.each(["session_switch", "before_agent_start", "session_shutdown"])("saves pending lane rows and closes on %s after moving", async (event) => {
		const { run, lane } = hostFor("omp");
		await run.emit("session_start");
		expect(lane()?.remote).toBeDefined();
		run.say("user", "still in lane");
		await run.emit("message_end");
		run.cwd = join(f.root, "outside");
		run.say("user", "outside lane");
		await run.emit(event, { reason: "resume", systemPrompt: ["base"] });
		expect((await f.storage.list())[0]).toMatchObject({ newestSave: 1, lock: { held: false } });
		const fetched = await f.storage.fetch(f.lane.name, 0);
		expect(decodeRows(unseal(f.key, f.lane.name, "save", 1, fetched.saves[0].file)).main.map((row) => row.text)).toEqual(["still in lane"]);
		expect(lane()).toBeUndefined();
	});
});

it("treats an unanswered pi takeover dialog as no after 60 s", async () => {
	await f.storage.take(f.lane.name, { machine: "macbook", device: "other", pid: 1 });
	f.clock.value += STALE_MS + 1;
	const take = vi.spyOn(f.storage, "take");
	vi.useFakeTimers();
	const { run, lane } = hostFor("pi", { confirm: vi.fn(() => new Promise(() => {})) });
	const opening = run.emit("session_start");
	let done = false;
	void opening.then(() => { done = true; });
	await vi.advanceTimersByTimeAsync(60_000);
	expect(done).toBe(true);
	expect(lane()).toBeUndefined();
	expect(take).toHaveBeenCalledTimes(1);
});

it.each(["confirm", "select"])("pi shutdown cancels a pending takeover %s immediately", async (kind) => {
	await f.storage.take(f.lane.name, { machine: "macbook", device: "other", pid: 1 });
	f.clock.value += STALE_MS + 1;
	const reply = Promise.withResolvers<boolean | string | undefined>();
	const prompt = vi.fn(() => reply.promise);
	const { run, lane } = hostFor("pi", kind === "confirm" ? { confirm: prompt } : { confirm: undefined, select: prompt });
	const opening = run.emit("session_start");
	await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
	const take = vi.spyOn(f.storage, "take");
	const closing = run.emit("session_shutdown");
	let closed = false;
	void closing.then(() => { closed = true; });
	try {
		await vi.waitFor(() => expect(closed).toBe(true), { timeout: 300 });
		expect(lane()).toBeUndefined();
		expect(take).not.toHaveBeenCalled();
		expect(run.notices).toEqual([]);
	} finally { reply.resolve(undefined); await Promise.all([opening, closing]); }
});

it("describes a remote lane held locally without naming this machine as a remote host", async () => {
	const first = hostFor("pi");
	await first.run.emit("session_start");
	const second = hostFor("pi");
	await second.run.emit("session_start");
	expect(second.lane()).toBeUndefined();
	expect(second.run.notices).toEqual([{ message: expect.stringContaining("open in another pi or Claude Code on this machine"), type: "warning" }]);
});
