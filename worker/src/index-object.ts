/** Stores the lane directory and the remote's immutable encrypted key check. */
import { CHUNK_BYTES, empty, type Env, failure, NAME, Problem, protect, same } from "./common.ts";

export class IndexObject {
	readonly #ctx: DurableObjectState;
	readonly #env: Env;
	constructor(ctx: DurableObjectState, env: Env) {
		this.#ctx = ctx; this.#env = env;
		ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS lanes (name TEXT PRIMARY KEY)");
		ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS key_check (id INTEGER PRIMARY KEY CHECK (id = 1), bytes BLOB NOT NULL)");
	}
	async fetch(request: Request): Promise<Response> {
		return protect(async () => {
			const path = new URL(request.url).pathname;
			const sql = this.#ctx.storage.sql;
			const lane = /^\/internal\/lanes\/([A-Za-z][A-Za-z0-9_-]{0,31})$/.exec(path)?.[1];
			if (lane && (request.method === "PUT" || request.method === "DELETE")) {
				sql.exec(request.method === "PUT" ? "INSERT OR IGNORE INTO lanes VALUES (?)" : "DELETE FROM lanes WHERE name = ?", lane);
				return empty();
			}
			if (path === "/v1/check") {
				if (request.method === "GET") {
					const row = sql.exec<{ bytes: ArrayBuffer }>("SELECT bytes FROM key_check").toArray()[0];
					return row ? new Response(row.bytes) : failure(404, "not-found");
				}
				if (request.method === "PUT") {
					const bytes = await request.arrayBuffer();
					if (bytes.byteLength > CHUNK_BYTES) throw new Problem(413, "refused");
					return this.#ctx.storage.transactionSync(() => {
						const row = sql.exec<{ bytes: ArrayBuffer }>("SELECT bytes FROM key_check").toArray()[0];
						if (row && !same(row.bytes, bytes)) throw new Problem(409, "refused");
						if (!row) sql.exec("INSERT INTO key_check VALUES (1, ?)", bytes);
						return empty();
					});
				}
			}
			if (path === "/v1/lanes" && request.method === "GET") {
				const names = sql.exec<{ name: string }>("SELECT name FROM lanes ORDER BY name").toArray();
				const entries: unknown[] = [];
				// Sequential requests stay below the Worker's outgoing connection limit.
				for (const { name } of names) {
					if (!NAME.test(name)) continue;
					const response = await this.#env.LANES.get(this.#env.LANES.idFromName(name)).fetch(`https://internal/v1/lanes/${name}/entry`);
					if (response.status === 404) continue; // A concurrent drop completed.
					if (!response.ok) return response;
					entries.push(await response.json());
				}
				return Response.json(entries);
			}
			return failure(404, "not-found");
		});
	}
}
