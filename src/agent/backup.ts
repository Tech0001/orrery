/**
 * Backups (spec §8): a consistent snapshot of each agent's databases, taken while agents run, a plain JSONL export
 * of its memory that can be read without this code, and a copy of its instructions.md. Both databases are WAL without
 * an exclusive lock, so a read-only connection's VACUUM INTO sees one committed state and never blocks the agent.
 */

import { chmodSync, closeSync, constants, copyFileSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { openDatabase } from "../memory/sqlite.ts";
import { localIso, MemoryStore } from "../memory/index.ts";
import { findAgent, type HarnessConfig } from "./config.ts";
import { INSTRUCTIONS_FILE, instructionsPath } from "./instructions.ts";
import { writePrivate as writeAtomically } from "./private-file.ts";

export interface BackupReport {
	readonly dir: string;
	readonly agents: { readonly name: string; readonly messages: number; readonly nodes: number; readonly files: string[] }[];
	readonly pruned: string[];
}

const DATED = /^\d{4}-\d{2}-\d{2}$/;

function day(date: Date): string {
	return localIso(date).slice(0, 10);
}

function snapshot(source: string, target: string): void {
	const db = openDatabase(source, { readOnly: true });
	try {
		db.prepare("VACUUM INTO ?").run(target);
	} finally {
		db.close();
	}
	chmodSync(target, 0o600);
}

function writePrivate(path: string, content: string | Buffer): void {
	const fd = openSync(path, "w", 0o600);
	try {
		writeFileSync(fd, content);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/**
 * What is at `path`: a regular file's bytes, "missing", or "other". A symlink is never followed, and a FIFO or device
 * is never read: lstat looks first, then O_NOFOLLOW and O_NONBLOCK (a FIFO opens at once) with fstat cover a swap in
 * between. A file that can't be read throws.
 */
function regularFile(path: string): Buffer | "missing" | "other" {
	try {
		if (!lstatSync(path).isFile()) return "other";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
		throw error;
	}
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return "missing";
		if (code === "ELOOP") return "other";
		throw error;
	}
	try {
		return fstatSync(fd).isFile() ? readFileSync(fd) : "other";
	} finally {
		closeSync(fd);
	}
}

function exportMemory(database: string, target: string, agent: string, now: Date): { messages: number; nodes: number } {
	const store = MemoryStore.openReadOnly(database);
	try {
		const nodes = [...store.nodes()].sort((a, b) => a.l - b.l || a.i - b.i);
		const lines = [
			JSON.stringify({ type: "agent", name: agent, exported: localIso(now) }),
			...store.root.map((m) => JSON.stringify({ type: "message", i: m.i, kind: m.kind, date: m.date, text: m.text })),
			...nodes.map((n) => JSON.stringify({ type: "node", l: n.l, i: n.i, text: n.text })),
		];
		writePrivate(target, `${lines.join("\n")}\n`);
		return { messages: store.root.length, nodes: nodes.length };
	} finally {
		store.close();
	}
}

/** Writes `<data_dir>/backups/<YYYY-MM-DD>/<Name>/`, replacing that day's backup, and keeps the newest `keep` days. */
export function backupAgents(config: HarnessConfig, options: { now?: Date; keep?: number } = {}): BackupReport {
	const now = options.now ?? new Date();
	const keep = options.keep ?? 14;
	if (!Number.isInteger(keep) || keep < 1) throw new RangeError("keep must be a whole number of at least 1");
	const root = join(config.dataDir, "backups");
	mkdirSync(root, { recursive: true, mode: 0o700 });
	chmodSync(root, 0o700);
	const dir = join(root, day(now));
	const partial = `${dir}.partial`;
	rmSync(partial, { recursive: true, force: true });
	mkdirSync(partial, { mode: 0o700 });
	const agents: BackupReport["agents"] = [];
	for (const agent of config.agents.values()) {
		const memory = join(agent.dir, "memory.sqlite");
		if (!existsSync(memory)) continue;
		const out = join(partial, agent.name);
		mkdirSync(out, { mode: 0o700 });
		const files = ["memory.sqlite"];
		snapshot(memory, join(out, "memory.sqlite"));
		const session = join(agent.dir, "session.sqlite");
		if (existsSync(session)) {
			snapshot(session, join(out, "session.sqlite"));
			files.push("session.sqlite");
		}
		const counts = exportMemory(join(out, "memory.sqlite"), join(out, "memory.jsonl"), agent.name, now);
		files.push("memory.jsonl");
		const instructions = regularFile(instructionsPath(agent.dir));
		if (Buffer.isBuffer(instructions)) {
			writePrivate(join(out, INSTRUCTIONS_FILE), instructions);
			files.push(INSTRUCTIONS_FILE);
		}
		agents.push({ name: agent.name, ...counts, files });
	}
	rmSync(dir, { recursive: true, force: true });
	renameSync(partial, dir);
	const dated = readdirSync(root)
		.filter((entry) => DATED.test(entry))
		.sort();
	const pruned = dated.slice(0, Math.max(0, dated.length - keep));
	for (const old of pruned) rmSync(join(root, old), { recursive: true, force: true });
	return { dir, agents, pruned };
}

/** Where an agent's newest backup is: its day and its folder. */
export interface BackupFound {
	readonly day: string;
	readonly dir: string;
}

/**
 * Finds agents' newest backups: one read of `<data_dir>/backups/`, then one per day folder, only as far back as an agent
 * needs. A `.partial` folder (a backup still being written) never counts. It never throws: what it can't read counts
 * as no backup.
 */
export function backupFinder(config: HarnessConfig): (agent: string) => BackupFound | undefined {
	const root = join(config.dataDir, "backups");
	let days: string[];
	try {
		days = readdirSync(root)
			.filter((entry) => DATED.test(entry))
			.sort()
			.reverse();
	} catch {
		return () => undefined;
	}
	const agentsOn = new Map<string, Set<string>>();
	const agentsIn = (day: string): Set<string> => {
		let names = agentsOn.get(day);
		if (names === undefined) {
			try {
				names = new Set(readdirSync(join(root, day), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name));
			} catch {
				names = new Set();
			}
			agentsOn.set(day, names);
		}
		return names;
	};
	return (agent) => {
		for (const day of days) if (agentsIn(day).has(agent)) return { day, dir: join(root, day, agent) };
		return undefined;
	};
}

/** The newest `<data_dir>/backups/<YYYY-MM-DD>/` that holds `agent` (its day and the agent's folder in it), or undefined. Never throws. */
export function lastBackup(config: HarnessConfig, agent: string): BackupFound | undefined {
	return backupFinder(config)(agent);
}

export interface RestoreReport {
	readonly agent: string;
	readonly from: string;
	readonly messages: number;
	readonly nodes: number;
	readonly files: string[];
	/**
	 * The backup's instructions.md: "restored" (the agent had none: no file, or a blank one), "kept" (the agent has its
	 * own, which stays; the backup's copy is in `from`), or "none" (the backup holds none, or only a blank one).
	 */
	readonly instructions: "restored" | "kept" | "none";
}

/**
 * Puts a backup back in place of a stopped agent's databases. The agent's -wal/-shm files are removed first: replayed
 * onto an older snapshot they would mix two states of the database. Backups snapshot memory before session, so the
 * session is never older than the memory's projection cursor. The backup's instructions.md goes back only where the
 * agent has none: instructions written since the backup are the person's, and newer.
 */
export function restoreAgent(config: HarnessConfig, agentName: string, options: { from: string }): RestoreReport {
	const agent = findAgent(config, agentName);
	if (agent.remote !== undefined) throw new Error(`${agent.name} keeps its memory on remote ${agent.remote}; run orrery agent local ${agent.name} first`);
	const from = DATED.test(options.from) ? join(config.dataDir, "backups", options.from, agent.name) : options.from;
	if (!isAbsolute(from) && !DATED.test(options.from)) throw new Error(`--from must be a date (YYYY-MM-DD) or an absolute directory`);
	if (!existsSync(join(from, "memory.sqlite"))) throw new Error(`No backup of ${agent.name} at ${from}`);
	const memory = join(agent.dir, "memory.sqlite");
	if (existsSync(memory)) {
		try {
			MemoryStore.open(memory).close(); // takes and releases the writer lock: refused while the agent runs
		} catch (error) {
			if (/already open/i.test(error instanceof Error ? error.message : String(error))) {
				throw new Error(`${agent.name} is running; stop it first (sudo systemctl stop orrery@${agent.name})`);
			}
			// Anything else (a damaged store) is what the restore replaces.
		}
	}
	mkdirSync(agent.dir, { recursive: true, mode: 0o700 });
	for (const name of ["memory.sqlite", "session.sqlite"]) {
		for (const suffix of ["", "-wal", "-shm"]) rmSync(join(agent.dir, `${name}${suffix}`), { force: true });
	}
	rmSync(join(agent.dir, "status.json"), { force: true });
	const files: string[] = [];
	for (const name of ["memory.sqlite", "session.sqlite"]) {
		if (!existsSync(join(from, name))) continue;
		copyFileSync(join(from, name), join(agent.dir, name));
		chmodSync(join(agent.dir, name), 0o600);
		files.push(name);
	}
	const instructions = restoreInstructions(join(from, INSTRUCTIONS_FILE), instructionsPath(agent.dir));
	if (instructions === "restored") files.push(INSTRUCTIONS_FILE);
	const store = MemoryStore.openReadOnly(memory);
	try {
		return { agent: agent.name, from, messages: store.root.length, nodes: store.nodeCount, files, instructions };
	} finally {
		store.close();
	}
}

const blank = (bytes: Buffer): boolean => bytes.toString("utf8").trim() === "";

/** Puts `saved` (a backup's instructions.md) at `own` when the agent has none there: no file, or a blank one. */
function restoreInstructions(saved: string, own: string): RestoreReport["instructions"] {
	const copy = regularFile(saved);
	if (!Buffer.isBuffer(copy) || blank(copy)) return "none";
	const current = regularFile(own);
	if (current !== "missing" && !(Buffer.isBuffer(current) && blank(current))) return "kept";
	writeAtomically(own, copy);
	return "restored";
}
