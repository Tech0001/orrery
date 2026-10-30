/**
 * Grok Build's hooks (spec 2026-10-29-grok-build-design, "Hooks"), run as `orrery grok-hook <event>` with the hook's
 * JSON on stdin (camelCase, with Claude Code's snake_case aliases). They are Codex's (src/codex/hooks.ts) for Grok,
 * sharing its recorder (the holder), spool, notices and agent pick:
 * - The agent is the one ORRERY_AGENT names, with its token, for Grok's own process (src/codex/pick.ts grokAgent,
 *   src/grok/host.ts); no folder decides. A refused one gets a notice at SessionStart and records nothing.
 * - Orrery's Grok hooks are global, so they run in every Grok session. One with no ORRERY_AGENT is a plain grok: it
 *   records nothing and decides nothing, and its SessionStart says only, in an agent's folder, how to open that agent
 *   (`orrery agent <Name> --tool grok`); elsewhere it prints nothing.
 * - SessionStart (source `new`, for a start, /new and /clear; `load`, for a resume): starts this session's holder, or
 *   keeps the one already recording it, and answers the status line and any update or summary notices as a top-level
 *   systemMessage. Grok's SessionStart can't give the model context: the memory came with the launch (src/grok/launch.ts).
 *   It also records Grok's process as the agent's session host, with the session's id. A Grok started inside an agent's
 *   session (src/codex/pick.ts) opens no memory and records nothing: SessionStart says why, and no event spools.
 * - UserPromptSubmit spools the prompt and Stop (`reason` "end_turn") the turn's last reply, each with the turn's
 *   promptId; each prints nothing. The separate Stop at a session's end (`channel_closed`, `shutdown`) is no turn.
 *   StopCancelled spools nothing: the interrupted turn's prompt was spooled, and its reply never came. The holder
 *   records each only once Grok's session log confirms it (src/grok/log.ts), and records the log's words.
 * - An event of a session this Grok's host record doesn't name (a subagent's own session: Grok runs UserPromptSubmit
 *   there too, with the subagent's sessionId) is not memory: it is spooled with no words or promptId into the recorded
 *   session, for the holder to drop and count.
 * - SessionEnd changes nothing: the host record and the process's decision go stale once Grok is gone, and the holder
 *   ends when Grok does (a made-up SessionEnd would look the same).
 * - PreToolUse is the guard (src/grok/guard.ts runGrokGuard), which answers by its exit code (src/cli/main.ts
 *   grokGuardHook), not here: runGrokHook says nothing for it.
 * - Grok's shared leader (leader mode, which Orrery opens agents without: src/grok/launch.ts grokArgs) runs every
 *   session's hooks in one process, with its first client's environment, so one session's agent can't be told from
 *   another's there: a hook whose host is the leader, or one whose command line can't be read (src/grok/host.ts
 *   grokHostRefusal), decides, claims, records and spools nothing, whatever its environment names; SessionStart in a Grok
 *   opened as an agent says why. The guard still judges there, by Orrery's own rules (src/grok/guard.ts).
 * - Their stdout is only their JSON answer (nothing at all when there is none), and they never put message contents on
 *   stderr or in a log.
 *
 * Grok runs a hook through a pipe, so the agent's own shell can run this command with made-up input and its own
 * environment (GROK_HOME, HOME). So no event changes what such a call could abuse:
 * - SessionStart takes a session only when it is Grok's own, all before it decides, claims or records anything. What it
 *   checks, never taking a folder from the hook's own environment or its input:
 *   - Grok's folder is the one the grok process was started with: its own environment's GROK_HOME, else its HOME's
 *     .grok, as it really is (Linux /proc/<pid>/environ; macOS ps -E, its arguments left out). An environment that
 *     can't be read refuses.
 *   - The grok process has the session's events.jsonl open under that folder, at sessions/<the folder it runs in>/
 *     <session>/: exactly one such descriptor, open for writing, as Grok holds its record. A tool of Grok's reading a
 *     file the agent made holds it too, but read-only, and under another folder. A mode this system doesn't tell refuses.
 *   - That file is at its own place with no link on the way or at it (on Linux the very file Grok has open), and the
 *     log beside it is no link either.
 *   - Its summary.json names it as a person's own session (not a subagent's).
 *   The log read is the one beside that file. What this does not tell apart: a shell of the same user that writes
 *   inside Grok's own folder (appends to a live session's updates.jsonl, or puts files of its own in a live session's
 *   folder) can still make words look like Grok's; that is the guard's to refuse, and a Limit, as a shell that writes
 *   Codex's rollout is for Codex. A Grok keeps every session it ran since it started open (/clear leaves the last one
 *   open), so a made-up SessionStart may name one of those: the recording moves there until the next real SessionStart
 *   (the limit of a check with no turn of its own to prove it, as Codex's has), and only Grok's own log of it confirms
 *   anything.
 * - UserPromptSubmit and Stop spool only for the session this Grok's host record names, and what they spool is held
 *   until Grok's log confirms it, then dropped and counted if it doesn't.
 */

import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync, type Stats } from "node:fs";
import { join } from "node:path";
import { type AgentConfig, agentForCwd, type HarnessConfig } from "../agent/config.ts";
import { holderFresh, openElsewhere, readHolder } from "../agent/handover.ts";
import { readMemory } from "../agent/memory-read.ts";
import { type OpenFile, openFiles } from "../agent/open-files.ts";
import { AGENT_ENV } from "../agent/pick.ts";
import type { PlainDeps } from "../agent/plain-nested.ts";
import { processCwd, processEnv } from "../agent/process.ts";
import { liveSession, nestedNotice, plainFields, recordSession, type SessionRecord } from "../agent/sessions.ts";
import { safeText } from "../agent/source-labels.ts";
import { NOT_RECORDED, type StatusState, statusText } from "../agent/status-text.ts";
import { noticeShownBefore, waitForMode } from "../claude/hooks.ts";
import { summaryNotice, updateNotice } from "../claude/notices.ts";
import { holderLog, validSession } from "../claude/paths.ts";
import { readMode, type SessionMode, spoolEvent } from "../claude/spool.ts";
import { grokAgent } from "../codex/pick.ts";
import { grokHostNotice, grokHostRefusal } from "./host.ts";
import { type GrokHeld, grokHeldSessions, grokLogStart, grokSessionKind, grokStartHome } from "./log.ts";
import { GROK_HOOK_EVENTS } from "./names.ts";

/** The events `orrery grok-hook` answers (pre-tool-use is the guard), kept in src/grok/names.ts, where the install reads them. */
export { GROK_HOOK_EVENTS };

/** The fields read from Grok's input; every one is checked before use. */
export interface GrokHookInput {
	readonly sessionId?: unknown;
	readonly session_id?: unknown;
	readonly promptId?: unknown;
	readonly source?: unknown;
	readonly prompt?: unknown;
	readonly lastAssistantMessage?: unknown;
	readonly last_assistant_message?: unknown;
	readonly reason?: unknown;
}

/** What a hook runs with: the config, the environment, Grok's process and how to start a holder. */
export interface GrokHookContext {
	readonly config: HarnessConfig;
	readonly env: NodeJS.ProcessEnv;
	/** The files a process has open (default src/agent/open-files.ts openFiles): Grok's session folders are found by them. */
	readonly openFiles?: (pid: number) => readonly OpenFile[] | undefined;
	/**
	 * Named variables of the environment a process was started with (default processEnv, src/agent/process.ts, without
	 * the process's arguments): Grok's folder is the one the grok process's names.
	 */
	readonly envOf?: (pid: number, names: readonly string[]) => Readonly<Record<string, string>> | undefined;
	/** Grok's process (src/grok/host.ts): the token's owner and the holder's host. */
	readonly grokPid: number;
	/**
	 * The process grokPid() started from (the hook's parent): when grokPid is another, it was reached past processes
	 * named like shells, and must prove itself (src/codex/pick.ts). Undefined: no check (tests).
	 */
	readonly grokParent?: number;
	/** The folder a process runs in, as it really is (default processCwd): Grok names its sessions' folder by it. */
	readonly cwdOf?: (pid: number) => string | undefined;
	/** Starts the session's holder (spawnHolder for Grok); tests start one in-process or answer for it. */
	readonly startHolder: (agent: AgentConfig, session: string, nonce: string, since: number) => void;
	/** How long SessionStart waits for the holder to choose recording or read-only (default 8 s). */
	readonly modeWaitMs?: number;
	/** Whether a pid lives, for the token's claim (default processAlive); tests pass their own. */
	readonly alive?: (pid: number) => boolean;
	/** Whether hooks show Orrery's update notices (src/claude/notices.ts updateNotice); the CLI turns them on. */
	readonly updateNotices?: boolean;
	/** How a coding tool's session that is no agent's is looked for (src/agent/plain-nested.ts); tests pass their own. */
	readonly plain?: PlainDeps;
	/** A process's command line (default processArgv): whether grokPid is Grok's shared leader (src/grok/host.ts). */
	readonly argvOf?: (pid: number) => readonly string[] | undefined;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The input's session id (camelCase, else Claude Code's alias), when it is one the spool takes. */
const sessionOf = (input: GrokHookInput): string | undefined => {
	const id = input.sessionId ?? input.session_id;
	return validSession(id) ? id : undefined;
};

/** The hook's promptId ("" when it has none: the holder then confirms nothing). */
const promptOf = (input: GrokHookInput) => (typeof input.promptId === "string" ? input.promptId : "");

/** Whether this Grok was opened as an agent: ORRERY_AGENT set. Without it, it is a plain grok (module doc). */
const opened = (ctx: GrokHookContext) => (ctx.env[AGENT_ENV]?.trim() ?? "") !== "";

/** The agent of an event of `session` (`takeover` only for SessionStart: the process's first asker). */
function agentOf(ctx: GrokHookContext, session: string | undefined, takeover = false) {
	return grokAgent(ctx.config, {
		env: ctx.env,
		pid: ctx.grokPid,
		takeover,
		...(ctx.grokParent === undefined ? {} : { parent: ctx.grokParent }),
		...(session === undefined ? {} : { session }),
		...(ctx.alive === undefined ? {} : { alive: ctx.alive }),
		...(ctx.plain === undefined ? {} : { plain: ctx.plain }),
	});
}

/** This Grok's host record, when it names a session: the session its last SessionStart took as its own. */
function hostRecord(ctx: GrokHookContext): (SessionRecord & { readonly grokSession: string }) | undefined {
	const record = liveSession(ctx.config.dataDir, ctx.grokPid);
	return record?.tool === "grok" && record.grokSession !== undefined ? (record as SessionRecord & { readonly grokSession: string }) : undefined;
}

/**
 * Where an event of this Grok's agent goes: the session its host record names, which its holder does not run read-only,
 * and whether the event is of that session (`own`) or another's (a subagent's).
 */
function recordable(input: GrokHookInput, ctx: GrokHookContext): { readonly agent: AgentConfig; readonly session: string; readonly own: boolean } | undefined {
	const session = sessionOf(input);
	if (session === undefined || !opened(ctx)) return undefined;
	const host = hostRecord(ctx);
	if (host === undefined) return undefined;
	const pick = agentOf(ctx, session);
	if (pick.kind !== "agent" || pick.agent.name !== host.agent) return undefined;
	if (readMode(pick.agent.dir, host.grokSession)?.mode === "read-only") return undefined;
	return { agent: pick.agent, session: host.grokSession, own: session === host.grokSession };
}

/** Spools a prompt or reply: the event's own, or, from another session, one with no words for the holder to count. */
function spoolSaid(kind: "prompt" | "reply", text: unknown, input: GrokHookInput, ctx: GrokHookContext): void {
	const at = recordable(input, ctx);
	if (at === undefined || typeof text !== "string" || !text.trim()) return;
	const said = at.own ? { text, promptId: promptOf(input) } : { text: "", promptId: "" };
	spoolEvent(at.agent.dir, at.session, { kind, at: Date.now(), claudePid: ctx.grokPid, host: "grok", ...said });
}

/** UserPromptSubmit: spools the person's prompt; Grok discards an allowing hook's answer, so it prints nothing. */
export function userPromptSubmit(input: GrokHookInput, ctx: GrokHookContext): void {
	spoolSaid("prompt", input.prompt, input, ctx);
}

/** Stop: spools the turn's last reply, at a turn's end only (not the separate Stop at the session's end). */
export function stop(input: GrokHookInput, ctx: GrokHookContext): void {
	if (input.reason !== "end_turn") return;
	spoolSaid("reply", input.lastAssistantMessage ?? input.last_assistant_message, input, ctx);
}

/** How a Grok session switches the summary model: Orrery's command (Grok has no command of Orrery's). */
const compactorCommand = (agent: AgentConfig) => `orrery compactor ${agent.name}`;

/** This session's summary and update notices, one per line, never an error: a hook that fails must not disturb the session. */
function noticeLines(agent: AgentConfig, session: string, ctx: GrokHookContext): string[] {
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

/** A Grok session's log, as SessionStart found it: the log and Grok's folder as they really are, and where to read from. */
interface OwnLog {
	readonly path: string;
	readonly home: string;
	readonly offset: number;
	readonly file?: string;
}

/** What is at `path` itself, a link there not followed: undefined when nothing is, "unreadable" when that can't be told. */
function placeOf(path: string): Stats | undefined | "unreadable" {
	try {
		return lstatSync(path);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : "unreadable";
	}
}

/** `path` as it really is, or undefined when it can't be read. */
function realOf(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

/** The variables of the grok process's start environment that name Grok's folder. */
const GROK_FOLDER_VARIABLES = ["GROK_HOME", "HOME"];

/** A process's start environment, never a word of its arguments (Grok's --rules hold the agent's memory). */
const startEnv = (pid: number, names: readonly string[]) => processEnv(pid, names, { withoutArgs: true });

/**
 * Session `session` as this Grok's own (module doc): its log and where to read it from, or why it can't be confirmed.
 * Grok's folder is the one the grok process was started with (src/grok/log.ts grokStartHome), as it really is; an
 * environment that can't be read refuses. The session's folder comes from the events.jsonl the grok process has open
 * for the session under that folder and under the folder that process runs in, as it really is (Grok resolves links in
 * it, live): exactly one such file, open for writing, as Grok holds its record. Never from the hook's own GROK_HOME,
 * HOME or input. That file must be at its own place with no link on the way or at it (on Linux, the very file Grok has
 * open), and the log beside it a regular file, or none yet (a new session's).
 */
function ownSession(session: string, ctx: GrokHookContext): OwnLog | string {
	const cwd = (ctx.cwdOf ?? processCwd)(ctx.grokPid);
	if (cwd === undefined) return "the folder Grok runs in can't be read";
	const started = (ctx.envOf ?? startEnv)(ctx.grokPid, GROK_FOLDER_VARIABLES);
	if (started === undefined) return "Grok's environment can't be read";
	const named = grokStartHome(started, cwd);
	if (named === undefined) return "Grok's environment names neither GROK_HOME nor HOME";
	const grokHome = realOf(named);
	if (grokHome === undefined) return "Grok's folder can't be read";
	const open = (ctx.openFiles ?? openFiles)(ctx.grokPid);
	if (open === undefined) return "this system can't tell which files Grok has open";
	// A tool of Grok's reading a file the agent made at a path like Grok's has it open too: only Grok's own folder counts.
	const under = grokHeldSessions(open, cwd, session).filter((one) => realOf(one.home) === grokHome);
	if (under.length === 0) return "Grok doesn't have it open";
	if (under.length > 1) return "Grok has it open more than once";
	const held = under[0] as GrokHeld;
	if (held.writes === undefined) return "this system can't tell whether Grok has it open for writing";
	if (!held.writes) return "Grok doesn't have it open for writing";
	const { dir, home } = held;
	const events = join(dir, "events.jsonl");
	const real = realOf(dir);
	const at = placeOf(events);
	if (real === undefined || join(real, "events.jsonl") !== events || at === undefined || at === "unreadable" || !at.isFile() || (held.file !== undefined && held.file !== `${at.dev}:${at.ino}`)) {
		return "the file Grok has open is not at its place";
	}
	const log = join(dir, "updates.jsonl");
	const logAt = placeOf(log);
	if (logAt === "unreadable" || (logAt !== undefined && !logAt.isFile())) return "its log is a link or no regular file";
	const kind = grokSessionKind(dir, session);
	if (kind === undefined) return `no session of it under ${home}`;
	if (kind !== "main") return "it is no session of the person's own, but a subagent's or another kind";
	const start = grokLogStart(log);
	if (start === undefined) return "its log can't be read";
	return { path: log, home, offset: start.offset, ...(start.file === undefined ? {} : { file: start.file }) };
}

/** A plain grok's SessionStart (module doc): in an agent's folder, how to open that agent; elsewhere nothing. */
function plainStart(ctx: GrokHookContext): object | undefined {
	const cwd = (ctx.cwdOf ?? processCwd)(ctx.grokPid);
	const agent = cwd === undefined ? undefined : agentForCwd(ctx.config, cwd);
	if (agent === undefined) return undefined;
	const name = safeText(agent.name);
	return { systemMessage: `Orrery: this folder is ${name}'s, but this Grok wasn't opened as ${name}, so it opens no memory and records nothing. Open it with orrery agent ${name} --tool grok.` };
}

/**
 * SessionStart: the holder, then the status (module doc). A session that isn't this Grok's own, or a refused
 * ORRERY_AGENT, only tells the person.
 */
export async function sessionStart(input: GrokHookInput, ctx: GrokHookContext): Promise<object | undefined> {
	if (!opened(ctx)) return plainStart(ctx);
	const session = sessionOf(input);
	if (session === undefined) return undefined;
	const refuse = (why: string) => ({ systemMessage: `Orrery: can't confirm this is this Grok's own session (${safeText(why)}), so it opens no memory and records nothing.` });
	// Before anything is decided, claimed or recorded: is this session this Grok's own?
	const log = ownSession(session, ctx);
	if (typeof log === "string") return refuse(log);
	// Every SessionStart may be the process's first asker (Grok fires none at a compaction): it decides, and may claim.
	const pick = agentOf(ctx, session, input.source === "new" || input.source === "load");
	if (pick.kind === "refused") return { systemMessage: pick.notice };
	if (pick.kind === "nested") return { systemMessage: nestedNotice({ agent: pick.outer, tool: pick.tool, via: "ancestry", dataDir: "", ...plainFields(pick) }) };
	const { agent } = pick;
	// The session this Grok's host record names already: nothing to record again.
	const recorded = hostRecord(ctx);
	const current = recorded?.grokSession === session && recorded.agent === agent.name;
	// This Grok hosts the agent's session, with this session's id, whether or not it records: what its shell starts runs
	// inside the agent's session.
	const hosted = current || recordSession(ctx.config.dataDir, { agent: agent.name, tool: "grok", pid: ctx.grokPid, grokSession: session, config: ctx.config.file });
	// The holder's cut-off: this session's events from now on belong to this run.
	const since = Date.now();
	// Where the holder reads this session's log from: a session new to this Grok's record only.
	if (hosted && !current) spoolEvent(agent.dir, session, { kind: "grok-log", at: since, claudePid: ctx.grokPid, path: log.path, home: log.home, offset: log.offset, ...(log.file === undefined ? {} : { file: log.file }) });
	const warnings: string[] = [];
	let state: StatusState = "recording";
	if (pick.notRecorded !== undefined) warnings.push(`Orrery: which agent this Grok is could not be recorded (${safeText(pick.notRecorded)}), so each SessionStart works it out again.`);
	if (!hosted) {
		// Its prompts are confirmed by the session the host record names: with none, nothing records.
		state = NOT_RECORDED;
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
			state = NOT_RECORDED;
			if (held) warnings.push(`Orrery: ${agent.name} is ${openElsewhere(agent.dir, "grok")}; this session reads memory but is not recorded.`);
		}
		// A recording recorder's notices (memory kept aside, unsaved turns kept) are said once per recorder start.
		if (!held && typeof mode?.reason === "string" && !(mode.mode === "recording" && noticeShownBefore(agent.dir, session, mode.nonce))) warnings.push(safeText(mode.reason));
	}
	let memory: { readonly messages?: number } = {};
	try {
		memory = readMemory(agent, false);
	} catch (error) {
		warnings.push(`Orrery: ${agent.name}'s memory could not be read: ${safeText(errorText(error))}`);
	}
	// The status line as statusText says it, which the status row (src/grok/status.ts) uses too, with why on the lines
	// after. Their words can differ: a read-only row says where the agent is open, this line that the session isn't recorded.
	const status = statusText({ name: agent.name, count: memory.messages, state });
	return { systemMessage: [status, ...warnings, ...noticeLines(agent, session, ctx)].join("\n") };
}

/** The hook's stdout for `event` (an empty string: nothing to say). An event it does not know throws. */
export async function runGrokHook(event: string, stdin: string, ctx: GrokHookContext): Promise<string> {
	if (!(GROK_HOOK_EVENTS as readonly string[]).includes(event)) throw new Error(`unknown hook event ${event}; expected one of ${GROK_HOOK_EVENTS.join(", ")}`);
	// Before anything is read, decided, claimed or recorded: a leader hosts no agent's session (module doc).
	const refused = grokHostRefusal(ctx.grokPid, ctx.argvOf);
	if (refused !== undefined) return event === "session-start" && opened(ctx) ? JSON.stringify({ systemMessage: grokHostNotice(refused) }) : "";
	let input: GrokHookInput;
	try {
		const parsed = JSON.parse(stdin) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "";
		input = parsed as GrokHookInput;
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
			userPromptSubmit(input, ctx);
			break;
		case "stop":
			stop(input, ctx);
			break;
		// The interrupted turn's prompt is spooled already; its reply never came. The session's end changes nothing (module
		// doc), and the guard (pre-tool-use) answers by its exit code, in src/cli/main.ts grokGuardHook.
		case "stop-cancelled":
		case "session-end":
		case "pre-tool-use":
			break;
	}
	return output === undefined ? "" : JSON.stringify(output);
}

/** What SessionStart says when Orrery's config cannot be read in a Grok opened as an agent: it runs as plain Grok. */
export function configNotice(why: string): string {
	return JSON.stringify({ systemMessage: `Orrery: the config could not be read (${safeText(why)}); this session runs without memory.` });
}
