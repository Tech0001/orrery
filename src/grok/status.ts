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
 *   hasn't chosen); `read-only:` where the agent is open, or the holder's own reason; `not recording:` Grok didn't run
 *   Orrery's hooks (nothing of the session at all: the folder isn't trusted), Orrery's hooks are switched off in Grok's
 *   /hooks tab (its disabled-hooks file names SessionStart, UserPromptSubmit or Stop of Orrery's hook file: seen live,
 *   1.0.70), this Grok records another of its sessions now (Grok keeps every session it ran open), or the recorder
 *   stopped.
 * - Under Grok's shared leader (leader mode), whose environment is its first client's, it names no agent and never says
 *   recording: when its host is the leader it says why; a session's own grok in leader mode holds no claim (its hooks and
 *   memory server run in the leader, which refuses them: src/grok/host.ts), so its row says nothing.
 * - It reads the agent's message count from a read-only snapshot (src/agent/memory-read.ts), takes no write lock, writes
 *   nothing, and never prints a word of memory. Every error prints nothing: Grok paints a failing command's exit code
 *   into the row, so the CLI exits 0 whatever happens (src/cli/main.ts grokStatusCommand).
 */

import type { AgentConfig, HarnessConfig } from "../agent/config.ts";
import { holderFresh, openElsewhere, readHolder } from "../agent/handover.ts";
import { readMemory } from "../agent/memory-read.ts";
import { AGENT_ENV } from "../agent/pick.ts";
import { liveSession } from "../agent/sessions.ts";
import { safeText } from "../agent/source-labels.ts";
import { type StatusState, statusText } from "../agent/status-text.ts";
import { validSession } from "../claude/paths.ts";
import { readMode } from "../claude/spool.ts";
import { grokAgent } from "../codex/pick.ts";
import { GROK_LEADER_REFUSAL, grokHostRefusal, grokPid } from "./host.ts";
import { grokRecordingSwitchedOff } from "./install.ts";

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

/** No SessionStart of Orrery's ran for the session in this Grok, and no hook of Orrery's is switched off: an untrusted folder. */
const HOOKS_NEVER_RAN = "Grok didn't run Orrery's hooks; trust this folder (/hooks-trust)";
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
	if (refused !== undefined) return refused === GROK_LEADER_REFUSAL ? `Orrery · not recording: ${GROK_LEADER_REFUSAL}` : undefined;
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
	const state = stateOf(ctx.config, agent, session, pid, ctx.now ?? Date.now(), () => grokRecordingSwitchedOff(ctx.env));
	return statusText({ name: agent.name, count: readMemory(agent, false).messages, state });
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
 * Orrery records with is switched off in Grok's /hooks tab, which a session that would record, or whose hooks never ran,
 * says instead.
 */
function stateOf(config: HarnessConfig, agent: AgentConfig, session: string, pid: number, now: number, off: () => boolean): StatusState {
	const record = liveSession(config.dataDir, pid);
	const hosted = record?.tool === "grok" && record.agent === agent.name ? record.grokSession : undefined;
	// The mode this Grok's holder chose; one another Grok's run of the same session left is not this one's.
	const written = readMode(agent.dir, session);
	const mode = written?.claudePid === pid ? written : undefined;
	if (hosted !== session) return { notRecording: mode !== undefined ? ANOTHER_SESSION : off() ? SWITCHED_OFF : HOOKS_NEVER_RAN };
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
