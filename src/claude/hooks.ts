/**
 * Claude Code's hooks (spec §4 "Hooks"), run as `orrery claude-hook <event>` with the hook's JSON on stdin.
 * - They find the session's agent (src/claude/pick.ts): the one ORRERY_AGENT names, in any folder, else the one whose
 *   folder holds the project folder (CLAUDE_PROJECT_DIR, else the hook's cwd). Under ORRERY_AGENT that is decided
 *   once for Claude Code's process (CLAUDE_PID, which Claude Code sets for its hooks): by the MCP server or the first
 *   SessionStart, and read by every later event.
 * - They never write the store, and they return quickly: SessionEnd gets about 1.5 s.
 * - Subagent events (agent_id) are not memory.
 * - Outside an agent they print and write nothing. An ORRERY_AGENT that is refused (it names no agent, its token is
 *   malformed, the folder is another agent's set up the file way, or the process's decision could not be recorded or is
 *   missing) gets a notice at SessionStart, records nothing, and keeps the guard.
 * - They record only where `orrery claude-setup` ran: in mod mode in any folder, in file mode for the agent's
 *   folder. In any other agent they start no holder and spool nothing, SessionStart says the session is not recorded,
 *   and the guard still applies.
 * - Their stdout is only their JSON answer, and they never put message contents on stderr.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { type HarnessConfig, type AgentConfig, agentForCwd } from "../agent/config.ts";
import { agentViews, GuardCall, movedAgentDirCredentials, ompCredentials, openCodeCredentials } from "../agent/guard-paths.ts";
import { cutNotice, readInstructions } from "../agent/instructions.ts";
import { workArea } from "../agent/pick.ts";
import { writePrivate } from "../agent/private-file.ts";
import { selfCommand } from "../agent/running.ts";
import { safeText } from "../agent/source-labels.ts";
import { type HolderHost, holderFresh, openElsewhere, readHolder } from "../agent/handover.ts";
import { claudeGuard, claudeStateRoots, movedConfigDirCredentials } from "./guard.ts";
import { summaryNotice, updateNotice } from "./notices.ts";
import { holderLog, samePath, validSession } from "./paths.ts";
import { type ClaudePicked, claudeRefusedNotice, claudeSession, forgetProcess } from "./pick.ts";
import { readMode, type SessionMode, spoolEvent } from "./spool.ts";
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
	/** Claude Code's process: CLAUDE_PID, else the hook's parent. */
	readonly claudePid: number;
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
	return claudeSession(ctx.config, { env: ctx.env, cwd: projectDir, pid: ctx.claudePid, decide: start });
}

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
		if (!slashCommand(input)) spoolEvent(at.agent.dir, at.session, { kind: "prompt", at: Date.now(), claudePid: ctx.claudePid, text: input.prompt });
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
	if (input.agent_id === undefined && (input.reason === "prompt_input_exit" || input.reason === "other")) forgetProcess(ctx.config, ctx.claudePid);
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
	// A refused ORRERY_AGENT: said once, to the person, in the main session; nothing is recorded.
	if (pick.kind !== "agent") return input.agent_id === undefined ? { systemMessage: claudeRefusedNotice(pick) } : undefined;
	const { agent } = pick;
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
	let state = "recording";
	if (!setUp) state = `not set up for Claude Code here, so this session is not recorded; run \`orrery claude-setup ${agent.name}\` to record it`;
	else {
		const holder = readHolder(agent.dir);
		let mode: SessionMode | undefined;
		if (holderFresh(holder) && holder.session === session && holder.state === "recording") mode = readMode(agent.dir, session);
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
 * A PreToolUse input over TOOL_INPUT_MAX, refused unread: wherever the guard runs (an agent's session, or a refused
 * ORRERY_AGENT's, by CLAUDE_PROJECT_DIR), and when Claude Code does not say where the call runs, since only the unread
 * input would.
 */
function unreadToolCall(ctx: HookContext): object | undefined {
	const projectDir = ctx.env.CLAUDE_PROJECT_DIR;
	try {
		if (projectDir && pickFor(ctx, projectDir).kind === "none") return undefined;
	} catch (error) {
		// A pick that cannot be made is no proof the folder is no agent's.
		return deny(`this call could not be checked (${errorText(error)}).`);
	}
	return deny("this call's input is over 1 MB, too long to check; nothing was run.");
}

/**
 * The guard (spec §4 PreToolUse): every tool call of an agent's session, subagents' too, whatever the memory's mode. It
 * may write where the session works (workArea: the agent's folder, or the folder it was opened in) and the agent's
 * allowed roots, and Claude Code's own state (claudeStateRoots). A session whose ORRERY_AGENT was refused keeps the
 * guard with the rules of the agent whose folder it runs in, or outside agents those of an agent with no folder (its own
 * folder, no allowed roots), as pi's refusedGuard does. No session reads another agent's memory view file (agentViews):
 * a refused one is no agent's, so every agent's view is another's. A call it cannot judge is refused, since a hook that
 * crashed would let it through: the pick too (the folder's agent, the process's decision) is made inside the check.
 */
export function preToolUse(input: HookInput, ctx: HookContext): object | undefined {
	let reason: string | undefined;
	try {
		const found = pickHere(input, ctx);
		if (found === undefined || found.pick.kind === "none" || typeof input.tool_name !== "string") return undefined;
		const { pick, projectDir } = found;
		const rules = pick.kind === "agent" ? pick.agent : agentForCwd(ctx.config, projectDir);
		const toolInput = typeof input.tool_input === "object" && input.tool_input !== null ? (input.tool_input as Record<string, unknown>) : {};
		const home = ctx.home ?? homedir();
		reason = claudeGuard(input.tool_name, toolInput, {
			// One guard call: the rules every path it names is judged by are worked out once (guard-paths.ts GuardCall).
			call: new GuardCall(),
			folder: workArea(rules ?? {}, projectDir),
			allowedRoots: [...(rules?.allowedRoots ?? []), ...claudeStateRoots(projectDir, home, ctx.env)],
			cwd: typeof input.cwd === "string" ? input.cwd : projectDir,
			credentials: [ctx.config.credentialsPath, ...movedAgentDirCredentials(ctx.env, home), ...movedConfigDirCredentials(ctx.env), ...ompCredentials(ctx.env, home), ...openCodeCredentials(ctx.env, home)],
			orreryData: ctx.config.dataDir,
			home,
			protect: ctx.config.guard.protect,
			...agentViews(ctx.config, pick.kind === "agent" ? pick.agent : undefined),
			...(ctx.configFile === undefined ? {} : { configFile: ctx.configFile }),
		});
	} catch (error) {
		reason = `this call could not be checked (${errorText(error)}).`;
	}
	return reason === undefined ? undefined : deny(reason);
}

/**
 * The hook's stdout for `event` (an empty string for "nothing to say"). `stdin` is undefined when it held more than
 * the hook keeps (hookInputMax). An unknown event throws.
 */
export async function runHook(event: string, stdin: string | undefined, ctx: HookContext): Promise<string> {
	if (!(HOOK_EVENTS as readonly string[]).includes(event)) throw new Error(`unknown hook event ${event}; expected one of ${HOOK_EVENTS.join(", ")}`);
	// Before parsing: what the hook does not keep, it does not read.
	if (stdin === undefined || Buffer.byteLength(stdin) > hookInputMax(event)) {
		const output = event === "pre-tool-use" ? unreadToolCall(ctx) : undefined;
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
