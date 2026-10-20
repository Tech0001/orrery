/**
 * Which agent's session a process runs in (spec 2026-10-18-agent-permissions-design §2): the CLI asks before it runs a
 * command, and each tool's integration before it opens memory, so that a command or a tool started from an agent's
 * shell is known as that agent's, whatever folder, config or environment it was given.
 *
 * Session records. A tool session that opens an agent's memory records its host process in the data folder that holds
 * that memory, and forgets it when the session closes: <data>/session-hosts/<pid>.json, holding
 * {"agent","tool","pid","start"}, for Codex "codexSession", on Linux "ns" and "boot", and "config", the config file the
 * host loaded (HarnessConfig.file), with "configReal", its real path then, when it loaded one; 0600 in a 0700 folder,
 * written whole (src/agent/private-file.ts), and read only as a small regular file of this user's, never through a
 * link. The CLI takes that config, and no other, for a command run inside the session (src/cli/gate.ts).
 * `start` is when the process started, so a reused pid is no session: Linux's /proc/<pid>/stat field 22 (clock ticks
 * since boot), macOS's `ps -o lstart=` (to the second, asked in UTC and the C locale so every process spells it alike).
 * On Linux a pid means a process only in the pid namespace it is numbered in: from another one (`unshare -p`, a
 * container's or a sandbox's shell) kill(0) finds it gone and /proc shows another process, or none. So a Linux record
 * holds that namespace (`ns`, the host's /proc/<pid>/ns/pid, which must be the recorder's own) and the boot's id
 * (`boot`: the first namespace's id is the same at every boot), and is judged only from that namespace, in that boot.
 *
 * A record is live while its process lives and started when the record says; stale when its process is gone, started at
 * another time, or (Linux) belonged to another boot. The look that finds a stale record takes it down exclusively
 * (removeStale, src/agent/exclusive.ts), so a fresh record that took the name meanwhile stays, and each new record takes
 * out the dead ones beside it. Any other record is unsure, kept, and never taken down: one read from another pid
 * namespace (or where the namespace can't be read), one of a live process whose start can't be read, a file that is no
 * record this version reads while its process lives (or, on Linux, at all), and one that can't be read (a link, a FIFO).
 * An unsure record is no session to the ancestry: its pid may name another process here, the user's own terminal among
 * others, and that is never refused. A marker pointing at one is a session whose identity is unknown (fail closed).
 *
 * Ancestry. A process is inside a session when one of its ancestors is recorded, live, in a data folder it asks about, or
 * in any folder above one that holds records (judgedFolders: a data folder may sit inside another, and a records folder
 * planted nearer hides none further up); the nearest ancestor wins, and its record is the identity. Linux walks /proc one
 * parent at a time; macOS takes one `ps -A -o pid=,ppid=` snapshot. The walk stops at pid 1, at the top of a pid
 * namespace, or after MAX_DEPTH steps. It is skipped when no folder judged holds a record, so a hook or a command outside
 * every session costs a few stats and a readdir.
 *
 * Markers, the backup when the ancestry is cut (a detached process, a process in another pid namespace). With a config
 * they count only for its data folder, and a name the config doesn't have is ignored (a scratch home's config, a
 * developer's). Each says there is a session; only a secret, a launch's token claimed by a live process (its claim
 * holds the pid and, on Linux, its namespace: src/agent/pick.ts), says whose:
 * - ORRERY_AGENT_TOKEN, with or without ORRERY_AGENT: the agent in whose claims a live process holds it. ORRERY_AGENT
 *   naming a configured agent whose token proves nothing is a session of unknown identity.
 * - OPENCODE_CONFIG_CONTENT carrying Orrery's plugin (src/opencode/options.ts): the agent in whose claims a live
 *   process holds the token in the launch's token file (src/opencode/token-file.ts); for a configured agent whose token
 *   proves nothing, a session of unknown identity.
 * - CLAUDE_PID naming a live Claude Code record, ORRERY_HOST (HOST_ENV, which every tool sets for its shell) naming a
 *   live record of any tool, or CODEX_THREAD_ID / CODEX_SESSION_ID equal to a live record's Codex session: never an
 *   identity by itself. Pids and Codex ids are anyone's to read, so a detached process could copy another agent's; the
 *   record's agent stands only when a token proves the same agent. ORRERY_HOST is what a session opened by its folder
 *   (no token) leaves a merely detached process (`setsid -f pi -p …`).
 * - A claim numbered in another pid namespace than this process's can't be judged here: a session of unknown identity.
 *   So can a record a CLAUDE_PID, an ORRERY_HOST or a Codex id points at from there: Codex's sandboxed shell, in a pid
 *   namespace of its own, is inside a session whose agent it can't name, and only `help` runs there.
 * Tokens proving different agents, or a record naming another agent than the token, leave the identity unknown. Without
 * a config nothing can be checked, so any marker (ORRERY_AGENT, ORRERY_AGENT_TOKEN, ORRERY_HOST, CLAUDE_PID, a Codex id,
 * or an OPENCODE_CONFIG_CONTENT naming Orrery's plugin) is a session of unknown identity.
 *
 * A tool asking whether it was itself started inside a session (`self`, its host process) carries its own launch's
 * markers: the ORRERY_AGENT and token its launcher gave it, OpenCode's config, its own ORRERY_HOST, CLAUDE_PID or Codex
 * thread id.
 * For it a marker counts only when it points at another process: a token claimed by a live process other than `self`,
 * or by one in another namespace (an unclaimed token, one whose claimant is dead, or its own claim is its own launch's,
 * so asking before or after claiming gives one answer), a record whose pid isn't `self`. The walk starts above `self`,
 * and passes it over, so its own record never matches. Without a config its markers are taken as its own: such a tool
 * opens no memory anyway.
 *
 * Tool sessions (spec 2026-10-19-no-agent-sessions-design §1): a process no agent's session holds may still have been
 * started from a coding tool's, which is no agent's. toolSession says so, by ancestry first, else by markers:
 * - Ancestry: the nearest ancestor (the same walk) whose program is a coding tool (CODING_TOOLS), matched exactly, case
 *   and all, so the desktop apps (`claude-desktop`, macOS's `Claude`) and the tools' helpers (`codex-code-mode`,
 *   `MainThread`) are none. A program is a file name without a trailing `.exe` (OpenCode's on Linux): first that of the
 *   process's name (Linux's comm, from the stat line the walk read; macOS's comm, the whole argv[0], from the walk's one
 *   ps snapshot); then, where that names no tool, that of argv[0] (on Linux not one holding whitespace, a process title
 *   such as sshd's), and for an interpreter (node, bun, deno, python…, bash, sh) that of its script (past its own
 *   options, Interpreter) without `.exe`, `.js`, `.mjs`, `.cjs` or `.py`, or python's `-m` module. Linux reads argv for
 *   every ancestor whose comm names no tool, one small /proc file each: comm is only the kernel's name for a process,
 *   and a thread may rename it (Node 26 shows `node-MainThread`). macOS asks ps for args only for its interpreters,
 *   since comm is argv[0] there; ps joins argv with spaces, so a script's path with spaces is the longest run of words
 *   that is a file.
 * - Markers (TOOL_MARKERS), for a shell whose ancestry is cut (Codex's sandboxed shell, in a pid namespace of its own; a
 *   detached process): the first set, in that order. A nested tool keeps its parents' markers, so a marker names a tool
 *   somewhere above, not the nearest. A Codex id that a record names is an agent's Codex session, no marker.
 * A tool session is no agent's: the caller asks only when insideSession finds none. A tool's integration asks about its
 * own host process (`own`, src/agent/plain-nested.ts): its own launcher right above it, by the shape the tool starts it in
 * (npm's Codex launcher, OpenCode's TUI, the Claude Code desktop app), is passed over, and its own tool's markers count
 * only as far as what it was started with shows (toolSession).
 *
 * Nothing here throws: a record that can't be written makes recordSession false, for its caller to say so, and a
 * folder or file that can't be read holds no session.
 * Imports Node built-ins and relative modules only, for pi and OMP, which load this file; through pick.ts that is also
 * config.ts, and with it smol-toml and the memory module, which pi and OMP load already.
 */

import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { namesOrreryPlugin } from "../install/layout.ts";
import { readPluginOptions } from "../opencode/options.ts";
import { launchTokenFile, readTokenFile } from "../opencode/token-file.ts";
import type { AgentConfig, HarnessConfig } from "./config.ts";
import { removeStale, stray } from "./exclusive.ts";
import { AGENT_ENV, agentNamed, claimHeld, reused, TOKEN_ENV } from "./pick.ts";
import { readPrivate, writePrivate } from "./private-file.ts";
import { bootId, pidNamespace, processAlive, processEnv, processStart, procStat, psOutput, readProcStat } from "./process.ts";
import { safeText } from "./source-labels.ts";

export { ALLOWED_INSIDE } from "./inside-commands.ts";
/** When a process started (src/agent/process.ts), as session records hold it. */
export { processStart };

/**
 * The variable a tool sets in its own environment to its host pid when it opens an agent's memory, so its shell, and
 * whatever is started from it, carries it: a marker for a process detached from the tool (module doc). Its value is
 * public, like CLAUDE_PID's: it says there is a session, never whose.
 */
export const HOST_ENV = "ORRERY_HOST";

/** The tool a session runs in: `run` is `orrery run`. */
export type SessionTool = "pi" | "omp" | "claude-code" | "codex" | "opencode" | "run";

/** Each tool as a notice (and the CLI's refusal, src/cli/gate.ts) names it. */
export const TOOL_NAMES: Readonly<Record<SessionTool, string>> = { pi: "pi", omp: "OMP", "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode", run: "orrery run" };
/** Every SessionTool, for reading one from a record (here, and the Claude Code and Codex decisions). */
export const SESSION_TOOLS: ReadonlySet<string> = new Set(Object.keys(TOOL_NAMES));

export interface SessionRecord {
	readonly agent: string;
	readonly tool: SessionTool;
	/** The session's host process: pi's, OMP's, Claude Code's, Codex's, OpenCode's server, or `orrery run`'s. */
	readonly pid: number;
	/** When that process started, as processStart reads it. */
	readonly start: string;
	/** A Codex session's id, which Codex hands its shell as CODEX_THREAD_ID (or CODEX_SESSION_ID). */
	readonly codexSession?: string;
	/** Linux: the pid namespace `pid` is numbered in ("pid:[4026531836]"). */
	readonly ns?: string;
	/** Linux: the boot's id. */
	readonly boot?: string;
	/** The config file the host loaded (HarnessConfig.file, an absolute path), when it loaded one from a file. */
	readonly config?: string;
	/**
	 * That file's real path when the record was made (with `config`, always): a link at `config` pointed elsewhere since
	 * is no longer the host's config.
	 */
	readonly configReal?: string;
}

/** The session a process runs in. */
export interface Inside {
	/** The session's agent; undefined when only a marker says there is a session, and nothing proves whose. */
	readonly agent: string | undefined;
	readonly tool: SessionTool | undefined;
	readonly via: "ancestry" | "marker";
	/** The data folder whose record or config found it; with no config, the first data folder asked about ("" for none). */
	readonly dataDir: string;
	/** The config file the record of the session's agent names (SessionRecord.config), and its real path then. */
	readonly config?: string;
	readonly configReal?: string;
	/**
	 * Not an agent's session but a coding tool's that is no agent's (spec 2026-10-19-no-agent-sessions §4c,
	 * src/agent/plain-nested.ts): that tool, as toolSession names it (`agent` and `tool` are then undefined).
	 */
	readonly plain?: string;
	/** With `plain`, found by a variable (a TOOL_MARKERS one), not by a process: that variable. */
	readonly variable?: string;
}

/** How processes are read; each defaults to this system's own way (tests give fakes). */
export interface SessionDeps {
	/** Linux: a process's /proc/<pid>/stat line, or undefined when it can't be read (gone). */
	readonly proc?: (pid: number) => string | undefined;
	/** macOS: ps's output for `args`, or undefined when it fails (a gone pid). */
	readonly ps?: (args: readonly string[]) => string | undefined;
	/** Linux: the pid namespace a process (or this one, "self") is in (default pidNamespace). */
	readonly ns?: (pid: number | "self") => string | undefined;
	/** Linux: the boot's id (default bootId). */
	readonly boot?: () => string | undefined;
	/** Whether a pid lives (default processAlive). */
	readonly alive?: (pid: number) => boolean;
	/** Which system's way to ask: Linux's, macOS's, or none elsewhere (default this one's). */
	readonly platform?: NodeJS.Platform;
	/** insideSession and toolSession: the process whose ancestors are walked (default: insideSession `self`, else this one). */
	readonly from?: number;
	/**
	 * toolSession: a process's argv, or undefined when it can't be read (gone). Default: Linux's /proc/<pid>/cmdline;
	 * macOS's `ps -o args=`, split at its spaces, its argv[0] the walk's snapshot's comm (whole: it may hold spaces).
	 */
	readonly cmdline?: (pid: number) => readonly string[] | undefined;
	/**
	 * toolSession, asked by a tool about its own host: the values of `names` in the environment process `pid` was started
	 * with, or undefined when it can't be read (default processEnv, src/agent/process.ts).
	 */
	readonly startEnv?: (pid: number, names: readonly string[]) => Readonly<Record<string, string>> | undefined;
	/**
	 * insideSession, asked by a tool about its own session (pi's or OMP's extension, Claude Code's or Codex's hooks, the
	 * OpenCode plugin, `orrery run`): the tool's host process. Its own launch's markers are then no evidence (module doc);
	 * unset for the CLI.
	 */
	readonly self?: number;
}

/** The folder in a data folder that holds session records. */
const FOLDER = "session-hosts";
/** A record's name: its process's pid. Temporary and graveyard files beside it have other names. */
const RECORD_NAME = /^([1-9]\d*)\.json$/;
/** The most of a record read: a whole one is a few hundred bytes. */
const RECORD_MAX = 4096;
/** The most ancestors walked: no session nests that deep, and a loop ends here at worst. */
const MAX_DEPTH = 64;

const folderOf = (dataDir: string): string => join(dataDir, FOLDER);
const fileOf = (dataDir: string, pid: number): string => join(folderOf(dataDir), `${pid}.json`);
const positive = (pid: number): boolean => Number.isInteger(pid) && pid > 0;
const onLinux = (deps: SessionDeps): boolean => (deps.platform ?? process.platform) === "linux";
const onMac = (deps: SessionDeps): boolean => (deps.platform ?? process.platform) === "darwin";
const namespaceOf = (deps: SessionDeps, pid: number | "self"): string | undefined => (deps.ns ?? pidNamespace)(pid);

function pidNamed(name: string): number | undefined {
	const match = RECORD_NAME.exec(name);
	return match === null ? undefined : Number(match[1]);
}

/** Processes as this system tells them: each one's parent, and its name (undefined: unknown). */
interface Processes {
	readonly parentOf: (pid: number) => number | undefined;
	/** Linux: comm, from the stat line the walk read. macOS, with `names`: comm, the whole argv[0], from the snapshot. */
	readonly nameOf: (pid: number) => string | undefined;
}

/**
 * Processes as this system tells them: Linux reads /proc at each step, each stat line once (so a name asked for after the
 * walk reads nothing more); macOS reads one snapshot of all, with `names` their comm too. `-ww`: BSD ps cuts its last
 * column at the terminal's width, 79 when there is none.
 */
function processes(deps: SessionDeps, names = false): Processes {
	if (onLinux(deps)) {
		const read = deps.proc ?? readProcStat;
		const seen = new Map<number, ReturnType<typeof procStat>>();
		const stat = (pid: number) => {
			if (!seen.has(pid)) {
				const line = read(pid);
				seen.set(pid, line === undefined ? undefined : procStat(line));
			}
			return seen.get(pid);
		};
		return {
			parentOf: (pid) => {
				const ppid = Number(stat(pid)?.fields[1]);
				return Number.isInteger(ppid) ? ppid : undefined;
			},
			nameOf: (pid) => stat(pid)?.name,
		};
	}
	if (onMac(deps)) {
		const table = new Map<number, { readonly ppid: number; readonly name?: string }>();
		const columns = names ? ["-A", "-ww", "-o", "pid=,ppid=,comm="] : ["-A", "-o", "pid=,ppid="];
		const row = names ? /^\s*(\d+)\s+(\d+)(?:\s+(.*?))?\s*$/ : /^\s*(\d+)\s+(\d+)\s*$/;
		for (const line of ((deps.ps ?? psOutput)(columns) ?? "").split("\n")) {
			const match = row.exec(line);
			if (match !== null) table.set(Number(match[1]), { ppid: Number(match[2]), ...(match[3] ? { name: match[3] } : {}) });
		}
		return { parentOf: (pid) => table.get(pid)?.ppid, nameOf: (pid) => table.get(pid)?.name };
	}
	return { parentOf: () => undefined, nameOf: () => undefined };
}

/** The ancestors of `from` (default this process), nearest first, without `from` itself or pid 1. */
export function ancestors(from: number = process.pid, deps: SessionDeps = {}): number[] {
	return walk(from, processes(deps).parentOf);
}

/** The ancestors of `from` as `parentOf` tells them (ancestors). */
function walk(from: number, parentOf: (pid: number) => number | undefined): number[] {
	return walkTo(from, parentOf).pids;
}

/**
 * The ancestors of `from` (walk), and whether the walk reached the top (`top`): pid 1, or 0 above the top of a pid
 * namespace, with every parent read. A parent that can't be read, a loop, or MAX_DEPTH ends it short of the top.
 */
function walkTo(from: number, parentOf: (pid: number) => number | undefined): { readonly pids: number[]; readonly top: boolean } {
	const found: number[] = [];
	let pid = from;
	while (found.length < MAX_DEPTH) {
		const parent = parentOf(pid);
		if (parent === undefined) return { pids: found, top: false };
		// pid 1, or 0 above the top of a pid namespace, ends the walk; so does a loop (a pid reused during the walk).
		if (parent <= 1) return { pids: found, top: true };
		if (parent === from || found.includes(parent)) return { pids: found, top: false };
		found.push(parent);
		pid = parent;
	}
	return { pids: found, top: false };
}

/**
 * `value` as the record of `pid`, or undefined when it is none: its agent, tool, pid or start can't be read.
 * - `doubtful` when its codexSession, ns or boot is there but no non-empty string: the record is judged unsure (module
 *   doc: fail closed), never taken for none, and those fields are left out.
 * - A config without its real path, or either not an absolute path, is left out: only the config is untrusted, and the
 *   CLI takes the data folder's own (src/cli/gate.ts).
 */
function recordOf(value: unknown, pid: number): { readonly record: SessionRecord; readonly doubtful: boolean } | undefined {
	const { agent, tool, pid: own, start, codexSession, ns, boot, config, configReal } = (value ?? {}) as Record<string, unknown>;
	if (typeof agent !== "string" || agent === "" || typeof tool !== "string" || !SESSION_TOOLS.has(tool) || own !== pid || typeof start !== "string" || start === "") return undefined;
	const text = (field: unknown): field is string => typeof field === "string" && field !== "";
	const doubtful = [codexSession, ns, boot].some((field) => field !== undefined && !text(field));
	const configured = text(config) && text(configReal) && isAbsolute(config) && isAbsolute(configReal);
	const record: SessionRecord = {
		agent,
		tool: tool as SessionTool,
		pid,
		start,
		...(text(codexSession) ? { codexSession } : {}),
		...(text(ns) ? { ns } : {}),
		...(text(boot) ? { boot } : {}),
		...(configured ? { config, configReal } : {}),
	};
	return { record, doubtful };
}

/**
 * What a record file stands for, to this process (module doc). An unsure one may hold a record (one read from another
 * pid namespace, or of a live process whose start can't be read); `foreign` when it isn't known to be numbered in this
 * process's pid namespace, so its pid may name another process here.
 */
type Standing =
	| { readonly kind: "none" }
	| { readonly kind: "stale" }
	| { readonly kind: "live"; readonly record: SessionRecord }
	| { readonly kind: "unsure"; readonly record?: SessionRecord; readonly foreign: boolean };

/** What the file at `file`, a record of `pid`, stands for (Standing). */
function standing(file: string, pid: number, deps: SessionDeps): Standing {
	let text: string;
	try {
		text = readPrivate(file, RECORD_MAX);
	} catch (error) {
		// A link or a FIFO in a record's place, or a file that can't be read: kept, and judged by nobody.
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "none" } : { kind: "unsure", foreign: true };
	}
	let parsed: ReturnType<typeof recordOf>;
	try {
		parsed = recordOf(JSON.parse(text), pid);
	} catch {
		// no JSON: no record this version reads
	}
	const record = parsed?.record;
	if (onLinux(deps)) {
		// Judged only from the namespace its pid is numbered in (module doc); from anywhere else, kept.
		const here = namespaceOf(deps, "self");
		if (record?.ns === undefined || here === undefined || record.ns !== here) return { kind: "unsure", record, foreign: true };
		const boot = (deps.boot ?? bootId)();
		if (boot === undefined || record.boot === undefined) return { kind: "unsure", record, foreign: false };
		if (record.boot !== boot) return { kind: "stale" };
	}
	if (!(deps.alive ?? processAlive)(pid)) return { kind: "stale" };
	if (record === undefined) return { kind: "unsure", foreign: false };
	// A field it holds but that can't be read: kept, and judged unsure.
	if (parsed?.doubtful === true) return { kind: "unsure", record, foreign: false };
	const start = processStart(pid, deps);
	if (start === undefined) return { kind: "unsure", record, foreign: false };
	return start === record.start ? { kind: "live", record } : { kind: "stale" };
}

/** What `dataDir`'s record of `pid` stands for (Standing); a stale one is taken down. */
function judged(dataDir: string, pid: number, deps: SessionDeps): Standing {
	if (!positive(pid)) return { kind: "none" };
	const file = fileOf(dataDir, pid);
	const found = standing(file, pid, deps);
	if (found.kind === "stale") {
		try {
			// Judged again once moved aside: a fresh record that took the name meanwhile goes back. Gone counts as stale.
			removeStale(file, (moved) => ["stale", "none"].includes(standing(moved, pid, deps).kind));
		} catch {
			// left for the next look, or the next record's prune
		}
	}
	return found;
}

/**
 * The session process `pid` hosts for `dataDir`'s memory: only while it lives and started when its record says, judged
 * from the pid namespace the record was made in. A stale record goes. An unsure one (module doc) is no session, though
 * it stays (it may be a real session's): the pid may by now name another process, the user's own terminal among
 * others, and that is never refused.
 */
export function liveSession(dataDir: string, pid: number, deps: SessionDeps = {}): SessionRecord | undefined {
	const found = judged(dataDir, pid, deps);
	return found.kind === "live" ? found.record : undefined;
}

/** The pids `dataDir` holds records for (none when its folder can't be read). */
function recordedPids(dataDir: string): Set<number> {
	try {
		return new Set(readdirSync(folderOf(dataDir)).map(pidNamed).filter((pid) => pid !== undefined));
	} catch {
		return new Set();
	}
}

/** Takes out `dataDir`'s stale records but `keep`'s, and temporary or graveyard files left long enough to be strays. */
function pruneSessions(dataDir: string, keep: number, deps: SessionDeps): void {
	let names: string[];
	try {
		names = readdirSync(folderOf(dataDir));
	} catch {
		return;
	}
	for (const name of names) {
		const pid = pidNamed(name);
		if (pid === keep) continue;
		if (pid !== undefined) judged(dataDir, pid, deps);
		else if (stray(join(folderOf(dataDir), name))) {
			try {
				rmSync(join(folderOf(dataDir), name), { force: true });
			} catch {
				// gone already, or no file: left alone
			}
		}
	}
}

/**
 * Records that process `record.pid` hosts a session of `record.agent`'s memory in `dataDir`, with the process's start
 * time, and on Linux its pid namespace and the boot. False when it can't: the start can't be read, the record is no
 * record, the host is in another pid namespace than this process (its pid wouldn't be the one a reader here sees), or
 * nothing can be written there. A config is kept with its real path now (configReal); one whose path can't be resolved
 * is recorded as none.
 */
export function recordSession(dataDir: string, record: Omit<SessionRecord, "start" | "ns" | "boot" | "configReal">, deps: SessionDeps = {}): boolean {
	const start = processStart(record.pid, deps);
	if (start === undefined) return false;
	let place = {};
	if (onLinux(deps)) {
		const ns = namespaceOf(deps, record.pid);
		const boot = (deps.boot ?? bootId)();
		if (ns === undefined || ns !== namespaceOf(deps, "self") || boot === undefined) return false;
		place = { ns, boot };
	}
	let configured = {};
	if (record.config !== undefined) {
		try {
			configured = { config: record.config, configReal: realpathSync(record.config) };
		} catch {
			// no config to name: the CLI then takes only one in the data folder (src/cli/gate.ts)
		}
	}
	const parsed = recordOf({ ...record, config: undefined, ...configured, start, ...place }, record.pid);
	if (parsed === undefined || parsed.doubtful) return false;
	const full = parsed.record;
	pruneSessions(dataDir, full.pid, deps);
	try {
		writePrivate(fileOf(dataDir, full.pid), `${JSON.stringify(full)}\n`);
		return true;
	} catch {
		// A data folder that can't be written (or a link in its folder's place): the caller says the session is unrecorded.
		return false;
	}
}

/** Removes process `pid`'s record from `dataDir`, when its session closes. */
export function forgetSession(dataDir: string, pid: number): void {
	if (!positive(pid)) return;
	try {
		rmSync(fileOf(dataDir, pid), { force: true });
	} catch {
		// left: once the process is gone, the next look takes it as stale
	}
}

/** The variables that mark a session, OPENCODE_CONFIG_CONTENT aside (it marks one only when it names Orrery's plugin). */
const MARKERS = [AGENT_ENV, TOKEN_ENV, HOST_ENV, "CLAUDE_PID", "CODEX_THREAD_ID", "CODEX_SESSION_ID"] as const;

/** The most links followed from a dangling one to the folder its target would be in. */
const MAX_LINKS = 8;

/** A path with its links resolved, or undefined when it can't be (it isn't there). */
export function realOrNone(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

/** The nearest part of `path` that exists, links resolved (the root at worst). */
function nearestExisting(path: string): string {
	let dir = resolve(path);
	for (;;) {
		const found = realOrNone(dir);
		if (found !== undefined) return found;
		const parent = dirname(dir);
		if (parent === dir) return dir;
		dir = parent;
	}
}

/**
 * Where judging `path` starts: the nearest part of it that exists; and when `path` is a link to nothing (yet), also the
 * nearest existing part of where it points, followed up to MAX_LINKS links: a write through it lands there. Each has
 * its links resolved. The CLI's gate asks it too, for the real data a command touches (src/cli/gate.ts).
 */
export function startsOf(path: string): string[] {
	const starts = [nearestExisting(path)];
	let link = resolve(path);
	for (let hop = 0; hop < MAX_LINKS; hop++) {
		try {
			if (!lstatSync(link).isSymbolicLink() || realOrNone(link) !== undefined) break;
			link = resolve(dirname(link), readlinkSync(link));
		} catch {
			break;
		}
		starts.push(nearestExisting(link));
	}
	return starts;
}

/**
 * The folders judged for `dataDirs`: each as given, and every folder from (the nearest existing part of) it up to the root
 * that holds session records. Records live in the data folder of the memory they open, and one data folder may sit
 * inside another (a config whose data_dir is inside the real one): a record in any of them judges. Links are followed,
 * a dangling one to where it points (startsOf). In order, without repeats: each folder given, then those above it that
 * hold records, nearest first.
 * A folder holds records when its session-hosts is a real folder (no link) of this user's (`uid`, default this
 * process's), as each record must be: another user's, or a link to this user's records from a shared folder such as
 * /tmp, judges nothing. Each folder is looked at once, however many of the paths it is above.
 */
export function judgedFolders(dataDirs: readonly string[], uid: number | undefined = process.getuid?.()): string[] {
	const folders: string[] = [];
	const seen = new Set<string>();
	const add = (dir: string) => {
		const key = realOrNone(dir) ?? resolve(dir);
		if (seen.has(key)) return;
		seen.add(key);
		folders.push(dir);
	};
	/** Each folder walked so far, and whether it holds records; a folder walked holds its parents walked too. */
	const walked = new Map<string, boolean>();
	const holdsRecords = (dir: string): boolean => {
		try {
			const stats = lstatSync(folderOf(dir));
			return stats.isDirectory() && (uid === undefined || stats.uid === uid);
		} catch {
			return false;
		}
	};
	for (const dataDir of dataDirs) {
		add(dataDir);
		for (const start of startsOf(dataDir)) {
			for (let dir = start; !walked.has(dir); dir = dirname(dir)) {
				const holds = holdsRecords(dir);
				walked.set(dir, holds);
				if (holds) add(dir);
				if (dirname(dir) === dir) break;
			}
		}
	}
	return folders;
}

/**
 * The session this process (or deps.from, or deps.self) runs in: the nearest ancestor recorded, live, in any of
 * `dataDirs` or any folder above one that holds records (judgedFolders), else what the markers in `env` say for
 * `config`'s data folder; with no config, any marker is a session of unknown identity, except to a tool asking with
 * `self` (module doc). Undefined: no session.
 */
export function insideSession(dataDirs: readonly string[], env: NodeJS.ProcessEnv, config: HarnessConfig | undefined, deps: SessionDeps = {}): Inside | undefined {
	const recorded: { readonly dataDir: string; readonly pids: ReadonlySet<number> }[] = [];
	for (const dataDir of judgedFolders(dataDirs)) {
		const pids = recordedPids(dataDir);
		if (pids.size > 0) recorded.push({ dataDir, pids });
	}
	// No records anywhere: no walk (and on macOS no ps).
	if (recorded.length > 0) {
		for (const pid of ancestors(deps.from ?? deps.self ?? process.pid, deps)) {
			// A tool's own record, above a process it started (`from`), is no outer session.
			if (pid === deps.self) continue;
			for (const { dataDir, pids } of recorded) {
				const record = pids.has(pid) ? liveSession(dataDir, pid, deps) : undefined;
				if (record !== undefined) return { agent: record.agent, tool: record.tool, via: "ancestry", dataDir, ...configOf(record) };
			}
		}
	}
	if (config !== undefined) return byMarkers(config, env, deps);
	// A tool's markers with nothing to check them against are its own launch's, as far as anyone can tell.
	if (deps.self !== undefined) return undefined;
	// Nothing to check markers against: any of them is a session, whose agent nobody can say.
	const marked = MARKERS.some((key) => (env[key]?.trim() ?? "") !== "") || orreryPluginOptions(env.OPENCODE_CONFIG_CONTENT).length > 0;
	return marked ? { agent: undefined, tool: undefined, via: "marker", dataDir: dataDirs[0] ?? "" } : undefined;
}

/**
 * What one marker says: the agent a secret proves (`proves`), or the agent a record names unproven (`names`), and the
 * tool, when known. Neither: a session of unknown identity.
 */
interface Mark {
	readonly proves?: string;
	readonly names?: string;
	readonly tool: SessionTool | undefined;
	/** The config file the record behind the mark names, if any, and its real path then. */
	readonly config?: string;
	readonly configReal?: string;
}

/** The session the markers in `env` name for `config`'s data folder (module doc), or undefined when none does. */
function byMarkers(config: HarnessConfig, env: NodeJS.ProcessEnv, deps: SessionDeps): Inside | undefined {
	const dataDir = config.dataDir;
	const alive = deps.alive ?? processAlive;
	const self = deps.self;
	const here = onLinux(deps) ? namespaceOf(deps, "self") : undefined;
	const marks: Mark[] = [];
	// Records: a session, and an agent that stands only when a token proves it too (CLAUDE_PID, ORRERY_HOST and Codex ids
	// are public). A tool's own record is no outer session; one that can't be judged from here is a session of unknown
	// identity.
	// Each record is judged first; only a record known to be numbered here whose pid is `self` is the tool's own. One made
	// in another namespace under the same number is another process's.
	const own = (pid: number, found: Standing): boolean => pid === self && (found.kind === "live" || (found.kind === "unsure" && !found.foreign));
	const claudePid = Number(env.CLAUDE_PID);
	const claude = judged(dataDir, claudePid, deps);
	if (!own(claudePid, claude)) {
		if (claude.kind === "live" && claude.record.tool === "claude-code") marks.push({ names: claude.record.agent, tool: "claude-code", ...configOf(claude.record) });
		else if (claude.kind === "unsure" && (claude.record === undefined || claude.record.tool === "claude-code")) marks.push({ tool: "claude-code" });
	}
	const hostPid = Number(env[HOST_ENV]);
	const host = judged(dataDir, hostPid, deps);
	if (!own(hostPid, host)) {
		if (host.kind === "live") marks.push({ names: host.record.agent, tool: host.record.tool, ...configOf(host.record) });
		else if (host.kind === "unsure") marks.push({ tool: host.record?.tool });
	}
	const codexIds = [env.CODEX_THREAD_ID, env.CODEX_SESSION_ID].filter((id) => id !== undefined && id !== "");
	if (codexIds.length > 0) {
		for (const pid of recordedPids(dataDir)) {
			const found = judged(dataDir, pid, deps);
			const record = found.kind === "live" || found.kind === "unsure" ? found.record : undefined;
			if (record?.codexSession === undefined || !codexIds.includes(record.codexSession) || own(pid, found)) continue;
			marks.push(found.kind === "live" ? { names: record.agent, tool: record.tool, ...configOf(record) } : { tool: record.tool });
		}
	}
	/**
	 * Marks for a launch's `token`, from every configured agent's claims: a live claim by another process than `self`
	 * proves that agent; one numbered in another pid namespace (or read where this one's can't be), or something other
	 * than a regular file in a claim's place (claimHeld), says only "a session".
	 */
	const claimMarks = (token: string | undefined, tool: SessionTool | undefined): Mark[] => {
		if (token === undefined || token === "") return [];
		const found: Mark[] = [];
		for (const agent of config.agents.values()) {
			const claim = claimHeld(agent.dir, token);
			if (claim === undefined) continue;
			if (claim === "unreadable" || (claim.ns !== undefined && (here === undefined || claim.ns !== here))) found.push({ tool });
			// A live claimant, and the process that claimed: a pid reused since (its start now not the claim's, read as the
			// claim was written: pick.ts reused) is a dead claim.
			else if (claim.pid !== self && alive(claim.pid) && !reused(claim)) {
				// The claimant's own record, when it hosts the session: its tool, and the config it loaded.
				const record = liveSession(dataDir, claim.pid, deps);
				found.push({ proves: agent.name, tool: tool ?? record?.tool, ...(record?.agent === agent.name ? configOf(record) : {}) });
			}
		}
		return found;
	};
	// A name its token proves nothing for still says there is a session, but to a tool asking about itself it is its own
	// launch's: unclaimed, or claimed by itself, or by a process now gone.
	const unproven = (agent: AgentConfig | undefined, tool: SessionTool | undefined): Mark[] => (agent !== undefined && self === undefined ? [{ tool }] : []);
	const name = env[AGENT_ENV]?.trim();
	const tokenMarks = claimMarks(env[TOKEN_ENV]?.trim(), undefined);
	marks.push(...(tokenMarks.length > 0 ? tokenMarks : unproven(name ? agentNamed(config, name) : undefined, undefined)));
	for (const given of orreryPluginOptions(env.OPENCODE_CONFIG_CONTENT)) {
		const options = readPluginOptions(given);
		if ("problem" in options) continue;
		const found = claimMarks(launchToken(options.tokenFile, env), "opencode");
		marks.push(...(found.length > 0 ? found : unproven(agentNamed(config, options.agent), "opencode")));
	}
	if (marks.length === 0) return undefined;
	// One agent proven, and no record naming another.
	const proven = new Set(marks.flatMap((mark) => (mark.proves === undefined ? [] : [mark.proves])));
	const one = proven.size === 1 ? [...proven][0] : undefined;
	const agent = one !== undefined && marks.every((mark) => mark.names === undefined || mark.names === one) ? one : undefined;
	const tool = marks.find((mark) => (agent === undefined || mark.proves === agent || mark.names === agent) && mark.tool !== undefined)?.tool;
	// The config a record of that agent's names; none for a session whose agent is unknown.
	const recorded = agent === undefined ? undefined : marks.find((mark) => (mark.proves === agent || mark.names === agent) && mark.config !== undefined && mark.configReal !== undefined);
	return { agent, tool, via: "marker", dataDir, ...(recorded === undefined ? {} : { config: recorded.config, configReal: recorded.configReal }) };
}

/** A record's config, as an Inside or a Mark carries it. */
const configOf = (record: SessionRecord): { config?: string; configReal?: string } =>
	record.config === undefined || record.configReal === undefined ? {} : { config: record.config, configReal: record.configReal };

/**
 * The options given to each of Orrery's plugin entries in an OPENCODE_CONFIG_CONTENT, as a launch writes them
 * (configContent, src/opencode/options.ts): entries whose package is an Orrery plugin folder (namesOrreryPlugin), one
 * item each, as given (undefined for none). JSON only, as Orrery writes it: JSONC is the person's own.
 */
function orreryPluginOptions(content: string | undefined): unknown[] {
	if (content === undefined || content === "") return [];
	let plugins: unknown;
	try {
		plugins = (JSON.parse(content) as { plugins?: unknown } | null)?.plugins;
	} catch {
		return [];
	}
	if (!Array.isArray(plugins)) return [];
	const found: unknown[] = [];
	for (const entry of plugins as ({ package?: unknown; options?: unknown } | null)[]) {
		if (typeof entry?.package === "string" && namesOrreryPlugin(entry.package)) found.push(entry.options);
	}
	return found;
}

/**
 * What a tool session started inside an agent's session says: it opens no memory and records nothing. One started inside
 * a coding tool's session that is no agent's (`plain`) names that tool, and, found by a variable, the variable and where
 * the README tells what to do about one left over (a tmux server first started from a tool's shell keeps it).
 */
export function nestedNotice(inside: Inside): string {
	if (inside.plain !== undefined) {
		const found = inside.variable === undefined ? "" : ` (found ${safeText(inside.variable)}; see "Leftover markers" in the README)`;
		return `Orrery: started inside ${toolSessionName(inside.plain)} session that is no agent's${found}, so this one opens no memory and records nothing.`;
	}
	const outer = inside.agent === undefined ? "an agent" : safeText(inside.agent);
	const tool = inside.tool === undefined ? "" : ` (${TOOL_NAMES[inside.tool]})`;
	return `Orrery: started inside ${outer}'s session${tool}, so this one opens no memory and records nothing.`;
}

/** The token in a launch's token file, or undefined when the file is no launch's (src/opencode/token-file.ts) or can't be read. */
function launchToken(file: string, env: NodeJS.ProcessEnv): string | undefined {
	if (!launchTokenFile(file, env)) return undefined;
	try {
		return readTokenFile(file);
	} catch {
		return undefined;
	}
}

/** The coding tools, by the exact names of their programs (module doc, Tool sessions). */
export const CODING_TOOLS: ReadonlySet<string> = new Set(["claude", "codex", "opencode", "pi", "omp", "gemini", "qwen", "cursor-agent", "aider", "goose", "amp", "crush", "droid", "copilot"]);

/**
 * Each tool id (a CODING_TOOLS name, or a TOOL_MARKERS tool) as a refusal names it: "this is a Claude Code session …".
 * Undefined for an id it doesn't know.
 */
export const TOOL_SESSION_NAMES: Readonly<Partial<Record<string, string>>> = {
	claude: "Claude Code",
	codex: "Codex",
	opencode: "OpenCode",
	pi: "pi",
	omp: "OMP",
	gemini: "Gemini",
	qwen: "Qwen Code",
	"cursor-agent": "Cursor Agent",
	aider: "Aider",
	goose: "Goose",
	amp: "Amp",
	crush: "Crush",
	droid: "Droid",
	copilot: "Copilot",
};

/** A tool id as a sentence names its session: "a Claude Code", "an OpenCode" (an id it doesn't know, safely as it is). */
export function toolSessionName(tool: string): string {
	const name = TOOL_SESSION_NAMES[tool] ?? safeText(tool);
	return `${/^[aeiou]/i.test(name) ? "an" : "a"} ${name}`;
}

/**
 * The variables a tool gives its shell, in the order they are looked at: any one set (non-empty) says that tool. OMP sets
 * none of its own. Never AGENT, AI_AGENT or CI: several tools set them, and anyone may.
 */
export const TOOL_MARKERS: readonly { readonly variable: string; readonly tool: string }[] = [
	{ variable: "CLAUDECODE", tool: "claude" },
	{ variable: "CLAUDE_CODE_ENTRYPOINT", tool: "claude" },
	{ variable: "CODEX_THREAD_ID", tool: "codex" },
	{ variable: "CODEX_SESSION_ID", tool: "codex" },
	{ variable: "CODEX_SANDBOX", tool: "codex" },
	{ variable: "OPENCODE", tool: "opencode" },
	{ variable: "OPENCODE_SESSION_ID", tool: "opencode" },
	{ variable: "PI_CODING_AGENT", tool: "pi" },
];

/** The markers that hold a Codex session's id: no marker when a record names it (recordedCodexIds). */
const CODEX_IDS: ReadonlySet<string> = new Set(["CODEX_THREAD_ID", "CODEX_SESSION_ID"]);

/**
 * The markers a tool gives what it starts, and never itself: a host started with one was started inside that tool's
 * session, wherever its walk leads (toolSession). Not CLAUDE_CODE_ENTRYPOINT: the VS Code extension and SDK launches
 * set it on a `claude` of the user's own. Nor OpenCode's, nor Codex's others.
 */
const START_MARKERS: ReadonlySet<string> = new Set(["CLAUDECODE", "PI_CODING_AGENT", "CODEX_THREAD_ID"]);

/** What a nested session carries of a coding tool's session that is no agent's (Inside `plain`, `variable`). */
export interface PlainFound {
	readonly plain?: string;
	readonly variable?: string;
}

/** `found`'s `plain` and `variable`, each only when set: for a decision record, a pick, or a notice. */
export const plainFields = (found: PlainFound): PlainFound => ({
	...(found.plain === undefined ? {} : { plain: found.plain }),
	...(found.variable === undefined ? {} : { variable: found.variable }),
});

/**
 * `plain` and `variable` as a decision record holds them (Claude Code's, Codex's), or "unreadable": `plain` a coding tool
 * (CODING_TOOLS), `variable` one of TOOL_MARKERS', and only with `plain`.
 */
export function recordedPlain(value: Readonly<Record<string, unknown>>): PlainFound | "unreadable" {
	const { plain, variable } = value;
	if (plain !== undefined && (typeof plain !== "string" || !CODING_TOOLS.has(plain))) return "unreadable";
	if (variable !== undefined && (plain === undefined || typeof variable !== "string" || !TOOL_MARKERS.some((marker) => marker.variable === variable))) return "unreadable";
	return plainFields({ ...(plain === undefined ? {} : { plain }), ...(variable === undefined ? {} : { variable: variable as string }) });
}

/**
 * How an interpreter's arguments (argv after argv[0]) name the script it runs: its own options come first, some taking
 * the next argument as their value (unless given with `=`, or in a cluster); then the script, unless an option gave the
 * code inline or from stdin; `--` ends the options. Only the common value-taking options are known: an unknown one
 * written with a space makes its value the script, compared exactly like any other.
 */
interface Interpreter {
	/**
	 * getopt's short options, as python's and the shells' are: `-uc` is `-u -c`, and one taking a value takes the
	 * cluster's rest, else the next argument.
	 */
	readonly clusters?: boolean;
	/** The shells': `+o name` is an option too. */
	readonly plus?: boolean;
	/** Options taking a value. */
	readonly valued: ReadonlySet<string>;
	/** Options after which no script comes: the code is inline, or read from stdin. */
	readonly inline: ReadonlySet<string>;
	/** The option whose value is the module run as the program (python's `-m aider`). */
	readonly module?: string;
	/** A subcommand that may come before the script (`bun run`, `deno run`). */
	readonly run?: string;
}

const SHELL: Interpreter = { clusters: true, plus: true, valued: new Set(["-o", "+o", "-O", "+O", "--init-file", "--rcfile"]), inline: new Set(["-c", "-s", "-"]) };

/** The programs that run a script, by their file names; python's by its prefix (python3, python3.12). */
const INTERPRETERS: ReadonlyMap<string, Interpreter> = new Map([
	[
		"node",
		{
			valued: new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "-C", "--conditions", "--env-file", "--env-file-if-exists", "--title", "--disable-warning", "--input-type", "--inspect-port", "--watch-path", "--redirect-warnings", "--diagnostic-dir", "--report-dir", "--icu-data-dir", "--openssl-config"]),
			inline: new Set(["-e", "--eval", "-p", "--print", "-pe", "-i", "--interactive", "--run", "-"]),
		},
	],
	[
		"bun",
		{
			valued: new Set(["-r", "--preload", "--require", "--import", "--cwd", "-c", "--config", "--env-file", "--tsconfig-override", "-d", "--define", "-l", "--loader", "--main-fields", "--conditions", "--port", "-F", "--filter", "--elide-lines", "--console-depth"]),
			inline: new Set(["-e", "--eval", "-p", "--print", "-"]),
			run: "run",
		},
	],
	["deno", { valued: new Set(["-c", "--config", "--import-map", "--location", "--cert", "-L", "--log-level", "--seed", "--ext"]), inline: new Set(["-"]), run: "run" }],
	["bash", SHELL],
	["sh", SHELL],
]);
const PYTHON: Interpreter = { clusters: true, valued: new Set(["-W", "-X", "--check-hash-based-pycs"]), inline: new Set(["-c", "-"]), module: "-m" };

const interpreterOf = (program: string): Interpreter | undefined => INTERPRETERS.get(program) ?? (program.startsWith("python") ? PYTHON : undefined);

/**
 * Where in `args`, an interpreter's arguments, the script it runs is (Interpreter), or the module it runs; undefined when
 * it runs none.
 */
function scriptOf(kind: Interpreter, args: readonly string[]): { readonly at: number } | { readonly module: string } | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (arg === "--") return i + 1 < args.length ? { at: i + 1 } : undefined;
		if (kind.inline.has(arg)) return undefined;
		if (!arg.startsWith("-") && !(kind.plus === true && arg.startsWith("+"))) {
			if (arg === kind.run) continue;
			return { at: i };
		}
		if (arg.startsWith("--")) {
			const equals = arg.indexOf("=");
			const name = equals < 0 ? arg : arg.slice(0, equals);
			if (kind.inline.has(name)) return undefined;
			if (equals < 0 && kind.valued.has(name)) i++;
			continue;
		}
		if (kind.clusters !== true) {
			if (kind.valued.has(arg)) i++;
			continue;
		}
		for (let k = 1; k < arg.length; k++) {
			const option = `${arg.charAt(0)}${arg.charAt(k)}`;
			const rest = arg.slice(k + 1);
			if (kind.inline.has(option)) return undefined;
			if (option === kind.module) {
				const module = rest !== "" ? rest : args[i + 1];
				return module === undefined ? undefined : { module };
			}
			if (kind.valued.has(option)) {
				if (rest === "") i++;
				break;
			}
		}
	}
	return undefined;
}

/** The most words a script's path is taken to span where ps joined argv with spaces (macOS). */
const MAX_SCRIPT_WORDS = 16;

/**
 * The script at `args[at]` where ps joined argv with spaces (macOS): the longest run of words from there that is a file
 * (a path holding spaces), up to the next option; else the word itself.
 */
function spacedScript(args: readonly string[], at: number): string {
	let end = at + 1;
	while (end < args.length && end - at < MAX_SCRIPT_WORDS && !(args[end] as string).startsWith("-")) end++;
	for (; end > at + 1; end--) {
		const path = args.slice(at, end).join(" ");
		try {
			if (statSync(path).isFile()) return path;
		} catch {
			// no such file: a shorter run, or the word
		}
	}
	return args[at] as string;
}

/** What a program's name is compared by: its file name without a trailing `.exe` (OpenCode's on Linux)… */
const PROGRAM_SUFFIX = /\.exe$/;
/** …and a script's without its `.exe`, `.js`, `.mjs`, `.cjs` or `.py`. */
const SCRIPT_SUFFIX = /\.(?:exe|js|mjs|cjs|py)$/;

/** `path`'s file name without `suffix`. */
const programOf = (path: string, suffix: RegExp = PROGRAM_SUFFIX): string => basename(path).replace(suffix, "");

/** A coding tool's session that a process was started from (toolSession). */
export interface ToolSession {
	/** The tool's id: a CODING_TOOLS name, or a TOOL_MARKERS tool (TOOL_SESSION_NAMES names each). */
	readonly tool: string;
	readonly via: "ancestry" | "marker";
	/** By ancestry: the tool's process. */
	readonly pid?: number;
	/** By a marker: its variable. */
	readonly variable?: string;
}

/** A tool a process runs: `script` when it is an interpreter running the tool's script or module, not the tool itself. */
interface ToolProcess {
	readonly tool: string;
	readonly script: boolean;
}

/**
 * The tool `argv` runs: argv[0]'s program, or an interpreter's script (scriptOf) or module; undefined for none. `spaced`:
 * argv was split at every space (macOS's ps), so a script's path is found again (spacedScript). On Linux an argv[0]
 * holding whitespace is a process title (`sshd: u@pts/0 /srv/claude`), whose last word is no program of its own: it
 * names no tool by itself (macOS's argv[0], comm, is a whole path, and its app paths hold spaces).
 */
function toolOfArgv(argv: readonly string[], spaced: boolean): ToolProcess | undefined {
	const first = argv[0] ?? "";
	const program = programOf(first);
	if (CODING_TOOLS.has(program) && (spaced || !/\s/.test(first))) return { tool: program, script: false };
	const kind = interpreterOf(program);
	const args = argv.slice(1);
	const found = kind === undefined ? undefined : scriptOf(kind, args);
	if (found === undefined) return undefined;
	const name = "module" in found ? found.module : programOf(spaced ? spacedScript(args, found.at) : (args[found.at] as string), SCRIPT_SUFFIX);
	return CODING_TOOLS.has(name) ? { tool: name, script: true } : undefined;
}

/**
 * The tool process `pid` is. A name that is a tool's decides. Else on Linux argv decides: comm is only the kernel's name
 * for the process (a thread may rename it: Node 26 shows `node-MainThread`). On macOS comm is the whole argv[0], so only
 * an interpreter's args (or a process whose name is unknown) are asked for.
 */
function toolOf(pid: number, seen: Processes, cmdline: (pid: number) => readonly string[] | undefined, linux: boolean): ToolProcess | undefined {
	const name = seen.nameOf(pid);
	if (name !== undefined) {
		const program = programOf(name);
		if (CODING_TOOLS.has(program)) return { tool: program, script: false };
		if (!linux && interpreterOf(program) === undefined) return undefined;
	}
	const argv = cmdline(pid);
	return argv === undefined ? undefined : toolOfArgv(argv, !linux);
}

/** This system's way to read a process's argv (SessionDeps.cmdline); macOS's takes argv[0] from `seen`'s snapshot. */
function argvReader(deps: SessionDeps, seen: Processes): (pid: number) => readonly string[] | undefined {
	if (onLinux(deps)) {
		return (pid) => {
			try {
				const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
				if (argv.at(-1) === "") argv.pop();
				return argv.length > 0 ? argv : undefined;
			} catch {
				return undefined;
			}
		};
	}
	if (onMac(deps)) {
		return (pid) => {
			const args = (deps.ps ?? psOutput)(["-ww", "-o", "args=", "-p", String(pid)])?.trim();
			if (args === undefined || args === "") return undefined;
			// ps joins argv with spaces; argv[0], comm, may hold some itself.
			const first = seen.nameOf(pid);
			if (first !== undefined && args.startsWith(first) && (args.length === first.length || /\s/.test(args.charAt(first.length)))) {
				return [first, ...args.slice(first.length).split(/\s+/).filter((arg) => arg !== "")];
			}
			// Args that don't start with comm (comm the program's short name, say): argv[0] ends at the first word with
			// comm's file name, else at the first space.
			const words = args.split(/\s+/);
			const end = first === undefined ? -1 : words.findIndex((word) => basename(word) === basename(first));
			return end > 0 ? [words.slice(0, end + 1).join(" "), ...words.slice(end + 1)] : words;
		};
	}
	return () => undefined;
}

/** The initial pid namespace, as /proc/<pid>/ns/pid names it: the kernel's PROC_PID_INIT_INO (0xEFFFFFFC). */
const INIT_PID_NAMESPACE = "pid:[4026531836]";

/**
 * Where npm's Codex package keeps the binary its launcher (`bin/codex.js`, read in @openai/codex 0.163.0) spawns, with
 * the launcher's own arguments: vendor/<target triple>/bin/codex (vendor/<triple>/codex/codex in older packages).
 */
const NPM_CODEX_BINARY = /[\\/]vendor[\\/][^\\/]+[\\/](?:bin|codex)[\\/]codex(?:\.exe)?$/;

/** The Claude Code desktop app's processes right above its session's `claude`: claude ← disclaimer ← claude-desktop. */
const CLAUDE_DESKTOP: ReadonlySet<string> = new Set(["disclaimer", "claude-desktop"]);

/** Whether `argv` ends with `tail`. */
const endsWith = (argv: readonly string[], tail: readonly string[]): boolean => tail.length <= argv.length && tail.every((arg, i) => argv[argv.length - tail.length + i] === arg);

/**
 * Whether `parent`, right above `host` (a process of the tool `own`), is that tool's own launcher, by the shape the tool
 * starts it in (each shape the tool's own, never its name alone), and whether it also vouches for the host's own tool's
 * variables in a walk cut short (`markers`):
 * - Codex: npm's launcher, an interpreter running Codex's script (`node …/codex.js`), above the package's binary
 *   (NPM_CODEX_BINARY), which it runs with its own arguments. No outer session; its variables vouch for nothing.
 * - OpenCode: its TUI (or `run`) with --standalone, above the private server it starts as `opencode serve --stdio`. No
 *   outer session; its variables vouch for nothing.
 * - Claude Code: the desktop app's `disclaimer` wrapper, or the app itself (CLAUDE_DESKTOP). No Claude Code, so never an
 *   outer session; a known launcher, which gives its `claude` Claude Code's variables (`markers`).
 * Undefined: no launcher of the host's.
 */
function ownLauncher(own: string, host: number, parent: number, found: ToolProcess | undefined, seen: Processes, cmdline: (pid: number) => readonly string[] | undefined): { readonly markers: boolean } | undefined {
	switch (own) {
		case "codex": {
			if (found?.tool !== "codex" || !found.script) return undefined;
			const binary = cmdline(host);
			const launcher = cmdline(parent);
			return binary !== undefined && launcher !== undefined && NPM_CODEX_BINARY.test(binary[0] ?? "") && endsWith(launcher, binary.slice(1)) ? { markers: false } : undefined;
		}
		case "opencode": {
			if (found?.tool !== "opencode" || found.script) return undefined;
			const server = cmdline(host);
			const tui = cmdline(parent);
			const shaped = server !== undefined && tui !== undefined && programOf(server[0] ?? "") === "opencode" && server[1] === "serve" && server.includes("--stdio") && tui.includes("--standalone");
			return shaped ? { markers: false } : undefined;
		}
		case "claude":
			return [seen.nameOf(parent), cmdline(parent)?.[0]].some((name) => name !== undefined && CLAUDE_DESKTOP.has(programOf(name))) ? { markers: true } : undefined;
		default:
			return undefined;
	}
}

/**
 * The coding tool's session this process (or deps.from) was started from, by ancestry, else by markers (module doc,
 * Tool sessions); undefined: none. Asked only when insideSession finds no agent's session. A Codex id in
 * `deps.recordedCodexIds` (recordedCodexIds) is an agent's Codex session, no marker. `deps.self` is not used.
 * Asked by a tool about its own host (`deps.own`, the tool it is, a CODING_TOOLS name; `from` is the host):
 * - Its own launcher right above it (ownLauncher) is passed over. Any other process of its tool above it is an outer
 *   session: right above it (a shell that exec'd it, or a script of the tool above a script of it), or further up.
 * - Its own tool's markers are no evidence under the Claude Code desktop app's wrapper right above it (ownLauncher's
 *   `markers`, a known launcher that gives its `claude` Claude Code's variables; npm's Codex launcher and OpenCode's TUI
 *   are passed over in the walk only). Else they count only when the host was started with them (its start
 *   environment, deps.startEnv): set by the host itself (pi sets PI_CODING_AGENT, Claude Code CLAUDECODE for its hooks),
 *   they say nothing of a session above.
 *   - A walk cut short (a sandbox's own pid namespace, a parent that can't be read): each one set counts unless the host
 *     was started without it. A start environment that can't be read counts it (fail closed).
 *   - A whole walk (to pid 1 with every parent read, in the first pid namespace): on Linux, a START_MARKERS one the host
 *     was started with counts, whether set now or not: the same tool started detached or in the background from its own
 *     session (`setsid claude -p …`, or `claude -p … &` from a subshell that exits) has no tool above it, and only that
 *     says where it came from. So does one left over in the user's terminal (`orrery agent` starts tools without them,
 *     src/agent/launch.ts). A start environment that can't be read counts none: the walk shows no session. On macOS the
 *     start environment is not asked where the walk is whole, and none counts (a known gap, in the README's Limits).
 */
export function toolSession(env: NodeJS.ProcessEnv, deps: SessionDeps & { readonly recordedCodexIds?: ReadonlySet<string>; readonly own?: string } = {}): ToolSession | undefined {
	const seen = processes(deps, true);
	const cmdline = deps.cmdline ?? argvReader(deps, seen);
	const linux = onLinux(deps);
	const from = deps.from ?? process.pid;
	const own = deps.own;
	const chain = walkTo(from, seen.parentOf);
	// Whether the desktop app's wrapper, right above the host, vouches for its own tool's variables.
	let vouched = false;
	for (const [i, pid] of chain.pids.entries()) {
		const found = toolOf(pid, seen, cmdline, linux);
		const launcher = i === 0 && own !== undefined ? ownLauncher(own, from, pid, found, seen, cmdline) : undefined;
		if (launcher !== undefined) {
			vouched = launcher.markers;
			continue;
		}
		if (found !== undefined) return { tool: found.tool, via: "ancestry", pid };
	}
	const whole = chain.top && (linux ? namespaceOf(deps, from) === INIT_PID_NAMESPACE : onMac(deps));
	const ownVariables = TOOL_MARKERS.filter((marker) => marker.tool === own).map((marker) => marker.variable);
	let started: { readonly env: Readonly<Record<string, string>> | undefined } | undefined;
	/** The host's own tool's variables it was started with, read once; undefined: they can't be read. */
	const startedWith = () => (started ??= { env: (deps.startEnv ?? processEnv)(from, ownVariables) }).env;
	const set = (variable: string, value: string | undefined): boolean => value !== undefined && value !== "" && !(CODEX_IDS.has(variable) && deps.recordedCodexIds?.has(value) === true);
	/** Whether the host's own tool's marker `variable` is evidence of a session above it (toolSession's doc). */
	const evidence = (variable: string): boolean => {
		if (vouched) return false;
		if (whole) return linux && START_MARKERS.has(variable) && set(variable, startedWith()?.[variable]);
		if (!set(variable, env[variable])) return false;
		const start = startedWith();
		return start === undefined || (start[variable] ?? "") !== "";
	};
	for (const { variable, tool } of TOOL_MARKERS) {
		if (tool === own ? !evidence(variable) : !set(variable, env[variable])) continue;
		return { tool, via: "marker", variable };
	}
	return undefined;
}

/**
 * The Codex sessions (SessionRecord.codexSession) of every live or unsure record in `dataDirs` and the folders above them
 * that hold records (judgedFolders), as insideSession reads them; a stale record found is taken down.
 */
export function recordedCodexIds(dataDirs: readonly string[], deps: SessionDeps = {}): ReadonlySet<string> {
	const ids = new Set<string>();
	for (const dataDir of judgedFolders(dataDirs)) {
		for (const pid of recordedPids(dataDir)) {
			const found = judged(dataDir, pid, deps);
			const id = found.kind === "live" || found.kind === "unsure" ? found.record?.codexSession : undefined;
			if (id !== undefined) ids.add(id);
		}
	}
	return ids;
}
