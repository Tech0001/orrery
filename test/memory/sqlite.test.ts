import { spawnSync } from "node:child_process";
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type BunDatabase, type BunStatement, openBunReadOnly, openDatabase, sqliteBackend, vacuumInto } from "../../src/memory/sqlite.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const SCRIPT = new URL("../../scripts/bun-store-check.ts", import.meta.url).pathname;
const hasBun = spawnSync("bun", ["--version"]).status === 0;

describe("openDatabase", () => {
	it("uses node:sqlite on Node (bun:sqlite on Bun) and keeps BLOBs, multi-statement exec and missing rows as undefined", () => {
		const dir = mkdtempSync(join(tmpdir(), "orrery-sqlite-"));
		dirs.push(dir);
		expect(sqliteBackend()).toBe(process.versions.bun === undefined ? "node" : "bun");
		const db = openDatabase(join(dir, "t.sqlite"));
		db.exec("CREATE TABLE t (x BLOB); CREATE TABLE u (y INTEGER);");
		db.prepare("INSERT INTO t VALUES (?)").run(new TextEncoder().encode("a\u0000b"));
		expect((db.prepare("SELECT x FROM t").get()?.x as Uint8Array).length).toBe(3);
		expect(db.prepare("SELECT y FROM u").get()).toBeUndefined();
		db.close();
		const ro = openDatabase(join(dir, "t.sqlite"), { readOnly: true });
		expect(() => ro.exec("INSERT INTO u VALUES (1)")).toThrow();
		ro.close();
	});

	it.skipIf(!hasBun)("runs the whole memory store and Orrery's login store on bun (as inside pi's binary)", () => {
		const result = spawnSync("bun", [SCRIPT], { env: { ...process.env, ORRERY_SQLITE: "bun" }, encoding: "utf8" });
		expect(result.stderr).toBe("");
		expect(result.stdout.trim()).toBe("bun store ok: backend=bun messages=2 nodes=1 readonly=2 lock=refused view=same logins=openrouter:api_key");
	});
});

/** A stand-in for bun:sqlite's Database: `opened` records each construction; `probe` and `reopen` say what fails. */
function fakeBun(fail: { probe?: unknown; reopen?: unknown }) {
	const opened: { options: object; closes: (boolean | undefined)[]; finalized: number }[] = [];
	class FakeDatabase implements BunDatabase {
		readonly #record: (typeof opened)[number];
		constructor(_path: string, options: object = {}) {
			if ("readwrite" in options && fail.reopen !== undefined) throw fail.reopen;
			this.#record = { options, closes: [], finalized: 0 };
			opened.push(this.#record);
		}
		run(): unknown {
			return undefined;
		}
		prepare(): BunStatement {
			if ("readonly" in this.#record.options && fail.probe !== undefined) throw fail.probe;
			const record = this.#record;
			return { run: () => undefined, get: () => ({ schema_version: 1 }), all: () => [], finalize: () => { record.finalized += 1; } };
		}
		close(throwOnError?: boolean): void {
			this.#record.closes.push(throwOnError);
		}
	}
	return { Database: FakeDatabase, opened };
}

describe("openBunReadOnly", () => {
	it("keeps the read-only connection when the first read works", () => {
		const bun = fakeBun({});
		openBunReadOnly(bun.Database, "/x/memory.sqlite");
		expect(bun.opened).toEqual([{ options: { readonly: true }, closes: [], finalized: 1 }]);
	});

	it.each([14, 14 | (3 << 8)])("closes and reopens read-write, never creating, on SQLITE_CANTOPEN (code %i)", (errno) => {
		const bun = fakeBun({ probe: Object.assign(new Error("unable to open database file"), { errno }) });
		openBunReadOnly(bun.Database, "/x/memory.sqlite");
		expect(bun.opened).toEqual([
			{ options: { readonly: true }, closes: [false], finalized: 0 },
			{ options: { readwrite: true, create: false }, closes: [], finalized: 0 },
		]);
	});

	it("rethrows the first error when the read-write reopen fails too", () => {
		const first = Object.assign(new Error("unable to open database file"), { errno: 14 });
		const bun = fakeBun({ probe: first, reopen: Object.assign(new Error("attempt to write a readonly database"), { errno: 8 }) });
		expect(() => openBunReadOnly(bun.Database, "/x/memory.sqlite")).toThrow(first);
		expect(bun.opened).toEqual([{ options: { readonly: true }, closes: [false], finalized: 0 }]);
	});

	it("rethrows any other error as it is, without a reopen", () => {
		for (const error of [Object.assign(new Error("file is not a database"), { errno: 26 }), new TypeError("not SQLite")]) {
			const bun = fakeBun({ probe: error });
			let thrown: unknown;
			try {
				openBunReadOnly(bun.Database, "/x/memory.sqlite");
			} catch (caught) {
				thrown = caught;
			}
			expect(thrown).toBe(error);
			expect(bun.opened).toEqual([{ options: { readonly: true }, closes: [false], finalized: 0 }]);
		}
	});
});

describe("vacuumInto", () => {
	const source = () => {
		const dir = mkdtempSync(join(tmpdir(), "orrery-vacuum-"));
		dirs.push(dir);
		const db = openDatabase(join(dir, "source.sqlite"));
		db.exec("CREATE TABLE t (x TEXT)");
		db.prepare("INSERT INTO t VALUES (?)").run("kept");
		return { dir, db };
	};
	const rows = (path: string) => {
		const db = openDatabase(path, { readOnly: true });
		try {
			return db.prepare("SELECT x FROM t").all().map((row) => row.x);
		} finally {
			db.close();
		}
	};

	it("fills an empty private reservation, or a path where nothing is, and leaves no folder behind", () => {
		const { dir, db } = source();
		try {
			const reserved = join(dir, "reserved.sqlite");
			closeSync(openSync(reserved, "wx", 0o600));
			vacuumInto(db, reserved);
			const fresh = join(dir, "fresh.sqlite");
			vacuumInto(db, fresh);
			for (const path of [reserved, fresh]) {
				expect(rows(path)).toEqual(["kept"]);
				expect(statSync(path).mode & 0o777).toBe(0o600);
			}
			expect(readdirSync(dir).sort()).toEqual(["fresh.sqlite", "reserved.sqlite", "source.sqlite"]);
		} finally {
			db.close();
		}
	});

	it("never replaces a file with data, a link or a folder", () => {
		const { dir, db } = source();
		try {
			const full = join(dir, "full.sqlite");
			writeFileSync(full, "data");
			const pointed = join(dir, "pointed.sqlite");
			closeSync(openSync(pointed, "wx", 0o600));
			const link = join(dir, "link.sqlite");
			symlinkSync(pointed, link);
			const folder = join(dir, "folder.sqlite");
			mkdirSync(folder);
			for (const target of [full, link, folder]) expect(() => vacuumInto(db, target)).toThrow(/is not an empty file/);
			expect(readFileSync(full, "utf8")).toBe("data");
			expect(lstatSync(link).isSymbolicLink()).toBe(true);
			expect(statSync(pointed).size).toBe(0);
			expect(readdirSync(folder)).toEqual([]);
			expect(readdirSync(dir).sort()).toEqual(["folder.sqlite", "full.sqlite", "link.sqlite", "pointed.sqlite", "source.sqlite"]);
		} finally {
			db.close();
		}
	});
});
