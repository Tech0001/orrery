import { type ChildProcess, spawn } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeSession, forgetProcess } from "../../src/claude/pick.ts";
import { tempDir } from "../lane/support.ts";
import { cleanupDirs, testLane } from "./support.ts";

const dirs: string[] = [];
const sleepers: ChildProcess[] = [];
afterEach(() => {
	for (const sleeper of sleepers.splice(0)) sleeper.kill();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	cleanupDirs();
});

/** A live pid standing for a Claude Code process (records of dead ones are pruned). */
function livePid(): number {
	const sleeper = spawn("sleep", ["120"], { stdio: "ignore" });
	sleepers.push(sleeper);
	return sleeper.pid as number;
}

describe("claudeSession: one decision per Claude Code process", () => {
	it("the first decision is the one every later consumer reads, whatever it would pick; a process with none is refused, never none", () => {
		const t = testLane();
		const dir = tempDir("orrery-elsewhere-");
		dirs.push(dir);
		const pid = livePid();
		expect(claudeSession(t.config, { env: { ORRERY_AGENT: "Test" }, cwd: dir, pid, decide: true })).toMatchObject({ kind: "lane", by: "env", lane: { name: "Test" } });
		// A second deciding consumer of the process (the server and SessionStart racing) reads the first's decision.
		expect(claudeSession(t.config, { env: { ORRERY_AGENT: "Nobody" }, cwd: dir, pid, decide: true })).toMatchObject({ kind: "lane", lane: { name: "Test" } });
		expect(claudeSession(t.config, { env: { ORRERY_AGENT: "Nobody" }, cwd: dir, pid, decide: false })).toMatchObject({ kind: "lane", lane: { name: "Test" } });
		expect(claudeSession(t.config, { env: { ORRERY_AGENT: "Test" }, cwd: dir, pid: livePid(), decide: false })).toEqual({ kind: "undecided" });
		// Without ORRERY_AGENT nothing is recorded: the folder decides.
		expect(claudeSession(t.config, { env: {}, cwd: t.workspace, pid: livePid(), decide: true })).toMatchObject({ kind: "lane", by: "folder" });
		const records = join(t.config.dataDir, "claude-processes");
		expect(readdirSync(records)).toEqual([`${pid}.json`]);
		// Names only.
		expect(JSON.parse(readFileSync(join(records, `${pid}.json`), "utf8"))).toEqual({ kind: "lane", lane: "Test", by: "env" });
		forgetProcess(t.config, pid);
		expect(readdirSync(records)).toEqual([]);
	});

	it("records refusals and none as they were decided, and refuses a record it cannot read", () => {
		const t = testLane();
		const dir = tempDir("orrery-elsewhere-");
		dirs.push(dir);
		const [unknown, malformed] = [livePid(), livePid()];
		expect(claudeSession(t.config, { env: { ORRERY_AGENT: "Nobody" }, cwd: dir, pid: unknown, decide: true })).toEqual({ kind: "unknown", name: "Nobody" });
		expect(claudeSession(t.config, { env: { ORRERY_AGENT: "Test" }, cwd: dir, pid: unknown, decide: false })).toEqual({ kind: "unknown", name: "Nobody" });
		expect(claudeSession(t.config, { env: { ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: "x" }, cwd: dir, pid: malformed, decide: true })).toEqual({ kind: "bad-token", name: "Test" });
		const broken = livePid();
		writeFileSync(join(t.config.dataDir, "claude-processes", `${broken}.json`), "not json");
		expect(claudeSession(t.config, { env: { ORRERY_AGENT: "Test" }, cwd: dir, pid: broken, decide: true })).toEqual({ kind: "unrecorded", why: "its record is unreadable" });
	});
});
