/** Read-only remote agent caches: refresh under the copy's writer lock, never take the remote's lock. */

import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { HarnessConfig, AgentConfig } from "../agent/config.ts";
import { writePrivate } from "../agent/private-file.ts";
import { processAlive } from "../agent/process.ts";
import { localIso } from "../memory/bytes.ts";
import { holdWriterLock, MemoryStore, type StoreRows, type WriterLock } from "../memory/store.ts";
import { StoreError } from "../memory/types.ts";
import { codeToKey, unseal } from "./crypto.ts";
import { openStorage } from "./index.ts";
import { assertWrittenThrough, decodeRows, decodeSnapshot, restoreSnapshot } from "./save-format.ts";
import { readRemoteSecret } from "./secrets.ts";
import { CALL_TIMEOUT_MS, RemoteError, type FetchResult, type Storage } from "./types.ts";

interface CopyState {
	readonly v: 1;
	readonly remote: string;
	readonly save: number;
	readonly fetchedAt: number;
	readonly database: string;
}

interface CopyPath { readonly path: string; readonly asOf?: string }
interface ReadOptions { readonly storage?: Storage; readonly now?: () => number }
const REFRESH_MS = 60_000;
const refreshing = new Map<string, Promise<CopyPath>>();

/** The same liveness rule as the local agent listing, including older status files without an open flag. */
export function agentOpenHere(agent: AgentConfig): boolean {
	try {
		const status = JSON.parse(readFileSync(join(agent.dir, "status.json"), "utf8"));
		return status.open !== false && typeof status.pid === "number" && processAlive(status.pid);
	} catch { return false; }
}

/** A rename replaces the inode; tie state to that exact copy to recover a crash between the two publications. */
function databaseStamp(path: string): string {
	const stat = statSync(path, { bigint: true });
	return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
}

function copyState(path: string, remote: string, database: string): CopyState | undefined {
	try {
		const state = JSON.parse(readFileSync(path, "utf8")) as CopyState;
		if (state.v === 1 && state.remote === remote && Number.isSafeInteger(state.save) && state.save >= 0 && Number.isFinite(state.fetchedAt) && state.database === databaseStamp(database)) return state;
	} catch { /* A missing or incomplete state needs a full rebuild. */ }
	return undefined;
}

/** Hold the exact SQLite lock file used by MemoryStore, with no database connection to obstruct replacement. */
async function copyLock(path: string): Promise<WriterLock> {
	const until = performance.now() + CALL_TIMEOUT_MS;
	for (;;) {
		try {
			return holdWriterLock(path);
		} catch (error) {
			if (!(error instanceof StoreError) || !error.message.includes("already open")) throw error;
			if (performance.now() >= until) throw new RemoteError("refused", "this read copy is busy; try again");
			await delay(25);
		}
	}
}

/** Only replay failure triggers a rebuild; authentication and publication failures propagate. */
class ApplyError extends RemoteError {
	constructor() { super("corrupt", "a save from the remote could not be applied to the read copy"); }
}

/** Apply all fetched rows atomically: a bad later save must not leave a partial refresh in the old copy. */
function applySaves(store: MemoryStore, rows: StoreRows[]): void {
	try {
		store.applyRows({
			main: rows.flatMap((batch) => batch.main), tree: rows.flatMap((batch) => batch.tree),
			usage: rows.flatMap((batch) => batch.usage), meta: Object.fromEntries(rows.flatMap((batch) => Object.entries(batch.meta))),
		});
	} catch { throw new ApplyError(); }
}

/** Authenticate before writing; append saves in place, or stage and publish a genuinely newer snapshot. */
function updateCopy(path: string, agent: string, key: Uint8Array, fetched: FetchResult, after: number, writer: WriterLock): number {
	let saved = fetched.snapshot?.n ?? after;
	if (saved < 0 || !Number.isSafeInteger(fetched.newestSave) || fetched.newestSave < saved) throw new RemoteError("corrupt", "the remote read copy has no usable snapshot");
	const snapshot = fetched.snapshot === undefined ? undefined : decodeSnapshot(unseal(key, agent, "snapshot", fetched.snapshot.n, fetched.snapshot.file));
	if (snapshot !== undefined && snapshot.header.n !== saved) throw new RemoteError("corrupt", "a snapshot header has the wrong save number");
	// Authenticate the whole response before touching any local database.
	const rows = fetched.saves.map((save) => {
		if (save.n !== saved + 1) throw new RemoteError("corrupt", "a remote save does not continue the read copy");
		saved = save.n;
		return decodeRows(unseal(key, agent, "save", save.n, save.file));
	});
	if (saved !== fetched.newestSave) throw new RemoteError("corrupt", "the remote read copy is missing saves");
	if (snapshot !== undefined) {
		const staging = mkdtempSync(join(dirname(path), ".refresh-"));
		try {
			const stagedPath = join(staging, "memory.sqlite");
			restoreSnapshot(stagedPath, snapshot.db);
			const store = MemoryStore.open(stagedPath);
			try { if (rows.length > 0) applySaves(store, rows); } finally { store.close(); }
			assertWrittenThrough(stagedPath);
			writer.check(path);
			for (const suffix of ["-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
			renameSync(stagedPath, path);
			const folder = openSync(dirname(path), "r");
			try { fsyncSync(folder); } finally { closeSync(folder); }
		} finally { rmSync(staging, { recursive: true, force: true }); }
	} else if (rows.length > 0) {
		const store = MemoryStore.open(path, writer);
		try { applySaves(store, rows); } finally { store.close(); }
	}
	return saved;
}

async function refresh(config: HarnessConfig, agent: AgentConfig, path: string, options: ReadOptions): Promise<CopyPath> {
	const remote = agent.remote!;
	const secret = readRemoteSecret(config, remote);
	if (secret === undefined) throw new RemoteError("key-missing", `the key for remote ${remote} isn't on this machine`);
	const key = codeToKey(secret.key);
	const now = options.now ?? Date.now;
	const dir = join(config.dataDir, "read-copies", agent.name);
	const statePath = join(dir, "state.json");
	const current = () => existsSync(path) ? copyState(statePath, remote, path) : undefined;
	const fresh = (state: CopyState | undefined) => state !== undefined && now() >= state.fetchedAt && now() - state.fetchedAt < REFRESH_MS;
	if (fresh(current())) return { path };
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const lock = await copyLock(path);
	try {
		const state = current(); // Another process may have refreshed while this one waited for the lock.
		if (fresh(state)) return { path };
		try {
			const storage = options.storage ?? openStorage(config, remote);
			let after = state?.save ?? -1;
			let fetched = await storage.fetch(agent.name, after);
			if (fetched.newestSave < after) {
				after = -1;
				fetched = await storage.fetch(agent.name, after);
			}
			let saved: number;
			try { saved = updateCopy(path, agent.name, key, fetched, after, lock); }
			catch (error) {
				if (!(error instanceof ApplyError) || after === -1) throw error;
				// A dropped/recreated agent can reuse save numbers for a different history. Rebuild exactly once.
				saved = updateCopy(path, agent.name, key, await storage.fetch(agent.name, -1), -1, lock);
			}
			writePrivate(statePath, JSON.stringify({ v: 1, remote, save: saved, fetchedAt: now(), database: databaseStamp(path) } satisfies CopyState));
			return { path };
		} catch (error) {
			if (!(error instanceof RemoteError) || (error.kind !== "unreachable" && error.kind !== "quota")) throw error;
			if (state !== undefined) return { path, asOf: localIso(new Date(state.fetchedAt)).slice(11, 16) };
			if (error.kind === "quota") throw error;
			throw new RemoteError("unreachable", `remote ${remote} can't be reached`);
		}
	} finally { lock(); }
}

export async function readCopyPath(config: HarnessConfig, agent: AgentConfig, options: ReadOptions = {}): Promise<CopyPath> {
	if (agent.remote === undefined || agentOpenHere(agent)) return { path: join(agent.dir, "memory.sqlite") };
	const path = join(config.dataDir, "read-copies", agent.name, "memory.sqlite");
	const existing = refreshing.get(path);
	if (existing !== undefined) return existing;
	const pending = refresh(config, agent, path, options);
	refreshing.set(path, pending);
	try { return await pending; }
	finally { refreshing.delete(path); }
}
