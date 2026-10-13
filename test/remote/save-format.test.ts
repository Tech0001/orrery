import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spoolKey } from "../../src/claude/spool.ts";
import { CURSOR_KEY } from "../../src/lane/projector.ts";
import { MemoryStore, type StoreRows } from "../../src/memory/store.ts";
import { Part, StoreError, type UsageRow } from "../../src/memory/types.ts";
import { cursorKey } from "../../src/pi/log.ts";
import { assertWrittenThrough, decodeRows, encodeRows, LOCAL_META_KEYS, makeHeader, restoreSnapshot, snapshotBytes } from "../../src/remote/save-format.ts";

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "orrery-save-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Every table's rows, for comparing two databases. Tree compared by (l, i), never by rowid. */
function dump(path: string) {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		return {
			main: db.prepare("SELECT i, kind, text, size, date FROM main ORDER BY i").all(),
			tree: db.prepare("SELECT l, i, text, size FROM tree ORDER BY l, i").all(),
			usage: db.prepare("SELECT * FROM usage ORDER BY id").all(),
			meta: db.prepare("SELECT key, value FROM meta ORDER BY key").all().filter((row) => !LOCAL_META_KEYS.some((prefix) => (row.key as string).startsWith(prefix))),
		};
	} finally {
		db.close();
	}
}

/** A seeded pseudo-random history: appends, summaries of finished pairs, meta writes and usage rows. */
function grow(store: MemoryStore, seed: number, steps: number): void {
	let x = seed;
	const next = () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0);
	for (let s = 0; s < steps; s++) {
		const r = next() % 10;
		if (r < 6) store.append(r % 2 ? "user" : "talk", `message ${s} \u0000 nul and ünïcode ${next()}`);
		else if (r < 8 && store.root.length >= 2) {
			const i = Math.floor((store.root.length - 1) / 2);
			const part = new Part(0, i);
			if (!store.hasNode(part) && part.end <= store.root.length) store.saveNode(part, `summary of pair ${i}`);
		} else if (r < 9) store.setMeta(`k${next() % 5}`, `value ${s}`);
		else store.recordUsage({ at: new Date(0).toISOString(), role: "compactor", model: "m", input: s, cacheRead: 0, cacheWrite: 0, output: 1, ok: true });
	}
}

describe("saves rebuild the database", () => {
	it.each([1, 2, 3, 4, 5])("snapshot plus saves equals the original (seed %i)", (seed) => {
		const source = MemoryStore.open(join(dir, "a", "memory.sqlite"));
		grow(source, seed, 40);
		const snap = snapshotBytes(source.path);
		let marks = source.marks();
		const bodies: Uint8Array[] = [];
		for (let round = 0; round < 5; round++) {
			grow(source, seed * 100 + round, 30);
			const changed = source.rowsAfter(marks, LOCAL_META_KEYS);
			if (changed === undefined) continue;
			bodies.push(encodeRows(changed.rows));
			marks = changed.next;
		}
		expect(source.rowsAfter(marks, LOCAL_META_KEYS)).toBeUndefined();
		const targetPath = join(dir, "b", "memory.sqlite");
		MemoryStore.open(targetPath).close(); // make the folder and the lock file
		restoreSnapshot(targetPath, snap);
		const target = MemoryStore.open(targetPath);
		for (const body of bodies) target.applyRows(decodeRows(body));
		source.close();
		target.close();
		expect(dump(targetPath)).toEqual(dump(join(dir, "a", "memory.sqlite")));
	});

	it("never saves a local meta key", () => {
		expect(LOCAL_META_KEYS).toContain(CURSOR_KEY);
		const store = MemoryStore.open(join(dir, "memory.sqlite"));
		const marks = store.marks();
		for (const key of LOCAL_META_KEYS) store.setMeta(key, "here only");
		expect(store.rowsAfter(marks, LOCAL_META_KEYS)).toBeUndefined();
		store.close();
	});

	it("omits local metadata from snapshots without changing the source", () => {
		const source = MemoryStore.open(join(dir, "source.sqlite"));
		try {
			for (const key of LOCAL_META_KEYS) source.setMeta(key, "here only");
			source.setMeta("view.parts", "[]");
			const targetPath = join(dir, "target.sqlite");
			restoreSnapshot(targetPath, snapshotBytes(source.path));
			const target = MemoryStore.open(targetPath);
			try {
				for (const key of LOCAL_META_KEYS) {
					expect(target.getMeta(key)).toBeUndefined();
					expect(source.getMeta(key)).toBe("here only");
				}
				expect(target.getMeta("view.parts")).toBe("[]");
			} finally { target.close(); }
		} finally { source.close(); }
	});

	it("refuses rows that do not continue the log", () => {
		const store = MemoryStore.open(join(dir, "memory.sqlite"));
		store.append("user", "zero");
		expect(() => store.applyRows({ main: [{ i: 5, kind: "user", text: "gap", size: 9, date: "2026-10-12T00:00:00Z" }], tree: [], usage: [], meta: {} })).toThrow(/continue/);
		expect(store.root.length).toBe(1);
		store.close();
	});

	it("refuses a corrupt body as corrupt", () => {
		expect(() => decodeRows(new Uint8Array([1, 2, 3]))).toThrow(expect.objectContaining({ kind: "corrupt" }));
	});
});

const emptyRows = (): StoreRows => ({ main: [], tree: [], usage: [], meta: {} });
const usage = { at: "2026-10-12T00:00:00Z", role: "compactor" as const, model: "m", input: 3, cacheRead: 2, cacheWrite: 1, output: 4, ok: true };

describe("reviewed save boundaries", () => {
	it.each([
		{ at: "not a date", role: "another-role", input: -1.5, cacheRead: 2.25, cacheWrite: -3, output: 0.5, ok: false },
		{ at: "", role: "", input: 0, cacheRead: -0.5, cacheWrite: 3.5, output: -2, ok: true },
	])("replays usage accepted by the local store (%#)", (fields) => {
		const source = MemoryStore.open(join(dir, "source.sqlite"));
		const target = MemoryStore.open(join(dir, "target.sqlite"));
		try {
			const marks = source.marks();
			// The local writer accepts these database values even though its caller-facing role type is narrower.
			source.recordUsage({ ...usage, ...fields } as UsageRow);
			const rows = source.rowsAfter(marks, [])!.rows;
			const decoded = decodeRows(encodeRows(rows));
			expect(decoded.usage).toEqual([{ ...usage, ...fields, id: 1 }]);
			target.applyRows(decoded);
			expect(target.usageRows()).toEqual(source.usageRows());
		} finally { source.close(); target.close(); }
	});

	it.each(["input", "cacheRead", "cacheWrite", "output", "at", "role", "ok"])("refuses invalid usage %s before writing", (field) => {
		const store = MemoryStore.open(join(dir, "memory.sqlite"));
		try {
			const invalid = { ...emptyRows(), usage: [{ ...usage, id: 1, [field]: field === "at" || field === "role" || field === "ok" ? 1 : Infinity }] };
			expect(() => decodeRows(encodeRows(invalid))).toThrow(expect.objectContaining({ kind: "corrupt" }));
			expect(() => store.applyRows(invalid)).toThrow(StoreError);
			expect(store.usageRows()).toEqual([]);
		} finally { store.close(); }
	});

	it("refuses a usage id gap against existing rows and within a save", () => {
		const store = MemoryStore.open(join(dir, "memory.sqlite"));
		try {
			store.recordUsage(usage);
			for (const ids of [[3], [2, 4]]) {
				const rows = { ...emptyRows(), usage: ids.map((id) => ({ ...usage, id })), meta: { instructions: "must not land" } };
				expect(() => store.applyRows(rows)).toThrow(StoreError);
				expect(store.usageRows()).toEqual([usage]);
				expect(store.getMeta("instructions")).toBeUndefined();
			}
			expect(() => decodeRows(encodeRows({ ...emptyRows(), usage: [2, 4].map((id) => ({ ...usage, id })) }))).toThrow(expect.objectContaining({ kind: "corrupt" }));
			store.applyRows({ ...emptyRows(), usage: [2, 3].map((id) => ({ ...usage, id })) });
			expect(store.marks().usage).toBe(3);
		} finally { store.close(); }
	});

	it.each(["main", "tree", "usage"] as const)("refuses %s marks beyond the database", (table) => {
		const store = MemoryStore.open(join(dir, "memory.sqlite"));
		try {
			store.append("user", "one");
			store.saveNode(new Part(0, 0), "leaf");
			store.recordUsage(usage);
			const marks = store.marks();
			expect(() => store.rowsAfter({ ...marks, [table]: marks[table] + 1 }, [])).toThrow(StoreError);
			expect(store.rowsAfter(marks, [])).toBeUndefined();
			expect(store.writable).toBe(true);
		} finally { store.close(); }
	});

	it("drops unknown fields during decoding and direct replay", () => {
		const source = MemoryStore.open(join(dir, "source.sqlite"));
		const target = MemoryStore.open(join(dir, "target.sqlite"));
		try {
			const marks = source.marks();
			source.append("user", "one");
			source.saveNode(new Part(0, 0), "leaf");
			source.recordUsage(usage);
			const rows = source.rowsAfter(marks, [])!.rows;
			const extra = { ...rows, extra: "ignore", main: rows.main.map((row) => ({ ...row, extra: "ignore" })), tree: rows.tree.map((row) => ({ ...row, extra: "ignore" })), usage: rows.usage.map((row) => ({ ...row, extra: "ignore" })) };
			expect(decodeRows(encodeRows(extra))).toEqual(rows);
			target.applyRows(extra);
			expect(target.root).toEqual(source.root);
			expect([...target.nodes()]).toEqual([...source.nodes()]);
			expect(target.rowsAfter(marks, [])!.rows).toEqual(rows);
		} finally { source.close(); target.close(); }
	});

	it.each([CURSOR_KEY, cursorKey("pi-session"), spoolKey("claude-session")])("keeps %s on its own machine through saves, snapshots and restore", (key) => {
		const source = MemoryStore.open(join(dir, "source.sqlite"));
		const targetPath = join(dir, "target.sqlite");
		const target = MemoryStore.open(targetPath);
		try {
			const marks = source.marks();
			source.setMeta(key, "remote cursor");
			expect(source.rowsAfter(marks, LOCAL_META_KEYS)).toBeUndefined();
			source.setMeta("instructions", "from remote");
			target.setMeta(key, "500");
			target.setMeta("instructions", "replaced");
			target.close();
			const snapshot = snapshotBytes(source.path);
			const freshPath = join(dir, "fresh.sqlite");
			restoreSnapshot(freshPath, snapshot);
			const fresh = MemoryStore.openReadOnly(freshPath);
			try { expect(fresh.getMeta(key)).toBeUndefined(); } finally { fresh.close(); }
			restoreSnapshot(targetPath, snapshot);
			const restored = MemoryStore.openReadOnly(targetPath);
			try {
				expect(restored.getMeta(key)).toBe("500");
				expect(restored.getMeta("instructions")).toBe("from remote");
			} finally { restored.close(); }
			expect(source.getMeta(key)).toBe("remote cursor");
		} finally { source.close(); target.close(); }
	});

	it.each(["snapshot", "restore"])("cleans only old snapshot/restore temporary files before %s", (operation) => {
		const source = MemoryStore.open(join(dir, "source.sqlite"));
		try {
			const snapshot = snapshotBytes(source.path);
			const old = new Date(Date.now() - 3_601_000);
			for (const name of [".restore-old.sqlite", ".snapshot-old.sqlite", ".restore-old.sqlite-wal", "unrelated.sqlite"]) {
				const path = join(dir, name);
				writeFileSync(path, "old");
				utimesSync(path, old, old);
			}
			writeFileSync(join(dir, ".snapshot-fresh.sqlite"), "active");
			if (operation === "snapshot") snapshotBytes(source.path);
			else restoreSnapshot(join(dir, "target.sqlite"), snapshot);
			for (const name of [".restore-old.sqlite", ".snapshot-old.sqlite", ".restore-old.sqlite-wal"]) expect(existsSync(join(dir, name))).toBe(false);
			expect(existsSync(join(dir, "unrelated.sqlite"))).toBe(true);
			expect(existsSync(join(dir, ".snapshot-fresh.sqlite"))).toBe(true);
		} finally { source.close(); }
	});
});

describe("save boundaries and validation", () => {
	it("tracks exact ids, changed metadata and UTF-8 text across all tables", () => {
		const store = MemoryStore.open(join(dir, "a.sqlite"));
		const target = MemoryStore.open(join(dir, "b.sqlite"));
		try {
			const marks = store.marks();
			expect(marks).toEqual({ main: -1, tree: 0, usage: 0, meta: {} });
			store.append("user", "hi\u0000🌳");
			store.append("talk", "next");
			store.saveNode(new Part(0, 0), "leaf\u0000🌳");
			store.saveNode(new Part(0, 1), "leaf 2");
			store.saveNode(new Part(1, 0), "parent");
			store.recordUsage(usage);
			store.setMeta("instructions", "line\u0000two");
			store.setMeta("__proto__", "metadata");
			const changed = store.rowsAfter(marks, LOCAL_META_KEYS)!;
			expect(changed.next).toEqual(store.marks());
			expect(changed.rows.usage).toEqual([{ id: 1, ...usage }]);
			expect(changed.rows.meta.instructions).toBe("line\u0000two");
			expect(changed.rows.meta.__proto__).toBe("metadata");
			target.applyRows(decodeRows(encodeRows(changed.rows)));
			expect(target.root).toEqual(store.root);
			expect([...target.nodes()]).toEqual([...store.nodes()]);
			expect(target.usageRows()).toEqual(store.usageRows());
			expect(target.rowsAfter(marks, LOCAL_META_KEYS)?.rows).toEqual(changed.rows);
			store.setMeta("instructions", "changed");
			expect(store.rowsAfter(changed.next, LOCAL_META_KEYS)?.rows).toEqual({ ...emptyRows(), meta: { instructions: "changed" } });
		} finally {
			target.close();
			store.close();
		}
	});

	it("validates the entire batch before writing, including children and existing nodes", () => {
		const store = MemoryStore.open(join(dir, "memory.sqlite"));
		try {
			store.append("user", "a");
			store.append("talk", "b");
			const marks = store.marks();
			expect(() => store.applyRows({ ...emptyRows(), tree: [{ l: 1, i: 0, text: "parent", size: 6 }], meta: { x: "no" } })).toThrow(/child/);
			expect(store.marks()).toEqual(marks);
			store.saveNode(new Part(0, 0), "leaf");
			expect(() => store.applyRows({ ...emptyRows(), tree: [{ l: 0, i: 0, text: "changed", size: 7 }] })).toThrow(/immutable|exist/);
			expect(store.writable).toBe(true);
		} finally {
			store.close();
		}
	});

	it("applies tree rows by level even when older parents precede newer leaves", () => {
		const source = MemoryStore.open(join(dir, "source.sqlite"));
		const target = MemoryStore.open(join(dir, "target.sqlite"));
		try {
			const marks = source.marks();
			for (let i = 0; i < 4; i++) source.append("user", `message ${i}`);
			for (const part of [new Part(0, 0), new Part(0, 1), new Part(1, 0), new Part(0, 2), new Part(0, 3), new Part(1, 1), new Part(2, 0)]) source.saveNode(part, part.address);
			const rows = source.rowsAfter(marks, [])!.rows;
			target.applyRows({ ...rows, tree: [...rows.tree].reverse() });
			expect(target.root).toEqual(source.root);
			for (const node of source.nodes()) expect(target.node(new Part(node.l, node.i))).toEqual(node);
		} finally { target.close(); source.close(); }
	});

	it("rolls back all tables and poisons the store when a write fails", () => {
		const source = MemoryStore.open(join(dir, "source.sqlite"));
		const target = MemoryStore.open(join(dir, "target.sqlite"));
		const raw = new DatabaseSync(target.path);
		try {
			const marks = source.marks();
			source.append("user", "one");
			source.saveNode(new Part(0, 0), "leaf");
			source.recordUsage(usage);
			source.setMeta("instructions", "new");
			raw.exec("CREATE TRIGGER fail_usage BEFORE INSERT ON usage BEGIN SELECT RAISE(ABORT, 'disk failure'); END");
			expect(() => target.applyRows(source.rowsAfter(marks, [])!.rows)).toThrow(/disk failure/);
			expect(target.root).toHaveLength(0);
			expect(target.nodeCount).toBe(0);
			expect(target.marks()).toEqual(marks);
			expect(target.writable).toBe(false);
			expect(() => target.append("user", "no")).toThrow(/restart/);
		} finally {
			raw.close();
			target.close();
			source.close();
		}
	});

	it.each([
		{}, { v: 2, ...emptyRows() }, { v: 1, ...emptyRows(), main: null },
		{ v: 1, ...emptyRows(), meta: { x: 3 } },
		{ v: 1, ...emptyRows(), main: [{ i: 0, kind: "thought", text: "bad", size: 12, date: usage.at }] },
		{ v: 1, ...emptyRows(), usage: [{ ...usage }] },
	])("refuses malformed versioned bodies (%#)", (body) => {
		expect(() => decodeRows(gzipSync(JSON.stringify(body)))).toThrow(expect.objectContaining({ kind: "corrupt" }));
	});

	it("hashes the compressed body and counts each table in the header", () => {
		const rows: StoreRows = { ...emptyRows(), meta: { instructions: "hello" } };
		const body = encodeRows(rows);
		const fields = { n: 7, lock: 3, machine: "pc", device: "device", at: usage.at };
		expect(makeHeader(fields, rows, body)).toEqual({ ...fields, v: 1, rows: { main: 0, tree: 0, usage: 0, meta: 1 }, sha256: createHash("sha256").update(body).digest("hex") });
	});

	it("restores privately, drops stale sidecars and cleans temporary files", () => {
		const source = MemoryStore.open(join(dir, "source.sqlite"));
		source.append("user", "source");
		const snapshot = snapshotBytes(source.path);
		source.close();
		const targetPath = join(dir, "target.sqlite");
		writeFileSync(targetPath, "old");
		writeFileSync(`${targetPath}-wal`, "stale");
		writeFileSync(`${targetPath}-shm`, "stale");
		restoreSnapshot(targetPath, snapshot);
		expect(statSync(targetPath).mode & 0o777).toBe(0o600);
		expect(existsSync(`${targetPath}-wal`)).toBe(false);
		expect(existsSync(`${targetPath}-shm`)).toBe(false);
		const target = MemoryStore.open(targetPath);
		expect(target.root[0].text).toBe("source");
		target.close();
		expect(readdirSync(dir).filter((name) => name.startsWith(".snapshot-") || name.startsWith(".restore-"))).toEqual([]);
	});

	it("leaves the working copy intact when a snapshot is corrupt", () => {
		const path = join(dir, "memory.sqlite");
		const store = MemoryStore.open(path);
		store.append("user", "keep");
		store.close();
		for (const bytes of [new Uint8Array([1, 2]), gzipSync("not a database")]) {
			expect(() => restoreSnapshot(path, bytes)).toThrow(expect.objectContaining({ kind: "corrupt" }));
		}
		const again = MemoryStore.open(path);
		expect(again.root[0].text).toBe("keep");
		again.close();
	});
});

describe("a copy is renamed into place only when written through", () => {
	it("refuses a database whose WAL still holds rows, and accepts it once the last connection closed", () => {
		const path = join(dir, "copy.sqlite");
		const writer = new DatabaseSync(path);
		writer.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (x); INSERT INTO t VALUES (1)");
		const holder = new DatabaseSync(path); // a connection left open keeps the rows in the WAL after the writer closes
		holder.exec("SELECT * FROM t");
		writer.close();
		expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
		expect(() => assertWrittenThrough(path)).toThrow(expect.objectContaining({ kind: "corrupt" }));
		holder.close();
		expect(() => assertWrittenThrough(path)).not.toThrow();
	});
});
