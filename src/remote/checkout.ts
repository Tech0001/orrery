/** The common check-out door for every writer of an agent's memory. */

import { stripVTControlCharacters } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { HarnessConfig, AgentConfig } from "../agent/config.ts";
import { safeText } from "../agent/source-labels.ts";
import { holdWriterLock, MemoryStore, type WriterLock } from "../memory/store.ts";
import { abortable, cancellableCheckout } from "./open-cancellation.ts";
import { codeToKey } from "./crypto.ts";
import { holderFor, openStorage } from "./index.ts";
import { agentSettings, LOCAL_META_KEYS } from "./save-format.ts";
import { readRemoteSecret } from "./secrets.ts";
import { RemoteSession } from "./session.ts";
import { type LockState, RemoteError, type RemoteStatus, type Storage } from "./types.ts";

// checkOutAgent has no writer yet. Register its loss handler when the writer attaches, after the restore.
const plain = (text: string) => safeText(stripVTControlCharacters(text));
const writers = new WeakMap<RemoteSession, { store: MemoryStore; onLost?: () => void }>();
const checkouts = new WeakMap<RemoteSession, () => void>();

export async function checkOutAgent(
	config: HarnessConfig,
	agent: AgentConfig,
	options: { confirmTakeover?: (held: LockState) => Promise<boolean>; report(message: string): void; storage?: Storage; writer?: WriterLock; signal?: AbortSignal },
): Promise<RemoteSession | undefined> {
	if (agent.remote === undefined) return undefined;
	options.signal?.throwIfAborted();
	const secret = readRemoteSecret(config, agent.remote);
	if (secret === undefined) throw new RemoteError("key-missing", `No key for remote ${agent.remote} on this machine: run orrery remote add ${agent.remote}`);
	// These keys refer to this machine's session.sqlite, which survives a remote snapshot replacement. Preserve
	// the boundary even on a split: already projected local turns must stay in the unsaved archive, not replay.
	const dbPath = join(agent.dir, "memory.sqlite");
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
	const transport = cancellableCheckout(options.storage ?? openStorage(config, agent.remote), options.signal);
	const remote = await RemoteSession.checkOut({
		agent: agent.name,
		agentDir: agent.dir,
		storage: transport.storage,
		writer: options.writer,
		key: codeToKey(secret.key),
		holder: holderFor(config),
		settings: agentSettings(agent),
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
export function remoteOpenNotice(agent: AgentConfig, error: unknown): string {
	const text = plain(error instanceof Error ? error.message : String(error));
	const named = text.toLowerCase().includes(`remote ${agent.remote}`.toLowerCase());
	return error instanceof RemoteError && error.kind === "unreachable" && !named ? plain(`remote ${agent.remote} is unreachable: ${text}`) : text;
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
	agent: AgentConfig,
	write: (remote?: RemoteSession, writer?: WriterLock) => T | Promise<T>,
	report: (message: string) => void,
): Promise<T> {
	if (agent.remote === undefined) return write();
	const writer = holdWriterLock(join(agent.dir, "memory.sqlite"));
	try {
		let remote: RemoteSession | undefined;
		try {
			remote = await checkOutAgent(config, agent, { report, writer });
		} catch (error) {
			throw new Error(remoteOpenNotice(agent, error), { cause: error });
		}
		if (remote === undefined) return write(undefined, writer);
		let result: T;
		try {
			result = await write(remote, writer);
		} finally {
			try {
				try {
					if (!remote.lost && !writers.has(remote)) attachRemoteStore(remote, MemoryStore.open(join(agent.dir, "memory.sqlite"), writer));
				} finally {
					await remote.close();
				}
			} finally {
				writers.get(remote)?.store.close();
			}
		}
		if (remote.lost) throw new RemoteError("lock-lost", plain(`${agent.name} moved to ${remote.status().movedTo ?? "another machine"}; this session runs without memory now.`));
		return result;
	} finally { writer(); }
}
