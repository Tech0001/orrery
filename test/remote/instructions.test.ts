import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/memory/store.ts";
import { createKey, unseal } from "../../src/remote/crypto.ts";
import { FakeStorage } from "../../src/remote/fake.ts";
import { INSTRUCTIONS_KEY } from "../../src/remote/instructions-sync.ts";
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
	const session = await RemoteSession.checkOut({ lane: "Atlas", laneDir: m.dir, storage: s.storage, key: s.key, holder: m.holder, report: (text) => m.reports.push(text), settings, renewMs: 0 });
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
	await RemoteSession.push({ lane: "Atlas", laneDir: s.pc.dir, storage: s.storage, key: s.key, holder: s.pc.holder, report: () => {}, settings });
}

/** The PC pushes Atlas with "v1"; the Mac checks it out once, so both last agreed on v1. */
async function pushed(s: Scene): Promise<void> {
	await firstPush(s);
	await close(await open(s, s.mac));
}

/** What the remote holds now: the store's copy as a machine that never had a file checks it out. */
async function remoteCopy(s: Scene): Promise<string | undefined> {
	rmSync(s.probe.dir, { recursive: true, force: true });
	mkdirSync(s.probe.dir);
	const session = await RemoteSession.checkOut({ lane: "Atlas", laneDir: s.probe.dir, storage: s.storage, key: s.key, holder: s.probe.holder, report: () => {}, settings, renewMs: 0 });
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
		expect(s.mac.reports).toContain(`Orrery: Atlas's instructions were changed both here and on another machine; the other machine's are kept, and this machine's are in ${join(s.mac.dir, asides(s.mac)[0] as string)}.`);
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
		await RemoteSession.push({ lane: "Atlas", laneDir: s.pc.dir, storage: s.storage, key: s.key, holder: s.pc.holder, report: () => {}, settings });
		expect(await remoteCopy(s)).toBe("");
		await close(await open(s, s.mac));
		expect(existsSync(join(s.mac.dir, "instructions.md"))).toBe(false);
	});
});
