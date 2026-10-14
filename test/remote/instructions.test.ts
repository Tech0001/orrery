import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/memory/store.ts";
import { createKey, unseal } from "../../src/remote/crypto.ts";
import { FakeStorage } from "../../src/remote/fake.ts";
import { INSTRUCTIONS_KEY, SYNCED_FILE } from "../../src/remote/instructions-sync.ts";
import { decodeRows } from "../../src/remote/save-format.ts";
import { RemoteSession } from "../../src/remote/session.ts";
import { RemoteError } from "../../src/remote/types.ts";

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

/** Two machines, each with its own copy of Atlas's folder; one remote; one key. */
function scene() {
	const root = mkdtempSync(join(tmpdir(), "orrery-instructions-sync-"));
	roots.push(root);
	const machine = (name: string): Machine => {
		const dir = join(root, name);
		mkdirSync(dir, { recursive: true });
		return { dir, reports: [], holder: { machine: name, device: `device-${name}`, pid: process.pid } };
	};
	return { storage: new FakeStorage({ name: "home" }), key: createKey(), pc: machine("pc"), mac: machine("mac"), probe: machine("probe") };
}
type Scene = ReturnType<typeof scene>;

async function open(s: Scene, m: Machine): Promise<{ session: RemoteSession; store: MemoryStore }> {
	const session = await RemoteSession.checkOut({ agent: "Atlas", agentDir: m.dir, storage: s.storage, key: s.key, holder: m.holder, report: (text) => m.reports.push(text), settings, renewMs: 0 });
	const store = MemoryStore.open(join(m.dir, "memory.sqlite"));
	session.attach(store);
	return { session, store };
}

async function close(opened: { session: RemoteSession; store: MemoryStore }): Promise<void> {
	await opened.session.close();
	opened.store.close();
}

const instructions = (m: Machine) => readFileSync(join(m.dir, "instructions.md"), "utf8");
const write = (m: Machine, text: string) => writeFileSync(join(m.dir, "instructions.md"), text);
const asides = (m: Machine) => readdirSync(m.dir).filter((name) => name.startsWith("instructions-unsaved-")).sort();

/** The PC pushes Atlas with "v1" (or what `text` says); nobody else has opened it yet. */
async function firstPush(s: Scene, text = "v1\n"): Promise<void> {
	const store = MemoryStore.open(join(s.pc.dir, "memory.sqlite"));
	store.append("user", "hello");
	store.close();
	write(s.pc, text);
	await RemoteSession.push({ agent: "Atlas", agentDir: s.pc.dir, storage: s.storage, key: s.key, holder: s.pc.holder, report: () => {}, settings });
}

/** The PC pushes Atlas with "v1"; the Mac checks it out once, so both last agreed on v1. */
async function pushed(s: Scene): Promise<void> {
	await firstPush(s);
	await close(await open(s, s.mac));
}

/** The store key older builds' `orrery run` wrote, at every start, with the folder's AGENTS.md text. */
const LEGACY_KEY = "instructions";

/** An older build on machine `m`: a held session whose `orrery run` writes the folder's AGENTS.md under LEGACY_KEY. */
async function olderRun(s: Scene, m: Machine, text: string): Promise<void> {
	const held = await open(s, m);
	held.store.setMeta(LEGACY_KEY, text);
	await close(held);
}

/** Saves fail as if the remote were offline, until the returned function is called. */
function offline(s: Scene): () => void {
	const save = s.storage.save.bind(s.storage);
	s.storage.save = async () => {
		throw new RemoteError("unreachable", "offline");
	};
	return () => {
		s.storage.save = save;
	};
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const tooLarge = "Orrery: Atlas's instructions.md is over 256 KB, so it stays on this machine and does not travel with its memory; shorten it to share it.";
/** Every notice that this machine's instructions were kept aside for another copy. */
const conflicts = (m: Machine) => m.reports.filter((text) => text.includes("both here") || text.includes("is not the copy that travels") || text.includes("came with the memory set aside"));

/** What the remote holds now: the store's copy as a machine that never had a file checks it out. */
async function remoteCopy(s: Scene): Promise<string | undefined> {
	rmSync(s.probe.dir, { recursive: true, force: true });
	mkdirSync(s.probe.dir);
	const session = await RemoteSession.checkOut({ agent: "Atlas", agentDir: s.probe.dir, storage: s.storage, key: s.key, holder: s.probe.holder, report: () => {}, settings, renewMs: 0 });
	await session.close();
	const store = MemoryStore.openReadOnly(join(s.probe.dir, "memory.sqlite"));
	try {
		return store.getMeta(INSTRUCTIONS_KEY);
	} finally {
		store.close();
	}
}

describe("instructions.md travels with remote memory", () => {
	it("a first push carries it; another machine's check-out writes it there", async () => {
		const s = scene();
		await pushed(s);
		expect(instructions(s.mac)).toBe("v1\n");
	});

	it("an edit made where the agent is held goes up when it closes; the other machine gets it, and is told", async () => {
		const s = scene();
		await pushed(s);
		const held = await open(s, s.pc);
		write(s.pc, "v2 from the PC\n");
		await close(held);
		await close(await open(s, s.mac));
		expect(instructions(s.mac)).toBe("v2 from the PC\n");
		expect(s.mac.reports).toContain("Orrery: Atlas's instructions were changed on another machine; this machine now has them.");
	});

	it("an edit made on a machine that did not hold the agent goes up at that machine's next open", async () => {
		const s = scene();
		await pushed(s);
		write(s.mac, "v2 from the Mac\n");
		await close(await open(s, s.mac));
		await close(await open(s, s.pc));
		expect(instructions(s.pc)).toBe("v2 from the Mac\n");
	});

	it("edited on both machines: the remote's copy wins, and this machine's is kept beside it, with a notice", async () => {
		const s = scene();
		await pushed(s);
		const held = await open(s, s.pc);
		write(s.pc, "v2 from the PC\n");
		write(s.mac, "v2 from the Mac\n");
		await close(held);
		await close(await open(s, s.mac));
		expect(instructions(s.mac)).toBe("v2 from the PC\n");
		const aside = readdirSync(s.mac.dir).filter((name) => name.startsWith("instructions-unsaved-"));
		expect(aside).toHaveLength(1);
		expect(readFileSync(join(s.mac.dir, aside[0] as string), "utf8")).toBe("v2 from the Mac\n");
		expect(s.mac.reports.some((text) => text.startsWith("Orrery: Atlas's instructions were changed both here and on another machine;"))).toBe(true);
	});

	it("goes in the sealed saves as the store's metadata", async () => {
		const s = scene();
		await pushed(s);
		const held = await open(s, s.pc);
		write(s.pc, "v2\n");
		await close(held);
		const { saves } = await s.storage.fetch("Atlas", 0);
		const metas = saves.map((save) => decodeRows(unseal(s.key, "Atlas", "save", save.n, save.file)).meta);
		expect(metas.some((meta) => meta[INSTRUCTIONS_KEY] === "v2\n")).toBe(true);
	});

	it("edits that take turns between machines never leave a copy aside", async () => {
		const s = scene();
		await pushed(s);
		write(s.pc, "v2 from the PC\n");
		await close(await open(s, s.pc));
		await close(await open(s, s.mac));
		expect(instructions(s.mac)).toBe("v2 from the PC\n");
		const held = await open(s, s.mac);
		write(s.mac, "v3 from the Mac\n");
		await close(held);
		await close(await open(s, s.pc));
		expect(instructions(s.pc)).toBe("v3 from the Mac\n");
		await close(await open(s, s.mac));
		expect(instructions(s.mac)).toBe("v3 from the Mac\n");
		expect([...asides(s.pc), ...asides(s.mac)]).toEqual([]);
		expect(s.pc.reports.filter((text) => text.includes("both here"))).toEqual([]);
		expect(s.mac.reports.filter((text) => text.includes("both here"))).toEqual([]);
	});

	it("an edit sent at the open and edited again before the close goes up as last written", async () => {
		const s = scene();
		await pushed(s);
		write(s.mac, "v2 from the Mac\n");
		const held = await open(s, s.mac);
		write(s.mac, "v3 from the Mac\n");
		await close(held);
		await close(await open(s, s.pc));
		expect(instructions(s.pc)).toBe("v3 from the Mac\n");
		await close(await open(s, s.mac));
		expect(instructions(s.mac)).toBe("v3 from the Mac\n");
		expect(asides(s.mac)).toEqual([]);
	});

	it("an edit whose save failed is sent again at the next open, not mistaken for one made elsewhere", async () => {
		const s = scene();
		await pushed(s);
		const held = await open(s, s.mac);
		write(s.mac, "v2 from the Mac\n");
		const save = s.storage.save.bind(s.storage);
		s.storage.save = async () => {
			throw new RemoteError("unreachable", "offline");
		};
		await close(held);
		s.storage.save = save;
		await close(await open(s, s.mac));
		expect(instructions(s.mac)).toBe("v2 from the Mac\n");
		expect(asides(s.mac)).toEqual([]);
		await close(await open(s, s.pc));
		expect(instructions(s.pc)).toBe("v2 from the Mac\n");
	});

	it("an edit whose save failed stays this machine's edit after another machine saved memory since: it goes up, never overwritten", async () => {
		const s = scene();
		await pushed(s);
		const held = await open(s, s.mac);
		write(s.mac, "v2 from the Mac\n");
		const save = s.storage.save.bind(s.storage);
		s.storage.save = async () => {
			throw new RemoteError("unreachable", "offline");
		};
		await close(held);
		s.storage.save = save;
		const pc = await open(s, s.pc);
		pc.store.append("user", "a turn on the PC");
		await close(pc);
		await close(await open(s, s.mac));
		expect(instructions(s.mac)).toBe("v2 from the Mac\n");
		expect(asides(s.mac)).toEqual([]);
		await close(await open(s, s.pc));
		expect(instructions(s.pc)).toBe("v2 from the Mac\n");
	});

	it("over 32 KB, the whole file travels (only what reaches the model is cut)", async () => {
		const s = scene();
		const long = `${"a".repeat(40 * 1024)}\nTAIL\n`;
		await firstPush(s, long);
		await close(await open(s, s.mac));
		expect(instructions(s.mac)).toBe(long);
	});

	it("something other than a file where instructions.md goes is never replaced; the memory opens as usual", async () => {
		const s = scene();
		await firstPush(s);
		mkdirSync(join(s.mac.dir, "instructions.md"));
		const held = await open(s, s.mac);
		expect(held.store.root.map((m) => m.text)).toEqual(["hello"]);
		await close(held);
		expect(s.mac.reports.some((text) => text.startsWith("Orrery: Atlas's instructions could not be brought up to date ("))).toBe(true);
		expect(statSync(join(s.mac.dir, "instructions.md")).isDirectory()).toBe(true);
		expect(await remoteCopy(s)).toBe("v1\n");
	});
});

describe("cleared on purpose, or never had any", () => {
	it.each([
		["no instructions.md", undefined],
		["a blank one", " \n"],
	])("a machine that never had instructions (%s) takes the remote's, and never clears them", async (_label, text) => {
		const s = scene();
		await firstPush(s);
		if (text !== undefined) write(s.mac, text);
		await close(await open(s, s.mac));
		expect(instructions(s.mac)).toBe("v1\n");
		expect(asides(s.mac)).toEqual([]);
		await close(await open(s, s.pc));
		expect(instructions(s.pc)).toBe("v1\n");
		expect(s.pc.reports).toEqual([]);
		expect(await remoteCopy(s)).toBe("v1\n");
	});

	it("a machine with its own, different instructions that never agreed with the remote takes the remote's, and keeps its own aside", async () => {
		const s = scene();
		await firstPush(s);
		write(s.mac, "the Mac's own\n");
		await close(await open(s, s.mac));
		expect(instructions(s.mac)).toBe("v1\n");
		expect(asides(s.mac)).toHaveLength(1);
		expect(readFileSync(join(s.mac.dir, asides(s.mac)[0] as string), "utf8")).toBe("the Mac's own\n");
		expect(s.mac.reports).toContain(`Orrery: Atlas's instructions.md here is not the copy that travels with its memory; that copy is used now, and this machine's is kept in ${join(s.mac.dir, asides(s.mac)[0] as string)}.`);
		expect(await remoteCopy(s)).toBe("v1\n");
	});

	it("an emptied file is cleared on purpose: it travels, and the other machine keeps its copy aside, with a notice", async () => {
		const s = scene();
		await pushed(s);
		write(s.pc, "");
		await close(await open(s, s.pc));
		expect(await remoteCopy(s)).toBe("");
		await close(await open(s, s.mac));
		expect(instructions(s.mac)).toBe("");
		expect(asides(s.mac)).toHaveLength(1);
		expect(readFileSync(join(s.mac.dir, asides(s.mac)[0] as string), "utf8")).toBe("v1\n");
		expect(s.mac.reports).toContain(`Orrery: Atlas's instructions were cleared on another machine; this machine's copy is kept in ${join(s.mac.dir, asides(s.mac)[0] as string)}.`);
		// The PC keeps them cleared: nothing comes back, and nothing is kept aside there.
		await close(await open(s, s.pc));
		expect(instructions(s.pc)).toBe("");
		expect(asides(s.pc)).toEqual([]);
	});

	it("a held session's emptied file is cleared on purpose too", async () => {
		const s = scene();
		await pushed(s);
		const held = await open(s, s.pc);
		write(s.pc, "\n");
		await close(held);
		expect(await remoteCopy(s)).toBe("");
	});

	it("a deleted file does not travel: the remote's copy comes back, with a notice", async () => {
		const s = scene();
		await pushed(s);
		rmSync(join(s.mac.dir, "instructions.md"));
		const held = await open(s, s.mac);
		expect(instructions(s.mac)).toBe("v1\n");
		expect(s.mac.reports).toContain("Orrery: Atlas's instructions.md was deleted here; the copy that travels with its memory is back. To take the instructions away, empty the file instead.");
		// Deleted while held: still nothing travels.
		rmSync(join(s.mac.dir, "instructions.md"));
		await close(held);
		expect(await remoteCopy(s)).toBe("v1\n");
		await close(await open(s, s.pc));
		expect(instructions(s.pc)).toBe("v1\n");
		expect(s.pc.reports).toEqual([]);
	});

	it("a first push with no instructions.md sends none, even when the store kept an older copy", async () => {
		const s = scene();
		const store = MemoryStore.open(join(s.pc.dir, "memory.sqlite"));
		store.append("user", "hello");
		store.setMeta(INSTRUCTIONS_KEY, "an older copy\n");
		store.close();
		await RemoteSession.push({ agent: "Atlas", agentDir: s.pc.dir, storage: s.storage, key: s.key, holder: s.pc.holder, report: () => {}, settings });
		expect(await remoteCopy(s)).toBe("");
		await close(await open(s, s.mac));
		expect(existsSync(join(s.mac.dir, "instructions.md"))).toBe(false);
	});
});

describe("an older build's \"instructions\" value is not the agent's", () => {
	it("written by an older build on another machine while both run: ignored, the file stays, nothing set aside", async () => {
		const s = scene();
		await pushed(s);
		await olderRun(s, s.probe, "LEGACY folder AGENTS.md\n");
		await close(await open(s, s.mac));
		expect(instructions(s.mac)).toBe("v1\n");
		expect(asides(s.mac)).toEqual([]);
		expect(s.mac.reports).toEqual([]);
		expect(await remoteCopy(s)).toBe("v1\n");
	});

	it("left on the remote by an older build at the upgrade: never taken for the agent's, so this machine's own goes up", async () => {
		const s = scene();
		const store = MemoryStore.open(join(s.pc.dir, "memory.sqlite"));
		store.append("user", "hello");
		store.close();
		await RemoteSession.push({ agent: "Atlas", agentDir: s.pc.dir, storage: s.storage, key: s.key, holder: s.pc.holder, report: () => {}, settings });
		await olderRun(s, s.pc, "LEGACY folder AGENTS.md\n");
		expect(existsSync(join(s.pc.dir, "instructions.md"))).toBe(false);
		write(s.mac, "mine, written for the new build\n");
		await close(await open(s, s.mac));
		expect(instructions(s.mac)).toBe("mine, written for the new build\n");
		expect(asides(s.mac)).toEqual([]);
		expect(conflicts(s.mac)).toEqual([]);
		expect(await remoteCopy(s)).toBe("mine, written for the new build\n");
	});

	it("in this machine's own store, from its older build: ignored, never written to instructions.md, never sent", async () => {
		const s = scene();
		await pushed(s);
		await olderRun(s, s.mac, "LEGACY folder AGENTS.md\n");
		rmSync(join(s.mac.dir, "instructions.md"));
		await close(await open(s, s.mac));
		expect(instructions(s.mac)).toBe("v1\n");
		expect(s.mac.reports.filter((text) => text.includes("changed on another machine"))).toEqual([]);
		// A guard (passes before the fix too): a store holding only the old key pushes no instructions.
		const fresh = scene();
		const store = MemoryStore.open(join(fresh.pc.dir, "memory.sqlite"));
		store.append("user", "hello");
		store.setMeta(LEGACY_KEY, "LEGACY folder AGENTS.md\n");
		store.close();
		await RemoteSession.push({ agent: "Atlas", agentDir: fresh.pc.dir, storage: fresh.storage, key: fresh.key, holder: fresh.pc.holder, report: () => {}, settings });
		await close(await open(fresh, fresh.mac));
		expect(existsSync(join(fresh.mac.dir, "instructions.md"))).toBe(false);
	});

	it("saves that changed no instructions carry no key, and a remote whose saves never had one leaves this machine's file alone", async () => {
		const s = scene();
		const store = MemoryStore.open(join(s.pc.dir, "memory.sqlite"));
		store.append("user", "hello");
		store.close();
		await RemoteSession.push({ agent: "Atlas", agentDir: s.pc.dir, storage: s.storage, key: s.key, holder: s.pc.holder, report: () => {}, settings });
		const held = await open(s, s.pc);
		held.store.append("user", "a turn");
		await close(held);
		const { saves } = await s.storage.fetch("Atlas", 0);
		expect(saves.length).toBeGreaterThan(0);
		for (const save of saves) expect(decodeRows(unseal(s.key, "Atlas", "save", save.n, save.file)).meta).not.toHaveProperty(INSTRUCTIONS_KEY);
		expect(await remoteCopy(s)).toBeUndefined();
		await close(await open(s, s.mac));
		expect(existsSync(join(s.mac.dir, "instructions.md"))).toBe(false);
		write(s.mac, "the Mac's\n");
		await close(await open(s, s.mac));
		expect(instructions(s.mac)).toBe("the Mac's\n");
		expect(await remoteCopy(s)).toBe("the Mac's\n");
	});
});

describe("agreement only with this remote's history", () => {
	it.each([false, true])("a folder that agreed with an unrelated history keeps its own aside, never replaced silently (memory set aside: %s)", async (memory) => {
		const s = scene();
		await firstPush(s, "Z another Atlas\n");
		if (memory) {
			const store = MemoryStore.open(join(s.mac.dir, "memory.sqlite"));
			store.append("user", "an earlier Atlas's turn");
			store.close();
		}
		write(s.mac, "X only here\n");
		writeFileSync(join(s.mac.dir, SYNCED_FILE), `${sha256("X only here\n")}\n`);
		await close(await open(s, s.mac));
		expect(instructions(s.mac)).toBe("Z another Atlas\n");
		expect(asides(s.mac)).toHaveLength(1);
		expect(readFileSync(join(s.mac.dir, asides(s.mac)[0] as string), "utf8")).toBe("X only here\n");
		expect(conflicts(s.mac)).toHaveLength(1);
		expect(readdirSync(s.mac.dir).filter((name) => name.startsWith("memory-before-remote-"))).toHaveLength(memory ? 1 : 0);
	});

	it("an edit whose send failed, edited again before the next open: the newest stays and goes up, no false conflict", async () => {
		const s = scene();
		await pushed(s);
		const held = await open(s, s.mac);
		write(s.mac, "v2 mac\n");
		const online = offline(s);
		await close(held);
		online();
		write(s.mac, "v3 mac, edited again while offline\n");
		await close(await open(s, s.mac));
		expect(instructions(s.mac)).toBe("v3 mac, edited again while offline\n");
		expect(asides(s.mac)).toEqual([]);
		expect(conflicts(s.mac)).toEqual([]);
		await close(await open(s, s.pc));
		expect(instructions(s.pc)).toBe("v3 mac, edited again while offline\n");
	});

	it("an edit whose save landed but whose reply was lost, edited again: the newest stays and goes up, no false conflict", async () => {
		const s = scene();
		await pushed(s);
		const held = await open(s, s.mac);
		write(s.mac, "v2 mac\n");
		const save = s.storage.save.bind(s.storage);
		s.storage.save = async (...args) => {
			await save(...args);
			throw new RemoteError("unreachable", "the reply was lost");
		};
		await close(held);
		s.storage.save = save;
		write(s.mac, "v3 mac\n");
		await close(await open(s, s.mac));
		expect(instructions(s.mac)).toBe("v3 mac\n");
		expect(asides(s.mac)).toEqual([]);
		expect(conflicts(s.mac)).toEqual([]);
		await close(await open(s, s.pc));
		expect(instructions(s.pc)).toBe("v3 mac\n");
	});
});

describe("instructions.md over 256 KB stays on its machine", () => {
	const over = `${"b".repeat(256 * 1024)}+`;

	it("exactly 256 KB still travels", async () => {
		const s = scene();
		const most = "c".repeat(256 * 1024);
		await firstPush(s, most);
		await close(await open(s, s.mac));
		expect(instructions(s.mac)).toBe(most);
	});

	it("over 256 KB: it stays local, with a notice; the memory still saves, and the other machine keeps its copy", async () => {
		const s = scene();
		await pushed(s);
		// The remote refuses a save this large, as a Worker refuses an oversized request: one such save would block every later one.
		const save = s.storage.save.bind(s.storage);
		s.storage.save = async (agent, lock, n, file, log) => {
			if (file.byteLength > 256 * 1024) throw new RemoteError("refused", "too large");
			return save(agent, lock, n, file, log);
		};
		write(s.mac, over);
		const held = await open(s, s.mac);
		expect(s.mac.reports).toContain(tooLarge);
		held.store.append("user", "a turn on the Mac");
		await close(held);
		expect(instructions(s.mac)).toBe(over);
		const pc = await open(s, s.pc);
		expect(pc.store.root.map((m) => m.text)).toContain("a turn on the Mac");
		await close(pc);
		expect(instructions(s.pc)).toBe("v1\n");
		expect(await remoteCopy(s)).toBe("v1\n");
	});

	it("is never replaced: an edit from another machine leaves it as it is, and says so again", async () => {
		const s = scene();
		await pushed(s);
		write(s.pc, "v2 from the PC\n");
		await close(await open(s, s.pc));
		write(s.mac, over);
		await close(await open(s, s.mac));
		expect(instructions(s.mac)).toBe(over);
		expect(asides(s.mac)).toEqual([]);
		expect(s.mac.reports).toContain(tooLarge);
		expect(await remoteCopy(s)).toBe("v2 from the PC\n");
	});

	it("made over 256 KB in a held session: the close sends nothing and says so; the memory still saves", async () => {
		const s = scene();
		await pushed(s);
		const held = await open(s, s.mac);
		write(s.mac, over);
		held.store.append("user", "a turn on the Mac");
		await close(held);
		expect(s.mac.reports).toContain(tooLarge);
		expect(await remoteCopy(s)).toBe("v1\n");
		const pc = await open(s, s.pc);
		expect(pc.store.root.map((m) => m.text)).toContain("a turn on the Mac");
		await close(pc);
	});

	it("a first push of one over 256 KB sends none, and says so", async () => {
		const s = scene();
		const store = MemoryStore.open(join(s.pc.dir, "memory.sqlite"));
		store.append("user", "hello");
		store.close();
		write(s.pc, over);
		await RemoteSession.push({ agent: "Atlas", agentDir: s.pc.dir, storage: s.storage, key: s.key, holder: s.pc.holder, report: (text) => s.pc.reports.push(text), settings });
		expect(s.pc.reports).toContain(tooLarge);
		expect(await remoteCopy(s) ?? "").toBe("");
		expect(instructions(s.pc)).toBe(over);
	});
});

describe("a first push starts a new history", () => {
	it.each(["S a new shorter text\n", "v1\n"])("pushed elsewhere over 256 KB, then shortened to %j: the file goes up, nothing set aside, nothing cleared", async (shortened) => {
		const s = scene();
		await pushed(s);
		await close(await open(s, s.pc));
		// The PC's Atlas moves to another remote with a file over 256 KB: none travels there.
		const home2 = { ...s, storage: new FakeStorage({ name: "home2" }) };
		write(s.pc, `${"b".repeat(256 * 1024)}+`);
		await RemoteSession.push({ agent: "Atlas", agentDir: s.pc.dir, storage: home2.storage, key: s.key, holder: s.pc.holder, report: () => {}, settings });
		write(s.pc, shortened);
		s.pc.reports.length = 0;
		await close(await open(home2, s.pc));
		expect(instructions(s.pc)).toBe(shortened);
		expect(asides(s.pc)).toEqual([]);
		expect(s.pc.reports).toEqual([]);
		expect(await remoteCopy(home2)).toBe(shortened);
	});
});

describe("the agreement record in the way", () => {
	it("a folder where .instructions-synced goes does not stop a check-out: it is said, and the memory opens", async () => {
		const s = scene();
		await firstPush(s);
		mkdirSync(join(s.mac.dir, SYNCED_FILE));
		const held = await open(s, s.mac);
		expect(held.store.root.map((m) => m.text)).toEqual(["hello"]);
		await close(held);
		expect(s.mac.reports.some((text) => text.startsWith(`Orrery: Atlas: ${SYNCED_FILE} could not be removed (`))).toBe(true);
	});
});
