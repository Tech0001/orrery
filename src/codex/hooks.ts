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
 * - UserPromptSubmit spools the prompt and Stop the turn's last reply, each with the turn's id; each returns quickly.
 *   The holder records them only once Codex's rollout confirms them (src/codex/rollout.ts).
 * - Events of Codex's subagents (agent_id) are not memory.
 * - SessionStart records Codex's process as the agent's session host, with the session's id (src/agent/sessions.ts:
 *   its sandboxed shell, in a pid namespace of its own, is known by CODEX_THREAD_ID), whether or not it records. A
 *   Codex started inside an agent's session (src/codex/pick.ts) opens no memory and records nothing: SessionStart says
 *   why (not again after a compaction), and no event spools.
 * - Their stdout is only their JSON answer (nothing at all when there is none), and they never put message contents on
 *   stderr or in a log.
 *
 * Codex runs a hook through a pipe, so the agent's own shell (or another tool's: Claude Code's Bash inherits a launch's
 * ORRERY_AGENT and token) can run this command with made-up input, and nothing about the caller tells them apart (spec
 * 2026-10-18-agent-permissions §3c). So no event changes what such a call could abuse:
 * - SessionStart takes a session only when this Codex holds its rollout open, found by the session's id under Codex's
 *   own folder, and the rollout says it is a person's own thread (not a spawned agent's), before it decides, claims or
 *   records anything: no other process can name a session. Moving this Codex to another session than its host record
 *   names takes a turn of that session running: Codex starts the turn before SessionStart (startup, /clear, /resume,
 *   /fork, `codex resume` and `codex fork` alike), so an earlier session it still holds open can't be named again. One
 *   this Codex's host record already names changes nothing (no record, no resume note, no new rollout place, the
 *   holder kept).
 * - UserPromptSubmit and Stop spool only for the session this Codex's host record names, and what they spool is held
 *   until the rollout confirms it, then dropped and counted if it doesn't.
 * - SessionEnd changes nothing: the host record and the process's decision go stale once Codex is gone, and the holder
 *   ends when Codex does.
 */

import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentConfig, HarnessConfig } from "../agent/config.ts";
import { holderFresh, openElsewhere, readHolder } from "../agent/handover.ts";
import { liveSession, nestedNotice, recordSession, type SessionRecord } from "../agent/sessions.ts";
import { safeText } from "../agent/source-labels.ts";
import { memorySection } from "../agent/view-text.ts";
import { noticeShownBefore, waitForMode } from "../claude/hooks.ts";
import { settleView } from "../claude/mod-view.ts";
import { summaryNotice, updateNotice } from "../claude/notices.ts";
import { holderLog, validSession } from "../claude/paths.ts";
import { readMode, type SessionMode, spoolEvent } from "../claude/spool.ts";
import { MemoryStore, MemoryView } from "../memory/index.ts";
import { codexAgent } from "./pick.ts";
import { codexSessionOf, recordCodexSession } from "./resume.ts";
import { codexHome, findRollout, holdsOpen, type OpenFile, readerStart, rolloutThread } from "./rollout.ts";

/** The events `orrery codex-hook` records (pre-tool-use is the guard, src/codex/guard.ts). */
export const CODEX_RECORD_EVENTS = ["session-start", "user-prompt-submit", "stop", "session-end"] as const;

/** The fields read from Codex's input; every one is checked before use. */
export interface CodexHookInput {
	readonly session_id?: unknown;
	readonly turn_id?: unknown;
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
	/** The home folder ~/.codex is in when CODEX_HOME is not set (default os.homedir()). */
	readonly home?: string;
	/** The files a process has open (default src/codex/rollout.ts openFiles); tests give their own. */
	readonly openFiles?: (pid: number) => readonly OpenFile[] | undefined;
	/** Codex's process (src/codex/host.ts): the token's owner and the holder's host. */
	readonly codexPid: number;
	/**
	 * The process codexPid() started from (the hook's parent): when codexPid is another, it was reached past processes
	 * named like shells, and must prove itself (src/codex/pick.ts). Undefined: no check (tests).
	 */
	readonly codexParent?: number;
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

/** The agent of an event of `session` (never the first decision: only SessionStart claims the token). */
function agentOf(ctx: CodexHookContext, session: string | undefined, takeover = false) {
	return codexAgent(ctx.config, {
		env: ctx.env,
		pid: ctx.codexPid,
		takeover,
		...(ctx.codexParent === undefined ? {} : { parent: ctx.codexParent }),
		...(session === undefined ? {} : { session }),
		...(ctx.alive === undefined ? {} : { alive: ctx.alive }),
	});
}

/** This Codex's host record when it names `session`, the session its SessionStart took as its own (module doc). */
function hostOf(ctx: CodexHookContext, session: string): SessionRecord | undefined {
	const record = liveSession(ctx.config.dataDir, ctx.codexPid);
	return record?.tool === "codex" && record.codexSession === session ? record : undefined;
}

/**
 * A main-thread event of this Codex's agent, in the session its host record names, which its holder does not run
 * read-only: its events are memory.
 */
function recordable(input: CodexHookInput, ctx: CodexHookContext): { readonly agent: AgentConfig; readonly session: string } | undefined {
	if (input.agent_id !== undefined || !validSession(input.session_id)) return undefined;
	const host = hostOf(ctx, input.session_id);
	if (host === undefined) return undefined;
	const pick = agentOf(ctx, input.session_id);
	if (pick.kind !== "agent" || pick.agent.name !== host.agent) return undefined;
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

/** The notices as an answer, for the turn's events (main thread, this Codex's agent, the session its host record names). */
function notices(input: CodexHookInput, ctx: CodexHookContext): object | undefined {
	if (input.agent_id !== undefined || !validSession(input.session_id)) return undefined;
	const host = hostOf(ctx, input.session_id);
	if (host === undefined) return undefined;
	const pick = agentOf(ctx, input.session_id);
	if (pick.kind !== "agent" || pick.agent.name !== host.agent) return undefined;
	const lines = noticeLines(pick.agent, input.session_id, ctx);
	return lines.length === 0 ? undefined : { systemMessage: lines.join("\n") };
}

/** The hook's turn id ("" when it has none: the holder then confirms nothing). */
const turnOf = (input: CodexHookInput) => (typeof input.turn_id === "string" ? input.turn_id : "");

/** UserPromptSubmit: spools the person's prompt. Codex sends its own commands (/compact, /model) to no hook. */
export function userPromptSubmit(input: CodexHookInput, ctx: CodexHookContext): object | undefined {
	const at = recordable(input, ctx);
	if (at !== undefined && typeof input.prompt === "string" && input.prompt.trim()) {
		spoolEvent(at.agent.dir, at.session, { kind: "prompt", at: Date.now(), claudePid: ctx.codexPid, text: input.prompt, host: "codex", turnId: turnOf(input) });
	}
	return notices(input, ctx);
}

/** Stop: spools the turn's last reply. */
export function stop(input: CodexHookInput, ctx: CodexHookContext): object | undefined {
	const at = recordable(input, ctx);
	const text = input.last_assistant_message;
	if (at !== undefined && typeof text === "string" && text.trim()) spoolEvent(at.agent.dir, at.session, { kind: "reply", at: Date.now(), claudePid: ctx.codexPid, text, host: "codex", turnId: turnOf(input) });
	return notices(input, ctx);
}

/**
 * SessionEnd: changes nothing (module doc). A made-up one would look the same, so the host record and the process's
 * decision stay until Codex is gone (they are stale then), and the holder ends when Codex does.
 */
export function sessionEnd(_input: CodexHookInput, _ctx: CodexHookContext): void {}

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

/** A Codex session's rollout, as this Codex holds it: the file and Codex's folder as they really are, the file Codex holds, where to read it from, and whether a turn of it runs. */
interface OwnRollout {
	readonly path: string;
	readonly home: string;
	readonly file: string;
	readonly offset: number;
	readonly running: boolean;
}

/**
 * Session `session` as this Codex's own: its rollout, found by its id under Codex's folder (never where the input says),
 * a person's own thread by its session_meta, held open by this Codex's process; else why it can't be confirmed.
 */
function ownRollout(session: string, ctx: CodexHookContext): OwnRollout | string {
	const home = codexHome(ctx.env, ctx.home ?? homedir());
	const path = findRollout(home, session);
	if (path === undefined) return `no rollout of it under ${home}`;
	const thread = rolloutThread(path);
	if (thread?.id !== session) return "its rollout doesn't say it is this session";
	if (thread.threadSource !== "user") return "it is no thread of the person's own, but a spawned agent's or another kind";
	const file = holdsOpen(ctx.codexPid, path, ctx.openFiles);
	if (file === "unknown") return "this system can't tell which files Codex has open";
	if (file === false) return "Codex doesn't have its rollout open";
	const start = readerStart(path);
	if (start === undefined) return "its rollout can't be read";
	try {
		return { path: realpathSync(path), home: realpathSync(home), file, ...start };
	} catch {
		return "its rollout can't be read";
	}
}

/**
 * SessionStart: the holder, then the status and, but at resume and fork, the memory section (module doc). A session
 * this Codex doesn't hold the rollout of, or a refused ORRERY_AGENT, only tells the person.
 */
export async function sessionStart(input: CodexHookInput, ctx: CodexHookContext): Promise<object | undefined> {
	if (input.agent_id !== undefined || !validSession(input.session_id)) return undefined;
	const session = input.session_id;
	const refuse = (why: string) => ({ systemMessage: `Orrery: can't confirm this is this Codex's own session (${safeText(why)}), so it opens no memory and records nothing.` });
	// Before anything is decided, claimed or recorded: is this session this Codex's own?
	const rollout = ownRollout(session, ctx);
	if (typeof rollout === "string") return refuse(rollout);
	// Moving this Codex to another session than its record names: Codex starts that session's turn before SessionStart.
	const recorded = liveSession(ctx.config.dataDir, ctx.codexPid);
	if (recorded?.tool === "codex" && recorded.codexSession !== session && !rollout.running) return refuse("Codex moves to a session with a turn of it running, and none is");
	// A session's start (or resume) may be the process's first asker: it decides, and may claim the token, unless the
	// memory server has already. A compaction or /clear never is (src/codex/pick.ts).
	const pick = agentOf(ctx, session, input.source === "startup" || input.source === "resume");
	if (pick.kind === "refused") return { systemMessage: pick.notice };
	// Started inside an agent's session: said to the person, once a session (not again after a compaction).
	if (pick.kind === "nested") return input.source === "compact" ? undefined : { systemMessage: nestedNotice({ agent: pick.outer, tool: pick.tool, via: "ancestry", dataDir: "" }) };
	const { agent } = pick;
	// The session this Codex's host record names already: nothing to record again.
	const current = hostOf(ctx, session)?.agent === agent.name;
	// This Codex hosts the agent's session, with this session's id, whether or not it records (spec
	// 2026-10-18-agent-permissions §2): what its shell starts runs inside the agent's session.
	const hosted = current || recordSession(ctx.config.dataDir, { agent: agent.name, tool: "codex", pid: ctx.codexPid, codexSession: session, config: ctx.config.file });
	// For the launcher's resume line once Codex ends (src/codex/resume.ts).
	if (codexSessionOf(agent.dir, ctx.codexPid) !== session) recordCodexSession(agent.dir, ctx.codexPid, session, ctx.alive);
	// The holder's cut-off: this session's events from now on belong to this run.
	const since = Date.now();
	// Where the holder reads this session's rollout from: a session new to this Codex's record only.
	if (hosted && !current) spoolEvent(agent.dir, session, { kind: "rollout", at: since, claudePid: ctx.codexPid, path: rollout.path, home: rollout.home, offset: rollout.offset, file: rollout.file });
	// At resume (and a fork) the session's history holds the view it had: another would sit beside it.
	const withView = input.source !== "resume" && input.source !== "fork";
	const warnings: string[] = [];
	let state = "recording";
	// Its own claim keeps this Codex the agent's; each SessionStart decides again, which is said once a session.
	if (pick.notRecorded !== undefined && input.source !== "compact") warnings.push(`Orrery: which agent this Codex is could not be recorded (${safeText(pick.notRecorded)}), so each SessionStart works it out again.`);
	if (!hosted) {
		// Its prompts are confirmed by the session the host record names: with none, nothing records.
		state = "read-only: this session is not recorded";
		warnings.push(`Orrery: this session could not be recorded as ${agent.name}'s, so tools and commands started from it are not known as ${agent.name}'s, and it isn't recorded.`);
	} else {
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
			if (held) warnings.push(`Orrery: ${agent.name} is ${openElsewhere(agent.dir, "codex")}; this session reads memory but is not recorded.`);
		}
		// A recording recorder's notices (memory kept aside, unsaved turns kept) are said once per recorder start, not again
		// after each compaction that keeps it.
		if (!held && typeof mode?.reason === "string" && !(mode.mode === "recording" && noticeShownBefore(agent.dir, session, mode.nonce))) warnings.push(safeText(mode.reason));
	}
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
