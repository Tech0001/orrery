import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { deepStrictEqual, strictEqual } from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, MemoryView, Part, StoreError } from "../src/memory/index.ts";
import { sqliteBackend } from "../src/memory/sqlite.ts";
import { decodeRows, encodeRows, LOCAL_META_KEYS, restoreSnapshot, snapshotBytes } from "../src/remote/save-format.ts";

const dir = mkdtempSync(join(tmpdir(), "orrery-bun-"));
try {
	const path = join(dir, "memory.sqlite");
	const store = MemoryStore.open(path);
	const marks = store.marks();
	const view = new MemoryView(store);
	view.append("user", "hello\u0000world", "2026-10-06T10:00:00.000Z");
	view.append("talk", "hi", "2026-10-06T10:00:01.000Z");
	store.saveNode(new Part(0, 0), "user: hello world");
	const copy = MemoryStore.open(join(dir, "copy.sqlite"));
	try {
		copy.applyRows(decodeRows(encodeRows(store.rowsAfter(marks, LOCAL_META_KEYS)!.rows)));
		strictEqual(copy.root.length, store.root.length);
		deepStrictEqual(copy.root, store.root);
	} finally {
		copy.close();
	}
	// A rebuilt copy is renamed into place after close: everything must be in the file by then, none of it left in a
	// WAL that the rename leaves behind (a rebuilt store once lost saves made inside pi that way). The system SQLite on
	// macOS keeps the emptied WAL file.
	strictEqual(lstatSync(join(dir, "copy.sqlite-wal"), { throwIfNoEntry: false })?.size ?? 0, 0, "a closed store left rows in its WAL");
	const restoredPath = join(dir, "restored.sqlite");
	restoreSnapshot(restoredPath, snapshotBytes(path));
	const restored = MemoryStore.open(restoredPath);
	try { deepStrictEqual(restored.root, store.root); } finally { restored.close(); }
	let lock = "acquired";
	try {
		MemoryStore.open(path).close();
	} catch (error) {
		lock = error instanceof StoreError ? "refused" : `wrong error: ${error}`;
	}
	const ro = MemoryStore.openReadOnly(path);
	const readonly = ro.root.length;
	const sameView = new MemoryView(ro).render() === view.render() ? "same" : "different";
	ro.close();
	// A closed store opens read-only too (status, backups, a remote check-out), though no connection left a -wal file:
	// the system SQLite that Bun uses on macOS may not create one for a read-only connection.
	const closedPath = join(dir, "closed.sqlite");
	const closed = MemoryStore.open(closedPath);
	new MemoryView(closed).append("user", "closed", "2026-10-06T10:00:02.000Z");
	closed.close();
	for (const suffix of ["-wal", "-shm"]) rmSync(`${closedPath}${suffix}`, { force: true }); // as a rebuild leaves it
	const reread = MemoryStore.openReadOnly(closedPath);
	try { deepStrictEqual(reread.root.map((m) => m.text), ["closed"]); } finally { reread.close(); }
	const copiedPath = join(dir, "copied.sqlite");
	restoreSnapshot(copiedPath, snapshotBytes(closedPath)); // VACUUM INTO through a read-only connection
	const copied = MemoryStore.openReadOnly(copiedPath);
	try { deepStrictEqual(copied.root.map((m) => m.text), ["closed"]); } finally { copied.close(); }
	// pi runs on Bun, and orrery's logins (with proper-lockfile) now load inside pi.
	const { FileCredentialStore } = await import("../src/agent/credentials.ts");
	const logins = new FileCredentialStore(join(dir, "logins.json"));
	await logins.modify("openrouter", async () => ({ type: "api_key", key: "k" }));
	const listed = (await logins.list()).map((c) => `${c.providerId}:${c.type}`).join(",");
	await logins.delete("openrouter");
	console.log(`bun store ok: backend=${sqliteBackend()} messages=${store.root.length} nodes=${store.nodeCount} readonly=${readonly} lock=${lock} view=${sameView} logins=${listed}`);
	store.close();
} finally {
	rmSync(dir, { recursive: true, force: true });
}
