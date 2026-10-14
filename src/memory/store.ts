/**
 * The agent's long-term memory in one SQLite file: the append-only message log (`main`), the summary tree
 * (`tree`), small metadata such as the projector cursor (`meta`), and compactor usage (`usage`).
 * One writer per file, enforced by an exclusive SQLite lock on `<path>.lock` held for the store's lifetime: the kernel
 * releases it when the process dies, so it cannot go stale. Read-only readers may open the database directly.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type Database, openDatabase, type Statement } from "./sqlite.ts";
import { byteSize, localIso, validDate } from "./bytes.ts";
import {
	bitLength,
	children,
	isKind,
	type Message,
	messageSource,
	type NewMessage,
	type Node,
	Part,
	StoreError,
	type UsageRow,
} from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS main (i INTEGER PRIMARY KEY, kind TEXT NOT NULL, text BLOB NOT NULL, size INTEGER NOT NULL, date TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tree (l INTEGER NOT NULL, i INTEGER NOT NULL, text BLOB NOT NULL, size INTEGER NOT NULL, PRIMARY KEY (l, i));
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY, at TEXT NOT NULL, role TEXT NOT NULL, model TEXT NOT NULL,
  input INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, output INTEGER NOT NULL, ok INTEGER NOT NULL);
`;

/** The meta key holding the saved view, JSON [[l, i], …] (spec 2026-10-07-cache-view §2, Persistence). */
export const VIEW_KEY = "view.parts";

// Text is stored as UTF-8 BLOBs: node:sqlite on Node 22 truncates TEXT values at an embedded NUL when reading,
// and tool output may contain NULs. BLOBs round-trip exactly.
function encode(text: string): Uint8Array {
	return Buffer.from(text, "utf8");
}

function decode(value: unknown): string | undefined {
	return value instanceof Uint8Array ? Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("utf8") : undefined;
}

interface StoredMessage {
	i: number;
	kind: string;
	text: unknown;
	size: number;
	date: string;
}

interface StoredNode {
	l: number;
	i: number;
	text: unknown;
	size: number;
}

/**
 * Holds `<path>.lock` with an exclusive SQLite (fcntl) lock until the returned connection closes. The kernel drops the
 * lock if the process dies, so there is no stale state, no unlink, and no pid reuse problem.
 */
function acquireLock(lockPath: string): Database {
	const created = !existsSync(lockPath);
	const lock = openDatabase(lockPath);
	try {
		if (created) chmodSync(lockPath, 0o600);
		lock.exec("PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;");
		return lock;
	} catch (error) {
		lock.close();
		if ((error as { errcode?: number }).errcode === 5) {
			throw new StoreError(`Memory store is already open by another writer: ${lockPath}`);
		}
		throw error;
	}
}

/**
 * Holds the store's writer lock without opening the database, so a caller can replace the file (a remote snapshot
 * restore) with no other writer in between. Call the returned function to release it.
 */
export interface WriterLock {
	(): void;
	/** Refuses a released lock or a lock for another database. */
	check(path: string): void;
}

export function holdWriterLock(path: string): WriterLock {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const lock = acquireLock(`${path}.lock`);
	let held = true;
	return Object.assign(() => { if (held) { held = false; lock.close(); } }, {
		check(candidate: string) { if (!held || candidate !== path) throw new StoreError(`No writer lock held for ${candidate}`); },
	});
}

interface UsageRecord {
	at: string;
	role: "agent" | "compactor";
	model: string;
	input: number;
	cache_read: number;
	cache_write: number;
	output: number;
	ok: number;
}

/** Saved high-water marks; tree rowids belong to this working copy and must be reset after a restore. */
export interface StoreMarks {
	readonly main: number; // -1 when empty
	readonly tree: number; // 0 when empty
	readonly usage: number; // 0 when empty
	readonly meta: Readonly<Record<string, string>>; // sha256 of each value
}

/** Append-only rows and changed metadata carried by a remote save. Usage keeps its database id. */
export interface StoreRows {
	readonly main: readonly { i: number; kind: string; text: string; size: number; date: string }[];
	readonly tree: readonly { l: number; i: number; text: string; size: number }[];
	readonly usage: readonly (Omit<UsageRow, "role"> & { readonly id: number; readonly role: string })[];
	readonly meta: Readonly<Record<string, string>>;
}

function valueHash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export class MemoryStore {
	readonly path: string;
	readonly #lock: (() => void) | undefined;
	readonly #readOnly: boolean;
	readonly #db: Database;
	readonly #root: Message[] = [];
	readonly #nodes = new Map<string, Node>();
	readonly #insertMessage: Statement;
	readonly #insertNode: Statement;
	readonly #upsertMeta: Statement;
	readonly #insertUsage: Statement;
	#closed = false;
	#poisoned = false;
	#snapshotView: string | undefined;

	/** A supplied lock is borrowed: its owner keeps it across closes and snapshot replacements. */
	static open(path: string, writer?: WriterLock): MemoryStore {
		if (writer !== undefined) {
			writer.check(path);
			return new MemoryStore(path, () => {});
		}
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const lock = holdWriterLock(path);
		try {
			return new MemoryStore(path, lock);
		} catch (error) {
			lock();
			throw error;
		}
	}

	/** Opens an existing store for reading without the writer lock (status, usage, the future hub). */
	static openReadOnly(path: string): MemoryStore {
		if (!existsSync(path)) throw new StoreError(`No memory store at ${path}`);
		return new MemoryStore(path, undefined);
	}

	private constructor(path: string, lock: (() => void) | undefined) {
		this.path = path;
		this.#lock = lock;
		this.#readOnly = lock === undefined;
		const created = !this.#readOnly && !existsSync(path);
		this.#db = openDatabase(path, { readOnly: this.#readOnly });
		try {
			if (created) chmodSync(path, 0o600);
			if (!this.#readOnly) {
				this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
				this.#db.exec(SCHEMA);
			}
		} catch (error) {
			this.#db.close();
			throw error;
		}
		this.#insertMessage = this.#db.prepare("INSERT INTO main (i, kind, text, size, date) VALUES (?, ?, ?, ?, ?)");
		this.#insertNode = this.#db.prepare("INSERT INTO tree (l, i, text, size) VALUES (?, ?, ?, ?)");
		this.#upsertMeta = this.#db.prepare(
			"INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		);
		this.#insertUsage = this.#db.prepare(
			"INSERT INTO usage (at, role, model, input, cache_read, cache_write, output, ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		);
		try {
			if (this.#readOnly) this.#snapshot(() => this.#load());
			else this.#load();
		} catch (error) {
			this.#db.close();
			throw error;
		}
	}

	/**
	 * Runs `read` in one deferred read transaction: a reader beside a live writer (another agent's pi) sees one snapshot,
	 * never messages from before an append and nodes from after it.
	 */
	#snapshot(read: () => void): void {
		this.#db.exec("BEGIN");
		try {
			read();
		} catch (error) {
			try {
				this.#db.exec("ROLLBACK");
			} catch {
				// The load error is what matters.
			}
			throw error;
		}
		this.#db.exec("COMMIT");
	}

	get root(): readonly Message[] {
		return this.#root;
	}

	/** False once closed or after a failed write; reopen the store to write again. */
	get writable(): boolean {
		return !this.#readOnly && !this.#closed && !this.#poisoned;
	}

	get nodeCount(): number {
		return this.#nodes.size;
	}

	hasNode(part: Part): boolean {
		return this.#nodes.has(part.key);
	}

	node(part: Part): Node | undefined {
		return this.#nodes.get(part.key);
	}

	nodes(): IterableIterator<Node> {
		return this.#nodes.values();
	}

	#load(): void {
		const rows = this.#db.prepare("SELECT i, kind, text, size, date FROM main ORDER BY i").all() as unknown as StoredMessage[];
		for (const row of rows) {
			if (row.i !== this.#root.length) {
				throw new StoreError(`Missing message ${this.#root.length}; ids cannot be renumbered`);
			}
			const text = decode(row.text);
			if (!isKind(row.kind) || text === undefined || row.size !== byteSize(messageSource({ kind: row.kind, text }))) {
				throw new StoreError(`Invalid message record ${row.i}`);
			}
			try {
				validDate(row.date);
			} catch {
				throw new StoreError(`Invalid date on message ${row.i}`);
			}
			this.#root.push({ i: row.i, kind: row.kind, text, size: row.size, date: row.date });
		}
		const total = this.#root.length;
		const nodes = this.#db.prepare("SELECT l, i, text, size FROM tree ORDER BY l, i").all() as unknown as StoredNode[];
		for (const node of nodes) {
			const part = new Part(node.l, node.i);
			if (node.l > bitLength(total) || part.end > total) {
				throw new StoreError(`Node ${part.address} is outside the log`);
			}
			const text = decode(node.text);
			if (text === undefined || !text.trim() || node.size !== byteSize(text)) {
				throw new StoreError(`Invalid tree record ${part.address}`);
			}
			this.#nodes.set(part.key, { l: node.l, i: node.i, text, size: node.size });
		}
		for (const node of this.#nodes.values()) {
			const part = new Part(node.l, node.i);
			if (part.l > 0 && children(part).some((child) => !this.#nodes.has(child.key))) {
				throw new StoreError(`Node ${part.address} is missing a child`);
			}
		}
		// A reader takes the saved view in the same snapshot as the messages and nodes it describes.
		if (this.#readOnly) {
			const row = this.#db.prepare("SELECT value FROM meta WHERE key = ?").get(VIEW_KEY) as { value: string } | undefined;
			this.#snapshotView = row?.value;
		}
	}

	#writable(): void {
		if (this.#readOnly) throw new StoreError("Memory store is open read-only");
		if (this.#closed) throw new StoreError("Store is closed");
		if (this.#poisoned) throw new StoreError("A previous write failed; restart before appending more history");
	}

	/** Runs `write` in one transaction. Any failure poisons the store: no further writes until it is reopened. */
	#write(write: () => void): void {
		try {
			this.#db.exec("BEGIN IMMEDIATE");
			try {
				write();
				this.#db.exec("COMMIT");
			} catch (error) {
				try {
					this.#db.exec("ROLLBACK");
				} catch {
					// The transaction may already be gone; the original error is what matters.
				}
				throw error;
			}
		} catch (error) {
			this.#poisoned = true;
			throw error;
		}
	}

	append(kind: Message["kind"], text: string, date?: string): Message {
		return this.appendBatch([{ kind, text, date }])[0];
	}

	/** Validates every item first, then appends messages, metadata and usage rows in one transaction. */
	appendBatch(
		items: readonly NewMessage[],
		meta: Readonly<Record<string, string>> = {},
		usage: readonly UsageRow[] = [],
	): Message[] {
		this.#writable();
		const messages: Message[] = items.map((item, offset) => {
			if (!isKind(item.kind) || typeof item.text !== "string") {
				throw new RangeError("Expected a supported message kind and string text");
			}
			const text = item.text.toWellFormed();
			return {
				i: this.#root.length + offset,
				kind: item.kind,
				text,
				size: byteSize(`${item.kind}: ${text}`),
				date: validDate(item.date ?? localIso()),
			};
		});
		this.#write(() => {
			for (const m of messages) this.#insertMessage.run(m.i, m.kind, encode(m.text), m.size, m.date);
			for (const [key, value] of Object.entries(meta)) this.#upsertMeta.run(key, value);
			for (const row of usage) this.#insertUsageRow(row);
		});
		this.#root.push(...messages);
		return messages;
	}

	saveNode(part: Part, text: string): Node {
		this.#writable();
		if (this.#nodes.has(part.key)) throw new StoreError(`Node ${part.address} is immutable`);
		if (!text.trim() || part.end > this.#root.length) throw new RangeError("Empty or out-of-range node");
		if (part.l > 0 && children(part).some((child) => !this.#nodes.has(child.key))) {
			throw new RangeError("Both children must exist before their parent");
		}
		const clean = text.toWellFormed();
		const node: Node = { l: part.l, i: part.i, text: clean, size: byteSize(clean) };
		this.#write(() => {
			this.#insertNode.run(node.l, node.i, encode(node.text), node.size);
		});
		this.#nodes.set(part.key, node);
		return node;
	}

	getMeta(key: string): string | undefined {
		const row = this.#db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
		return row?.value;
	}

	/** The saved view: a writer reads it now; a read-only reader sees it as of its snapshot. */
	savedView(): string | undefined {
		return this.#readOnly ? this.#snapshotView : this.getMeta(VIEW_KEY);
	}

	setMeta(key: string, value: string): void {
		this.#writable();
		this.#write(() => {
			this.#upsertMeta.run(key, value);
		});
	}

	#insertUsageRow(row: UsageRow): void {
		this.#insertUsage.run(row.at, row.role, row.model, row.input, row.cacheRead, row.cacheWrite, row.output, row.ok ? 1 : 0);
	}

	recordUsage(row: UsageRow): void {
		this.#writable();
		this.#write(() => this.#insertUsageRow(row));
	}

	usageRows(): UsageRow[] {
		const rows = this.#db
			.prepare("SELECT at, role, model, input, cache_read, cache_write, output, ok FROM usage ORDER BY id")
			.all() as unknown as UsageRecord[];
		return rows.map((row) => ({
			at: row.at,
			role: row.role,
			model: row.model,
			input: row.input,
			cacheRead: row.cache_read,
			cacheWrite: row.cache_write,
			output: row.output,
			ok: row.ok === 1,
		}));
	}

	/** Read metadata as bytes too: node:sqlite TEXT reads truncate values containing a NUL. */
	#metaValues(): Record<string, string> {
		return Object.fromEntries(this.#db.prepare("SELECT key, CAST(value AS BLOB) AS value FROM meta").all().map((row) => {
			const value = decode(row.value);
			if (value === undefined) throw new StoreError(`Invalid metadata record ${row.key}`);
			return [row.key as string, value];
		}));
	}

	#marks(meta: Readonly<Record<string, string>>): StoreMarks {
		const last = (table: string, column: string, empty: number) =>
			this.#db.prepare(`SELECT COALESCE(MAX(${column}), ?) AS n FROM ${table}`).get(empty)!.n as number;
		return {
			main: last("main", "i", -1),
			tree: last("tree", "rowid", 0),
			usage: last("usage", "id", 0),
			meta: Object.fromEntries(Object.entries(meta).map(([key, value]) => [key, valueHash(value)])),
		};
	}

	/** Everything in one consistent database snapshot counts as saved. */
	marks(): StoreMarks {
		let result!: StoreMarks;
		this.#snapshot(() => { result = this.#marks(this.#metaValues()); });
		return result;
	}

	/** New rows and changed metadata outside the local key prefixes, with marks from the same read transaction. */
	rowsAfter(marks: StoreMarks, localKeys: readonly string[]): { rows: StoreRows; next: StoreMarks } | undefined {
		let result: { rows: StoreRows; next: StoreMarks } | undefined;
		this.#snapshot(() => {
			const values = this.#metaValues();
			const next = this.#marks(values);
			for (const table of ["main", "tree", "usage"] as const) {
				if (marks[table] > next[table]) throw new StoreError(`Saved ${table} mark is past the database's highest row`);
			}
			const messages = this.#db.prepare("SELECT i, kind, text, size, date FROM main WHERE i > ? ORDER BY i").all(marks.main) as unknown as StoredMessage[];
			const nodes = this.#db.prepare("SELECT l, i, text, size FROM tree WHERE rowid > ? ORDER BY rowid").all(marks.tree) as unknown as StoredNode[];
			const usage = this.#db.prepare("SELECT * FROM usage WHERE id > ? ORDER BY id").all(marks.usage) as unknown as (UsageRecord & { id: number })[];
			const meta = Object.fromEntries(Object.entries(values).filter(([key]) => !localKeys.some((prefix) => key.startsWith(prefix)) && next.meta[key] !== marks.meta[key]));
			if (messages.length === 0 && nodes.length === 0 && usage.length === 0 && Object.keys(meta).length === 0) return;
			const readText = (value: unknown) => {
				const text = decode(value);
				if (text === undefined) throw new StoreError("Invalid text in a saved row");
				return text;
			};
			result = {
				next,
				rows: {
					main: messages.map((row) => ({ ...row, text: readText(row.text) })),
					tree: nodes.map((row) => ({ ...row, text: readText(row.text) })),
					usage: usage.map((row) => ({ id: row.id, at: row.at, role: row.role, model: row.model, input: row.input, cacheRead: row.cache_read, cacheWrite: row.cache_write, output: row.output, ok: row.ok === 1 })),
					meta,
				},
			};
		});
		return result;
	}

	/** Validate a complete save, commit all tables together, then update the in-memory log and tree. */
	applyRows(rows: StoreRows): void {
		this.#writable();
		const messages: Message[] = rows.main.map((row, offset) => {
			if (row.i !== this.#root.length + offset) throw new StoreError("Saved history does not continue the log");
			if (!isKind(row.kind) || typeof row.text !== "string" || !row.text.isWellFormed() || row.size !== byteSize(messageSource({ kind: row.kind, text: row.text }))) {
				throw new StoreError(`Invalid message record ${row.i}`);
			}
			try { validDate(row.date); } catch { throw new StoreError(`Invalid date on message ${row.i}`); }
			return { i: row.i, kind: row.kind, text: row.text, size: row.size, date: row.date };
		});
		const total = this.#root.length + messages.length;
		const added = new Map<string, Node>();
		for (const row of [...rows.tree].sort((a, b) => a.l - b.l || a.i - b.i)) {
			const part = new Part(row.l, row.i);
			if (!Number.isSafeInteger(row.l) || row.l < 0 || row.l > bitLength(total) || !Number.isSafeInteger(row.i) || row.i < 0 || part.end > total) {
				throw new StoreError(`Node ${part.address} is outside the log`);
			}
			if (this.#nodes.has(part.key) || added.has(part.key)) throw new StoreError(`Node ${part.address} is immutable`);
			if (typeof row.text !== "string" || !row.text.isWellFormed() || !row.text.trim() || row.size !== byteSize(row.text)) throw new StoreError(`Invalid tree record ${part.address}`);
			if (part.l > 0 && children(part).some((child) => !this.#nodes.has(child.key) && !added.has(child.key))) throw new StoreError(`Node ${part.address} is missing a child`);
			added.set(part.key, { l: row.l, i: row.i, text: row.text, size: row.size });
		}
		let lastUsage = this.#db.prepare("SELECT COALESCE(MAX(id), 0) AS n FROM usage").get()!.n as number;
		for (const row of rows.usage) {
			if (!Number.isSafeInteger(row.id) || row.id !== lastUsage + 1 || ![row.input, row.cacheRead, row.cacheWrite, row.output].every(Number.isFinite) || typeof row.at !== "string" || typeof row.role !== "string" || typeof row.model !== "string" || typeof row.ok !== "boolean") throw new StoreError("Invalid usage record in save");
			lastUsage = row.id;
		}
		for (const value of Object.values(rows.meta)) if (typeof value !== "string") throw new StoreError("Invalid metadata in save");
		const insertUsage = this.#db.prepare("INSERT INTO usage (id, at, role, model, input, cache_read, cache_write, output, ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
		this.#write(() => {
			for (const row of messages) this.#insertMessage.run(row.i, row.kind, encode(row.text), row.size, row.date);
			for (const row of added.values()) this.#insertNode.run(row.l, row.i, encode(row.text), row.size);
			for (const row of rows.usage) insertUsage.run(row.id, row.at, row.role, row.model, row.input, row.cacheRead, row.cacheWrite, row.output, row.ok ? 1 : 0);
			for (const [key, value] of Object.entries(rows.meta)) this.#upsertMeta.run(key, value);
		});
		// Avoid spreading large first saves into push(): the argument limit is much smaller than an agent can be.
		for (const message of messages) this.#root.push(message);
		for (const [key, node] of added) this.#nodes.set(key, node);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		try {
			this.#db.close();
		} finally {
			this.#lock?.();
		}
	}
}
