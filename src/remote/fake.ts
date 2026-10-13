/** An in-memory Storage with an injectable clock: the reference for what every remote kind must do (test/remote/contract.ts). */

import { isDeepStrictEqual } from "node:util";
import { type FetchResult, type Holder, KEEP_SNAPSHOTS, type LaneEntry, type LockState, RemoteError, type RemoteFile, STALE_MS, type Storage, type TakeResult } from "./types.ts";

interface Lane {
	lock: number;
	holder?: Holder;
	held: boolean;
	lastSeen: number;
	saves: Map<number, Uint8Array>;
	logs: Map<number, Uint8Array>;
	snapshots: Map<number, Uint8Array>;
	newestSave: number;
}

export interface FakeStorageOptions {
	readonly name?: string;
	readonly now?: () => number;
	readonly staleMs?: number;
}

export class FakeStorage implements Storage {
	readonly name: string;
	readonly #now: () => number;
	readonly #staleMs: number;
	readonly #lanes = new Map<string, Lane>();
	/** Lock numbers of dropped lanes: a lane created again continues from here, so an old lock can never match. */
	readonly #dropped = new Map<string, number>();
	#check: Uint8Array | undefined;

	constructor(options: FakeStorageOptions = {}) {
		this.name = options.name ?? "fake";
		this.#now = options.now ?? Date.now;
		this.#staleMs = options.staleMs ?? STALE_MS;
	}

	#state(lane: Lane): LockState | undefined {
		if (lane.holder === undefined) return undefined;
		return { holder: lane.holder, lock: lane.lock, lastSeen: lane.lastSeen, held: lane.held, stale: lane.held && this.#now() - lane.lastSeen > this.#staleMs };
	}

	#current(name: string, lock: number): Lane {
		const lane = this.#lanes.get(name);
		if (lane === undefined || !lane.held || lane.lock !== lock) throw new RemoteError("lock-lost", `${name}: lock ${lock} is no longer current`);
		return lane;
	}

	async take(name: string, holder: Holder, options: { force?: boolean } = {}): Promise<TakeResult> {
		let lane = this.#lanes.get(name);
		if (lane === undefined) {
			lane = { lock: this.#dropped.get(name) ?? 0, held: false, lastSeen: 0, saves: new Map(), logs: new Map(), snapshots: new Map(), newestSave: 0 };
			this.#lanes.set(name, lane);
		}
		const state = this.#state(lane);
		if (state !== undefined && state.held) {
			const mine = state.holder.device === holder.device;
			if (!(options.force === true && (state.stale || mine))) return { ok: false, held: state };
		}
		lane.lock += 1;
		lane.holder = holder;
		lane.held = true;
		lane.lastSeen = this.#now();
		return { ok: true, lock: lane.lock, newestSave: lane.newestSave };
	}

	async renew(name: string, lock: number): Promise<void> {
		this.#current(name, lock).lastSeen = this.#now();
	}

	async release(name: string, lock: number): Promise<void> {
		const lane = this.#lanes.get(name);
		if (lane !== undefined && lane.held && lane.lock === lock) lane.held = false;
	}

	async save(name: string, lock: number, n: number, file: Uint8Array, logEntry: Uint8Array): Promise<void> {
		const lane = this.#current(name, lock);
		if (n === lane.newestSave && n > 0 && isDeepStrictEqual(lane.saves.get(n), file) && isDeepStrictEqual(lane.logs.get(n), logEntry)) return;
		if (n !== lane.newestSave + 1) throw new RemoteError("out-of-order", `${name}: save ${n} is not next (newest is ${lane.newestSave})`);
		lane.saves.set(n, file.slice());
		lane.logs.set(n, logEntry.slice());
		lane.newestSave = n;
		lane.lastSeen = this.#now();
	}

	async snapshot(name: string, lock: number, n: number, file: Uint8Array): Promise<void> {
		const lane = this.#current(name, lock);
		if (n < 0 || n > lane.newestSave) throw new RemoteError("out-of-order", `${name}: snapshot ${n} is past the newest save ${lane.newestSave}`);
		lane.snapshots.set(n, file.slice());
		const kept = [...lane.snapshots.keys()].sort((a, b) => b - a).slice(0, KEEP_SNAPSHOTS);
		for (const key of lane.snapshots.keys()) if (!kept.includes(key)) lane.snapshots.delete(key);
		const oldest = Math.min(...kept);
		for (const key of lane.saves.keys()) if (key <= oldest) lane.saves.delete(key);
		lane.lastSeen = this.#now();
	}

	async fetch(name: string, after: number): Promise<FetchResult> {
		const lane = this.#lanes.get(name);
		if (lane === undefined) throw new RemoteError("not-found", `No lane ${name} on remote ${this.name}`);
		const newest = Math.max(-1, ...lane.snapshots.keys());
		const file = (n: number, bytes: Uint8Array): RemoteFile => ({ n, file: bytes.slice() });
		const from = newest > after ? newest : after;
		const saves = [...lane.saves.entries()].filter(([n]) => n > from).sort(([a], [b]) => a - b).map(([n, f]) => file(n, f));
		return { ...(newest > after ? { snapshot: file(newest, lane.snapshots.get(newest) as Uint8Array) } : {}), saves, newestSave: lane.newestSave };
	}

	async list(): Promise<LaneEntry[]> {
		return [...this.#lanes.entries()].map(([lane, l]) => {
			const lock = this.#state(l);
			return { lane, newestSave: l.newestSave, ...(lock === undefined ? {} : { lock }) };
		});
	}

	async log(name: string): Promise<RemoteFile[]> {
		const lane = this.#lanes.get(name);
		if (lane === undefined) throw new RemoteError("not-found", `No lane ${name} on remote ${this.name}`);
		return [...lane.logs.entries()].sort(([a], [b]) => a - b).map(([n, f]) => ({ n, file: f.slice() }));
	}

	async getCheck(): Promise<Uint8Array | undefined> {
		return this.#check?.slice();
	}

	async putCheck(file: Uint8Array): Promise<void> {
		if (this.#check !== undefined && !isDeepStrictEqual(this.#check, file)) throw new RemoteError("refused", `remote ${this.name} already has a different key check`);
		this.#check = file.slice();
	}

	async drop(name: string, lock: number): Promise<void> {
		const lane = this.#current(name, lock);
		this.#dropped.set(name, lane.lock);
		this.#lanes.delete(name);
	}
}
