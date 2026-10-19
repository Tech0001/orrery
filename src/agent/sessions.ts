/**
 * Which agent's session a process runs in (spec 2026-10-18-agent-permissions-design §2): the CLI asks before it runs a
 * command, and each tool's integration before it opens memory, so that a command or a tool started from an agent's
 * shell is known as that agent's, whatever folder, config or environment it was given.
 *
 * Session records. A tool session that opens an agent's memory records its host process in the data folder that holds
 * that memory, and forgets it when the session closes: <data>/session-hosts/<pid>.json, holding
 * {"agent","tool","pid","start"}, for Codex "codexSession", and on Linux "ns" and "boot"; 0600 in a 0700 folder, written
 * whole (src/agent/private-file.ts), and read only as a small regular file of this user's, never through a link.
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
 * Ancestry. A process is inside a session when one of its ancestors is recorded, live, in a data folder it asks about;
 * the nearest one wins, and its record is the identity. Linux walks /proc one parent at a time; macOS takes one
 * `ps -A -o pid=,ppid=` snapshot. The walk stops at pid 1, at the top of a pid namespace, or after MAX_DEPTH steps. It is
 * skipped when no data folder asked about holds a record, so a hook or a command outside every session costs a readdir.
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
 * - CLAUDE_PID naming a live Claude Code record, or CODEX_THREAD_ID / CODEX_SESSION_ID equal to a live record's Codex
 *   session: never an identity by itself. Pids and Codex ids are anyone's to read, so a detached process could copy
 *   another agent's; the record's agent stands only when a token proves the same agent.
 * - A claim numbered in another pid namespace than this process's can't be judged here: a session of unknown identity.
 *   So can a record a CLAUDE_PID or a Codex id points at from there: Codex's sandboxed shell, in a pid namespace of its
 *   own, is inside a session whose agent it can't name, and only `help` runs there.
 * Tokens proving different agents, or a record naming another agent than the token, leave the identity unknown. Without
 * a config nothing can be checked, so any marker (ORRERY_AGENT, ORRERY_AGENT_TOKEN, CLAUDE_PID, a Codex id, or an
 * OPENCODE_CONFIG_CONTENT naming Orrery's plugin) is a session of unknown identity.
 *
 * A tool asking whether it was itself started inside a session (`self`, its host process) carries its own launch's
 * markers: the ORRERY_AGENT and token its launcher gave it, OpenCode's config, its own CLAUDE_PID or Codex thread id.
 * For it a marker counts only when it points at another process: a token claimed by a live process other than `self`,
 * or by one in another namespace (an unclaimed token, one whose claimant is dead, or its own claim is its own launch's,
 * so asking before or after claiming gives one answer), a record whose pid isn't `self`. The walk starts above `self`,
 * and passes it over, so its own record never matches. Without a config its markers are taken as its own: such a tool
 * opens no memory anyway.
 *
 * Nothing here throws: a record that can't be written makes recordSession false, for its caller to say so, and a
 * folder or file that can't be read holds no session.
 * Imports Node built-ins and relative modules only, for pi and OMP, which load this file; through pick.ts that is also
 * config.ts, and with it smol-toml and the memory module, which pi and OMP load already.
 */

import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { namesOrreryPlugin } from "../install/layout.ts";
import { readPluginOptions } from "../opencode/options.ts";
import { launchTokenFile, readTokenFile } from "../opencode/token-file.ts";
import type { AgentConfig, HarnessConfig } from "./config.ts";
import { removeStale, stray } from "./exclusive.ts";
import { AGENT_ENV, agentNamed, claimHeld, TOKEN_ENV } from "./pick.ts";
import { readPrivate, writePrivate } from "./private-file.ts";
import { bootId, pidNamespace, processAlive, procStat, psOutput } from "./process.ts";
import { safeText } from "./source-labels.ts";

export { ALLOWED_INSIDE } from "./inside-commands.ts";

/** The tool a session runs in: `run` is `orrery run`. */
export type SessionTool = "pi" | "omp" | "claude-code" | "codex" | "opencode" | "run";

/** Each tool as a notice names it. */
const TOOL_NAMES: Readonly<Record<SessionTool, string>> = { pi: "pi", omp: "OMP", "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode", run: "orrery run" };
const TOOLS: ReadonlySet<string> = new Set(Object.keys(TOOL_NAMES));

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
}

/** The session a process runs in. */
export interface Inside {
	/** The session's agent; undefined when only a marker says there is a session, and nothing proves whose. */
	readonly agent: string | undefined;
	readonly tool: SessionTool | undefined;
	readonly via: "ancestry" | "marker";
	/** The data folder whose record or config found it; with no config, the first data folder asked about ("" for none). */
	readonly dataDir: string;
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
	/** insideSession: the process whose ancestors are walked (default `self`, else this one). */
	readonly from?: number;
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
/** /proc/<pid>/stat's start time field (proc(5)). */
const START_FIELD = 22;
/** The most ancestors walked: no session nests that deep, and a loop ends here at worst. */
const MAX_DEPTH = 64;

const folderOf = (dataDir: string): string => join(dataDir, FOLDER);
const fileOf = (dataDir: string, pid: number): string => join(folderOf(dataDir), `${pid}.json`);
const positive = (pid: number): boolean => Number.isInteger(pid) && pid > 0;
const onLinux = (deps: SessionDeps): boolean => (deps.platform ?? process.platform) === "linux";
const namespaceOf = (deps: SessionDeps, pid: number | "self"): string | undefined => (deps.ns ?? pidNamespace)(pid);

function pidNamed(name: string): number | undefined {
	const match = RECORD_NAME.exec(name);
	return match === null ? undefined : Number(match[1]);
}

/** /proc/<pid>/stat, or undefined when it can't be read. */
function readProc(pid: number): string | undefined {
	try {
		return readFileSync(`/proc/${pid}/stat`, "utf8");
	} catch {
		return undefined;
	}
}

/** When process `pid` started, or undefined when that can't be read (gone, or no way to ask on this system). */
export function processStart(pid: number, deps: SessionDeps = {}): string | undefined {
	if (!positive(pid)) return undefined;
	const platform = deps.platform ?? process.platform;
	if (platform === "linux") {
		const stat = (deps.proc ?? readProc)(pid);
		const start = stat === undefined ? undefined : procStat(stat)?.fields[START_FIELD - 3];
		return start !== undefined && /^\d+$/.test(start) ? start : undefined;
	}
	if (platform === "darwin") {
		const start = (deps.ps ?? psOutput)(["-o", "lstart=", "-p", String(pid)])?.trim();
		return start === undefined || start === "" ? undefined : start;
	}
	return undefined;
}

/** Each process's parent, as this system tells it: Linux reads /proc at each step; macOS reads one snapshot of all. */
function parents(deps: SessionDeps): (pid: number) => number | undefined {
	const platform = deps.platform ?? process.platform;
	if (platform === "linux") {
		const proc = deps.proc ?? readProc;
		return (pid) => {
			const stat = proc(pid);
			const ppid = Number(stat === undefined ? undefined : procStat(stat)?.fields[1]);
			return Number.isInteger(ppid) ? ppid : undefined;
		};
	}
	if (platform === "darwin") {
		const table = new Map<number, number>();
		for (const line of ((deps.ps ?? psOutput)(["-A", "-o", "pid=,ppid="]) ?? "").split("\n")) {
			const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
			if (match !== null) table.set(Number(match[1]), Number(match[2]));
		}
		return (pid) => table.get(pid);
	}
	return () => undefined;
}

/** The ancestors of `from` (default this process), nearest first, without `from` itself or pid 1. */
export function ancestors(from: number = process.pid, deps: SessionDeps = {}): number[] {
	const parentOf = parents(deps);
	const found: number[] = [];
	let pid = from;
	while (found.length < MAX_DEPTH) {
		const parent = parentOf(pid);
		// pid 1, or 0 above the top of a pid namespace, ends the walk; so does a loop (a pid reused during the walk).
		if (parent === undefined || parent <= 1 || parent === from || found.includes(parent)) break;
		found.push(parent);
		pid = parent;
	}
	return found;
}

/** `value` as the record of `pid`, or undefined when it is none. */
function recordOf(value: unknown, pid: number): SessionRecord | undefined {
	const { agent, tool, pid: own, start, codexSession, ns, boot } = (value ?? {}) as Record<string, unknown>;
	if (typeof agent !== "string" || agent === "" || typeof tool !== "string" || !TOOLS.has(tool) || own !== pid || typeof start !== "string" || start === "") return undefined;
	// Each optional field is absent, or a non-empty string.
	const text = (field: unknown): field is string | undefined => field === undefined || (typeof field === "string" && field !== "");
	if (!text(codexSession) || !text(ns) || !text(boot)) return undefined;
	return {
		agent,
		tool: tool as SessionTool,
		pid,
		start,
		...(codexSession === undefined ? {} : { codexSession }),
		...(ns === undefined ? {} : { ns }),
		...(boot === undefined ? {} : { boot }),
	};
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
	let record: SessionRecord | undefined;
	try {
		record = recordOf(JSON.parse(text), pid);
	} catch {
		// no JSON: no record this version reads
	}
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
 * nothing can be written there.
 */
export function recordSession(dataDir: string, record: Omit<SessionRecord, "start" | "ns" | "boot">, deps: SessionDeps = {}): boolean {
	const start = processStart(record.pid, deps);
	if (start === undefined) return false;
	let place = {};
	if (onLinux(deps)) {
		const ns = namespaceOf(deps, record.pid);
		const boot = (deps.boot ?? bootId)();
		if (ns === undefined || ns !== namespaceOf(deps, "self") || boot === undefined) return false;
		place = { ns, boot };
	}
	const full = recordOf({ ...record, start, ...place }, record.pid);
	if (full === undefined) return false;
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
const MARKERS = [AGENT_ENV, TOKEN_ENV, "CLAUDE_PID", "CODEX_THREAD_ID", "CODEX_SESSION_ID"] as const;

/**
 * The session this process (or deps.from, or deps.self) runs in: the nearest ancestor recorded, live, in any of
 * `dataDirs`, else what the markers in `env` say for `config`'s data folder; with no config, any marker is a session of
 * unknown identity, except to a tool asking with `self` (module doc). Undefined: no session.
 */
export function insideSession(dataDirs: readonly string[], env: NodeJS.ProcessEnv, config: HarnessConfig | undefined, deps: SessionDeps = {}): Inside | undefined {
	const seen = new Set<string>();
	const recorded: { readonly dataDir: string; readonly pids: ReadonlySet<number> }[] = [];
	for (const dataDir of dataDirs) {
		if (seen.has(resolve(dataDir))) continue;
		seen.add(resolve(dataDir));
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
				if (record !== undefined) return { agent: record.agent, tool: record.tool, via: "ancestry", dataDir };
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
}

/** The session the markers in `env` name for `config`'s data folder (module doc), or undefined when none does. */
function byMarkers(config: HarnessConfig, env: NodeJS.ProcessEnv, deps: SessionDeps): Inside | undefined {
	const dataDir = config.dataDir;
	const alive = deps.alive ?? processAlive;
	const self = deps.self;
	const here = onLinux(deps) ? namespaceOf(deps, "self") : undefined;
	const marks: Mark[] = [];
	// Records: a session, and an agent that stands only when a token proves it too (CLAUDE_PID and Codex ids are public).
	// A tool's own record is no outer session; one that can't be judged from here is a session of unknown identity.
	const claudePid = Number(env.CLAUDE_PID);
	if (claudePid !== self) {
		const found = judged(dataDir, claudePid, deps);
		if (found.kind === "live" && found.record.tool === "claude-code") marks.push({ names: found.record.agent, tool: "claude-code" });
		else if (found.kind === "unsure" && (found.record === undefined || found.record.tool === "claude-code")) marks.push({ tool: "claude-code" });
	}
	const codexIds = [env.CODEX_THREAD_ID, env.CODEX_SESSION_ID].filter((id) => id !== undefined && id !== "");
	if (codexIds.length > 0) {
		for (const pid of recordedPids(dataDir)) {
			const found = judged(dataDir, pid, deps);
			const record = found.kind === "live" || found.kind === "unsure" ? found.record : undefined;
			if (record?.codexSession === undefined || !codexIds.includes(record.codexSession)) continue;
			if (found.kind === "live") {
				if (pid !== self) marks.push({ names: record.agent, tool: record.tool });
			} else if (found.kind === "unsure" && (found.foreign || pid !== self)) marks.push({ tool: record.tool });
		}
	}
	/**
	 * Marks for a launch's `token`, from every configured agent's claims: a live claim by another process than `self`
	 * proves that agent; one numbered in another pid namespace (or read where this one's can't be) says only "a session".
	 */
	const claimMarks = (token: string | undefined, tool: SessionTool | undefined): Mark[] => {
		if (token === undefined || token === "") return [];
		const found: Mark[] = [];
		for (const agent of config.agents.values()) {
			const claim = claimHeld(agent.dir, token);
			if (claim === undefined) continue;
			if (claim.ns !== undefined && (here === undefined || claim.ns !== here)) found.push({ tool });
			else if (claim.pid !== self && alive(claim.pid)) found.push({ proves: agent.name, tool: tool ?? liveSession(dataDir, claim.pid, deps)?.tool });
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
	return { agent, tool, via: "marker", dataDir };
}

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

/** What a tool session started inside an agent's session says: it opens no memory and records nothing. */
export function nestedNotice(inside: Inside): string {
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
