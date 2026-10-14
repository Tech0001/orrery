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
 * only: the kind of pick, the lane, and how it was decided. SessionEnd at the process's end removes it
 * (forgetProcess); a new decision first prunes the records of processes that are gone.
 *
 * Fail closed: a decision that cannot be recorded, or a later event with ORRERY_AGENT set that finds no record for its
 * process, is refused (no memory, nothing recorded, no view, no tools, the guard on with the folder lane's rules), never
 * "none".
 *
 * Known limit: a reused pid whose old record survived (its process died without SessionEnd, and no decision has pruned
 * it since) inherits that record's pick.
 *
 * One rule of Claude Code's own: an agent opened by ORRERY_AGENT in a folder that a lane set up the file way holds (its
 * own or an ancestor's: Claude Code loads every ancestor's CLAUDE.md and CLAUDE.local.md) is refused when that lane is
 * another, since those files import that lane's memory view and Claude Code loads it into the session whatever Orrery
 * does. Known limit: Claude Code also loads a subfolder's CLAUDE.local.md once the session reads files there; Orrery
 * cannot intercept that loading. The Orrery mod avoids it (mod mode writes no view file).
 */

import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type HarnessConfig, inWorkspace } from "../lane/config.ts";
import { AGENT_ENV, type Picked, pickLane, type Refused, refusedNotice, type Where } from "../lane/pick.ts";
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
	/** A later event found no recorded decision for its process. */
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
			return "Orrery: ORRERY_AGENT is set, but no choice of agent is recorded for this Claude Code (its session start made none); this session runs without memory.";
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

/** The record: names only. */
type Decision =
	| { readonly kind: "lane"; readonly lane: string; readonly by: "env" | "folder" }
	| { readonly kind: "none" }
	| { readonly kind: "refused"; readonly why: "unknown" | "bad-token" | "in-view-folder"; readonly name: string; readonly host?: string };

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

/** The process's record: undefined when there is none; "unreadable" when there is one that cannot be read as one. */
function readDecision(config: HarnessConfig, pid: number): Decision | "unreadable" | undefined {
	let text: string;
	try {
		text = readFileSync(recordFile(config, pid), "utf8");
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : "unreadable";
	}
	try {
		const value = JSON.parse(text) as Record<string, unknown>;
		if (value.kind === "none") return { kind: "none" };
		if (value.kind === "lane" && typeof value.lane === "string" && (value.by === "env" || value.by === "folder")) return { kind: "lane", lane: value.lane, by: value.by };
		if (value.kind === "refused" && typeof value.name === "string" && (value.why === "unknown" || value.why === "bad-token" || value.why === "in-view-folder")) {
			return { kind: "refused", why: value.why, name: value.name, ...(typeof value.host === "string" ? { host: value.host } : {}) };
		}
	} catch {
		// not JSON
	}
	return "unreadable";
}

/**
 * Records the process's decision, exclusively: written whole to a temporary file, then linked into place, so no reader
 * ever sees half of it. "exists" when another consumer of the process recorded first; else the error's text.
 */
function recordDecision(config: HarnessConfig, pid: number, decision: Decision): true | "exists" | string {
	const file = recordFile(config, pid);
	const temporary = `${file}.${randomBytes(6).toString("hex")}`;
	try {
		mkdirSync(processesDir(config), { recursive: true, mode: 0o700 });
		writeFileSync(temporary, `${JSON.stringify(decision)}\n`, { flag: "wx", mode: 0o600 });
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

/** The session's lane for Claude Code process `process`: its recorded decision, made here when it may (module doc). */
export function claudeSession(config: HarnessConfig, asking: ClaudeProcess): ClaudePicked {
	const where = { env: asking.env, cwd: asking.cwd, owner: asking.pid, ...(asking.alive === undefined ? {} : { alive: asking.alive }) };
	// No ORRERY_AGENT: no token, and nothing to decide once; the folder decides, as it always has.
	if (!asking.env[AGENT_ENV]?.trim()) return claudePick(config, { ...where, takeover: false });
	const recorded = readDecision(config, asking.pid);
	if (recorded === "unreadable") return { kind: "unrecorded", why: "its record is unreadable" };
	if (recorded !== undefined) return fromDecision(config, recorded);
	if (!asking.decide) return { kind: "undecided" };
	prune(config, asking.alive ?? processAlive);
	const pick = claudePick(config, { ...where, takeover: true });
	const written = recordDecision(config, asking.pid, toDecision(pick));
	if (written === true) return pick;
	if (written !== "exists") return { kind: "unrecorded", why: written };
	// Another consumer of this process decided first: its decision holds.
	const theirs = readDecision(config, asking.pid);
	return theirs === undefined || theirs === "unreadable" ? { kind: "unrecorded", why: "its record is unreadable" } : fromDecision(config, theirs);
}

/** SessionEnd at the process's end: its decision goes. */
export function forgetProcess(config: HarnessConfig, pid: number): void {
	try {
		rmSync(recordFile(config, pid), { force: true });
	} catch {
		// a later decision's prune takes it once the process is gone
	}
}
