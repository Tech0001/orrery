import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { backupAgents, lastBackup, restoreAgent } from "../../src/agent/backup.ts";
import { parseConfig } from "../../src/agent/config.ts";
import { MemoryStore, Part } from "../../src/memory/index.ts";
import { agentConfigToml, tempDir } from "./support.ts";

const dirs: string[] = [];
const open: { close(): void }[] = [];
afterEach(() => {
	for (const handle of open.splice(0)) handle.close();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
	const dir = tempDir("orrery-backup-");
	dirs.push(dir);
	const extra = `\n[agents.Empty]\nfolder = ${JSON.stringify(join(dir, "ws"))}\nmodel = "faux-agent/faux-1"\n`;
	const config = parseConfig(agentConfigToml({ dataDir: join(dir, "data"), folder: join(dir, "ws"), extra }), dir);
	const agentDir = config.agents.get("Test")!.dir;
	mkdirSync(agentDir, { recursive: true });
	const store = MemoryStore.open(join(agentDir, "memory.sqlite"));
	open.push(store);
	store.appendBatch([
		{ kind: "user", text: "Use pnpm.", date: "2026-10-01T09:00:00.000Z" },
		{ kind: "talk", text: "Switched.", date: "2026-10-01T09:00:05.000Z" },
		{ kind: "user", text: "Codename Cedar.", date: "2026-10-01T09:01:00.000Z" },
	]);
	store.saveNode(new Part(0, 0), "user: Use pnpm.");
	const session = new DatabaseSync(join(agentDir, "session.sqlite"));
	open.push(session);
	session.exec("PRAGMA journal_mode = WAL; CREATE TABLE entries (x); INSERT INTO entries VALUES (1), (2);");
	return { config, root: join(config.dataDir, "backups"), store };
}

const day = (d: number) => new Date(2026, 9, d, 1, 30);
const mode = (path: string) => statSync(path).mode & 0o777;

describe("backupAgents", () => {
	it("snapshots both databases while the agent holds them open, and exports the memory as JSONL", () => {
		const { config, root } = setup();
		const report = backupAgents(config, { now: day(6) });
		expect(report.dir).toBe(join(root, "2026-10-06"));
		expect(report.agents).toEqual([{ name: "Test", messages: 3, nodes: 1, files: ["memory.sqlite", "session.sqlite", "memory.jsonl"] }]);

		const snapshot = MemoryStore.openReadOnly(join(report.dir, "Test", "memory.sqlite"));
		expect(snapshot.root.map((m) => m.text)).toEqual(["Use pnpm.", "Switched.", "Codename Cedar."]);
		expect(snapshot.nodeCount).toBe(1);
		snapshot.close();
		const session = new DatabaseSync(join(report.dir, "Test", "session.sqlite"), { readOnly: true });
		expect(session.prepare("SELECT count(*) AS n FROM entries").get()).toEqual({ n: 2 });
		session.close();

		const lines = readFileSync(join(report.dir, "Test", "memory.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
		expect(lines.map((l) => l.type)).toEqual(["agent", "message", "message", "message", "node"]);
		expect(lines[1]).toEqual({ type: "message", i: 0, kind: "user", date: "2026-10-01T09:00:00.000Z", text: "Use pnpm." });
		expect(lines[4]).toEqual({ type: "node", l: 0, i: 0, text: "user: Use pnpm." });

		for (const path of [root, report.dir, join(report.dir, "Test")]) expect(mode(path)).toBe(0o700);
		for (const file of ["memory.sqlite", "session.sqlite", "memory.jsonl"]) expect(mode(join(report.dir, "Test", file))).toBe(0o600);
		expect(existsSync(join(report.dir, "Empty"))).toBe(false);
	});

	it("replaces a same-day backup and keeps only the newest dated directories", () => {
		const { config, root, store } = setup();
		for (const d of [1, 2, 3]) backupAgents(config, { now: day(d), keep: 2 });
		store.append("talk", "Noted.", "2026-10-04T09:00:00.000Z");
		backupAgents(config, { now: day(4), keep: 2 });
		const again = backupAgents(config, { now: day(4), keep: 2 });
		expect(readdirSync(root).sort()).toEqual(["2026-10-03", "2026-10-04"]);
		expect(again.agents[0].messages).toBe(4);
		expect(backupAgents(config, { now: day(5), keep: 2 }).pruned).toEqual(["2026-10-03"]);
	});

	it("refuses a keep below 1", () => {
		const { config } = setup();
		expect(() => backupAgents(config, { keep: 0 })).toThrow(/keep/);
	});

	it("restores a day's snapshots without replaying a crashed agent's stale WAL, and refuses while the agent runs", () => {
		const { config, store } = setup();
		backupAgents(config, { now: day(1) });
		const agentDir = config.agents.get("Test")!.dir;
		const memory = join(agentDir, "memory.sqlite");
		expect(() => restoreAgent(config, "Test", { from: "2026-10-01" })).toThrow(/running|stop/i);

		// A crash after the backup: one more message, left only in the WAL.
		store.append("talk", "after the backup", "2026-10-02T09:00:00.000Z");
		const stale = join(agentDir, "..", "stale.wal");
		copyFileSync(`${memory}-wal`, stale);
		open.splice(open.indexOf(store), 1)[0].close();
		copyFileSync(stale, `${memory}-wal`);

		const report = restoreAgent(config, "test", { from: "2026-10-01" });
		expect(report).toMatchObject({ agent: "Test", messages: 3, nodes: 1, files: ["memory.sqlite", "session.sqlite"] });
		const reopened = MemoryStore.open(memory);
		expect(reopened.root.map((m) => m.text)).toEqual(["Use pnpm.", "Switched.", "Codename Cedar."]);
		reopened.close();
		expect(mode(memory)).toBe(0o600);
		expect(() => restoreAgent(config, "Test", { from: "2026-09-30" })).toThrow(/no backup/i);
	});
});

describe("lastBackup", () => {
	function data() {
		const dir = tempDir("orrery-last-backup-");
		dirs.push(dir);
		const config = parseConfig(`data_dir = ${JSON.stringify(join(dir, "data"))}\n[agents.Test]\nfolder = "/w"\ncompactor_model = "a/b"\n`, dir);
		const root = join(config.dataDir, "backups");
		const add = (day: string, agent: string) => mkdirSync(join(root, day, agent), { recursive: true });
		return { config, root, add };
	}

	it("is undefined when there is no backup, or only an unfinished .partial one", () => {
		const { config, add } = data();
		expect(lastBackup(config, "Test")).toBeUndefined();
		add("2026-10-08.partial", "Test");
		expect(lastBackup(config, "Test")).toBeUndefined();
	});

	it("picks the newest dated folder that holds the agent", () => {
		const { config, root, add } = data();
		add("2026-10-06", "Test");
		add("2026-10-07", "Test");
		add("notes", "Test");
		expect(lastBackup(config, "Test")).toEqual({ day: "2026-10-07", dir: join(root, "2026-10-07", "Test") });
	});

	it("skips a newer day the agent is missing from", () => {
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
