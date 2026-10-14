/**
 * Which lane a Claude Code session belongs to: one answer for its hooks, the MCP server, `claude-mod view` and the
 * commands' "." (src/lane/pick.ts), decided once per Claude Code process.
 *
 * Without ORRERY_AGENT the folder decides, at each event, as it always has. With ORRERY_AGENT set, the first consumer
 * to pick for a Claude Code process (the MCP server at its start, or the first SessionStart, whichever comes first)
 * records that process's pick in <data>/claude-processes/<pid>.json, made exclusively (0600, in a 0700 folder), and
 * every later event of the process reads it and never picks again: later SessionStarts (compact, clear, an in-process
 * resume), the other hooks, the mod view, a restarted MCP server and ".". So a dead agent's token claim is taken over
 * only in that first decision, and the hooks, the view and the tools never split between lanes. The record holds names
 * only: whose decision it is (ORRERY_AGENT, and a sha256 digest of ORRERY_AGENT_TOKEN), the kind of pick, the lane, and
 * how it was decided. SessionEnd at the process's end removes it (forgetProcess); a new decision first prunes the
 * records of processes that are gone.
 *
 * A record of another identity is stale: another process's whose pid this one reuses (pids wrap, at 99999 on a Mac), or
 * an ancestor's whose CLAUDE_PID a descendant inherited. A decider replaces it whole (a temporary file renamed over it);
 * any other reader is refused.
 *
 * Fail closed: a decision that cannot be recorded, or a later event with ORRERY_AGENT set that finds no record of its
 * own for its process, is refused (no memory, nothing recorded, no view, no tools, the guard on with the folder lane's
 * rules), never "none".
 *
 * Known limit: a reused pid whose old record survived (its process died without SessionEnd, and no decision has pruned
 * it since) and was made under the same ORRERY_AGENT and token inherits that record's pick.
 *
 * One rule of Claude Code's own: an agent opened by ORRERY_AGENT in a folder that a lane set up the file way holds (its
 * own or an ancestor's: Claude Code loads every ancestor's CLAUDE.md and CLAUDE.local.md) is refused when that lane is
 * another, since those files import that lane's memory view and Claude Code loads it into the session whatever Orrery
 * does. Known limit: Claude Code also loads a subfolder's CLAUDE.local.md once the session reads files there; Orrery
 * cannot intercept that loading. The Orrery mod avoids it (mod mode writes no view file).
 */

import { createHash, randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type HarnessConfig, inWorkspace } from "../lane/config.ts";
import { AGENT_ENV, type Picked, pickLane, type Refused, refusedNotice, TOKEN_ENV, type Where } from "../lane/pick.ts";
import { processAlive } from "../lane/process.ts";
import { safeText } from "../lane/source-labels.ts";
import { laneMode } from "./view-file.ts";

/** Refused by Claude Code's rules, beyond pickLane's own refusals. */
export type ClaudeRefused =
	| Refused
	/** ORRERY_AGENT named `name`, but the folder is `host`'s, which loads `host`'s view (file mode). */
	| { readonly kind: "in-view-folder"; readonly name: string; readonly host: string }
	/** The first decision could not be recorded (`why`). */
	| { readonly kind: "unrecorded"; readonly why: string }
	/** A later event found no recorded decision of its own (its ORRERY_AGENT and token) for its process. */
	| { readonly kind: "undecided" };

export type ClaudePicked = Exclude<Picked, Refused> | ClaudeRefused;

/**
 * pickLane, and a by-ORRERY_AGENT pick refused in a folder that another lane, set up the file way, holds: the deepest
 * lane's or any ancestor's (see the module doc).
 */
export function claudePick(config: HarnessConfig, where: Where): ClaudePicked {
	const pick = pickLane(config, where);
	if (pick.kind !== "lane" || pick.by !== "env") return pick;
	for (const host of config.lanes.values()) {
		if (host.name !== pick.lane.name && inWorkspace(host, where.cwd) && laneMode(host) === "file") return { kind: "in-view-folder", name: pick.lane.name, host: host.name };
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
		default:
			return refusedNotice(pick);
	}
}

/** A Claude Code process asking which lane its session belongs to. */
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
}

/** A decision, as recorded: names only. */
type Decision =
	| { readonly kind: "lane"; readonly lane: string; readonly by: "env" | "folder" }
	| { readonly kind: "none" }
	| { readonly kind: "refused"; readonly why: "unknown" | "bad-token" | "in-view-folder"; readonly name: string; readonly host?: string };

/**
 * Whose decision a record is: ORRERY_AGENT as set (trimmed), and the sha256 (hex) of ORRERY_AGENT_TOKEN, or "" without
 * one. A record whose identity is not the asker's is another process's, whose pid this one reuses, or an ancestor's
 * whose CLAUDE_PID a descendant inherited: never this session's.
 */
interface Identity {
	readonly agent: string;
	readonly token: string;
}

function identityOf(env: NodeJS.ProcessEnv): Identity {
	const token = env[TOKEN_ENV];
	return { agent: env[AGENT_ENV]?.trim() ?? "", token: token === undefined ? "" : createHash("sha256").update(token).digest("hex") };
}

const processesDir = (config: HarnessConfig) => join(config.dataDir, "claude-processes");
const recordFile = (config: HarnessConfig, pid: number) => join(processesDir(config), `${pid}.json`);

/** The record of a first pick (which is never "unrecorded" or "undecided"). */
function toDecision(pick: ClaudePicked): Decision {
	switch (pick.kind) {
		case "lane":
			return { kind: "lane", lane: pick.lane.name, by: pick.by };
		case "unknown":
		case "bad-token":
			return { kind: "refused", why: pick.kind, name: pick.name };
		case "in-view-folder":
			return { kind: "refused", why: pick.kind, name: pick.name, host: pick.host };
		default:
			return { kind: "none" };
	}
}

function fromDecision(config: HarnessConfig, decision: Decision): ClaudePicked {
	switch (decision.kind) {
		case "lane": {
			const lane = config.lanes.get(decision.lane);
			// A lane gone from the config since: as ORRERY_AGENT naming no lane.
			return lane === undefined ? { kind: "unknown", name: decision.lane } : { kind: "lane", lane, by: decision.by };
		}
		case "none":
			return { kind: "none" };
		case "refused":
			return decision.why === "in-view-folder" ? { kind: "in-view-folder", name: decision.name, host: decision.host ?? "" } : { kind: decision.why, name: decision.name };
	}
}

/** What the record said; `identity` is missing from a record that names none (one written before identities). */
interface Recorded {
	readonly identity?: Identity;
	readonly decision: Decision;
}

/** The process's record: undefined when there is none; "unreadable" when there is one that cannot be read as one. */
function readRecord(config: HarnessConfig, pid: number): Recorded | "unreadable" | undefined {
	let text: string;
	try {
		text = readFileSync(recordFile(config, pid), "utf8");
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
	const identity = typeof value.agent === "string" && typeof value.token === "string" ? { agent: value.agent, token: value.token } : undefined;
	const recorded = (decision: Decision): Recorded => ({ ...(identity === undefined ? {} : { identity }), decision });
	if (value.kind === "none") return recorded({ kind: "none" });
	if (value.kind === "lane" && typeof value.lane === "string" && (value.by === "env" || value.by === "folder")) return recorded({ kind: "lane", lane: value.lane, by: value.by });
	if (value.kind === "refused" && typeof value.name === "string" && (value.why === "unknown" || value.why === "bad-token" || value.why === "in-view-folder")) {
		return recorded({ kind: "refused", why: value.why, name: value.name, ...(typeof value.host === "string" ? { host: value.host } : {}) });
	}
	return "unreadable";
}

const sameIdentity = (recorded: Identity | undefined, asker: Identity) => recorded !== undefined && recorded.agent === asker.agent && recorded.token === asker.token;

/**
 * Records the process's decision, whole: written to a temporary file, then put in place, so no reader ever sees half of
 * it. A first decision is linked into place, exclusively: "exists" when another consumer of the process recorded first.
 * A decision that replaces a stale record (`replace`) is renamed over it. Else the error's text.
 */
function recordDecision(config: HarnessConfig, pid: number, record: Identity & Decision, replace: boolean): true | "exists" | string {
	const file = recordFile(config, pid);
	const temporary = `${file}.${randomBytes(6).toString("hex")}`;
	try {
		mkdirSync(processesDir(config), { recursive: true, mode: 0o700 });
		writeFileSync(temporary, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
		if (replace) {
			renameSync(temporary, file);
			return true;
		}
		try {
			linkSync(temporary, file);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return "exists";
			throw error;
		}
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

/** Removes the records (and stray temporary files) of processes that are gone, before a new decision. */
function prune(config: HarnessConfig, alive: (pid: number) => boolean): void {
	let names: string[];
	try {
		names = readdirSync(processesDir(config));
	} catch {
		return;
	}
	for (const name of names) {
		const pid = Number.parseInt(name, 10);
		if (Number.isInteger(pid) && pid > 0 && alive(pid)) continue;
		try {
			rmSync(join(processesDir(config), name), { force: true });
		} catch {
			// gone already, or not ours to remove
		}
	}
}

/** The session's lane for Claude Code process `asking`: its recorded decision, made here when it may (module doc). */
export function claudeSession(config: HarnessConfig, asking: ClaudeProcess): ClaudePicked {
	const where = { env: asking.env, cwd: asking.cwd, owner: asking.pid, ...(asking.alive === undefined ? {} : { alive: asking.alive }) };
	// No ORRERY_AGENT: no token, and nothing to decide once; the folder decides, as it always has.
	if (!asking.env[AGENT_ENV]?.trim()) return claudePick(config, { ...where, takeover: false });
	const identity = identityOf(asking.env);
	const recorded = readRecord(config, asking.pid);
	if (recorded === "unreadable") return { kind: "unrecorded", why: "its record is unreadable" };
	if (recorded !== undefined && sameIdentity(recorded.identity, identity)) return fromDecision(config, recorded.decision);
	// No record, or a stale one (another identity's): only a decider makes this process's decision.
	if (!asking.decide) return { kind: "undecided" };
	prune(config, asking.alive ?? processAlive);
	const pick = claudePick(config, { ...where, takeover: true });
	const written = recordDecision(config, asking.pid, { ...identity, ...toDecision(pick) }, recorded !== undefined);
	if (written === true) return pick;
	if (written !== "exists") return { kind: "unrecorded", why: written };
	// Another consumer of this process decided first: its decision holds.
	const theirs = readRecord(config, asking.pid);
	if (theirs === undefined || theirs === "unreadable") return { kind: "unrecorded", why: "its record is unreadable" };
	return sameIdentity(theirs.identity, identity) ? fromDecision(config, theirs.decision) : { kind: "undecided" };
}

/** SessionEnd at the process's end: its decision goes. */
export function forgetProcess(config: HarnessConfig, pid: number): void {
	try {
		rmSync(recordFile(config, pid), { force: true });
	} catch {
		// a later decision's prune takes it once the process is gone
	}
}
