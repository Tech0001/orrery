/** Remote lanes (spec 2026-10-12-remote-lanes-design): what every remote kind stores and how its lock behaves. */

/** Who holds a lane: the machine's name (for people), its device id (to tell machines apart), and the process. */
export interface Holder {
	readonly machine: string;
	readonly device: string;
	readonly pid: number;
}

export interface LockState {
	readonly holder: Holder;
	/** Raised by one on every take; never reused, even after a release. */
	readonly lock: number;
	/** The remote's clock, ms since the epoch. */
	readonly lastSeen: number;
	readonly stale: boolean;
	/** False after a release: the record keeps the last lock number. */
	readonly held: boolean;
}

export type TakeResult =
	| { readonly ok: true; readonly lock: number; readonly newestSave: number }
	| { readonly ok: false; readonly held: LockState };

export interface RemoteFile {
	readonly n: number;
	readonly file: Uint8Array;
}

export interface FetchResult {
	/** The newest snapshot, when it covers more than `after`. */
	readonly snapshot?: RemoteFile;
	/** Saves after the snapshot (or after `after`), in order. */
	readonly saves: readonly RemoteFile[];
	readonly newestSave: number;
}

export interface LaneEntry {
	readonly lane: string;
	readonly newestSave: number;
	readonly lock?: LockState;
}

export type RemoteErrorKind =
	| "held" // another holder has a fresh lock
	| "lock-lost" // the lock number is no longer current (taken over)
	| "out-of-order" // save n is not the next number (and not an identical retry)
	| "unreachable" // network, DNS, SSH connect, timeout
	| "auth" // SSH auth, bad token
	| "quota" // Cloudflare free-plan daily cap
	| "corrupt" // decryption or format failure
	| "key-missing" // no key for this remote on this machine
	| "not-found" // no such lane on the remote
	| "refused"; // anything else the remote refused, with its message

export class RemoteError extends Error {
	readonly kind: RemoteErrorKind;
	constructor(kind: RemoteErrorKind, message: string) {
		super(message);
		this.name = "RemoteError";
		this.kind = kind;
	}
}

export interface Storage {
	/** The remote's name in the config. */
	readonly name: string;
	/** Take the lane's lock. Creates the lane on first take. `force` takes a stale lock, or one held by `holder.device`. */
	take(lane: string, holder: Holder, options?: { force?: boolean }): Promise<TakeResult>;
	/** Refresh lastSeen. Throws RemoteError("lock-lost") unless `lock` is current. */
	renew(lane: string, lock: number): Promise<void>;
	/** Free the lock. No-op when `lock` is not current. */
	release(lane: string, lock: number): Promise<void>;
	/** Store save `n` and its log entry. `n` must be newestSave + 1, or an identical retry of newestSave. */
	save(lane: string, lock: number, n: number, file: Uint8Array, logEntry: Uint8Array): Promise<void>;
	/** Store a snapshot covering saves 1..n (n may be 0 for a first push), then prune (keep 3 snapshots). */
	snapshot(lane: string, lock: number, n: number, file: Uint8Array): Promise<void>;
	/** No lock needed. Throws RemoteError("not-found") for an unknown lane. */
	fetch(lane: string, after: number): Promise<FetchResult>;
	list(): Promise<LaneEntry[]>;
	/** Every log entry, in order (never pruned). */
	log(lane: string): Promise<RemoteFile[]>;
	/** The remote's key check: an encrypted known value written once, so a recovery code can be verified. */
	getCheck(): Promise<Uint8Array | undefined>;
	putCheck(file: Uint8Array): Promise<void>;
	/** Delete a lane (orrery lane local --delete-remote). Requires the current lock. */
	drop(lane: string, lock: number): Promise<void>;
}

/** What a lane's footer and the TUI show about its remote. */
export interface RemoteStatus {
	readonly remote: string;
	/** saved: everything is up; pending: changes wait for the next save; failing: saves fail (reason); lost: taken over. */
	readonly state: "saved" | "pending" | "failing" | "lost";
	/** Local time of the last successful save, HH:MM. */
	readonly savedAt?: string;
	readonly reason?: string;
	/** For "lost": the machine that took over. */
	readonly movedTo?: string;
}

/** The largest save or lock number every kind accepts (the server kind keeps its shell arithmetic in 64 bits). */
export const MAX_REMOTE_NUMBER = 999_999_999_999_999;
export const RENEW_MS = 60_000;
export const STALE_MS = 180_000;
export const SNAPSHOT_EVERY_SAVES = 200;
export const SNAPSHOT_EVERY_BYTES = 5 * 1024 * 1024;
export const KEEP_SNAPSHOTS = 3;
export const CALL_TIMEOUT_MS = 15_000;
export function sizedTimeoutMs(bytes: number): number {
	return CALL_TIMEOUT_MS + Math.ceil(bytes / (1024 * 1024)) * 1000;
}
