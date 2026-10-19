/**
 * Which agent a Claude Code session belongs to: one answer for its hooks, the MCP server, `claude-mod view` and the
 * commands' "." (src/agent/pick.ts), decided once per Claude Code process.
 *
 * The first consumer to pick for a Claude Code process (the MCP server at its start, or the first SessionStart,
 * whichever comes first) records that process's decision in <data>/claude-processes/<pid>.json, made exclusively (0600,
 * in a 0700 folder), and every later event of the process reads it and never decides again: later SessionStarts
 * (compact, clear, an in-process resume), the other hooks, the mod view, a restarted MCP server and ".". So a dead
 * agent's token claim is taken over only in that first decision, and the hooks, the view and the tools never split
 * between agents. The record holds names only: whose decision it is (ORRERY_AGENT, and a sha256 digest of
 * ORRERY_AGENT_TOKEN), when its process started, the kind of pick, the agent, and how it was decided. SessionEnd at the
 * process's end removes it (forgetProcess); a new decision first prunes the records of processes that are gone.
 *
 * Started inside an agent's session (spec 2026-10-18-agent-permissions §3b): the first decision asks, before any pick,
 * whether the Claude Code runs under an agent's session (src/agent/sessions.ts, the process as `self`). If so that is
 * its decision ("nested"), whatever ORRERY_AGENT or the folder says: no memory, no token claimed, nothing recorded, no
 * view, no tools, the guard on with the outer agent's rules. Without ORRERY_AGENT the decision is only that it is not
 * ("folder"): the folder still decides at each event, as it always has, but no hook walks the process tree. A reader
 * that finds no decision for its process (a Claude Code started before this version) judges it itself, recording
 * nothing. An agent's session records its Claude Code as the agent's host (src/agent/sessions.ts), which the decider
 * keeps up to date and forgetProcess removes.
 *
 * A record of another identity is stale: another process's whose pid this one reuses (pids wrap, at 99999 on a Mac: its
 * process started at another time), or an ancestor's whose CLAUDE_PID a descendant inherited. A decider takes it down exclusively and records its own
 * decision in its place (src/agent/exclusive.ts); of two deciders, the loser reads the winner's record. Any other reader
 * is refused.
 *
 * Fail closed: a decision that cannot be recorded, or a later event with ORRERY_AGENT set that finds no record of its
 * own for its process, is refused (no memory, nothing recorded, no view, no tools, the guard on with the folder agent's
 * rules), never "none". A crash between a stale record's takedown and the new link leaves no record, so the next event
 * refuses the same way, until a SessionStart decides afresh.
 *
 * One rule of Claude Code's own: an agent opened by ORRERY_AGENT in a folder that an agent set up the file way holds (its
 * own or an ancestor's: Claude Code loads every ancestor's CLAUDE.md and CLAUDE.local.md) is refused when that agent is
 * another, since those files import that agent's memory view and Claude Code loads it into the session whatever Orrery
 * does. Known limit: Claude Code also loads a subfolder's CLAUDE.local.md once the session reads files there; Orrery
 * cannot intercept that loading. The Orrery mod avoids it (mod mode writes no view file).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type HarnessConfig, insideFolder } from "../agent/config.ts";
import { beingMade, publish, removeStale, stray, temporaryOf } from "../agent/exclusive.ts";
import { AGENT_ENV, type Picked, pickAgent, type Refused, refusedNotice, TOKEN_ENV, type Where } from "../agent/pick.ts";
import { processAlive, processInfo } from "../agent/process.ts";
import { forgetSession, type Inside, insideSession, liveSession, nestedNotice, processStart, recordSession, type SessionTool } from "../agent/sessions.ts";
import { safeText } from "../agent/source-labels.ts";
import { agentMode } from "./view-file.ts";

/** Refused by Claude Code's rules, beyond pickAgent's own refusals. */
export type ClaudeRefused =
	| Refused
	/** ORRERY_AGENT named `name`, but the folder is `host`'s, which loads `host`'s view (file mode). */
	| { readonly kind: "in-view-folder"; readonly name: string; readonly host: string }
	/** The first decision could not be recorded (`why`). */
	| { readonly kind: "unrecorded"; readonly why: string }
	/** A later event found no recorded decision of its own (its ORRERY_AGENT and token) for its process. */
	| { readonly kind: "undecided" }
	/**
	 * The Claude Code was started inside an agent's session (spec 2026-10-18-agent-permissions §3b): `outer`'s, in `tool`,
	 * either undefined when nothing proves it. It opens no memory and records nothing.
	 */
	| { readonly kind: "nested"; readonly outer: string | undefined; readonly tool: SessionTool | undefined }
	/**
	 * The Claude Code's process can't be confirmed: its start time can't be read, so its own decision can't be told from a
	 * dead process's under its pid, nor recorded. No memory, nothing recorded; the guard keeps the folder's agent's rules.
	 */
	| { readonly kind: "unconfirmed" };

/** What an unconfirmed session (ClaudeRefused "unconfirmed") says, and the reason its SessionStart marks it read-only with. */
export const UNCONFIRMED_NOTICE = "Orrery: this Claude Code's process can't be confirmed (its start time can't be read), so this session opens no memory and records nothing.";

/**
 * A pick, or why there is none. Without ORRERY_AGENT a decision that could not be recorded costs nothing but speed (each
 * event judges again): the pick says why (`notRecorded`), for SessionStart to tell.
 */
export type ClaudePicked = (Exclude<Picked, Refused> & { readonly notRecorded?: string }) | ClaudeRefused;

/**
 * pickAgent, and a by-ORRERY_AGENT pick refused in a folder that another agent, set up the file way, holds: the deepest
 * agent's or any ancestor's (see the module doc).
 */
export function claudePick(config: HarnessConfig, where: Where): ClaudePicked {
	const pick = pickAgent(config, where);
	if (pick.kind !== "agent" || pick.by !== "env") return pick;
	for (const host of config.agents.values()) {
		if (host.name !== pick.agent.name && insideFolder(host, where.cwd) && agentMode(host) === "file") return { kind: "in-view-folder", name: pick.agent.name, host: host.name };
	}
	return pick;
}

/** What a session whose ORRERY_AGENT was refused says, once. */
export function claudeRefusedNotice(pick: ClaudeRefused): string {
	switch (pick.kind) {
		case "in-view-folder": {
			const { name, host } = pick;
			return `Orrery: this folder is ${host}'s, set up to load ${host}'s memory view into Claude Code, so ${name} does not open here (${host}'s memory would be in its session); this session runs without memory. Open ${name} in another folder, or switch ${host} to the mod (\`orrery claude-setup ${host} --mod\`).`;
		}
		case "unrecorded":
			return `Orrery: ORRERY_AGENT is set, but which agent this Claude Code is could not be recorded (${safeText(pick.why)}); this session runs without memory.`;
		case "undecided":
			return "Orrery: ORRERY_AGENT is set, but no choice of agent is recorded for this Claude Code under this ORRERY_AGENT; this session runs without memory.";
		case "nested":
			return nestedNotice({ agent: pick.outer, tool: pick.tool, via: "ancestry", dataDir: "" });
		case "unconfirmed":
			return UNCONFIRMED_NOTICE;
		default:
			return refusedNotice(pick);
	}
}

/** A Claude Code process asking which agent its session belongs to. */
export interface ClaudeProcess {
	readonly env: NodeJS.ProcessEnv;
	/** The session's project folder. */
	readonly cwd: string;
	/** Claude Code's own pid: the record's key, and the owner of a token claim. */
	readonly pid: number;
	/** Whether this consumer may make the process's first decision: the MCP server at its start, and SessionStart. */
	readonly decide: boolean;
	/** Whether a pid lives (default processAlive); tests pass their own. */
	readonly alive?: (pid: number) => boolean;
	/** How the process's start time is read (default processStart, src/agent/sessions.ts); tests pass their own. */
	readonly start?: (pid: number) => string | undefined;
}

/** A decision, as recorded: names only. */
type Decision =
	| { readonly kind: "agent"; readonly name: string; readonly by: "env" | "folder" }
	| { readonly kind: "none" }
	| { readonly kind: "refused"; readonly why: "unknown" | "bad-token" | "in-view-folder"; readonly name: string; readonly host?: string }
	/** Started inside `outer`'s session in `tool` (either left out when unknown): no memory. */
	| { readonly kind: "nested"; readonly outer?: string; readonly tool?: SessionTool }
	/** No ORRERY_AGENT, and started inside no agent's session: the folder decides, at each event. */
	| { readonly kind: "folder" };

/**
 * Whose decision a record is: ORRERY_AGENT as set (trimmed, "" without one), the sha256 (hex) of ORRERY_AGENT_TOKEN, or
 * "" without one, and when the process started (src/agent/sessions.ts processStart). A record whose identity is not the
 * asker's is another process's, whose pid this one reuses (every process without ORRERY_AGENT
 * shares the rest of an identity), or an ancestor's whose CLAUDE_PID a descendant inherited: never this session's.
 */
interface Identity {
	readonly agent: string;
	readonly token: string;
	readonly start?: string;
}

function identityOf(env: NodeJS.ProcessEnv, start: string): Identity {
	const token = env[TOKEN_ENV];
	return { agent: env[AGENT_ENV]?.trim() ?? "", token: token === undefined ? "" : createHash("sha256").update(token).digest("hex"), start };
}

const processesDir = (config: HarnessConfig) => join(config.dataDir, "claude-processes");
const recordFile = (config: HarnessConfig, pid: number) => join(processesDir(config), `${pid}.json`);

/** The record of a first pick (which is never "unrecorded" or "undecided"). */
function toDecision(pick: ClaudePicked): Decision {
	switch (pick.kind) {
		case "agent":
			return { kind: "agent", name: pick.agent.name, by: pick.by };
		case "unknown":
		case "bad-token":
			return { kind: "refused", why: pick.kind, name: pick.name };
		case "in-view-folder":
			return { kind: "refused", why: pick.kind, name: pick.name, host: pick.host };
		case "nested":
			return { kind: "nested", ...(pick.outer === undefined ? {} : { outer: pick.outer }), ...(pick.tool === undefined ? {} : { tool: pick.tool }) };
		default:
			return { kind: "none" };
	}
}

/** A decision as the pick it stands for; "folder" is the folder's pick, now. */
function fromDecision(config: HarnessConfig, decision: Decision, where: Where): ClaudePicked {
	switch (decision.kind) {
		case "agent": {
			const agent = config.agents.get(decision.name);
			// An agent gone from the config since: as ORRERY_AGENT naming no agent.
			return agent === undefined ? { kind: "unknown", name: decision.name } : { kind: "agent", agent, by: decision.by };
		}
		case "none":
			return { kind: "none" };
		case "refused":
			return decision.why === "in-view-folder" ? { kind: "in-view-folder", name: decision.name, host: decision.host ?? "" } : { kind: decision.why, name: decision.name };
		case "nested":
			return { kind: "nested", outer: decision.outer, tool: decision.tool };
		case "folder":
			return claudePick(config, { ...where, takeover: false });
	}
}

/** What the record said; `identity` is missing from a record that names none (one written before identities). */
interface Recorded {
	readonly identity?: Identity;
	readonly decision: Decision;
}

/** The process's record: undefined when there is none; "unreadable" when there is one that cannot be read as one. */
const readRecord = (config: HarnessConfig, pid: number) => readRecordFile(recordFile(config, pid));

const TOOLS: ReadonlySet<string> = new Set<SessionTool>(["pi", "omp", "claude-code", "codex", "opencode", "run"]);

function readRecordFile(file: string): Recorded | "unreadable" | undefined {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : "unreadable";
	}
	let value: Record<string, unknown>;
	try {
		value = JSON.parse(text) as Record<string, unknown>;
	} catch {
		return "unreadable";
	}
	if (typeof value !== "object" || value === null) return "unreadable";
	const identity =
		typeof value.agent === "string" && typeof value.token === "string" ? { agent: value.agent, token: value.token, ...(typeof value.start === "string" ? { start: value.start } : {}) } : undefined;
	const recorded = (decision: Decision): Recorded => ({ ...(identity === undefined ? {} : { identity }), decision });
	if (value.kind === "none") return recorded({ kind: "none" });
	if (value.kind === "folder") return recorded({ kind: "folder" });
	if (value.kind === "agent" && typeof value.name === "string" && (value.by === "env" || value.by === "folder")) return recorded({ kind: "agent", name: value.name, by: value.by });
	if (value.kind === "refused" && typeof value.name === "string" && (value.why === "unknown" || value.why === "bad-token" || value.why === "in-view-folder")) {
		return recorded({ kind: "refused", why: value.why, name: value.name, ...(typeof value.host === "string" ? { host: value.host } : {}) });
	}
	if (value.kind === "nested" && (value.outer === undefined || typeof value.outer === "string") && (value.tool === undefined || (typeof value.tool === "string" && TOOLS.has(value.tool)))) {
		return recorded({ kind: "nested", ...(value.outer === undefined ? {} : { outer: value.outer }), ...(value.tool === undefined ? {} : { tool: value.tool as SessionTool }) });
	}
	return "unreadable";
}

/**
 * Whether a record is the asker's: the same agent and token, and the same start, both known. A record made before start
 * times (none in it) stands only for an ORRERY_AGENT launch's token, whose digest alone tells its process apart from
 * others: a session running across the update keeps its decision. One without a token (a folder's, or an ORRERY_AGENT
 * with no token) and no start is no one's.
 */
function sameIdentity(recorded: Identity | undefined, asker: Identity): boolean {
	if (recorded === undefined || recorded.agent !== asker.agent || recorded.token !== asker.token) return false;
	if (recorded.start === undefined) return recorded.agent !== "" && recorded.token !== "";
	return asker.start !== undefined && recorded.start === asker.start;
}

/**
 * A readable record of another identity: never this session's, and a decider's to replace. A missing one is stale too:
 * in the graveyard, a pruner may have swept it (src/agent/exclusive.ts).
 */
const staleFor = (asker: Identity) => (file: string) => {
	const recorded = readRecordFile(file);
	return recorded === undefined || (recorded !== "unreadable" && !sameIdentity(recorded.identity, asker));
};

/**
 * Records the process's decision, whole: written to a temporary file, then published to its name exclusively
 * (src/agent/exclusive.ts), so no reader ever sees half of it, and "exists" when another consumer of the process
 * recorded first. A stale record (`replace`) is taken down exclusively before that: of two deciders, one renames it
 * away, and the other finds the winner's fresh record of this identity, leaves it standing and gets "exists". Else the
 * error's text.
 */
function recordDecision(config: HarnessConfig, pid: number, record: Identity & Decision, replace: boolean): true | "exists" | string {
	const file = recordFile(config, pid);
	const temporary = temporaryOf(file);
	try {
		mkdirSync(processesDir(config), { recursive: true, mode: 0o700 });
		const content = `${JSON.stringify(record)}\n`;
		writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
		if (replace) removeStale(file, staleFor(record));
		return publish(temporary, file, content);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	} finally {
		try {
			rmSync(temporary, { force: true });
		} catch {
			// left for a later prune
		}
	}
}

const RECORD = /^\d+\.json$/;

/**
 * Removes the records of processes that are gone, before a new decision, except one still being made (publish's
 * fallback is writing it: empty and young). Temporary and graveyard files go once stray.
 */
function prune(config: HarnessConfig, alive: (pid: number) => boolean): void {
	let names: string[];
	try {
		names = readdirSync(processesDir(config));
	} catch {
		return;
	}
	for (const name of names) {
		const file = join(processesDir(config), name);
		const pid = Number.parseInt(name, 10);
		if (RECORD.test(name) ? (Number.isInteger(pid) && pid > 0 && alive(pid)) || beingMade(file) : !stray(file)) continue;
		try {
			rmSync(file, { force: true });
		} catch {
			// gone already, or not ours to remove
		}
	}
}

/**
 * The agent session Claude Code process `asking.pid` was started inside (src/agent/sessions.ts, with the process as
 * `self`, so its own launch's markers are its own), or undefined. Its pid hosting another tool's live session (a pi's, a
 * Codex's) makes it no Claude Code of its own: inside that session. A look that fails counts as a session whose agent is
 * unknown: a check that can't judge refuses.
 */
function nestedIn(config: HarnessConfig, asking: ClaudeProcess): Inside | undefined {
	try {
		const own = liveSession(config.dataDir, asking.pid);
		if (own !== undefined && own.tool !== "claude-code") return { agent: own.agent, tool: own.tool, via: "ancestry", dataDir: config.dataDir };
		return insideSession([config.dataDir], asking.env, config, { self: asking.pid });
	} catch {
		return { agent: undefined, tool: undefined, via: "marker", dataDir: config.dataDir };
	}
}

const nestedPick = (inside: Inside): ClaudePicked => ({ kind: "nested", outer: inside.agent, tool: inside.tool });

/**
 * A decider's pick, with the process's host record (spec 2026-10-18-agent-permissions §2) to match: an agent's session
 * records the Claude Code as its host in the config's data folder, so what its shell starts is known as the agent's; a
 * session that is no agent's has none (one a former pick of the process left goes). A nested one records nothing, and
 * touches no record.
 */
function hosted(config: HarnessConfig, pid: number, pick: ClaudePicked): ClaudePicked {
	if (pick.kind === "agent") recordSession(config.dataDir, { agent: pick.agent.name, tool: "claude-code", pid, config: config.file });
	else if (pick.kind !== "nested") forgetHost(config, pid);
	return pick;
}

/** Forgets `pid`'s host record when it is a Claude Code's: another tool's session there is not this process's to end. */
function forgetHost(config: HarnessConfig, pid: number): void {
	if (liveSession(config.dataDir, pid)?.tool === "claude-code") forgetSession(config.dataDir, pid);
}

/**
 * The session's agent for Claude Code process `asking`: its recorded decision, made here when it may (module doc). The
 * first decider of a process asks whether it was started inside an agent's session, before any pick (which may claim a
 * token): if so, that is its decision, in the agent's folder too, and it opens no memory. Without ORRERY_AGENT the
 * decision is only that ("folder": the folder decides at each event, as it always has), so no hook walks the process's
 * ancestry; a reader that finds no decision for its process (one started before this version, or whose decision could
 * not be written) judges it itself, and records nothing.
 */
export function claudeSession(config: HarnessConfig, asking: ClaudeProcess): ClaudePicked {
	const where = { env: asking.env, cwd: asking.cwd, owner: asking.pid, ...(asking.alive === undefined ? {} : { alive: asking.alive }) };
	const byEnv = Boolean(asking.env[AGENT_ENV]?.trim());
	// A process whose start can't be read can't tell its own decision from a dead one's under its pid, and never records
	// one: no memory (fail closed). A decider, which may record, reads it twice before it gives up.
	const startOf = asking.start ?? processStart;
	const start = startOf(asking.pid) ?? (asking.decide ? startOf(asking.pid) : undefined);
	if (start === undefined) return { kind: "unconfirmed" };
	const identity = identityOf(asking.env, start);
	const settled = (decision: Decision) => {
		const pick = fromDecision(config, decision, where);
		return asking.decide ? hosted(config, asking.pid, pick) : pick;
	};
	const recorded = readRecord(config, asking.pid);
	if (recorded !== undefined && recorded !== "unreadable" && sameIdentity(recorded.identity, identity)) return settled(recorded.decision);
	if (recorded === "unreadable" && byEnv) return { kind: "unrecorded", why: "its record is unreadable" };
	// No record of its own (none, or a stale one: another identity's): only a decider makes this process's decision.
	if (!asking.decide) {
		if (byEnv) return { kind: "undecided" };
		const inside = nestedIn(config, asking);
		return inside === undefined ? claudePick(config, { ...where, takeover: false }) : nestedPick(inside);
	}
	prune(config, asking.alive ?? processAlive);
	const inside = nestedIn(config, asking);
	const pick = inside === undefined ? claudePick(config, { ...where, takeover: byEnv }) : nestedPick(inside);
	const decision: Decision = byEnv || pick.kind === "nested" ? toDecision(pick) : { kind: "folder" };
	const written = recordDecision(config, asking.pid, { ...identity, ...decision }, recorded !== undefined);
	if (written === true) return hosted(config, asking.pid, pick);
	// By its folder, a decision that can't be written is judged again at each event, which SessionStart says.
	const unwritten = (why: string) => hosted(config, asking.pid, pick.kind === "agent" ? { ...pick, notRecorded: why } : pick);
	if (written !== "exists") return byEnv ? { kind: "unrecorded", why: written } : unwritten(written);
	// Another consumer of this process decided first: its decision holds.
	const theirs = readRecord(config, asking.pid);
	if (theirs !== undefined && theirs !== "unreadable" && sameIdentity(theirs.identity, identity)) return settled(theirs.decision);
	if (!byEnv) return unwritten("its record is another's, or unreadable");
	return theirs === undefined || theirs === "unreadable" ? { kind: "unrecorded", why: "its record is unreadable" } : { kind: "undecided" };
}

/**
 * When the Claude Code process `pid` started, as its decision record says (src/claude/peer.ts checks a hook's caller
 * against it); undefined without a readable record, or one that holds no start.
 */
export function decisionStart(config: HarnessConfig, pid: number): string | undefined {
	const recorded = readRecord(config, pid);
	return recorded === undefined || recorded === "unreadable" ? undefined : recorded.identity?.start;
}

/** SessionEnd at the process's end: its decision goes, and its host record (a Claude Code's only). */
export function forgetProcess(config: HarnessConfig, pid: number): void {
	try {
		rmSync(recordFile(config, pid), { force: true });
	} catch {
		// a later decision's prune takes it once the process is gone
	}
	forgetHost(config, pid);
}

/**
 * Claude Code's process, for a hook it runs: CLAUDE_PID, which Claude Code sets to its own pid for its hooks over any it
 * inherited (2.1.302 seen), checked against the hook's place in the process tree, since an environment is anyone's to
 * set. Claude Code starts a hook through a shell that execs it, so the hook's parent is Claude Code; past one shell that
 * did not exec (an older /bin/sh), its grandparent, when that shell is no session's host and no Claude Code with a
 * decision of its own. Without CLAUDE_PID (an older Claude Code), the parent. Undefined when CLAUDE_PID names any other
 * process: the hook can't tell whose it is, and opens no memory (fail closed).
 */
export function claudeHookPid(
	config: HarnessConfig,
	env: NodeJS.ProcessEnv,
	parent: number = process.ppid,
	parentOf: (pid: number) => number | undefined = (pid) => processInfo(pid)?.ppid,
): number | undefined {
	const named = env.CLAUDE_PID?.trim();
	if (named === undefined || named === "") return parent;
	const pid = /^\d+$/.test(named) ? Number(named) : Number.NaN;
	if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
	if (pid === parent) return pid;
	if (parentOf(parent) !== pid) return undefined;
	return existsSync(recordFile(config, parent)) || liveSession(config.dataDir, parent) !== undefined ? undefined : pid;
}
