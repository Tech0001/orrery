/**
 * Codex's hooks (spec 2026-10-16-codex-design, "Hooks"), run as `orrery codex-hook <event>` with the hook's JSON on
 * stdin. They are Claude Code's (src/claude/hooks.ts) for Codex, sharing its recorder (the holder), spool and notices:
 * - The agent is the one ORRERY_AGENT names, with its token, for Codex's own process (src/codex/pick.ts, host.ts); no
 *   folder decides. A refused one gets a notice at SessionStart and records nothing.
 * - SessionStart, at startup, /clear and after a compaction: starts this session's holder, or keeps the one already
 *   recording it, and returns the status line and the memory section (src/agent/view-text.ts, "codex") as
 *   additionalContext, which reaches the model as developer context, and the status line and any update or summary
 *   notices as systemMessage, which reaches the person. Before a compaction's view it waits a while for this session's
 *   spool and the summaries (as the Claude Code mod does). At resume (and a fork) the session's history already holds a
 *   view: the holder is started all the same, and only the status is said.
 * - UserPromptSubmit spools the prompt, Stop the turn's last reply, SessionEnd the session's end; each returns quickly.
 * - Events of Codex's subagents (agent_id) are not memory.
 * - Their stdout is only their JSON answer (nothing at all when there is none), and they never put message contents on
 *   stderr or in a log.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig, HarnessConfig } from "../agent/config.ts";
import { holderFresh, readHolder } from "../agent/handover.ts";
import { safeText } from "../agent/source-labels.ts";
import { memorySection } from "../agent/view-text.ts";
import { noticeShownBefore, waitForMode } from "../claude/hooks.ts";
import { settleView } from "../claude/mod-view.ts";
import { summaryNotice, updateNotice } from "../claude/notices.ts";
import { holderLog, validSession } from "../claude/paths.ts";
import { readMode, type SessionMode, spoolEvent } from "../claude/spool.ts";
import { MemoryStore, MemoryView } from "../memory/index.ts";
import { codexAgent } from "./pick.ts";

/** The events `orrery codex-hook` records (pre-tool-use is the guard, src/codex/guard.ts). */
export const CODEX_RECORD_EVENTS = ["session-start", "user-prompt-submit", "stop", "session-end"] as const;

/** The fields read from Codex's input; every one is checked before use. */
export interface CodexHookInput {
	readonly session_id?: unknown;
	readonly agent_id?: unknown;
	readonly source?: unknown;
	readonly prompt?: unknown;
	readonly last_assistant_message?: unknown;
	readonly reason?: unknown;
}

/** What a hook runs with: the config, the environment, Codex's process and how to start a holder. */
export interface CodexHookContext {
	readonly config: HarnessConfig;
	readonly env: NodeJS.ProcessEnv;
	/** Codex's process (src/codex/host.ts): the token's owner and the holder's host. */
	readonly codexPid: number;
	/** Starts the session's holder (spawnHolder for Codex); tests start one in-process or answer for it. */
	readonly startHolder: (agent: AgentConfig, session: string, nonce: string, since: number) => void;
	/** How long SessionStart waits for the holder to choose recording or read-only (default 8 s). */
	readonly modeWaitMs?: number;
	/** How long SessionStart after a compaction waits for the spool and the summaries (default 15 s: Codex gives the hook 30, and a holder may need starting first). */
	readonly compactWaitMs?: number;
	/** Whether a pid lives, for the token's claim (default processAlive); tests pass their own. */
	readonly alive?: (pid: number) => boolean;
	/** Whether hooks show Orrery's update notices (src/claude/notices.ts updateNotice); the CLI turns them on. */
	readonly updateNotices?: boolean;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The agent of an event (never the first decision: only SessionStart claims the token). */
function agentOf(ctx: CodexHookContext, takeover = false) {
	return codexAgent(ctx.config, { env: ctx.env, pid: ctx.codexPid, takeover, ...(ctx.alive === undefined ? {} : { alive: ctx.alive }) });
}

/** A main-thread event of this Codex's agent, in a session its holder does not run read-only: its events are memory. */
function recordable(input: CodexHookInput, ctx: CodexHookContext): { readonly agent: AgentConfig; readonly session: string } | undefined {
	if (input.agent_id !== undefined || !validSession(input.session_id)) return undefined;
	const pick = agentOf(ctx);
	if (pick.kind !== "agent") return undefined;
	if (readMode(pick.agent.dir, input.session_id)?.mode === "read-only") return undefined;
	return { agent: pick.agent, session: input.session_id };
}

/** How a Codex session switches the summary model: Orrery's command (Codex has no command of Orrery's). */
const compactorCommand = (agent: AgentConfig) => `orrery compactor ${agent.name}`;

/** This session's summary and update notices, one per line, never an error: a hook that fails must not disturb the turn. */
function noticeLines(agent: AgentConfig, session: string, ctx: CodexHookContext): string[] {
	const lines: string[] = [];
	const add = (read: () => string | undefined) => {
		try {
			const message = read();
			if (message !== undefined) lines.push(message);
		} catch {
			// left out
		}
	};
	add(() => summaryNotice(agent, session, compactorCommand(agent)));
	if (ctx.updateNotices === true) add(() => updateNotice(agent, session, ctx.env, ctx.config.updates.check));
	return lines;
}

/** The notices as an answer, for the turn's events (main thread, this Codex's agent). */
function notices(input: CodexHookInput, ctx: CodexHookContext): object | undefined {
	if (input.agent_id !== undefined || !validSession(input.session_id)) return undefined;
	const pick = agentOf(ctx);
	if (pick.kind !== "agent") return undefined;
	const lines = noticeLines(pick.agent, input.session_id, ctx);
	return lines.length === 0 ? undefined : { systemMessage: lines.join("\n") };
}

/** UserPromptSubmit: spools the person's prompt. Codex sends its own commands (/compact, /model) to no hook. */
export function userPromptSubmit(input: CodexHookInput, ctx: CodexHookContext): object | undefined {
	const at = recordable(input, ctx);
	if (at !== undefined && typeof input.prompt === "string" && input.prompt.trim()) {
		spoolEvent(at.agent.dir, at.session, { kind: "prompt", at: Date.now(), claudePid: ctx.codexPid, text: input.prompt });
	}
	return notices(input, ctx);
}

/** Stop: spools the turn's last reply. */
export function stop(input: CodexHookInput, ctx: CodexHookContext): object | undefined {
	const at = recordable(input, ctx);
	const text = input.last_assistant_message;
	if (at !== undefined && typeof text === "string" && text.trim()) spoolEvent(at.agent.dir, at.session, { kind: "reply", at: Date.now(), claudePid: ctx.codexPid, text });
	return notices(input, ctx);
}

/** SessionEnd: only drops an "end" in the spool (Codex gives the hook at most 3 s); the holder finishes the rest. */
export function sessionEnd(input: CodexHookInput, ctx: CodexHookContext): void {
	const at = recordable(input, ctx);
	if (at !== undefined) spoolEvent(at.agent.dir, at.session, { kind: "end", at: Date.now(), claudePid: ctx.codexPid, ...(typeof input.reason === "string" ? { reason: input.reason } : {}) });
}

/** The agent's message count and, when `withSection`, its memory section, read from a read-only snapshot; none yet: {}. */
function readMemory(agent: AgentConfig, withSection: boolean): { readonly messages?: number; readonly section?: string } {
	const file = join(agent.dir, "memory.sqlite");
	if (!existsSync(file)) return {};
	const store = MemoryStore.openReadOnly(file);
	try {
		return { messages: store.root.length, ...(withSection ? { section: memorySection(new MemoryView(store, agent.memory.viewBytes), "codex") } : {}) };
	} finally {
		store.close();
	}
}

/**
 * SessionStart: the holder, then the status and, but at resume and fork, the memory section (module doc). A refused
 * ORRERY_AGENT only tells the person.
 */
export async function sessionStart(input: CodexHookInput, ctx: CodexHookContext): Promise<object | undefined> {
	if (input.agent_id !== undefined || !validSession(input.session_id)) return undefined;
	// The session's start claims the token for this Codex, unless the memory server has already.
	const pick = agentOf(ctx, true);
	if (pick.kind === "refused") return { systemMessage: pick.notice };
	const { agent } = pick;
	const session = input.session_id;
	// The holder's cut-off: this session's events from now on belong to this run.
	const since = Date.now();
	// At resume (and a fork) the session's history holds the view it had: another would sit beside it.
	const withView = input.source !== "resume" && input.source !== "fork";
	const warnings: string[] = [];
	let state = "recording";
	const holder = readHolder(agent.dir);
	let mode: SessionMode | undefined;
	if (holderFresh(holder) && holder.session === session && holder.state === "recording") mode = readMode(agent.dir, session);
	else {
		const nonce = randomUUID();
		ctx.startHolder(agent, session, nonce, since);
		mode = await waitForMode(agent.dir, session, nonce, ctx.modeWaitMs ?? 8000);
	}
	// The holder notes no reason when the agent is held locally (pi, or another session).
	const held = mode?.mode === "read-only" && (mode.reason === undefined || mode.reason === "held");
	if (mode === undefined) {
		state = "not recording yet";
		warnings.push(`Orrery: ${agent.name}'s recorder did not answer in time; see ${holderLog(agent.dir)}.`);
	} else if (mode.mode === "read-only") {
		state = "read-only: this session is not recorded";
		if (held) warnings.push(`Orrery: ${agent.name} is open elsewhere (pi, Claude Code, or another Codex session); this session reads memory but is not recorded.`);
	}
	// A recording recorder's notices (memory kept aside, unsaved turns kept) are said once per recorder start, not again
	// after each compaction that keeps it.
	if (!held && typeof mode?.reason === "string" && !(mode.mode === "recording" && noticeShownBefore(agent.dir, session, mode.nonce))) warnings.push(safeText(mode.reason));
	if (withView && input.source === "compact") {
		try {
			await settleView(agent, session, { waitMs: ctx.compactWaitMs ?? 15_000 });
		} catch {
			// the view as it is
		}
	}
	let memory: { readonly messages?: number; readonly section?: string } = {};
	try {
		memory = readMemory(agent, withView);
	} catch (error) {
		warnings.push(`Orrery: ${agent.name}'s memory could not be read: ${safeText(errorText(error))}`);
	}
	const status = `Orrery · ${agent.name} · ${memory.messages === undefined ? "no memory yet" : `${memory.messages} msgs`} · ${state}`;
	const head = [status, ...warnings].join("\n");
	// For the person only (systemMessage), never the model's context.
	const shown = [head, ...noticeLines(agent, session, ctx)].join("\n");
	return {
		systemMessage: shown,
		...(withView ? { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: memory.section === undefined ? head : `${head}\n\n${memory.section}` } } : {}),
	};
}

/** The hook's stdout for `event` (an empty string: nothing to say). An event it does not record throws. */
export async function runCodexHook(event: string, stdin: string, ctx: CodexHookContext): Promise<string> {
	if (!(CODEX_RECORD_EVENTS as readonly string[]).includes(event)) throw new Error(`unknown hook event ${event}; expected one of ${[...CODEX_RECORD_EVENTS, "pre-tool-use"].join(", ")}`);
	let input: CodexHookInput;
	try {
		const parsed = JSON.parse(stdin) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "";
		input = parsed as CodexHookInput;
	} catch {
		// Never pass on the parser's message: it quotes the input, which holds the person's words.
		return "";
	}
	let output: object | undefined;
	switch (event) {
		case "session-start":
			output = await sessionStart(input, ctx);
			break;
		case "user-prompt-submit":
			output = userPromptSubmit(input, ctx);
			break;
		case "stop":
			output = stop(input, ctx);
			break;
		case "session-end":
			sessionEnd(input, ctx);
			break;
	}
	return output === undefined ? "" : JSON.stringify(output);
}

/** What SessionStart says when Orrery's config cannot be read: the session runs as plain Codex. */
export function configNotice(why: string): string {
	return JSON.stringify({ systemMessage: `Orrery: the config could not be read (${safeText(why)}); this session runs without memory.` });
}
