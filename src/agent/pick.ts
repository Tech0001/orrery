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
 *    it can't judge the claim (src/agent/sessions.ts), and never takes it for dead (holding); then the owner's start
 *    time when it can be read, so a claim whose pid was reused is a dead process's. Shorter claims, an older version's,
 *    read as before.
 * 2. The agent whose folder holds the folder (agentForCwd).
 * 3. None.
 * Node built-ins and relative imports only: pi and OMP load this file.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type HarnessConfig, insideFolder, type AgentConfig, agentForCwd } from "./config.ts";
import { beingMade, publish, removeStale, stray, temporaryOf } from "./exclusive.ts";
import { readPrivate } from "./private-file.ts";
import { pidNamespace, processAlive, processStart } from "./process.ts";
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

export type Claim = { readonly pid: number; readonly ns?: string; readonly start?: string };

/** The most of a claim file read: a pid, a namespace's name and a start time are a few dozen bytes. */
const CLAIM_MAX = 256;

/**
 * A claim file's pid and, when its second and third lines say (claimText), the pid namespace (Linux) and the owner's
 * start time; "none" when it holds no pid (gone, empty, or not a pid); "unreadable" when it is no regular file of this
 * user's (a FIFO or a link put in its place), which is read without waiting or following (readPrivate) and which nobody
 * here can judge.
 */
function readClaim(file: string): Claim | "none" | "unreadable" {
	let text: string;
	try {
		text = readPrivate(file, CLAIM_MAX);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "none" : "unreadable";
	}
	const pid = Number.parseInt(text, 10);
	if (!Number.isInteger(pid) || pid < 1) return "none";
	const [, ns, start] = text.split("\n").map((line) => line.trim());
	return { pid, ...(ns ? { ns } : {}), ...(start ? { start } : {}) };
}

/**
 * Whether a claim's pid now names another process than the one that claimed: the claim's start time and the pid's now
 * (processStart, src/agent/process.ts) are both known, and differ (the pid was reused). Either unknown: no, and the claim
 * is judged by pid and namespace. src/agent/sessions.ts judges a claim's marker the same way.
 */
export function reused(claim: Claim): boolean {
	if (claim.start === undefined) return false;
	const now = processStart(claim.pid);
	return now !== undefined && now !== claim.start;
}

/** A claim file's pid and namespace, or undefined when it holds none, or can't be read. */
function claimIn(file: string): Claim | undefined {
	const claim = readClaim(file);
	return typeof claim === "object" ? claim : undefined;
}

/** The pid a claim file holds, or undefined when it holds none. */
const claimant = (file: string): number | undefined => claimIn(file)?.pid;

/**
 * Whether a claim was made in another pid namespace than this process's, or this one's can't be read to tell: its pid
 * names another process here, or none, and kill(0) can't judge its owner. A one-line claim (an older version's, or
 * macOS's) names no namespace and is judged as before.
 */
function foreign(claim: Claim): boolean {
	if (claim.ns === undefined) return false;
	const here = pidNamespace("self");
	return here === undefined || claim.ns !== here;
}

/** Whether the claim in `file` is `owner`'s, made in this pid namespace, and not by a process that had its pid before. */
function heldBy(file: string, owner: number): boolean {
	const claim = claimIn(file);
	return claim !== undefined && claim.pid === owner && !foreign(claim) && !reused(claim);
}

/**
 * What a claim file holds: the live process it names; "making" when it names none yet but is young (publish's fallback
 * is still writing it; src/agent/exclusive.ts); "unsure" when it was made in another pid namespace (foreign), or is no
 * regular file of this user's (readClaim); else "dead": its process is gone, or its pid now names a process started at
 * another time than the claim says (reused), or it names no pid and is old (a crash's leftover, or an older version's).
 * One rule for pruning and for taking a token over. An unsure claim is never dead:
 * from here it is neither pruned nor taken over, so a tool started in another namespace (`unshare -p` from an agent's
 * shell) can't take a live session's token, and falls through to its folder (src/agent/sessions.ts finds it inside a
 * session). The cost: a really dead claim from another namespace stays until its launcher releases it, or a claimer in
 * that namespace prunes it; tokens are per launch, so no other launch needs it.
 */
function holding(file: string, alive: (pid: number) => boolean): number | "making" | "unsure" | "dead" {
	const claim = readClaim(file);
	if (claim === "unreadable") return "unsure";
	if (claim !== "none") return foreign(claim) ? "unsure" : alive(claim.pid) && !reused(claim) ? claim.pid : "dead";
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
	if (heldBy(file, owner)) return true;
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
		return heldBy(file, owner);
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

/**
 * What a claim by `owner` holds: its pid; then on Linux the pid namespace of this process, the one `owner` is numbered
 * in (an empty line elsewhere); then `owner`'s start time, when it can be read. Lines with nothing after them are left out.
 */
export function claimText(owner: number): string {
	const ns = pidNamespace("self");
	const start = processStart(owner);
	if (start !== undefined) return `${owner}\n${ns ?? ""}\n${start}\n`;
	return ns === undefined ? `${owner}\n` : `${owner}\n${ns}\n`;
}

/** The pid that claimed `token` for the agent, or undefined when none has (or the token is no token). */
export function claimedBy(agentDir: string, token: string): number | undefined {
	return TOKEN.test(token) ? claimant(join(agentDir, "claims", token)) : undefined;
}

/**
 * Whether a claim on `token` for the agent stands (holding): a live process's, one being made, or one that can't be
 * judged from here. False when there is none, or the one there is dead (the token is no token: false).
 */
export function tokenHeld(agentDir: string, token: string, alive: (pid: number) => boolean = processAlive): boolean {
	return TOKEN.test(token) && holding(join(agentDir, "claims", token), alive) !== "dead";
}

/**
 * The claim on `token` for the agent: the pid, and the pid namespace it is numbered in when the claim says (Linux);
 * "unreadable" when something other than a regular file of this user's is in its place (readClaim); or undefined when
 * none holds a pid (or the token is no token).
 */
export function claimHeld(agentDir: string, token: string): Claim | "unreadable" | undefined {
	if (!TOKEN.test(token)) return undefined;
	const claim = readClaim(join(agentDir, "claims", token));
	return claim === "none" ? undefined : claim;
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
