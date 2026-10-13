import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, sqliteBackend } from "../../src/memory/sqlite.ts";

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
