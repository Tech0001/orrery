/**
 * The Antigravity CLI's status row (spec 2026-11-20-antigravity-design): `orrery agy-status`, the command Orrery's
 * install names in agy's settings.json (`statusLine`, src/antigravity/install.ts). agy runs it with `sh -c` whenever its
 * state changes, at most every 300 ms, with its status JSON on stdin (agy 1.5.13's docs: `conversation_id`, `cwd`,
 * `agent_state`, …), and shows what it prints:
 * - It speaks only for the agent ORRERY_AGENT names with its token claimed by this agy (src/codex/pick.ts
 *   antigravityAgent, never claiming or deciding), both as the agy process was started with them (launchedEnv): one
 *   whose own names another agent or token gets nothing, and a plain agy no row. The status JSON's conversation_id only
 *   chooses which conversation the row describes.
 * - Its state: `recording` when this agy's host record names the conversation and its recorder chose to record and still
 *   beats; `read-only:` where the agent is open; `not recording yet` before the first model call of a conversation
 *   (Orrery takes a conversation at its PreInvocation hook); `not recording:` when the recorder stopped, or this agy
 *   records another of its conversations.
 * - It reads the agent's message count alone, never a word of memory, and writes nothing. Every error prints nothing.
 */

import type { AgentConfig, HarnessConfig } from "../agent/config.ts";
import { holderFresh, openElsewhere, readHolder } from "../agent/handover.ts";
import { readMessageCount } from "../agent/memory-read.ts";
import { AGENT_ENV } from "../agent/pick.ts";
import { liveSession } from "../agent/sessions.ts";
import { safeText } from "../agent/source-labels.ts";
import { type StatusState, statusText } from "../agent/status-text.ts";
import { readMode } from "../claude/spool.ts";
import { antigravityAgent, LAUNCH_VARIABLES, launchedEnv, startEnvOf } from "../codex/pick.ts";
import { agyPid, validConversation } from "./host.ts";

/** What the row reads besides the config and the environment; tests pass their own. */
export interface AgyStatusContext {
	readonly config: HarnessConfig;
	readonly env: NodeJS.ProcessEnv;
	readonly now?: number;
	readonly agyPid?: number;
	readonly agyParent?: number;
	readonly alive?: (pid: number) => boolean;
	readonly envOf?: (pid: number, names: readonly string[]) => Readonly<Record<string, string>> | undefined;
}

const ANOTHER = "this Antigravity records another of its conversations now";
const RECORDER_STOPPED = "Orrery's recorder stopped; a new conversation or a resume starts it again";

/** The row's line for agy's status JSON `stdin`, or "" for no row (module doc). Never throws. */
export function agyStatus(stdin: string, ctx: AgyStatusContext): string {
	try {
		return rowOf(stdin, ctx) ?? "";
	} catch {
		return "";
	}
}

/** The conversation id in agy's status JSON. */
function conversationOf(stdin: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(stdin);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		const { conversation_id: id, session_id: alias } = parsed as { readonly conversation_id?: unknown; readonly session_id?: unknown };
		const found = id ?? alias;
		return validConversation(found) ? found : undefined;
	} catch {
		return undefined;
	}
}

function rowOf(stdin: string, ctx: AgyStatusContext): string | undefined {
	if ((ctx.env[AGENT_ENV]?.trim() ?? "") === "") return undefined;
	const pid = ctx.agyPid ?? agyPid();
	if (pid === undefined) return undefined;
	const launched = launchedEnv("antigravity", ctx.env, (ctx.envOf ?? startEnvOf)(pid, LAUNCH_VARIABLES));
	if ("refused" in launched) return undefined;
	const conversation = conversationOf(stdin);
	const pick = antigravityAgent(ctx.config, {
		env: launched.env,
		pid,
		takeover: false,
		...(conversation === undefined ? {} : { session: conversation }),
		...(ctx.agyParent === undefined ? {} : { parent: ctx.agyParent }),
		...(ctx.alive === undefined ? {} : { alive: ctx.alive }),
	});
	if (pick.kind !== "agent") return undefined;
	const now = ctx.now ?? Date.now();
	return statusText({ name: pick.agent.name, count: readMessageCount(pick.agent), state: conversation === undefined ? "not recording yet" : stateOf(ctx.config, pick.agent, conversation, pid, now) });
}

/** Whether `agent`'s conversation in agy `pid` is recorded, and if not, why (module doc). */
function stateOf(config: HarnessConfig, agent: AgentConfig, conversation: string, pid: number, now: number): StatusState {
	const record = liveSession(config.dataDir, pid);
	const hosted = record?.tool === "antigravity" && record.agent === agent.name ? record.antigravitySession : undefined;
	const written = readMode(agent.dir, conversation);
	const mode = written?.claudePid === pid ? written : undefined;
	if (hosted !== conversation) return hosted !== undefined ? { notRecording: ANOTHER } : "not recording yet";
	if (mode?.mode === "read-only") return { readOnly: mode.reason === undefined || mode.reason === "held" ? openElsewhere(agent.dir, "antigravity", now) : safeText(mode.reason) };
	if (mode === undefined) return "not recording yet";
	const holder = readHolder(agent.dir);
	if (!holderFresh(holder, now) || holder.session !== conversation || holder.state !== "recording") return { notRecording: RECORDER_STOPPED };
	return "recording";
}
