/** The Cloudflare Storage client: authenticated HTTP for opaque encrypted files, with bounded calls. */
import type { RemoteConfig } from "../lane/config.ts";
import { CALL_TIMEOUT_MS, type FetchResult, type Holder, type LaneEntry, RemoteError, type RemoteErrorKind, type RemoteFile, sizedTimeoutMs, type Storage, type TakeResult } from "./types.ts";

const CHUNK_BYTES = 1024 * 1024;
interface Manifest {
	snapshot?: { n: number; parts: number; generation?: string };
	saves: number[];
	/** Additive fields keep the v1 manifest compatible while supporting large saves and scaled downloads. */
	saveParts?: Record<string, number>;
	bytes?: number;
	newestSave: number;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const validNumber = (n: unknown, min = 0): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= min;
const validLock = (value: unknown): boolean => record(value)
	&& validNumber(value.lock, 1) && validNumber(value.lastSeen)
	&& typeof value.held === "boolean" && typeof value.stale === "boolean"
	&& record(value.holder) && typeof value.holder.machine === "string"
	&& typeof value.holder.device === "string" && validNumber(value.holder.pid);

export class CloudflareStorage implements Storage {
	readonly name: string;
	readonly #url: string;
	readonly #token: string;
	readonly #fetch: typeof fetch;
	constructor(remote: Extract<RemoteConfig, { kind: "cloudflare" }>, token: string, options: { fetch?: typeof fetch } = {}) {
		this.name = remote.name;
		const url = new URL(remote.url);
		if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || url.username || url.password || url.search || url.hash) throw new RemoteError("refused", `remote ${this.name} needs an HTTPS URL`);
		this.#url = remote.url.replace(/\/+$/, ""); this.#token = token; this.#fetch = options.fetch ?? fetch;
	}
	#lane(lane: string): string {
		if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(lane)) throw new RemoteError("refused", "Lane names use letters, digits, - and _ (max 32)");
		return `/v1/lanes/${lane}`;
	}
	#number(n: number, min = 0): number {
		if (!validNumber(n, min)) throw new RemoteError("refused", "The remote request needs a valid whole number");
		return n;
	}
	async #call(path: string, init: RequestInit = {}, signal = AbortSignal.timeout(CALL_TIMEOUT_MS), missingCheck = false): Promise<Uint8Array | undefined> {
		try {
			const headers = new Headers(init.headers);
			headers.set("Authorization", `Bearer ${this.#token}`);
			const response = await this.#fetch(`${this.#url}${path}`, { ...init, headers, signal, redirect: "manual" });
			const bytes = new Uint8Array(await response.arrayBuffer());
			if (missingCheck && response.status === 404) return undefined;
			if (response.ok && !response.headers.get("Content-Type")?.includes("text/html")) return bytes;
			const text = new TextDecoder().decode(bytes);
			if (response.status === 429 || /\berror code:\s*1027\b/i.test(text)) throw new RemoteError("quota", `remote ${this.name} is over Cloudflare's daily free limit until 00:00 UTC`);
			if (response.status === 401 || response.status === 403) throw new RemoteError("auth", `remote ${this.name} refused its access token`);
			if (response.ok) return bytes;
			let kind: RemoteErrorKind = response.status === 404 ? "not-found" : response.status >= 500 ? "unreachable" : "refused";
			if (response.status === 409) {
				try {
					const error = JSON.parse(text).error;
					if (error === "lock-lost" || error === "out-of-order" || error === "held") kind = error;
				} catch { /* Unknown errors remain refused. */ }
			}
			throw new RemoteError(kind, `remote ${this.name}: ${kind} (HTTP ${response.status})`);
		} catch (error) {
			if (error instanceof RemoteError) throw error;
			// Do not echo transport messages: they may contain request headers or the token.
			throw new RemoteError("unreachable", `remote ${this.name} cannot be reached`);
		}
	}
	async #json<T>(path: string, init?: RequestInit): Promise<T> {
		const bytes = await this.#call(path, init);
		try { return JSON.parse(new TextDecoder().decode(bytes)) as T; }
		catch { throw new RemoteError("corrupt", `remote ${this.name} sent an invalid reply`); }
	}
	#post(body: unknown): RequestInit { return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }; }
	async take(lane: string, holder: Holder, options: { force?: boolean } = {}): Promise<TakeResult> {
		const value = await this.#json<unknown>(`${this.#lane(lane)}/take`, this.#post({ holder, force: options.force ?? false }));
		if (!record(value) || !((value.ok === true && validNumber(value.lock, 1) && validNumber(value.newestSave)) || (value.ok === false && validLock(value.held)))) throw new RemoteError("corrupt", `remote ${this.name} sent an invalid lock reply`);
		return value as unknown as TakeResult;
	}
	async renew(lane: string, lock: number): Promise<void> { await this.#call(`${this.#lane(lane)}/renew`, this.#post({ lock: this.#number(lock, 1) })); }
	async release(lane: string, lock: number): Promise<void> { await this.#call(`${this.#lane(lane)}/release`, this.#post({ lock: this.#number(lock, 1) })); }
	async save(lane: string, lock: number, n: number, file: Uint8Array, logEntry: Uint8Array): Promise<void> {
		await this.#call(`${this.#lane(lane)}/saves/${this.#number(n, 1)}?lock=${this.#number(lock, 1)}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream", "x-orrery-log": Buffer.from(logEntry).toString("base64") }, body: new Uint8Array(file) }, AbortSignal.timeout(sizedTimeoutMs(file.byteLength)));
	}
	async snapshot(lane: string, lock: number, n: number, file: Uint8Array): Promise<void> {
		const path = `${this.#lane(lane)}/snapshots/${this.#number(n)}?lock=${this.#number(lock, 1)}`;
		const parts = Math.max(1, Math.ceil(file.byteLength / CHUNK_BYTES));
		for (let part = 0; part < parts; part++) {
			const body = new Uint8Array(file.subarray(part * CHUNK_BYTES, (part + 1) * CHUNK_BYTES));
			await this.#call(`${path}&part=${part}&parts=${parts}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body }, AbortSignal.timeout(sizedTimeoutMs(body.byteLength)));
		}
	}
	async fetch(lane: string, after: number): Promise<FetchResult> {
		for (let attempt = 0; attempt < 3; attempt++) {
			try { return await this.#fetchOnce(lane, after); }
			catch (error) { if (!(error instanceof RemoteError) || error.kind !== "out-of-order") throw error; }
		}
		throw new RemoteError("unreachable", `remote ${this.name} changed during the fetch; try again`);
	}
	async #fetchOnce(lane: string, after: number): Promise<FetchResult> {
		const path = this.#lane(lane);
		const manifest = await this.#json<Manifest>(`${path}/fetch?after=${this.#number(after, -1)}`);
		const corrupt = () => new RemoteError("corrupt", `remote ${this.name} sent an invalid file list`);
		if (!record(manifest) || !validNumber(manifest.newestSave) || !Array.isArray(manifest.saves)) throw corrupt();
		if (manifest.snapshot !== undefined) {
			const snapshot = manifest.snapshot;
			if (!record(snapshot) || !validNumber(snapshot.n) || !validNumber(snapshot.parts, 1)
				|| snapshot.n <= after || snapshot.n > manifest.newestSave
				|| (snapshot.generation !== undefined && (typeof snapshot.generation !== "string" || snapshot.generation.length === 0 || snapshot.generation.length > 128))) throw corrupt();
		}
		if (manifest.saves.some((n, i) => !validNumber(n, 1) || n > manifest.newestSave || n <= (manifest.saves[i - 1] ?? manifest.snapshot?.n ?? after))) throw corrupt();
		if ((manifest.saveParts !== undefined && !record(manifest.saveParts)) || (manifest.bytes !== undefined && !validNumber(manifest.bytes))) throw corrupt();
		const partCount = (n: number) => {
			const count = manifest.saveParts?.[n] ?? 1;
			if (!validNumber(count, 1)) throw new RemoteError("corrupt", `remote ${this.name} sent an invalid part count`);
			return count;
		};
		for (const n of manifest.saves) partCount(n); // Validate all counts before downloading any files.
		const read = async (kind: string, n: number, count: number, generation?: string): Promise<RemoteFile> => {
			const chunks: Uint8Array[] = [];
			for (let part = 0; part < count; part++) {
				try { chunks.push((await this.#call(`${path}/files/${kind}/${n}?part=${part}${generation === undefined ? "" : `&generation=${encodeURIComponent(generation)}`}`, {}, AbortSignal.timeout(sizedTimeoutMs(CHUNK_BYTES))))!); }
				catch (error) {
					if (error instanceof RemoteError && error.kind === "not-found") throw new RemoteError("out-of-order", "Files were pruned during the fetch");
					throw error;
				}
			}
			const file = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
			let offset = 0; for (const chunk of chunks) { file.set(chunk, offset); offset += chunk.byteLength; }
			return { n, file };
		};
		const snapshot = manifest.snapshot && await read("snapshot", manifest.snapshot.n, manifest.snapshot.parts, manifest.snapshot.generation);
		const saves: RemoteFile[] = [];
		for (const n of manifest.saves) saves.push(await read("save", n, partCount(n)));
		return { ...(snapshot ? { snapshot } : {}), saves, newestSave: manifest.newestSave };
	}
	async list(): Promise<LaneEntry[]> {
		const entries = await this.#json<unknown>("/v1/lanes");
		if (!Array.isArray(entries) || entries.some((entry) => !record(entry) || typeof entry.lane !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(entry.lane) || !validNumber(entry.newestSave) || (entry.lock !== undefined && !validLock(entry.lock)))) throw new RemoteError("corrupt", `remote ${this.name} sent an invalid lane list`);
		return entries as LaneEntry[];
	}
	async log(lane: string): Promise<RemoteFile[]> {
		const entries = await this.#json<{ n: number; file: string }[]>(`${this.#lane(lane)}/log`);
		if (!Array.isArray(entries) || entries.some((entry) => !record(entry) || !validNumber(entry.n, 1) || typeof entry.file !== "string")) throw new RemoteError("corrupt", `remote ${this.name} sent an invalid log`);
		return entries.map(({ n, file }) => ({ n, file: new Uint8Array(Buffer.from(file, "base64")) }));
	}
	async getCheck(): Promise<Uint8Array | undefined> { return this.#call("/v1/check", {}, AbortSignal.timeout(CALL_TIMEOUT_MS), true); }
	async putCheck(file: Uint8Array): Promise<void> { await this.#call("/v1/check", { method: "PUT", body: new Uint8Array(file) }); }
	async drop(lane: string, lock: number): Promise<void> { await this.#call(`${this.#lane(lane)}?lock=${this.#number(lock, 1)}`, { method: "DELETE" }); }
}
