/**
 * The Antigravity CLI's hooks (spec 2026-11-20-antigravity-design, "Hooks"), run as `orrery agy-hook <event>` with
 * agy's JSON on stdin. Orrery's hooks are global (Antigravity's ~/.gemini/config/hooks.json), so they run in every agy
 * session, a plain one's and a subagent's conversation included:
 * - pre-invocation, before every model call (agy fires no SessionStart on a resume, so this is where a conversation is
 *   taken): for the person's own conversation of an agy opened as an agent, decides the agent (the first asker may claim
 *   its token), records agy as the agent's session host, starts the recorder, and gives the model the agent's memory
 *   view and instructions as system messages when it has none since the last compaction (in chunks agy keeps whole).
 * - stop, at each turn's end: a mark for the recorder, which records the turns the transcript shows over, in its words.
 * - pre-tool-use is the guard (src/antigravity/guard.ts), answered in src/cli/main.ts.
 * A plain agy (no ORRERY_AGENT) gets nothing here: Orrery's hook script answers for it before Orrery runs.
 *
 * agy runs a hook through a shell, so the agent's own shell can run this command with made-up input and its own
 * environment. So nothing an event says is taken that such a call could abuse:
 * - Whose session it is comes from the agy process's own start environment (src/codex/pick.ts launchedEnv), never the
 *   hook's: a hook whose own environment names another agent or token is refused (src/cli/main.ts).
 * - A conversation is taken only when agy holds its presence lock open for writing under the Antigravity folder of its
 *   start HOME (src/antigravity/host.ts ownConversation), and only when no other process's session record names it.
 * - Words are never taken from the input: the recorder reads them from that folder's transcript of the conversation
 *   (src/antigravity/transcript.ts), which no tool may write (src/antigravity/guard-rules.ts). A made-up stop mark only
 *   makes the recorder read the transcript again.
 * - A subagent's conversation (whose transcript starts with no typed prompt) is not the person's: no view, nothing
 *   recorded. Its tool calls are still guarded.
 * They never fail the session: their answer on stdout (agy ignores a PreInvocation hook that fails), errors on stderr
 * with no message contents.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AgentConfig, HarnessConfig } from "../agent/config.ts";
import { holderFresh, openElsewhere, readHolder } from "../agent/handover.ts";
import { cutNotice, instructionsSection, readInstructions } from "../agent/instructions.ts";
import { readMemory } from "../agent/memory-read.ts";
import type { OpenFile } from "../agent/open-files.ts";
import { AGENT_ENV, agentNamed } from "../agent/pick.ts";
import type { PlainDeps } from "../agent/plain-nested.ts";
import { readPrivate, writePrivate } from "../agent/private-file.ts";
import { agentFiles } from "../agent/real-data.ts";
import { antigravitySessionHosts, hostReason, liveSession, nestedNotice, plainFields, recordSession, type SessionRecord } from "../agent/sessions.ts";
import { safeText } from "../agent/source-labels.ts";
import { NOT_RECORDED, type StatusState, statusText } from "../agent/status-text.ts";
import { noticeShownBefore, waitForMode } from "../claude/hooks.ts";
import { settleView } from "../claude/mod-view.ts";
import { summaryNotice, updateNotice } from "../claude/notices.ts";
import { holderLog } from "../claude/paths.ts";
import { readMode, type SessionMode, spoolEvent } from "../claude/spool.ts";
import { antigravityAgent } from "../codex/pick.ts";
import { ownConversation, validConversation } from "./host.ts";
import { AGY_HOOK_EVENTS } from "./names.ts";
import { type AgyScan, chunksOf, EMPTY_SCAN, scanOn, VIEW_MARK } from "./transcript.ts";

export { AGY_HOOK_EVENTS };

/** The most UTF-8 bytes one injected step holds: agy cuts a step past about 48,000 (seen live). */
export const CHUNK_BYTES = 40_000;

/** What a hook runs with: the config, agy's environment as it was started, its process and how to start a holder. */
export interface AgyHookContext {
	readonly config: HarnessConfig;
	/** The hook's environment, with ORRERY_AGENT and its token as agy was started with them (launchedEnv). */
	readonly env: NodeJS.ProcessEnv;
	/** agy's start HOME: its folder is under it. */
	readonly home: string | undefined;
	readonly agyPid: number;
	/** The hook's parent, when agyPid was reached past shells (src/codex/pick.ts); undefined: no check. */
	readonly agyParent?: number;
	readonly openFiles?: (pid: number) => readonly OpenFile[] | undefined;
	readonly startHolder: (agent: AgentConfig, session: string, nonce: string, since: number) => void;
	/** How long the first PreInvocation waits for the holder's choice (default 8 s). */
	readonly modeWaitMs?: number;
	/** How long a view after a compaction waits for the summaries (default 10 s). */
	readonly settleMs?: number;
	readonly alive?: (pid: number) => boolean;
	readonly updateNotices?: boolean;
	readonly plain?: PlainDeps;
}

/** The fields read from agy's input; each is checked before use. */
interface AgyHookInput {
	readonly conversationId?: unknown;
	readonly fullyIdle?: unknown;
}

/** What PreInvocation keeps of a conversation between calls: where its scan stopped, and what it did. */
interface ConversationState {
	readonly scan?: AgyScan;
	/** The checkpoint step the view was last given after (-1: from the start). */
	readonly injected?: number;
	/** The last refusal said, so it is said once. */
	readonly told?: string;
}

const statesDir = (dataDir: string) => join(dataDir, "antigravity-conversations");
const stateFile = (dataDir: string, conversation: string) => join(statesDir(dataDir), `${conversation}.json`);

function readState(dataDir: string, conversation: string): ConversationState {
	try {
		const value = JSON.parse(readPrivate(stateFile(dataDir, conversation), 64 * 1024)) as ConversationState;
		return typeof value === "object" && value !== null ? value : {};
	} catch {
		return {};
	}
}

function writeState(dataDir: string, conversation: string, state: ConversationState): void {
	try {
		writePrivate(stateFile(dataDir, conversation), JSON.stringify(state));
	} catch {
		// Next time it is worked out again.
	}
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Whether this agy was opened as an agent: ORRERY_AGENT set, as it was started. */
const opened = (ctx: AgyHookContext) => (ctx.env[AGENT_ENV]?.trim() ?? "") !== "";

/** agy's answer that gives the model `texts` as system messages. */
const inject = (texts: readonly string[]) => ({ injectSteps: texts.map((text) => ({ systemMessage: { systemMessage: text } })) });

/** This agy's host record, when it names a conversation. */
function hostRecord(ctx: AgyHookContext): (SessionRecord & { readonly antigravitySession: string }) | undefined {
	const record = liveSession(ctx.config.dataDir, ctx.agyPid);
	return record?.tool === "antigravity" && record.antigravitySession !== undefined ? (record as SessionRecord & { readonly antigravitySession: string }) : undefined;
}

/** Other processes' live or unsure records that name `conversation`, where the config's and the agent's data are. */
function hostsElsewhere(ctx: AgyHookContext, conversation: string, agent: AgentConfig | undefined) {
	const dirs = [ctx.config.dataDir, ...(agent === undefined ? [] : [agent.dir, ...agentFiles(agent.dir)])];
	return antigravitySessionHosts(dirs, conversation, ctx.agyPid);
}

/** This conversation's summary and update notices, one per line, never an error. */
function noticeLines(agent: AgentConfig, session: string, ctx: AgyHookContext): string[] {
	const lines: string[] = [];
	const add = (read: () => string | undefined) => {
		try {
			const message = read();
			if (message !== undefined) lines.push(message);
		} catch {
			// left out
		}
	};
	add(() => summaryNotice(agent, session, `orrery compactor ${agent.name}`));
	if (ctx.updateNotices === true) add(() => updateNotice(agent, session, ctx.env, ctx.config.updates.check));
	return lines;
}

/**
 * The view the model gets (spec "How it works"): a status line and what Orrery has to say, then the agent's instructions,
 * then its memory section, in chunks of at most CHUNK_BYTES, each starting with VIEW_MARK, by which a later scan finds it.
 */
export function viewChunks(agent: AgentConfig, head: readonly string[], readOnly: boolean): string[] {
	const parts: string[] = [...head];
	const instructions = readInstructions(agent.dir);
	if (instructions !== undefined) {
		parts.push(instructionsSection(agent.name, instructions));
		if (instructions.cut === true) parts.push(cutNotice(agent.name));
	}
	try {
		const memory = readMemory(agent, true, "antigravity", { readOnly });
		if (memory.section !== undefined) parts.push(memory.section);
	} catch (error) {
		parts.push(`Orrery: ${agent.name}'s memory could not be read: ${safeText(errorText(error))}`);
	}
	const chunks = chunksOf(parts.join("\n\n"), CHUNK_BYTES - 200);
	return chunks.map((chunk, at) => `${VIEW_MARK} for ${agent.name}, part ${at + 1} of ${chunks.length}.\n\n${chunk}`);
}

/** PreInvocation (module doc): the conversation taken, its recorder started, and the view when it has none. */
export async function preInvocation(input: AgyHookInput, ctx: AgyHookContext): Promise<object | undefined> {
	const conversation = input.conversationId;
	if (!validConversation(conversation) || !opened(ctx)) return undefined;
	const { dataDir } = ctx.config;
	const state = readState(dataDir, conversation);
	/** Says `text` to the model once per conversation (a refusal): nothing is recorded, and no view is given. */
	const once = (text: string) => {
		if (state.told === text) return undefined;
		writeState(dataDir, conversation, { ...state, told: text });
		return inject([text]);
	};
	const refuse = (why: string) => once(`Orrery: can't confirm this is this Antigravity's own conversation (${safeText(why)}), so it isn't recorded and has no memory.`);
	// Before anything is decided, claimed or recorded: is this conversation agy's own?
	const own = ownConversation(ctx.agyPid, conversation, ctx.home, ctx.openFiles);
	if (typeof own === "string") return refuse(own);
	const scan = scanOn(own.transcript, state.scan ?? EMPTY_SCAN);
	if (scan === undefined) return refuse("its record can't be read");
	// A subagent's conversation, or none written yet: not the person's.
	if (scan.own !== true) {
		writeState(dataDir, conversation, { ...state, scan });
		return undefined;
	}
	const asked = agentNamed(ctx.config, ctx.env[AGENT_ENV]?.trim() ?? "");
	const elsewhere = hostsElsewhere(ctx, conversation, asked)[0];
	if (elsewhere !== undefined) return refuse(hostReason(elsewhere, "Antigravity"));
	const live = liveSession(dataDir, ctx.agyPid);
	if (live?.tool === "antigravity" && asked !== undefined && live.agent !== asked.name) {
		return once(`Orrery: this Antigravity hosts ${safeText(live.agent)}'s session, so this conversation isn't recorded as ${safeText(asked.name)}'s.`);
	}
	const pick = antigravityAgent(ctx.config, {
		env: ctx.env,
		pid: ctx.agyPid,
		takeover: true,
		session: conversation,
		...(ctx.agyParent === undefined ? {} : { parent: ctx.agyParent }),
		...(ctx.alive === undefined ? {} : { alive: ctx.alive }),
		...(ctx.plain === undefined ? {} : { plain: ctx.plain }),
	});
	if (pick.kind === "refused") return once(pick.notice);
	if (pick.kind === "nested") return once(nestedNotice({ agent: pick.outer, tool: pick.tool, via: "ancestry", dataDir: "", ...plainFields(pick) }));
	const { agent } = pick;
	const warnings: string[] = [];
	if (pick.notRecorded !== undefined) warnings.push(`Orrery: which agent this Antigravity is could not be recorded (${safeText(pick.notRecorded)}).`);
	const recorded = hostRecord(ctx);
	const current = recorded?.antigravitySession === conversation && recorded.agent === agent.name;
	const hosted = current || recordSession(dataDir, { agent: agent.name, tool: "antigravity", pid: ctx.agyPid, antigravitySession: conversation, config: ctx.config.file });
	const since = Date.now();
	// Where the recorder reads from: the prompt in progress (a resumed conversation's earlier turns are behind it).
	if (hosted && !current) spoolEvent(agent.dir, conversation, { kind: "agy-log", at: since, claudePid: ctx.agyPid, path: own.transcript, folder: own.folder, step: Math.max(scan.prompt, 0) });
	let state2: StatusState = "recording";
	let mode: SessionMode | undefined;
	if (!hosted) {
		state2 = NOT_RECORDED;
		warnings.push(`Orrery: this conversation could not be recorded as ${agent.name}'s, so it isn't recorded.`);
	} else {
		const holder = readHolder(agent.dir);
		if (holderFresh(holder) && holder.session === conversation && holder.state === "recording") mode = readMode(agent.dir, conversation);
		else {
			const nonce = randomUUID();
			ctx.startHolder(agent, conversation, nonce, since);
			mode = await waitForMode(agent.dir, conversation, nonce, ctx.modeWaitMs ?? 8000);
		}
		const held = mode?.mode === "read-only" && (mode.reason === undefined || mode.reason === "held");
		if (mode === undefined) {
			state2 = "not recording yet";
			warnings.push(`Orrery: ${agent.name}'s recorder did not answer in time; see ${holderLog(agent.dir)}.`);
		} else if (mode.mode === "read-only") {
			state2 = NOT_RECORDED;
			if (held) warnings.push(`Orrery: ${agent.name} is ${openElsewhere(agent.dir, "antigravity")}; this conversation reads memory but is not recorded.`);
		}
		const reason = mode?.reason;
		if (!held && typeof reason === "string" && !(mode?.mode === "recording" && noticeShownBefore(agent.dir, conversation, mode.nonce))) warnings.push(safeText(reason));
	}
	// The view: none since the last compaction, and not given for it already.
	const wanted = (scan.view === -1 || scan.view < scan.checkpoint) && state.injected !== scan.checkpoint;
	if (!wanted) {
		writeState(dataDir, conversation, { ...state, scan });
		return undefined;
	}
	if (scan.checkpoint >= 0) {
		try {
			await settleView(agent, conversation, { waitMs: ctx.settleMs ?? 10_000 });
		} catch {
			// the view as it is
		}
	}
	let messages: number | undefined;
	try {
		messages = readMemory(agent, false).messages;
	} catch {
		// said with the view
	}
	const head = [statusText({ name: agent.name, count: messages, state: state2 }), ...warnings, ...noticeLines(agent, conversation, ctx)];
	const chunks = viewChunks(agent, head, state2 !== "recording" && state2 !== "not recording yet");
	writeState(dataDir, conversation, { ...state, scan, injected: scan.checkpoint });
	return inject(chunks);
}

/** Stop: a turn mark for the recorder (module doc), for the conversation this agy's host record names. */
export function stop(input: AgyHookInput, ctx: AgyHookContext): void {
	const conversation = input.conversationId;
	if (!validConversation(conversation) || !opened(ctx)) return;
	const host = hostRecord(ctx);
	if (host === undefined || host.antigravitySession !== conversation) return;
	const pick = antigravityAgent(ctx.config, { env: ctx.env, pid: ctx.agyPid, takeover: false, session: conversation, ...(ctx.agyParent === undefined ? {} : { parent: ctx.agyParent }), ...(ctx.alive === undefined ? {} : { alive: ctx.alive }) });
	if (pick.kind !== "agent" || pick.agent.name !== host.agent) return;
	if (readMode(pick.agent.dir, conversation)?.mode === "read-only") return;
	if (hostsElsewhere(ctx, conversation, pick.agent).length > 0) return;
	spoolEvent(pick.agent.dir, conversation, { kind: "agy-turn", at: Date.now(), claudePid: ctx.agyPid, over: input.fullyIdle === true });
}

/** The hook's stdout for `event` (never empty: agy reads JSON). An event it does not know throws. */
export async function runAgyHook(event: string, stdin: string, ctx: AgyHookContext): Promise<string> {
	if (!(AGY_HOOK_EVENTS as readonly string[]).includes(event) || event === "pre-tool-use") throw new Error(`unknown hook event ${event}; expected pre-invocation or stop`);
	let input: AgyHookInput = {};
	try {
		const parsed = JSON.parse(stdin) as unknown;
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) input = parsed as AgyHookInput;
	} catch {
		// Never the parser's message: it quotes the input.
	}
	if (event === "stop") {
		stop(input, ctx);
		return JSON.stringify({ decision: "stop" });
	}
	if (event === "session-start") return "{}";
	const output = await preInvocation(input, ctx);
	return JSON.stringify(output ?? {});
}
