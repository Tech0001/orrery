import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { laneRemoteCommand, setStorageForTests } from "../../src/cli/remote.ts";
import { loadConfig } from "../../src/lane/config.ts";
import { laneOverview, OverviewCache } from "../../src/lane/overview.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import { checkOutLane } from "../../src/remote/checkout.ts";
import { createKey, keyToCode } from "../../src/remote/crypto.ts";
import { FakeStorage } from "../../src/remote/fake.ts";
import { laneSettings } from "../../src/remote/save-format.ts";
import { saveRemoteSecret } from "../../src/remote/secrets.ts";
import { RemoteSession } from "../../src/remote/session.ts";
import { type LaneEntry, RemoteError } from "../../src/remote/types.ts";
import { lanesPage } from "../../src/tui/pages/lanes.ts";
import { tempDir } from "../lane/support.ts";
import { answer, fakeDeps, keys, makeApp, screen, settle } from "./support.ts";

/** The TUI runs outside Atlas's folder: L asks where, and these open it in its folder. */
const inItsFolder = (app: Parameters<typeof answer>[0]) => answer(app, "Open Atlas where?", "\x1b[B", "\r");

let dir: string;
let path: string;
let now: number;
let storage: FakeStorage;
const peer = { machine: "macbook", device: "other-device", pid: 900 };
const seen = Date.parse("2026-10-12T14:02:00");
const question = "Atlas was open on macbook, last seen 14:02, saved up to save 1. Take over?";

beforeEach(async () => {
	dir = tempDir("orrery-tui-launch-"); path = join(dir, "config.toml"); now = seen;
	storage = new FakeStorage({ name: "home", now: () => now });
	writeFileSync(path, `data_dir = "${dir}/data"\n[lanes.Atlas]\nworkspace = "${dir}"\ntool = "pi"\ncompactor_model = "openai/gpt-6.1-sol"\nremote = "home"\n[remotes.home]\nkind = "cloudflare"\nurl = "https://example.com"\n`);
	const config = loadConfig(path); const lane = config.lanes.get("Atlas")!;
	const key = createKey(); const laneDir = join(dir, "peer");
	const store = MemoryStore.open(join(laneDir, "memory.sqlite"));
	store.append("user", "initial memory"); store.close();
	const options = { lane: "Atlas", laneDir, storage, key, holder: peer, settings: laneSettings(lane), report: () => {}, now: () => now };
	await RemoteSession.push(options);
	const session = await RemoteSession.checkOut(options);
	const writer = MemoryStore.open(join(laneDir, "memory.sqlite"));
	session.attach(writer); writer.append("user", "saved on the peer");
	try { await session.close(); } finally { writer.close(); }
	saveRemoteSecret(config, "home", { key: keyToCode(key), token: "hidden-token" });
	setStorageForTests(() => storage);
});

afterEach(() => { setStorageForTests(undefined); rmSync(dir, { recursive: true, force: true }); });

function setup() {
	const cache = new OverviewCache({ storage: () => storage, now: () => now });
	const deps = fakeDeps({ configPath: path, loadConfig: () => loadConfig(path),
		overview: (config) => laneOverview(config, { cache, now }),
		remotes: (config) => cache.remotes(config),
		refreshRemote: (config, name) => cache.refreshRemote(config, name),
		takeoverLane: (name) => laneRemoteCommand(path, ["takeover", name], { yes: true }),
		tools: () => [{ id: "pi", label: "pi", path: "/bin/pi", version: "1", wiring: "installed", detail: "" }],
	});
	return { cache, deps, app: makeApp(deps, [lanesPage]) };
}

async function hold(stale = false) {
	const result = await storage.take("Atlas", peer);
	if (!result.ok) throw new Error("fixture lock already held");
	if (stale) now += 181_000;
	return result.lock;
}

describe("L on a remote lane", () => {
	it("refreshes a cached free lane once and refuses a fresh holder without launching", async () => {
		let lists = 0; const list = storage.list.bind(storage);
		storage.list = async () => { lists++; return list(); };
		const { app, deps } = setup(); await settle(); app.refresh();
		await hold(); keys(app, "L"); await app.idle();
		expect(lists).toBe(2);
		expect(screen(app)).toContain("Atlas is open on macbook (last seen 14:02)");
		expect(deps.launched).toEqual([]); expect(app.host.current).toBeUndefined();
		expect((await list())[0].lock?.holder).toEqual(peer);
	});

	it("asks before forcing a stale lock, releases it, and lets the launched tool check out", async () => {
		const lock = await hold(true); const { app, deps } = setup();
		let launched = false;
		deps.launch = async () => {
			expect((await storage.list())[0].lock).toMatchObject({ held: false, lock: lock + 1 });
			const config = loadConfig(path);
			const session = await checkOutLane(config, config.lanes.get("Atlas")!, { storage, report: () => {} });
			try {
				const store = MemoryStore.openReadOnly(join(config.lanes.get("Atlas")!.dir, "memory.sqlite"));
				try { expect(store.root.map((m) => m.text)).toEqual(["initial memory", "saved on the peer"]); } finally { store.close(); }
			} finally { await session!.close(); }
			launched = true; return { code: 0, signal: null };
		};
		keys(app, "L"); await inItsFolder(app);
		expect(app.host.current?.title).toBe(question);
		expect((await storage.list())[0].lock).toMatchObject({ held: true, lock, holder: peer });
		expect(launched).toBe(false);
		await answer(app, "Take over?", "y"); await app.idle();
		expect(launched).toBe(true); expect(screen(app)).toContain("Back from pi (Atlas)");
	});

	it.each(["n", "\x1b"])("%j leaves the stale lock alone and does not launch", async (key) => {
		const lock = await hold(true); const { app, deps } = setup();
		keys(app, "L"); await inItsFolder(app); await answer(app, "Take over?", key); await app.idle();
		expect(deps.launched).toEqual([]);
		expect((await storage.list())[0].lock).toMatchObject({ held: true, lock, holder: peer });
	});

	it("labels an initial snapshot of substantial existing memory as save 0, not turn 0", async () => {
		storage = new FakeStorage({ name: "home", now: () => now });
		const config = loadConfig(path); const key = createKey(); const laneDir = join(dir, "long-history");
		const store = MemoryStore.open(join(laneDir, "memory.sqlite"));
		try { for (let n = 1; n <= 200; n++) store.append("user", `message ${n}`); } finally { store.close(); }
		await RemoteSession.push({ lane: "Atlas", laneDir, storage, key, holder: peer, settings: laneSettings(config.lanes.get("Atlas")!), report: () => {} });
		saveRemoteSecret(config, "home", { key: keyToCode(key), token: "hidden-token" });
		await hold(true); const { app, deps } = setup(); keys(app, "L"); await inItsFolder(app);
		expect(app.host.current?.title).toBe("Atlas was open on macbook, last seen 14:02, saved up to save 0. Take over?");
		expect(screen(app)).not.toContain("turn 0");
		await answer(app, "Take over?", "n"); await app.idle(); expect(deps.launched).toEqual([]);
	});

	it("refreshes a cached stale lock that was released, then launches without asking", async () => {
		const lock = await hold(true); const { app, deps } = setup(); await settle(); app.refresh();
		await storage.release("Atlas", lock); keys(app, "L"); await inItsFolder(app); await app.idle();
		expect(deps.launched).toEqual(["Atlas"]); expect(app.host.current).toBeUndefined();
	});

	it("keeps rendering during a refresh and shares its request with background refreshes", async () => {
		const { app, deps } = setup(); await settle();
		const list = storage.list.bind(storage); let calls = 0;
		let complete!: (lanes: LaneEntry[]) => void;
		storage.list = () => { calls++; return new Promise((resolve) => { complete = resolve; }); };
		keys(app, "L"); await settle(); app.refresh();
		expect(screen(app)).toContain("Checking Atlas on home"); expect(calls).toBe(1);
		expect(deps.launched).toEqual([]); expect(app.host.current).toBeUndefined();
		// The remote answers; then the folder is asked.
		complete(await list()); await inItsFolder(app); await app.idle(); expect(deps.launched).toEqual(["Atlas"]);
	});

	it("refuses to launch if the refresh fails, even with a cached free lane", async () => {
		const { app, deps } = setup(); await settle();
		storage.list = async () => { throw new RemoteError("auth", "hidden-token"); };
		keys(app, "L"); await app.idle();
		expect(deps.launched).toEqual([]); expect(screen(app)).toContain("Could not check remote home");
		expect(screen(app)).not.toContain("hidden-token");
	});

	it("does not ask to take over a holder on this device", async () => {
		await hold(); const config = loadConfig(path);
		mkdirSync(config.dataDir, { recursive: true }); writeFileSync(config.deviceIdPath, peer.device);
		const { app, deps } = setup(); keys(app, "L"); await inItsFolder(app); await app.idle();
		expect(deps.launched).toEqual(["Atlas"]); expect(app.host.current).toBeUndefined();
	});

	it("does not launch when the stale holder renews while the confirmation is open", async () => {
		const lock = await hold(true); const { app, deps } = setup();
		keys(app, "L"); await inItsFolder(app); expect(app.host.current?.title).toBe(question);
		await storage.renew("Atlas", lock);
		await answer(app, "Take over?", "y"); await app.idle();
		expect(deps.launched).toEqual([]); expect(screen(app)).toContain("its lock is not stale");
		expect((await storage.list())[0].lock).toMatchObject({ held: true, lock, holder: peer });
	});

	it("does not launch when releasing the taken lock fails", async () => {
		await hold(true); const { app, deps } = setup();
		storage.release = async () => { throw new RemoteError("unreachable", "release failed"); };
		keys(app, "L"); await inItsFolder(app); await answer(app, "Take over?", "y"); await app.idle();
		expect(deps.launched).toEqual([]); expect(screen(app)).toContain("release failed");
	});

	it("keeps local L independent of remote checks", async () => {
		writeFileSync(path, readFileSync(path, "utf8").replace('remote = "home"\n', ""));
		const { app, deps } = setup();
		deps.refreshRemote = async () => { throw new Error("local L must not check remotes"); };
		deps.takeoverLane = async () => { throw new Error("local L must not take over"); };
		keys(app, "L"); await inItsFolder(app); await app.idle(); expect(deps.launched).toEqual(["Atlas"]);
	});
});
