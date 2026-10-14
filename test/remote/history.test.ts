/**
 * A remote lane's history has an identity: a check-out whose remote holds another history under the same remote and
 * lane name (the lane removed and pushed again, or the remote replaced) keeps this machine's memory and instructions
 * aside instead of replacing them silently.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/memory/store.ts";
import { createKey, seal } from "../../src/remote/crypto.ts";
import { FakeStorage } from "../../src/remote/fake.ts";
import { INSTRUCTIONS_KEY } from "../../src/remote/instructions-sync.ts";
import { encodeSnapshot, snapshotBytes } from "../../src/remote/save-format.ts";
import { HISTORY_KEY, RemoteSession } from "../../src/remote/session.ts";
import { RemoteError, STALE_MS } from "../../src/remote/types.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const settings = { compactorModel: "openai/gpt-6.1-sol", compactorThinking: "low" };

interface Machine {
	readonly dir: string;
	readonly reports: string[];
	readonly holder: { machine: string; device: string; pid: number };
}

function scene() {
	const root = mkdtempSync(join(tmpdir(), "orrery-history-"));
	roots.push(root);
	const machine = (name: string): Machine => {
		const dir = join(root, name);
		mkdirSync(dir, { recursive: true });
		return { dir, reports: [], holder: { machine: name, device: `device-${name}`, pid: process.pid } };
	};
	const clock = { value: 1_000_000 };
	return { clock, storage: new FakeStorage({ name: "home", now: () => clock.value }), key: createKey(), pc: machine("pc"), mac: machine("mac"), other: machine("other"), probe: machine("probe") };
}
type Scene = ReturnType<typeof scene>;
type Remote = { readonly storage: FakeStorage; readonly key: Uint8Array };

const db = (m: Machine) => join(m.dir, "memory.sqlite");

async function hold(remote: Remote, m: Machine): Promise<{ session: RemoteSession; store: MemoryStore }> {
	const session = await RemoteSession.checkOut({ lane: "Atlas", laneDir: m.dir, storage: remote.storage, key: remote.key, holder: m.holder, report: (text) => m.reports.push(text), settings, renewMs: 0, confirmTakeover: async () => true });
	const store = MemoryStore.open(db(m));
	session.attach(store);
	return { session, store };
}

async function open(remote: Remote, m: Machine, turn?: string): Promise<void> {
	const { session, store } = await hold(remote, m);
	if (turn !== undefined) store.append("user", turn);
	await session.close();
	store.close();
}

/** Saves fail as if the remote were offline, until the returned function is called. */
function offline(remote: Remote): () => void {
	const save = remote.storage.save.bind(remote.storage);
	remote.storage.save = async () => {
		throw new RemoteError("unreachable", "offline");
	};
	return () => {
		remote.storage.save = save;
	};
}

/** A snapshot of saves 1..n from machine m's copy, uploaded as any machine making save n would. */
async function snapshotFrom(remote: Remote, m: Machine, n: number): Promise<void> {
	const taken = await remote.storage.take("Atlas", m.holder, { force: true });
	if (!taken.ok) throw new Error("held");
	const plain = encodeSnapshot({ v: 1, n, lock: taken.lock, machine: m.holder.machine, at: new Date().toISOString(), settings }, snapshotBytes(db(m)));
	await remote.storage.snapshot("Atlas", taken.lock, n, seal(remote.key, "Atlas", "snapshot", n, plain));
	await remote.storage.release("Atlas", taken.lock);
}

/** The copy as a build from before identities left it: no identity in its store or in its state's marks. */
function withoutIdentity(m: Machine): void {
	const sqlite = new DatabaseSync(db(m));
	try {
		sqlite.prepare("DELETE FROM meta WHERE key = ?").run(HISTORY_KEY);
	} finally {
		sqlite.close();
	}
	const path = join(m.dir, "remote-state.json");
	const state = JSON.parse(readFileSync(path, "utf8")) as { marks: { meta: Record<string, string> } };
	delete state.marks.meta[HISTORY_KEY];
	writeFileSync(path, JSON.stringify(state));
}

/** The store's history identity, and the hash remote-state.json records for it. */
function identity(m: Machine): { id: string | undefined; recorded: string | undefined } {
	const store = MemoryStore.openReadOnly(db(m));
	try {
		const state = JSON.parse(readFileSync(join(m.dir, "remote-state.json"), "utf8")) as { marks: { meta: Record<string, string> } };
		return { id: store.getMeta(HISTORY_KEY), recorded: state.marks.meta[HISTORY_KEY] };
	} finally {
		store.close();
	}
}

/** What the remote holds: a fresh copy's store, checked out by a machine with no folder of its own. */
async function remoteMeta(s: Scene, key: string): Promise<string | undefined> {
	rmSync(s.probe.dir, { recursive: true, force: true });
	mkdirSync(s.probe.dir);
	const session = await RemoteSession.checkOut({ lane: "Atlas", laneDir: s.probe.dir, storage: s.storage, key: s.key, holder: s.probe.holder, report: () => {}, settings, renewMs: 0 });
	await session.close();
	const store = MemoryStore.openReadOnly(db(s.probe));
	try {
		return store.getMeta(key);
	} finally {
		store.close();
	}
}

async function push(remote: Remote, m: Machine, turn: string, instructions?: string): Promise<void> {
	const store = MemoryStore.open(db(m));
	store.append("user", turn);
	store.close();
	if (instructions !== undefined) writeFileSync(join(m.dir, "instructions.md"), instructions);
	await RemoteSession.push({ lane: "Atlas", laneDir: m.dir, storage: remote.storage, key: remote.key, holder: m.holder, report: (text) => m.reports.push(text), settings });
}

/** A push by a build from before history identities: a snapshot 0 of a store with no identity. */
async function olderPush(remote: Remote, m: Machine, turn: string): Promise<void> {
	const store = MemoryStore.open(db(m));
	store.append("user", turn);
	store.close();
	const taken = await remote.storage.take("Atlas", m.holder, { force: true });
	if (!taken.ok) throw new Error("held");
	const plain = encodeSnapshot({ v: 1, n: 0, lock: taken.lock, machine: m.holder.machine, at: new Date().toISOString(), settings }, snapshotBytes(db(m)));
	await remote.storage.snapshot("Atlas", taken.lock, 0, seal(remote.key, "Atlas", "snapshot", 0, plain));
	await remote.storage.release("Atlas", taken.lock);
}

/** A backup of the remote as it is now, under the same name: restored later, it is the remote rolled back to this point. */
async function backupOf(s: Scene): Promise<Remote> {
	const backup = { storage: new FakeStorage({ name: "home" }), key: s.key };
	const now = await s.storage.fetch("Atlas", -1);
	const taken = await backup.storage.take("Atlas", s.pc.holder, { force: true });
	if (!taken.ok || now.snapshot === undefined) throw new Error("setup");
	await backup.storage.snapshot("Atlas", taken.lock, now.snapshot.n, now.snapshot.file);
	for (const save of now.saves) await backup.storage.save("Atlas", taken.lock, save.n, save.file, new Uint8Array([1]));
	await backup.storage.release("Atlas", taken.lock);
	return backup;
}

/** The lane is taken off the remote (orrery lane local --delete-remote on some machine). */
async function drop(remote: Remote, m: Machine): Promise<void> {
	const taken = await remote.storage.take("Atlas", m.holder, { force: true });
	if (!taken.ok) throw new Error("held");
	await remote.storage.drop("Atlas", taken.lock);
}

const texts = (path: string) => {
	const store = MemoryStore.openReadOnly(path);
	try {
		return store.root.map((m) => m.text);
	} finally {
		store.close();
	}
};
const keptMemory = (m: Machine) => readdirSync(m.dir).filter((name) => name.startsWith("memory-before-remote-"));
const keptTurns = (m: Machine) => readdirSync(m.dir).filter((name) => name.startsWith("unsaved-"));
const keptInstructions = (m: Machine) => readdirSync(m.dir).filter((name) => name.startsWith("instructions-unsaved-"));
const instructions = (m: Machine) => readFileSync(join(m.dir, "instructions.md"), "utf8");

describe("another history under the same names", () => {
	it("the lane removed from the remote and pushed again: this machine's memory and instructions are kept aside, with true notices", async () => {
		const s = scene();
		await push(s, s.pc, "a PC turn", "X the agreed text\n");
		await open(s, s.mac, "a Mac turn");
		expect(instructions(s.mac)).toBe("X the agreed text\n");
		await drop(s, s.pc);
		await push(s, s.other, "an unrelated turn", "Z an unrelated Atlas\n");
		s.mac.reports.length = 0;
		await open(s, s.mac);
		expect(texts(db(s.mac))).toEqual(["an unrelated turn"]);
		expect(keptMemory(s.mac)).toHaveLength(1);
		const aside = join(s.mac.dir, keptMemory(s.mac)[0] as string);
		expect(texts(aside)).toEqual(["a PC turn", "a Mac turn"]);
		expect(instructions(s.mac)).toBe("Z an unrelated Atlas\n");
		expect(keptInstructions(s.mac)).toHaveLength(1);
		const instructionsAside = join(s.mac.dir, keptInstructions(s.mac)[0] as string);
		expect(readFileSync(instructionsAside, "utf8")).toBe("X the agreed text\n");
		expect(s.mac.reports).toEqual([
			`Orrery: Atlas: home holds another history of it now (pushed there again, or a replaced remote); the memory on this machine was kept aside as ${aside}, and the lane now uses home's copy.`,
			`Orrery: Atlas's instructions.md here came with the memory set aside; the copy that travels with this memory is used now, and this machine's is kept in ${instructionsAside}.`,
		]);
	});

	it("a replaced remote under the same name: the same", async () => {
		const s = scene();
		await push(s, s.pc, "a PC turn", "X the agreed text\n");
		await open(s, s.mac);
		const replaced = { storage: new FakeStorage({ name: "home" }), key: createKey() };
		await push(replaced, s.other, "an unrelated turn", "Z an unrelated Atlas\n");
		await open(replaced, s.mac);
		expect(texts(db(s.mac))).toEqual(["an unrelated turn"]);
		expect(keptMemory(s.mac)).toHaveLength(1);
		expect(texts(join(s.mac.dir, keptMemory(s.mac)[0] as string))).toEqual(["a PC turn"]);
		expect(instructions(s.mac)).toBe("Z an unrelated Atlas\n");
		expect(keptInstructions(s.mac)).toHaveLength(1);
		expect(s.mac.reports.filter((text) => text.includes("changed on another machine"))).toEqual([]);
	});

	it("a snapshot at this machine's last save that is not the one it saw made: kept aside once as a rollback saved over would be, nothing lost", async () => {
		// A snapshot at n is made and uploaded only by the session that made save n, under its lock (every storage refuses
		// a snapshot under a lock that is not current), so one uploaded after another machine caught up with save n from
		// the save itself does not happen in use. Only its checksum tells it from a rollback another machine saved over
		// with a snapshot at that number, which loses this copy's saves (round 4), so both are kept aside.
		const s = scene();
		await push(s, s.pc, "a PC turn", "v1\n");
		await open(s, s.mac);
		await open(s, s.pc, "a second PC turn");
		await open(s, s.mac);
		// The snapshot of saves 1..1, uploaded after the Mac caught up with save 1 from the save itself.
		await snapshotFrom(s, s.pc, 1);
		s.mac.reports.length = 0;
		await open(s, s.mac, "a Mac turn");
		expect(texts(db(s.mac))).toEqual(["a PC turn", "a second PC turn", "a Mac turn"]);
		expect(keptMemory(s.mac)).toHaveLength(1);
		const aside = join(s.mac.dir, keptMemory(s.mac)[0] as string);
		expect(texts(aside)).toEqual(["a PC turn", "a second PC turn"]);
		expect([...keptTurns(s.mac), ...keptInstructions(s.mac)]).toEqual([]);
		expect(s.mac.reports).toEqual([`Orrery: Atlas: home's copy does not continue the one on this machine; the memory on this machine was kept aside as ${aside}, and the lane now uses home's copy.`]);
		s.mac.reports.length = 0;
		await open(s, s.pc);
		await open(s, s.mac);
		expect(keptMemory(s.mac)).toHaveLength(1);
		expect(s.mac.reports).toEqual([]);
	});
});

describe("a copy from before history identities", () => {
	/** The Mac's working copy as an older build left it: checked out, its state and store without an identity. */
	async function olderCheckOut(s: Scene): Promise<void> {
		const session = await RemoteSession.checkOut({ lane: "Atlas", laneDir: s.mac.dir, storage: s.storage, key: s.key, holder: s.mac.holder, report: () => {}, settings, renewMs: 0 });
		await session.close();
		const sqlite = new DatabaseSync(db(s.mac));
		try {
			sqlite.prepare("DELETE FROM meta WHERE key = ?").run(HISTORY_KEY);
		} finally {
			sqlite.close();
		}
		const state = JSON.parse(readFileSync(join(s.mac.dir, "remote-state.json"), "utf8")) as { marks: { meta: Record<string, string> } };
		expect(state.marks.meta).not.toHaveProperty(HISTORY_KEY);
	}

	it("is adopted at its first intact check-out, which gives the history an identity; from then on another history is kept aside", async () => {
		const s = scene();
		await olderPush(s, s.pc, "a PC turn");
		await olderCheckOut(s);
		await open(s, s.mac, "a Mac turn");
		expect(keptMemory(s.mac)).toEqual([]);
		expect(texts(db(s.mac))).toEqual(["a PC turn", "a Mac turn"]);
		const state = JSON.parse(readFileSync(join(s.mac.dir, "remote-state.json"), "utf8")) as { marks: { meta: Record<string, string> } };
		expect(state.marks.meta).toHaveProperty(HISTORY_KEY);
		await drop(s, s.pc);
		await push(s, s.other, "an unrelated turn", "Z\n");
		await open(s, s.mac);
		expect(keptMemory(s.mac)).toHaveLength(1);
		expect(texts(join(s.mac.dir, keptMemory(s.mac)[0] as string))).toEqual(["a PC turn", "a Mac turn"]);
	});

	it("one whose remote no longer continues it is kept aside, though neither has an identity", async () => {
		const s = scene();
		await olderPush(s, s.pc, "a PC turn");
		await olderCheckOut(s);
		await drop(s, s.pc);
		await olderPush(s, s.other, "an unrelated turn");
		await open(s, s.mac);
		expect(texts(db(s.mac))).toEqual(["an unrelated turn"]);
		expect(keptMemory(s.mac)).toHaveLength(1);
		expect(texts(join(s.mac.dir, keptMemory(s.mac)[0] as string))).toEqual(["a PC turn"]);
		expect(s.mac.reports.some((text) => text.startsWith("Orrery: Atlas: home's copy does not continue the one on this machine;"))).toBe(true);
	});
});

describe("round 3: what a copy can prove, and what a push leaves behind", () => {
	it("a copy from before identities, whose remote's newer snapshot covers its save without a checksum to prove it: kept aside once, instructions too", async () => {
		const s = scene();
		await push(s, s.pc, "a PC turn", "X the old Atlas\n");
		await open(s, s.mac, "a Mac turn");
		withoutIdentity(s.mac);
		await drop(s, s.pc);
		await push(s, s.other, "unrelated 0", "Z an unrelated Atlas\n");
		await open(s, s.other, "unrelated 1");
		await open(s, s.other, "unrelated 2");
		await snapshotFrom(s, s.other, 2);
		s.mac.reports.length = 0;
		await open(s, s.mac);
		expect(texts(db(s.mac))).toEqual(["unrelated 0", "unrelated 1", "unrelated 2"]);
		expect(keptMemory(s.mac)).toHaveLength(1);
		const aside = join(s.mac.dir, keptMemory(s.mac)[0] as string);
		expect(texts(aside)).toEqual(["a PC turn", "a Mac turn"]);
		expect(instructions(s.mac)).toBe("Z an unrelated Atlas\n");
		expect(keptInstructions(s.mac)).toHaveLength(1);
		const instructionsAside = join(s.mac.dir, keptInstructions(s.mac)[0] as string);
		expect(readFileSync(instructionsAside, "utf8")).toBe("X the old Atlas\n");
		expect(s.mac.reports).toEqual([
			`Orrery: Atlas: home's copy could not be shown to continue the one on this machine; the memory on this machine was kept aside as ${aside}, and the lane now uses home's copy.`,
			`Orrery: Atlas's instructions.md here came with the memory set aside; the copy that travels with this memory is used now, and this machine's is kept in ${instructionsAside}.`,
		]);
	});

	it("the same history covered by a newer snapshot, from before identities: one cautious set-aside, nothing lost, then quiet", async () => {
		const s = scene();
		await push(s, s.pc, "a PC turn", "v1\n");
		await open(s, s.mac);
		withoutIdentity(s.mac);
		await open(s, s.pc, "a second PC turn");
		await snapshotFrom(s, s.pc, 1);
		await open(s, s.mac, "a Mac turn");
		expect(keptMemory(s.mac)).toHaveLength(1);
		expect(texts(db(s.mac))).toEqual(["a PC turn", "a second PC turn", "a Mac turn"]);
		s.mac.reports.length = 0;
		await open(s, s.pc);
		await open(s, s.mac);
		expect(keptMemory(s.mac)).toHaveLength(1);
		expect(s.mac.reports).toEqual([]);
	});

	it("a push that fails elsewhere leaves no identity behind: back on its remote, the history keeps its identity", async () => {
		const s = scene();
		await push(s, s.pc, "a PC turn", "X\n");
		await open(s, s.mac, "a Mac turn");
		const online = offline(s);
		await open(s, s.pc, "a PC turn not saved");
		online();
		const before = await remoteMeta(s, HISTORY_KEY);
		const home2 = { storage: new FakeStorage({ name: "home2" }), key: s.key };
		home2.storage.snapshot = async () => {
			throw new RemoteError("unreachable", "offline");
		};
		await expect(push(home2, s.mac, "a Mac turn while moving")).rejects.toThrow("offline");
		await open(s, s.mac);
		expect(await remoteMeta(s, HISTORY_KEY)).toBe(before);
		await open(s, s.pc);
		expect(keptMemory(s.pc)).toEqual([]);
		expect(keptTurns(s.pc)).toHaveLength(1);
		expect(texts(db(s.pc))).toEqual(["a PC turn", "a Mac turn", "a Mac turn while moving"]);
	});

	it("an identity left in a store is never sent over the one its history has, and keeps a due snapshot from being made", async () => {
		const s = scene();
		await push(s, s.pc, "a PC turn", "X\n");
		await open(s, s.mac, "a Mac turn");
		const before = await remoteMeta(s, HISTORY_KEY);
		const online = offline(s);
		await open(s, s.pc, "a PC turn not saved");
		online();
		const store = MemoryStore.open(db(s.mac));
		store.setMeta(HISTORY_KEY, "a leftover");
		store.close();
		// Over 5 MB that does not compress: this save is due a snapshot, which must not carry the leftover either.
		const large = randomBytes(4 * 1024 * 1024).toString("base64");
		await open(s, s.mac, large);
		expect((await s.storage.fetch("Atlas", -1)).snapshot?.n ?? 0).toBe(0);
		expect(await remoteMeta(s, HISTORY_KEY)).toBe(before);
		await open(s, s.pc);
		expect(keptMemory(s.pc)).toEqual([]);
		expect(texts(db(s.pc))).toEqual(["a PC turn", "a Mac turn", large]);
	});

	it("another history pushed with no instructions: the old history's are not sent into it, but kept aside with a true notice; the pusher is told nothing", async () => {
		const s = scene();
		await push(s, s.pc, "a PC turn", "X the old Atlas\n");
		await open(s, s.mac, "a Mac turn");
		await drop(s, s.pc);
		const store = MemoryStore.open(db(s.other));
		store.append("user", "an unrelated turn");
		store.close();
		await RemoteSession.push({ lane: "Atlas", laneDir: s.other.dir, storage: s.storage, key: s.key, holder: s.other.holder, report: (text) => s.other.reports.push(text), settings });
		s.mac.reports.length = 0;
		await open(s, s.mac);
		expect(instructions(s.mac)).toBe("");
		expect(keptInstructions(s.mac)).toHaveLength(1);
		const instructionsAside = join(s.mac.dir, keptInstructions(s.mac)[0] as string);
		expect(readFileSync(instructionsAside, "utf8")).toBe("X the old Atlas\n");
		expect(s.mac.reports[1]).toBe(`Orrery: Atlas's instructions.md here came with the memory set aside; this memory has none, so the file is now empty, and this machine's is kept in ${instructionsAside}.`);
		expect(await remoteMeta(s, INSTRUCTIONS_KEY) ?? "").toBe("");
		await open(s, s.other);
		expect(s.other.reports).toEqual([]);
		expect(readdirSync(s.other.dir)).not.toContain("instructions.md");
	});

	it("a remote rolled back within one history (restored from a backup) is older than this copy: kept aside, naming the rollback", async () => {
		const s = scene();
		await push(s, s.pc, "a PC turn", "v1\n");
		await open(s, s.mac, "Mac turn 1");
		// The backup: the remote as it is now (snapshot 0 and save 1).
		const backup = await backupOf(s);
		await open(s, s.mac, "Mac turn 2");
		await open(s, s.mac, "Mac turn 3");
		s.mac.reports.length = 0;
		await open(backup, s.mac);
		expect(texts(db(s.mac))).toEqual(["a PC turn", "Mac turn 1"]);
		expect(keptMemory(s.mac)).toHaveLength(1);
		const aside = join(s.mac.dir, keptMemory(s.mac)[0] as string);
		expect(texts(aside)).toEqual(["a PC turn", "Mac turn 1", "Mac turn 2", "Mac turn 3"]);
		expect(s.mac.reports[0]).toBe(`Orrery: Atlas: home's copy is older than the one on this machine (rolled back, or restored from a backup), so this machine's newer saves are not on it; the memory on this machine was kept aside as ${aside}, and the lane now uses home's copy.`);
	});
});

describe("round 4: a rollback another machine has saved over", () => {
	// The remote is not older then, and the identity matches; only the save at this copy's number tells, by its checksum.
	for (const past of [false, true]) {
		it(`a remote rolled back within one history, then saved ${past ? "past" : "up to"} this copy's acknowledged save: its memory and instructions are kept aside, with true notices`, async () => {
			const s = scene();
			await push(s, s.pc, "a PC turn", "v1\n");
			await open(s, s.mac, "Mac turn 1");
			await open(s, s.pc);
			// The backup: the remote as it is now (snapshot 0 and save 1), which both machines have.
			const backup = await backupOf(s);
			writeFileSync(join(s.mac.dir, "instructions.md"), "v2 edited on the Mac\n");
			await open(s, s.mac, "Mac turn 2");
			await open(s, s.mac, "Mac turn 3");
			// The restored remote: the PC saves over the Mac's saves 2 and 3, and past them.
			const restored = ["PC turn 2 on the restored remote", "PC turn 3 on the restored remote", ...(past ? ["PC turn 4 on the restored remote"] : [])];
			for (const turn of restored) await open(backup, s.pc, turn);
			s.mac.reports.length = 0;
			await open(backup, s.mac);
			expect(texts(db(s.mac))).toEqual(["a PC turn", "Mac turn 1", ...restored]);
			expect(keptMemory(s.mac)).toHaveLength(1);
			const aside = join(s.mac.dir, keptMemory(s.mac)[0] as string);
			expect(texts(aside)).toEqual(["a PC turn", "Mac turn 1", "Mac turn 2", "Mac turn 3"]);
			expect(keptTurns(s.mac)).toEqual([]);
			expect(instructions(s.mac)).toBe("v1\n");
			expect(keptInstructions(s.mac)).toHaveLength(1);
			const instructionsAside = join(s.mac.dir, keptInstructions(s.mac)[0] as string);
			expect(readFileSync(instructionsAside, "utf8")).toBe("v2 edited on the Mac\n");
			expect(s.mac.reports).toEqual([
				`Orrery: Atlas: home's copy does not continue the one on this machine; the memory on this machine was kept aside as ${aside}, and the lane now uses home's copy.`,
				`Orrery: Atlas's instructions.md here came with the memory set aside; the copy that travels with this memory is used now, and this machine's is kept in ${instructionsAside}.`,
			]);
		});
	}
});

describe("older-pushed lanes: identities given by two machines converge (guards)", () => {
	it("a first attach whose save never landed, while another machine's landed: both end on one identity, nothing set aside", async () => {
		const s = scene();
		await olderPush(s, s.pc, "a PC turn");
		const online = offline(s);
		await open(s, s.mac, "a Mac turn, offline");
		online();
		await open(s, s.other, "another turn");
		await open(s, s.mac, "a Mac turn");
		for (let i = 0; i < 2; i++) {
			await open(s, s.other, `other ${i}`);
			await open(s, s.mac, `mac ${i}`);
		}
		await open(s, s.other);
		expect(identity(s.mac).id).toBeDefined();
		expect(identity(s.mac)).toEqual(identity(s.other));
		expect(identity(s.mac).recorded).toBeDefined();
		expect([...keptMemory(s.mac), ...keptMemory(s.other)]).toEqual([]);
		expect(texts(db(s.other))).toEqual(texts(db(s.mac)));
	});

	it("a lock lost to a takeover before the first save: both end on one identity, nothing set aside", async () => {
		const s = scene();
		await olderPush(s, s.pc, "a PC turn");
		const mac = await hold(s, s.mac);
		s.clock.value += STALE_MS + 1;
		const other = await hold(s, s.other);
		other.store.append("user", "another turn");
		await other.session.close();
		other.store.close();
		mac.store.append("user", "a Mac turn after losing the lock");
		await mac.session.save();
		await mac.session.close();
		mac.store.close();
		await open(s, s.mac, "a Mac turn");
		await open(s, s.other, "another turn again");
		await open(s, s.mac);
		expect(identity(s.mac).id).toBeDefined();
		expect(identity(s.mac)).toEqual(identity(s.other));
		expect([...keptMemory(s.mac), ...keptMemory(s.other)]).toEqual([]);
	});

	it("a copy whose only unsaved row is an identity it gave: another machine saved meanwhile, and nothing is kept as an unsaved turn", async () => {
		const s = scene();
		await olderPush(s, s.pc, "a PC turn");
		await open(s, s.mac, "a Mac turn");
		await open(s, s.other);
		const fresh = s.probe;
		const session = await RemoteSession.checkOut({ lane: "Atlas", laneDir: fresh.dir, storage: s.storage, key: s.key, holder: fresh.holder, report: () => {}, settings, renewMs: 0 });
		await session.close();
		withoutIdentity(fresh);
		const online = offline(s);
		await open(s, fresh);
		online();
		await open(s, s.other, "another turn");
		fresh.reports.length = 0;
		await open(s, fresh);
		expect([...keptTurns(fresh), ...keptMemory(fresh)]).toEqual([]);
		expect(fresh.reports).toEqual([]);
		expect(identity(fresh)).toEqual(identity(s.other));
	});
});
