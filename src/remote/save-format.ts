/** Versioned, compressed saves and consistent SQLite snapshots for remote agent memory. */

import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import type { AgentConfig } from "../agent/config.ts";
import { validDate } from "../memory/bytes.ts";
import { openDatabase, type Database, vacuumInto } from "../memory/sqlite.ts";
import { MemoryStore, type StoreRows } from "../memory/store.ts";
import { isKind } from "../memory/types.ts";
import { unseal } from "./crypto.ts";
import { RemoteError, type Storage } from "./types.ts";

// These key prefixes name positions in local files: the projector's session.sqlite, pi logs, and Claude spools.
// Their source files stay on this machine, so their cursors do too. Views, models and instructions travel.
export const LOCAL_META_KEYS: readonly string[] = ["projector.cursor", "pi.cursor.", "claude.spool."];

export interface SaveHeader {
	readonly v: 1;
	readonly n: number;
	readonly lock: number;
	readonly machine: string;
	readonly device: string;
	readonly at: string;
	readonly rows: { readonly main: number; readonly tree: number; readonly usage: number; readonly meta: number };
	readonly sha256: string;
	/** On the first save after a forced take: the machine whose lock was taken over (spec §6, the audit log). */
	readonly takeover?: { readonly from: string };
}

/** Portable settings copied once by agent pull; machine-specific folder paths are not included. */
export interface AgentSettings {
	readonly tool?: string;
	readonly compactorModel: string;
	readonly compactorThinking: string;
	readonly viewBytes?: number;
	/** Summary size (node_bytes). */
	readonly nodeBytes?: number;
	/** The top of each summary call's view (compactor_context_bytes), when the agent sets one. */
	readonly contextBytes?: number;
	readonly compactorJobs?: number;
	readonly compactAt?: number;
	/** Before agents: the agent's instructions file name. Read from older snapshots; never written or used. */
	readonly instructions?: string;
	readonly reads?: readonly string[];
}

export function agentSettings(agent: AgentConfig): AgentSettings {
	return {
		...(agent.tool === undefined ? {} : { tool: agent.tool }),
		compactorModel: `${agent.compactor.model.provider}/${agent.compactor.model.modelId}`,
		compactorThinking: agent.compactor.model.thinking,
		viewBytes: agent.memory.viewBytes,
		nodeBytes: agent.memory.nodeBytes,
		...(agent.compactor.contextBytes === undefined ? {} : { contextBytes: agent.compactor.contextBytes }),
		compactorJobs: agent.compactor.jobs,
		compactAt: agent.compactAt,
		reads: [...agent.reads],
	};
}

/** Snapshot plaintext is a big-endian header length, this UTF-8 JSON header, and compressed database bytes. */
export interface SnapshotHeader {
	readonly v: 1;
	readonly n: number;
	readonly lock: number;
	readonly machine: string;
	readonly at: string;
	readonly settings: AgentSettings;
}

export function encodeSnapshot(header: SnapshotHeader, db: Uint8Array): Uint8Array {
	const json = Buffer.from(JSON.stringify(header));
	const length = Buffer.alloc(4);
	length.writeUInt32BE(json.byteLength);
	return Buffer.concat([length, json, db]);
}

export function decodeSnapshot(plain: Uint8Array): { header: SnapshotHeader; db: Uint8Array } {
	try {
		if (plain.byteLength < 4) throw new Error("Missing header length");
		const bytes = Buffer.from(plain.buffer, plain.byteOffset, plain.byteLength);
		const length = bytes.readUInt32BE(0);
		if (length === 0 || length >= bytes.byteLength - 4) throw new Error("Truncated snapshot");
		const header: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(4, 4 + length)));
		if (!record(header) || header.v !== 1 || !natural(header.n) || !natural(header.lock) || typeof header.machine !== "string" || typeof header.at !== "string" || !record(header.settings)) throw new Error("Invalid snapshot header");
		validDate(header.at);
		const settings = header.settings;
		if (typeof settings.compactorModel !== "string" || !/^[^/]+\/.+/.test(settings.compactorModel) || typeof settings.compactorThinking !== "string") throw new Error("Invalid model settings");
		for (const key of ["tool", "instructions"]) if (settings[key] !== undefined && typeof settings[key] !== "string") throw new Error("Invalid text setting");
		for (const key of ["viewBytes", "nodeBytes", "contextBytes", "compactorJobs", "compactAt"]) if (settings[key] !== undefined && (!natural(settings[key]) || settings[key] === 0)) throw new Error("Invalid numeric setting");
		if (settings.reads !== undefined && (!Array.isArray(settings.reads) || !settings.reads.every((agent) => typeof agent === "string"))) throw new Error("Invalid reader settings");
		return { header: header as unknown as SnapshotHeader, db: bytes.subarray(4 + length) };
	} catch {
		throw new RemoteError("corrupt", "a snapshot header from the remote could not be read");
	}
}

/** Read the newest snapshot's settings without opening or restoring the database. */
export async function remoteAgentSettings(storage: Storage, key: Uint8Array, agent: string): Promise<SnapshotHeader> {
	const { snapshot } = await storage.fetch(agent, -1);
	if (snapshot === undefined) throw new RemoteError("not-found", `${agent} has no snapshot on remote ${storage.name}`);
	const { header } = decodeSnapshot(unseal(key, agent, "snapshot", snapshot.n, snapshot.file));
	if (header.n !== snapshot.n) throw new RemoteError("corrupt", "a snapshot header has the wrong save number");
	return header;
}

export function encodeRows(rows: StoreRows): Uint8Array {
	return gzipSync(Buffer.from(JSON.stringify({ v: 1, ...rows })));
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function natural(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function decodeRows(body: Uint8Array): StoreRows {
	try {
		const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(gunzipSync(body)));
		if (!record(value) || value.v !== 1 || !Array.isArray(value.main) || !Array.isArray(value.tree) || !Array.isArray(value.usage) || !record(value.meta)) throw new Error("Invalid save shape");
		if (!value.main.every((row: unknown) => record(row) && natural(row.i) && isKind(row.kind) && typeof row.text === "string" && natural(row.size) && typeof row.date === "string")) throw new Error("Invalid messages");
		if (!value.tree.every((row: unknown) => record(row) && natural(row.l) && natural(row.i) && typeof row.text === "string" && natural(row.size))) throw new Error("Invalid nodes");
		if (!value.usage.every((row: unknown) => record(row) && natural(row.id) && row.id > 0 && typeof row.at === "string" && typeof row.role === "string" && typeof row.model === "string" && [row.input, row.cacheRead, row.cacheWrite, row.output].every(Number.isFinite) && typeof row.ok === "boolean")) throw new Error("Invalid usage");
		if (value.usage.some((row, i, rows) => i > 0 && row.id !== rows[i - 1].id + 1)) throw new Error("Usage gap in save");
		if (!Object.values(value.meta).every((item) => typeof item === "string")) throw new Error("Invalid metadata");
		return {
			main: value.main.map(({ i, kind, text, size, date }) => ({ i, kind, text, size, date })),
			tree: value.tree.map(({ l, i, text, size }) => ({ l, i, text, size })),
			usage: value.usage.map(({ id, at, role, model, input, cacheRead, cacheWrite, output, ok }) => ({ id, at, role, model, input, cacheRead, cacheWrite, output, ok })),
			meta: value.meta as StoreRows["meta"],
		};
	} catch {
		throw new RemoteError("corrupt", "a save from the remote could not be read");
	}
}

export function makeHeader(fields: Omit<SaveHeader, "v" | "sha256" | "rows">, rows: StoreRows, body: Uint8Array): SaveHeader {
	return {
		...fields,
		v: 1,
		rows: { main: rows.main.length, tree: rows.tree.length, usage: rows.usage.length, meta: Object.keys(rows.meta).length },
		sha256: createHash("sha256").update(body).digest("hex"),
	};
}

function tempPath(dbPath: string, kind: string): string {
	return join(dirname(dbPath), `.${kind}-${process.pid}-${randomBytes(12).toString("hex")}.sqlite`);
}

/** The private folder vacuumInto (src/memory/sqlite.ts) writes in, `<target>-XXXXXX`, beside a snapshot or a set-aside copy. */
const VACUUM_FOLDER = /^(\.snapshot-.+|memory-before-remote-.+)\.sqlite-[A-Za-z0-9]{6}$/;

/**
 * Recover files left by interrupted snapshot/restore operations, and vacuumInto's folders left by interrupted snapshots
 * and set-asides, without disturbing recent work. Links are never followed or removed.
 */
function cleanOldTemps(dbPath: string): void {
	const cutoff = Date.now() - 60 * 60 * 1000;
	for (const name of readdirSync(dirname(dbPath))) {
		const file = name.startsWith(".restore-") || name.startsWith(".snapshot-");
		const folder = VACUUM_FOLDER.test(name);
		if (!file && !folder) continue;
		const path = join(dirname(dbPath), name);
		const stat = lstatSync(path, { throwIfNoEntry: false });
		if (stat === undefined || stat.mtimeMs >= cutoff) continue;
		if (file && stat.isFile()) rmSync(path, { force: true });
		else if (folder && stat.isDirectory()) rmSync(path, { recursive: true, force: true });
	}
}

function localMeta(db: Database): [string, string][] {
	return db.prepare("SELECT key, CAST(value AS BLOB) AS value FROM meta").all()
		.filter((row) => LOCAL_META_KEYS.some((prefix) => (row.key as string).startsWith(prefix)))
		.map((row) => [row.key as string, Buffer.from(row.value as Uint8Array).toString("utf8")]);
}

function removeLocalMeta(db: Database): void {
	const remove = db.prepare("DELETE FROM meta WHERE key = ?");
	for (const [key] of localMeta(db)) remove.run(key);
}

/**
 * A VACUUM copy sees committed WAL data without changing the source's tree rowids. `meta` is written into the copy only
 * (a first push's values, which the working copy takes once the push has landed).
 */
export function snapshotBytes(dbPath: string, meta: Readonly<Record<string, string>> = {}): Uint8Array {
	cleanOldTemps(dbPath);
	const temp = tempPath(dbPath, "snapshot");
	// Reserve it privately before SQLite writes any memory text.
	closeSync(openSync(temp, "wx", 0o600));
	try {
		const db = openDatabase(dbPath, { readOnly: true });
		try { vacuumInto(db, temp); } finally { db.close(); }
		// Local metadata is excluded from full snapshots as well as incremental saves.
		const copy = openDatabase(temp);
		try {
			copy.exec("PRAGMA secure_delete = ON");
			removeLocalMeta(copy);
			const upsert = copy.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
			for (const [key, value] of Object.entries(meta)) upsert.run(key, value);
		} finally { copy.close(); }
		return gzipSync(readFileSync(temp));
	} finally {
		rmSync(temp, { force: true });
	}
}

/**
 * A copy about to be renamed into place must hold everything in its own file: rows still in its WAL (a connection left
 * open) would stay behind with the old name and be deleted with it.
 */
export function assertWrittenThrough(path: string): void {
	const wal = lstatSync(`${path}-wal`, { throwIfNoEntry: false });
	if (wal !== undefined && wal.size > 0) throw new RemoteError("corrupt", "the new copy of the memory was not fully written; the old copy is kept");
}

/** Caller holds the store lock and has closed its database connection before replacing the working copy. */
export function restoreSnapshot(dbPath: string, bytes: Uint8Array): void {
	mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
	cleanOldTemps(dbPath);
	let plain: Uint8Array;
	try { plain = gunzipSync(bytes); } catch { throw new RemoteError("corrupt", "a snapshot from the remote could not be read"); }
	const temp = tempPath(dbPath, "restore");
	const fd = openSync(temp, "wx", 0o600);
	try {
		try {
			writeFileSync(fd, plain);
		} finally { closeSync(fd); }
		// A valid gzip is not necessarily a valid database. Validate before touching the working copy or its WAL.
		try {
			const db = openDatabase(temp, { readOnly: true });
			try {
				const checks = db.prepare("PRAGMA quick_check").all();
				if (checks.length !== 1 || checks[0].quick_check !== "ok") throw new Error("Invalid SQLite snapshot");
			} finally { db.close(); }
			MemoryStore.openReadOnly(temp).close();
		} catch { throw new RemoteError("corrupt", "a snapshot from the remote could not be read"); }
		let carried: [string, string][] = [];
		if (existsSync(dbPath)) {
			try {
				const old = openDatabase(dbPath, { readOnly: true });
				try { carried = localMeta(old); } finally { old.close(); }
			} catch (error) {
				// A non-database placeholder has no metadata. Other read failures must leave the old copy intact.
				if ((error as { errcode?: number }).errcode !== 26) throw error;
			}
		}
		const copy = openDatabase(temp);
		try {
			copy.exec("PRAGMA secure_delete = ON; BEGIN IMMEDIATE");
			removeLocalMeta(copy);
			const insert = copy.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
			for (const [key, value] of carried) insert.run(key, value);
			copy.exec("COMMIT");
		} finally { copy.close(); }
		// Sync after carrying metadata into the replacement, then make the rename durable too.
		assertWrittenThrough(temp);
		const ready = openSync(temp, "r");
		try { fsyncSync(ready); } finally { closeSync(ready); }
		rmSync(`${dbPath}-wal`, { force: true });
		rmSync(`${dbPath}-shm`, { force: true });
		renameSync(temp, dbPath);
		const folder = openSync(dirname(dbPath), "r");
		try { fsyncSync(folder); } finally { closeSync(folder); }
	} finally {
		rmSync(temp, { force: true });
		rmSync(`${temp}-wal`, { force: true });
		rmSync(`${temp}-shm`, { force: true });
	}
}
