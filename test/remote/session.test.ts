import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/memory/store.ts";
import { createKey, unseal } from "../../src/remote/crypto.ts";
import { FakeStorage } from "../../src/remote/fake.ts";
import { decodeSnapshot, type AgentSettings } from "../../src/remote/save-format.ts";
import { RemoteSession, type RemoteSessionOptions } from "../../src/remote/session.ts";
import { type Holder, RemoteError, STALE_MS, type Storage } from "../../src/remote/types.ts";

const settings: AgentSettings = { compactorModel: "openai/gpt-5.1-mini", compactorThinking: "low", tool: "pi" };
const pc: Holder = { machine: "pc", device: "device-pc", pid: process.pid };
const mac: Holder = { machine: "macbook", device: "device-mac", pid: process.pid };

let root: string;
let time: number;
let storage: FakeStorage;
let key: Uint8Array;
let reports: string[];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "orrery-session-"));
	time = Date.UTC(2026, 9, 12, 12, 0, 0);
	storage = new FakeStorage({ name: "home", now: () => time });
	key = createKey();
	reports = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** One machine's view of the agent: its own agent folder. */
function machine(name: string, holder: Holder, over: Partial<RemoteSessionOptions> = {}): RemoteSessionOptions {
	return { agent: "Atlas", agentDir: join(root, name, "agents", "Atlas"), storage, key, holder, report: (m) => reports.push(m), now: () => time, renewMs: 0, settings, ...over };
}

function dbPath(o: RemoteSessionOptions): string {
	return join(o.agentDir, "memory.sqlite");
}

function write(o: RemoteSessionOptions, count: number, from = 0): void {
	const store = MemoryStore.open(dbPath(o));
	try {
		for (let i = 0; i < count; i++) store.append(i % 2 ? "talk" : "user", `turn ${from + i}`);
	} finally {
		store.close();
	}
}

function texts(o: RemoteSessionOptions): string[] {
	const store = MemoryStore.openReadOnly(dbPath(o));
	try {
		return store.root.map((m) => m.text);
	} finally {
		store.close();
	}
}

/** Opens a checked-out agent like an agent would: attach, run `work`, close. */
async function session(o: RemoteSessionOptions, work: (store: MemoryStore, s: RemoteSession) => Promise<void> | void = () => {}): Promise<RemoteSession> {
	const s = await RemoteSession.checkOut(o);
	const store = MemoryStore.open(dbPath(o));
	s.attach(store);
	try {
		await work(store, s);
	} finally {
		await s.close();
		store.close();
	}
	return s;
}

/** Counts storage calls by name. */
function spy(inner: Storage): { storage: Storage; calls: Map<string, number> } {
	const calls = new Map<string, number>();
	const storage = new Proxy(inner, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				calls.set(String(prop), (calls.get(String(prop)) ?? 0) + 1);
				return value.apply(target, args);
			};
		},
	});
	return { storage, calls };
}

describe("RemoteSession", () => {
	it("1: a fresh machine restores the newest snapshot and later saves", async () => {
		const a = machine("a", pc);
		write(a, 4);
		await RemoteSession.push(a);
		await session(a, (store) => {
			store.append("user", "after push");
		});
		const b = machine("b", mac);
		await session(b);
		expect(texts(b)).toEqual(["turn 0", "turn 1", "turn 2", "turn 3", "after push"]);
	});

	it("2: reopening on the machine that saved last fetches only what it lacks", async () => {
		const a = machine("a", pc);
		write(a, 2);
		await RemoteSession.push(a);
		await session(a, (store) => void store.append("user", "x"));
		const { storage: counted, calls } = spy(storage);
		const again = await RemoteSession.checkOut({ ...a, storage: counted });
		await again.close();
		expect(calls.get("snapshot") ?? 0).toBe(0);
		expect(calls.get("save") ?? 0).toBe(0);
		expect(texts(a)).toEqual(["turn 0", "turn 1", "x"]);
	});

	it("3: a save sends exactly the new rows; nothing new sends nothing", async () => {
		const a = machine("a", pc);
		await RemoteSession.push(a);
		await session(a, async (store, s) => {
			store.append("user", "one");
			store.append("talk", "two");
			await s.save();
			expect(s.status()).toMatchObject({ remote: "home", state: "saved" });
			expect(s.status().savedAt).toMatch(/^\d\d:\d\d$/);
			await s.save();
			await s.save();
		});
		const log = await storage.log("Atlas");
		expect(log.map((e) => e.n)).toEqual([1]);
		const header = JSON.parse(Buffer.from(unseal(key, "Atlas", "log", 1, log[0].file)).toString("utf8"));
		expect(header).toMatchObject({ n: 1, machine: "pc", rows: { main: 2 } });
	});

	it("4: 200 saves since the last snapshot take a new snapshot", async () => {
		const a = machine("a", pc);
		await RemoteSession.push(a);
		await session(a, async (store, s) => {
			for (let i = 0; i < 200; i++) {
				store.append("user", `m${i}`);
				await s.save();
			}
		});
		const fresh = await storage.fetch("Atlas", 0);
		expect(fresh.snapshot?.n).toBe(200);
		const state = JSON.parse(readFileSync(join(a.agentDir, "remote-state.json"), "utf8"));
		expect(state.snapshotAt).toBe(200);
		expect(state.bytesSinceSnapshot).toBe(0);
	});

	it("4b: a row written while a snapshot-crossing save uploads never lands in both the snapshot and the next save", async () => {
		const a = machine("a", pc);
		await RemoteSession.push(a);
		let store!: MemoryStore;
		let duringUpload = false;
		const slow = new Proxy(storage, {
			get(target, prop, receiver) {
				const value = Reflect.get(target, prop, receiver);
				if (prop === "save")
					return async (...args: unknown[]) => {
						if (duringUpload) {
							duringUpload = false;
							store.append("talk", "written during the 200th upload");
						}
						return value.apply(target, args);
					};
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as Storage;
		const s = await RemoteSession.checkOut({ ...a, storage: slow });
		store = MemoryStore.open(dbPath(a));
		s.attach(store);
		for (let i = 0; i < 200; i++) {
			store.append("user", `m${i}`);
			if (i === 199) duringUpload = true;
			await s.save();
		}
		await s.save();
		await s.close();
		store.close();
		expect((await storage.fetch("Atlas", 0)).snapshot?.n).toBe(200);
		const b = machine("b", mac);
		await session(b);
		expect(texts(b).at(-1)).toBe("written during the 200th upload");
		expect(texts(b)).toHaveLength(201);
	});

	it("5: a fresh lock elsewhere refuses, naming the machine and time", async () => {
		const a = machine("a", pc);
		await RemoteSession.push(a);
		const held = await RemoteSession.checkOut(a);
		await expect(RemoteSession.checkOut(machine("b", mac))).rejects.toMatchObject({ kind: "held", message: expect.stringMatching(/Atlas is open on pc \(last seen \d\d:\d\d\)/) });
		await held.close();
	});

	it("6: a stale lock asks first; yes takes over, no refuses", async () => {
		const a = machine("a", pc);
		await RemoteSession.push(a);
		await RemoteSession.checkOut(a); // left open: the lid shut
		time += STALE_MS + 1000;
		const asked: string[] = [];
		await expect(RemoteSession.checkOut(machine("b", mac, { confirmTakeover: async (h) => (asked.push(h.holder.machine), false) }))).rejects.toMatchObject({ kind: "held" });
		const taken = await RemoteSession.checkOut(machine("b", mac, { confirmTakeover: async () => true }));
		expect(asked).toEqual(["pc"]);
		expect((await storage.list())[0].lock?.holder.machine).toBe("macbook");
		await taken.close();
	});

	it("7: this device's lock left by a dead process is retaken without asking; a live one is held", async () => {
		const a = machine("a", pc);
		await RemoteSession.push(a);
		await storage.take("Atlas", { ...pc, pid: 2 ** 22 + 12345 }); // a pid that is not running
		const retaken = await RemoteSession.checkOut(machine("a", pc, { confirmTakeover: async () => { throw new Error("must not ask"); } }));
		await retaken.close();
		await storage.take("Atlas", { ...pc, pid: process.ppid }); // alive
		await expect(RemoteSession.checkOut(a)).rejects.toMatchObject({ kind: "held" });
	});

	it("8: a lock lost mid-session stops all writing and says where the agent went", async () => {
		const a = machine("a", pc);
		await RemoteSession.push(a);
		let lostCalls = 0;
		const s = await RemoteSession.checkOut({ ...a, onLost: () => lostCalls++ });
		const store = MemoryStore.open(dbPath(a));
		s.attach(store);
		time += STALE_MS + 1000;
		const theirs = await storage.take("Atlas", mac, { force: true });
		expect(theirs.ok).toBe(true);
		store.append("user", "written after the takeover");
		await s.renew();
		expect(s.lost).toBe(true);
		expect(s.status()).toEqual({ remote: "home", state: "lost", movedTo: "macbook" });
		expect(reports.at(-1)).toBe("Orrery: Atlas moved to macbook; this session runs without memory now.");
		expect(lostCalls).toBe(1);
		await s.save();
		await s.close();
		store.close();
		expect((await storage.fetch("Atlas", 0)).newestSave).toBe(0);
	});

	it("9: failing saves keep every row locally and send them all once reachable", async () => {
		const a = machine("a", pc);
		await RemoteSession.push(a);
		let offline = false;
		const flaky = new Proxy(storage, {
			get(target, prop, receiver) {
				const value = Reflect.get(target, prop, receiver);
				if (prop === "save" || prop === "renew") return (...args: unknown[]) => (offline ? Promise.reject(new RemoteError("unreachable", "no route")) : value.apply(target, args));
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as Storage;
		await session(machine("a", pc, { storage: flaky }), async (store, s) => {
			offline = true;
			store.append("user", "while offline 1");
			await s.save();
			store.append("talk", "while offline 2");
			await s.save();
			expect(s.status()).toMatchObject({ state: "failing", reason: "offline" });
			offline = false;
			await s.save();
			expect(s.status().state).toBe("saved");
		});
		expect(texts(a)).toEqual(["while offline 1", "while offline 2"]);
		const b = machine("b", mac);
		await session(b);
		expect(texts(b)).toEqual(["while offline 1", "while offline 2"]);
	});

	it("10: unsaved rows from a closed session go up first when nobody saved since", async () => {
		const a = machine("a", pc);
		await RemoteSession.push(a);
		const s = await RemoteSession.checkOut(a);
		const store = MemoryStore.open(dbPath(a));
		s.attach(store);
		store.append("user", "never saved");
		store.close(); // crash: no save, no close
		time += STALE_MS + 1000;
		const left = (await storage.list())[0].lock;
		if (left === undefined) throw new Error("no lock");
		await storage.release("Atlas", left.lock); // as if the crashed process's lock had been cleared
		const again = await RemoteSession.checkOut(a);
		await again.close();
		expect((await storage.fetch("Atlas", 0)).newestSave).toBe(1);
		const b = machine("b", mac);
		await session(b);
		expect(texts(b)).toEqual(["never saved"]);
	});

	it("11: unsaved rows are kept aside when another machine saved since", async () => {
		const a = machine("a", pc);
		await RemoteSession.push(a);
		const s = await RemoteSession.checkOut(a);
		const store = MemoryStore.open(dbPath(a));
		s.attach(store);
		store.append("user", "pc's unsaved turn");
		store.close(); // lid shut, no save
		time += STALE_MS + 1000;
		const b = machine("b", mac, { confirmTakeover: async () => true });
		await session(b, (st) => void st.append("user", "mac's turn"));
		await session(machine("a", pc));
		expect(texts(a)).toEqual(["mac's turn"]);
		const aside = readdirSync(a.agentDir).filter((f) => f.startsWith("unsaved-"));
		expect(aside).toHaveLength(1);
		expect(readFileSync(join(a.agentDir, aside[0]), "utf8")).toContain("pc's unsaved turn");
		expect(reports.some((r) => r.includes(aside[0]))).toBe(true);
	});

	it("12: a save whose reply was lost is retried with the same bytes and succeeds", async () => {
		const a = machine("a", pc);
		await RemoteSession.push(a);
		let dropReply = true;
		const lossy = new Proxy(storage, {
			get(target, prop, receiver) {
				const value = Reflect.get(target, prop, receiver);
				if (prop === "save")
					return async (...args: unknown[]) => {
						await value.apply(target, args);
						if (dropReply) {
							dropReply = false;
							throw new RemoteError("unreachable", "reply lost");
						}
					};
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as Storage;
		await session(machine("a", pc, { storage: lossy }), async (store, s) => {
			store.append("user", "one");
			await s.save();
			expect(s.status().state).toBe("failing");
			store.append("user", "two"); // more rows arrive before the retry
			await s.save();
			expect(s.status().state).toBe("saved");
			await s.save();
		});
		expect((await storage.fetch("Atlas", 0)).newestSave).toBe(2);
		const b = machine("b", mac);
		await session(b);
		expect(texts(b)).toEqual(["one", "two"]);
	});

	it("13: a save that won't decrypt refuses the check-out and leaves the working copy alone", async () => {
		const a = machine("a", pc);
		write(a, 1);
		await RemoteSession.push(a);
		const taken = await storage.take("Atlas", mac);
		if (!taken.ok) throw new Error("take");
		await storage.save("Atlas", taken.lock, 1, new Uint8Array([1, 2, 3]), new Uint8Array([4]));
		await storage.release("Atlas", taken.lock);
		const before = texts(a);
		await expect(RemoteSession.checkOut(a)).rejects.toMatchObject({ kind: "corrupt" });
		expect(texts(a)).toEqual(before);
		expect((await storage.list())[0].lock?.held).toBe(false);
	});

	it("14: a replaced remote history rebuilds from the snapshot, keeping this machine's whole memory aside", async () => {
		const a = machine("a", pc);
		await RemoteSession.push(a);
		await session(a, (store) => void store.append("user", "pc saved this"));
		// The agent is dropped and pushed again from another machine's different memory.
		const t = await storage.take("Atlas", mac);
		if (!t.ok) throw new Error("take");
		await storage.drop("Atlas", t.lock);
		const b = machine("b", mac);
		write(b, 3, 100);
		await RemoteSession.push(b);
		await session(b, (store) => void store.append("talk", "mac saved this"));
		const s = await RemoteSession.checkOut(a);
		await s.close();
		expect(texts(a)).toEqual(["turn 100", "turn 101", "turn 102", "mac saved this"]);
		expect(readdirSync(a.agentDir).filter((name) => name.startsWith("memory-before-remote-"))).toHaveLength(1);
	});

	it("15: push refuses an agent already on the remote", async () => {
		const a = machine("a", pc);
		await RemoteSession.push(a);
		await expect(RemoteSession.push(machine("b", mac))).rejects.toMatchObject({ kind: "refused", message: "Atlas is already on remote home; use orrery agent pull" });
	});

	it("16: every snapshot carries the agent's settings", async () => {
		const a = machine("a", pc);
		await RemoteSession.push(a);
		const fetched = await storage.fetch("Atlas", -1);
		const snap = fetched.snapshot;
		if (snap === undefined) throw new Error("no snapshot");
		const { header } = decodeSnapshot(unseal(key, "Atlas", "snapshot", snap.n, snap.file));
		expect(header.settings).toEqual(settings);
		expect(header).toMatchObject({ v: 1, n: 0, machine: "pc" });
	});

	it("keeps local memory aside instead of overwriting it on a first check-out", async () => {
		const a = machine("a", pc);
		write(a, 2);
		await RemoteSession.push(a);
		const b = machine("b", mac);
		write(b, 1, 50); // memory already on the MacBook, never synced
		await session(b);
		expect(texts(b)).toEqual(["turn 0", "turn 1"]);
		expect(readdirSync(b.agentDir).some((f) => f.startsWith("memory-before-remote-"))).toBe(true);
	});

	it("says a never-pushed agent is not on the remote", async () => {
		await expect(RemoteSession.checkOut(machine("a", pc))).rejects.toMatchObject({ kind: "not-found", message: expect.stringContaining("orrery agent push Atlas --to home") });
		expect(await storage.list()).toEqual([]);
	});
});

describe("RemoteSession review fixes", () => {
	/** A storage whose chosen methods can be made to fail or act through `hooks`. */
	function hooked(hooks: Partial<Record<keyof Storage, (call: () => Promise<unknown>, args: unknown[]) => Promise<unknown>>>): Storage {
		return new Proxy(storage, {
			get(target, prop, receiver) {
				const value = Reflect.get(target, prop, receiver);
				if (typeof value !== "function") return value;
				const hook = hooks[prop as keyof Storage];
				if (hook === undefined) return value.bind(target);
				return (...args: unknown[]) => hook(() => value.apply(target, args), args);
			},
		}) as Storage;
	}

	it("adopts a save whose reply was lost before an offline close, and pushes the turn after it", async () => {
		const a = machine("a", pc);
		await RemoteSession.push(a);
		let mode: "drop-reply" | "offline" | "ok" = "drop-reply";
		const flaky = hooked({
			save: async (call) => {
				if (mode === "offline") throw new RemoteError("unreachable", "offline");
				await call();
				if (mode === "drop-reply") {
					mode = "offline";
					throw new RemoteError("unreachable", "reply lost");
				}
			},
			release: async (call) => (mode === "offline" ? Promise.reject(new RemoteError("unreachable", "offline")) : call()),
		});
		const s = await RemoteSession.checkOut({ ...a, storage: flaky });
		const store = MemoryStore.open(dbPath(a));
		s.attach(store);
		store.append("user", "turn A");
		await s.save(); // landed, reply lost
		store.append("talk", "turn B");
		await s.close(); // offline: B never went up, the lock stays
		store.close();
		time += STALE_MS + 1000;
		await session(machine("a", pc));
		expect(readdirSync(a.agentDir).filter((f) => f.startsWith("unsaved-"))).toEqual([]);
		expect(texts(a)).toEqual(["turn A", "turn B"]);
		const b = machine("b", mac);
		await session(b);
		expect(texts(b)).toEqual(["turn A", "turn B"]);
	});

	it("takes an agent off the remote again when its first snapshot fails, so the next push works", async () => {
		const a = machine("a", pc);
		write(a, 1);
		const failing = hooked({ snapshot: async () => Promise.reject(new RemoteError("unreachable", "timeout")) });
		await expect(RemoteSession.push({ ...a, storage: failing })).rejects.toMatchObject({ kind: "unreachable" });
		expect(await storage.list()).toEqual([]);
		await RemoteSession.push(a);
		await session(machine("b", mac));
		expect(texts(machine("b", mac))).toEqual(["turn 0"]);
	});

	it("lets a push take over an agent a failed push left with no snapshot", async () => {
		const a = machine("a", pc);
		write(a, 1);
		const failing = hooked({ snapshot: async () => Promise.reject(new RemoteError("unreachable", "timeout")), drop: async () => Promise.reject(new RemoteError("unreachable", "timeout")) });
		await expect(RemoteSession.push({ ...a, storage: failing })).rejects.toMatchObject({ kind: "unreachable" });
		expect((await storage.list()).map((l) => l.lane)).toEqual(["Atlas"]);
		await RemoteSession.push(a);
		expect((await storage.fetch("Atlas", -1)).snapshot?.n).toBe(0);
	});

	it("rebuilds when the remote's snapshot at our save number is not the one we pushed", async () => {
		const a = machine("a", pc);
		write(a, 2);
		await RemoteSession.push(a); // a stands at save 0, snapshot 0
		const t = await storage.take("Atlas", mac);
		if (!t.ok) throw new Error("take");
		await storage.drop("Atlas", t.lock);
		const b = machine("b", mac);
		write(b, 3, 100);
		await RemoteSession.push(b);
		await session(a, (store) => void store.append("user", "a's turn"));
		expect(texts(a)).toEqual(["turn 100", "turn 101", "turn 102", "a's turn"]);
		const c = machine("c", { machine: "laptop", device: "device-c", pid: process.pid });
		await session(c);
		expect(texts(c)).toEqual(["turn 100", "turn 101", "turn 102", "a's turn"]);
	});

	it("retakes this machine's own stale lock without asking, even from the same process", async () => {
		const a = machine("a", pc);
		await RemoteSession.push(a);
		await storage.take("Atlas", pc); // a release that failed offline, same pid
		time += STALE_MS + 1000;
		const s = await RemoteSession.checkOut({ ...a, confirmTakeover: async () => { throw new Error("must not ask"); } });
		await s.close();
	});

	it("asks before taking a lock whose device id matches but whose machine name does not", async () => {
		const a = machine("a", pc);
		await RemoteSession.push(a);
		await storage.take("Atlas", { machine: "clone", device: pc.device, pid: 2 ** 22 + 99 });
		await expect(RemoteSession.checkOut(a)).rejects.toMatchObject({ kind: "held" });
	});

	it("never throws from renew, save or close when the caller's callbacks throw", async () => {
		const a = machine("a", pc);
		await RemoteSession.push(a);
		const s = await RemoteSession.checkOut({ ...a, report: () => { throw new Error("pi is gone"); }, onLost: () => { throw new Error("pi is gone"); } });
		const store = MemoryStore.open(dbPath(a));
		s.attach(store);
		time += STALE_MS + 1000;
		await storage.take("Atlas", mac, { force: true });
		await expect(s.renew()).resolves.toBeUndefined();
		expect(s.lost).toBe(true);
		await expect(s.save()).resolves.toBeUndefined();
		await expect(s.close()).resolves.toBeUndefined();
		store.close();
	});

	it("leaves the working copy alone when a later save in a catch-up won't decrypt", async () => {
		const a = machine("a", pc);
		await RemoteSession.push(a);
		await session(a, (store) => void store.append("user", "one"));
		const b = machine("b", mac);
		await session(b, (store) => void store.append("user", "two"));
		const t = await storage.take("Atlas", mac);
		if (!t.ok) throw new Error("take");
		await storage.save("Atlas", t.lock, 3, new Uint8Array([9, 9, 9]), new Uint8Array([9]));
		await storage.release("Atlas", t.lock);
		await expect(RemoteSession.checkOut(a)).rejects.toMatchObject({ kind: "corrupt" });
		expect(texts(a)).toEqual(["one"]);
		expect((await storage.list())[0].lock?.held).toBe(false);
	});

	it("retries a failed snapshot instead of reading a new one on every save", async () => {
		const a = machine("a", pc);
		await RemoteSession.push(a);
		const attempts: number[] = [];
		const failing = hooked({
			snapshot: async (_call, args) => {
				const [, , n, file] = args as [string, number, number, Uint8Array];
				attempts.push(decodeSnapshot(unseal(key, "Atlas", "snapshot", n, file)).header.n);
				throw new RemoteError("unreachable", "timeout");
			},
		});
		await session(machine("a", pc, { storage: failing }), async (store, s) => {
			for (let i = 0; i < 205; i++) {
				store.append("user", `m${i}`);
				await s.save();
			}
		});
		expect(attempts.length).toBeGreaterThan(1);
		expect(new Set(attempts)).toEqual(new Set([200]));
		expect((await storage.fetch("Atlas", 0)).newestSave).toBe(205);
	});

	it("takes a snapshot once 5 MB of saves have piled up", async () => {
		const a = machine("a", pc);
		await RemoteSession.push(a);
		await session(a, async (store, s) => {
			for (let i = 0; i < 4; i++) {
				store.append("user", randomBytes(1_500_000).toString("hex"));
				await s.save();
			}
		});
		const snap = (await storage.fetch("Atlas", 0)).snapshot;
		expect(snap?.n).toBeGreaterThanOrEqual(3);
		expect(snap?.n).toBeLessThanOrEqual(4);
	});

	it("ignores a renewal that fails after close released the lock", async () => {
		const a = machine("a", pc);
		await RemoteSession.push(a);
		let finish!: (error: Error) => void;
		let hold = false;
		const slow = hooked({ renew: async (call) => (hold ? new Promise((_, reject) => (finish = reject)) : call()) });
		const s = await RemoteSession.checkOut({ ...a, storage: slow });
		const store = MemoryStore.open(dbPath(a));
		s.attach(store);
		hold = true;
		const renewing = s.renew();
		await s.close();
		finish(new RemoteError("lock-lost", "released"));
		await renewing;
		store.close();
		expect(s.lost).toBe(false);
		expect(reports.filter((r) => r.includes("moved to"))).toEqual([]);
	});

	it("names the machine it took over from in the first save after a takeover", async () => {
		const a = machine("a", pc);
		await RemoteSession.push(a);
		await RemoteSession.checkOut(a); // left open
		time += STALE_MS + 1000;
		await session(machine("b", mac, { confirmTakeover: async () => true }), (store) => void store.append("user", "on the mac"));
		const log = await storage.log("Atlas");
		const header = JSON.parse(Buffer.from(unseal(key, "Atlas", "log", 1, log[0].file)).toString("utf8"));
		expect(header.takeover).toEqual({ from: "pc" });
	});

	it("reopens on the machine that saved last without downloading a snapshot", async () => {
		const a = machine("a", pc);
		await RemoteSession.push(a);
		await session(a, (store) => void store.append("user", "x"));
		const snapshots: number[] = [];
		const watched = hooked({ fetch: async (call) => { const f = (await call()) as { snapshot?: { n: number } }; if (f.snapshot) snapshots.push(f.snapshot.n); return f; } });
		const again = await RemoteSession.checkOut({ ...a, storage: watched });
		await again.close();
		expect(snapshots).toEqual([]);
	});

	it("retakes a lock this same process left after a failed release, but not one it still has open", async () => {
		const a = machine("a", pc);
		await RemoteSession.push(a);
		const open = await RemoteSession.checkOut(a);
		await expect(RemoteSession.checkOut(a)).rejects.toMatchObject({ kind: "held" });
		await open.close();
		await storage.take("Atlas", pc); // this process's lock, left behind: a release that failed offline
		const again = await RemoteSession.checkOut({ ...a, confirmTakeover: async () => { throw new Error("must not ask"); } });
		await again.close();
	});

	it("recognises a snapshot whose reply was lost, so later offline turns are not taken for a split", async () => {
		const a = machine("a", pc);
		await RemoteSession.push(a);
		let offline = false;
		let dropSnapshotReply = true;
		const flaky = hooked({
			snapshot: async (call) => {
				if (offline) throw new RemoteError("unreachable", "offline");
				await call();
				if (dropSnapshotReply) {
					dropSnapshotReply = false;
					offline = true;
					throw new RemoteError("unreachable", "reply lost");
				}
			},
			save: async (call) => (offline ? Promise.reject(new RemoteError("unreachable", "offline")) : call()),
			release: async (call) => (offline ? Promise.reject(new RemoteError("unreachable", "offline")) : call()),
			renew: async (call) => (offline ? Promise.reject(new RemoteError("unreachable", "offline")) : call()),
		});
		const s = await RemoteSession.checkOut({ ...a, storage: flaky });
		const store = MemoryStore.open(dbPath(a));
		s.attach(store);
		for (let i = 0; i < 200; i++) {
			store.append("user", `m${i}`);
			await s.save();
		}
		store.append("talk", "after the lost snapshot reply");
		await s.save();
		await s.close();
		store.close();
		expect((await storage.fetch("Atlas", 199)).snapshot?.n).toBe(200);
		time += STALE_MS + 1000;
		await session(machine("a", pc));
		expect(readdirSync(a.agentDir).filter((f) => f.startsWith("unsaved-"))).toEqual([]);
		expect(texts(a).at(-1)).toBe("after the lost snapshot reply");
		expect((await storage.fetch("Atlas", 0)).newestSave).toBe(201);
	});
});
