/**
 * Which agent's session a process runs in (spec 2026-10-18-agent-permissions-design §2): the CLI asks before it runs a
 * command, and each tool's integration before it opens memory, so that a command or a tool started from an agent's
 * shell is known as that agent's, whatever folder, config or environment it was given.
 *
 * Session records. A tool session that opens an agent's memory records its host process in the data folder that holds
 * that memory, and forgets it when the session closes: <data>/session-hosts/<pid>.json, holding
 * {"agent","tool","pid","start"} and, for Codex, "codexSession"; 0600 in a 0700 folder, written whole
 * (src/agent/private-file.ts). `start` is when the process started, so a reused pid is no session: Linux's
 * /proc/<pid>/stat field 22 (clock ticks since boot), macOS's `ps -o lstart=` (to the second, asked in UTC and the C
 * locale so every process spells it alike). A record whose process is gone, or started at another time, is stale: the
 * look that finds it takes it down exclusively (removeStale, src/agent/exclusive.ts), so a fresh record that took the
 * name meanwhile stays, and each new record takes out the dead ones beside it. A record of a live process that can't
 * be judged now (its start can't be read, or the file is no record this version reads) is kept, since it may be a real
 * session's, and counts for nothing: its pid may be reused by now, by the user's own terminal among others, and that is
 * never refused.
 *
 * Ancestry. A process is inside a session when one of its ancestors is recorded in a data folder it asks about; the
 * nearest one wins, and its record is the identity. Linux walks /proc one parent at a time; macOS takes one
 * `ps -A -o pid=,ppid=` snapshot. The walk stops at pid 1, at the top of a pid namespace, or after MAX_DEPTH steps. It is
 * skipped when no data folder asked about holds a record, so a hook or a command outside every session costs a readdir.
 *
 * Markers, the backup when the ancestry is cut (a detached process; Codex's sandboxed shell, in its own pid namespace).
 * With a config they count only for its data folder, and one naming an agent the config doesn't have is ignored (a
 * scratch home's config, a developer's). Each says there is a session; only a secret says whose:
 * - ORRERY_AGENT naming a configured agent: that agent when ORRERY_AGENT_TOKEN, the launch's secret, is claimed by a
 *   live process in the agent's claims (src/agent/pick.ts).
 * - OPENCODE_CONFIG_CONTENT carrying Orrery's plugin for a configured agent (src/opencode/options.ts): that agent when the
 *   token in the launch's token file (src/opencode/token-file.ts) is claimed so.
 * - CLAUDE_PID naming a live Claude Code record, or CODEX_THREAD_ID / CODEX_SESSION_ID equal to a live record's Codex
 *   session: never an identity by itself. Pids and Codex ids are anyone's to read, so a detached process could copy
 *   another agent's; the record's agent stands only when a token proves the same agent.
 * Tokens proving different agents, or a record naming another agent than the token, leave the identity unknown. Without
 * a config nothing can be checked, so any marker (ORRERY_AGENT, ORRERY_AGENT_TOKEN, CLAUDE_PID, a Codex id, or an
 * OPENCODE_CONFIG_CONTENT naming Orrery's plugin) is a session of unknown identity.
 *
 * Nothing here throws: a record that can't be written makes recordSession false, for its caller to say so, and a
 * folder or file that can't be read holds no session.
 * Node built-ins and relative imports only: pi and OMP load this file.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { namesOrreryPlugin } from "../install/layout.ts";
import { readPluginOptions } from "../opencode/options.ts";
import { launchTokenFile, readTokenFile } from "../opencode/token-file.ts";
import type { AgentConfig, HarnessConfig } from "./config.ts";
import { removeStale, stray } from "./exclusive.ts";
import { AGENT_ENV, agentNamed, claimedBy, TOKEN_ENV } from "./pick.ts";
import { writePrivate } from "./private-file.ts";
import { processAlive, procStat } from "./process.ts";
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
	/** Whether a pid lives (default processAlive). */
	readonly alive?: (pid: number) => boolean;
	/** Which system's way to ask: Linux's, macOS's, or none elsewhere (default this one's). */
	readonly platform?: NodeJS.Platform;
	/** insideSession: the process whose ancestors are walked (default this one). */
	readonly from?: number;
}

/** The folder in a data folder that holds session records. */
const FOLDER = "session-hosts";
/** A record's name: its process's pid. Temporary and graveyard files beside it have other names. */
const RECORD_NAME = /^([1-9]\d*)\.json$/;
/** /proc/<pid>/stat's start time field (proc(5)). */
const START_FIELD = 22;
/** The most ancestors walked: no session nests that deep, and a loop ends here at worst. */
const MAX_DEPTH = 64;

const folderOf = (dataDir: string): string => join(dataDir, FOLDER);
const fileOf = (dataDir: string, pid: number): string => join(folderOf(dataDir), `${pid}.json`);
const positive = (pid: number): boolean => Number.isInteger(pid) && pid > 0;

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

/**
 * ps's output, or undefined when it fails (a gone pid makes it exit 1). By its path, so a `ps` first on PATH isn't the
 * one asked; in UTC and the C locale, so lstart reads alike in every process whatever its TZ or LANG.
 */
function runPs(args: readonly string[]): string | undefined {
	const ps = spawnSync("/bin/ps", args, { encoding: "utf8", timeout: 2000, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
	return ps.status === 0 ? ps.stdout : undefined;
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
		const start = (deps.ps ?? runPs)(["-o", "lstart=", "-p", String(pid)])?.trim();
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
		for (const line of ((deps.ps ?? runPs)(["-A", "-o", "pid=,ppid="]) ?? "").split("\n")) {
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
	const { agent, tool, pid: own, start, codexSession } = (value ?? {}) as Record<string, unknown>;
	if (typeof agent !== "string" || agent === "" || typeof tool !== "string" || !TOOLS.has(tool) || own !== pid || typeof start !== "string" || start === "") return undefined;
	if (codexSession !== undefined && (typeof codexSession !== "string" || codexSession === "")) return undefined;
	const record: SessionRecord = { agent, tool: tool as SessionTool, pid, start };
	return codexSession === undefined ? record : { ...record, codexSession };
}

/**
 * What the file at `file`, a record of `pid`, stands for: the live record; "none" when there is no file; "stale" when
 * its process is gone or started at another time; "unsure" when that can't be told now (the file can't be read, or is
 * no record this version reads, while its process lives; or the process's start can't be read).
 */
function standing(file: string, pid: number, deps: SessionDeps): SessionRecord | "none" | "stale" | "unsure" {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "none" : "unsure";
	}
	if (!(deps.alive ?? processAlive)(pid)) return "stale";
	let record: SessionRecord | undefined;
	try {
		record = recordOf(JSON.parse(text), pid);
	} catch {
		// no JSON: no record this version reads
	}
	const start = processStart(pid, deps);
	if (record === undefined || start === undefined) return "unsure";
	return record.start === start ? record : "stale";
}

/**
 * The session process `pid` hosts for `dataDir`'s memory: only while it lives and started when its record says. A stale
 * record goes. A live process whose start can't be read now is no session, though its record stays (it may be a real
 * session's): the pid may by now be another process's, the user's own terminal among others, and that is never refused.
 */
export function liveSession(dataDir: string, pid: number, deps: SessionDeps = {}): SessionRecord | undefined {
	if (!positive(pid)) return undefined;
	const file = fileOf(dataDir, pid);
	const found = standing(file, pid, deps);
	if (found === "stale") {
		try {
			// Judged again once moved aside: a fresh record that took the name meanwhile goes back. Gone counts as stale.
			removeStale(file, (moved) => {
				const again = standing(moved, pid, deps);
				return again === "stale" || again === "none";
			});
		} catch {
			// left for the next look, or the next record's prune
		}
	}
	return typeof found === "object" ? found : undefined;
}

/** The pids `dataDir` holds records for (none when its folder can't be read). */
function recordedPids(dataDir: string): Set<number> {
	try {
		return new Set(readdirSync(folderOf(dataDir)).map(pidNamed).filter((pid) => pid !== undefined));
	} catch {
		return new Set();
	}
}

/** Every live record in `dataDir`; stale ones found on the way go. */
function liveSessions(dataDir: string, deps: SessionDeps): SessionRecord[] {
	return [...recordedPids(dataDir)].map((pid) => liveSession(dataDir, pid, deps)).filter((record) => record !== undefined);
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
		if (pid !== undefined) liveSession(dataDir, pid, deps);
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
 * time. False when it can't: the start can't be read, the record is no record, or nothing can be written there.
 */
export function recordSession(dataDir: string, record: Omit<SessionRecord, "start">, deps: SessionDeps = {}): boolean {
	const start = processStart(record.pid, deps);
	const full = start === undefined ? undefined : recordOf({ ...record, start }, record.pid);
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
 * The session this process (or deps.from) runs in: the nearest ancestor recorded in any of `dataDirs`, else what the
 * markers in `env` say for `config`'s data folder; with no config, any marker is a session of unknown identity (module
 * doc). Undefined: no session.
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
		for (const pid of ancestors(deps.from ?? process.pid, deps)) {
			for (const { dataDir, pids } of recorded) {
				const record = pids.has(pid) ? liveSession(dataDir, pid, deps) : undefined;
				if (record !== undefined) return { agent: record.agent, tool: record.tool, via: "ancestry", dataDir };
			}
		}
	}
	if (config !== undefined) return byMarkers(config, env, deps);
	// Nothing to check markers against: any of them is a session, whose agent nobody can say.
	const marked = MARKERS.some((key) => (env[key]?.trim() ?? "") !== "") || orreryPluginOptions(env.OPENCODE_CONFIG_CONTENT).length > 0;
	return marked ? { agent: undefined, tool: undefined, via: "marker", dataDir: dataDirs[0] ?? "" } : undefined;
}

/**
 * What one marker says: the agent a secret proves (`proves`), or the agent a record names unproven (`names`), and the
 * tool, when known.
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
	const marks: Mark[] = [];
	// Records: a session, and an agent that stands only when a token proves it too (CLAUDE_PID and Codex ids are public).
	const claude = liveSession(dataDir, Number(env.CLAUDE_PID), deps);
	if (claude?.tool === "claude-code") marks.push({ names: claude.agent, tool: claude.tool });
	const codexIds = [env.CODEX_THREAD_ID, env.CODEX_SESSION_ID].filter((id) => id !== undefined && id !== "");
	if (codexIds.length > 0) {
		for (const record of liveSessions(dataDir, deps)) {
			if (record.codexSession !== undefined && codexIds.includes(record.codexSession)) marks.push({ names: record.agent, tool: record.tool });
		}
	}
	// A name alone says there is a session; its token, claimed by a live process in the agent's claims, says whose.
	const claimant = (agent: AgentConfig, token: string | undefined): number | undefined => {
		const pid = token === undefined ? undefined : claimedBy(agent.dir, token);
		return pid !== undefined && alive(pid) ? pid : undefined;
	};
	const name = env[AGENT_ENV]?.trim();
	const named = name ? agentNamed(config, name) : undefined;
	if (named !== undefined) {
		const pid = claimant(named, env[TOKEN_ENV]);
		marks.push(pid === undefined ? { tool: undefined } : { proves: named.name, tool: liveSession(dataDir, pid, deps)?.tool });
	}
	for (const given of orreryPluginOptions(env.OPENCODE_CONFIG_CONTENT)) {
		const options = readPluginOptions(given);
		if ("problem" in options) continue;
		const agent = agentNamed(config, options.agent);
		if (agent === undefined) continue;
		marks.push(claimant(agent, launchToken(options.tokenFile, env)) === undefined ? { tool: "opencode" } : { proves: agent.name, tool: "opencode" });
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
