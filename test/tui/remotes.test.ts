import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRemoteCommand, laneRemoteCommand, pullLaneCommand, setStorageForTests } from "../../src/cli/remote.ts";
import { editConfigFile, setLaneKey } from "../../src/lane/config-edit.ts";
import { loadConfig } from "../../src/lane/config.ts";
import { laneOverview, OverviewCache } from "../../src/lane/overview.ts";
import { FakeStorage } from "../../src/remote/fake.ts";
import { createKey, keyToCode, sealCheck } from "../../src/remote/crypto.ts";
import { readRemoteSecret, saveRemoteSecret } from "../../src/remote/secrets.ts";
import { RemoteSession } from "../../src/remote/session.ts";
import { laneSettings, remoteLaneSettings } from "../../src/remote/save-format.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import { RemoteError, type LaneEntry } from "../../src/remote/types.ts";
import { lanesPage } from "../../src/tui/pages/lanes.ts";
import { loginsPage } from "../../src/tui/pages/logins.ts";
import { tempDir } from "../lane/support.ts";
import { answer, fakeDeps, keys, makeApp, screen, settle, typed } from "./support.ts";

const ENTER = "\r";
let dir: string;
let path: string;
let storage: FakeStorage;
let now: number;
const peer = { machine: "macbook", device: "other-device", pid: 900 };
beforeEach(() => {
	dir = tempDir("orrery-tui-remotes-"); path = join(dir, "config.toml");
	now = 1_000_000; storage = new FakeStorage({ name: "home", now: () => now });
	writeFileSync(path, `data_dir = "${dir}/data"\n[lanes.Atlas]\nworkspace = "${dir}"\ncompactor_model = "openai/gpt-6.1-sol"\nremote = "home" # keep this\n[lanes.Birch]\nworkspace = "${dir}/birch"\ncompactor_model = "openai/gpt-6.1-sol"\n[remotes.home]\nkind = "cloudflare"\nurl = "https://example.com"\n`);
});
afterEach(() => { setStorageForTests(undefined); rmSync(dir, { recursive: true, force: true }); });

function setup(cache = new OverviewCache({ storage: () => storage, now: () => now })) {
	const deps = fakeDeps({ configPath: path, loadConfig: () => loadConfig(path),
		editConfig: (edit) => editConfigFile(path, edit), overview: (config) => laneOverview(config, { cache, now }),
		remotes: (config) => cache.remotes(config),
		addRemote: (name, options, interaction) => addRemoteCommand(path, name, options, interaction),
		remoteLanes: (_config, _name) => storage.list(),
		pullLane: (name, remote, folder) => pullLaneCommand(path, name, remote, folder),
		pushLane: (name, remote) => laneRemoteCommand(path, ["push", name], { to: remote }),
		localLane: (name) => laneRemoteCommand(path, ["local", name]),
	});
	return { deps, app: makeApp(deps, [lanesPage, loginsPage]) };
}

describe("background remote overview", () => {
	it.each(["open", "working", "closed"] as const)("keeps local %s state before remote holder and stale status", async (state) => {
		await storage.take("Atlas", peer); now += 181000;
		const { app } = setup(); await settle(); app.refresh();
		app.lanes = app.lanes.map((lane) => lane.name === "Atlas" ? { ...lane, state } : lane);
		expect(screen(app)).toContain(`${state} · open on macbook (stale)`);
		for (const width of [60, 80, 100, 120]) expect(app.render(width).every((line) => line.length <= width)).toBe(true);
	});
	it("never waits for list, shows a cache miss as …, then shows where a lane is open", async () => {
		let resolve!: (entries: LaneEntry[]) => void;
		let calls = 0;
		const list = storage.list.bind(storage);
		await storage.take("Atlas", peer);
		storage.list = () => { calls++; return new Promise((done) => { resolve = done; }); };
		const { app } = setup();
		expect(screen(app)).toContain("Memory");
		expect(screen(app)).toMatch(/Atlas.*…/);
		expect(screen(app)).toContain("local");
		await settle(); expect(calls).toBe(1);
		app.refresh(); screen(app); await settle(); expect(calls).toBe(1);
		resolve(await list()); await settle(); app.refresh();
		expect(screen(app)).toContain("open on macbook");
		expect(screen(app)).toContain("home");
		expect(app.lanes[0].heldElsewhere).toMatchObject({ machine: "macbook", lastSeen: now });
	});

	it("shares one 30 s cache across lanes and Logins, and retries a failed refresh after the interval", async () => {
		let calls = 0; let fail = false;
		const list = storage.list.bind(storage);
		storage.list = async () => { calls++; if (fail) throw new RemoteError("unreachable", "secret must not be rendered"); return list(); };
		const cache = new OverviewCache({ storage: () => storage, now: () => now });
		const { app } = setup(cache); await settle(); app.refresh(); app.showPage("logins");
		await settle(); expect(calls).toBe(1); expect(screen(app)).toMatch(/home\s+cloudflare\s+✓/);
		now += 29_999; app.refresh(); await settle(); expect(calls).toBe(1);
		now++; fail = true; app.refresh(); await settle();
		expect(calls).toBe(2); expect(screen(app)).toMatch(/home\s+cloudflare\s+✗/);
		expect(screen(app)).not.toContain("secret must not be rendered");
		app.refresh(); await settle(); expect(calls).toBe(2);
		now += 30_000; fail = false; app.refresh(); await settle();
		expect(calls).toBe(3); expect(screen(app)).toMatch(/home\s+cloudflare\s+✓/);
	});

	it("does not mark this device as elsewhere and never creates a device id to render", async () => {
		const config = loadConfig(path);
		const cache = new OverviewCache({ storage: () => storage, now: () => now });
		await storage.take("Atlas", peer);
		laneOverview(config, { cache }); await settle();
		expect(laneOverview(config, { cache })[0].heldElsewhere?.machine).toBe("macbook");
		expect(existsSync(config.deviceIdPath)).toBe(false);
		mkdirSync(join(dir, "data"), { recursive: true });
		writeFileSync(config.deviceIdPath, `${peer.device}\n`);
		expect(laneOverview(config, { cache })[0].heldElsewhere).toBeUndefined();
		expect(laneOverview(config, { cache })[1].remote).toBeUndefined();
	});

	it("invalidates cached reachability when a configured endpoint changes", async () => {
		let calls = 0;
		const cache = new OverviewCache({ storage: () => { calls++; return storage; }, now: () => now });
		cache.remotes(loadConfig(path)); await settle();
		writeFileSync(path, readFileSync(path, "utf8").replace("https://example.com", "https://changed.example.com"));
		expect(cache.remotes(loadConfig(path))[0].reachable).toBeUndefined();
		await settle(); expect(calls).toBe(2);
	});
});

describe("N add a lane from a remote", () => {
	async function seedImport() {
		const key = createKey();
		const laneDir = join(dir, "source", "Cedar");
		const store = MemoryStore.open(join(laneDir, "memory.sqlite"));
		store.append("user", "memory from another machine"); store.close();
		await RemoteSession.push({ lane: "Cedar", laneDir, storage, key, holder: peer, report: () => {}, settings: { tool: "claude-code", compactorModel: "openai/gpt-6.1-sol", compactorThinking: "high", viewBytes: 73000, compactorJobs: 5, reads: ["Birch"] } });
		saveRemoteSecret(loadConfig(path), "home", { key: keyToCode(key), token: "hidden-cloud-token" });
		setStorageForTests(() => storage);
	}

	async function startImport(app: ReturnType<typeof setup>["app"]) {
		keys(app, "N"); await settle();
		expect(screen(app)).toContain("Add a lane from a remote");
		await answer(app, "Add a lane:", ...typed("from a remote"), ENTER);
	}

	it("picks remote, lane and folder and pulls real memory through the CLI's shared code", async () => {
		await seedImport();
		await storage.take("Atlas", peer); // already configured here: never offer it for import
		const { app } = setup();
		await startImport(app); await answer(app, "Remote:", ...typed("home"), ENTER);
		expect(screen(app)).toContain("Cedar"); expect(screen(app)).not.toContain("Atlas");
		await answer(app, "Lane on home:", ...typed("Cedar"), ENTER);
		await answer(app, "Its folder:", "\x15", ...typed(dir), ENTER);
		await app.idle();
		const lane = loadConfig(path).lanes.get("Cedar")!;
		expect(lane).toMatchObject({ remote: "home", workspace: dir, tool: "claude-code", memory: { viewBytes: 73000 }, compactor: { jobs: 5 }, reads: ["Birch"] });
		const store = MemoryStore.openReadOnly(join(lane.dir, "memory.sqlite"));
		try { expect(store.root.map((m) => m.text)).toEqual(["memory from another machine"]); } finally { store.close(); }
		expect((await storage.list()).find((e) => e.lane === "Cedar")?.lock?.held).toBe(false);
		expect(screen(app)).toContain("Pulled Cedar"); expect(screen(app)).not.toContain("hidden-cloud-token");
	});

	it.each(["Add a lane:", "Remote:", "Lane on home:", "Its folder:"])("cancelling %s leaves config and remote locks unchanged", async (at) => {
		await seedImport(); const before = readFileSync(path, "utf8"); const locks = await storage.list();
		const { app } = setup(); keys(app, "N"); await settle(); expect(screen(app)).toContain("Add a lane from a remote");
		if (at !== "Add a lane:") await answer(app, "Add a lane:", ...typed("from a remote"), ENTER);
		if (at === "Lane on home:" || at === "Its folder:") await answer(app, "Remote:", ENTER);
		if (at === "Its folder:") await answer(app, "Lane on home:", ENTER);
		await answer(app, at, "\x1b"); await app.idle();
		expect(readFileSync(path, "utf8")).toBe(before); expect(await storage.list()).toEqual(locks);
	});

	it("keeps rendering while a remote listing is slow", async () => {
		await seedImport(); const { app, deps } = setup();
		let complete!: (lanes: LaneEntry[]) => void;
		deps.remoteLanes = () => new Promise((resolve) => { complete = resolve; });
		await startImport(app); await answer(app, "Remote:", ENTER);
		expect(screen(app)).toContain("Loading lanes from home"); expect(app.host.current).toBeUndefined();
		complete(await storage.list()); await settle();
		await answer(app, "Lane on home:", "\x1b"); await app.idle();
	});

	it("reports an empty remote and an unreachable remote without adding a lane", async () => {
		const before = readFileSync(path, "utf8"); const { app, deps } = setup();
		await startImport(app); await answer(app, "Remote:", ENTER); await app.idle();
		expect(screen(app)).toContain("No new lanes on remote home");
		deps.remoteLanes = async () => { throw new RemoteError("unreachable", "remote home is unreachable"); };
		await startImport(app); await answer(app, "Remote:", ENTER); await app.idle();
		expect(screen(app)).toContain("remote home is unreachable"); expect(readFileSync(path, "utf8")).toBe(before);
	});

	it("keeps the existing new-local-lane flow available when remotes are configured", async () => {
		const { app } = setup(); keys(app, "N"); await settle();
		expect(screen(app)).toContain("New local lane");
		await answer(app, "Add a lane:", ...typed("New local"), ENTER);
		await answer(app, "New lane's name", "\x1b"); await app.idle();
	});
});

describe("memory home and remote dialogs", () => {
	it("keeps the Memory heading readable when every lane is local", () => {
		writeFileSync(path, readFileSync(path, "utf8").replace('remote = "home" # keep this\n', ""));
		const { app } = setup();
		for (const width of [60, 80, 100, 120]) {
			expect(screen(app, width)).toContain("Memory");
			expect(screen(app, width)).toContain("local");
		}
	});

	it("E fetches the newest remote memory before making the lane local, preserving comments", async () => {
		const key = createKey(); const lane = loadConfig(path).lanes.get("Atlas")!;
		const laneDir = join(dir, "peer"); const store = MemoryStore.open(join(laneDir, "memory.sqlite"));
		store.append("user", "newest remote memory"); store.close();
		await RemoteSession.push({ lane: "Atlas", laneDir, storage, key, holder: peer, report: () => {}, settings: laneSettings(lane) });
		saveRemoteSecret(loadConfig(path), "home", { key: keyToCode(key), token: "token" }); setStorageForTests(() => storage);
		const { app } = setup();
		keys(app, "E"); await answer(app, "change which setting", ...typed("Memory home"), ENTER);
		await answer(app, "Memory home", ...typed("local"), ENTER); await app.idle();
		expect(loadConfig(path).lanes.get("Atlas")?.remote).toBeUndefined();
		expect(readFileSync(path, "utf8")).toContain("# keep this");
		const fetched = MemoryStore.openReadOnly(join(lane.dir, "memory.sqlite"));
		try { expect(fetched.root.map((m) => m.text)).toEqual(["newest remote memory"]); } finally { fetched.close(); }
		expect((await storage.list())[0].lock?.held).toBe(false);
	});

	it("E pushes local memory before selecting its remote home", async () => {
		editConfigFile(path, (text, d) => setLaneKey(text, d, "Atlas", "remote", ""));
		const key = createKey(); const lane = loadConfig(path).lanes.get("Atlas")!;
		saveRemoteSecret(loadConfig(path), "home", { key: keyToCode(key), token: "token" }); setStorageForTests(() => storage);
		const store = MemoryStore.open(join(lane.dir, "memory.sqlite")); store.append("user", "my local memory"); store.close();
		const { app } = setup();
		keys(app, "E"); await answer(app, "change which setting", ...typed("Memory home"), ENTER);
		await answer(app, "Memory home", ...typed("home"), ENTER); await app.idle();
		expect(loadConfig(path).lanes.get("Atlas")?.remote).toBe("home");
		expect((await remoteLaneSettings(storage, key, "Atlas")).settings.compactorModel).toBe("openai/gpt-6.1-sol");
		const copy = await RemoteSession.checkOut({ lane: "Atlas", laneDir: join(dir, "verify"), storage, key, holder: peer, report: () => {}, settings: laneSettings(lane) }); await copy.close();
		const fetched = MemoryStore.openReadOnly(join(dir, "verify", "memory.sqlite"));
		try { expect(fetched.root.map((m) => m.text)).toEqual(["my local memory"]); } finally { fetched.close(); }
	});

	it("E refuses moving between two remotes and leaves the config alone", async () => {
		writeFileSync(path, `${readFileSync(path, "utf8")}\n[remotes.other]\nkind = "cloudflare"\nurl = "https://other.example.com"\n`);
		const before = readFileSync(path, "utf8"); const { app } = setup();
		keys(app, "E"); await answer(app, "change which setting", ...typed("Memory home"), ENTER);
		await answer(app, "Memory home", ...typed("other"), ENTER); await app.idle();
		expect(screen(app)).toContain("make it local first"); expect(readFileSync(path, "utf8")).toBe(before);
	});

	it.each(["local", "home"])("E keeps memory home unchanged when the %s operation fails", async (target) => {
		if (target === "home") editConfigFile(path, (text, d) => setLaneKey(text, d, "Atlas", "remote", ""));
		saveRemoteSecret(loadConfig(path), "home", { key: keyToCode(createKey()), token: "token" }); setStorageForTests(() => storage);
		storage.fetch = async () => { throw new RemoteError("unreachable", "offline"); };
		storage.snapshot = async () => { throw new RemoteError("unreachable", "offline"); };
		const before = readFileSync(path, "utf8"); const { app } = setup();
		keys(app, "E"); await answer(app, "change which setting", ...typed("Memory home"), ENTER);
		await answer(app, "Memory home", ...typed(target), ENTER); await app.idle();
		expect(screen(app)).toContain("offline"); expect(readFileSync(path, "utf8")).toBe(before);
	});

	it("shows Memory at narrow widths and filters by the remote holder", async () => {
		await storage.take("Atlas", peer);
		const { app } = setup(); await settle(); app.refresh();
		for (const width of [60, 80, 100, 120]) { expect(screen(app, width)).toContain("Memory"); expect(app.render(width).every((line) => line.length <= width)).toBe(true); }
		keys(app, "/", ...typed("macbook")); expect(screen(app)).toContain("Atlas"); expect(screen(app)).not.toContain("Birch");
	});

	it("Logins shows a new recovery code once in its own modal, while keeping the token hidden", async () => {
		setStorageForTests(() => storage);
		const { app } = setup(); app.showPage("logins");
		const frames: string[] = [];
		keys(app, "R"); await answer(app, "Remote name", ...typed("cloud"), ENTER);
		await answer(app, "Remote kind", ...typed("cloudflare"), ENTER);
		await answer(app, "Worker URL", ...typed("https://cloud.example.com"), ENTER);
		await settle(); frames.push(screen(app));
		await answer(app, "Cloudflare access token", "\x1b[200~token-never-display\x1b[201~");
		frames.push(screen(app)); keys(app, ENTER); await settle();
		const config = loadConfig(path); const secret = readRemoteSecret(config, "cloud")!;
		expect(config.remotes.get("cloud")?.kind).toBe("cloudflare");
		expect(secret.token).toBe("token-never-display");
		expect(await storage.getCheck()).toBeDefined();
		expect(frames.join("\n")).not.toContain(secret.key); expect(frames.join("\n")).not.toContain(secret.token);
		expect(screen(app)).toContain("Keep this recovery code somewhere safe");
		for (const width of [60, 120]) expect(screen(app, width).split(secret.key)).toHaveLength(2);
		expect(screen(app)).not.toContain(secret.token);
		await answer(app, "Recovery code", ENTER); await app.idle(); app.refresh();
		expect(screen(app)).not.toContain(secret.key); expect(screen(app)).toContain("Added remote cloud");
	});

	it("Logins imports an existing recovery code without displaying it again", async () => {
		const key = createKey(); await storage.putCheck(sealCheck(key)); setStorageForTests(() => storage);
		const { app } = setup(); app.showPage("logins");
		keys(app, "R"); await answer(app, "Remote name", ...typed("cloud"), ENTER);
		await answer(app, "Remote kind", ...typed("cloudflare"), ENTER);
		await answer(app, "Worker URL", ...typed("https://cloud.example.com"), ENTER);
		await answer(app, "Cloudflare access token", ...typed("hidden-token"), ENTER);
		await answer(app, "Recovery code", ...typed(keyToCode(key)));
		expect(screen(app)).not.toContain(keyToCode(key)); keys(app, ENTER); await app.idle();
		expect(app.host.current).toBeUndefined(); expect(screen(app)).not.toContain(keyToCode(key));
		expect(readRemoteSecret(loadConfig(path), "cloud")?.key).toBe(keyToCode(key));
	});

	it("cancelling Add remote leaves the config alone", async () => {
		const before = readFileSync(path, "utf8"); const { app } = setup(); app.showPage("logins");
		keys(app, "R"); await answer(app, "Remote name", "\x1b"); await app.idle();
		expect(readFileSync(path, "utf8")).toBe(before);
	});
});
