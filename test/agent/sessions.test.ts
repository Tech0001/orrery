import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../../src/agent/config.ts";
import { orreryHome } from "../../src/agent/home.ts";
import { claimToken, newToken } from "../../src/agent/pick.ts";
import { writePrivate } from "../../src/agent/private-file.ts";
import {
	ALLOWED_INSIDE,
	ancestors,
	forgetSession,
	insideSession,
	liveSession,
	processStart,
	recordSession,
	type SessionDeps,
} from "../../src/agent/sessions.ts";
import { configContent } from "../../src/opencode/options.ts";

const SESSIONS = new URL("../../src/agent/sessions.ts", import.meta.url).pathname;
const CONFIG = new URL("../../src/agent/config.ts", import.meta.url).pathname;
const real = process.platform === "linux" || process.platform === "darwin";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "orrery-sessions-"));
	dirs.push(dir);
	return dir;
}

/** Atlas and Birch, with their memory under `<root>/data`. */
function world() {
	const root = temp();
	const agent = (name: string) => `[agents.${name}]\ncompactor_model = "openai/gpt-6.1-sol"\n`;
	const toml = `data_dir = ${JSON.stringify(join(root, "data"))}\n${agent("Atlas")}${agent("Birch")}`;
	return { root, toml, config: parseConfig(toml, root) };
}

const hostFile = (dataDir: string, pid: number) => join(dataDir, "session-hosts", `${pid}.json`);

type Table = Record<number, { readonly ppid: number; readonly start: string }>;

/** A /proc/<pid>/stat line: the name holds spaces and parentheses, field 4 is the parent, field 22 the start time. */
const statLine = (pid: number, ppid: number, start: string) => `${pid} (a (b) c) S ${ppid} ${Array(17).fill("0").join(" ")} ${start} 4096 0\n`;

/** A fake Linux: the table read through a fake /proc; a process lives while the table has it. */
function linux(table: Table, from?: number): SessionDeps {
	return {
		platform: "linux",
		proc: (pid) => (table[pid] === undefined ? undefined : statLine(pid, table[pid].ppid, table[pid].start)),
		alive: (pid) => table[pid] !== undefined,
		...(from === undefined ? {} : { from }),
	};
}

/** A fake macOS: the table read through a fake ps, each call kept. */
function darwin(table: Table): SessionDeps & { readonly calls: string[][] } {
	const calls: string[][] = [];
	return {
		calls,
		platform: "darwin",
		alive: (pid) => table[pid] !== undefined,
		ps: (args) => {
			calls.push([...args]);
			if (args[0] === "-A") return Object.entries(table).map(([pid, row]) => `  ${pid}   ${row.ppid}`).join("\n") + "\n";
			const row = table[Number(args.at(-1))];
			return row === undefined ? undefined : `${row.start}\n`;
		},
	};
}

/** 50 → 40 → 30 → 1, each started at its own time, and 77 (a launcher's tool, say) under 1. */
const chain = (): Table => ({ 1: { ppid: 0, start: "1" }, 30: { ppid: 1, start: "300" }, 40: { ppid: 30, start: "400" }, 50: { ppid: 40, start: "500" }, 77: { ppid: 1, start: "770" } });

describe("session records", () => {
	it.skipIf(!real)("records this process with its start time, 0600 in a 0700 folder, and finds it live", () => {
		const dir = temp();
		expect(recordSession(dir, { agent: "Atlas", tool: "pi", pid: process.pid })).toBe(true);
		const start = processStart(process.pid);
		expect(start).toMatch(/\S/);
		expect(liveSession(dir, process.pid)).toEqual({ agent: "Atlas", tool: "pi", pid: process.pid, start });
		expect(statSync(hostFile(dir, process.pid)).mode & 0o777).toBe(0o600);
		expect(statSync(join(dir, "session-hosts")).mode & 0o777).toBe(0o700);
		forgetSession(dir, process.pid);
		expect(existsSync(hostFile(dir, process.pid))).toBe(false);
		expect(liveSession(dir, process.pid)).toBeUndefined();
		// Forgetting what is gone is fine.
		forgetSession(dir, process.pid);
	});

	it("keeps a Codex session's id", () => {
		const dir = temp();
		const deps = linux(chain());
		expect(recordSession(dir, { agent: "Birch", tool: "codex", pid: 30, codexSession: "019a-thread" }, deps)).toBe(true);
		expect(liveSession(dir, 30, deps)).toEqual({ agent: "Birch", tool: "codex", pid: 30, start: "300", codexSession: "019a-thread" });
	});

	it("a record whose pid now names a process started at another time (a reused pid) is no session, and goes", () => {
		const dir = temp();
		const table = chain();
		expect(recordSession(dir, { agent: "Atlas", tool: "pi", pid: 30 }, linux(table))).toBe(true);
		table[30] = { ppid: 1, start: "301" };
		expect(liveSession(dir, 30, linux(table))).toBeUndefined();
		expect(existsSync(hostFile(dir, 30))).toBe(false);
	});

	it("a record whose process is gone is no session, and goes", () => {
		const dir = temp();
		const table = chain();
		expect(recordSession(dir, { agent: "Atlas", tool: "omp", pid: 40 }, linux(table))).toBe(true);
		delete table[40];
		expect(liveSession(dir, 40, linux(table))).toBeUndefined();
		expect(existsSync(hostFile(dir, 40))).toBe(false);
	});

	it("makes no record of a process whose start can't be read; a live one whose start can't be read now keeps its record", () => {
		const dir = temp();
		const table = chain();
		const blind: SessionDeps = { ...linux(table), proc: () => undefined };
		expect(recordSession(dir, { agent: "Atlas", tool: "pi", pid: 30 }, blind)).toBe(false);
		expect(existsSync(hostFile(dir, 30))).toBe(false);
		expect(recordSession(dir, { agent: "Atlas", tool: "pi", pid: 30 }, linux(table))).toBe(true);
		expect(liveSession(dir, 30, blind)).toBeUndefined();
		expect(existsSync(hostFile(dir, 30))).toBe(true);
		expect(liveSession(dir, 30, linux(table))).toMatchObject({ agent: "Atlas" });
	});

	it("a file that is no record: gone when its process is, kept while it lives; another pid's record is no record of this one", () => {
		const dir = temp();
		const table = chain();
		mkdirSync(join(dir, "session-hosts"), { recursive: true });
		writeFileSync(hostFile(dir, 30), "not json");
		expect(liveSession(dir, 30, linux(table))).toBeUndefined();
		expect(existsSync(hostFile(dir, 30))).toBe(true);
		delete table[30];
		expect(liveSession(dir, 30, linux(table))).toBeUndefined();
		expect(existsSync(hostFile(dir, 30))).toBe(false);
		writeFileSync(hostFile(dir, 40), JSON.stringify({ agent: "Atlas", tool: "pi", pid: 50, start: "500" }));
		expect(liveSession(dir, 40, linux(table))).toBeUndefined();
	});

	it("a new record takes out the dead ones beside it", () => {
		const dir = temp();
		const table = chain();
		for (const pid of [30, 40]) expect(recordSession(dir, { agent: "Atlas", tool: "pi", pid }, linux(table))).toBe(true);
		delete table[40];
		expect(recordSession(dir, { agent: "Birch", tool: "pi", pid: 50 }, linux(table))).toBe(true);
		expect(existsSync(hostFile(dir, 30))).toBe(true);
		expect(existsSync(hostFile(dir, 40))).toBe(false);
	});

	it("on macOS the start time is ps's lstart", () => {
		const dir = temp();
		const table: Table = { 1: { ppid: 0, start: "Thu Oct 15 08:00:00 2026" }, 30: { ppid: 1, start: "Sat Oct 18 10:00:00 2026" } };
		const mac = darwin(table);
		expect(recordSession(dir, { agent: "Atlas", tool: "claude-code", pid: 30 }, mac)).toBe(true);
		expect(mac.calls).toContainEqual(["-o", "lstart=", "-p", "30"]);
		expect(liveSession(dir, 30, mac)).toEqual({ agent: "Atlas", tool: "claude-code", pid: 30, start: "Sat Oct 18 10:00:00 2026" });
		expect(processStart(30, { platform: "win32" })).toBeUndefined();
	});

	it.skipIf(!real)("a real process's start time stays the same, and a gone process has none", () => {
		expect(processStart(process.pid)).toBe(processStart(process.pid));
		const gone = spawnSync(process.execPath, ["-e", ""]).pid as number;
		expect(processStart(gone)).toBeUndefined();
	});
});

describe("ancestors", () => {
	it("walks a fake /proc from 50 to 30, nearest first, without 50 itself or pid 1", () => {
		expect(ancestors(50, linux(chain()))).toEqual([40, 30]);
		expect(ancestors(1, linux(chain()))).toEqual([]);
		// A process that can't be read ends the walk.
		expect(ancestors(99, linux(chain()))).toEqual([]);
	});

	it("asks macOS's ps once for the whole chain", () => {
		const table: Table = { 1: { ppid: 0, start: "-" } };
		for (let pid = 10; pid <= 70; pid += 10) table[pid] = { ppid: pid === 10 ? 1 : pid - 10, start: "-" };
		const mac = darwin(table);
		expect(ancestors(70, mac)).toEqual([60, 50, 40, 30, 20, 10]);
		expect(mac.calls).toEqual([["-A", "-o", "pid=,ppid="]]);
	});

	it("stops after 64 steps, and at a loop", () => {
		const deep: Table = { 1: { ppid: 0, start: "-" } };
		for (let pid = 2; pid <= 200; pid++) deep[pid] = { ppid: pid - 1, start: "-" };
		expect(ancestors(200, linux(deep))).toHaveLength(64);
		expect(ancestors(5, linux({ 5: { ppid: 6, start: "-" }, 6: { ppid: 7, start: "-" }, 7: { ppid: 6, start: "-" } }))).toEqual([6, 7]);
	});

	it.skipIf(!real)("starts at this process's parent", () => {
		expect(ancestors()[0]).toBe(process.ppid);
	});
});

describe("insideSession", () => {
	it("finds the recorded ancestor in a given data folder, and only there", () => {
		const [a, b] = [temp(), temp()];
		const table = chain();
		expect(recordSession(a, { agent: "Atlas", tool: "pi", pid: 30 }, linux(table))).toBe(true);
		expect(insideSession([a], {}, undefined, linux(table, 50))).toEqual({ agent: "Atlas", tool: "pi", via: "ancestry", dataDir: a });
		forgetSession(a, 30);
		expect(recordSession(b, { agent: "Atlas", tool: "pi", pid: 30 }, linux(table))).toBe(true);
		expect(insideSession([a], {}, undefined, linux(table, 50))).toBeUndefined();
	});

	it("the nearest recorded ancestor wins, in whichever data folder; a stale one is passed over", () => {
		const [a, b] = [temp(), temp()];
		const table = chain();
		expect(recordSession(a, { agent: "Atlas", tool: "pi", pid: 30 }, linux(table))).toBe(true);
		expect(recordSession(b, { agent: "Birch", tool: "claude-code", pid: 40 }, linux(table))).toBe(true);
		expect(insideSession([a, b], {}, undefined, linux(table, 50))).toEqual({ agent: "Birch", tool: "claude-code", via: "ancestry", dataDir: b });
		table[40] = { ppid: 30, start: "401" };
		expect(insideSession([a, b], {}, undefined, linux(table, 50))).toEqual({ agent: "Atlas", tool: "pi", via: "ancestry", dataDir: a });
	});

	it("ancestry wins over markers", () => {
		const { config } = world();
		const table = chain();
		const token = newToken();
		claimToken(join(config.dataDir, "agents", "Atlas"), token, 77, linux(table).alive);
		expect(recordSession(config.dataDir, { agent: "Birch", tool: "pi", pid: 40 }, linux(table))).toBe(true);
		expect(insideSession([config.dataDir], { ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: token }, config, linux(table, 50))).toMatchObject({ agent: "Birch", via: "ancestry" });
	});

	it.skipIf(!real)("a real child process finds this one's record (Linux and macOS)", () => {
		const { root, toml } = world();
		const dir = join(root, "data");
		const script = `Promise.all([import(${JSON.stringify(SESSIONS)}), import(${JSON.stringify(CONFIG)})]).then(([s, c]) => process.stdout.write(JSON.stringify(s.insideSession([${JSON.stringify(dir)}], {}, c.parseConfig(${JSON.stringify(toml)}, ${JSON.stringify(root)})) ?? null)))`;
		const child = () => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "-e", script], { encoding: "utf8" });
		expect(recordSession(dir, { agent: "Atlas", tool: "pi", pid: process.pid })).toBe(true);
		const inside = child();
		expect(JSON.parse(inside.stdout), inside.stderr).toEqual({ agent: "Atlas", tool: "pi", via: "ancestry", dataDir: dir });
		forgetSession(dir, process.pid);
		const outside = child();
		expect(JSON.parse(outside.stdout), outside.stderr).toBeNull();
	});
});

describe("insideSession by markers", () => {
	it("ORRERY_AGENT with its token claimed by a live process is that agent; unclaimed, or claimed by a dead one, is a session of unknown identity", () => {
		const { config } = world();
		const table = chain();
		const deps = linux(table, 50);
		const token = newToken();
		claimToken(join(config.dataDir, "agents", "Atlas"), token, 77, deps.alive);
		expect(insideSession([config.dataDir], { ORRERY_AGENT: "atlas", ORRERY_AGENT_TOKEN: token }, config, deps)).toEqual({ agent: "Atlas", tool: undefined, via: "marker", dataDir: config.dataDir });
		expect(insideSession([config.dataDir], { ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: newToken() }, config, deps)).toEqual({ agent: undefined, tool: undefined, via: "marker", dataDir: config.dataDir });
		expect(insideSession([config.dataDir], { ORRERY_AGENT: "Atlas" }, config, deps)).toMatchObject({ agent: undefined, via: "marker" });
		// Birch's claims hold no Atlas token.
		expect(insideSession([config.dataDir], { ORRERY_AGENT: "Birch", ORRERY_AGENT_TOKEN: token }, config, deps)).toMatchObject({ agent: undefined, via: "marker" });
		delete table[77];
		expect(insideSession([config.dataDir], { ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: token }, config, deps)).toMatchObject({ agent: undefined, via: "marker" });
	});

	it("a claimed ORRERY_AGENT takes its tool from the claimant's record", () => {
		const { config } = world();
		const table = chain();
		const token = newToken();
		claimToken(join(config.dataDir, "agents", "Atlas"), token, 77, linux(table).alive);
		expect(recordSession(config.dataDir, { agent: "Atlas", tool: "omp", pid: 77 }, linux(table))).toBe(true);
		expect(insideSession([config.dataDir], { ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: token }, config, linux(table, 50))).toEqual({ agent: "Atlas", tool: "omp", via: "marker", dataDir: config.dataDir });
	});

	it("an ORRERY_AGENT that names no configured agent is no marker; with no config there are none", () => {
		const { config } = world();
		const deps = linux(chain(), 50);
		expect(insideSession([config.dataDir], { ORRERY_AGENT: "Ghost", ORRERY_AGENT_TOKEN: newToken() }, config, deps)).toBeUndefined();
		expect(insideSession([config.dataDir], { ORRERY_AGENT: "Atlas" }, undefined, deps)).toBeUndefined();
	});

	it("CODEX_THREAD_ID or CODEX_SESSION_ID naming a live record's Codex session is that agent", () => {
		const { config } = world();
		const table = chain();
		expect(recordSession(config.dataDir, { agent: "Birch", tool: "codex", pid: 77, codexSession: "019a-thread" }, linux(table))).toBe(true);
		const deps = linux(table, 50);
		const birch = { agent: "Birch", tool: "codex", via: "marker", dataDir: config.dataDir };
		expect(insideSession([config.dataDir], { CODEX_THREAD_ID: "019a-thread" }, config, deps)).toEqual(birch);
		expect(insideSession([config.dataDir], { CODEX_SESSION_ID: "019a-thread" }, config, deps)).toEqual(birch);
		expect(insideSession([config.dataDir], { CODEX_THREAD_ID: "019b-other" }, config, deps)).toBeUndefined();
		delete table[77];
		expect(insideSession([config.dataDir], { CODEX_THREAD_ID: "019a-thread" }, config, deps)).toBeUndefined();
	});

	it("CLAUDE_PID naming a live Claude Code record is that agent; one naming another tool's record, or none, is no marker", () => {
		const { config } = world();
		const table = chain();
		const deps = linux(table, 50);
		expect(recordSession(config.dataDir, { agent: "Atlas", tool: "claude-code", pid: 77 }, linux(table))).toBe(true);
		expect(insideSession([config.dataDir], { CLAUDE_PID: "77" }, config, deps)).toEqual({ agent: "Atlas", tool: "claude-code", via: "marker", dataDir: config.dataDir });
		forgetSession(config.dataDir, 77);
		expect(recordSession(config.dataDir, { agent: "Atlas", tool: "pi", pid: 77 }, linux(table))).toBe(true);
		expect(insideSession([config.dataDir], { CLAUDE_PID: "77" }, config, deps)).toBeUndefined();
		expect(insideSession([config.dataDir], { CLAUDE_PID: "1234" }, config, deps)).toBeUndefined();
	});

	it("OPENCODE_CONFIG_CONTENT carrying Orrery's plugin for a configured agent: that agent when its token file's token is claimed", () => {
		const { root, config } = world();
		const table = chain();
		const deps = linux(table, 50);
		const env = { ORRERY_HOME: join(root, "home") };
		const token = newToken();
		const tokenFile = join(orreryHome(env), "tokens", "opencode-123-0123456789ab");
		writePrivate(tokenFile, token);
		const plugin = join(root, "app", "current", "extensions", "opencode");
		const content = (agent: string, folder = plugin) => configContent(folder, { agent, tokenFile });
		expect(insideSession([config.dataDir], { ...env, OPENCODE_CONFIG_CONTENT: content("Atlas") }, config, deps)).toEqual({ agent: undefined, tool: "opencode", via: "marker", dataDir: config.dataDir });
		claimToken(join(config.dataDir, "agents", "Atlas"), token, 77, deps.alive);
		expect(insideSession([config.dataDir], { ...env, OPENCODE_CONFIG_CONTENT: content("Atlas") }, config, deps)).toEqual({ agent: "Atlas", tool: "opencode", via: "marker", dataDir: config.dataDir });
		// Among the person's own plugins, and from a checkout's plugin folder, alike.
		const theirs = JSON.stringify({ plugins: ["their-plugin", ...JSON.parse(content("Atlas", join(root, "orrery", "src", "opencode", "plugin"))).plugins] });
		expect(insideSession([config.dataDir], { ...env, OPENCODE_CONFIG_CONTENT: theirs }, config, deps)).toMatchObject({ agent: "Atlas", via: "marker" });
		// Not Orrery's plugin, a plugin for an agent the config doesn't have, or no JSON: no marker.
		expect(insideSession([config.dataDir], { ...env, OPENCODE_CONFIG_CONTENT: content("Atlas", join(root, "elsewhere")) }, config, deps)).toBeUndefined();
		expect(insideSession([config.dataDir], { ...env, OPENCODE_CONFIG_CONTENT: content("Ghost") }, config, deps)).toBeUndefined();
		expect(insideSession([config.dataDir], { ...env, OPENCODE_CONFIG_CONTENT: "{plugins: [" }, config, deps)).toBeUndefined();
		// A token file outside Orrery's tokens folder proves nothing.
		const stray = join(root, "opencode-123-0123456789ab");
		writeFileSync(stray, token);
		expect(insideSession([config.dataDir], { ...env, OPENCODE_CONFIG_CONTENT: configContent(plugin, { agent: "Atlas", tokenFile: stray }) }, config, deps)).toMatchObject({ agent: undefined, via: "marker" });
	});

	it("markers that name different agents leave the identity unknown; one with no identity yields to one with", () => {
		const { config } = world();
		const table = chain();
		const deps = linux(table, 50);
		expect(recordSession(config.dataDir, { agent: "Atlas", tool: "claude-code", pid: 77 }, linux(table))).toBe(true);
		const token = newToken();
		claimToken(join(config.dataDir, "agents", "Birch"), token, 30, deps.alive);
		expect(insideSession([config.dataDir], { CLAUDE_PID: "77", ORRERY_AGENT: "Birch", ORRERY_AGENT_TOKEN: token }, config, deps)).toMatchObject({ agent: undefined, via: "marker" });
		expect(insideSession([config.dataDir], { CLAUDE_PID: "77", ORRERY_AGENT: "Birch", ORRERY_AGENT_TOKEN: newToken() }, config, deps)).toEqual({ agent: "Atlas", tool: "claude-code", via: "marker", dataDir: config.dataDir });
	});
});

describe("ALLOWED_INSIDE", () => {
	it("names the commands that run inside an agent session", () => {
		expect([...ALLOWED_INSIDE].sort()).toEqual(["browse", "claude-hook", "claude-mod", "codex-hook", "compactor", "help", "holder", "mcp", "status", "usage"]);
	});
});
