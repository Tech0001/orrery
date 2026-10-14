/**
 * `orrery claude-mod view` (spec 2026-10-08-claude-code-mod §4.2): what the Orrery mod in Claude Code needs from the
 * session's lane (src/claude/pick.ts: ORRERY_AGENT's, as the mod passes it on, else the folder's), as one JSON
 * document. It runs within a session, so it never claims ORRERY_AGENT_TOKEN: it finds the claim SessionStart made, for
 * its parent, the Claude Code that runs it. The reply keeps its names (`lane`): a cached older mod reads it. It opens
 * memory read-only, so it works while the holder, pi or nothing holds the lane; the holder stays the single writer. It
 * never prints message contents anywhere but the section.
 * It runs at every Claude Code session start and compaction, so it imports nothing heavy (not lane/overview.ts).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleepFor } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { safeText } from "../lane/source-labels.ts";
import type { RemoteStatus } from "../remote/types.ts";
import type { HarnessConfig, LaneConfig } from "../lane/config.ts";
import { holderFresh, readHolder } from "../lane/handover.ts";
import { AGENT_ENV, TOKEN_ENV } from "../lane/pick.ts";
import { processAlive } from "../lane/process.ts";
import { readStatus } from "../lane/status-file.ts";
import { memorySection } from "../lane/view-text.ts";
import { MemoryStore, MemoryView } from "../memory/index.ts";
import { validSession } from "./paths.ts";
import { claudePick } from "./pick.ts";
import { pendingEvents, readMode, type SessionMode } from "./spool.ts";
import { type LaneMode, laneMode } from "./view-file.ts";

const POLL_MS = 250;
/** A status.json this fresh is from a running pi (mirrors STATUS_FRESH_MS in lane/overview.ts, which is heavy to import). */
const STATUS_FRESH_MS = 30_000;

export type ModViewReply =
	| { readonly lane: null }
	| {
			readonly lane: string;
			readonly mode: LaneMode;
			readonly compactAt: number;
			readonly messages: number;
			readonly remote?: RemoteStatus;
			readonly section: string | null;
			/** In mod mode, with --session: whether that session is recorded, so a compaction may drop its older turns. */
			readonly recording?: boolean;
			/**
			 * With --session: what that session's mode file says (the holder's choice for it), left out while there is none.
			 * The mod's startup band reads it to tell a read-only window from one whose holder has not started yet.
			 */
			readonly sessionMode?: SessionMode["mode"];
	  }
	| { readonly error: string };

export interface ModViewOptions {
	readonly cwd: string;
	readonly session?: string;
	readonly waitMs?: number;
	/**
	 * The wait is for this session's spool alone, not for summaries: the mod's per-turn refetch wants the message count
	 * once the holder has taken the turn's events in, and summaries can take far longer than its short cap.
	 */
	readonly spoolOnly?: boolean;
	/** Tests replace the clock and the pause between looks. */
	readonly now?: () => number;
	readonly sleep?: (ms: number) => Promise<void>;
	/** ORRERY_AGENT and its token as the Orrery mod read them from Claude Code's environment: they stand in for it. */
	readonly agent?: string;
	readonly agentToken?: string;
	/**
	 * The environment and Claude Code's process (default: this process's environment, and its parent). Never CLAUDE_PID:
	 * Claude Code passes its own on to what its Bash tool runs, so a claude started from an agent's Bash has the agent's
	 * pid there, while this command's parent is that claude itself (the mod runs it, and orrery-run execs).
	 */
	readonly env?: NodeJS.ProcessEnv;
	readonly owner?: number;
}

/** Runs `use` on a read-only open of the lane's memory, closed again after. */
function withStore<T>(lane: LaneConfig, use: (store: MemoryStore) => T): T {
	const store = MemoryStore.openReadOnly(join(lane.dir, "memory.sqlite"));
	try {
		return use(store);
	} finally {
		store.close();
	}
}

/** Whether `session`'s own holder runs (a fresh heartbeat), so it takes that session's spooled events in. */
function ownHolder(lane: LaneConfig, session: string, now: number): boolean {
	const holder = readHolder(lane.dir);
	return holderFresh(holder, now) && holder.session === session;
}

/**
 * Whether `session` is recorded now: its holder chose recording for it, still beats and records it, and nothing of it
 * waits in the spool. A session that runs read-only (pi or another Claude Code session holds the lane), or whose holder
 * died with events spooled, is not: its older turns are not all in memory, so a compaction must not drop them.
 */
function recorded(lane: LaneConfig, session: string, now: number): boolean {
	if (readMode(lane.dir, session)?.mode !== "recording") return false;
	const holder = readHolder(lane.dir);
	if (!holderFresh(holder, now) || holder.session !== session || holder.state !== "recording") return false;
	// No `after`: pendingEvents then removes nothing.
	return pendingEvents(lane.dir, session).length === 0;
}

/** Whether pi (or anything writing status.json) is running and has said it is summarizing without trouble. */
function summarizing(lane: LaneConfig, now: number): boolean {
	const status = readStatus(lane.dir);
	if (status === undefined || status.open === false || !processAlive(status.pid)) return false;
	if (!(now - Date.parse(status.updatedAt) < STATUS_FRESH_MS)) return false;
	return (status.trouble === null || status.trouble === undefined) && status.compactor.stopped === false;
}

/** Only public, validated fields cross into the mod; status files are not trusted JSON schemas. */
function remoteStatus(value: unknown, remote: string): RemoteStatus | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const v = value as Record<string, unknown>;
	if (v.remote !== remote || !["saved", "pending", "failing", "lost"].includes(v.state as string)) return undefined;
	if ([v.savedAt, v.reason, v.movedTo].some((field) => field !== undefined && typeof field !== "string")) return undefined;
	const plain = (text: string) => safeText(stripVTControlCharacters(text));
	return {
		remote: plain(remote), state: v.state as RemoteStatus["state"],
		...(typeof v.savedAt === "string" ? { savedAt: plain(v.savedAt) } : {}),
		...(typeof v.reason === "string" ? { reason: plain(v.reason) } : {}),
		...(typeof v.movedTo === "string" ? { movedTo: plain(v.movedTo) } : {}),
	};
}

/** No network or writer open: the recorder publishes live state, and its lost session keeps the final notice. */
function remoteFields(lane: LaneConfig, session: string | undefined, now: number): { remote?: RemoteStatus } {
	if (lane.remote === undefined) return {};
	const ended = session === undefined ? undefined : remoteStatus(readMode(lane.dir, session)?.remote, lane.remote);
	if (ended?.state === "lost") return { remote: ended };
	const holder = readHolder(lane.dir);
	if (holderFresh(holder, now) && processAlive(holder.pid)) {
		const remote = remoteStatus(holder.remote, lane.remote);
		return remote === undefined ? {} : { remote };
	}
	try {
		// remote-state has no timestamp field. Its atomic replacement time is the last confirmed sync time.
		// An in-flight save has not been acknowledged: its newer mtime must never become a saved checkmark.
		const file = join(lane.dir, "remote-state.json");
		const state = JSON.parse(readFileSync(file, "utf8"));
		if (state === null || state.v !== 1 || state.remote !== lane.remote || !Number.isSafeInteger(state.save) || state.save < 0 || state.inflight !== undefined) return {};
		const time = statSync(file).mtime;
		const savedAt = `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
		return { remote: { remote: safeText(stripVTControlCharacters(lane.remote)), state: "saved", savedAt } };
	} catch {
		return {};
	}
}

export async function modView(config: HarnessConfig | undefined, options: ModViewOptions): Promise<ModViewReply> {
	try {
		if (config === undefined) return { lane: null };
		// The session's lane (src/claude/pick.ts): the agent the mod passed on, else ORRERY_AGENT here, else the folder's.
		const base = options.env ?? process.env;
		const env = options.agent === undefined ? base : { ...base, [AGENT_ENV]: options.agent, [TOKEN_ENV]: options.agentToken ?? base[TOKEN_ENV] };
		const picked = claudePick(config, { env, cwd: options.cwd, owner: options.owner ?? process.ppid, takeover: false });
		if (picked.kind !== "lane") return { lane: null };
		const { lane } = picked;
		const { session } = options;
		if (session !== undefined && !validSession(session)) return { error: "not a Claude Code session id" };
		const mode = laneMode(lane);
		const now = options.now ?? Date.now;
		const remote = () => remoteFields(lane, session, now());
		const exists = existsSync(join(lane.dir, "memory.sqlite"));
		/** What this session's mode file says now, when asked with the session and the file exists. */
		const sessionMode = (): { sessionMode?: SessionMode["mode"] } => {
			const chosen = session === undefined ? undefined : readMode(lane.dir, session)?.mode;
			return chosen === undefined ? {} : { sessionMode: chosen };
		};
		if (mode !== "mod") {
			const messages = exists ? withStore(lane, (store) => store.root.length) : 0;
			return { lane: lane.name, mode, compactAt: lane.compactAt, messages, section: null, ...sessionMode(), ...remote() };
		}
		const recording = (): { recording?: boolean; sessionMode?: SessionMode["mode"] } => (session === undefined ? {} : { recording: recorded(lane, session, now()), ...sessionMode() });
		if (!exists) return { lane: lane.name, mode, compactAt: lane.compactAt, messages: 0, section: null, ...recording(), ...remote() };
		const waitMs = options.waitMs ?? 0;
		if (waitMs > 0) {
			const sleep = options.sleep ?? ((ms: number) => sleepFor(ms));
			const deadline = now() + waitMs;
			for (;;) {
				// Only this session's own holder takes its events in. No `after`: pendingEvents then removes nothing.
				const spoolBusy = session !== undefined && ownHolder(lane, session, now()) && pendingEvents(lane.dir, session).length > 0;
				const settled = () => withStore(lane, (store) => new MemoryView(store, lane.memory.viewBytes).settled);
				if (!spoolBusy && (options.spoolOnly === true || !summarizing(lane, now()) || settled())) break;
				if (now() >= deadline) break;
				await sleep(POLL_MS);
			}
		}
		// After the wait: events still spooled now are not in the view.
		const said = recording();
		return withStore(lane, (store) => {
			const view = new MemoryView(store, lane.memory.viewBytes);
			return { lane: lane.name, mode, compactAt: lane.compactAt, messages: store.root.length, section: memorySection(view, "claude-mod"), ...said, ...remote() };
		});
	} catch (error) {
		const text = error instanceof Error ? error.message : String(error);
		return { error: text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 300) };
	}
}
