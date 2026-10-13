/** Exercise RemoteSession through both real storage transports, with separate lane folders per machine. */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/memory/store.ts";
import { CloudflareStorage } from "../../src/remote/cloudflare.ts";
import { createKey } from "../../src/remote/crypto.ts";
import type { LaneSettings } from "../../src/remote/save-format.ts";
import { ServerStorage } from "../../src/remote/server.ts";
import { RemoteSession, type RemoteSessionOptions } from "../../src/remote/session.ts";
import { type Holder, RemoteError, type Storage } from "../../src/remote/types.ts";
import { hasWorkerTools, startLocalWorker } from "./cloudflare-worker-support.ts";
import { fakeSsh, serverRemote } from "./fake-ssh.ts";

const settings: LaneSettings = { compactorModel: "openai/gpt-5.1-mini", compactorThinking: "low", tool: "pi" };
const pc: Holder = { machine: "pc", device: "device-pc", pid: process.pid };
const mac: Holder = { machine: "macbook", device: "device-mac", pid: process.pid };
type Backend = { storage: Storage; stop(): Promise<void> };
type OpenSession = { session: RemoteSession; store: MemoryStore };

function scenarios(setup: (root: string) => Promise<Backend>): void {
	let root: string;
	let backend: Backend | undefined;
	let storage: Storage;
	let key: Uint8Array;
	let reports: string[];
	const opened = new Set<OpenSession>();

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "orrery-session-kinds-"));
		key = createKey();
		reports = [];
		backend = await setup(root);
		storage = backend.storage;
	});
	afterEach(async () => {
		try {
			for (const handle of opened) await close(handle);
		} finally {
			try { await backend?.stop(); }
			finally {
				backend = undefined;
				rmSync(root, { recursive: true, force: true });
			}
		}
	});

	function machine(holder: Holder, over: Partial<RemoteSessionOptions> = {}): RemoteSessionOptions {
		return { lane: "Atlas", laneDir: join(root, holder.device, "lanes", "Atlas"), storage, key, holder,
			report: (message) => reports.push(message), renewMs: 0, settings, ...over };
	}
	function dbPath(o: RemoteSessionOptions): string { return join(o.laneDir, "memory.sqlite"); }
	function write(o: RemoteSessionOptions, ...rows: string[]): void {
		const store = MemoryStore.open(dbPath(o));
		try { for (const text of rows) store.append("user", text); }
		finally { store.close(); }
	}
	function texts(o: RemoteSessionOptions): string[] {
		const store = MemoryStore.openReadOnly(dbPath(o));
		try { return store.root.map((row) => row.text); }
		finally { store.close(); }
	}
	async function open(o: RemoteSessionOptions): Promise<OpenSession> {
		const session = await RemoteSession.checkOut(o);
		let store: MemoryStore;
		try { store = MemoryStore.open(dbPath(o)); }
		catch (error) { await session.close(); throw error; }
		session.attach(store);
		const handle = { session, store };
		opened.add(handle);
		return handle;
	}
	async function close(handle: OpenSession): Promise<void> {
		try { await handle.session.close(); }
		finally { handle.store.close(); opened.delete(handle); }
	}
	async function run(o: RemoteSessionOptions, work: (store: MemoryStore, session: RemoteSession) => void | Promise<void> = () => {}): Promise<void> {
		const handle = await open(o);
		try { await work(handle.store, handle.session); }
		finally { await close(handle); }
	}
	async function waitUntilStale(): Promise<void> {
		// Poll the backend clock: the SSH script uses whole seconds, the Worker uses milliseconds.
		const deadline = Date.now() + 10_000;
		do {
			const lock = (await storage.list()).find((entry) => entry.lane === "Atlas")?.lock;
			if (lock?.held && lock.stale) return;
			await pause(50);
		} while (Date.now() < deadline);
		throw new Error("Atlas did not become stale with the backend's short-stale test setting");
	}

	it("first open on a fresh machine restores the initial snapshot", async () => {
		const a = machine(pc), b = machine(mac);
		write(a, "initial user turn", "initial answer");
		await RemoteSession.push(a);
		expect(existsSync(b.laneDir)).toBe(false);
		await run(b);
		expect(texts(b)).toEqual(["initial user turn", "initial answer"]);
		expect(texts(a)).toEqual(texts(b));
	});

	it("saves and reopens on the other machine in both directions", async () => {
		const a = machine(pc), b = machine(mac);
		write(a, "initial");
		await RemoteSession.push(a);
		await run(a, async (store, session) => {
			store.append("user", "from pc");
			await session.save();
			expect(session.status().state).toBe("saved");
		});
		await run(b, (store) => {
			expect(store.root.map((row) => row.text)).toEqual(["initial", "from pc"]);
			store.append("talk", "from macbook");
		});
		await run(a);
		expect(texts(a)).toEqual(["initial", "from pc", "from macbook"]);
		expect(texts(b)).toEqual(texts(a));
		expect((await storage.log("Atlas")).map((entry) => entry.n)).toEqual([1, 2]);
	});

	it("asks before a stale takeover and takes over after yes", async () => {
		const a = machine(pc);
		await RemoteSession.push(a);
		await open(a); // lid shut: no background renewal
		await waitUntilStale();
		const asked: string[] = [];
		await expect(RemoteSession.checkOut(machine(mac, { confirmTakeover: async (held) => {
			asked.push(held.holder.machine);
			return false;
		} }))).rejects.toMatchObject({ kind: "held" });
		const taken = await open(machine(mac, { confirmTakeover: async (held) => {
			asked.push(held.holder.machine);
			expect(held.stale).toBe(true);
			return true;
		} }));
		expect(asked).toEqual(["pc", "pc"]);
		expect((await storage.list())[0].lock).toMatchObject({ held: true, holder: mac });
		await close(taken);
	});

	it("refuses the old holder's save after takeover and stops its later writes", async () => {
		const a = machine(pc), b = machine(mac, { confirmTakeover: async () => true });
		await RemoteSession.push(a);
		let lostCalls = 0;
		const old = await open({ ...a, onLost: () => lostCalls++ });
		await waitUntilStale();
		const current = await open(b);
		old.store.append("user", "old holder's refused turn");
		await old.session.save();
		expect(old.session.lost).toBe(true);
		expect(old.session.status()).toEqual({ remote: storage.name, state: "lost", movedTo: "macbook" });
		expect(reports.at(-1)).toBe("Orrery: Atlas moved to macbook; this session runs without memory now.");
		await old.session.renew();
		await old.session.save();
		await close(old);
		expect(lostCalls).toBe(1);
		expect((await storage.fetch("Atlas", 0)).newestSave).toBe(0);
		expect((await storage.list())[0].lock).toMatchObject({ held: true, holder: mac });
		current.store.append("user", "current holder's turn");
		await close(current);
		await run(b);
		expect(texts(b)).toEqual(["current holder's turn"]);
	});

	it("retries a committed save with a lost reply using identical bytes", async () => {
		const a = machine(pc), b = machine(mac);
		await RemoteSession.push(a);
		const attempts: { n: number; file: Uint8Array; log: Uint8Array }[] = [];
		const lossy = new Proxy(storage, {
			get(target, prop) {
				if (prop === "save") return async (...args: Parameters<Storage["save"]>) => {
					attempts.push({ n: args[2], file: args[3].slice(), log: args[4].slice() });
					await target.save(...args); // commit on the real backend before losing the reply
					if (attempts.length === 1) throw new RemoteError("unreachable", "reply lost");
				};
				const value = Reflect.get(target, prop);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		await run({ ...a, storage: lossy }, async (store, session) => {
			store.append("user", "one");
			await session.save();
			expect(session.status().state).toBe("failing");
			store.append("talk", "two");
			await session.save();
			expect(session.status().state).toBe("saved");
			await session.save();
		});
		expect(attempts.map((entry) => entry.n)).toEqual([1, 1, 2]);
		expect(attempts[1]).toEqual(attempts[0]);
		expect((await storage.fetch("Atlas", 0)).newestSave).toBe(2);
		expect((await storage.log("Atlas")).map((entry) => entry.n)).toEqual([1, 2]);
		await run(b);
		expect(texts(b)).toEqual(["one", "two"]);
	});

	it("takes a snapshot after 200 saves and restores it on a fresh machine", async () => {
		const a = machine(pc), b = machine(mac);
		await RemoteSession.push(a);
		await run(a, async (store, session) => {
			for (let i = 0; i < 200; i++) {
				store.append("user", `m${i}`);
				await session.save();
				expect(session.status().state).toBe("saved");
			}
		});
		expect((await storage.fetch("Atlas", 0)).snapshot?.n).toBe(200);
		const state = JSON.parse(readFileSync(join(a.laneDir, "remote-state.json"), "utf8"));
		expect(state).toMatchObject({ snapshotAt: 200, bytesSinceSnapshot: 0 });
		await run(b);
		expect(texts(b)).toEqual(Array.from({ length: 200 }, (_, i) => `m${i}`));
	}, 90_000);

	it("keeps unsaved split history aside when the other machine saved since", async () => {
		const a = machine(pc), b = machine(mac, { confirmTakeover: async () => true });
		await RemoteSession.push(a);
		const crashed = await open(a);
		crashed.store.append("user", "pc's unsaved turn");
		crashed.store.close(); // crash: no RemoteSession.close(), save, or timer
		opened.delete(crashed);
		await waitUntilStale();
		await run(b, (store) => { store.append("user", "mac's turn"); });
		await run(a);
		expect(texts(a)).toEqual(["mac's turn"]);
		expect(texts(b)).toEqual(texts(a));
		const aside = readdirSync(a.laneDir).filter((file) => /^unsaved-.*\.json$/.test(file));
		expect(aside).toHaveLength(1);
		expect(readFileSync(join(a.laneDir, aside[0]), "utf8")).toContain("pc's unsaved turn");
		expect(reports.some((message) => message.includes(aside[0]))).toBe(true);
	});
}

describe("RemoteSession with server (fake SSH)", () => scenarios(async (root) => {
	const ssh = fakeSsh(join(root, "server"), undefined, { ORRERY_TEST_STALE_SECONDS: "1" });
	return { storage: new ServerStorage(serverRemote("lanes"), join(root, "ssh"), { ssh: ssh.path }), stop: async () => {} };
}));

const cloudflareName = hasWorkerTools ? "RemoteSession with cloudflare (local Worker)"
	: "RemoteSession with cloudflare — skipped: worker/node_modules absent; run cd worker && npm install --ignore-scripts";
describe.skipIf(!hasWorkerTools)(cloudflareName, () => scenarios(async () => {
	const worker = await startLocalWorker(100); // ORRERY_STALE_MS in the actual Worker bindings
	return { storage: new CloudflareStorage({ name: "cloud", kind: "cloudflare", url: "http://127.0.0.1:8787" }, "test-token", { fetch: worker.fetch }), stop: worker.stop };
}));
