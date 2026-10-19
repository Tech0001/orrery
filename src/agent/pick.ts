/**
 * Which agent a session belongs to (spec 2026-10-13-orrery-agents-design §4), decided at session start by pi's and OMP's
 * extension (and, later, Claude Code's hooks, MCP server and mod view), in order:
 * 1. ORRERY_AGENT, when set: the agent it names (ignoring case), or "unknown" (a notice and no memory; no fallback).
 *    A launcher may also set ORRERY_AGENT_TOKEN, 32 lowercase hex digits; any other value is "bad-token" (a notice and no
 *    memory; no fallback). The first process that starts a session with that token owns it (claims/<token> in the agent's
 *    folder), so a tool the agent starts itself, which inherits both variables, is not the agent too: it falls through
 *    to 2. A dead owner's claim is taken over only at a session's start (`takeover`); a session's later picks (Claude
 *    Code asks at every hook) keep what its start decided, so it never changes agents midway. A claim holds the owner's
 *    pid, then on Linux the pid namespace that pid is numbered in (claimText), so a reader in another namespace can tell
 *    it can't judge the claim (src/agent/sessions.ts). A one-line claim, an older version's, reads as before.
 * 2. The agent whose folder holds the folder (agentForCwd).
 * 3. None.
 * Node built-ins and relative imports only: pi and OMP load this file.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type HarnessConfig, insideFolder, type AgentConfig, agentForCwd } from "./config.ts";
import { beingMade, publish, removeStale, stray, temporaryOf } from "./exclusive.ts";
import { pidNamespace, processAlive } from "./process.ts";
import { safeText } from "./source-labels.ts";

export const AGENT_ENV = "ORRERY_AGENT";
export const TOKEN_ENV = "ORRERY_AGENT_TOKEN";
/** What newToken makes; nothing else is taken (a token names a file). */
const TOKEN = /^[0-9a-f]{32}$/;

/** ORRERY_AGENT was set but cannot be honoured: a notice, no memory, and no fallback to the folder's agent. */
export type Refused = { readonly kind: "unknown"; readonly name: string } | { readonly kind: "bad-token"; readonly name: string };

export type Picked = { readonly kind: "agent"; readonly agent: AgentConfig; readonly by: "env" | "folder" } | Refused | { readonly kind: "none" };

export interface Where {
	readonly env: NodeJS.ProcessEnv;
	/** The session's folder: pi's cwd, Claude Code's project folder. */
	readonly cwd: string;
	/** The session's own tool process: pi's or OMP's pid; Claude Code's pid for its hooks, MCP server and mod view. */
	readonly owner: number;
	/** Whether a pid lives (default processAlive); tests pass their own. */
	readonly alive?: (pid: number) => boolean;
	/**
	 * Whether this pick may claim the token: make the claim, or take a dead owner's over (default true). False for a
	 * session's later events, which may only find the owner's own claim (claimToken).
	 */
	readonly takeover?: boolean;
}

/** Whether `token` has the form newToken gives (32 lowercase hex digits). */
export const tokenForm = (token: string): boolean => TOKEN.test(token);

/** The agent `name` names: an exact match, else the one match ignoring case. */
export function agentNamed(config: HarnessConfig, name: string): AgentConfig | undefined {
	const exact = config.agents.get(name);
	if (exact !== undefined) return exact;
	const matches = [...config.agents.values()].filter((agent) => agent.name.toLowerCase() === name.toLowerCase());
	return matches.length === 1 ? matches[0] : undefined;
}

export function pickAgent(config: HarnessConfig, where: Where): Picked {
	const name = where.env[AGENT_ENV]?.trim();
	if (name) {
		const agent = agentNamed(config, name);
		if (agent === undefined) return { kind: "unknown", name };
		const token = where.env[TOKEN_ENV];
		if (token !== undefined && !TOKEN.test(token)) return { kind: "bad-token", name: agent.name };
		if (token === undefined || claimToken(agent.dir, token, where.owner, where.alive, where.takeover !== false)) return { kind: "agent", agent, by: "env" };
	}
	const agent = agentForCwd(config, where.cwd);
	return agent === undefined ? { kind: "none" } : { kind: "agent", agent, by: "folder" };
}

/** The pid a claim's text starts with, or undefined when it starts with none. */
function pidIn(text: string): number | undefined {
	const pid = Number.parseInt(text, 10);
	return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** The pid a claim file holds, or undefined when it holds none (unreadable, empty, or not a pid). */
function claimant(file: string): number | undefined {
	try {
		return pidIn(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

/**
 * What a claim file holds: the live process it names; "making" when it names none yet but is young (publish's fallback
 * is still writing it; src/agent/exclusive.ts); else "dead": its process is gone, or it names no pid and is old (a
 * crash's leftover, or an older version's). One rule for pruning and for taking a token over.
 */
function holding(file: string, alive: (pid: number) => boolean): number | "making" | "dead" {
	const pid = claimant(file);
	if (pid !== undefined) return alive(pid) ? pid : "dead";
	return beingMade(file) ? "making" : "dead";
}

const dead = (alive: (pid: number) => boolean) => (file: string) => holding(file, alive) === "dead";

/**
 * Takes out dead claims (holding): files named by a token, each taken down exclusively (removeStale), so a fresh claim
 * made meanwhile stays. A live owner's claim stays however old it is (an agent may run for weeks). Any other file is a
 * temporary or graveyard one, another process's claim being made or taken over: only stray ones, old enough, go.
 */
function pruneClaims(dir: string, alive: (pid: number) => boolean): void {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) {
		const file = join(dir, name);
		try {
			if (TOKEN.test(name)) {
				if (holding(file, alive) === "dead") removeStale(file, dead(alive));
			} else if (stray(file)) rmSync(file, { force: true });
		} catch {
			// gone already
		}
	}
}

/**
 * Whether `owner` may take ORRERY_AGENT with `token`: it claimed it before, or is the first to claim it, or the claim
 * is dead (holding). Without `takeover` (a session's later events) only the first: such an event never makes a claim
 * nor takes a dead one over, so a session that started as another process's tool stays one. False for a token that is
 * not 32 lowercase hex digits (it must never name a file elsewhere).
 *
 * The claim is written whole to a temporary file, then published to its name exclusively (src/agent/exclusive.ts:
 * EEXIST, someone holds it), so no claim ever exists without its pid for a pruner to take for dead. A dead claim found
 * then is taken down exclusively (removeStale), and the link decides again. Whatever a taker lost, the rename, the
 * link, or a live claim it had moved and put back, it owns the token only if the claim that stands is its own (another
 * consumer of the same process may have made it). A crash between the takedown and the link leaves no claim: the next
 * claim is made fresh, and until then later events (no takeover) fall back to the folder, as they did on a dead claim.
 */
export function claimToken(agentDir: string, token: string, owner: number, alive: (pid: number) => boolean = processAlive, takeover = true): boolean {
	if (!TOKEN.test(token)) return false;
	const dir = join(agentDir, "claims");
	const file = join(dir, token);
	// The owner's own claim, the common case (Claude Code asks at every hook): nothing to prune or write.
	if (claimant(file) === owner) return true;
	if (!takeover) return false;
	let temporary: string | undefined;
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		pruneClaims(dir, alive);
		const content = claimText(owner);
		temporary = temporaryOf(file);
		writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
		if (publish(temporary, file, content) === true) return true;
		// Made since the prune: the same rule decides.
		const held = holding(file, alive);
		if (held !== "dead") return held === owner;
		removeStale(file, dead(alive));
		if (publish(temporary, file, content) === true) return true;
		return claimant(file) === owner;
	} catch {
		// A claim that cannot be recorded never costs the session its agent.
		return true;
	} finally {
		try {
			if (temporary !== undefined) rmSync(temporary, { force: true });
		} catch {
			// a stray one: a later prune takes it
		}
	}
}

/** What a claim by `owner` holds: its pid, then on Linux the pid namespace of this process, the one `owner` is numbered in. */
export function claimText(owner: number): string {
	const ns = pidNamespace("self");
	return ns === undefined ? `${owner}\n` : `${owner}\n${ns}\n`;
}

/** The pid that claimed `token` for the agent, or undefined when none has (or the token is no token). */
export function claimedBy(agentDir: string, token: string): number | undefined {
	return TOKEN.test(token) ? claimant(join(agentDir, "claims", token)) : undefined;
}

/**
 * The claim on `token` for the agent: the pid, and the pid namespace it is numbered in when the claim says (Linux); or
 * undefined when none holds a pid (or the token is no token).
 */
export function claimHeld(agentDir: string, token: string): { readonly pid: number; readonly ns?: string } | undefined {
	if (!TOKEN.test(token)) return undefined;
	let text: string;
	try {
		text = readFileSync(join(agentDir, "claims", token), "utf8");
	} catch {
		return undefined;
	}
	const pid = pidIn(text);
	const ns = text.split("\n")[1]?.trim();
	return pid === undefined ? undefined : ns ? { pid, ns } : { pid };
}

/** Removes a claim its launcher made, once its tool has exited. */
export function releaseClaim(agentDir: string, token: string): void {
	if (TOKEN.test(token)) rmSync(join(agentDir, "claims", token), { force: true });
}

export function newToken(): string {
	return randomBytes(16).toString("hex");
}

/** Where a session of `agent` works: its folder when the session runs in it or below it, else the session's folder. */
export function workArea(agent: Pick<AgentConfig, "folder">, cwd: string): string {
	return agent.folder !== undefined && insideFolder(agent, cwd) ? agent.folder : resolve(cwd);
}

/** What a session whose ORRERY_AGENT was refused says, once. */
export function refusedNotice(pick: Refused): string {
	return pick.kind === "unknown"
		? `Orrery: ORRERY_AGENT names ${safeText(pick.name)}, which is not a configured agent; this session runs without memory.`
		: `Orrery: ORRERY_AGENT_TOKEN is not 32 lowercase hex digits, so this session is not ${safeText(pick.name)}; it runs without memory.`;
}
