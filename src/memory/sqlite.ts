/**
 * The few SQLite calls the memory store needs, on Node (node:sqlite) or on Bun (bun:sqlite). pi's own binary runs on
 * Bun 1.3.14, which has no node:sqlite; the CLI and tests run on Node. ORRERY_SQLITE=node|bun forces one.
 */

import { chmodSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

export type SqlValue = null | number | bigint | string | Uint8Array;

export interface Statement {
	run(...params: SqlValue[]): void;
	get(...params: SqlValue[]): Record<string, unknown> | undefined;
	all(...params: SqlValue[]): Record<string, unknown>[];
}

export interface Database {
	exec(sql: string): void;
	prepare(sql: string): Statement;
	close(): void;
}

interface BunStatement {
	run(...params: SqlValue[]): unknown;
	get(...params: SqlValue[]): Record<string, unknown> | null;
	all(...params: SqlValue[]): Record<string, unknown>[];
	finalize(): void;
}

interface BunDatabase {
	run(sql: string): unknown;
	prepare(sql: string): BunStatement;
	close(throwOnError?: boolean): void;
}

/** bun:sqlite errors carry the SQLite code as `errno`; node:sqlite calls it `errcode`. Callers match on `errcode`. */
function withErrcode<T>(call: () => T): T {
	try {
		return call();
	} catch (error) {
		const e = error as { errcode?: number; errno?: number };
		if (e !== null && typeof e === "object" && e.errcode === undefined && typeof e.errno === "number") e.errcode = e.errno;
		throw error;
	}
}

const load = createRequire(import.meta.url);

type BunDatabaseClass = new (path: string, options?: object) => BunDatabase;

const SQLITE_CANTOPEN = 14;

/**
 * A read-only bun:sqlite connection. A read-only connection to a WAL-mode file needs its -wal file, and a file no
 * connection has open has none (rebuilds and restores remove it; a SQLite that deletes it on close leaves none). The
 * system SQLite that Bun uses on macOS will not create one for a read-only connection: the first read fails with
 * SQLITE_CANTOPEN. That file is opened read-write instead, never created. Callers only read through it (VACUUM INTO
 * writes another file); like any last connection, its close checkpoints the WAL.
 */
function openBunReadOnly(Database: BunDatabaseClass, path: string): BunDatabase {
	const db = withErrcode(() => new Database(path, { readonly: true }));
	try {
		withErrcode(() => {
			const probe = db.prepare("PRAGMA schema_version");
			try {
				probe.get();
			} finally {
				probe.finalize();
			}
		});
		return db;
	} catch (error) {
		db.close(false);
		if ((error as { errcode?: number }).errcode !== SQLITE_CANTOPEN) throw error;
		try {
			return withErrcode(() => new Database(path, { readwrite: true, create: false }));
		} catch {
			throw error;
		}
	}
}

export function sqliteBackend(): "node" | "bun" {
	const forced = process.env.ORRERY_SQLITE;
	if (forced === "node" || forced === "bun") return forced;
	return process.versions.bun === undefined ? "node" : "bun";
}

export function openDatabase(path: string, options: { readOnly?: boolean } = {}): Database {
	if (sqliteBackend() === "bun") {
		const { Database } = load("bun:sqlite") as { Database: BunDatabaseClass };
		const db = options.readOnly === true ? openBunReadOnly(Database, path) : withErrcode(() => new Database(path, { create: true }));
		// bun:sqlite's close() leaves the connection open while any prepared statement is unfinalized, until garbage
		// collection: the WAL stays beside the file and the file stays open. A rebuilt copy renamed into place then
		// lost every save in its WAL. Statements are kept per SQL text (the store prepares some on every call, and a lane
		// stays open for days) and all finalized at close, so close() really closes.
		const statements = new Map<string, BunStatement>();
		return {
			// Our SQL never has ";" inside literals, so statements split safely.
			exec: (sql) => {
				for (const statement of sql.split(";")) if (statement.trim()) withErrcode(() => db.run(statement));
			},
			prepare: (sql) => {
				let statement = statements.get(sql);
				if (statement === undefined) {
					const prepared = withErrcode(() => db.prepare(sql));
					statements.set(sql, prepared);
					statement = prepared;
				}
				const compiled = statement;
				return {
					run: (...params) => {
						withErrcode(() => compiled.run(...params));
					},
					get: (...params) => withErrcode(() => compiled.get(...params)) ?? undefined,
					all: (...params) => withErrcode(() => compiled.all(...params)),
				};
			},
			close: () => {
				let failed: unknown;
				for (const statement of statements.values()) {
					try { statement.finalize(); } catch (error) { failed ??= error; }
				}
				statements.clear();
				try {
					withErrcode(() => db.close(true));
				} catch (error) {
					// Never leave the handle fully open: at worst it closes when collected, as before.
					db.close(false);
					failed ??= error;
				}
				if (failed !== undefined) throw failed;
			},
		};
	}
	const { DatabaseSync } = load("node:sqlite") as typeof import("node:sqlite");
	const db = new DatabaseSync(path, { readOnly: options.readOnly === true });
	return {
		exec: (sql) => db.exec(sql),
		prepare: (sql) => {
			const statement = db.prepare(sql);
			return {
				run: (...params) => {
					statement.run(...params);
				},
				get: (...params) => statement.get(...params) as Record<string, unknown> | undefined,
				all: (...params) => statement.all(...params) as Record<string, unknown>[],
			};
		},
		close: () => db.close(),
	};
}

/**
 * VACUUM INTO `target`, a file the caller reserved empty and private (0600) so that no one else can read what SQLite
 * writes. The system SQLite that Bun uses on macOS refuses an existing file, even an empty one, so SQLite writes a new
 * file in a private folder (0700) beside the target, and that file is renamed over the reservation.
 */
export function vacuumInto(db: Database, target: string): void {
	const folder = mkdtempSync(`${target}-`);
	try {
		const copy = join(folder, "copy.sqlite");
		db.prepare("VACUUM INTO ?").run(copy);
		chmodSync(copy, 0o600);
		renameSync(copy, target);
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
}
