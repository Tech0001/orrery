/** An in-memory Storage with an injectable clock: the reference for what every remote kind must do (test/remote/contract.ts). */

import { isDeepStrictEqual } from "node:util";
import { type FetchResult, type Holder, KEEP_SNAPSHOTS, type LaneEntry, type LockState, RemoteError, type RemoteFile, STALE_MS, type Storage, type TakeResult } from "./types.ts";

interface Agent {
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
	readonly #agents = new Map<string, Agent>();
	/** Lock numbers of dropped agents: an agent created again continues from here, so an old lock can never match. */
	readonly #dropped = new Map<string, number>();
	#check: Uint8Array | undefined;

	constructor(options: FakeStorageOptions = {}) {
		this.name = options.name ?? "fake";
		this.#now = options.now ?? Date.now;
		this.#staleMs = options.staleMs ?? STALE_MS;
	}

	#state(agent: Agent): LockState | undefined {
		if (agent.holder === undefined) return undefined;
		return { holder: agent.holder, lock: agent.lock, lastSeen: agent.lastSeen, held: agent.held, stale: agent.held && this.#now() - agent.lastSeen > this.#staleMs };
	}

	#current(name: string, lock: number): Agent {
		const agent = this.#agents.get(name);
		if (agent === undefined || !agent.held || agent.lock !== lock) throw new RemoteError("lock-lost", `${name}: lock ${lock} is no longer current`);
		return agent;
	}

	async take(name: string, holder: Holder, options: { force?: boolean } = {}): Promise<TakeResult> {
		let agent = this.#agents.get(name);
		if (agent === undefined) {
			agent = { lock: this.#dropped.get(name) ?? 0, held: false, lastSeen: 0, saves: new Map(), logs: new Map(), snapshots: new Map(), newestSave: 0 };
			this.#agents.set(name, agent);
		}
		const state = this.#state(agent);
		if (state !== undefined && state.held) {
			const mine = state.holder.device === holder.device;
			if (!(options.force === true && (state.stale || mine))) return { ok: false, held: state };
		}
		agent.lock += 1;
		agent.holder = holder;
		agent.held = true;
		agent.lastSeen = this.#now();
		return { ok: true, lock: agent.lock, newestSave: agent.newestSave };
	}

	async renew(name: string, lock: number): Promise<void> {
		this.#current(name, lock).lastSeen = this.#now();
	}

	async release(name: string, lock: number): Promise<void> {
		const agent = this.#agents.get(name);
		if (agent !== undefined && agent.held && agent.lock === lock) agent.held = false;
	}

	async save(name: string, lock: number, n: number, file: Uint8Array, logEntry: Uint8Array): Promise<void> {
		const agent = this.#current(name, lock);
		if (n === agent.newestSave && n > 0 && isDeepStrictEqual(agent.saves.get(n), file) && isDeepStrictEqual(agent.logs.get(n), logEntry)) return;
		if (n !== agent.newestSave + 1) throw new RemoteError("out-of-order", `${name}: save ${n} is not next (newest is ${agent.newestSave})`);
		agent.saves.set(n, file.slice());
		agent.logs.set(n, logEntry.slice());
		agent.newestSave = n;
		agent.lastSeen = this.#now();
	}

	async snapshot(name: string, lock: number, n: number, file: Uint8Array): Promise<void> {
		const agent = this.#current(name, lock);
		if (n < 0 || n > agent.newestSave) throw new RemoteError("out-of-order", `${name}: snapshot ${n} is past the newest save ${agent.newestSave}`);
		agent.snapshots.set(n, file.slice());
		const kept = [...agent.snapshots.keys()].sort((a, b) => b - a).slice(0, KEEP_SNAPSHOTS);
		for (const key of agent.snapshots.keys()) if (!kept.includes(key)) agent.snapshots.delete(key);
		const oldest = Math.min(...kept);
		for (const key of agent.saves.keys()) if (key <= oldest) agent.saves.delete(key);
		agent.lastSeen = this.#now();
	}

	async fetch(name: string, after: number): Promise<FetchResult> {
		const agent = this.#agents.get(name);
		if (agent === undefined) throw new RemoteError("not-found", `No agent ${name} on remote ${this.name}`);
		const newest = Math.max(-1, ...agent.snapshots.keys());
		const file = (n: number, bytes: Uint8Array): RemoteFile => ({ n, file: bytes.slice() });
		const from = newest > after ? newest : after;
		const saves = [...agent.saves.entries()].filter(([n]) => n > from).sort(([a], [b]) => a - b).map(([n, f]) => file(n, f));
		return { ...(newest > after ? { snapshot: file(newest, agent.snapshots.get(newest) as Uint8Array) } : {}), saves, newestSave: agent.newestSave };
	}

	async list(): Promise<LaneEntry[]> {
		return [...this.#agents.entries()].map(([agent, l]) => {
			const lock = this.#state(l);
			return { lane: agent, newestSave: l.newestSave, ...(lock === undefined ? {} : { lock }) };
		});
	}

	async log(name: string): Promise<RemoteFile[]> {
		const agent = this.#agents.get(name);
		if (agent === undefined) throw new RemoteError("not-found", `No agent ${name} on remote ${this.name}`);
		return [...agent.logs.entries()].sort(([a], [b]) => a - b).map(([n, f]) => ({ n, file: f.slice() }));
	}

	async getCheck(): Promise<Uint8Array | undefined> {
		return this.#check?.slice();
	}

	async putCheck(file: Uint8Array): Promise<void> {
		if (this.#check !== undefined && !isDeepStrictEqual(this.#check, file)) throw new RemoteError("refused", `remote ${this.name} already has a different key check`);
		this.#check = file.slice();
	}

	async drop(name: string, lock: number): Promise<void> {
		const agent = this.#current(name, lock);
		this.#dropped.set(name, agent.lock);
		this.#agents.delete(name);
	}
}
