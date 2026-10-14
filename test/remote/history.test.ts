/**
 * A remote lane's history has an identity: a check-out whose remote holds another history under the same remote and
 * lane name (the lane removed and pushed again, or the remote replaced) keeps this machine's memory and instructions
 * aside instead of replacing them silently.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/memory/store.ts";
import { createKey, seal } from "../../src/remote/crypto.ts";
import { FakeStorage } from "../../src/remote/fake.ts";
import { encodeSnapshot, snapshotBytes } from "../../src/remote/save-format.ts";
import { HISTORY_KEY, RemoteSession } from "../../src/remote/session.ts";

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
	return { storage: new FakeStorage({ name: "home" }), key: createKey(), pc: machine("pc"), mac: machine("mac"), other: machine("other"), probe: machine("probe") };
}
type Scene = ReturnType<typeof scene>;
type Remote = { readonly storage: FakeStorage; readonly key: Uint8Array };

const db = (m: Machine) => join(m.dir, "memory.sqlite");

async function open(remote: Remote, m: Machine, turn?: string): Promise<void> {
	const session = await RemoteSession.checkOut({ lane: "Atlas", laneDir: m.dir, storage: remote.storage, key: remote.key, holder: m.holder, report: (text) => m.reports.push(text), settings, renewMs: 0 });
	const store = MemoryStore.open(db(m));
	session.attach(store);
	if (turn !== undefined) store.append("user", turn);
	await session.close();
	store.close();
}

async function push(remote: Remote, m: Machine, turn: string, instructions: string): Promise<void> {
	const store = MemoryStore.open(db(m));
	store.append("user", turn);
	store.close();
	writeFileSync(join(m.dir, "instructions.md"), instructions);
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
			`Orrery: Atlas's instructions.md here is not the copy that travels with its memory; that copy is used now, and this machine's is kept in ${instructionsAside}.`,
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

	it("a rebuild within one history (a snapshot covering this machine's last save, uploaded late) sets nothing aside", async () => {
		const s = scene();
		await push(s, s.pc, "a PC turn", "v1\n");
		await open(s, s.mac);
		await open(s, s.pc, "a second PC turn");
		await open(s, s.mac);
		// The snapshot of saves 1..1, uploaded after the Mac caught up with save 1 from the save itself.
		const taken = await s.storage.take("Atlas", s.pc.holder, { force: true });
		if (!taken.ok) throw new Error("held");
		const plain = encodeSnapshot({ v: 1, n: 1, lock: taken.lock, machine: "pc", at: new Date().toISOString(), settings }, snapshotBytes(db(s.pc)));
		await s.storage.snapshot("Atlas", taken.lock, 1, seal(s.key, "Atlas", "snapshot", 1, plain));
		await s.storage.release("Atlas", taken.lock);
		s.mac.reports.length = 0;
		await open(s, s.mac, "a Mac turn");
		expect(texts(db(s.mac))).toEqual(["a PC turn", "a second PC turn", "a Mac turn"]);
		expect([...keptMemory(s.mac), ...keptTurns(s.mac), ...keptInstructions(s.mac)]).toEqual([]);
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
			sqlite.prepare("DELETE FROM meta WHERE key = ?").run(HISTORY_KEY ?? "remote.history");
		} finally {
			sqlite.close();
		}
		const state = JSON.parse(readFileSync(join(s.mac.dir, "remote-state.json"), "utf8")) as { marks: { meta: Record<string, string> } };
		expect(state.marks.meta).not.toHaveProperty(HISTORY_KEY ?? "remote.history");
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
