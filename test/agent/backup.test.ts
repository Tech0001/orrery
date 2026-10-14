import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { backupAgents, lastBackup, restoreAgent } from "../../src/agent/backup.ts";
import { parseConfig } from "../../src/agent/config.ts";
import { writeInstructions } from "../../src/agent/instructions.ts";
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

describe("instructions.md in backups", () => {
	/** setup(), with the agent's instructions written; `close` closes its store, as a stopped agent's is. */
	function stopped(instructions?: string) {
		const t = setup();
		const agentDir = t.config.agents.get("Test")!.dir;
		if (instructions !== undefined) writeInstructions(agentDir, instructions);
		const close = () => open.splice(open.indexOf(t.store), 1)[0].close();
		return { ...t, agentDir, close };
	}

	it("backs it up (0600) and lists it; an agent without one has none in its backup", () => {
		const { config, root, agentDir } = stopped("Atlas reviews pull requests.\n");
		const report = backupAgents(config, { now: day(6) });
		expect(report.agents[0].files).toEqual(["memory.sqlite", "session.sqlite", "memory.jsonl", "instructions.md"]);
		const copy = join(root, "2026-10-06", "Test", "instructions.md");
		expect(readFileSync(copy, "utf8")).toBe("Atlas reviews pull requests.\n");
		expect(mode(copy)).toBe(0o600);

		rmSync(join(agentDir, "instructions.md"));
		const again = backupAgents(config, { now: day(7) });
		expect(again.agents[0].files).toEqual(["memory.sqlite", "session.sqlite", "memory.jsonl"]);
		expect(existsSync(join(root, "2026-10-07", "Test", "instructions.md"))).toBe(false);
	});

	it("puts it back when the agent has none (missing or blank), and says so", () => {
		const { config, agentDir, close } = stopped("Atlas reviews pull requests.\n");
		backupAgents(config, { now: day(1) });
		close();
		const path = join(agentDir, "instructions.md");
		rmSync(path);
		const report = restoreAgent(config, "Test", { from: "2026-10-01" });
		expect(report.instructions).toBe("restored");
		expect(report.files).toEqual(["memory.sqlite", "session.sqlite", "instructions.md"]);
		expect(readFileSync(path, "utf8")).toBe("Atlas reviews pull requests.\n");
		expect(mode(path)).toBe(0o600);

		writeFileSync(path, " \n\t\n");
		expect(restoreAgent(config, "Test", { from: "2026-10-01" }).instructions).toBe("restored");
		expect(readFileSync(path, "utf8")).toBe("Atlas reviews pull requests.\n");
	});

	it("keeps the agent's own instructions, and leaves the backup's copy where it is", () => {
		const { config, root, agentDir, close } = stopped("Atlas reviews pull requests.\n");
		backupAgents(config, { now: day(1) });
		close();
		writeInstructions(agentDir, "Atlas reviews pull requests and releases.\n");
		const report = restoreAgent(config, "Test", { from: "2026-10-01" });
		expect(report.instructions).toBe("kept");
		expect(report.files).toEqual(["memory.sqlite", "session.sqlite"]);
		expect(readFileSync(join(agentDir, "instructions.md"), "utf8")).toBe("Atlas reviews pull requests and releases.\n");
		expect(readFileSync(join(root, "2026-10-01", "Test", "instructions.md"), "utf8")).toBe("Atlas reviews pull requests.\n");
	});

	it("is none when the backup holds no instructions (one taken before backups kept them)", () => {
		const { config, agentDir, close } = stopped();
		backupAgents(config, { now: day(1) });
		close();
		const report = restoreAgent(config, "Test", { from: "2026-10-01" });
		expect(report.instructions).toBe("none");
		expect(existsSync(join(agentDir, "instructions.md"))).toBe(false);
	});

	it("skips a symlink in its place: never followed, on backup or on restore", () => {
		const { config, root, agentDir, close } = stopped();
		const outside = join(agentDir, "..", "outside.md");
		writeFileSync(outside, "Not the agent's.\n");
		symlinkSync(outside, join(agentDir, "instructions.md"));
		const report = backupAgents(config, { now: day(1) });
		expect(report.agents[0].files).not.toContain("instructions.md");
		expect(existsSync(join(root, "2026-10-01", "Test", "instructions.md"))).toBe(false);

		// A backup folder given with --from whose instructions.md is a symlink: not read, not put back.
		close();
		rmSync(join(agentDir, "instructions.md"));
		const from = join(root, "2026-10-01", "Test");
		symlinkSync(outside, join(from, "instructions.md"));
		expect(restoreAgent(config, "Test", { from }).instructions).toBe("none");
		expect(existsSync(join(agentDir, "instructions.md"))).toBe(false);
	});

	// mkfifo is a POSIX tool: where it is missing there is no FIFO to test with.
	it.skipIf(spawnSync("mkfifo", ["--version"]).error !== undefined)("skips a FIFO in its place, at once (never a wait for a writer), and leaves it there on restore", () => {
		const { config, root, agentDir, close } = stopped();
		const fifo = join(agentDir, "instructions.md");
		expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
		const report = backupAgents(config, { now: day(1) });
		expect(report.agents[0].files).not.toContain("instructions.md");
		expect(existsSync(join(root, "2026-10-01", "Test", "instructions.md"))).toBe(false);

		// A backup that holds instructions, restored over a FIFO: something is there that is not "none", so it stays.
		close();
		writeFileSync(join(root, "2026-10-01", "Test", "instructions.md"), "Atlas reviews pull requests.\n");
		expect(restoreAgent(config, "Test", { from: "2026-10-01" }).instructions).toBe("kept");
		expect(lstatSync(fifo).isFIFO()).toBe(true);
	});

	// Root reads a mode-000 file anyway: there is nothing unreadable to test with.
	it.skipIf(process.getuid?.() === 0)("leaves out an instructions.md it can't read, with a warning naming the agent and why; the memory is still backed up", () => {
		const { config, root, agentDir } = stopped("Atlas reviews pull requests.\n");
		const path = join(agentDir, "instructions.md");
		chmodSync(path, 0o000);
		try {
			const report = backupAgents(config, { now: day(1) });
			expect(report.agents).toEqual([{ name: "Test", messages: 3, nodes: 1, files: ["memory.sqlite", "session.sqlite", "memory.jsonl"] }]);
			expect(report.warnings).toEqual([expect.stringMatching(/^Test: instructions\.md was not backed up \(EACCES/)]);
			expect(existsSync(join(root, "2026-10-01", "Test", "memory.sqlite"))).toBe(true);
			expect(existsSync(join(root, "2026-10-01", "Test", "instructions.md"))).toBe(false);
		} finally {
			chmodSync(path, 0o600);
		}
		expect(backupAgents(config, { now: day(2) }).warnings).toEqual([]);
	});

	it("backs up an agent with instructions but no memory yet: a folder with just that file", () => {
		const { config, root } = stopped();
		const empty = config.agents.get("Empty")!.dir;
		writeInstructions(empty, "Empty answers questions.\n");
		const report = backupAgents(config, { now: day(1) });
		expect(report.agents).toEqual([
			{ name: "Test", messages: 3, nodes: 1, files: ["memory.sqlite", "session.sqlite", "memory.jsonl"] },
			{ name: "Empty", messages: 0, nodes: 0, files: ["instructions.md"] },
		]);
		expect(readdirSync(join(root, "2026-10-01", "Empty"))).toEqual(["instructions.md"]);
		expect(mode(join(root, "2026-10-01", "Empty", "instructions.md"))).toBe(0o600);
		expect(lastBackup(config, "Empty")?.day).toBe("2026-10-01");
	});

	it("restores an instructions-only backup: the instructions go back as before, and the agent's memory is left as it is", () => {
		const { config } = stopped();
		const empty = config.agents.get("Empty")!.dir;
		writeInstructions(empty, "Empty answers questions.\n");
		backupAgents(config, { now: day(1) });
		rmSync(join(empty, "instructions.md"));

		const report = restoreAgent(config, "Empty", { from: "2026-10-01" });
		expect(report).toEqual({ agent: "Empty", from: expect.stringContaining("2026-10-01"), memory: false, messages: 0, nodes: 0, files: ["instructions.md"], instructions: "restored" });
		expect(readFileSync(join(empty, "instructions.md"), "utf8")).toBe("Empty answers questions.\n");
		expect(existsSync(join(empty, "memory.sqlite"))).toBe(false);

		// Opened since the backup: its memory stays, and so do its own instructions.
		const store = MemoryStore.open(join(empty, "memory.sqlite"));
		store.append("user", "Since the backup.", "2026-10-02T09:00:00.000Z");
		store.close();
		writeInstructions(empty, "Empty answers questions, briefly.\n");
		expect(restoreAgent(config, "Empty", { from: "2026-10-01" })).toMatchObject({ memory: false, files: [], instructions: "kept" });
		const after = MemoryStore.openReadOnly(join(empty, "memory.sqlite"));
		expect(after.root.map((m) => m.text)).toEqual(["Since the backup."]);
		after.close();
		expect(readFileSync(join(empty, "instructions.md"), "utf8")).toBe("Empty answers questions, briefly.\n");
	});

	it("still says there is no backup where a folder holds neither memory nor instructions", () => {
		const { config, root } = stopped();
		backupAgents(config, { now: day(1) });
		mkdirSync(join(root, "2026-10-01", "Empty"));
		expect(() => restoreAgent(config, "Empty", { from: "2026-10-01" })).toThrow(/No backup of Empty/);
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
