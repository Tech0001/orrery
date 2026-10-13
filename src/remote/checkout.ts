/** The common check-out door for every writer of a lane's memory. */

import { stripVTControlCharacters } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { HarnessConfig, LaneConfig } from "../lane/config.ts";
import { safeText } from "../lane/source-labels.ts";
import { holdWriterLock, MemoryStore, type WriterLock } from "../memory/store.ts";
import { abortable, cancellableCheckout } from "./open-cancellation.ts";
import { codeToKey } from "./crypto.ts";
import { holderFor, openStorage } from "./index.ts";
import { laneSettings, LOCAL_META_KEYS } from "./save-format.ts";
import { readRemoteSecret } from "./secrets.ts";
import { RemoteSession } from "./session.ts";
import { type LockState, RemoteError, type RemoteStatus, type Storage } from "./types.ts";

// checkOutLane has no writer yet. Register its loss handler when the writer attaches, after the restore.
const plain = (text: string) => safeText(stripVTControlCharacters(text));
const writers = new WeakMap<RemoteSession, { store: MemoryStore; onLost?: () => void }>();
const checkouts = new WeakMap<RemoteSession, () => void>();

export async function checkOutLane(
	config: HarnessConfig,
	lane: LaneConfig,
	options: { confirmTakeover?: (held: LockState) => Promise<boolean>; report(message: string): void; storage?: Storage; writer?: WriterLock; signal?: AbortSignal },
): Promise<RemoteSession | undefined> {
	if (lane.remote === undefined) return undefined;
	options.signal?.throwIfAborted();
	const secret = readRemoteSecret(config, lane.remote);
	if (secret === undefined) throw new RemoteError("key-missing", `No key for remote ${lane.remote} on this machine: run orrery remote add ${lane.remote}`);
	// These keys refer to this machine's session.sqlite, which survives a remote snapshot replacement. Preserve
	// the boundary even on a split: already projected local turns must stay in the unsaved archive, not replay.
	const dbPath = join(lane.dir, "memory.sqlite");
	const localMeta: Record<string, string> = {};
	if (existsSync(dbPath)) {
		const local = MemoryStore.openReadOnly(dbPath);
		try {
			for (const key of Object.keys(local.marks().meta)) {
				if (!LOCAL_META_KEYS.some((prefix) => prefix.endsWith(".") ? key.startsWith(prefix) : key === prefix)) continue;
				const value = local.getMeta(key);
				if (value !== undefined) localMeta[key] = value;
			}
		} finally { local.close(); }
	}
	const transport = cancellableCheckout(options.storage ?? openStorage(config, lane.remote), options.signal);
	const remote = await RemoteSession.checkOut({
		lane: lane.name,
		laneDir: lane.dir,
		storage: transport.storage,
		writer: options.writer,
		key: codeToKey(secret.key),
		holder: holderFor(config),
		settings: laneSettings(lane),
		confirmTakeover: options.confirmTakeover === undefined ? undefined : (held) => abortable(options.signal, () => options.confirmTakeover!(held)),
		report: (message) => options.report(plain(message)),
		onLost: () => {
			const writer = writers.get(remote);
			writer?.store.close();
			writer?.onLost?.();
		},
	});
	try {
		options.signal?.throwIfAborted();
		if (Object.keys(localMeta).length > 0) {
			const restored = MemoryStore.open(dbPath, options.writer);
			try {
				for (const [key, value] of Object.entries(localMeta)) restored.setMeta(key, value);
			} finally { restored.close(); }
		}
		// Opening the writer can still fail. Keep its cleanup within the checkout deadline until it attaches.
		checkouts.set(remote, transport.finish);
		return remote;
	} catch (error) {
		await remote.close();
		throw error;
	}
}

/** Attach the actual writer, so a fenced-out session cannot keep writing even while a turn or summary runs. */
export function attachRemoteStore(remote: RemoteSession, store: MemoryStore, onLost?: () => void): void {
	checkouts.get(remote)?.();
	checkouts.delete(remote);
	writers.set(remote, { store, onLost });
	remote.attach(store);
}

/** Plain words at open; remote/provider text must never pass control sequences to an agent or terminal. */
export function remoteOpenNotice(lane: LaneConfig, error: unknown): string {
	const text = plain(error instanceof Error ? error.message : String(error));
	const named = text.toLowerCase().includes(`remote ${lane.remote}`.toLowerCase());
	return error instanceof RemoteError && error.kind === "unreachable" && !named ? plain(`remote ${lane.remote} is unreachable: ${text}`) : text;
}

export function remoteFooter(status: RemoteStatus): string {
	const { remote, state } = status;
	if (state === "lost") return plain(`${remote}: moved to ${status.movedTo ?? "another machine"}`);
	if (state === "failing") return plain(`${remote} ⚠ not saved: ${status.reason ?? "unknown error"}`);
	if (state === "pending") return plain(`${remote} · not saved yet`);
	return plain(`${remote} ✓${status.savedAt === undefined ? "" : ` ${status.savedAt}`}`);
}

/**
 * Take, restore, write, save and release. The optional session argument lets a long-running writer attach its
 * store immediately (renewal and loss handling must cover the work). The helper closes that store after saving.
 * The second argument is the held local writer reservation: pass it to MemoryStore.open, keeping the lock across
 * checkout, callback work and final save. A callback without an attached store must close its store before returning.
 */
export async function withBriefCheckOut<T>(
	config: HarnessConfig,
	lane: LaneConfig,
	write: (remote?: RemoteSession, writer?: WriterLock) => T | Promise<T>,
	report: (message: string) => void,
): Promise<T> {
	if (lane.remote === undefined) return write();
	const writer = holdWriterLock(join(lane.dir, "memory.sqlite"));
	try {
		let remote: RemoteSession | undefined;
		try {
			remote = await checkOutLane(config, lane, { report, writer });
		} catch (error) {
			throw new Error(remoteOpenNotice(lane, error), { cause: error });
		}
		if (remote === undefined) return write(undefined, writer);
		let result: T;
		try {
			result = await write(remote, writer);
		} finally {
			try {
				try {
					if (!remote.lost && !writers.has(remote)) attachRemoteStore(remote, MemoryStore.open(join(lane.dir, "memory.sqlite"), writer));
				} finally {
					await remote.close();
				}
			} finally {
				writers.get(remote)?.store.close();
			}
		}
		if (remote.lost) throw new RemoteError("lock-lost", plain(`${lane.name} moved to ${remote.status().movedTo ?? "another machine"}; this session runs without memory now.`));
		return result;
	} finally { writer(); }
}
