/**
 * A remote lane's check-out (spec 2026-10-12-remote-lanes-design §5): take the lane's lock on its remote, bring the
 * working copy up to the newest save, then save the rows added after each turn, renew the lock every minute, and
 * release it at close. A lock lost to another machine stops all writing; the working copy is never the remote's truth
 * unless this session holds the lock.
 */

import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, vacuumInto } from "../memory/sqlite.ts";
import { holdWriterLock, MemoryStore, type StoreMarks, type StoreRows, type WriterLock } from "../memory/store.ts";
import { processAlive } from "../lane/process.ts";
import { writePrivate } from "../lane/private-file.ts";
import { seal, unseal } from "./crypto.ts";
import { agreeOn, agreeOnOwnRows, forgetAgreement, INSTRUCTIONS_KEY, instructionsIntoStore, pushInstructions, type SettledInstructions, settleInstructions, SYNCED_FILE } from "./instructions-sync.ts";
import { assertWrittenThrough, decodeRows, decodeSnapshot, encodeRows, encodeSnapshot, type LaneSettings, LOCAL_META_KEYS, makeHeader, restoreSnapshot, type SaveHeader, snapshotBytes } from "./save-format.ts";
import {
	type FetchResult,
	type Holder,
	type LockState,
	MAX_REMOTE_NUMBER,
	RemoteError,
	type RemoteStatus,
	RENEW_MS,
	SNAPSHOT_EVERY_BYTES,
	SNAPSHOT_EVERY_SAVES,
	type Storage,
} from "./types.ts";

export interface RemoteSessionOptions {
	/** The caller's local writer reservation, held across checkout and the eventual writer open. */
	readonly writer?: WriterLock;
	readonly lane: string;
	/** Holds memory.sqlite and remote-state.json. */
	readonly laneDir: string;
	readonly storage: Storage;
	readonly key: Uint8Array;
	readonly holder: Holder;
	/** Asked when another machine's lock is stale; false (or no function) keeps the lane closed. */
	readonly confirmTakeover?: (held: LockState) => Promise<boolean>;
	readonly report: (message: string) => void;
	/** Called once when another machine took the lane over: the caller stops writing to the store. */
	readonly onLost?: () => void;
	readonly now?: () => number;
	/** Default RENEW_MS; 0 disables the timer (tests call renew() by hand). */
	readonly renewMs?: number;
	/** The lane's config settings, carried in every snapshot's header for `orrery lane pull` (spec §4). */
	readonly settings: LaneSettings;
}

/** A save sent but not acknowledged when the state was written: adopted at the next check-out if the remote has it. */
interface Inflight {
	readonly n: number;
	readonly sha256: string;
	readonly marks: StoreMarks;
}

/** remote-state.json: where this working copy stands against its remote. */
interface SessionState {
	readonly v: 1;
	readonly remote: string;
	readonly lock: number;
	/** The newest save this working copy has, and the sha256 of its body ("" when it came from a snapshot). */
	readonly save: number;
	readonly sha256: string;
	readonly marks: StoreMarks;
	/** The newest snapshot this working copy is known to match, and the sha256 of that sealed file. */
	readonly snapshotAt: number;
	readonly snapshotSha: string;
	readonly bytesSinceSnapshot: number;
	readonly inflight?: Inflight;
	/** A snapshot sent but not acknowledged: recognised at the next check-out if its reply was lost. */
	readonly snapshotPending?: { readonly n: number; readonly sha256: string };
}

type Position = Omit<SessionState, "v" | "remote" | "lock" | "inflight" | "snapshotPending">;

/** A save sent but not yet acknowledged: retried with the same bytes so a lost reply can't fork the history. */
interface Unacked {
	readonly n: number;
	readonly file: Uint8Array;
	readonly logEntry: Uint8Array;
	readonly next: StoreMarks;
	readonly sha256: string;
	/** When this save crosses the snapshot threshold: the snapshot covering exactly saves 1..n, read in the same step. */
	readonly snapshot?: Uint8Array;
}

/**
 * Lanes this process has checked out, by remote and lane. A lock that names this very process while none is open here
 * was left by a release that failed (pi keeps its pid across /new and /reload): retaken without asking.
 */
const OPEN_HERE = new Set<string>();

function openKey(storage: Storage, lane: string): string {
	return `${storage.name}/${lane}`;
}

const STATE_FILE = "remote-state.json";
const DB_FILE = "memory.sqlite";

/**
 * The store key holding the remote history's identity: a random id a first push writes, so it rides in every snapshot
 * and every working copy made from them. A history pushed by an older build gets one from its first writer's attach.
 * remote-state.json records it through its marks (the hash of every travelling metadata value the remote has), so a
 * check-out can tell this lane's history from another one under the same remote and lane name: the lane removed from
 * the remote and pushed again, or the remote replaced.
 */
export const HISTORY_KEY = "remote.history";

const newHistoryId = () => randomBytes(16).toString("hex");
/** A command took and released the lane; the next checkout carries its source into the first save's audit. */
export const TAKEOVER_FILE = "takeover-from.json";

function pendingTakeover(laneDir: string): string | undefined {
	const path = join(laneDir, TAKEOVER_FILE);
	if (!existsSync(path)) return undefined;
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (value !== null && typeof value === "object" && "machine" in value && typeof value.machine === "string" && value.machine.length > 0) return value.machine;
	} catch { /* Refuse a damaged marker rather than silently omitting the takeover audit. */ }
	throw new RemoteError("corrupt", "The pending takeover record is invalid");
}

function hhmm(ms: number): string {
	const d = new Date(ms);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function stamp(ms: number): string {
	return new Date(ms).toISOString().replaceAll(":", "-");
}

function isLocalKey(key: string): boolean {
	return LOCAL_META_KEYS.some((local) => (local.endsWith(".") ? key.startsWith(local) : key === local));
}

function readState(laneDir: string, remote: string): SessionState | undefined {
	const path = join(laneDir, STATE_FILE);
	if (!existsSync(path)) return undefined;
	try {
		const state = JSON.parse(readFileSync(path, "utf8")) as SessionState;
		if (state.v !== 1 || state.remote !== remote || !Number.isSafeInteger(state.save)) return undefined;
		return { ...state, snapshotSha: typeof state.snapshotSha === "string" ? state.snapshotSha : "" };
	} catch {
		return undefined;
	}
}

function writeState(laneDir: string, state: SessionState): void {
	writePrivate(join(laneDir, STATE_FILE), `${JSON.stringify(state)}\n`);
}

/** Calls a caller's callback; a callback that throws (pi after shutdown) must never take a session down. */
function guarded(call: () => void): void {
	try {
		call();
	} catch {
		// nothing to do: the caller is gone
	}
}

/** Plain words for a lock someone else holds. */
export function heldMessage(lane: string, held: LockState): string {
	return `${lane} is open on ${held.holder.machine} (last seen ${hhmm(held.lastSeen)})`;
}

/** Plain words for a failed save or renewal, for the footer. */
function reasonOf(error: unknown): string {
	if (error instanceof RemoteError) {
		if (error.kind === "unreachable") return "offline";
		if (error.kind === "auth") return "sign-in refused";
		if (error.kind === "quota") return "daily limit reached";
		return error.message;
	}
	return error instanceof Error ? error.message : String(error);
}

export class RemoteSession {
	readonly #o: RemoteSessionOptions;
	readonly #now: () => number;
	readonly #dbPath: string;
	readonly #lock: number;
	#save: number;
	#sha: string;
	#marks: StoreMarks;
	#snapshotAt: number;
	#snapshotSha: string;
	#bytesSinceSnapshot: number;
	/** Set after a forced take: the first save names the machine it took the lane from. */
	#takeoverFrom: string | undefined;
	#store: MemoryStore | undefined;
	/** The hash of the instructions the check-out settled the file and the store on; undefined when it did not settle them. */
	#instructions: string | undefined;
	/** The hash of this machine's instructions put into the store, agreed on once a save carrying them is acknowledged. */
	#instructionsSent: string | undefined;
	#unacked: Unacked | undefined;
	/** A snapshot not yet acknowledged: still valid (it covers saves 1..n), sealed once and retried with the same bytes. */
	#pendingSnapshot: { readonly n: number; readonly sealed: Uint8Array; readonly sha256: string } | undefined;
	#status: RemoteStatus;
	#timer: ReturnType<typeof setInterval> | undefined;
	#chain: Promise<void> = Promise.resolve();
	#lost = false;
	#closing = false;
	#closed = false;

	private constructor(o: RemoteSessionOptions, lock: number, position: Position, takeoverFrom: string | undefined) {
		this.#o = o;
		this.#now = o.now ?? Date.now;
		this.#dbPath = join(o.laneDir, DB_FILE);
		this.#lock = lock;
		this.#save = position.save;
		this.#sha = position.sha256;
		this.#marks = position.marks;
		this.#snapshotAt = position.snapshotAt;
		this.#snapshotSha = position.snapshotSha;
		this.#bytesSinceSnapshot = position.bytesSinceSnapshot;
		this.#takeoverFrom = takeoverFrom;
		this.#status = { remote: o.storage.name, state: "saved", savedAt: hhmm(this.#now()) };
	}

	/** True once another machine took the lane over: the caller must stop writing (close without a final save). */
	get lost(): boolean {
		return this.#lost;
	}

	status(): RemoteStatus {
		return this.#status;
	}

	/**
	 * Before the store opens: takes the lock and brings memory.sqlite up to the remote's newest save. This machine's
	 * unsaved changes go up first when nobody saved since; otherwise they are kept aside in unsaved-<time>.json.
	 */
	static async checkOut(o: RemoteSessionOptions): Promise<RemoteSession> {
		const { storage, lane } = o;
		// A lane that was never pushed: say so instead of creating an empty lane on the remote. Asking for saves past
		// the largest number every kind accepts returns nothing for a lane that exists.
		await storage.fetch(lane, MAX_REMOTE_NUMBER).catch((error: unknown) => {
			if (error instanceof RemoteError && error.kind === "not-found") {
				throw new RemoteError("not-found", `${lane} is not on remote ${storage.name} yet: run orrery lane push ${lane} --to ${storage.name}`);
			}
			throw error;
		});
		const { lock, takeoverFrom } = await take(o);
		try {
			const pending = pendingTakeover(o.laneDir);
			const takeover = { from: takeoverFrom ?? pending };
			const position = await bringUpToDate(o, lock, takeover);
			const settled = settleAfterCheckOut(o);
			const session = new RemoteSession(o, lock, position, takeover.from);
			session.#instructions = settled?.hash;
			session.#instructionsSent = settled?.sent;
			writeState(o.laneDir, session.#state());
			if (pending !== undefined) rmSync(join(o.laneDir, TAKEOVER_FILE));
			OPEN_HERE.add(openKey(storage, lane));
			return session;
		} catch (error) {
			await storage.release(lane, lock).catch(() => {});
			throw error;
		}
	}

	/**
	 * First push of a local lane: take (creates the lane), snapshot 0 of the current database, release. A lane left on
	 * the remote by a push that failed before its snapshot (no snapshot, no saves) is taken over by the next push.
	 */
	static async push(o: Omit<RemoteSessionOptions, "confirmTakeover">): Promise<void> {
		const { storage, lane } = o;
		if ((await storage.list()).some((entry) => entry.lane === lane)) {
			const empty = await storage.fetch(lane, -1).then((f) => f.snapshot === undefined && f.newestSave === 0, () => false);
			if (!empty) throw new RemoteError("refused", `${lane} is already on remote ${storage.name}; use orrery lane pull`);
		}
		const dbPath = join(o.laneDir, DB_FILE);
		let store: MemoryStore;
		try {
			store = MemoryStore.open(dbPath, o.writer);
		} catch (error) {
			if (/already open/i.test(String(error))) throw new RemoteError("held", `${lane} is open on this machine; close it first`);
			throw error;
		}
		try {
			// A push starts a new history: its own identity, and nothing this folder agreed on before.
			store.setMeta(HISTORY_KEY, newHistoryId());
			forget(o);
			// A first push sends this machine's instructions.md as the agent's (none when there is no file).
			let instructions: string | undefined;
			try {
				instructions = pushInstructions(store, o.laneDir, lane, (message) => guarded(() => o.report(message)));
			} catch (error) {
				throw new Error(`${lane}'s instructions.md can't be read (${error instanceof Error ? error.message : String(error)}); fix or remove it, then push again.`, { cause: error });
			}
			const taken = await storage.take(lane, o.holder, { force: true });
			if (!taken.ok) throw new RemoteError("held", heldMessage(lane, taken.held));
			let pushed = false;
			try {
				const marks = store.marks();
				const now = (o.now ?? Date.now)();
				const plain = encodeSnapshot({ v: 1, n: 0, lock: taken.lock, machine: o.holder.machine, at: new Date(now).toISOString(), settings: o.settings }, snapshotBytes(dbPath));
				const sealed = seal(o.key, lane, "snapshot", 0, plain);
				await storage.snapshot(lane, taken.lock, 0, sealed);
				pushed = true;
				writeState(o.laneDir, { v: 1, remote: storage.name, lock: taken.lock, save: 0, sha256: "", marks, snapshotAt: 0, snapshotSha: sha256(sealed), bytesSinceSnapshot: 0 });
				try {
					if (instructions !== undefined) agreeOn(o.laneDir, instructions);
				} catch {
					// The next check-out finds the file and the remote equal, and agrees then.
				}
			} finally {
				// A lane without its first snapshot can't be opened anywhere: take it off the remote again.
				if (!pushed) await storage.drop(lane, taken.lock).catch(() => {});
				else await storage.release(lane, taken.lock).catch(() => {});
			}
		} finally {
			store.close();
		}
	}

	/** Called with the lane's open store. Renews at once (a long fetch may have used part of the stale time), then every minute. */
	attach(store: MemoryStore): void {
		this.#store = store;
		// A history pushed by an older build has no identity yet: its first writer gives it one, with its next save.
		try {
			if (store.getMeta(HISTORY_KEY) === undefined) store.setMeta(HISTORY_KEY, newHistoryId());
		} catch {
			// Tried again at the next attach.
		}
		void this.renew();
		const every = this.#o.renewMs ?? RENEW_MS;
		if (every > 0) {
			this.#timer = setInterval(() => {
				this.renew()
					.then(() => this.save())
					.catch(() => {});
			}, every);
			this.#timer.unref?.();
		}
	}

	/** After each finished turn and from the renewal timer. Never throws. */
	save(): Promise<void> {
		const run = this.#chain.then(() => this.#saveNow());
		this.#chain = run.catch(() => {});
		return this.#chain;
	}

	/** Never throws. */
	async renew(): Promise<void> {
		if (this.#lost || this.#closing || this.#closed) return;
		try {
			await this.#o.storage.renew(this.#o.lane, this.#lock);
		} catch (error) {
			// A renewal still in flight when close() released the lock is not a takeover.
			if (this.#closing || this.#closed) return;
			await this.#failed(error).catch(() => {});
		}
	}

	/** Final save, release, stop the timer. Never throws. Call before the store closes. */
	async close(): Promise<void> {
		if (this.#closing || this.#closed) return;
		this.#closing = true;
		if (this.#timer !== undefined) clearInterval(this.#timer);
		this.#timer = undefined;
		try {
			if (!this.#lost) {
				this.#instructionsIntoStore();
				await this.save();
				if (!this.#lost) {
					try {
						await this.#o.storage.release(this.#o.lane, this.#lock);
					} catch (error) {
						guarded(() => this.#o.report(`Orrery: ${this.#o.lane}: releasing its lock on ${this.#o.storage.name} failed (${reasonOf(error)}); it frees itself in 3 minutes.`));
					}
				}
			}
		} finally {
			this.#closed = true;
			this.#store = undefined;
			OPEN_HERE.delete(openKey(this.#o.storage, this.#o.lane));
		}
	}

	/** This session's own edit of instructions.md goes up with its last save; when that fails, the next check-out compares again. */
	#instructionsIntoStore(): void {
		const store = this.#store;
		const settled = this.#instructions;
		if (store === undefined || settled === undefined) return;
		try {
			const sent = instructionsIntoStore(store, this.#o.laneDir, settled, this.#o.lane, (message) => guarded(() => this.#o.report(message)));
			if (sent !== undefined) this.#instructionsSent = sent;
		} catch {
			// The file stays as it is; the next check-out compares it again.
		}
	}

	/** This machine's instructions, in a save the remote has acknowledged: the file and the remote agree on them now. */
	#agreeSent(): void {
		const sent = this.#instructionsSent;
		if (sent === undefined || this.#marks.meta[INSTRUCTIONS_KEY] !== sent) return;
		this.#instructionsSent = undefined;
		try {
			agreeOn(this.#o.laneDir, sent);
		} catch {
			// The next check-out finds the file and the remote equal, and agrees then.
		}
	}

	/** The state to write; a snapshot not yet acknowledged is always recorded, so a lost reply is recognised later. */
	#state(inflight?: Inflight): SessionState {
		const snapshotPending = this.#pendingSnapshot === undefined ? undefined : { n: this.#pendingSnapshot.n, sha256: this.#pendingSnapshot.sha256 };
		return {
			v: 1,
			remote: this.#o.storage.name,
			lock: this.#lock,
			save: this.#save,
			sha256: this.#sha,
			marks: this.#marks,
			snapshotAt: this.#snapshotAt,
			snapshotSha: this.#snapshotSha,
			bytesSinceSnapshot: this.#bytesSinceSnapshot,
			...(inflight === undefined ? {} : { inflight }),
			...(snapshotPending === undefined ? {} : { snapshotPending }),
		};
	}

	async #saveNow(): Promise<void> {
		const store = this.#store;
		if (this.#lost || this.#closed || store === undefined) return;
		const { storage, lane, key, holder } = this.#o;
		try {
			if (this.#unacked === undefined) {
				const changed = store.rowsAfter(this.#marks, LOCAL_META_KEYS);
				if (changed === undefined) {
					if (this.#status.state !== "saved") this.#status = { remote: storage.name, state: "saved", savedAt: hhmm(this.#now()) };
					await this.#uploadSnapshot();
					return;
				}
				const n = this.#save + 1;
				const body = encodeRows(changed.rows);
				const at = new Date(this.#now()).toISOString();
				const fields: Omit<SaveHeader, "v" | "sha256" | "rows"> = { n, lock: this.#lock, machine: holder.machine, device: holder.device, at, ...(this.#takeoverFrom === undefined ? {} : { takeover: { from: this.#takeoverFrom } }) };
				const header = makeHeader(fields, changed.rows, body);
				const file = seal(key, lane, "save", n, body);
				// The snapshot must hold exactly the rows of saves 1..n: read it now, with no await since rowsAfter, so a
				// row written during the upload can't land in both this snapshot and save n+1. A snapshot still waiting to
				// upload is retried instead of reading a new one; a snapshot that can't be read never holds the save back.
				const due = this.#pendingSnapshot === undefined && (n - this.#snapshotAt >= SNAPSHOT_EVERY_SAVES || this.#bytesSinceSnapshot + file.length >= SNAPSHOT_EVERY_BYTES);
				let snapshot: Uint8Array | undefined;
				if (due) {
					try {
						snapshot = encodeSnapshot({ v: 1, n, lock: this.#lock, machine: holder.machine, at, settings: this.#o.settings }, snapshotBytes(this.#dbPath));
					} catch {
						snapshot = undefined;
					}
				}
				this.#unacked = { n, file, logEntry: seal(key, lane, "log", n, Buffer.from(JSON.stringify(header))), next: changed.next, sha256: header.sha256, ...(snapshot === undefined ? {} : { snapshot }) };
			}
			const pending = this.#unacked;
			// Written before sending: if the reply is lost and this session ends, the next check-out can tell whether
			// the remote has this save (adopt it) or not (send it again).
			writeState(this.#o.laneDir, this.#state({ n: pending.n, sha256: pending.sha256, marks: pending.next }));
			await storage.save(lane, this.#lock, pending.n, pending.file, pending.logEntry);
			this.#unacked = undefined;
			this.#takeoverFrom = undefined;
			this.#save = pending.n;
			this.#sha = pending.sha256;
			this.#marks = pending.next;
			this.#agreeSent();
			this.#bytesSinceSnapshot += pending.file.length;
			writeState(this.#o.laneDir, this.#state());
			this.#status = { remote: storage.name, state: "saved", savedAt: hhmm(this.#now()) };
			if (pending.snapshot !== undefined) {
				const sealed = seal(key, lane, "snapshot", pending.n, pending.snapshot);
				this.#pendingSnapshot = { n: pending.n, sealed, sha256: sha256(sealed) };
			}
			await this.#uploadSnapshot();
		} catch (error) {
			await this.#failed(error).catch(() => {});
		}
	}

	async #uploadSnapshot(): Promise<void> {
		const snapshot = this.#pendingSnapshot;
		if (snapshot === undefined || this.#lost) return;
		const { storage, lane } = this.#o;
		try {
			// Recorded before sending: if the reply is lost, the next check-out recognises this snapshot by its checksum.
			writeState(this.#o.laneDir, this.#state());
			await storage.snapshot(lane, this.#lock, snapshot.n, snapshot.sealed);
			this.#pendingSnapshot = undefined;
			this.#snapshotAt = snapshot.n;
			this.#snapshotSha = snapshot.sha256;
			if (snapshot.n === this.#save) this.#bytesSinceSnapshot = 0;
			writeState(this.#o.laneDir, this.#state());
		} catch (error) {
			// A missed snapshot costs only a longer catch-up later; it is retried after the next save.
			if (error instanceof RemoteError && error.kind === "lock-lost") await this.#failed(error);
		}
	}

	async #failed(error: unknown): Promise<void> {
		const { storage, lane } = this.#o;
		if (error instanceof RemoteError && (error.kind === "lock-lost" || error.kind === "out-of-order")) {
			if (this.#lost) return;
			this.#lost = true;
			if (this.#timer !== undefined) clearInterval(this.#timer);
			this.#timer = undefined;
			let movedTo = "another machine";
			try {
				const entry = (await storage.list()).find((e) => e.lane === lane);
				if (entry?.lock?.held === true) movedTo = entry.lock.holder.machine;
			} catch {
				// keep "another machine"
			}
			this.#status = { remote: storage.name, state: "lost", movedTo };
			OPEN_HERE.delete(openKey(storage, lane));
			guarded(() => this.#o.report(`Orrery: ${lane} moved to ${movedTo}; this session runs without memory now.`));
			guarded(() => this.#o.onLost?.());
			return;
		}
		this.#status = { remote: storage.name, state: "failing", reason: reasonOf(error), ...(this.#status.savedAt === undefined ? {} : { savedAt: this.#status.savedAt }) };
	}
}

/**
 * Takes the lock. Another machine's stale lock is taken over only after a yes. This machine's own lock is retaken
 * without asking when it is stale or its process is gone (a crash, a reboot, a release that failed offline); the
 * machine name must match too, so a cloned device id never takes a live session silently.
 */
async function take(o: RemoteSessionOptions): Promise<{ lock: number; takeoverFrom?: string }> {
	const { storage, lane, holder } = o;
	const first = await storage.take(lane, holder);
	if (first.ok) return { lock: first.lock };
	const held = first.held;
	const sameMachine = held.holder.device === holder.device && held.holder.machine === holder.machine;
	let force = false;
	if (sameMachine) force = held.stale || (held.holder.pid === process.pid ? !OPEN_HERE.has(openKey(storage, lane)) : !processAlive(held.holder.pid));
	else if (held.stale && o.confirmTakeover !== undefined) force = await o.confirmTakeover(held);
	if (!force) throw new RemoteError("held", sameMachine ? `${lane} is open in another pi or Claude Code on this machine (last seen ${hhmm(held.lastSeen)})` : heldMessage(lane, held));
	const second = await storage.take(lane, holder, { force: true });
	if (!second.ok) throw new RemoteError("held", heldMessage(lane, second.held));
	return sameMachine ? { lock: second.lock } : { lock: second.lock, takeoverFrom: held.holder.machine };
}

function positionOf(state: SessionState): Position {
	return { save: state.save, sha256: state.sha256, marks: state.marks, snapshotAt: state.snapshotAt, snapshotSha: state.snapshotSha, bytesSinceSnapshot: state.bytesSinceSnapshot };
}

/**
 * instructions.md against the store's copy, now that the store is the remote's newest (src/remote/instructions-sync.ts).
 * A failure is said and changes nothing: the memory opens as usual.
 */
function settleAfterCheckOut(o: RemoteSessionOptions): SettledInstructions | undefined {
	try {
		const store = MemoryStore.open(join(o.laneDir, DB_FILE), o.writer);
		try {
			return settleInstructions(store, o.laneDir, o.lane, (o.now ?? Date.now)(), (message) => guarded(() => o.report(message)));
		} finally {
			store.close();
		}
	} catch (error) {
		guarded(() => o.report(`Orrery: ${o.lane}'s instructions could not be brought up to date (${error instanceof Error ? error.message : String(error)}); its memory opens as usual.`));
		return undefined;
	}
}

/** Fetch and apply, keeping this machine's unsaved rows: pushed when nobody saved since, else kept aside. */
async function bringUpToDate(o: RemoteSessionOptions, lock: number, takeover: { from?: string }): Promise<Position> {
	const { storage, lane, laneDir, key } = o;
	const now = o.now ?? Date.now;
	const dbPath = join(laneDir, DB_FILE);
	let state = readState(laneDir, storage.name);

	if (state === undefined) {
		// No state for this remote: whatever this folder agreed on before belongs to another history.
		forget(o);
		setAsideLocalMemory(o, dbPath, now());
		return rebuild(o, await storage.fetch(lane, -1));
	}

	// A save whose reply was lost: adopt it when the remote has it with the same body.
	if (state.inflight !== undefined) {
		const inflight = state.inflight;
		const after = await storage.fetch(lane, state.save);
		const next = after.snapshot === undefined ? after.saves[0] : undefined;
		let adopted = false;
		if (next !== undefined && next.n === inflight.n) {
			try {
				adopted = sha256(unseal(key, lane, "save", next.n, next.file)) === inflight.sha256;
			} catch {
				adopted = false;
			}
		}
		// The save holds this machine's own rows: instructions it changed are on the remote now.
		if (adopted) agreeOnOwnRows(laneDir, state.marks, inflight.marks);
		state = adopted
			? { ...state, save: inflight.n, sha256: inflight.sha256, marks: inflight.marks, bytesSinceSnapshot: state.bytesSinceSnapshot + (next?.file.length ?? 0), inflight: undefined }
			: { ...state, inflight: undefined };
		writeState(laneDir, state);
	}

	// A snapshot whose reply was lost: if the remote has it (same sealed bytes), this working copy matches it.
	if (state.snapshotPending !== undefined) {
		const sent = state.snapshotPending;
		const probe = await storage.fetch(lane, sent.n - 1);
		const landed = probe.snapshot !== undefined && probe.snapshot.n === sent.n && sha256(probe.snapshot.file) === sent.sha256;
		state = landed ? { ...state, snapshotAt: sent.n, snapshotSha: sent.sha256, bytesSinceSnapshot: sent.n === state.save ? 0 : state.bytesSinceSnapshot, snapshotPending: undefined } : { ...state, snapshotPending: undefined };
		writeState(laneDir, state);
	}

	// Unsaved rows of this working copy (a session closed while offline, or one that crashed).
	let pending: StoreRows | undefined;
	if (existsSync(dbPath)) {
		const store = MemoryStore.open(dbPath, o.writer);
		try {
			pending = store.rowsAfter(state.marks, LOCAL_META_KEYS)?.rows;
		} finally {
			store.close();
		}
	}

	const fetched = await storage.fetch(lane, state.save - 1);
	const intact = lineageIntact(o, state, fetched);
	const nobodySavedSince = fetched.newestSave === state.save;

	if (intact && nobodySavedSince) {
		if (pending === undefined) return positionOf(state);
		return pushPending(o, lock, state, dbPath, now(), takeover);
	}

	if (intact && pending === undefined) {
		// Catch up: a newer snapshot means a rebuild; otherwise apply the saves after ours.
		if (fetched.snapshot !== undefined && fetched.snapshot.n > state.save) return rebuild(o, fetched, { state, continues: true, now: now() });
		return catchUp(o, state, fetched, dbPath);
	}

	// The remote's newest replaces this working copy: its unsaved rows are kept aside, or all of its memory when the
	// remote holds another history.
	return rebuild(o, await storage.fetch(lane, -1), { state, continues: intact, pending, now: now() });
}

/** What a rebuild over an existing working copy knows of it, to keep what the remote's copy does not hold. */
interface Rebuilding {
	readonly state: SessionState;
	/** The remote's history continues this working copy's last save (lineageIntact). */
	readonly continues: boolean;
	/** This working copy's rows the remote does not have. */
	readonly pending?: StoreRows;
	readonly now: number;
}

/**
 * Before the remote's copy replaces this one: another history (an identity other than the one recorded, or, with none
 * recorded, a remote that does not continue this copy) keeps all of this machine's memory aside, as foreign, and forgets
 * the instructions agreement made with the old history. Within one history, only unsaved rows are kept (spec §5.9).
 */
function keepBeforeRebuild(o: RemoteSessionOptions, known: Rebuilding, remoteMarks: StoreMarks, dbPath: string): void {
	const { lane, storage } = o;
	const recorded = known.state.marks.meta[HISTORY_KEY];
	const another = recorded !== undefined && remoteMarks.meta[HISTORY_KEY] !== recorded;
	if (another || (recorded === undefined && !known.continues)) {
		forget(o);
		const why = another
			? `${storage.name} holds another history of it now (pushed there again, or a replaced remote)`
			: `${storage.name}'s copy does not continue the one on this machine`;
		setAsideLocalMemory(o, dbPath, known.now, (aside) => `Orrery: ${lane}: ${why}; the memory on this machine was kept aside as ${aside}, and the lane now uses ${storage.name}'s copy.`);
		return;
	}
	// A history identity given at an attach whose save never landed is not worth keeping: the remote has its own.
	const { [HISTORY_KEY]: _id, ...meta } = known.pending?.meta ?? {};
	const pending = known.pending === undefined ? undefined : { ...known.pending, meta };
	if (pending === undefined || (pending.main.length === 0 && pending.tree.length === 0 && pending.usage.length === 0 && Object.keys(pending.meta).length === 0)) return;
	// Two histories: the remote's wins; this machine's rows are kept, not merged (spec §5.9).
	const file = join(o.laneDir, `unsaved-${stamp(known.now)}.json`);
	writePrivate(file, `${JSON.stringify(pending)}\n`);
	guarded(() => o.report(`Orrery: ${lane} was saved from another machine since this one last saved. This machine's unsaved turns are kept in ${file}; the lane continues from ${storage.name}'s copy.`));
}

/** Forgets the instructions agreement; a failure is said, and the check-out or push goes on. */
function forget(o: Pick<RemoteSessionOptions, "lane" | "laneDir" | "report">): void {
	try {
		forgetAgreement(o.laneDir);
	} catch (error) {
		guarded(() => o.report(`Orrery: ${o.lane}: ${SYNCED_FILE} could not be removed (${error instanceof Error ? error.message : String(error)}); remove it by hand, or its instructions may be compared with another history's.`));
	}
}

/** Sends this machine's unsaved rows as the next save, under the new lock, before the store opens (spec §5.9). */
async function pushPending(o: RemoteSessionOptions, lock: number, state: SessionState, dbPath: string, now: number, takeover: { from?: string }): Promise<Position> {
	const { storage, lane, laneDir, key, holder } = o;
	const store = MemoryStore.open(dbPath, o.writer);
	try {
		const changed = store.rowsAfter(state.marks, LOCAL_META_KEYS);
		if (changed === undefined) return positionOf(state);
		const n = state.save + 1;
		const body = encodeRows(changed.rows);
		const header = makeHeader({ n, lock, machine: holder.machine, device: holder.device, at: new Date(now).toISOString(), ...(takeover.from === undefined ? {} : { takeover: { from: takeover.from } }) }, changed.rows, body);
		const file = seal(key, lane, "save", n, body);
		writeState(laneDir, { ...state, lock, inflight: { n, sha256: header.sha256, marks: changed.next } });
		await storage.save(lane, lock, n, file, seal(key, lane, "log", n, Buffer.from(JSON.stringify(header))));
		// These are this machine's own rows: instructions they changed are on the remote now, before the file is settled.
		agreeOnOwnRows(laneDir, state.marks, changed.next);
		takeover.from = undefined; // This checkout's first save may be the locally pending rows sent above.
		return { ...positionOf(state), save: n, sha256: header.sha256, marks: changed.next, bytesSinceSnapshot: state.bytesSinceSnapshot + file.length };
	} finally {
		store.close();
	}
}

/** Applies the saves after this working copy's last one. Everything is decrypted and checked before anything is applied. */
function catchUp(o: RemoteSessionOptions, state: SessionState, fetched: FetchResult, dbPath: string): Position {
	const { lane, key } = o;
	const saves = fetched.saves.filter((save) => save.n > state.save);
	const decoded = saves.map((save, i) => {
		if (save.n !== state.save + 1 + i) throw new RemoteError("corrupt", `${lane}: save ${state.save + 1 + i} is missing on remote ${o.storage.name}`);
		const body = unseal(key, lane, "save", save.n, save.file);
		return { n: save.n, body, rows: decodeRows(body), bytes: save.file.length };
	});
	const end = decoded.at(-1)?.n ?? state.save;
	if (end !== fetched.newestSave) throw new RemoteError("corrupt", `${lane}: remote ${o.storage.name} sent saves up to ${end} of ${fetched.newestSave}`);
	if (decoded.length === 0) return positionOf(state);
	const store = MemoryStore.open(dbPath, o.writer);
	try {
		for (const save of decoded) store.applyRows(save.rows);
		const last = decoded[decoded.length - 1];
		return {
			...positionOf(state),
			save: last.n,
			sha256: sha256(last.body),
			marks: store.marks(),
			bytesSinceSnapshot: state.bytesSinceSnapshot + decoded.reduce((sum, save) => sum + save.bytes, 0),
		};
	} finally {
		store.close();
	}
}

/** Whether the remote still holds this working copy's last save (same body) or the very snapshot it matches. */
function lineageIntact(o: RemoteSessionOptions, state: SessionState, fetched: FetchResult): boolean {
	if (fetched.newestSave < state.save) return false;
	if (fetched.snapshot !== undefined) {
		if (fetched.snapshot.n === state.save) return state.snapshotSha !== "" && sha256(fetched.snapshot.file) === state.snapshotSha;
		return fetched.snapshot.n > state.save; // the snapshot covers our last save; the remote is the truth either way
	}
	const ours = fetched.saves[0];
	if (ours === undefined || ours.n !== state.save) return false;
	try {
		return sha256(unseal(o.key, o.lane, "save", ours.n, ours.file)) === state.sha256;
	} catch {
		return false;
	}
}

/** Memory already here that never synced is copied aside (WAL included), never overwritten. */
function setAsideLocalMemory(o: RemoteSessionOptions, dbPath: string, now: number, notice?: (aside: string) => string): void {
	if (!existsSync(dbPath)) return;
	const store = MemoryStore.open(dbPath, o.writer);
	const hasRows = store.root.length > 0 || store.nodeCount > 0;
	store.close();
	if (!hasRows) return;
	const aside = join(o.laneDir, `memory-before-remote-${stamp(now)}.sqlite`);
	o.writer?.check(dbPath);
	const release = o.writer === undefined ? holdWriterLock(dbPath) : () => {};
	try {
		closeSync(openSync(aside, "wx", 0o600));
		const db = openDatabase(dbPath, { readOnly: true });
		try {
			vacuumInto(db, aside);
		} finally {
			db.close();
		}
		for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
	} finally {
		release();
	}
	guarded(() => o.report(notice?.(aside) ?? `Orrery: ${o.lane}: the memory already on this machine was kept aside as ${aside}; the lane now uses ${o.storage.name}'s copy.`));
}

/** This machine's local meta values (projector cursor, session cursors), carried across a rebuild. */
function localMeta(dbPath: string): Record<string, string> {
	if (!existsSync(dbPath)) return {};
	const db = openDatabase(dbPath, { readOnly: true });
	try {
		const rows = db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[];
		return Object.fromEntries(rows.filter((row) => isLocalKey(row.key)).map((row) => [row.key, row.value]));
	} catch {
		return {};
	} finally {
		db.close();
	}
}

/**
 * Replaces the working copy with the remote's newest snapshot plus the saves after it. Everything is decrypted and
 * checked first; the new copy is built in a temporary file and renamed into place, so a crash midway leaves the old one.
 */
function rebuild(o: RemoteSessionOptions, fetched: FetchResult, known?: Rebuilding): Position {
	const { lane, laneDir, key } = o;
	const dbPath = join(laneDir, DB_FILE);
	const remote = o.storage.name;
	if (fetched.snapshot === undefined) throw new RemoteError("corrupt", `${lane} has no snapshot on remote ${remote}`);
	const snapshotFile = fetched.snapshot;
	const snapshot = decodeSnapshot(unseal(key, lane, "snapshot", snapshotFile.n, snapshotFile.file));
	if (snapshot.header.n !== snapshotFile.n) throw new RemoteError("corrupt", `${lane}: snapshot ${snapshotFile.n} on remote ${remote} says it is ${snapshot.header.n}`);
	const saves = fetched.saves.map((save, i) => {
		if (save.n !== snapshotFile.n + 1 + i) throw new RemoteError("corrupt", `${lane}: save ${snapshotFile.n + 1 + i} is missing on remote ${remote}`);
		const body = unseal(key, lane, "save", save.n, save.file);
		return { n: save.n, body, rows: decodeRows(body), bytes: save.file.length };
	});
	const end = saves.at(-1)?.n ?? snapshotFile.n;
	if (end !== fetched.newestSave) throw new RemoteError("corrupt", `${lane}: remote ${remote} sent saves up to ${end} of ${fetched.newestSave}`);

	const local = localMeta(dbPath);
	const temp = join(laneDir, `.rebuild-${process.pid}-${randomBytes(8).toString("hex")}.sqlite`);
	try {
		restoreSnapshot(temp, snapshot.db);
		let marks: StoreMarks;
		const store = MemoryStore.open(temp);
		try {
			for (const save of saves) store.applyRows(save.rows);
			for (const [k, v] of Object.entries(local)) store.setMeta(k, v);
			marks = store.marks();
		} finally {
			store.close();
		}
		assertWrittenThrough(temp);
		if (known !== undefined) keepBeforeRebuild(o, known, marks, dbPath);
		o.writer?.check(dbPath);
		const release = o.writer === undefined ? holdWriterLock(dbPath) : () => {};
		try {
			rmSync(`${dbPath}-wal`, { force: true });
			rmSync(`${dbPath}-shm`, { force: true });
			renameSync(temp, dbPath);
		} finally {
			release();
		}
		const last = saves.at(-1);
		return {
			save: last?.n ?? snapshotFile.n,
			sha256: last === undefined ? "" : sha256(last.body),
			marks,
			snapshotAt: snapshotFile.n,
			snapshotSha: sha256(snapshotFile.file),
			bytesSinceSnapshot: saves.reduce((sum, save) => sum + save.bytes, 0),
		};
	} finally {
		for (const suffix of ["", "-wal", "-shm", ".lock", ".lock-journal"]) rmSync(`${temp}${suffix}`, { force: true });
	}
}
