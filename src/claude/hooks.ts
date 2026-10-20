/**
 * Claude Code's hooks (spec §4 "Hooks"), run as `orrery claude-hook <event>` with the hook's JSON on stdin.
 * - They find the session's agent (src/claude/pick.ts): the one ORRERY_AGENT names, in any folder, else the one whose
 *   folder holds the project folder (CLAUDE_PROJECT_DIR, else the hook's cwd). Under ORRERY_AGENT that is decided
 *   once for Claude Code's process (CLAUDE_PID, which Claude Code sets for its hooks): by the MCP server or the first
 *   SessionStart, and read by every later event.
 * - They never write the store, and they return quickly: SessionEnd gets about 1.5 s.
 * - Subagent events (agent_id) are not memory.
 * - Outside an agent they write nothing, and print nothing but PreToolUse's refusals: there the guard keeps Orrery's
 *   own rules (preToolUse, spec 2026-10-19-no-agent-sessions §3). An ORRERY_AGENT that is refused (it names no agent, its
 *   token is malformed, the folder is another agent's set up the file way, or the process's decision could not be
 *   recorded or is missing) gets a notice at SessionStart, records nothing, and keeps the guard.
 * - They record only where `orrery claude-setup` ran: in mod mode in any folder, in file mode for the agent's
 *   folder. In any other agent they start no holder and spool nothing, SessionStart says the session is not recorded,
 *   and the guard still applies.
 * - A Claude Code started inside an agent's session (spec 2026-10-18-agent-permissions §3b: the process's decision,
 *   src/claude/pick.ts), or whose CLAUDE_PID is not its own (claudeHookPid), opens no memory and records nothing:
 *   SessionStart says why (not again at a compaction), nothing is spooled, no holder starts, and the guard keeps the
 *   outer agent's rules, never looser than the folder's own (src/agent/nested-rules.ts).
 * - So does one started from a coding tool's session that is no agent's (spec 2026-10-19-no-agent-sessions §4c,
 *   src/agent/plain-nested.ts), with the guard of the agent whose folder it runs in. In a folder that is no agent's it
 *   is a plain session (plainHere): Orrery's own guard alone, and SessionStart says nothing unless ORRERY_AGENT is set.
 * - One whose process can't be confirmed at SessionStart (its start time can't be read) opens no memory either, and its
 *   SessionStart marks the session read-only for the agent it would be (markUnconfirmed): its later events are not
 *   spooled, no holder takes them in, and a later SessionStart of the session in the same process starts none, even
 *   once the start can be read.
 * - Their stdout is only their JSON answer, and they never put message contents on stderr.
 * - A writing hook (all but PreToolUse) changes nothing unless its caller is its Claude Code (spec
 *   2026-10-18-agent-permissions §3c, src/claude/peer.ts): its stdin's peer (on macOS, its stdout's when stdin's is
 *   gone) must be the Claude Code process, and, past SessionStart, the one recorded with its start time. An agent's
 *   shell that runs the hook command itself (a pipe, a socket pair of its own) gets nothing written, decided, forgotten
 *   or started; a SessionStart that looks like a real one says the session isn't recorded, and why (callerNotice). A
 *   session left open across Orrery's update from 0.8.0 (whose decision holds no start) goes on recording when its
 *   ORRERY_AGENT launch's token proves it; else its first refused prompt or reply says, once, to restart it
 *   (updatedSession).
 * - SessionStart spools where the session's transcript is (only under Claude Code's projects folder), and each prompt
 *   carries its promptId: the holder records a prompt only once that transcript confirms it (src/claude/transcript.ts).
 *   A session whose transcript can't be found there, or whose Claude Code isn't recorded, is marked read-only with the
 *   reason, and nothing of it is recorded; a /compact of a session its recorder records keeps the transcript it has. The
 *   reason is said once a session.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { type HarnessConfig, type AgentConfig, agentForCwd } from "../agent/config.ts";
import { agentViews, GuardCall, movedAgentDirCredentials, ompCredentials, openCodeCredentials } from "../agent/guard-paths.ts";
import { orreryHome } from "../agent/home.ts";
import { cutNotice, readInstructions } from "../agent/instructions.ts";
import { nestedRules, type WriteRules } from "../agent/nested-rules.ts";
import { opensHere, type PlainDeps } from "../agent/plain-nested.ts";
import { AGENT_ENV, agentNamed, workArea } from "../agent/pick.ts";
import { writePrivate } from "../agent/private-file.ts";
import { processAlive } from "../agent/process.ts";
import { liveSession, processStart } from "../agent/sessions.ts";
import { selfCommand } from "../agent/running.ts";
import { safeText } from "../agent/source-labels.ts";
import { type HolderHost, holderFresh, openElsewhere, readHolder } from "../agent/handover.ts";
import { claudeGuard, claudeStateRoots, movedConfigDirCredentials } from "./guard.ts";
import { summaryNotice, updateNotice } from "./notices.ts";
import { holderLog, samePath, validSession } from "./paths.ts";
import { type CallerCheck, checkCaller, type StdinPeer, stdinPeer, unsupportedCause } from "./peer.ts";
import { type ClaudePicked, claudeRefusedNotice, claudeSession, decidedBeforeUpdate, forgetProcess, markedUnconfirmed, UNCONFIRMED_NOTICE } from "./pick.ts";
import { readMode, type SessionMode, spoolEvent, writeMode } from "./spool.ts";
import { projectsFolder, transcriptIn, unreadableHere } from "./transcript.ts";
import { markedHere, refreshViewFile, type ViewGate, viewGate } from "./view-file.ts";

/**
 * Whether this recorder start's notice was already shown to this session (a /compact reuses the recorder and runs
 * SessionStart again). Records it when not. Keyed by the recorder start's nonce; a file that can't be read or written
 * just means the notice is shown again. Codex's SessionStart (src/codex/hooks.ts) asks it too.
 */
export function noticeShownBefore(agentDir: string, session: string, nonce: string | undefined): boolean {
	if (nonce === undefined) return false;
	const path = join(agentDir, "notices-shown.json");
	let shown: Record<string, string> = {};
	try {
		const data: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof data === "object" && data !== null && !Array.isArray(data)) shown = data as Record<string, string>;
	} catch {
		shown = {};
	}
	if (shown[session] === nonce) return true;
	try {
		writePrivate(path, `${JSON.stringify({ ...shown, [session]: nonce })}\n`);
	} catch {
		// shown again next time: harmless
	}
	return false;
}

/** The hook events `orrery claude-hook` takes, as the plugin's hooks.json names them. */
export const HOOK_EVENTS = ["session-start", "user-prompt-submit", "stop", "session-end", "pre-tool-use"] as const;

/** Claude Code's hook context: at most this many characters reach the model inline. */
const CONTEXT_LIMIT = 10_000;

/**
 * The longest PreToolUse input the hook reads, in bytes (1 MB). The guard's time grows with what a call names, and
 * Claude Code lets a call through when the hook times out, so a longer input is refused unread. Other events' inputs
 * are read whole: they are memory.
 */
export const TOOL_INPUT_MAX = 1024 * 1024;

/** How many bytes of an event's stdin the hook keeps (TOOL_INPUT_MAX for PreToolUse, else all). */
export function hookInputMax(event: string): number {
	return event === "pre-tool-use" ? TOOL_INPUT_MAX : Number.POSITIVE_INFINITY;
}

/** The fields orrery reads; every one is checked before use. */
export interface HookInput {
	readonly session_id?: unknown;
	readonly cwd?: unknown;
	readonly agent_id?: unknown;
	readonly source?: unknown;
	readonly prompt?: unknown;
	/** The turn's id (UserPromptSubmit, Stop): the transcript's promptId of the prompt. */
	readonly prompt_id?: unknown;
	/** Claude Code's transcript file: trusted from a SessionStart whose caller was checked, under its projects folder. */
	readonly transcript_path?: unknown;
	readonly slash_command?: unknown;
	readonly last_assistant_message?: unknown;
	readonly reason?: unknown;
	readonly tool_name?: unknown;
	readonly tool_input?: unknown;
}

/** What a hook runs with: the config, the environment, and how to start a holder. */
export interface HookContext {
	readonly config: HarnessConfig;
	readonly env: NodeJS.ProcessEnv;
	/** Claude Code's process: CLAUDE_PID, as claudeHookPid checks it, else the hook's parent. */
	readonly claudePid: number;
	/**
	 * CLAUDE_PID named a process that is not this hook's Claude Code (claudeHookPid): whose session this is can't be
	 * told, so it is taken as one started inside an agent's session, whose agent is unknown (fail closed).
	 */
	readonly hostUnverified?: boolean;
	/** How Claude Code's start time is read (default processStart, src/agent/sessions.ts); tests pass their own. */
	readonly processStart?: (pid: number) => string | undefined;
	/** How a coding tool's session that is no agent's is looked for (src/agent/plain-nested.ts); tests pass their own. */
	readonly plain?: PlainDeps;
	/**
	 * Who is on the other end of the hook's stdin, or on macOS maybe its stdout (default stdinPeer, src/claude/peer.ts):
	 * asked by writing hooks only. The CLI asks before it reads stdin or writes stdout and passes the answer; tests pass
	 * their own.
	 */
	readonly peer?: () => StdinPeer;
	/** Why a transcript can't be read here (default unreadableHere, src/claude/transcript.ts); tests pass their own. */
	readonly transcriptsUnreadable?: () => string | undefined;
	/**
	 * Starts the session's holder (spawnHolder), with SessionStart's time as its read-only cut-off; tests start one
	 * in-process or answer for it.
	 */
	readonly startHolder: (agent: AgentConfig, session: string, nonce: string, since: number) => void;
	/** How long SessionStart waits for the holder to choose recording or read-only (default 8 s). */
	readonly modeWaitMs?: number;
	/** The home folder "~" means (default: the OS's); tests set it. */
	readonly home?: string;
	/** The file `config` was read from: the guard keeps it read-only and named in no command (GuardOptions.configFile). */
	readonly configFile?: string;
	/**
	 * Whether hooks show Orrery's update notices (src/claude/notices.ts updateNotice), read from `env`'s Orrery home. The
	 * CLI turns them on; tests that leave this out see none.
	 */
	readonly updateNotices?: boolean;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface Here {
	readonly agent: AgentConfig;
	readonly projectDir: string;
}

/**
 * Which agent the session belongs to (src/claude/pick.ts), for the project folder and Claude Code's own process: under
 * ORRERY_AGENT, the process's one recorded decision. `start`: SessionStart, which makes that decision when nothing (the
 * MCP server) made it before; every other event, and every later SessionStart, reads it, so a session never changes
 * agents midway (a Claude Code an agent started, picked by its folder, does not become the agent when the agent exits).
 */
function pickFor(ctx: HookContext, projectDir: string, start = false): ClaudePicked {
	if (ctx.hostUnverified === true) return { kind: "nested", outer: undefined, tool: undefined };
	return claudeSession(ctx.config, {
		env: ctx.env,
		cwd: projectDir,
		pid: ctx.claudePid,
		decide: start,
		...(ctx.processStart === undefined ? {} : { start: ctx.processStart }),
		...(ctx.plain === undefined ? {} : { plain: ctx.plain }),
	});
}

/**
 * Whether `pick` is a session that is no agent's in `projectDir`: none, or one started from a coding tool's session that
 * is no agent's, in a folder that is no agent's (src/agent/plain-nested.ts), which is a plain one there.
 */
const plainHere = (pick: ClaudePicked, config: HarnessConfig, projectDir: string): boolean =>
	pick.kind === "none" || (pick.kind === "nested" && pick.plain !== undefined && agentForCwd(config, projectDir) === undefined);

function pickHere(input: HookInput, ctx: HookContext, start = false): { readonly pick: ClaudePicked; readonly projectDir: string } | undefined {
	const projectDir = ctx.env.CLAUDE_PROJECT_DIR || (typeof input.cwd === "string" ? input.cwd : undefined);
	if (projectDir === undefined) return undefined;
	return { pick: pickFor(ctx, projectDir, start), projectDir };
}

function here(input: HookInput, ctx: HookContext): Here | undefined {
	const found = pickHere(input, ctx);
	return found?.pick.kind === "agent" ? { agent: found.pick.agent, projectDir: found.projectDir } : undefined;
}

/** A prompt that is a slash command (`/compact`, `/orrery:memory`), not words for memory. `/tmp is full` is words. */
export function slashCommand(input: HookInput): boolean {
	if (input.slash_command !== undefined && input.slash_command !== null && input.slash_command !== false) return true;
	const match = typeof input.prompt === "string" ? /^\/([A-Za-z0-9][\w:.-]*)(\s|$)/.exec(input.prompt) : null;
	return match !== null && !existsSync(`/${match[1]}`);
}

/**
 * The session's own memory events: main-thread events of a real session id, in an agent where claude-setup ran
 * (markedHere), unless it runs read-only. In an agent never set up nothing is spooled, so no later holder adopts it.
 */
function recordable(input: HookInput, ctx: HookContext): (Here & { session: string }) | undefined {
	if (input.agent_id !== undefined) return undefined;
	const found = here(input, ctx);
	if (found === undefined || !validSession(input.session_id) || !markedHere(found.agent)) return undefined;
	if (readMode(found.agent.dir, input.session_id)?.mode === "read-only") return undefined;
	return { ...found, session: input.session_id };
}

/** orrery's own commands (`/orrery:memory`, `/orrery:compactor …`, `/orrery:browse`): their replies are not memory. */
const ORRERY_COMMAND = /^\/orrery:(memory|compactor|browse)(\s|$)/;

/**
 * This session's summary and update notices, never an error: a hook that fails must not disturb the turn. Main-thread
 * events of an agent's session only.
 */
function notice(input: HookInput, ctx: HookContext): object | undefined {
	if (input.agent_id !== undefined || !validSession(input.session_id)) return undefined;
	const found = here(input, ctx);
	if (found === undefined) return undefined;
	const session = input.session_id;
	const lines: string[] = [];
	const add = (read: () => string | undefined) => {
		try {
			const message = read();
			if (message !== undefined) lines.push(message);
		} catch {
			// left out
		}
	};
	add(() => summaryNotice(found.agent, session));
	if (ctx.updateNotices === true) add(() => updateNotice(found.agent, session, ctx.env, ctx.config.updates.check));
	return lines.length === 0 ? undefined : { systemMessage: lines.join("\n") };
}

/**
 * UserPromptSubmit: spools the user's prompt, unless it is a slash command or empty. One of orrery's own commands
 * spools a text-less `command` instead, so the holder keeps the reply to it out of memory, as pi does.
 */
export function userPromptSubmit(input: HookInput, ctx: HookContext): object | undefined {
	const at = recordable(input, ctx);
	if (at !== undefined && typeof input.prompt === "string" && input.prompt.trim()) {
		// With the turn's id, which the holder confirms against Claude Code's transcript ("" never confirms).
		const promptId = typeof input.prompt_id === "string" ? input.prompt_id : "";
		if (!slashCommand(input)) spoolEvent(at.agent.dir, at.session, { kind: "prompt", at: Date.now(), claudePid: ctx.claudePid, text: input.prompt, promptId });
		else if (ORRERY_COMMAND.test(input.prompt)) spoolEvent(at.agent.dir, at.session, { kind: "command", at: Date.now(), claudePid: ctx.claudePid });
	}
	return notice(input, ctx);
}

/** Stop: spools the turn's final reply. */
export function stop(input: HookInput, ctx: HookContext): object | undefined {
	const at = recordable(input, ctx);
	const text = input.last_assistant_message;
	if (at !== undefined && typeof text === "string" && text.trim()) spoolEvent(at.agent.dir, at.session, { kind: "reply", at: Date.now(), claudePid: ctx.claudePid, text });
	return notice(input, ctx);
}

/**
 * SessionEnd: only drops an "end" in the spool, since Claude Code cancels a slow SessionEnd hook, and at the process's
 * end removes its decision (src/claude/pick.ts). Not at /clear or an in-process /resume, which end one session of the
 * process and start another, nor at /logout or a reason not known here, which may leave it running: a later decision's
 * prune takes the record once the process is gone.
 */
export function sessionEnd(input: HookInput, ctx: HookContext): void {
	const at = recordable(input, ctx);
	if (at !== undefined) spoolEvent(at.agent.dir, at.session, { kind: "end", at: Date.now(), claudePid: ctx.claudePid, ...(typeof input.reason === "string" ? { reason: input.reason } : {}) });
	if (input.agent_id === undefined && ctx.hostUnverified !== true && (input.reason === "prompt_input_exit" || input.reason === "other")) forgetProcess(ctx.config, ctx.claudePid);
}

/**
 * Marks `session` read-only for the agent this session would be (ORRERY_AGENT's, else the folder's), where Claude Code is
 * set up to record it: its hooks then spool nothing (recordable), a holder takes none of its events in (none came before
 * the mark), and markedUnconfirmed (src/claude/pick.ts) keeps a later SessionStart of it in this process from starting
 * one; the mark's time (`since`) tells a Claude Code that reuses the pid later from this one. Never throws.
 */
function markUnconfirmed(id: string, projectDir: string, ctx: HookContext): void {
	try {
		const name = ctx.env[AGENT_ENV]?.trim();
		const agent = name ? agentNamed(ctx.config, name) : agentForCwd(ctx.config, projectDir);
		if (agent === undefined || !markedHere(agent)) return;
		writeMode(agent.dir, id, { mode: "read-only", pid: process.pid, claudePid: ctx.claudePid, nonce: randomUUID(), since: Date.now(), reason: UNCONFIRMED_NOTICE });
	} catch {
		// unmarked: its later hooks judge it as they can
	}
}

/**
 * What a session whose prompts can't be confirmed in this Claude Code version says (spec 2026-10-18-agent-permissions
 * §3c): its hooks' stdin is no socket pair of its Claude Code's, or its transcript is not where Claude Code keeps them.
 * Nothing of it is recorded, never by falling back.
 */
export const CALLER_NOTICE = "Orrery: can't confirm prompts in this Claude Code version, so this session isn't recorded.";

/**
 * What a session whose hooks' caller can't be checked says, by why: Orrery can't ask here (it runs under Node, the system
 * isn't supported, the C library can't be loaded), or its Claude Code's process isn't recorded; else CALLER_NOTICE.
 */
export function callerNotice(check: Exclude<CallerCheck, "ok">): string {
	const cause = check === "unsupported" ? unsupportedCause() : check === "unrecorded" ? "this Claude Code's process isn't recorded" : undefined;
	return cause === undefined ? CALLER_NOTICE : `Orrery can't check who calls its hooks here (${cause}), so this session isn't recorded.`;
}

/** Where the session's prompts are confirmed: its transcript and how long it was, from a SessionStart its caller sent. */
interface TranscriptAt {
	readonly path: string;
	readonly projects: string;
	readonly offset: number;
}

/** Why a SessionStart's prompts can't be confirmed: its notice, and whether only this transcript's place is at fault. */
interface Unconfirmable {
	readonly notice: string;
	/** Only the transcript path is not where Claude Code keeps them: a /compact may keep the transcript it had. */
	readonly transcript: boolean;
}

/**
 * The session's transcript (input.transcript_path, under Claude Code's projects folder: src/claude/transcript.ts) with
 * its size now, once this SessionStart's Claude Code is the recorded one (its pick just recorded it) and a transcript can
 * be read here; else why not.
 */
function confirmable(input: HookInput, ctx: HookContext): TranscriptAt | Unconfirmable {
	const peer = (ctx.peer ?? stdinPeer)();
	const check = checkCaller(ctx.config, ctx.claudePid, peer, { recorded: true, env: ctx.env, ...(ctx.processStart === undefined ? {} : { start: ctx.processStart }) });
	if (check !== "ok") return { notice: callerNotice(check), transcript: false };
	const unreadable = (ctx.transcriptsUnreadable ?? unreadableHere)();
	if (unreadable !== undefined) return { notice: `Orrery can't read Claude Code's transcript here (${unreadable}), so this session isn't recorded.`, transcript: false };
	const projects = projectsFolder(ctx.env, ctx.home ?? homedir());
	const path = transcriptIn(input.transcript_path, projects);
	if (path === undefined) return { notice: CALLER_NOTICE, transcript: true };
	let offset = 0;
	try {
		offset = statSync(path).size;
	} catch {
		// a new session's file: not there yet
	}
	return { path, projects, offset };
}

/**
 * Marks `session` read-only, `reason` its notice: its later hooks spool nothing (recordable) and no holder adopts it. Only
 * a SessionStart whose caller was checked marks: a forged one changes nothing. Never throws.
 */
function markNotConfirmable(agent: AgentConfig, session: string, ctx: HookContext, reason: string): void {
	try {
		writeMode(agent.dir, session, { mode: "read-only", pid: process.pid, claudePid: ctx.claudePid, nonce: randomUUID(), since: Date.now(), reason });
	} catch {
		// unmarked: its prompts are dropped unconfirmed, and counted
	}
}

/**
 * A SessionStart whose caller is not its Claude Code changes nothing: no decision, no host record, no mode, no holder, no
 * view. Where it would have recorded the session (an agent set up here, the main thread, not a compaction) it says why
 * (callerNotice): a Claude Code that stopped handing hooks a socket stops recording visibly.
 */
function refusedStart(input: HookInput, ctx: HookContext, check: Exclude<CallerCheck, "ok">): object | undefined {
	if (input.agent_id !== undefined || input.source === "compact" || !validSession(input.session_id)) return undefined;
	try {
		return wouldRecord(input, ctx) === undefined ? undefined : { systemMessage: callerNotice(check) };
	} catch {
		return undefined;
	}
}

/**
 * The agent a session would be recorded for, where Claude Code is set up to record it: ORRERY_AGENT's, else the project
 * folder's (CLAUDE_PROJECT_DIR, else the hook's cwd); undefined when it is no agent's or not set up there.
 */
function wouldRecord(input: HookInput, ctx: HookContext): AgentConfig | undefined {
	const projectDir = ctx.env.CLAUDE_PROJECT_DIR || (typeof input.cwd === "string" ? input.cwd : undefined);
	if (projectDir === undefined) return undefined;
	const name = ctx.env[AGENT_ENV]?.trim();
	const agent = name ? agentNamed(ctx.config, name) : agentForCwd(ctx.config, projectDir);
	return agent !== undefined && markedHere(agent) ? agent : undefined;
}

/** What a session that was recording when Orrery was updated says once its hooks stop recording it (updatedSession). */
export const UPDATED_NOTICE = "Orrery was updated while this session was open; restart it to keep recording.";

/**
 * A prompt or reply refused because its Claude Code isn't recorded (checkCaller "unrecorded"), from a session a recorder
 * was recording, whose Claude Code has no decision of this version's and no host record: a process started before
 * Orrery's update, picked by its folder or by ORRERY_AGENT without a token (one with a token goes on recording,
 * src/claude/pick.ts decidedFor). It says so once a process and session (UPDATED_NOTICE), so the session doesn't stop
 * recording silently. Its stdin's peer is its Claude Code, so only Claude Code's own events get here. Never throws.
 */
function updatedSession(input: HookInput, ctx: HookContext): object | undefined {
	if (input.agent_id !== undefined || ctx.hostUnverified === true || !validSession(input.session_id)) return undefined;
	const session = input.session_id;
	try {
		const start = (ctx.processStart ?? processStart)(ctx.claudePid);
		if (start === undefined || !decidedBeforeUpdate(ctx.config, ctx.claudePid) || liveSession(ctx.config.dataDir, ctx.claudePid) !== undefined) return undefined;
		const agent = wouldRecord(input, ctx);
		if (agent === undefined || readMode(agent.dir, session)?.mode !== "recording") return undefined;
		return noticeShownBefore(agent.dir, `${session}:updated`, `${ctx.claudePid}:${start}`) ? undefined : { systemMessage: UPDATED_NOTICE };
	} catch {
		return undefined;
	}
}

/** The mode the holder started with `nonce` chose for `session`, once it has, or undefined after `ms`. */
export async function waitForMode(agentDir: string, session: string, nonce: string, ms: number): Promise<SessionMode | undefined> {
	const deadline = Date.now() + ms;
	for (;;) {
		const mode = readMode(agentDir, session);
		if (mode?.nonce === nonce) return mode;
		if (Date.now() >= deadline) return undefined;
		await sleep(50);
	}
}

/** SessionStart's notice for instructions over 32 KB in a session that gets none of them (file mode outside the folder, or not set up). */
const cutNoneNotice = (name: string) =>
	`Orrery: ${name}'s instructions are over 32 KB, and none of them reach the model in this session: only the Orrery mod, or the view file in ${name}'s folder, brings them. Shorten instructions.md.`;

/** SessionStart's line for the model in mod mode: an old Claude Code, or mods turned off, leaves no memory section. */
const MOD_CHECK = "If your system prompt has no Orrery memory section (its text begins \"Earlier conversation reaches you only through the view below\"), the Orrery mod is not loaded; tell the user.";

/**
 * Brings the view file up to date (in mod mode it writes none, and deletes a stale one) and starts this session's holder, unless one already records it (/compact). It
 * then tells the model the agent, its size and whether this session records. What the user should fix is also
 * shown to them. In an agent where claude-setup never ran (or its gate just took the setup back), it starts no holder:
 * the session is not recorded, and the status says so to both. Under a refused ORRERY_AGENT it only tells the person.
 */
export async function sessionStart(input: HookInput, ctx: HookContext): Promise<object | undefined> {
	if (!validSession(input.session_id)) return undefined;
	// The session's start: it makes the process's decision when nothing made it before (pickFor).
	const picked = pickHere(input, ctx, true);
	if (picked === undefined) return undefined;
	const { pick, projectDir } = picked;
	if (pick.kind === "none") return undefined;
	// Started inside an agent's session: said to the person, once a session (not again at a compaction); nothing recorded.
	// One started from a coding tool's session that is no agent's says so only where an agent would have opened.
	if (pick.kind === "nested") {
		if (pick.plain !== undefined && !opensHere(ctx.config, ctx.env, projectDir)) return undefined;
		return input.agent_id === undefined && input.source !== "compact" ? { systemMessage: claudeRefusedNotice(pick) } : undefined;
	}
	// A process that can't be confirmed: the session is marked not recorded, so nothing of it is, whatever comes later.
	if (pick.kind === "unconfirmed") {
		if (input.agent_id === undefined) markUnconfirmed(input.session_id, projectDir, ctx);
		return input.agent_id === undefined && input.source !== "compact" ? { systemMessage: claudeRefusedNotice(pick) } : undefined;
	}
	// A refused ORRERY_AGENT: said once, to the person, in the main session; nothing is recorded.
	if (pick.kind !== "agent") return input.agent_id === undefined ? { systemMessage: claudeRefusedNotice(pick) } : undefined;
	const { agent } = pick;
	// Marked unconfirmed by this process's SessionStart: stays unrecorded, though the start can be read now.
	if (markedUnconfirmed(agent, ctx.claudePid, input.session_id)) return input.agent_id === undefined && input.source !== "compact" ? { systemMessage: UNCONFIRMED_NOTICE } : undefined;
	// The holder's cut-off: this session's events from now on belong to this run.
	const since = Date.now();
	// Outside the agent's folder only the mod puts memory into the prompt: no CLAUDE.md there loads a view of this agent.
	const outside = agent.folder === undefined || workArea(agent, projectDir) !== agent.folder;
	const session = input.session_id;
	const warnings: string[] = [];
	const cut = readInstructions(agent.dir)?.cut === true;
	let messages: number | undefined;
	// The view's own gate, which every write goes through, says why the view is not written. Where git would see it,
	// the gate has taken the view back.
	let gate: ViewGate | undefined;
	try {
		messages = refreshViewFile(agent, (seen) => {
			gate = seen;
		});
	} catch (error) {
		warnings.push(`Orrery: ${agent.name}'s memory view could not be written: ${errorText(error)}`);
	}
	// No memory yet, so no write and no gate: ask it anyway, for the warnings.
	gate ??= viewGate(agent);
	// After the gate, which takes the setup back where git would see the view.
	const setUp = markedHere(agent);
	// Without ORRERY_AGENT a decision that could not be recorded is judged again at each event: said once a session.
	if (pick.notRecorded !== undefined && input.source !== "compact") warnings.push(`Orrery: which agent this Claude Code is could not be recorded (${safeText(pick.notRecorded)}), so each of its hooks works it out again.`);
	// The decision recorded this Claude Code as the agent's host (src/claude/pick.ts); one that could not be is said.
	if (liveSession(ctx.config.dataDir, ctx.claudePid) === undefined && processAlive(ctx.claudePid)) {
		warnings.push(`Orrery: this session could not be recorded as ${agent.name}'s, so tools and commands started from it are not known as ${agent.name}'s.`);
	}
	let state = "recording";
	// Where the session's prompts are confirmed (src/claude/transcript.ts), or why they can't be. Subagents' events are
	// not memory.
	const confirm = setUp && input.agent_id === undefined ? confirmable(input, ctx) : undefined;
	let unconfirmable = confirm !== undefined && "notice" in confirm ? confirm : undefined;
	if (confirm !== undefined && !("notice" in confirm)) {
		try {
			spoolEvent(agent.dir, session, { kind: "transcript", at: Date.now(), claudePid: ctx.claudePid, ...confirm });
		} catch (error) {
			unconfirmable = { notice: `Orrery: ${agent.name}'s spool could not be written (${errorText(error)}), so this session is not recorded.`, transcript: false };
		}
	}
	const holder = readHolder(agent.dir);
	const recordingHere = holderFresh(holder) && holder.session === session && holder.state === "recording";
	// A /compact whose new transcript path is not where Claude Code keeps them, in a session its recorder records, keeps
	// the transcript the recorder has: recording goes on.
	const keep = unconfirmable?.transcript === true && input.source === "compact" && recordingHere;
	const said = keep
		? "Orrery: this compaction's transcript is not where Claude Code keeps them, so this session goes on recording against the transcript it already had."
		: unconfirmable?.notice;
	// Said once a session in this Claude Code process (again for another reason, or in another process: a resume), not at
	// every compaction.
	if (said !== undefined) {
		const claudeProcess = `${ctx.claudePid}:${(ctx.processStart ?? processStart)(ctx.claudePid) ?? ""}`;
		if (!noticeShownBefore(agent.dir, `${session}:caller`, `${claudeProcess}:${said}`)) warnings.push(said);
	}
	if (!setUp) state = `not set up for Claude Code here, so this session is not recorded; run \`orrery claude-setup ${agent.name}\` to record it`;
	else if (unconfirmable !== undefined && !keep) {
		// Its prompts can't be confirmed: none of it is recorded, whatever comes later.
		markNotConfirmable(agent, session, ctx, unconfirmable.notice);
		state = "read-only: this session is not recorded";
	} else {
		let mode: SessionMode | undefined;
		if (recordingHere) mode = readMode(agent.dir, session);
		else {
			const nonce = randomUUID();
			ctx.startHolder(agent, session, nonce, since);
			mode = await waitForMode(agent.dir, session, nonce, ctx.modeWaitMs ?? 8000);
		}
		// Older mode files called the ordinary local lock "held"; it keeps the original notice.
		const genericHeld = mode?.mode === "read-only" && (mode.reason === undefined || mode.reason === "held" || mode.reason === "the agent is open elsewhere (pi, or a session of another Claude Code)");
		if (mode === undefined) {
			state = "not recording yet";
			warnings.push(`Orrery: ${agent.name}'s recorder did not answer in time; see ${holderLog(agent.dir)}.`);
		} else if (mode.mode === "read-only") {
			state = "read-only: this session is not recorded";
			if (genericHeld) warnings.push(`Orrery: ${agent.name} is ${openElsewhere(agent.dir, "claude-code")}; this session reads memory but is not recorded.`);
		}
		// A recording recorder's notices (memory kept aside, unsaved turns kept) are said once per recorder start, not
		// again at every /compact that reuses it.
		if (!genericHeld && typeof mode?.reason === "string" && !(mode.mode === "recording" && noticeShownBefore(agent.dir, session, mode.nonce))) warnings.push(safeText(mode.reason));
	}
	const mod = gate.mod === true;
	// Said to the person and the model, as this session gets them: the mod's section, and the view file in the agent's own
	// folder, carry the first 32 KB; anywhere else none reach the model.
	if (cut) warnings.push(mod || (gate.open && !outside) ? cutNotice(agent.name) : cutNoneNotice(agent.name));
	const fix =`Make git ignore .orrery/ and track nothing there, then run \`orrery claude-setup ${agent.name}\`.`;
	if (mod) {
		// The mod puts the view in the prompt: no view-file warnings, but a stale view that stays is said.
		if (gate.failed !== undefined) warnings.push(`Orrery: ${agent.name}'s old memory view file could not be removed (${gate.failed}); remove ${agent.folder}/.orrery/view.md yourself.`);
	} else if (gate.exposed !== undefined && gate.failed !== undefined) {
		warnings.push(
			`Orrery: ${gate.exposed.reason}, so ${agent.name}'s memory view must leave ${agent.folder}/.orrery/, but it could not be removed (${gate.failed}); Orrery tries again, or remove .orrery/view.md yourself. ${fix}`,
		);
	} else if (gate.exposed !== undefined) {
		warnings.push(`Orrery: ${gate.exposed.reason}, so ${agent.name}'s memory view is no longer written to ${agent.folder}/.orrery/. ${fix}`);
	} else if (gate.unchecked !== undefined) {
		warnings.push(
			`Orrery: ${agent.name}'s memory view could not be checked against git this time (${gate.unchecked}), so it is taken out of ${agent.folder}/.orrery/ until git answers again; nothing to set up, a later session puts it back.`,
		);
	} else if (setUp && outside) {
		warnings.push(`Orrery: ${agent.name} is open outside its folder, where only the Orrery mod brings its memory and instructions into Claude Code; run \`orrery claude-setup ${agent.name} --mod\`, then start a new session.`);
	} else if (setUp && !gate.open) {
		// (Where nothing is set up, the status already says what to run.)
		warnings.push(`Orrery: CLAUDE.md does not load ${agent.name}'s memory view; run \`orrery claude-setup ${agent.name}\`, then start a new session.`);
	} else if (setUp && agent.folder !== undefined && !samePath(projectDir, agent.folder)) {
		warnings.push(`Orrery: Claude Code started in a subfolder of ${agent.folder}; start it there, or CLAUDE.md may not load the memory view.`);
	}
	// For the user only (systemMessage), never the model's context; this also records the session's key.
	const summaries = notice(input, ctx) as { systemMessage?: string } | undefined;
	const status = `Orrery · ${agent.name} · ${messages === undefined ? "no memory yet" : `${messages} msgs`} · ${state}${mod && setUp ? " · memory from the Orrery mod" : ""}`;
	// A session that is not recorded because nothing was set up: the user sees that too.
	const shown = [...(setUp ? warnings : [status, ...warnings]), ...(summaries?.systemMessage ? [summaries.systemMessage] : [])];
	return {
		// With no memory yet the mod adds no section by design, so there is nothing for the model to look for.
		hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: [status, ...warnings, ...(mod && setUp && messages !== undefined ? [MOD_CHECK] : [])].join("\n").slice(0, CONTEXT_LIMIT) },
		...(shown.length > 0 ? { systemMessage: shown.join("\n") } : {}),
	};
}

/** Claude Code's answer that refuses a tool call. */
const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `Orrery guard: ${reason}` } });

/**
 * A PreToolUse input over TOOL_INPUT_MAX, refused unread, in every session: an agent's, a refused ORRERY_AGENT's, one
 * that is no agent's (spec 2026-10-19-no-agent-sessions §3), and one Claude Code does not say the folder of.
 */
function unreadToolCall(): object {
	return deny("this call's input is over 1 MB, too long to check; nothing was run.");
}

/**
 * The guard (spec §4 PreToolUse): every tool call of every session, subagents' too, whatever the memory's mode. In an
 * agent's session it may write where the session works (workArea: the agent's folder, or the folder it was opened in)
 * and the agent's allowed roots, and Claude Code's own state (claudeStateRoots). A session whose ORRERY_AGENT was refused
 * keeps the guard with the rules of the agent whose folder it runs in, or outside agents those of an agent with no folder
 * (its own folder, no allowed roots), as pi's refusedGuard does. No such session reads another agent's memory view file
 * (agentViews): a refused one is no agent's, so every agent's view is another's. A session that is no agent's (the pick
 * is none) gets Orrery's own rules alone (GuardOptions.orreryOnly, spec 2026-10-19-no-agent-sessions §3): Orrery's home,
 * its credentials file, config and installed program, every agent's memory view (agentViews with no agent), the session
 * records, and Orrery's commands in shell text. A call it cannot judge is refused, since a hook that crashed would let
 * it through: the pick too (the folder's agent, the process's decision) is made inside the check.
 */
export function preToolUse(input: HookInput, ctx: HookContext): object | undefined {
	let reason: string | undefined;
	try {
		const found = pickHere(input, ctx);
		if (found === undefined || typeof input.tool_name !== "string") return undefined;
		const { pick, projectDir } = found;
		const toolInput = typeof input.tool_input === "object" && input.tool_input !== null ? (input.tool_input as Record<string, unknown>) : {};
		const home = ctx.home ?? homedir();
		const cwd = typeof input.cwd === "string" ? input.cwd : projectDir;
		const configFile = ctx.configFile === undefined ? {} : { configFile: ctx.configFile };
		if (plainHere(pick, ctx.config, projectDir)) {
			// One guard call: the rules every path it names is judged by are worked out once (guard-paths.ts GuardCall).
			// Orrery's credentials file alone: the tools' own logins are no files of Orrery's. Every agent's view is
			// another's: the session reads no agent's memory. The Orrery home the environment names, for its program.
			reason = claudeGuard(input.tool_name, toolInput, {
				call: new GuardCall(),
				orreryOnly: true,
				folder: projectDir,
				allowedRoots: [],
				cwd,
				credentials: [ctx.config.credentialsPath],
				orreryData: ctx.config.dataDir,
				home,
				...agentViews(ctx.config),
				...configFile,
				...namedHome({ ...ctx.env, HOME: home }),
			});
		} else {
			const rules = writeRules(pick, ctx.config, projectDir);
			reason = claudeGuard(input.tool_name, toolInput, {
				call: new GuardCall(),
				folder: rules.workArea,
				allowedRoots: [...rules.allowedRoots, ...claudeStateRoots(projectDir, home, ctx.env)],
				cwd,
				credentials: [ctx.config.credentialsPath, ...movedAgentDirCredentials(ctx.env, home), ...movedConfigDirCredentials(ctx.env), ...ompCredentials(ctx.env, home), ...openCodeCredentials(ctx.env, home)],
				orreryData: ctx.config.dataDir,
				home,
				protect: ctx.config.guard.protect,
				...agentViews(ctx.config, pick.kind === "agent" ? pick.agent : undefined),
				...configFile,
			});
		}
	} catch (error) {
		reason = `this call could not be checked (${errorText(error)}).`;
	}
	return reason === undefined ? undefined : deny(reason);
}

/** The Orrery home `env` names (orreryHome), for the guard of a session that is no agent's; none when it can't be read. */
function namedHome(env: NodeJS.ProcessEnv): { readonly orreryHome?: string } {
	try {
		return { orreryHome: orreryHome(env) };
	} catch {
		return {}; // a relative ORRERY_HOME: no folder beside a config counts as Orrery's home
	}
}

/**
 * Where a session's tool calls may write: its agent's rules; a nested one's, the outer agent's, never looser than the
 * folder's own (src/agent/nested-rules.ts); a refused one's, or a nested one whose outer agent is unknown, those of the
 * agent whose folder it runs in, else of an agent with no folder.
 */
function writeRules(pick: ClaudePicked, config: HarnessConfig, projectDir: string): WriteRules {
	if (pick.kind === "agent") return { workArea: workArea(pick.agent, projectDir), allowedRoots: pick.agent.allowedRoots };
	const nested = pick.kind === "nested" ? nestedRules(config, pick.outer, projectDir) : undefined;
	if (nested !== undefined) return nested;
	const here = agentForCwd(config, projectDir);
	return { workArea: workArea(here ?? {}, projectDir), allowedRoots: here?.allowedRoots ?? [] };
}

/**
 * The hook's stdout for `event` (an empty string for "nothing to say"). `stdin` is undefined when it held more than
 * the hook keeps (hookInputMax). An unknown event throws.
 */
export async function runHook(event: string, stdin: string | undefined, ctx: HookContext): Promise<string> {
	if (!(HOOK_EVENTS as readonly string[]).includes(event)) throw new Error(`unknown hook event ${event}; expected one of ${HOOK_EVENTS.join(", ")}`);
	// Before parsing: what the hook does not keep, it does not read.
	if (stdin === undefined || Buffer.byteLength(stdin) > hookInputMax(event)) {
		const output = event === "pre-tool-use" ? unreadToolCall() : undefined;
		return output === undefined ? "" : JSON.stringify(output);
	}
	let input: HookInput;
	try {
		const parsed = JSON.parse(stdin) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "";
		input = parsed as HookInput;
	} catch {
		// Never pass on the parser's message: it quotes the input, which holds the user's words.
		return "";
	}
	// A writing hook's caller must be its Claude Code (src/claude/peer.ts), before anything is decided or written; past
	// SessionStart, the one recorded. PreToolUse only asks the guard, and keeps its speed.
	if (event !== "pre-tool-use") {
		const peer = (ctx.peer ?? stdinPeer)();
		const caller = checkCaller(ctx.config, ctx.claudePid, peer, { recorded: event !== "session-start", env: ctx.env, ...(ctx.processStart === undefined ? {} : { start: ctx.processStart }) });
		if (caller !== "ok") {
			const refused =
				event === "session-start" ? refusedStart(input, ctx, caller) : caller === "unrecorded" && (event === "user-prompt-submit" || event === "stop") ? updatedSession(input, ctx) : undefined;
			return refused === undefined ? "" : JSON.stringify(refused);
		}
		ctx = { ...ctx, peer: () => peer };
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
		case "pre-tool-use":
			output = preToolUse(input, ctx);
			break;
	}
	return output === undefined ? "" : JSON.stringify(output);
}

/**
 * `orrery holder`'s arguments for a session of `host`'s process `hostPid`: Claude Code's with --claude-pid, as always;
 * Codex's with --host-pid and --tool codex.
 */
export function holderArgs(agent: AgentConfig, session: string, nonce: string, hostPid: number, since: number, configPath?: string, host: HolderHost = "claude-code"): string[] {
	const owner = host === "codex" ? ["--host-pid", String(hostPid), "--tool", "codex"] : ["--claude-pid", String(hostPid)];
	const args = ["holder", agent.name, "--session", session, ...owner, "--nonce", nonce, "--since", String(since)];
	if (configPath !== undefined) args.push("--config", configPath);
	return args;
}

/**
 * Starts `orrery holder` detached, so it outlives this hook and its host, Claude Code or Codex (Phase 0, finding 4).
 * `since` is when SessionStart ran: a run that turns read-only drops this session's events from then on.
 */
export function spawnHolder(agent: AgentConfig, session: string, nonce: string, claudePid: number, since: number, configPath?: string, host: HolderHost = "claude-code"): void {
	const self = selfCommand(holderArgs(agent, session, nonce, claudePid, since, configPath, host));
	const child = spawn(self.cmd, self.args, { detached: true, stdio: "ignore" });
	child.on("error", () => {});
	child.unref();
}
