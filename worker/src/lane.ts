/** Serializes lane locks and opaque saves; snapshot parts become visible in one SQLite transaction. */
import { KEEP_SNAPSHOTS, STALE_MS, type Holder, type LockState } from "../../src/remote/types.ts";
import { base64, CHUNK_BYTES, empty, type Env, failure, jsonBody, number, Problem, protect, same, unbase64 } from "./common.ts";

type LockRow = { lock: number; held: number; last_seen: number; machine: string; device: string; pid: number }
type Head = { active: number; newest: number; hash: ArrayBuffer | null; log_hash: ArrayBuffer | null }
type Snapshot = { n: number; parts: number; bytes: number; generation: string }

export class LaneObject {
	readonly #ctx: DurableObjectState;
	readonly #env: Env;
	readonly #sql: SqlStorage;
	constructor(ctx: DurableObjectState, env: Env) {
		this.#ctx = ctx; this.#env = env; this.#sql = ctx.storage.sql;
		this.#sql.exec(`CREATE TABLE IF NOT EXISTS lock (id INTEGER PRIMARY KEY CHECK (id = 1), lock INTEGER NOT NULL, held INTEGER NOT NULL, last_seen INTEGER NOT NULL, machine TEXT NOT NULL, device TEXT NOT NULL, pid INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS head (id INTEGER PRIMARY KEY CHECK (id = 1), active INTEGER NOT NULL, newest INTEGER NOT NULL, hash BLOB, log_hash BLOB);
			INSERT OR IGNORE INTO head VALUES (1, 0, 0, NULL, NULL);
			CREATE TABLE IF NOT EXISTS files (kind TEXT NOT NULL, n INTEGER NOT NULL, part INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (kind, n, part));
			CREATE TABLE IF NOT EXISTS logs (n INTEGER PRIMARY KEY, bytes BLOB NOT NULL);
			CREATE TABLE IF NOT EXISTS snapshots (n INTEGER PRIMARY KEY, parts INTEGER NOT NULL, bytes INTEGER NOT NULL, generation TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS uploads (n INTEGER PRIMARY KEY, lock INTEGER NOT NULL, parts INTEGER NOT NULL, generation TEXT NOT NULL)`);
	}
	#head(): Head { return this.#sql.exec<Head>("SELECT active, newest, hash, log_hash FROM head").one(); }
	#lock(): LockRow | undefined { return this.#sql.exec<LockRow>("SELECT lock, held, last_seen, machine, device, pid FROM lock").toArray()[0]; }
	#state(row: LockRow): LockState {
		const override = Number(this.#env.ORRERY_STALE_MS);
		const staleMs = Number.isFinite(override) && override > 0 ? override : STALE_MS;
		return { lock: row.lock, holder: { machine: row.machine, device: row.device, pid: row.pid }, held: row.held === 1, lastSeen: row.last_seen, stale: row.held === 1 && Date.now() - row.last_seen > staleMs };
	}
	#current(lock: number): Head {
		const head = this.#head(); const row = this.#lock();
		if (!head.active || !row?.held || row.lock !== lock) throw new Problem(409, "lock-lost");
		return head;
	}
	#touch(): void { this.#sql.exec("UPDATE lock SET last_seen = ? WHERE id = 1", Date.now()); }
	async #index(lane: string, method: "PUT" | "DELETE"): Promise<void> {
		const response = await this.#env.INDEX.get(this.#env.INDEX.idFromName("index")).fetch(`https://internal/internal/lanes/${lane}`, { method });
		if (!response.ok) throw new Problem(response.status, "refused");
	}
	async fetch(request: Request): Promise<Response> {
		return protect(async () => {
			const url = new URL(request.url);
			const match = /^\/v1\/lanes\/([A-Za-z][A-Za-z0-9_-]{0,31})(.*)$/.exec(url.pathname);
			if (!match) return failure(404, "not-found");
			const [, lane, path] = match;
			if (request.method === "POST" && path === "/take") {
				const body = await jsonBody(request); const holder = body.holder as Holder | undefined;
				if (!holder || typeof holder.machine !== "string" || typeof holder.device !== "string" || !holder.machine || !holder.device || holder.machine.length > 256 || holder.device.length > 256 || !Number.isSafeInteger(holder.pid) || holder.pid < 0 || (body.force !== undefined && typeof body.force !== "boolean")) throw new Problem(400, "refused");
				// Only creation/drop needs an external index call. Close the input gate across it.
				return this.#ctx.blockConcurrencyWhile(() => protect(async () => {
					if (!this.#head().active) await this.#index(lane, "PUT");
					return this.#ctx.storage.transactionSync(() => {
						const current = this.#lock(); const state = current && this.#state(current);
						if (state?.held && !(body.force === true && (state.stale || holder.device === state.holder.device))) return Response.json({ ok: false, held: state });
						const lock = (current?.lock ?? 0) + 1;
						this.#sql.exec("INSERT OR REPLACE INTO lock VALUES (1, ?, 1, ?, ?, ?, ?)", lock, Date.now(), holder.machine, holder.device, holder.pid);
						this.#sql.exec("UPDATE head SET active = 1 WHERE id = 1");
						this.#sql.exec("DELETE FROM files WHERE kind = 'pending'");
						this.#sql.exec("DELETE FROM uploads");
						return Response.json({ ok: true, lock, newestSave: this.#head().newest });
					});
				}));
			}
			if (request.method === "POST" && (path === "/renew" || path === "/release")) {
				const lock = number((await jsonBody(request)).lock, 1);
				return this.#ctx.storage.transactionSync(() => {
					if (path === "/renew") { this.#current(lock); this.#touch(); }
					else this.#sql.exec("UPDATE lock SET held = 0 WHERE lock = ?", lock);
					return empty();
				});
			}
			const file = /^\/(saves|snapshots)\/(\d+)$/.exec(path);
			if (request.method === "PUT" && file) {
				const lock = number(url.searchParams.get("lock"), 1); const n = number(file[2]);
				if (file[1] === "saves") return this.#save(request, lock, n);
				return this.#snapshot(request, url, lock, n);
			}
			if (path === "" && request.method === "DELETE") {
				const lock = number(url.searchParams.get("lock"), 1);
				return this.#ctx.blockConcurrencyWhile(() => protect(async () => {
					this.#current(lock);
					this.#ctx.storage.transactionSync(() => {
						this.#sql.exec("DELETE FROM files; DELETE FROM logs; DELETE FROM snapshots; DELETE FROM uploads; UPDATE head SET active = 0, newest = 0, hash = NULL, log_hash = NULL; UPDATE lock SET held = 0");
					});
					// A failed directory update leaves a tombstone, never an active but hidden lane.
					// Keep the counter: a delayed writer can never match a recreated lane.
					await this.#index(lane, "DELETE");
					return empty();
				}));
			}
			if (!this.#head().active) return failure(404, "not-found");
			if (request.method === "GET" && path === "/entry") return Response.json({ lane, newestSave: this.#head().newest, lock: this.#state(this.#lock()!) });
			if (request.method === "GET" && path === "/fetch") {
				const after = number(url.searchParams.get("after"), -1);
				const snapshot = this.#sql.exec<Snapshot>("SELECT n, parts, bytes, generation FROM snapshots WHERE n > ? ORDER BY n DESC LIMIT 1", after).toArray()[0];
				const saves = this.#sql.exec<{ n: number; parts: number; bytes: number }>("SELECT n, COUNT(*) AS parts, SUM(LENGTH(bytes)) AS bytes FROM files WHERE kind = 'save' AND n > ? GROUP BY n ORDER BY n", snapshot?.n ?? after).toArray();
				return Response.json({ ...(snapshot ? { snapshot } : {}), saves: saves.map((save) => save.n), saveParts: Object.fromEntries(saves.map((save) => [save.n, save.parts])), bytes: (snapshot?.bytes ?? 0) + saves.reduce((sum, save) => sum + save.bytes, 0), newestSave: this.#head().newest });
			}
			const get = /^\/files\/(save|snapshot)\/(\d+)$/.exec(path);
			if (request.method === "GET" && get) {
				const generation = url.searchParams.get("generation");
				if (get[1] === "snapshot" && generation !== null) {
					const current = this.#sql.exec<{ generation: string }>("SELECT generation FROM snapshots WHERE n = ?", number(get[2])).toArray()[0];
					if (current?.generation !== generation) throw new Problem(409, "out-of-order");
				}
				const row = this.#sql.exec<{ bytes: ArrayBuffer }>("SELECT bytes FROM files WHERE kind = ? AND n = ? AND part = ?", get[1], number(get[2]), number(url.searchParams.get("part") ?? "0")).toArray()[0];
				return row ? new Response(row.bytes, { headers: { "Content-Type": "application/octet-stream" } }) : failure(404, "not-found");
			}
			if (request.method === "GET" && path === "/log") return Response.json(this.#sql.exec<{ n: number; bytes: ArrayBuffer }>("SELECT n, bytes FROM logs ORDER BY n").toArray().map((row) => ({ n: row.n, file: base64(row.bytes) })));
			return failure(404, "not-found");
		});
	}
	async #save(request: Request, lock: number, n: number): Promise<Response> {
		const bytes = await request.arrayBuffer(); const log = unbase64(request.headers.get("x-orrery-log"));
		const [hash, logHash] = await Promise.all([crypto.subtle.digest("SHA-256", bytes), crypto.subtle.digest("SHA-256", log)]);
		return this.#ctx.storage.transactionSync(() => {
			const head = this.#current(lock);
			if (n === head.newest && n > 0 && head.hash && head.log_hash && same(head.hash, hash) && same(head.log_hash, logHash)) { this.#touch(); return empty(); }
			if (n !== head.newest + 1) throw new Problem(409, "out-of-order");
			for (let part = 0; part < Math.max(1, Math.ceil(bytes.byteLength / CHUNK_BYTES)); part++) this.#sql.exec("INSERT INTO files VALUES ('save', ?, ?, ?)", n, part, bytes.slice(part * CHUNK_BYTES, (part + 1) * CHUNK_BYTES));
			this.#sql.exec("INSERT INTO logs VALUES (?, ?)", n, log);
			this.#sql.exec("UPDATE head SET newest = ?, hash = ?, log_hash = ? WHERE id = 1", n, hash, logHash);
			this.#touch(); return empty();
		});
	}
	async #snapshot(request: Request, url: URL, lock: number, n: number): Promise<Response> {
		const part = number(url.searchParams.get("part")); const parts = number(url.searchParams.get("parts"), 1);
		if (part >= parts) throw new Problem(400, "refused");
		const bytes = await request.arrayBuffer();
		if (bytes.byteLength > CHUNK_BYTES) throw new Problem(413, "refused");
		return this.#ctx.storage.transactionSync(() => {
			const head = this.#current(lock);
			if (n > head.newest) throw new Problem(409, "out-of-order");
			const committed = this.#sql.exec<Snapshot>("SELECT n, parts, bytes, generation FROM snapshots WHERE n = ?", n).toArray()[0];
			const inProgress = this.#sql.exec<{ lock: number; parts: number; generation: string }>("SELECT lock, parts, generation FROM uploads WHERE n = ?", n).toArray()[0];
			if (part > 0 && !inProgress && committed) {
				const saved = this.#sql.exec<{ bytes: ArrayBuffer }>("SELECT bytes FROM files WHERE kind = 'snapshot' AND n = ? AND part = ?", n, part).toArray()[0];
				if (committed.parts !== parts || !saved || !same(saved.bytes, bytes)) throw new Problem(409, "out-of-order");
				this.#touch(); return empty();
			}
			if (part === 0) {
				this.#sql.exec("DELETE FROM files WHERE kind = 'pending' AND n = ?", n);
				this.#sql.exec("INSERT OR REPLACE INTO uploads VALUES (?, ?, ?, ?)", n, lock, parts, crypto.randomUUID());
			}
			const upload = this.#sql.exec<{ lock: number; parts: number; generation: string }>("SELECT lock, parts, generation FROM uploads WHERE n = ?", n).toArray()[0];
			if (!upload || upload.lock !== lock || upload.parts !== parts) throw new Problem(409, "out-of-order");
			this.#sql.exec("INSERT OR REPLACE INTO files VALUES ('pending', ?, ?, ?)", n, part, bytes);
			if (part === parts - 1) {
				const staged = this.#sql.exec<{ count: number; bytes: number }>("SELECT COUNT(*) AS count, SUM(LENGTH(bytes)) AS bytes FROM files WHERE kind = 'pending' AND n = ?", n).one();
				if (staged.count !== parts) throw new Problem(409, "out-of-order");
				this.#sql.exec("DELETE FROM files WHERE kind = 'snapshot' AND n = ?", n);
				this.#sql.exec("UPDATE files SET kind = 'snapshot' WHERE kind = 'pending' AND n = ?", n);
				this.#sql.exec("INSERT OR REPLACE INTO snapshots VALUES (?, ?, ?, ?)", n, parts, staged.bytes, upload.generation);
				this.#sql.exec("DELETE FROM uploads WHERE n = ?", n);
				this.#sql.exec("DELETE FROM snapshots WHERE n NOT IN (SELECT n FROM snapshots ORDER BY n DESC LIMIT ?)", KEEP_SNAPSHOTS);
				this.#sql.exec("DELETE FROM files WHERE kind = 'snapshot' AND n NOT IN (SELECT n FROM snapshots)");
				this.#sql.exec("DELETE FROM files WHERE kind = 'save' AND n <= (SELECT MIN(n) FROM snapshots)");
			}
			this.#touch(); return empty();
		});
	}
}
