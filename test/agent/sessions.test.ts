import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../../src/agent/config.ts";
import { orreryHome } from "../../src/agent/home.ts";
import { ALLOWED_INSIDE as ALLOWED_ALONE } from "../../src/agent/inside-commands.ts";
import { claimHeld, claimToken, newToken } from "../../src/agent/pick.ts";
import { writePrivate } from "../../src/agent/private-file.ts";
import { bootId, pidNamespace, processStartedAt } from "../../src/agent/process.ts";
import {
	ALLOWED_INSIDE,
	ancestors,
	codexSessionHosts,
	forgetSession,
	grokSessionHosts,
	HOST_ENV,
	type Inside,
	insideSession,
	liveSession,
	nestedNotice,
	processStart,
	recordedCodexIds,
	recordedPlain,
	recordSession,
	type SessionDeps,
	type SessionTool,
} from "../../src/agent/sessions.ts";
import { configContent } from "../../src/opencode/options.ts";

const SESSIONS = new URL("../../src/agent/sessions.ts", import.meta.url).pathname;
const CONFIG = new URL("../../src/agent/config.ts", import.meta.url).pathname;
const PICK = new URL("../../src/agent/pick.ts", import.meta.url).pathname;
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
/** The processes codexSessionHosts finds. */
const codexHosts = (...args: Parameters<typeof codexSessionHosts>) => codexSessionHosts(...args).map((host) => host.pid);
/** Hosts by pid, those with none (a records folder) first. */
const byPid = (a: { readonly pid?: number }, b: { readonly pid?: number }) => (a.pid ?? 0) - (b.pid ?? 0);

type Table = Record<number, { readonly ppid: number; readonly start: string }>;

/**
 * The pid namespace the fakes' processes and this test are in: this process's own on Linux, so the claims real
 * claimToken writes (with this process's namespace) are judged from it; any name elsewhere (claims there have none).
 */
const NS = pidNamespace("self") ?? "pid:[4026531836]";
const BOOT = "0b0b0b0b-boot";

/** A /proc/<pid>/stat line: the name holds spaces and parentheses, field 4 is the parent, field 22 the start time. */
const statLine = (pid: number, ppid: number, start: string) => `${pid} (a (b) c) S ${ppid} ${Array(17).fill("0").join(" ")} ${start} 4096 0\n`;

/**
 * A fake Linux: the table read through a fake /proc; a process lives while the table has it; every process is in NS,
 * and so is this one unless `here` says otherwise; the boot is BOOT.
 */
function linux(table: Table, from?: number, here: string | undefined = NS): SessionDeps {
	return {
		platform: "linux",
		proc: (pid) => (table[pid] === undefined ? undefined : statLine(pid, table[pid].ppid, table[pid].start)),
		alive: (pid) => table[pid] !== undefined,
		ns: (pid) => (pid === "self" ? here : table[pid] === undefined ? undefined : NS),
		boot: () => BOOT,
		...(from === undefined ? {} : { from }),
	};
}

/**
 * This process as a child pid namespace sees the fakes' processes (`unshare -p`): its own namespace is another, kill(0)
 * finds every one of them gone, and /proc shows them (`/proc` not remounted) or nothing (`--mount-proc`).
 */
function elsewhere(table: Table, procfs: "kept" | "remounted", from?: number): SessionDeps {
	return { ...linux(table, from, "pid:[4026533000]"), alive: () => false, ...(procfs === "remounted" ? { proc: () => undefined } : {}) };
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
		const place = process.platform === "linux" ? { ns: pidNamespace("self"), boot: bootId() } : {};
		expect(place).not.toMatchObject({ ns: undefined });
		expect(liveSession(dir, process.pid)).toEqual({ agent: "Atlas", tool: "pi", pid: process.pid, start, ...place });
		expect(statSync(hostFile(dir, process.pid)).mode & 0o777).toBe(0o600);
		expect(statSync(join(dir, "session-hosts")).mode & 0o777).toBe(0o700);
		forgetSession(dir, process.pid);
		expect(existsSync(hostFile(dir, process.pid))).toBe(false);
		expect(liveSession(dir, process.pid)).toBeUndefined();
		// Forgetting what is gone is fine.
		forgetSession(dir, process.pid);
	});

	it("replaces whatever is under the process's pid (a record made in another pid namespace, one that can't be read, one that is no record, one with a field that can't be read, a stale one); a closing session forgets only its own live record", () => {
		const dir = temp();
		const table = chain();
		// This process and process 30 in another pid namespace than the one the record there was made in (NS): a container's,
		// say, that shares the data folder.
		const other: SessionDeps = { ...linux(table), ns: () => "pid:[4026533000]" };
		mkdirSync(join(dir, "session-hosts"), { recursive: true, mode: 0o700 });
		const file = hostFile(dir, 30);
		const put = (text: string) => writeFileSync(file, text, { mode: 0o600 });
		const theirs = `${JSON.stringify({ agent: "Atlas", tool: "grok", pid: 30, start: "300", grokSession: "019a-atlas", ns: NS, boot: BOOT })}\n`;
		put(theirs);
		// Not its own: a closing session here keeps it.
		forgetSession(dir, 30, other);
		expect(readFileSync(file, "utf8")).toBe(theirs);
		// Here, pid 30 is this process: its record replaces that one, and is forgotten when it closes.
		expect(recordSession(dir, { agent: "Birch", tool: "grok", pid: 30, grokSession: "019b-birch" }, other)).toBe(true);
		expect(liveSession(dir, 30, other)).toMatchObject({ agent: "Birch", grokSession: "019b-birch", ns: "pid:[4026533000]" });
		// From the namespace the first was made in, this one isn't process 30's: kept.
		forgetSession(dir, 30, linux(table));
		expect(liveSession(dir, 30, other)).toMatchObject({ agent: "Birch" });
		forgetSession(dir, 30, other);
		expect(existsSync(file)).toBe(false);
		// One that can't be read (a link), one that is no record, one with a field that can't be read: never forgotten, and
		// replaced by a new record.
		const made = [() => symlinkSync(join(dir, "elsewhere.json"), file), () => put("{ cut short"), () => put(JSON.stringify({ agent: "Atlas", tool: "pi", pid: 30, start: "300", ns: NS, boot: 7 }))];
		for (const make of made) {
			make();
			const before = lstatSync(file).isSymbolicLink() ? "link" : readFileSync(file, "utf8");
			forgetSession(dir, 30, linux(table));
			expect(lstatSync(file).isSymbolicLink() ? "link" : readFileSync(file, "utf8")).toBe(before);
			expect(recordSession(dir, { agent: "Birch", tool: "pi", pid: 30 }, linux(table))).toBe(true);
			expect(lstatSync(file).isFile()).toBe(true);
			expect(liveSession(dir, 30, linux(table))).toMatchObject({ agent: "Birch", start: "300", ns: NS });
			forgetSession(dir, 30, linux(table));
			expect(existsSync(file)).toBe(false);
		}
		// A stale one (its process started at another time, or another boot's) is replaced.
		for (const stale of [{ start: "299", boot: BOOT }, { start: "300", boot: "another-boot" }]) {
			put(JSON.stringify({ agent: "Atlas", tool: "pi", pid: 30, ns: NS, ...stale }));
			expect(recordSession(dir, { agent: "Birch", tool: "pi", pid: 30 }, linux(table))).toBe(true);
			expect(liveSession(dir, 30, linux(table))).toMatchObject({ agent: "Birch", start: "300" });
		}
	});

	it("keeps a Codex session's id", () => {
		const dir = temp();
		const deps = linux(chain());
		expect(recordSession(dir, { agent: "Birch", tool: "codex", pid: 30, codexSession: "019a-thread" }, deps)).toBe(true);
		expect(liveSession(dir, 30, deps)).toEqual({ agent: "Birch", tool: "codex", pid: 30, start: "300", codexSession: "019a-thread", ns: NS, boot: BOOT });
	});

	it("keeps a Grok session's id; one that is no text makes the record unsure, never none", () => {
		const dir = temp();
		const deps = linux(chain());
		expect(recordSession(dir, { agent: "Birch", tool: "grok", pid: 30, grokSession: "01a188c0-06ae-78a2-b15c-bec4228c7070" }, deps)).toBe(true);
		expect(liveSession(dir, 30, deps)).toEqual({ agent: "Birch", tool: "grok", pid: 30, start: "300", grokSession: "01a188c0-06ae-78a2-b15c-bec4228c7070", ns: NS, boot: BOOT });
		expect(recordSession(dir, { agent: "Birch", tool: "grok", pid: 30, grokSession: "" }, deps)).toBe(false);
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

	it("a file that is no record: on macOS gone when its process is, kept while it lives; on Linux kept (its namespace unknown)", () => {
		const dir = temp();
		const table = chain();
		mkdirSync(join(dir, "session-hosts"), { recursive: true });
		writeFileSync(hostFile(dir, 30), "not json");
		for (const deps of [linux(table), darwin(table)]) expect(liveSession(dir, 30, deps)).toBeUndefined();
		expect(existsSync(hostFile(dir, 30))).toBe(true);
		delete table[30];
		expect(liveSession(dir, 30, linux(table))).toBeUndefined();
		expect(existsSync(hostFile(dir, 30))).toBe(true);
		expect(liveSession(dir, 30, darwin(table))).toBeUndefined();
		expect(existsSync(hostFile(dir, 30))).toBe(false);
		// Another pid's record is no record of this one; a Linux record without its namespace is judged by nobody.
		writeFileSync(hostFile(dir, 40), JSON.stringify({ agent: "Atlas", tool: "pi", pid: 50, start: "500", ns: NS, boot: BOOT }));
		expect(liveSession(dir, 40, linux(table))).toBeUndefined();
		writeFileSync(hostFile(dir, 50), JSON.stringify({ agent: "Atlas", tool: "pi", pid: 50, start: "500" }));
		expect(liveSession(dir, 50, linux(table))).toBeUndefined();
		delete table[50];
		expect(liveSession(dir, 50, linux(table))).toBeUndefined();
		expect(existsSync(hostFile(dir, 50))).toBe(true);
	});

	it("never reads a record through a link, nor waits on a FIFO in its place; both are kept", () => {
		const dir = temp();
		const table = chain();
		expect(recordSession(dir, { agent: "Atlas", tool: "pi", pid: 30 }, linux(table))).toBe(true);
		renameSync(hostFile(dir, 30), join(dir, "elsewhere.json"));
		symlinkSync(join(dir, "elsewhere.json"), hostFile(dir, 30));
		expect(liveSession(dir, 30, linux(table))).toBeUndefined();
		expect(lstatSync(hostFile(dir, 30)).isSymbolicLink()).toBe(true);
		const fifo = spawnSync("mkfifo", [hostFile(dir, 40)]);
		if (fifo.status === 0) {
			expect(liveSession(dir, 40, linux(table))).toBeUndefined();
			expect(lstatSync(hostFile(dir, 40)).isFIFO()).toBe(true);
			// A marker pointing at either is a session of unknown identity.
			const { config } = world();
			expect(insideSession([dir], { CLAUDE_PID: "40" }, { ...config, dataDir: dir }, linux(table, 50))).toMatchObject({ agent: undefined, via: "marker" });
		}
	});

	it("a record from another boot is stale, though its pid, start and namespace match", () => {
		const dir = temp();
		const table = chain();
		expect(recordSession(dir, { agent: "Atlas", tool: "pi", pid: 30 }, linux(table))).toBe(true);
		expect(liveSession(dir, 30, { ...linux(table), boot: () => "1c1c1c1c-boot" })).toBeUndefined();
		expect(existsSync(hostFile(dir, 30))).toBe(false);
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

describe("codexSessionHosts", () => {
	it("judges only the records that name the session asked about: no other record's process is asked about (a ps each on macOS)", () => {
		const dir = temp();
		const table: Table = { ...chain(), 32: { ppid: 1, start: "320" }, 33: { ppid: 1, start: "330" } };
		const records = [
			{ agent: "Atlas", tool: "codex", pid: 30, codexSession: "019a-atlas" },
			{ agent: "Birch", tool: "codex", pid: 32, codexSession: "019b-birch" },
			{ agent: "Cedar", tool: "codex", pid: 33, codexSession: "019a-atlas" },
			{ agent: "Birch", tool: "pi", pid: 40 },
		] as const;
		for (const record of records) expect(recordSession(dir, record, darwin(table))).toBe(true);
		/** macOS as darwin() fakes it, with each pid whose liveness is asked kept. */
		const watched = () => {
			const alive: number[] = [];
			const mac = darwin(table);
			return { alive, mac, deps: { ...mac, alive: (pid: number) => (alive.push(pid), table[pid] !== undefined) } };
		};
		const asked = (look: ReturnType<typeof watched>) => ({ alive: look.alive.sort(), ps: look.mac.calls.map((args) => args.join(" ")).sort() });
		let look = watched();
		expect(codexHosts([dir], "019a-atlas", look.deps).sort()).toEqual([30, 33]);
		expect(asked(look)).toEqual({ alive: [30, 33], ps: ["-o lstart= -p 30", "-o lstart= -p 33"] });
		look = watched();
		expect(codexHosts([dir], "019b-birch", look.deps)).toEqual([32]);
		expect(asked(look)).toEqual({ alive: [32], ps: ["-o lstart= -p 32"] });
		look = watched();
		expect(codexHosts([dir], "019c-none", look.deps)).toEqual([]);
		expect(asked(look)).toEqual({ alive: [], ps: [] });
		// A stale record that names another session is left for a look that judges it (recordedCodexIds judges every one).
		delete table[32];
		expect(codexHosts([dir], "019a-atlas", watched().deps).sort()).toEqual([30, 33]);
		expect(existsSync(hostFile(dir, 32))).toBe(true);
		expect([...recordedCodexIds([dir], darwin(table))]).toEqual(["019a-atlas"]);
		expect(existsSync(hostFile(dir, 32))).toBe(false);
	});

	it("passes over the asker's own record: on macOS unread; on Linux only one made in the asker's pid namespace, so one made in another under its number (a program in a pid namespace of its own) hosts the session", () => {
		const dir = temp();
		const table: Table = { ...chain(), 33: { ppid: 1, start: "330" } };
		for (const record of [
			{ agent: "Atlas", tool: "codex", pid: 30, codexSession: "019a-atlas" },
			{ agent: "Cedar", tool: "codex", pid: 33, codexSession: "019a-atlas" },
		] as const) {
			expect(recordSession(dir, record, darwin(table))).toBe(true);
		}
		const mac = darwin(table);
		expect(codexHosts([dir], "019a-atlas", mac, 30)).toEqual([33]);
		expect(mac.calls.map((args) => args.join(" "))).toEqual(["-o lstart= -p 33"]);
		const linuxDir = temp();
		expect(recordSession(linuxDir, { agent: "Atlas", tool: "codex", pid: 30, codexSession: "019a-atlas" }, linux(table))).toBe(true);
		expect(codexHosts([linuxDir], "019a-atlas", linux(table), 30)).toEqual([]);
		for (const procfs of ["kept", "remounted"] as const) expect(codexHosts([linuxDir], "019a-atlas", elsewhere(table, procfs), 30), procfs).toEqual([30]);
		const foreign = { agent: "Birch", tool: "codex", pid: 40, start: "400", codexSession: "019a-atlas", ns: "pid:[4026532999]", boot: BOOT };
		writeFileSync(hostFile(linuxDir, 40), JSON.stringify(foreign), { mode: 0o600 });
		expect(codexHosts([linuxDir], "019a-atlas", linux(table), 40).sort()).toEqual([30, 40]);
		expect(existsSync(hostFile(linuxDir, 40))).toBe(true);
	});
});

describe("grokSessionHosts", () => {
	it("finds the records that name a Grok session, with their agent and folder, judging only those (a ps each on macOS), the asker's own passed over; a Codex session of the same id is none of them", () => {
		const dir = temp();
		const table: Table = { ...chain(), 32: { ppid: 1, start: "320" }, 33: { ppid: 1, start: "330" }, 34: { ppid: 1, start: "340" } };
		const records = [
			{ agent: "Atlas", tool: "grok", pid: 30, grokSession: "019a-atlas" },
			{ agent: "Birch", tool: "grok", pid: 32, grokSession: "019b-birch" },
			{ agent: "Cedar", tool: "grok", pid: 33, grokSession: "019a-atlas" },
			{ agent: "Birch", tool: "codex", pid: 34, codexSession: "019a-atlas" },
		] as const;
		for (const record of records) expect(recordSession(dir, record, darwin(table))).toBe(true);
		const mac = darwin(table);
		const alive: number[] = [];
		const found = grokSessionHosts([dir], "019a-atlas", 0, { ...mac, alive: (pid: number) => (alive.push(pid), table[pid] !== undefined) });
		expect(found.sort(byPid)).toEqual([
			{ pid: 30, agent: "Atlas", dataDir: dir, live: true },
			{ pid: 33, agent: "Cedar", dataDir: dir, live: true },
		]);
		expect({ alive: alive.sort(), ps: mac.calls.map((args) => args.join(" ")).sort() }).toEqual({ alive: [30, 33], ps: ["-o lstart= -p 30", "-o lstart= -p 33"] });
		// Asked by Grok 30 about its own session: its record isn't even judged.
		const own = darwin(table);
		expect(grokSessionHosts([dir], "019a-atlas", 30, own).map((host) => host.pid)).toEqual([33]);
		expect(own.calls.map((args) => args.join(" "))).toEqual(["-o lstart= -p 33"]);
		expect(codexHosts([dir], "019a-atlas", darwin(table))).toEqual([34]);
		// A record whose process is gone is stale, taken down, and hosts nothing.
		delete table[33];
		expect(grokSessionHosts([dir], "019a-atlas", 0, darwin(table)).map((host) => host.pid)).toEqual([30]);
		expect(existsSync(hostFile(dir, 33))).toBe(false);
	});

	it.skipIf(process.platform !== "linux")("on Linux, a record of another pid namespace is unsure, kept, and still hosts the session; one found in a folder above the data folder names that folder", () => {
		const root = temp();
		const inner = join(root, "inner");
		mkdirSync(join(root, "session-hosts"), { recursive: true, mode: 0o700 });
		mkdirSync(inner);
		const foreign = { agent: "Atlas", tool: "grok", pid: 2_000_000_000, start: "1", grokSession: "019a-atlas", ns: "pid:[4026532999]", boot: "another" };
		writeFileSync(hostFile(root, foreign.pid), JSON.stringify(foreign), { mode: 0o600 });
		// Found above a folder given, the data folder is named by its real path (a temp folder may be a link).
		expect(grokSessionHosts([inner], "019a-atlas", process.pid)).toEqual([{ pid: foreign.pid, agent: "Atlas", dataDir: realpathSync(root), live: false }]);
		expect(existsSync(hostFile(root, foreign.pid))).toBe(true);
	});

	it("on Linux, the asker's own pid passes over only a record made in its own pid namespace: one made in another under that number (a program in a pid namespace of its own, numbered there as the real Grok is here) hosts the session", () => {
		const dir = temp();
		const table: Table = { ...chain() };
		expect(recordSession(dir, { agent: "Atlas", tool: "grok", pid: 30, grokSession: "019a-atlas" }, linux(table))).toBe(true);
		// Asked by Grok 30 itself, in the namespace its record was made in: its own.
		expect(grokSessionHosts([dir], "019a-atlas", 30, linux(table))).toEqual([]);
		// Asked by a process numbered 30 in a pid namespace of its own (/proc kept, or its own mounted): another process's.
		for (const procfs of ["kept", "remounted"] as const) {
			expect(grokSessionHosts([dir], "019a-atlas", 30, elsewhere(table, procfs)), procfs).toEqual([{ pid: 30, agent: "Atlas", dataDir: dir, live: false }]);
		}
		// Asked where this process's own namespace can't be read: no record is known to be its own.
		const blind = { ...linux(table), ns: (pid: number | "self") => (pid === "self" ? undefined : NS) };
		expect(grokSessionHosts([dir], "019a-atlas", 30, blind)).toEqual([{ pid: 30, agent: "Atlas", dataDir: dir, live: false }]);
		// A record made in another namespace under the number of a Grok of this one, which asks about its session.
		const foreign = { agent: "Birch", tool: "grok", pid: 40, start: "400", grokSession: "019a-atlas", ns: "pid:[4026532999]", boot: BOOT };
		writeFileSync(hostFile(dir, 40), JSON.stringify(foreign), { mode: 0o600 });
		expect(grokSessionHosts([dir], "019a-atlas", 40, linux(table)).sort(byPid)).toEqual([
			{ pid: 30, agent: "Atlas", dataDir: dir, live: true },
			{ pid: 40, agent: "Birch", dataDir: dir, live: false },
		]);
		// Every record is kept: none is stale.
		expect([30, 40].map((pid) => existsSync(hostFile(dir, pid)))).toEqual([true, true]);
	});
});

describe("the host check fails closed: what can't be read may host the session asked about", () => {
	/** Runs `look` with `path`'s mode `mode`, then puts 0700 back (the temp folder is removed after). */
	const withMode = <T>(path: string, mode: number, look: () => T): T => {
		chmodSync(path, mode);
		try {
			return look();
		} finally {
			chmodSync(path, 0o700);
		}
	};

	it.skipIf(process.getuid?.() === 0)("a records folder that is there but can't be listed hosts every session asked about, for Codex and Grok, found as given or above a folder given; it holds no Codex id (recordedCodexIds); none there, or a data folder given as a link to a file, holds nothing", () => {
		const root = temp();
		const dir = join(root, "data");
		const table: Table = { ...chain() };
		expect(recordSession(dir, { agent: "Atlas", tool: "codex", pid: 30, codexSession: "019a-atlas" }, linux(table))).toBe(true);
		const inner = join(dir, "agents", "Atlas");
		mkdirSync(inner, { recursive: true });
		const folder = join(dir, "session-hosts");
		const unreadable = [{ dataDir: dir, live: false, unreadable: folder }];
		const realDir = realpathSync(dir);
		withMode(folder, 0, () => {
			expect(codexSessionHosts([dir], "019a-atlas", linux(table), 77)).toEqual(unreadable);
			expect(codexSessionHosts([dir], "019c-cedar", darwin(table))).toEqual(unreadable);
			expect(grokSessionHosts([dir], "019b-birch", 77, linux(table))).toEqual(unreadable);
			// Found above a folder given, the records folder is named by its real path (macOS: /var is /private/var).
			expect(grokSessionHosts([inner], "019b-birch", 77, linux(table))).toEqual([{ dataDir: realDir, live: false, unreadable: join(realDir, "session-hosts") }]);
			expect(recordedCodexIds([dir], linux(table)).size).toBe(0);
		});
		expect(codexHosts([dir], "019a-atlas", linux(table), 77)).toEqual([30]);
		// No records folder: none; nor in a data folder given as a link to a file (an agent's link to its memory file).
		writeFileSync(join(root, "memory.sqlite"), "");
		symlinkSync(join(root, "memory.sqlite"), join(root, "link"));
		expect(grokSessionHosts([join(root, "missing"), join(root, "link")], "019b-birch", 77, linux(table))).toEqual([]);
		// Nor through a loop of links (one in an agent's folder, say): a loop holds no records.
		symlinkSync("loop-b", join(root, "loop-a"));
		symlinkSync("loop-a", join(root, "loop-b"));
		expect(grokSessionHosts([join(root, "loop-a")], "019b-birch", 77, linux(table))).toEqual([]);
		expect(codexSessionHosts([join(root, "loop-a")], "019a-atlas", linux(table), 77)).toEqual([]);
		// Something else in a records folder's place can't be listed either.
		const other = join(root, "other");
		mkdirSync(other);
		writeFileSync(join(other, "session-hosts"), "");
		expect(grokSessionHosts([other], "019b-birch", 77, linux(table))).toEqual([{ dataDir: other, live: false, unreadable: join(other, "session-hosts") }]);
	});

	it("a record file that may name the session but holds no record that names one (it can't be read, holds no record this version reads, or its id can't be read) hosts it, unsure, with its path; one that names another session, or none, doesn't; the asker's own number passes over none of them on Linux", () => {
		const dir = temp();
		const table: Table = { ...chain(), 32: { ppid: 1, start: "320" }, 33: { ppid: 1, start: "330" }, 34: { ppid: 1, start: "340" }, 35: { ppid: 1, start: "350" } };
		mkdirSync(join(dir, "session-hosts"), { recursive: true, mode: 0o700 });
		const put = (pid: number, text: string) => writeFileSync(hostFile(dir, pid), text, { mode: 0o600 });
		const record = (pid: number, fields: object) => put(pid, JSON.stringify({ agent: "Atlas", tool: "grok", pid, start: `${pid}0`, ns: NS, boot: BOOT, ...fields }));
		// No JSON; a record of the session with no start; one whose id is no string; one of another session; one of none.
		put(30, "{ cut short");
		put(32, JSON.stringify({ agent: "Atlas", tool: "grok", pid: 32, grokSession: "019a-atlas", ns: NS, boot: BOOT }));
		record(33, { grokSession: 7 });
		record(34, { grokSession: "019b-birch" });
		record(35, { tool: "pi" });
		// A link in a record's place: no record is read through one.
		symlinkSync(hostFile(dir, 34), hostFile(dir, 40));
		// Each but the link could be read: they hold no session record this version reads.
		const unsure = (pid: number) => ({ pid, dataDir: dir, live: false, unreadable: hostFile(dir, pid), ...(pid === 40 ? {} : { readable: true }) });
		expect(grokSessionHosts([dir], "019a-atlas", 77, linux(table)).sort(byPid)).toEqual([30, 32, 33, 40].map(unsure));
		// Codex's check reads them as Codex's: only what holds no JSON, or can't be read, may name a Codex session.
		expect(codexSessionHosts([dir], "019a-atlas", linux(table), 77).sort(byPid)).toEqual([30, 40].map(unsure));
		// On Linux the asker's own number passes over none of them (none is known to be made in its namespace); on macOS
		// its own is passed over unread.
		expect(grokSessionHosts([dir], "019a-atlas", 40, linux(table)).sort(byPid)).toEqual([30, 32, 33, 40].map(unsure));
		expect(grokSessionHosts([dir], "019a-atlas", 40, darwin(table)).sort(byPid)).toEqual([30, 32, 33].map(unsure));
		// None is taken down while its process lives. On macOS a file that is no record goes once its process is gone, as
		// it always has (on Linux it stays: no namespace says whose number it is).
		delete table[30];
		expect(grokSessionHosts([dir], "019a-atlas", 77, linux(table)).map((host) => host.pid)).toContain(30);
		expect(grokSessionHosts([dir], "019a-atlas", 77, darwin(table)).sort(byPid)).toEqual([32, 33, 40].map(unsure));
		expect(existsSync(hostFile(dir, 30))).toBe(false);
	});
});

describe("processStartedAt: when a process started, as a time", () => {
	/** A /proc/<pid>/stat line whose field 22 (the start, in clock ticks since boot) is `ticks`. */
	const stat = (ticks: string) => `30 (a (b) c) S ${Array.from({ length: 18 }, () => "1").join(" ")} ${ticks} 0 0\n`;

	it("on Linux: the boot time (/proc/stat btime) and the start's clock ticks (100 a second)", () => {
		expect(processStartedAt(30, { platform: "linux", proc: () => stat("12345"), bootTime: () => 1_700_000_000 })).toBe(1_700_000_123_450);
		expect(processStartedAt(30, { platform: "linux", proc: () => undefined, bootTime: () => 1_700_000_000 })).toBeUndefined();
		expect(processStartedAt(30, { platform: "linux", proc: () => stat("12345"), bootTime: () => undefined })).toBeUndefined();
	});

	it("on macOS: ps's lstart, read as UTC (ps is asked in UTC and the C locale)", () => {
		const mac = (lstart: string | undefined) => ({ platform: "darwin" as const, ps: () => lstart });
		expect(processStartedAt(30, mac("Sat Oct 18 10:00:00 2026\n"))).toBe(Date.UTC(2026, 9, 18, 10, 0, 0));
		expect(processStartedAt(30, mac("Mon Oct  5 08:09:07 2026"))).toBe(Date.UTC(2026, 9, 5, 8, 9, 7));
		expect(processStartedAt(30, mac("yesterday"))).toBeUndefined();
		expect(processStartedAt(30, mac(undefined))).toBeUndefined();
		expect(processStartedAt(30, { platform: "win32" })).toBeUndefined();
	});

	it.skipIf(!real)("a real process started before now, and a gone one has no start", () => {
		const at = processStartedAt(process.pid);
		expect(at).toBeDefined();
		expect(at as number).toBeLessThanOrEqual(Date.now() + 1000);
		expect(at as number).toBeGreaterThan(Date.now() - 24 * 60 * 60 * 1000);
		expect(processStartedAt(spawnSync(process.execPath, ["-e", ""]).pid as number)).toBeUndefined();
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
		forgetSession(a, 30, linux(table));
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
		// The token proves Atlas whatever name is beside it, or none (it is found in every agent's claims).
		expect(insideSession([config.dataDir], { ORRERY_AGENT: "Birch", ORRERY_AGENT_TOKEN: token }, config, deps)).toMatchObject({ agent: "Atlas", via: "marker" });
		expect(insideSession([config.dataDir], { ORRERY_AGENT: "Ghost", ORRERY_AGENT_TOKEN: token }, config, deps)).toMatchObject({ agent: "Atlas", via: "marker" });
		expect(insideSession([config.dataDir], { ORRERY_AGENT_TOKEN: token }, config, deps)).toEqual({ agent: "Atlas", tool: undefined, via: "marker", dataDir: config.dataDir });
		// A token alone that no live process claimed is no marker.
		expect(insideSession([config.dataDir], { ORRERY_AGENT_TOKEN: newToken() }, config, deps)).toBeUndefined();
		delete table[77];
		expect(insideSession([config.dataDir], { ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: token }, config, deps)).toMatchObject({ agent: undefined, via: "marker" });
		expect(insideSession([config.dataDir], { ORRERY_AGENT_TOKEN: token }, config, deps)).toBeUndefined();
	});

	it("a claimed ORRERY_AGENT takes its tool from the claimant's record", () => {
		const { config } = world();
		const table = chain();
		const token = newToken();
		claimToken(join(config.dataDir, "agents", "Atlas"), token, 77, linux(table).alive);
		expect(recordSession(config.dataDir, { agent: "Atlas", tool: "omp", pid: 77 }, linux(table))).toBe(true);
		expect(insideSession([config.dataDir], { ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: token }, config, linux(table, 50))).toEqual({ agent: "Atlas", tool: "omp", via: "marker", dataDir: config.dataDir });
	});

	it("an ORRERY_AGENT that names no agent of a loaded config is no marker (a scratch home's config)", () => {
		const { config } = world();
		const deps = linux(chain(), 50);
		expect(insideSession([config.dataDir], { ORRERY_AGENT: "Ghost", ORRERY_AGENT_TOKEN: newToken() }, config, deps)).toBeUndefined();
	});

	it("with no config, any marker is a session of unknown identity", () => {
		const { root } = world();
		const deps = linux(chain(), 50);
		const dir = join(root, "data");
		const unknown = { agent: undefined, tool: undefined, via: "marker", dataDir: dir };
		const plugin = configContent(join(root, "app", "current", "extensions", "opencode"), { agent: "Atlas", tokenFile: join(root, "token") });
		const markers = [{ ORRERY_AGENT: "Atlas" }, { ORRERY_AGENT_TOKEN: newToken() }, { CLAUDE_PID: "77" }, { CODEX_THREAD_ID: "019a-thread" }, { CODEX_SESSION_ID: "019a-thread" }, { ORRERY_HOST: "77" }, { OPENCODE_CONFIG_CONTENT: plugin }];
		for (const env of markers) expect(insideSession([dir], env, undefined, deps), JSON.stringify(env)).toEqual(unknown);
		// No marker: an empty or blank one, or a config content without Orrery's plugin.
		for (const env of [{}, { ORRERY_AGENT: " " }, { CLAUDE_PID: "" }, { OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugins: ["their-plugin"] }) }]) expect(insideSession([dir], env, undefined, deps), JSON.stringify(env)).toBeUndefined();
	});

	it("CODEX_THREAD_ID or CODEX_SESSION_ID naming a live record's Codex session is a session; whose, only a claimed token says", () => {
		const { config } = world();
		const table = chain();
		expect(recordSession(config.dataDir, { agent: "Birch", tool: "codex", pid: 77, codexSession: "019a-thread" }, linux(table))).toBe(true);
		const deps = linux(table, 50);
		const unknown = { agent: undefined, tool: "codex", via: "marker", dataDir: config.dataDir };
		expect(insideSession([config.dataDir], { CODEX_THREAD_ID: "019a-thread" }, config, deps)).toEqual(unknown);
		expect(insideSession([config.dataDir], { CODEX_SESSION_ID: "019a-thread" }, config, deps)).toEqual(unknown);
		const token = newToken();
		claimToken(join(config.dataDir, "agents", "Birch"), token, 77, deps.alive);
		expect(insideSession([config.dataDir], { CODEX_THREAD_ID: "019a-thread", ORRERY_AGENT: "Birch", ORRERY_AGENT_TOKEN: token }, config, deps)).toEqual({ agent: "Birch", tool: "codex", via: "marker", dataDir: config.dataDir });
		expect(insideSession([config.dataDir], { CODEX_THREAD_ID: "019b-other" }, config, deps)).toBeUndefined();
		delete table[77];
		expect(insideSession([config.dataDir], { CODEX_THREAD_ID: "019a-thread" }, config, deps)).toBeUndefined();
	});

	it("CLAUDE_PID naming a live Claude Code record is a session; whose, only a claimed token says; another tool's record, or none, is no marker", () => {
		const { config } = world();
		const table = chain();
		const deps = linux(table, 50);
		expect(recordSession(config.dataDir, { agent: "Atlas", tool: "claude-code", pid: 77 }, linux(table))).toBe(true);
		expect(insideSession([config.dataDir], { CLAUDE_PID: "77" }, config, deps)).toEqual({ agent: undefined, tool: "claude-code", via: "marker", dataDir: config.dataDir });
		const token = newToken();
		claimToken(join(config.dataDir, "agents", "Atlas"), token, 77, deps.alive);
		expect(insideSession([config.dataDir], { CLAUDE_PID: "77", ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: token }, config, deps)).toEqual({ agent: "Atlas", tool: "claude-code", via: "marker", dataDir: config.dataDir });
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
		// A plugin for an agent the config doesn't have, its token unclaimed: no marker.
		expect(insideSession([config.dataDir], { ...env, OPENCODE_CONFIG_CONTENT: content("Ghost") }, config, deps)).toBeUndefined();
		claimToken(join(config.dataDir, "agents", "Atlas"), token, 77, deps.alive);
		expect(insideSession([config.dataDir], { ...env, OPENCODE_CONFIG_CONTENT: content("Atlas") }, config, deps)).toEqual({ agent: "Atlas", tool: "opencode", via: "marker", dataDir: config.dataDir });
		// Among the person's own plugins, and from a checkout's plugin folder, alike.
		const theirs = JSON.stringify({ plugins: ["their-plugin", ...JSON.parse(content("Atlas", join(root, "orrery", "src", "opencode", "plugin"))).plugins] });
		expect(insideSession([config.dataDir], { ...env, OPENCODE_CONFIG_CONTENT: theirs }, config, deps)).toMatchObject({ agent: "Atlas", via: "marker" });
		// Its token claimed, the name in the entry doesn't matter.
		expect(insideSession([config.dataDir], { ...env, OPENCODE_CONFIG_CONTENT: content("Ghost") }, config, deps)).toMatchObject({ agent: "Atlas", via: "marker" });
		// Not Orrery's plugin, or no JSON: no marker.
		expect(insideSession([config.dataDir], { ...env, OPENCODE_CONFIG_CONTENT: content("Atlas", join(root, "elsewhere")) }, config, deps)).toBeUndefined();
		expect(insideSession([config.dataDir], { ...env, OPENCODE_CONFIG_CONTENT: "{plugins: [" }, config, deps)).toBeUndefined();
		// A token file outside Orrery's tokens folder proves nothing.
		const stray = join(root, "opencode-123-0123456789ab");
		writeFileSync(stray, token);
		expect(insideSession([config.dataDir], { ...env, OPENCODE_CONFIG_CONTENT: configContent(plugin, { agent: "Atlas", tokenFile: stray }) }, config, deps)).toMatchObject({ agent: undefined, via: "marker" });
	});

	it("ORRERY_HOST naming a live record, of any tool, is a session; whose, only a claimed token says; a dead or unrecorded pid is no marker", () => {
		const { config } = world();
		const table = chain();
		const deps = linux(table, 50);
		expect(HOST_ENV).toBe("ORRERY_HOST");
		expect(recordSession(config.dataDir, { agent: "Atlas", tool: "pi", pid: 77 }, linux(table))).toBe(true);
		expect(insideSession([config.dataDir], { ORRERY_HOST: "77" }, config, deps)).toEqual({ agent: undefined, tool: "pi", via: "marker", dataDir: config.dataDir });
		const token = newToken();
		claimToken(join(config.dataDir, "agents", "Atlas"), token, 77, deps.alive);
		expect(insideSession([config.dataDir], { ORRERY_HOST: "77", ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: token }, config, deps)).toEqual({ agent: "Atlas", tool: "pi", via: "marker", dataDir: config.dataDir });
		// A token proving another agent than the record's: unknown.
		const birch = newToken();
		claimToken(join(config.dataDir, "agents", "Birch"), birch, 30, deps.alive);
		expect(insideSession([config.dataDir], { ORRERY_HOST: "77", ORRERY_AGENT_TOKEN: birch }, config, deps)).toMatchObject({ agent: undefined, via: "marker" });
		expect(insideSession([config.dataDir], { ORRERY_HOST: "1234" }, config, deps)).toBeUndefined();
		expect(insideSession([config.dataDir], { ORRERY_HOST: "not a pid" }, config, deps)).toBeUndefined();
		delete table[77];
		expect(insideSession([config.dataDir], { ORRERY_HOST: "77" }, config, deps)).toBeUndefined();
	});

	it.skipIf(spawnSync("mkfifo", ["--help"]).error !== undefined)("a FIFO put in a claim's place is read without waiting, and is a session of unknown identity", () => {
		const { root, toml, config } = world();
		const claims = join(config.dataDir, "agents", "Atlas", "claims");
		mkdirSync(claims, { recursive: true });
		const token = newToken();
		expect(spawnSync("mkfifo", [join(claims, token)]).status).toBe(0);
		// In a child with a deadline: a read that waited on the FIFO would hang this test's process for good.
		const script = `Promise.all([import(${JSON.stringify(SESSIONS)}), import(${JSON.stringify(CONFIG)})]).then(([s, c]) => {
			const config = c.parseConfig(${JSON.stringify(toml)}, ${JSON.stringify(root)});
			const token = ${JSON.stringify(token)};
			process.stdout.write(JSON.stringify({
				cli: s.insideSession([config.dataDir], { ORRERY_AGENT_TOKEN: token }, config) ?? null,
				tool: s.insideSession([config.dataDir], { ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: token }, config, { self: process.pid }) ?? null,
			}));
		})`;
		const child = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "-e", script], { encoding: "utf8", timeout: 10_000 });
		expect(child.signal, "the claim's read waited on the FIFO").toBeNull();
		const unknown = { agent: undefined, via: "marker", dataDir: config.dataDir };
		expect(JSON.parse(child.stdout), child.stderr).toEqual({ cli: unknown, tool: unknown });
	});

	it("a detached process that copies another agent's CLAUDE_PID or Codex id gets no identity from it", () => {
		const { config } = world();
		const table = chain();
		const deps = linux(table, 50);
		// Atlas's Claude Code (77) and Birch's Codex (88) are running, neither above 50; the process proves only Birch's token, its own.
		table[88] = { ppid: 1, start: "880" };
		expect(recordSession(config.dataDir, { agent: "Atlas", tool: "claude-code", pid: 77 }, linux(table))).toBe(true);
		expect(recordSession(config.dataDir, { agent: "Birch", tool: "codex", pid: 88, codexSession: "019a-thread" }, linux(table))).toBe(true);
		const birch = newToken();
		claimToken(join(config.dataDir, "agents", "Birch"), birch, 88, deps.alive);
		expect(insideSession([config.dataDir], { CLAUDE_PID: "77" }, config, deps)).toMatchObject({ agent: undefined, via: "marker" });
		expect(insideSession([config.dataDir], { CLAUDE_PID: "77", ORRERY_AGENT: "Birch", ORRERY_AGENT_TOKEN: birch }, config, deps)).toMatchObject({ agent: undefined, via: "marker" });
		// And the other way: Atlas, proven, copying Birch's Codex id.
		const atlas = newToken();
		claimToken(join(config.dataDir, "agents", "Atlas"), atlas, 77, deps.alive);
		expect(insideSession([config.dataDir], { CODEX_THREAD_ID: "019a-thread", ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: atlas }, config, deps)).toMatchObject({ agent: undefined, via: "marker" });
		// An unproven ORRERY_AGENT naming the record's agent proves nothing either.
		expect(insideSession([config.dataDir], { CLAUDE_PID: "77", ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: newToken() }, config, deps)).toMatchObject({ agent: undefined, via: "marker" });
	});

	it("tokens proving different agents leave the identity unknown; a marker with no identity yields to one with", () => {
		const { root, config } = world();
		const table = chain();
		const deps = linux(table, 50);
		const env = { ORRERY_HOME: join(root, "home") };
		const [atlas, birch] = [newToken(), newToken()];
		const tokenFile = join(orreryHome(env), "tokens", "opencode-123-0123456789ab");
		writePrivate(tokenFile, atlas);
		claimToken(join(config.dataDir, "agents", "Atlas"), atlas, 77, deps.alive);
		claimToken(join(config.dataDir, "agents", "Birch"), birch, 30, deps.alive);
		const opencode = configContent(join(root, "app", "current", "extensions", "opencode"), { agent: "Atlas", tokenFile });
		expect(insideSession([config.dataDir], { ...env, OPENCODE_CONFIG_CONTENT: opencode, ORRERY_AGENT: "Birch", ORRERY_AGENT_TOKEN: birch }, config, deps)).toMatchObject({ agent: undefined, via: "marker" });
		expect(insideSession([config.dataDir], { ...env, OPENCODE_CONFIG_CONTENT: opencode, ORRERY_AGENT: "Birch", ORRERY_AGENT_TOKEN: newToken() }, config, deps)).toEqual({ agent: "Atlas", tool: "opencode", via: "marker", dataDir: config.dataDir });
	});
});

describe("insideSession for a tool asking about itself (self)", () => {
	/** chain() plus 60, a tool started at the top (no recorded ancestor), 61, a process it started (a hook), and 88. */
	const tools = (): Table => ({ ...chain(), 60: { ppid: 1, start: "600" }, 61: { ppid: 60, start: "610" }, 88: { ppid: 1, start: "880" } });

	it("a detached nested tool (`setsid -f pi -p …`) with only the outer host's ORRERY_HOST is inside, identity unknown; a tool's own ORRERY_HOST is not", () => {
		const { config } = world();
		const table = tools();
		// Atlas's pi, opened by its folder (no token), is 77; the nested pi, 60, is no descendant of it.
		expect(recordSession(config.dataDir, { agent: "Atlas", tool: "pi", pid: 77 }, linux(table))).toBe(true);
		const self = { ...linux(table), self: 60 };
		expect(insideSession([config.dataDir], { ORRERY_HOST: "77" }, config, self)).toEqual({ agent: undefined, tool: "pi", via: "marker", dataDir: config.dataDir });
		// Once open, the nested tool would set its own: no outer session in that.
		expect(recordSession(config.dataDir, { agent: "Birch", tool: "pi", pid: 60 }, linux(table))).toBe(true);
		expect(insideSession([config.dataDir], { ORRERY_HOST: "60" }, config, self)).toBeUndefined();
		expect(insideSession([config.dataDir], { ORRERY_HOST: "60" }, config, { ...self, from: 61 })).toBeUndefined();
		// The outer host gone: no marker.
		delete table[77];
		expect(insideSession([config.dataDir], { ORRERY_HOST: "77" }, config, self)).toBeUndefined();
	});

	it("a top-level launch's own markers are no session, before and after it claims its token; the CLI still counts them", () => {
		const { root, config } = world();
		const table = tools();
		const self = { ...linux(table), self: 60 };
		const atlas = join(config.dataDir, "agents", "Atlas");
		const token = newToken();
		const env = { ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: token };
		expect(insideSession([config.dataDir], env, config, self)).toBeUndefined();
		expect(insideSession([config.dataDir], env, config, linux(table, 60))).toMatchObject({ agent: undefined, via: "marker" });
		expect(claimToken(atlas, token, 60, self.alive)).toBe(true);
		expect(insideSession([config.dataDir], env, config, self)).toBeUndefined();
		// Its own record, named by its own CLAUDE_PID or Codex id, asked from itself or from a process it started.
		expect(recordSession(config.dataDir, { agent: "Atlas", tool: "codex", pid: 60, codexSession: "019a-own" }, linux(table))).toBe(true);
		const own = { ...env, CLAUDE_PID: "60", CODEX_THREAD_ID: "019a-own" };
		expect(insideSession([config.dataDir], own, config, self)).toBeUndefined();
		expect(insideSession([config.dataDir], own, config, { ...self, from: 61 })).toBeUndefined();
		// OpenCode's server: its launch's token file, unclaimed or claimed by itself.
		const home = { ORRERY_HOME: join(root, "home") };
		const tokenFile = join(orreryHome(home), "tokens", "opencode-123-0123456789ab");
		const birch = newToken();
		writePrivate(tokenFile, birch);
		const opencode = { ...home, OPENCODE_CONFIG_CONTENT: configContent(join(root, "app", "current", "extensions", "opencode"), { agent: "Birch", tokenFile }) };
		expect(insideSession([config.dataDir], opencode, config, self)).toBeUndefined();
		expect(claimToken(join(config.dataDir, "agents", "Birch"), birch, 60, self.alive)).toBe(true);
		expect(insideSession([config.dataDir], opencode, config, self)).toBeUndefined();
		// No config to check them against: they are taken as its own.
		expect(insideSession([config.dataDir], own, undefined, self)).toBeUndefined();
	});

	it("a nested tool (a `claude -p` from an agent's shell) whose inherited token the outer live host claimed is inside that agent's session, before and after its own claim", () => {
		const { root, config } = world();
		const table = tools();
		const self = { ...linux(table), self: 60 };
		const atlas = join(config.dataDir, "agents", "Atlas");
		const token = newToken();
		claimToken(atlas, token, 77, self.alive);
		expect(recordSession(config.dataDir, { agent: "Atlas", tool: "claude-code", pid: 77 }, linux(table))).toBe(true);
		// Claude Code sets CLAUDE_PID to the nested one itself.
		const env = { ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: token, CLAUDE_PID: "60" };
		const outer = { agent: "Atlas", tool: "claude-code", via: "marker", dataDir: config.dataDir };
		expect(insideSession([config.dataDir], env, config, self)).toEqual(outer);
		expect(claimToken(atlas, token, 60, self.alive)).toBe(false);
		expect(insideSession([config.dataDir], env, config, self)).toEqual(outer);
		// OpenCode's token file, claimed by another live process.
		const home = { ORRERY_HOME: join(root, "home") };
		const tokenFile = join(orreryHome(home), "tokens", "opencode-123-0123456789ab");
		writePrivate(tokenFile, token);
		const opencode = { ...home, OPENCODE_CONFIG_CONTENT: configContent(join(root, "app", "current", "extensions", "opencode"), { agent: "Atlas", tokenFile }) };
		expect(insideSession([config.dataDir], opencode, config, self)).toEqual({ ...outer, tool: "opencode" });
		// The outer host gone: its claim is dead, and the token the nested tool's own to take.
		delete table[77];
		expect(insideSession([config.dataDir], env, config, self)).toBeUndefined();
		// Ancestry is as without `self`: the walk starts above it.
		expect(recordSession(config.dataDir, { agent: "Birch", tool: "pi", pid: 30 }, linux(table))).toBe(true);
		expect(insideSession([config.dataDir], {}, config, { ...linux(table), self: 50 })).toEqual({ agent: "Birch", tool: "pi", via: "ancestry", dataDir: config.dataDir });
	});

	it("a nested tool that inherited another live Codex's thread id is inside a session of unknown identity, unless a token proves whose", () => {
		const { config } = world();
		const table = tools();
		const self = { ...linux(table), self: 60 };
		expect(recordSession(config.dataDir, { agent: "Birch", tool: "codex", pid: 88, codexSession: "019a-thread" }, linux(table))).toBe(true);
		expect(insideSession([config.dataDir], { CODEX_THREAD_ID: "019a-thread" }, config, self)).toEqual({ agent: undefined, tool: "codex", via: "marker", dataDir: config.dataDir });
		const token = newToken();
		claimToken(join(config.dataDir, "agents", "Birch"), token, 88, self.alive);
		expect(insideSession([config.dataDir], { CODEX_THREAD_ID: "019a-thread", ORRERY_AGENT: "Birch", ORRERY_AGENT_TOKEN: token }, config, self)).toEqual({ agent: "Birch", tool: "codex", via: "marker", dataDir: config.dataDir });
	});
});

describe("pid namespaces (Linux)", () => {
	/** chain() plus 88 (another tool) and 60 (a tool asking about itself), each under 1. */
	const tools = (): Table => ({ ...chain(), 60: { ppid: 1, start: "600" }, 88: { ppid: 1, start: "880" } });

	for (const procfs of ["kept", "remounted"] as const) {
		it(`a reader in another pid namespace (/proc ${procfs}) keeps every record, counts none for its ancestry, and takes a marker pointing at one for a session of unknown identity`, () => {
			const { config } = world();
			const table = tools();
			const records = [
				{ agent: "Atlas", tool: "pi", pid: 30 },
				{ agent: "Atlas", tool: "claude-code", pid: 77 },
				{ agent: "Birch", tool: "codex", pid: 88, codexSession: "019a-thread" },
			] as const;
			for (const record of records) expect(recordSession(config.dataDir, record, linux(table))).toBe(true);
			const kept = () => records.every((record) => existsSync(hostFile(config.dataDir, record.pid)));
			const blind = { ...elsewhere(table, procfs, 50), ns: (pid: number | "self") => (pid === "self" ? undefined : NS) };
			// One that reads another boot id (another kernel's view of the folder, or a faked id) proves no record dead either.
			const rebooted = { ...elsewhere(table, procfs, 50), boot: () => "1c1c1c1c-boot" };
			for (const deps of [elsewhere(table, procfs, 50), blind, rebooted]) {
				for (const record of records) expect(liveSession(config.dataDir, record.pid, deps)).toBeUndefined();
				expect(insideSession([config.dataDir], {}, config, deps)).toBeUndefined();
				expect(insideSession([config.dataDir], { CLAUDE_PID: "77" }, config, deps)).toEqual({ agent: undefined, tool: "claude-code", via: "marker", dataDir: config.dataDir });
				expect(insideSession([config.dataDir], { CODEX_THREAD_ID: "019a-thread" }, config, deps)).toEqual({ agent: undefined, tool: "codex", via: "marker", dataDir: config.dataDir });
				expect(insideSession([config.dataDir], { ORRERY_HOST: "30" }, config, deps)).toEqual({ agent: undefined, tool: "pi", via: "marker", dataDir: config.dataDir });
				// A new record made there doesn't take them out either (nor is made: its host isn't numbered here).
				expect(recordSession(config.dataDir, { agent: "Birch", tool: "pi", pid: 60 }, deps)).toBe(false);
				expect(kept()).toBe(true);
				// Still Codex's session's host, so no other process takes that session from here.
				expect(codexHosts([config.dataDir], "019a-thread", deps)).toEqual([88]);
			}
			// Back in their own namespace they are live.
			expect(liveSession(config.dataDir, 77, linux(table))).toMatchObject({ agent: "Atlas" });
		});
	}

	it("a claim numbered in another pid namespace proves nothing, and to a tool asking about itself is no launch of its own", () => {
		const { config } = world();
		const table = tools();
		const atlas = join(config.dataDir, "agents", "Atlas");
		mkdirSync(join(atlas, "claims"), { recursive: true });
		const [token, mine] = [newToken(), newToken()];
		// 77 lives here, but its claim was made in another namespace, where 77 is another process; so was 60's.
		writeFileSync(join(atlas, "claims", token), "77\npid:[4026533000]\n");
		writeFileSync(join(atlas, "claims", mine), "60\npid:[4026533000]\n");
		const deps = linux(table, 50);
		const unknown = { agent: undefined, tool: undefined, via: "marker", dataDir: config.dataDir };
		expect(insideSession([config.dataDir], { ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: token }, config, deps)).toEqual(unknown);
		expect(insideSession([config.dataDir], { ORRERY_AGENT_TOKEN: token }, config, deps)).toEqual(unknown);
		expect(insideSession([config.dataDir], { ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: token }, config, { ...deps, self: 60 })).toEqual(unknown);
		expect(insideSession([config.dataDir], { ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: mine }, config, { ...deps, self: 60 })).toEqual(unknown);
		// A claim made here (real claimToken: this process's namespace) read from another namespace, or where this one's
		// can't be read: the same. A tool asking about itself there is inside a session it can't name.
		const here = newToken();
		claimToken(atlas, here, 77, deps.alive);
		for (const reader of [elsewhere(table, "kept", 50), { ...deps, ns: (pid: number | "self") => (pid === "self" ? undefined : NS) }]) {
			if (pidNamespace("self") === undefined) break; // no namespaces here: the claim says none
			expect(insideSession([config.dataDir], { ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: here }, config, reader)).toEqual(unknown);
			expect(insideSession([config.dataDir], { ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: here }, config, { ...reader, self: 60 })).toEqual(unknown);
		}
		// From its own namespace it proves Atlas; an older one-line claim is judged as before, by its pid.
		expect(insideSession([config.dataDir], { ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: here }, config, deps)).toMatchObject({ agent: "Atlas" });
		const old = newToken();
		writeFileSync(join(atlas, "claims", old), "77\n");
		expect(insideSession([config.dataDir], { ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: old }, config, deps)).toMatchObject({ agent: "Atlas" });
	});

	it("a record made in another namespace under the asking tool's own number still marks; the tool's own record here, live or unsure, doesn't", () => {
		const { config } = world();
		const table = tools();
		expect(recordSession(config.dataDir, { agent: "Atlas", tool: "claude-code", pid: 60 }, linux(table))).toBe(true);
		const unknown = { agent: undefined, tool: "claude-code", via: "marker", dataDir: config.dataDir };
		for (const procfs of ["kept", "remounted"] as const) {
			const there = { ...elsewhere(table, procfs, 50), self: 60 };
			expect(insideSession([config.dataDir], { CLAUDE_PID: "60" }, config, there)).toEqual(unknown);
			expect(insideSession([config.dataDir], { ORRERY_HOST: "60" }, config, there)).toEqual(unknown);
		}
		const here = { ...linux(table, 50), self: 60 };
		for (const deps of [here, { ...here, proc: () => undefined }]) {
			expect(insideSession([config.dataDir], { CLAUDE_PID: "60" }, config, deps)).toBeUndefined();
			expect(insideSession([config.dataDir], { ORRERY_HOST: "60" }, config, deps)).toBeUndefined();
		}
		expect(existsSync(hostFile(config.dataDir, 60))).toBe(true);
	});

	/**
	 * Why `unshare` with `flags` can't start a process here, or undefined when it can. Each way is tried first: a host may
	 * allow a new pid namespace but not --mount-proc's new /proc (GitHub's Linux runners: "cannot change root filesystem
	 * propagation: Permission denied").
	 */
	const unshareRefused = (flags: readonly string[]): string | undefined => {
		if (process.platform !== "linux") return "pid namespaces are Linux's";
		const probe = spawnSync("unshare", [...flags, "true"], { encoding: "utf8" });
		if (probe.status === 0) return undefined;
		return `unshare ${flags.join(" ")} can't run here: ${probe.error?.message ?? (probe.stderr.trim() || `exit ${probe.status}`)}`;
	};

	for (const flags of [["-Upf"], ["-Upf", "--mount-proc"]]) {
		it(`a real process in a new pid namespace (unshare ${flags.join(" ")}) keeps the record and the claim, can't take the claim over, and is inside a session it can't name before and after trying`, (context) => {
			const refused = unshareRefused(flags);
			if (refused !== undefined) context.skip(refused);
			const { root, toml, config } = world();
			const dir = config.dataDir;
			const token = newToken();
			const atlas = join(dir, "agents", "Atlas");
			expect(recordSession(dir, { agent: "Atlas", tool: "claude-code", pid: process.pid })).toBe(true);
			expect(claimToken(atlas, token, process.pid)).toBe(true);
			// A nested tool asks about itself, tries to claim the token it inherited (as pickAgent would), and asks again.
			const script = `Promise.all([import(${JSON.stringify(SESSIONS)}), import(${JSON.stringify(CONFIG)}), import(${JSON.stringify(PICK)})]).then(([s, c, p]) => {
				const config = c.parseConfig(${JSON.stringify(toml)}, ${JSON.stringify(root)});
				const claude = s.insideSession([config.dataDir], { CLAUDE_PID: ${JSON.stringify(String(process.pid))} }, config) ?? null;
				const env = { ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: ${JSON.stringify(token)} };
				const nested = s.insideSession([config.dataDir], env, config, { self: process.pid }) ?? null;
				const took = p.claimToken(${JSON.stringify(atlas)}, ${JSON.stringify(token)}, process.pid);
				const after = s.insideSession([config.dataDir], env, config, { self: process.pid }) ?? null;
				process.stdout.write(JSON.stringify({ claude, nested, took, after }));
			})`;
			const node = [process.execPath, "--disable-warning=ExperimentalWarning", "-e", script];
			const run = (prefix: string[]) => {
				const child = spawnSync(prefix[0] ?? node[0], [...prefix.slice(1), ...(prefix.length > 0 ? node : node.slice(1))], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: root } });
				return { out: JSON.parse(child.stdout || "null"), err: child.stderr };
			};
			// In this namespace the child finds this process, its parent, by ancestry.
			const same = run([]);
			const found = { agent: "Atlas", tool: "claude-code", via: "ancestry", dataDir: dir };
			expect(same.out, same.err).toEqual({ claude: found, nested: found, took: false, after: found });
			const inside = run(["unshare", ...flags]);
			const unknown = { agent: undefined, via: "marker", dataDir: dir };
			expect(inside.out, `unshare ${flags.join(" ")}: ${inside.err}`).toEqual({ claude: { ...unknown, tool: "claude-code" }, nested: unknown, took: false, after: unknown });
			expect(liveSession(dir, process.pid)).toMatchObject({ agent: "Atlas" });
			expect(claimHeld(atlas, token)).toMatchObject({ pid: process.pid });
		});
	}
});

describe("nestedNotice", () => {
	it("names the outer session's agent and tool, or says an agent's, and leaves out a tool it doesn't know", () => {
		const inside = (agent: string | undefined, tool: SessionTool | undefined): Inside => ({ agent, tool, via: "ancestry", dataDir: "/data" });
		expect(nestedNotice(inside("Atlas", "claude-code"))).toBe("Orrery: started inside Atlas's session (Claude Code), so this one opens no memory and records nothing.");
		expect(nestedNotice(inside("Atlas", "run"))).toBe("Orrery: started inside Atlas's session (orrery run), so this one opens no memory and records nothing.");
		expect(nestedNotice(inside(undefined, "pi"))).toBe("Orrery: started inside an agent's session (pi), so this one opens no memory and records nothing.");
		expect(nestedNotice(inside("Birch", undefined))).toBe("Orrery: started inside Birch's session, so this one opens no memory and records nothing.");
		expect(nestedNotice(inside(undefined, undefined))).toBe("Orrery: started inside an agent's session, so this one opens no memory and records nothing.");
	});

	it("started inside a coding tool's session that is no agent's (`plain`, spec 2026-10-19-no-agent-sessions §4c): names that tool", () => {
		const plain = (tool: string): Inside => ({ agent: undefined, tool: undefined, via: "ancestry", dataDir: "/data", plain: tool });
		expect(nestedNotice(plain("claude"))).toBe("Orrery: started inside a Claude Code session that is no agent's, so this one opens no memory and records nothing.");
		expect(nestedNotice(plain("codex"))).toBe("Orrery: started inside a Codex session that is no agent's, so this one opens no memory and records nothing.");
		expect(nestedNotice(plain("pi"))).toBe("Orrery: started inside a pi session that is no agent's, so this one opens no memory and records nothing.");
		// "an" before a vowel, as the CLI's refusal says it (src/cli/gate.ts).
		expect(nestedNotice(plain("opencode"))).toBe("Orrery: started inside an OpenCode session that is no agent's, so this one opens no memory and records nothing.");
		expect(nestedNotice(plain("omp"))).toBe("Orrery: started inside an OMP session that is no agent's, so this one opens no memory and records nothing.");
		expect(nestedNotice(plain("gemini"))).toBe("Orrery: started inside a Gemini session that is no agent's, so this one opens no memory and records nothing.");
	});

	it("recordedPlain reads a decision record's `plain` and `variable`, or calls the record unreadable", () => {
		expect(recordedPlain({})).toEqual({});
		expect(recordedPlain({ plain: "claude" })).toEqual({ plain: "claude" });
		expect(recordedPlain({ plain: "codex", variable: "CODEX_THREAD_ID" })).toEqual({ plain: "codex", variable: "CODEX_THREAD_ID" });
		for (const value of [{ plain: "Claude" }, { plain: 1 }, { variable: "CLAUDECODE" }, { plain: "claude", variable: "HOME" }, { plain: "claude", variable: 2 }]) {
			expect(recordedPlain(value), JSON.stringify(value)).toBe("unreadable");
		}
	});

	it("found by a variable (not a process): names it, and where the README says what to do about one left over", () => {
		const marked = (tool: string, variable: string): Inside => ({ agent: undefined, tool: undefined, via: "marker", dataDir: "/data", plain: tool, variable });
		expect(nestedNotice(marked("claude", "CLAUDECODE"))).toBe(
			'Orrery: started inside a Claude Code session that is no agent\'s (found CLAUDECODE; see "Leftover markers" in the README), so this one opens no memory and records nothing.',
		);
		expect(nestedNotice(marked("opencode", "OPENCODE_SESSION_ID"))).toBe(
			'Orrery: started inside an OpenCode session that is no agent\'s (found OPENCODE_SESSION_ID; see "Leftover markers" in the README), so this one opens no memory and records nothing.',
		);
	});
});

describe("ALLOWED_INSIDE", () => {
	it("names the commands that run inside an agent session, in a module of its own with no imports, which sessions.ts re-exports", () => {
		expect(ALLOWED_INSIDE).toBe(ALLOWED_ALONE);
		expect(readFileSync(new URL("../../src/agent/inside-commands.ts", import.meta.url), "utf8")).not.toMatch(/^import /m);
		expect([...ALLOWED_INSIDE].sort()).toEqual(["browse", "claude-hook", "claude-mod", "codex-hook", "compactor", "grok-hook", "grok-status", "help", "holder", "mcp", "status", "usage"]);
	});
});
