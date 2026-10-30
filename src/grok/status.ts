/**
 * Grok Build's status row (spec 2026-10-29-grok-build-design, "Status row"): `orrery grok-status`, the command Orrery's
 * install names in Grok's config (`[ui.status_line]`, src/grok/install.ts). Grok runs it as a child of the session's own
 * grok process, with that process's launch environment and its status JSON on stdin (seen live, 1.0.70; in leader mode
 * too, where each session's own grok, not the leader, runs its row), at every state change and continuously while a
 * turn runs. It prints one line, which Grok shows under the prompt, or nothing, which shows no row:
 * - It speaks only for the agent ORRERY_AGENT names, and only when its token is claimed by this Grok, as a hook event
 *   finds it (src/codex/pick.ts grokAgent, never claiming or deciding): the memory server's start or SessionStart made
 *   that claim. The stdin session_id only chooses which of that agent's sessions the row describes, never the agent. No
 *   ORRERY_AGENT (a plain grok), a token that isn't this Grok's (made up, another process's, a Grok started inside
 *   another session), or input that isn't Grok's status JSON: nothing.
 * - Its state is what SessionStart (src/grok/hooks.ts) left for the session: this Grok's host record naming it, the mode
 *   its holder chose (written for this Grok), and the holder's heartbeat. `recording`; `not recording yet` (the holder
 *   hasn't chosen, or SessionStart may still be running: below); `read-only:` where the agent is open, or the holder's
 *   own reason; `not recording:` Orrery's SessionStart hasn't run for the session (nothing of it at all: Grok runs no
 *   hook switched off when the session started, and goes on without one that crashed or timed out before recording the
 *   session; Grok 1.0.70 quits rather than run an untrusted folder beside a hook file), Orrery's hooks are switched off in
 *   Grok's /hooks tab (its disabled-hooks file names SessionStart, UserPromptSubmit or Stop of Orrery's hook file: seen
 *   live, 1.0.70), this Grok records another of its sessions now (Grok keeps every session it ran open), or the recorder
 *   stopped.
 * - What SessionStart leaves can't tell one still running from one that never ran, and Grok runs the row beside it at
 *   every /new and /clear (seen live, 1.0.70: some 10 ms after the hook starts, before it records the session). So while
 *   SessionStart may still be running, within its timeout of the claim (made at the launch) or of the session's own
 *   start, the row says `not recording yet`.
 * - Under Grok's shared leader (leader mode), whose environment is its first client's, it names no agent and never says
 *   recording: when its host is the leader it says why; a session's own grok in leader mode holds no claim (its hooks and
 *   memory server run in the leader, which refuses them: src/grok/host.ts), so its row says nothing.
 * - It reads the agent's message count alone (src/memory/store.ts messageCount: no write lock, nothing of the memory
 *   loaded), and never prints a word of memory. It writes nothing of its own: no claim, decision or record. Reading this
 *   Grok's host record takes down a stale one it finds there, as every reader of the records does (src/agent/sessions.ts
 *   liveSession). Every error prints nothing: Grok paints a failing command's exit code into the row, so the CLI exits 0
 *   whatever happens (src/cli/main.ts grokStatusCommand).
 */

import type { AgentConfig, HarnessConfig } from "../agent/config.ts";
import { holderFresh, openElsewhere, readHolder } from "../agent/handover.ts";
import { readMessageCount } from "../agent/memory-read.ts";
import { AGENT_ENV, claimMadeAt, TOKEN_ENV } from "../agent/pick.ts";
import { liveSession } from "../agent/sessions.ts";
import { safeText } from "../agent/source-labels.ts";
import { type StatusState, statusText } from "../agent/status-text.ts";
import { validSession } from "../claude/paths.ts";
import { readMode } from "../claude/spool.ts";
import { grokAgent } from "../codex/pick.ts";
import { GROK_LEADER_REFUSAL, grokHostRefusal, grokPid } from "./host.ts";
import { GROK_SESSION_START_TIMEOUT, grokRecordingSwitchedOff } from "./install.ts";

/** What the row reads besides the config and the environment; tests pass their own. */
export interface GrokStatusContext {
	readonly config: HarnessConfig;
	readonly env: NodeJS.ProcessEnv;
	/** The row's clock (default now): a holder's heartbeat is fresh by it. */
	readonly now?: number;
	/** Grok's process, the token's owner (default src/grok/host.ts grokPid: this process's parent, past shells). */
	readonly grokPid?: number;
	/** The process grokPid started from: when grokPid is another, it must prove itself (src/codex/pick.ts). Undefined: no check. */
	readonly grokParent?: number;
	/** Whether a pid lives (default processAlive). */
	readonly alive?: (pid: number) => boolean;
	/** A process's command line (default processArgv): whether Grok's process is its shared leader. */
	readonly argvOf?: (pid: number) => readonly string[] | undefined;
}

/**
 * Nothing of Orrery's SessionStart for the session in this Grok, past its timeout, and no hook of Orrery's switched off
 * now: it was switched off when the session started and back on since (SessionStart doesn't fire again), or it crashed
 * or timed out before recording the session (Grok goes on without it). A resume, or a new session, runs it again.
 */
const NOT_STARTED = "Orrery's SessionStart hasn't run for this session; resume it or start a new one";
/** The row under Grok's shared leader, short for the row: src/grok/host.ts GROK_LEADER_REFUSAL says it at length. */
const LEADER = "leader mode; Orrery opens agents with --no-leader";
/** A hook Orrery records with is switched off in Grok's /hooks tab (src/grok/install.ts grokRecordingSwitchedOff). */
const SWITCHED_OFF = "Orrery's hooks are switched off in /hooks";
/** A session this Grok's SessionStart took before another (Grok keeps every session it ran open): its events are no memory. */
const ANOTHER_SESSION = "this Grok records another of its sessions now";
/** The session's holder chose recording, but no longer beats for it. */
const RECORDER_STOPPED = "Orrery's recorder stopped; a new session or a resume starts it again";

/** The row's line for Grok's status JSON `stdin`, or "" for no row (module doc). Never throws. */
export function grokStatus(stdin: string, ctx: GrokStatusContext): string {
	try {
		return rowOf(stdin, ctx) ?? "";
	} catch {
		// Nothing in Grok's row.
		return "";
	}
}

function rowOf(stdin: string, ctx: GrokStatusContext): string | undefined {
	// A plain grok: no agent's row.
	if ((ctx.env[AGENT_ENV]?.trim() ?? "") === "") return undefined;
	const pid = ctx.grokPid ?? grokPid();
	// A leader hosts no agent's session; a command line that can't be read can't tell, so nothing.
	const refused = grokHostRefusal(pid, ctx.argvOf);
	if (refused !== undefined) return refused === GROK_LEADER_REFUSAL ? `Orrery · not recording: ${LEADER}` : undefined;
	const session = sessionOf(stdin);
	if (session === undefined) return undefined;
	const pick = grokAgent(ctx.config, {
		env: ctx.env,
		pid,
		takeover: false,
		session,
		...(ctx.grokParent === undefined ? {} : { parent: ctx.grokParent }),
		...(ctx.alive === undefined ? {} : { alive: ctx.alive }),
	});
	if (pick.kind !== "agent") return undefined;
	const { agent } = pick;
	const now = ctx.now ?? Date.now();
	// SessionStart may still run: Grok gives it its timeout from the launch (whose claim of the token this is) or from the
	// session's own start.
	const young = (at: number | undefined) => at !== undefined && now - at >= 0 && now - at < GROK_SESSION_START_TIMEOUT * 1000;
	const starting = () => young(claimMadeAt(agent.dir, ctx.env[TOKEN_ENV] ?? "")) || young(sessionStartedAt(session));
	const state = stateOf(ctx.config, agent, session, pid, now, () => grokRecordingSwitchedOff(ctx.env), starting);
	return statusText({ name: agent.name, count: readMessageCount(agent), state });
}

/**
 * When a session began, from its id: Grok's session ids are UUIDv7 (seen live, 1.0.70), whose first 48 bits are the ms
 * it was made at. Undefined for any other id.
 */
function sessionStartedAt(session: string): number | undefined {
	const v7 = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.exec(session);
	return v7 === null ? undefined : Number.parseInt(`${v7[1]}${v7[2]}`, 16);
}

/** The session id in Grok's status JSON (`session_id`; a hook's `sessionId` too), when it is one the spool takes. */
function sessionOf(stdin: string): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdin);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const { session_id: snake, sessionId: camel } = parsed as { readonly session_id?: unknown; readonly sessionId?: unknown };
	const id = snake ?? camel;
	return validSession(id) ? id : undefined;
}

/**
 * Whether `agent`'s session `session` in Grok `pid` is recorded, and if not, why (module doc). `off`: whether a hook
 * Orrery records with is switched off in Grok's /hooks tab, which a session that would record, or whose SessionStart
 * hasn't run, says instead. `starting`: whether SessionStart may still be running, for a session it hasn't recorded.
 */
function stateOf(config: HarnessConfig, agent: AgentConfig, session: string, pid: number, now: number, off: () => boolean, starting: () => boolean): StatusState {
	const record = liveSession(config.dataDir, pid);
	const hosted = record?.tool === "grok" && record.agent === agent.name ? record.grokSession : undefined;
	// The mode this Grok's holder chose; one another Grok's run of the same session left is not this one's.
	const written = readMode(agent.dir, session);
	const mode = written?.claudePid === pid ? written : undefined;
	if (hosted !== session) {
		// A mode of this Grok's for the session, while its record names another of the agent's sessions: SessionStart took
		// that one since. With no record at all, the mode says nothing of another session.
		if (hosted !== undefined && mode !== undefined) return { notRecording: ANOTHER_SESSION };
		if (off()) return { notRecording: SWITCHED_OFF };
		return starting() ? "not recording yet" : { notRecording: NOT_STARTED };
	}
	if (mode?.mode === "read-only") {
		// The holder notes no reason when another writer has the agent here (older ones wrote "held"): where it is open.
		return { readOnly: mode.reason === undefined || mode.reason === "held" ? openElsewhere(agent.dir, "grok", now) : safeText(mode.reason) };
	}
	if (mode !== undefined) {
		const holder = readHolder(agent.dir);
		if (!holderFresh(holder, now) || holder.session !== session || holder.state !== "recording") return { notRecording: RECORDER_STOPPED };
	}
	if (off()) return { notRecording: SWITCHED_OFF };
	return mode === undefined ? "not recording yet" : "recording";
}
