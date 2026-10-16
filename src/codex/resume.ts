/**
 * Resuming an agent's Codex session the Orrery way. Codex says at its end "codex resume <id>", which reopens the chat as
 * plain Codex (no memory, no guard), so `orrery agent --tool codex` follows it with the line that resumes it as the
 * agent. Which session that is: Codex's session-start hook notes, per Codex process (the token's owner), the session
 * it is on (recordCodexSession), in <agent dir>/claude/codex-sessions.json; the launcher reads it for the Codex that
 * claimed its token. The holder and the spool forget a session moments after it ends, so they can't say.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivate } from "../agent/private-file.ts";
import { processAlive } from "../agent/process.ts";
import { validSession } from "../claude/paths.ts";
import { shellWords } from "./launch.ts";

/** How many Codex processes the file remembers at most (the live ones; one per open session of the agent). */
const KEPT = 20;

const file = (agentDir: string) => join(agentDir, "claude", "codex-sessions.json");

type Sessions = Record<string, { readonly session: string; readonly at: number }>;

function readSessions(agentDir: string): Sessions {
	try {
		const data: unknown = JSON.parse(readFileSync(file(agentDir), "utf8"));
		return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Sessions) : {};
	} catch {
		return {};
	}
}

/**
 * Notes that Codex process `pid` is on `session` now, keeping the entries of live processes only. Never throws: a note
 * that can't be written only costs the launcher the session's id (it then says `resume --last`).
 */
export function recordCodexSession(agentDir: string, pid: number, session: string, alive: (pid: number) => boolean = processAlive): void {
	try {
		const kept = Object.entries(readSessions(agentDir)).filter(([key]) => key !== String(pid) && alive(Number(key)));
		const entries = [...kept.slice(-(KEPT - 1)), [String(pid), { session, at: Date.now() }] as const];
		writePrivate(file(agentDir), `${JSON.stringify(Object.fromEntries(entries))}\n`);
	} catch {
		// not noted
	}
}

/** The session Codex process `pid` last started or resumed, or undefined. Only a valid session id is ever given. */
export function codexSessionOf(agentDir: string, pid: number): string | undefined {
	const session = readSessions(agentDir)[String(pid)]?.session;
	return validSession(session) ? session : undefined;
}

/** Codex 0.162.1's subcommands that start no session of the agent (its others are exec, review, resume and fork). */
const NO_SESSION: ReadonlySet<string> = new Set([
	"agents", "login", "logout", "mcp", "plugin", "app-server", "remote-control", "completion", "update", "doctor", "sandbox", "debug",
	"apply", "a", "queue", "archive", "delete", "migrate-rollouts", "unarchive", "cloud", "exec-server", "features", "help",
]);

/**
 * The line `orrery agent` says after Codex ends: how to resume the session as the agent. When this Codex noted no
 * session, `resume --last`, but only after a launch that starts one (`args`: the person's arguments to Codex: none, a
 * prompt, options, or a session subcommand). Undefined when no Codex ever claimed the agent's token (`claimedBy`).
 */
export function codexResumeLine(agent: { readonly name: string; readonly dir: string }, claimedBy: number | undefined, args: readonly string[] = []): string | undefined {
	if (claimedBy === undefined) return undefined;
	const session = codexSessionOf(agent.dir, claimedBy);
	if (session === undefined && args[0] !== undefined && NO_SESSION.has(args[0])) return undefined;
	return `To continue it as ${agent.name}, with its memory and the guard: orrery agent ${shellWords([agent.name])} --tool codex -- resume ${session ?? "--last"}`;
}
