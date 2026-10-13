import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { backupLanes, lastBackup, restoreLane } from "../../src/lane/backup.ts";
import { parseConfig } from "../../src/lane/config.ts";
import { MemoryStore, Part } from "../../src/memory/index.ts";
import { laneConfigToml, tempDir } from "./support.ts";

const dirs: string[] = [];
const open: { close(): void }[] = [];
afterEach(() => {
	for (const handle of open.splice(0)) handle.close();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
	const dir = tempDir("orrery-backup-");
	dirs.push(dir);
	const extra = `\n[lanes.Empty]\nworkspace = ${JSON.stringify(join(dir, "ws"))}\nmodel = "faux-agent/faux-1"\n`;
	const config = parseConfig(laneConfigToml({ dataDir: join(dir, "data"), workspace: join(dir, "ws"), extra }), dir);
	const laneDir = config.lanes.get("Test")!.dir;
	mkdirSync(laneDir, { recursive: true });
	const store = MemoryStore.open(join(laneDir, "memory.sqlite"));
	open.push(store);
	store.appendBatch([
		{ kind: "user", text: "Use pnpm.", date: "2026-10-01T09:00:00.000Z" },
		{ kind: "talk", text: "Switched.", date: "2026-10-01T09:00:05.000Z" },
		{ kind: "user", text: "Codename Cedar.", date: "2026-10-01T09:01:00.000Z" },
	]);
	store.saveNode(new Part(0, 0), "user: Use pnpm.");
	const session = new DatabaseSync(join(laneDir, "session.sqlite"));
	open.push(session);
	session.exec("PRAGMA journal_mode = WAL; CREATE TABLE entries (x); INSERT INTO entries VALUES (1), (2);");
	return { config, root: join(config.dataDir, "backups"), store };
}

const day = (d: number) => new Date(2026, 9, d, 1, 30);
const mode = (path: string) => statSync(path).mode & 0o777;

describe("backupLanes", () => {
	it("snapshots both databases while the lane holds them open, and exports the memory as JSONL", () => {
		const { config, root } = setup();
		const report = backupLanes(config, { now: day(6) });
		expect(report.dir).toBe(join(root, "2026-10-06"));
		expect(report.lanes).toEqual([{ name: "Test", messages: 3, nodes: 1, files: ["memory.sqlite", "session.sqlite", "memory.jsonl"] }]);

		const snapshot = MemoryStore.openReadOnly(join(report.dir, "Test", "memory.sqlite"));
		expect(snapshot.root.map((m) => m.text)).toEqual(["Use pnpm.", "Switched.", "Codename Cedar."]);
		expect(snapshot.nodeCount).toBe(1);
		snapshot.close();
		const session = new DatabaseSync(join(report.dir, "Test", "session.sqlite"), { readOnly: true });
		expect(session.prepare("SELECT count(*) AS n FROM entries").get()).toEqual({ n: 2 });
		session.close();

		const lines = readFileSync(join(report.dir, "Test", "memory.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
		expect(lines.map((l) => l.type)).toEqual(["lane", "message", "message", "message", "node"]);
		expect(lines[1]).toEqual({ type: "message", i: 0, kind: "user", date: "2026-10-01T09:00:00.000Z", text: "Use pnpm." });
		expect(lines[4]).toEqual({ type: "node", l: 0, i: 0, text: "user: Use pnpm." });

		for (const path of [root, report.dir, join(report.dir, "Test")]) expect(mode(path)).toBe(0o700);
		for (const file of ["memory.sqlite", "session.sqlite", "memory.jsonl"]) expect(mode(join(report.dir, "Test", file))).toBe(0o600);
		expect(existsSync(join(report.dir, "Empty"))).toBe(false);
	});

	it("replaces a same-day backup and keeps only the newest dated directories", () => {
		const { config, root, store } = setup();
		for (const d of [1, 2, 3]) backupLanes(config, { now: day(d), keep: 2 });
		store.append("talk", "Noted.", "2026-10-04T09:00:00.000Z");
		backupLanes(config, { now: day(4), keep: 2 });
		const again = backupLanes(config, { now: day(4), keep: 2 });
		expect(readdirSync(root).sort()).toEqual(["2026-10-03", "2026-10-04"]);
		expect(again.lanes[0].messages).toBe(4);
		expect(backupLanes(config, { now: day(5), keep: 2 }).pruned).toEqual(["2026-10-03"]);
	});

	it("refuses a keep below 1", () => {
		const { config } = setup();
		expect(() => backupLanes(config, { keep: 0 })).toThrow(/keep/);
	});

	it("restores a day's snapshots without replaying a crashed lane's stale WAL, and refuses while the lane runs", () => {
		const { config, store } = setup();
		backupLanes(config, { now: day(1) });
		const laneDir = config.lanes.get("Test")!.dir;
		const memory = join(laneDir, "memory.sqlite");
		expect(() => restoreLane(config, "Test", { from: "2026-10-01" })).toThrow(/running|stop/i);

		// A crash after the backup: one more message, left only in the WAL.
		store.append("talk", "after the backup", "2026-10-02T09:00:00.000Z");
		const stale = join(laneDir, "..", "stale.wal");
		copyFileSync(`${memory}-wal`, stale);
		open.splice(open.indexOf(store), 1)[0].close();
		copyFileSync(stale, `${memory}-wal`);

		const report = restoreLane(config, "test", { from: "2026-10-01" });
		expect(report).toMatchObject({ lane: "Test", messages: 3, nodes: 1, files: ["memory.sqlite", "session.sqlite"] });
		const reopened = MemoryStore.open(memory);
		expect(reopened.root.map((m) => m.text)).toEqual(["Use pnpm.", "Switched.", "Codename Cedar."]);
		reopened.close();
		expect(mode(memory)).toBe(0o600);
		expect(() => restoreLane(config, "Test", { from: "2026-09-30" })).toThrow(/no backup/i);
	});
});

describe("lastBackup", () => {
	function data() {
		const dir = tempDir("orrery-last-backup-");
		dirs.push(dir);
		const config = parseConfig(`data_dir = ${JSON.stringify(join(dir, "data"))}\n[lanes.Test]\nworkspace = "/w"\ncompactor_model = "a/b"\n`, dir);
		const root = join(config.dataDir, "backups");
		const add = (day: string, lane: string) => mkdirSync(join(root, day, lane), { recursive: true });
		return { config, root, add };
	}

	it("is undefined when there is no backup, or only an unfinished .partial one", () => {
		const { config, add } = data();
		expect(lastBackup(config, "Test")).toBeUndefined();
		add("2026-10-08.partial", "Test");
		expect(lastBackup(config, "Test")).toBeUndefined();
	});

	it("picks the newest dated folder that holds the lane", () => {
		const { config, root, add } = data();
		add("2026-10-06", "Test");
		add("2026-10-07", "Test");
		add("notes", "Test");
		expect(lastBackup(config, "Test")).toEqual({ day: "2026-10-07", dir: join(root, "2026-10-07", "Test") });
	});

	it("skips a newer day the lane is missing from", () => {
		const { config, root, add } = data();
		add("2026-10-06", "Test");
		add("2026-10-08", "Other");
		add("2026-10-09.partial", "Test");
		expect(lastBackup(config, "Test")).toEqual({ day: "2026-10-06", dir: join(root, "2026-10-06", "Test") });
	});

	it("never throws: a backups path that is a file, or a day that is a file, counts as no backup", () => {
		const { config, root } = data();
		mkdirSync(config.dataDir, { recursive: true });
		writeFileSync(root, "not a folder");
		expect(lastBackup(config, "Test")).toBeUndefined();
		rmSync(root);
		mkdirSync(root);
		writeFileSync(join(root, "2026-10-08"), "not a folder");
		expect(lastBackup(config, "Test")).toBeUndefined();
	});
});
