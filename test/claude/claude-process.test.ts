import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeSession, forgetProcess } from "../../src/claude/pick.ts";
import { newToken } from "../../src/agent/pick.ts";
import { tempDir } from "../agent/support.ts";
import { cleanupDirs, testAgent } from "./support.ts";

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

/** The pid of a process that has exited (its record is a dead one's). */
const deadPid = () =>
	new Promise<number>((resolve) => {
		const exited = spawn("sleep", ["0"], { stdio: "ignore" });
		exited.on("exit", () => resolve(exited.pid as number));
	});

/** sha256 hex, as the record keeps a token. */
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

describe("claudeSession: one decision per Claude Code process", () => {
	it("the first decision is the one every later consumer under the same ORRERY_AGENT and token reads; a process with none is refused, never none", () => {
		const t = testAgent();
		const dir = tempDir("orrery-elsewhere-");
		dirs.push(dir);
		const pid = livePid();
		const env = { ORRERY_AGENT: "Test" };
		expect(claudeSession(t.config, { env, cwd: dir, pid, decide: true })).toMatchObject({ kind: "agent", by: "env", agent: { name: "Test" } });
		const records = join(t.config.dataDir, "claude-processes");
		const recorded = readFileSync(join(records, `${pid}.json`), "utf8");
		// A second deciding consumer of the process reads the first's decision, and records nothing.
		expect(claudeSession(t.config, { env, cwd: t.folder, pid, decide: true })).toMatchObject({ kind: "agent", by: "env", agent: { name: "Test" } });
		expect(readFileSync(join(records, `${pid}.json`), "utf8")).toBe(recorded);
		expect(claudeSession(t.config, { env, cwd: dir, pid, decide: false })).toMatchObject({ kind: "agent", agent: { name: "Test" } });
		expect(claudeSession(t.config, { env, cwd: dir, pid: livePid(), decide: false })).toEqual({ kind: "undecided" });
		// Without ORRERY_AGENT the decision is only that the folder decides (at each event), and the process was started
		// inside no agent's session.
		const plain = livePid();
		expect(claudeSession(t.config, { env: {}, cwd: t.folder, pid: plain, decide: true })).toMatchObject({ kind: "agent", by: "folder" });
		expect(readdirSync(records).sort()).toEqual([`${pid}.json`, `${plain}.json`].sort());
		expect(JSON.parse(readFileSync(join(records, `${plain}.json`), "utf8"))).toEqual({ agent: "", token: "", start: expect.any(String), kind: "folder" });
		forgetProcess(t.config, plain);
		// Names only, whose decision it is (ORRERY_AGENT and its token's digest, "" with none) and when its process started.
		expect(JSON.parse(recorded)).toEqual({ agent: "Test", token: "", start: expect.any(String), kind: "agent", name: "Test", by: "env" });
		forgetProcess(t.config, pid);
		expect(readdirSync(records)).toEqual([]);
		const token = newToken();
		const tokened = livePid();
		claudeSession(t.config, { env: { ORRERY_AGENT: " Test ", ORRERY_AGENT_TOKEN: token }, cwd: dir, pid: tokened, decide: true });
		expect(JSON.parse(readFileSync(join(records, `${tokened}.json`), "utf8"))).toMatchObject({ agent: "Test", token: digest(token) });
		expect(readFileSync(join(records, `${tokened}.json`), "utf8")).not.toContain(token);
	});

	it("a stale record (another identity's: a reused pid, an ancestor's): readers are refused, a decider replaces it whole", () => {
		const t = testAgent();
		const dir = tempDir("orrery-elsewhere-");
		dirs.push(dir);
		const records = join(t.config.dataDir, "claude-processes");
		mkdirSync(records, { recursive: true, mode: 0o700 });
		const pid = livePid();
		const file = join(records, `${pid}.json`);
		// Another agent's decision, left by a process whose pid this one reuses.
		writeFileSync(file, JSON.stringify({ agent: "Birch", token: "", kind: "agent", name: "Test", by: "env" }));
		expect(claudeSession(t.config, { env: { ORRERY_AGENT: "Atlas" }, cwd: dir, pid, decide: false })).toEqual({ kind: "undecided" });
		// The same name with another token, or none, is another identity too.
		writeFileSync(file, JSON.stringify({ agent: "Test", token: digest(newToken()), kind: "agent", name: "Test", by: "env" }));
		expect(claudeSession(t.config, { env: { ORRERY_AGENT: "Test" }, cwd: dir, pid, decide: false })).toEqual({ kind: "undecided" });
		expect(claudeSession(t.config, { env: { ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: newToken() }, cwd: dir, pid, decide: false })).toEqual({ kind: "undecided" });
		// A record from before identities (it names none) is stale too: a stale "none" never turns the guard off.
		writeFileSync(file, JSON.stringify({ kind: "none" }));
		expect(claudeSession(t.config, { env: { ORRERY_AGENT: "Test" }, cwd: dir, pid, decide: false })).toEqual({ kind: "undecided" });
		// A decider replaces it with its own decision.
		expect(claudeSession(t.config, { env: { ORRERY_AGENT: "Nobody" }, cwd: dir, pid, decide: true })).toEqual({ kind: "unknown", name: "Nobody" });
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ agent: "Nobody", token: "", start: expect.any(String), kind: "refused", why: "unknown", name: "Nobody" });
		expect(readdirSync(records)).toEqual([`${pid}.json`]);
	});

	it("a decider takes a record of its own identity made for another process with its pid (another start) as stale, and decides anew", () => {
		const t = testAgent();
		const records = join(t.config.dataDir, "claude-processes");
		mkdirSync(records, { recursive: true, mode: 0o700 });
		const pid = livePid();
		const file = join(records, `${pid}.json`);
		// A dead Claude Code's decision (started inside an agent's session), left under the pid this one now has.
		writeFileSync(file, JSON.stringify({ agent: "", token: "", start: "1", kind: "nested", outer: "Atlas", tool: "pi" }));
		// A reader trusts it (only a decider reads the process's start); the process's first decider replaces it.
		expect(claudeSession(t.config, { env: {}, cwd: t.folder, pid, decide: false })).toEqual({ kind: "nested", outer: "Atlas", tool: "pi" });
		expect(claudeSession(t.config, { env: {}, cwd: t.folder, pid, decide: true })).toMatchObject({ kind: "agent", by: "folder" });
		expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ kind: "folder" });
		expect(JSON.parse(readFileSync(file, "utf8")).start).not.toBe("1");
		forgetProcess(t.config, pid);
	});

	it("prunes a dead process's record, but not an empty one younger than 60 s (being made), nor young temporary or graveyard files", async () => {
		const t = testAgent();
		const dir = tempDir("orrery-elsewhere-");
		dirs.push(dir);
		const records = join(t.config.dataDir, "claude-processes");
		mkdirSync(records, { recursive: true, mode: 0o700 });
		const dead = await deadPid();
		const stale = JSON.stringify({ agent: "Test", token: "", kind: "none" });
		const [making, temporary, grave] = [`${dead}.json`, `${dead}.json.0a0b0c0d0e0f`, `${dead}.json.dead-0a0b0c0d0e0f`];
		writeFileSync(join(records, making), "");
		writeFileSync(join(records, temporary), stale);
		writeFileSync(join(records, grave), stale);
		const decide = () => claudeSession(t.config, { env: { ORRERY_AGENT: "Test" }, cwd: dir, pid: livePid(), decide: true });
		const left = () => readdirSync(records).filter((name) => name.startsWith(`${dead}.`)).sort();
		expect(decide()).toMatchObject({ kind: "agent" });
		expect(left()).toEqual([making, temporary, grave].sort());
		// Old, the empty record is a crash's leftover, and the other two are strays.
		const longAgo = new Date(Date.now() - 120_000);
		for (const name of [making, temporary, grave]) utimesSync(join(records, name), longAgo, longAgo);
		expect(decide()).toMatchObject({ kind: "agent" });
		expect(left()).toEqual([]);
		// A dead process's written record goes at once, however young.
		writeFileSync(join(records, making), stale);
		expect(decide()).toMatchObject({ kind: "agent" });
		expect(left()).toEqual([]);
	});

	it("records refusals and none as they were decided, and refuses a record it cannot read", () => {
		const t = testAgent();
		const dir = tempDir("orrery-elsewhere-");
		dirs.push(dir);
		const [unknown, malformed] = [livePid(), livePid()];
		expect(claudeSession(t.config, { env: { ORRERY_AGENT: "Nobody" }, cwd: dir, pid: unknown, decide: true })).toEqual({ kind: "unknown", name: "Nobody" });
		expect(claudeSession(t.config, { env: { ORRERY_AGENT: "Nobody" }, cwd: dir, pid: unknown, decide: false })).toEqual({ kind: "unknown", name: "Nobody" });
		expect(claudeSession(t.config, { env: { ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: "x" }, cwd: dir, pid: malformed, decide: true })).toEqual({ kind: "bad-token", name: "Test" });
		const broken = livePid();
		writeFileSync(join(t.config.dataDir, "claude-processes", `${broken}.json`), "not json");
		expect(claudeSession(t.config, { env: { ORRERY_AGENT: "Test" }, cwd: dir, pid: broken, decide: true })).toEqual({ kind: "unrecorded", why: "its record is unreadable" });
	});
});
