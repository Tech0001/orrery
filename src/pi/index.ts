/**
 * orrery inside pi: a lane folder, or any folder when ORRERY_AGENT names a lane, gets OptChat memory (spec
 * 2026-10-06-pi-extension-design; src/lane/pick.ts). Install with a one-line ~/.pi/agent/extensions/orrery.ts that
 * re-exports this file by absolute path (docs/pi.md); a symlink to this directory breaks the relative imports, because pi
 * resolves them from the link. Anywhere else this extension does nothing.
 * In OMP, src/omp/index.ts builds this with `host: "omp"` (docs/omp.md).
 */

import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { defaultConfigPath, type HarnessConfig, type LaneConfig, laneForCwd, loadConfig } from "../lane/config.ts";
import { holderFresh, openYielding, readHolder } from "../lane/handover.ts";
import { orreryHome } from "../lane/home.ts";
import { compactorCommand } from "../lane/lane-commands.ts";
import { laneModelSource } from "../lane/model-source.ts";
import { noticeKey, noticeText, type TroubleState } from "../lane/notices.ts";
import { pickLane, refusedNotice, workArea } from "../lane/pick.ts";
import { NO_AGENT, noteSession, sessionStanding, settleVisit } from "../lane/session-owner.ts";
import { takeRequest } from "../lane/settings-request.ts";
import { safeText } from "../lane/source-labels.ts";
import { openSummarySources, type SummarySources } from "../lane/summary-sources.ts";
import { runCompactorText } from "../lane/summary-text.ts";
import { browse, memoryReport, pageOpener } from "./commands.ts";
import { compactorMenu, laneTarget, signInFromMenu } from "../lane/compactor-menu.ts";
import { LaneHeld, PiLane } from "./lane.ts";
import { copySession, markSessionCopied, moveCursor, startAtTail } from "./log.ts";
import { guardOmpToolCall, guardToolCall, laneViews, movedAgentDirCredentials, ompCredentials } from "./guard.ts";
import { memoryTools, readerTools } from "./tools.ts";
import { compactionDecision, memorySection, trimToRun } from "./turn.ts";
import { remoteFooter, remoteOpenNotice } from "../remote/checkout.ts";
import { abortable } from "../remote/open-cancellation.ts";
import { heldMessage } from "../remote/session.ts";
import type { LockState, Storage } from "../remote/types.ts";

/** OMP's session_switch, session_branch and session_before_branch, as far as Orrery reads them. */
interface SessionEvent {
	readonly type?: string;
	readonly reason?: string;
	/** session_before_branch: the entry the branch starts at. */
	readonly entryId?: string;
}

/** What switching OMP's own features off in a lane came to (src/omp/settings.ts), and what takes it back. */
export type LaneSettingsResult = ({ readonly applied: true } | { readonly applied: false; readonly why: string }) & {
	/** Takes back what was switched, when the session leaves the lane's folder; may throw when OMP would not take it back. */
	readonly restore?: () => void;
};

/** The footer's ending when OMP's own compaction and memory could not be switched off. */
export const SETTINGS_NOT_APPLIED = " · OMP settings not applied";

export interface OrreryState {
	lane?: PiLane;
	/** Shutdown and moves join this work, so an eventual checkout can never be orphaned. */
	opening?: Promise<void>;
	/** When the previous run ended (agent_end), or the session started. */
	lastEnd?: number;
	/** `lastEnd` as it was when the current run began: the user's !cmd output from then on goes with this run. */
	runSince?: number;
	/** The lane whose folder this pi runs in: its guard applies even when its memory did not open. */
	guarded?: Guarded;
	runStart?: number;
	timer?: ReturnType<typeof setInterval>;
	/** orrery's logins and models, which the lane summarizes with and /compactor picks from. */
	sources?: SummarySources;
	/** What the user was last told about summaries (notices.ts noticeKey). */
	notice?: string;
	/** OMP: SETTINGS_NOT_APPLIED when its own features stayed on. */
	settingsNote?: string;
	/** The config the session started with: OMP re-checks which lane a moved session's folder is in against it. */
	config?: HarnessConfig;
	/** OMP: takes back its settings Orrery switched off, when the session leaves the lane's folder. */
	restoreSettings?: () => void;
	/**
	 * When the host loaded the session now open (as close as the extension sees it: the session_start or switch that
	 * says so). A visit mark written since stays when the lane settles the visit (src/lane/session-owner.ts).
	 */
	loadedAt?: number;
}

export interface OrreryOptions {
	readonly config?: HarnessConfig;
	/** The longest a message waits for pending summaries before it goes with placeholders (default 60 s; in OMP 25 s from the start of the hook, see summaryWaitMs). */
	readonly memoryWaitMs?: number;
	readonly onLane?: (lane: PiLane | undefined) => void;
	/** Opens /browse's page; default: the desktop's opener (xdg-open, open), none without a display. */
	readonly openPage?: (path: string) => void;
	/** orrery's logins and models for summaries; default openSummarySources. Tests pass a faux one. */
	readonly summarySources?: (config: HarnessConfig, lane?: LaneConfig) => Promise<SummarySources>;
	/** How often the status and request tick runs (default 5000 ms; tests shorten it). */
	readonly tickMs?: number;
	/** The tool this runs in: pi (default) or OMP, whose extension API differs in a few places (spec 2026-10-10-omp-design). */
	readonly host?: "pi" | "omp";
	/** OMP only: switches its own compaction, memory, project CLAUDE.md and titles off for the session, in the lane whose folder is `workspace` (src/omp/settings.ts). */
	readonly laneSettings?: (ctx: ExtensionContext, workspace: string) => Promise<LaneSettingsResult>;
	/** The environment the guard finds moved credential folders in (PI_CODING_AGENT_DIR, XDG_DATA_HOME); default process.env. Tests pass a scratch one. */
	readonly env?: NodeJS.ProcessEnv;
	/** The home folder whose credential files the guard keeps out, and "~" means; default the OS's. Tests pass a scratch one. */
	readonly home?: string;
	/** Remote transport injection for integration tests; production opens the configured storage. */
	readonly remoteStorage?: (config: HarnessConfig, remote: string) => Storage;
	/** The process ORRERY_AGENT_TOKEN claims are made for (src/lane/pick.ts); default this process. Tests pass another. */
	readonly owner?: number;
}

/** What the lane guard judges a tool call against: where the session may write, every credential file, and "~". */
interface Guarded {
	/** The session's lane; absent when its ORRERY_AGENT was refused (then the guard alone runs, with no memory). */
	readonly lane?: LaneConfig;
	/**
	 * How the session found its lane: ORRERY_AGENT, its folder, or neither, because ORRERY_AGENT was refused or Orrery's
	 * config could not be read (unreadableGuard).
	 */
	readonly by: "env" | "folder" | "refused" | "unreadable";
	/** Where writes may go besides allowedRoots (src/lane/pick.ts workArea). */
	readonly workArea: string;
	readonly allowedRoots: readonly string[];
	readonly credentials: readonly string[];
	readonly orreryData: string;
	readonly home: string;
	/** Every other lane's memory view file, which no tool may read (src/lane/guard-paths.ts laneViews). */
	readonly foreignViews: readonly string[];
	/** Of those, the ones whose lane is set up Claude Code's file way: searches stay away even before they are written. */
	readonly fileModeViews: readonly string[];
	/** The session's own lane's view file, if it has one. */
	readonly ownView?: string;
	/** The config file the session read (or could not read): read-only, and named in no command. */
	readonly configFile?: string;
}

/** The file each config the extension read came from (orreryConfig); none for a config passed in (OrreryOptions.config). */
const configFiles = new WeakMap<HarnessConfig, string>();

/** What every guard keeps out: orrery's credentials, pi's in a moved agent dir, OMP's stores (in every tool), and the config's file from writes. */
function guardBase(config: HarnessConfig, options: OrreryOptions): Pick<Guarded, "credentials" | "orreryData" | "home" | "configFile"> {
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	const configFile = configFiles.get(config);
	return {
		home,
		orreryData: config.dataDir,
		credentials: [config.credentialsPath, ...movedAgentDirCredentials(env, home), ...ompCredentials(env, home)],
		...(configFile === undefined ? {} : { configFile }),
	};
}

/**
 * The guard for a session that starts while Orrery's config is there (or named) but cannot be read: no lane and no
 * memory, and the default rules, since a guard that cannot judge refuses. The session's folder is its work area, with no
 * allowed roots. Orrery's default home is kept out (where the config would put the data is unknown), and so are the
 * logins beside it and beside the config, every other credential store, every lane's view by name, and the config file.
 */
function unreadableGuard(file: string, cwd: string, options: OrreryOptions): Guarded {
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	let data: string;
	try {
		data = orreryHome({ ...env, HOME: home });
	} catch {
		data = join(home, ".orrery"); // a relative ORRERY_HOME: the default home
	}
	const credentials = [join(data, "credentials.json"), join(dirname(resolve(file)), "credentials.json"), ...movedAgentDirCredentials(env, home), ...ompCredentials(env, home)];
	return { by: "unreadable", workArea: workArea({}, cwd), allowedRoots: [], home, orreryData: data, credentials, foreignViews: [], fileModeViews: [], configFile: file };
}

/** The guard for `lane` in `cwd`: no other lane's view. */
function guarded(lane: LaneConfig, by: "env" | "folder", cwd: string, config: HarnessConfig, options: OrreryOptions): Guarded {
	return { lane, by, workArea: workArea(lane, cwd), allowedRoots: lane.allowedRoots, ...guardBase(config, options), ...laneViews(config, lane) };
}

/**
 * The guard for a session whose ORRERY_AGENT was refused: no lane and no memory, but the same rules as the lane whose
 * folder it runs in, or, outside lanes, an agent's with no default folder (the session's folder, no allowed roots). It
 * is no lane's, so every lane's view is another's, the folder's lane's too.
 */
function refusedGuard(cwd: string, config: HarnessConfig, options: OrreryOptions): Guarded {
	const rules = laneForCwd(config, cwd);
	return { by: "refused", workArea: workArea(rules ?? {}, cwd), allowedRoots: rules?.allowedRoots ?? [], ...guardBase(config, options), ...laneViews(config) };
}

const subagent = (ctx: ExtensionContext) => (ctx as { agent?: { kind?: string } }).agent?.kind === "sub";

/**
 * Notes that the agent this session runs as (its lane, or NO_AGENT under a refused ORRERY_AGENT) ran in the session now
 * open (src/lane/session-owner.ts): when it opens, at each message's and run's end, and at shutdown, so a visitor still
 * running after the owner opened marks the turns it says later, even one killed before its run ended. Both entries do
 * it, the other tool's too. Not in OMP subagents. Cheap, and it never throws: a note that fails never stops a message,
 * a run's end or a shutdown (which releases the lane); the session then has no record, as before.
 */
function noteRun(state: OrreryState, ctx: ExtensionContext): void {
	if (state.config === undefined || state.guarded === undefined || subagent(ctx)) return;
	try {
		noteSession(state.config.dataDir, ctx.sessionManager.getSessionId(), state.guarded.lane?.name ?? NO_AGENT);
	} catch {
		// no record
	}
}

/** Which lane a session in `cwd` belongs to (src/lane/pick.ts). */
const pickFor = (config: HarnessConfig, options: OrreryOptions, cwd: string) => pickLane(config, { env: options.env ?? process.env, cwd, owner: options.owner ?? process.pid });

/** OMP's extension API carries its schema libraries (`arktype`, `zod`); pi's has neither. */
export function insideOmp(pi: object): boolean {
	return "arktype" in pi && "zod" in pi;
}

/**
 * How long a message waits for pending summaries: `override`, else 60 s in pi. OMP drops a hook's result after 30 s
 * (its extensions/runner.ts), so there the wait ends 25 s after the hook began, counting the time already spent in it.
 */
export function summaryWaitMs(host: "pi" | "omp", elapsedMs: number, override?: number): number {
	if (override !== undefined) return override;
	return host === "omp" ? Math.max(0, 25_000 - elapsedMs) : 60_000;
}

const registeredOn = new WeakSet<ExtensionAPI>();
const guardedOn = new WeakSet<ExtensionAPI>();
const OPEN_CANCELLED = new Error("The session left while its memory was opening");

export function createOrrery(options: OrreryOptions = {}): ExtensionFactory {
	const host = options.host ?? "pi";
	const omp = host === "omp";
	// What notices call this tool; pi's own words stay as they were.
	const label = omp ? "OMP" : "pi";
	return (pi: ExtensionAPI) => {
		// pi and OMP can share one extensions folder (PI_CODING_AGENT_DIR): each entry runs only in its own tool. In the
		// other tool it still guards the lane (mismatched).
		if (insideOmp(pi) !== omp) return mismatched(pi, options, omp);
		const state: OrreryState = {};
		let lostLane: PiLane | undefined;
		let openingAbort: AbortController | undefined;
		let closingLane: Promise<void> | undefined;
		// OMP builds its slash autocomplete when the extension loads: its commands exist from then on, in every session.
		// Outside a lane they say no lane is open. pi registers them when a lane opens (register).
		if (omp) registerCommands(pi, state, lazyPageOpener(options), host);
		const status = (ctx: ExtensionContext) => {
			const lane = recordingLane(ctx);
			if (lane === undefined) return;
			ctx.ui.setStatus("orrery", `${lane.statusLine()}${state.settingsNote ?? ""}`);
			lane.writeStatus(!ctx.isIdle());
		};

		/**
		 * Opens the session's lane (ORRERY_AGENT's, else the folder's), as a new session does: its guard, then (main session
		 * only) its memory, OMP's settings, the tools, the session's copy and the status tick. `loaded`: the config already
		 * read. `arrived`: the session moved here from another folder (OMP), so it records only what comes after the move.
		 */
		const openNow = async (event: { reason?: string }, ctx: ExtensionContext, controller: AbortController, loaded?: HarnessConfig, arrived = false): Promise<void> => {
			const { config, unreadable } = loaded === undefined ? orreryConfig(options, ctx) : { config: loaded, unreadable: undefined };
			if (config === undefined) {
				// A guard that cannot judge refuses: an unreadable config leaves the default guard on (no lane, no memory).
				if (unreadable !== undefined) {
					state.config = undefined;
					state.guarded = unreadableGuard(unreadable, ctx.cwd, options);
					guard(pi, state, host);
				}
				return;
			}
			state.config = config;
			const pick = pickFor(config, options, ctx.cwd);
			if (pick.kind === "none") return;
			if (pick.kind === "unknown" || pick.kind === "bad-token") {
				// No memory and no lane, but the guard runs, and the session is no lane's to copy later.
				state.guarded = refusedGuard(ctx.cwd, config, options);
				guard(pi, state, host);
				// OMP starts each subagent with this extension too: only the main session says so.
				if (subagent(ctx)) return;
				noteRun(state, ctx);
				warn(ctx, refusedNotice(pick));
				return;
			}
			const { lane } = pick;
			lostLane = undefined;
			state.guarded = guarded(lane, pick.by, ctx.cwd, config, options);
			const area = state.guarded.workArea;
			guard(pi, state, host);
			// OMP loads the extension again in each subagent (its task tool): a subagent gets the guard, never the memory.
			if (omp && subagent(ctx)) return;
			// The session is this lane's, whether or not its memory opens.
			noteRun(state, ctx);
			const { signal } = controller;
			const deadline = omp && lane.remote !== undefined ? setTimeout(() => controller.abort(new Error("Remote checkout took longer than 25 seconds")), 25_000) : undefined;
			try {
				// Summaries use orrery's own logins (spec 2026-10-07-summary-sources-design), not pi's registry.
				const sources = await abortable(signal, () => (options.summarySources ?? openSummarySources)(config, lane));
				signal.throwIfAborted();
				state.sources = sources;
				const models = laneModelSource(sources.models);
				const memory = { lane, models, agent: host, report: (message: string) => {
					ctx.ui.notify(message, "warning");
					// RemoteSession reports loss before its writer callback: retire this session's memory immediately.
					if (state.lane?.remote?.lost) recordingLane(ctx);
					else if (lostLane?.config === lane) lostStatus(ctx, lostLane);
				} };
				state.lane = lane.remote === undefined
					? await openYielding(() => PiLane.open(memory), lane.dir)
					: await PiLane.openChecked({ ...memory, config,
						signal,
						storage: options.remoteStorage?.(config, lane.remote),
						confirmTakeover: (held) => confirmTakeover(ctx, lane, held, signal),
						open: (open) => openYielding(open, lane.dir),
					});
			} catch (error) {
				if (error !== OPEN_CANCELLED) ctx.ui.notify(notOpened(lane, error, label), "warning");
				return;
			} finally { clearTimeout(deadline); }
			const left = () => signal.aborted || moved(ctx);
			const discard = async () => {
				const memory = state.lane;
				state.lane = undefined;
				try { await memory?.close(); } finally { options.onLane?.(undefined); }
			};
			if (left()) { await discard(); return; }
			options.onLane?.(state.lane);
			if (recordingLane(ctx) === undefined) return;
			// The lane's open report already said what is wrong now: notices start from here.
			state.notice = noticeKey(troubleState(state.lane));
			// OMP: its own compaction, memory, project CLAUDE.md and titles go off for this session, before the tools
			// register: their registration rebuilds OMP's system prompt, now without the CLAUDE.md.
			if (omp && options.laneSettings !== undefined) {
				let result: LaneSettingsResult;
				try {
					result = await abortable(signal, () => options.laneSettings!(ctx, area), (late) => late.restore?.());
				} catch (error) {
					if (signal.aborted) { await discard(); return; }
					result = { applied: false, why: errorText(error) };
				}
				state.restoreSettings = result.restore;
				if (!result.applied) {
					state.settingsNote = SETTINGS_NOT_APPLIED;
					warn(ctx, `Orrery: OMP settings not applied (${safeText(result.why)}): OMP's own compaction, memory and project CLAUDE.md may still apply in ${lane.name}. Orrery's memory works as usual.`);
				}
			}
			if (left()) { await discard(); return; }
			if (recordingLane(ctx) === undefined) return;
			register(pi, state, config, lazyPageOpener(options), host);
			// A fork is a new session id over entries its parent already copied (same entry ids): start it at its tail.
			// That is /fork (reason "fork") and `pi --fork <file>` (reason "startup", the header names the parent). A session
			// moved in from another folder starts at its tail too, always: its earlier turns belong to that folder (lane
			// privacy). So does a session another agent owns or ran in since (src/lane/session-owner.ts), and one a lane opened
			// by ORRERY_AGENT finds with turns in it (`pi --session`, /resume): they were not said in this run, and may be
			// another lane's.
			const id = ctx.sessionManager.getSessionId();
			const standing = sessionStanding(config.dataDir, id, lane.name);
			if (arrived || standing !== "own" || (pick.by === "env" && ctx.sessionManager.getBranch().length > 0)) startAtTail(state.lane.store, ctx.sessionManager);
			else if (event.reason === "fork" || ctx.sessionManager.getHeader()?.parentSession !== undefined) markSessionCopied(state.lane.store, ctx.sessionManager);
			// Only once the tail is written: a write that failed (it threw) leaves the mark for the next open.
			if (standing === "visited") settleVisit(config.dataDir, id, state.loadedAt ?? 0);
			copySession(state.lane.view, ctx.sessionManager, lane.memory.toolCap);
			state.runStart = Date.now(); // a first model call that is not a prompt (resumed session) is trimmed too
			state.lastEnd = state.runSince = state.runStart;
			// A status that cannot be shown or written must never take pi down (it exits on an uncaught exception).
			let warned = false;
			let requestWarned = false;
			const tick = () => {
				try {
					const lane = recordingLane(ctx);
					if (lane !== undefined) {
						// Its own guard: a bad request must never stop the status below on later ticks.
						try {
							const taken = takeRequest(lane.config.dir, lane.config.name);
							if (taken.ignored !== undefined) warn(ctx, `Orrery: ignored ${taken.ignored}.`);
							if (taken.request !== undefined) ctx.ui.notify(safeText(`Orrery: ${compactorCommand(lane, taken.request.args)} (changed from outside ${label})`), "info");
						} catch (error) {
							if (!requestWarned) warn(ctx, `Orrery: a summary-model change from outside ${label} failed: ${safeText(errorText(error))}`);
							requestWarned = true;
						}
					}
					status(ctx);
					if (lane !== undefined) {
						const now = troubleState(lane);
						const message = noticeText(lane.config.name, now, state.notice, "/compactor");
						state.notice = noticeKey(now);
						if (message !== undefined) ctx.ui.notify(message, now ? "warning" : "info");
					}
				} catch (error) {
					if (warned) return;
					warned = true;
					warn(ctx, `Orrery: status update failed: ${errorText(error)}`);
				}
			};
			tick();
			if (state.lane !== undefined) {
				state.timer = setInterval(tick, options.tickMs ?? 5000);
				state.timer.unref?.();
			}
		};
		const open = (event: { reason?: string }, ctx: ExtensionContext, loaded?: HarnessConfig, arrived = false): Promise<void> => {
			if (state.opening !== undefined) return state.opening;
			const controller = new AbortController();
			openingAbort = controller;
			const pending = openNow(event, ctx, controller, loaded, arrived).finally(() => {
				if (state.opening === pending) { state.opening = undefined; openingAbort = undefined; }
			});
			state.opening = pending;
			return pending;
		};
		pi.on("session_start", (event, ctx) => {
			state.loadedAt = Date.now();
			return open(event, ctx);
		});

		/** Closes the open lane as a session's end does: the session saved into it when `save`, status closed, lock released. */
		const closeLane = (ctx: ExtensionContext, save: boolean): Promise<void> => {
			openingAbort?.abort(OPEN_CANCELLED);
			if (closingLane !== undefined) return closingLane;
			const closing = (async () => {
				await state.opening;
				if (state.timer !== undefined) clearInterval(state.timer);
				state.timer = undefined;
				const lane = state.lane;
				if (lane === undefined) return;
				state.lane = undefined;
				try {
					if (save && !lane.remote?.lost) copySession(lane.view, ctx.sessionManager, lane.config.memory.toolCap);
				} catch (error) {
					warn(ctx, `Orrery: saving ${lane.config.name} at shutdown failed: ${errorText(error)}`);
				}
				try {
					// Closed even when the copy failed: a lane left "open" would look busy to lanes() and orrery status.
					lane.writeStatus(false, false);
				} catch (error) {
					warn(ctx, `Orrery: writing ${lane.config.name}'s status at shutdown failed: ${errorText(error)}`);
				}
				try {
					// Always release the writer lock, or the next /new, /resume, /fork or /reload would find the lane held.
					await lane.close();
				} finally {
					options.onLane?.(undefined);
				}
			})().finally(() => { if (closingLane === closing) closingLane = undefined; });
			closingLane = closing;
			return closing;
		};

		const lostStatus = (ctx: ExtensionContext, lane: PiLane): void => {
			const remote = lane.remote!;
			// lost becomes true before the holder lookup finishes. Show loss now and the machine when its report arrives.
			const text = remote.status().state === "lost" ? lane.statusLine() : `Orrery · ${lane.config.name} · ${remoteFooter({ ...remote.status(), state: "lost" })}`;
			try { ctx.ui.setStatus("orrery", `${text}${state.settingsNote ?? ""}`); }
			catch { /* Closing memory must not depend on the footer working. */ }
		};

		/** Fencing closes the store; stop every session hook using it while the host and lane guard continue. */
		const recordingLane = (ctx: ExtensionContext): PiLane | undefined => {
			const lane = state.lane;
			if (!lane?.remote?.lost) return lane;
			lostLane = lane;
			lostStatus(ctx, lane);
			void closeLane(ctx, false).catch((error) => warn(ctx, `Orrery: closing ${lane.config.name}'s memory failed: ${errorText(error)}`));
			return undefined;
		};

		/**
		 * OMP only: the session now runs in a folder of another lane than the one it found by folder, or outside lanes. A
		 * lane opened by ORRERY_AGENT is the session's wherever OMP moves it. OMP moves a session to another folder in place
		 * (its /resume of another folder's session, /move); pi starts a new session.
		 */
		const moved = (ctx: ExtensionContext): boolean =>
			omp && state.config !== undefined && state.guarded?.by !== "env" && state.guarded?.by !== "refused" && laneForCwd(state.config, ctx.cwd)?.name !== state.guarded?.lane?.name;

		// A session moved elsewhere by /move and ended before another message is no longer the lane's to save.
		pi.on("session_shutdown", (_event, ctx) => {
			noteRun(state, ctx);
			return closeLane(ctx, !moved(ctx));
		});

		/** Leaves the lane the session had, as its end would but without saving: its guard and OMP settings go, the footer clears. */
		const leave = async (ctx: ExtensionContext): Promise<void> => {
			const name = state.guarded?.lane?.name;
			try {
				await closeLane(ctx, false);
			} catch (error) {
				warn(ctx, `Orrery: closing ${name}'s memory failed: ${errorText(error)}`);
			}
			state.guarded = undefined;
			lostLane = undefined;
			state.sources = undefined;
			state.notice = undefined;
			state.settingsNote = undefined;
			const restore = state.restoreSettings;
			state.restoreSettings = undefined;
			try {
				restore?.();
			} catch (error) {
				warn(ctx, `Orrery: taking back OMP's settings for ${name} failed (${safeText(errorText(error))}): OMP's own compaction and memory may stay off in this session.`);
			}
			try {
				ctx.ui.setStatus("orrery", undefined);
			} catch {
				// A footer that cannot be cleared must not stop the move.
			}
		};

		/**
		 * OMP only: when the session moved to a folder of another lane, or outside lanes, the lane it had closes without the
		 * moved session copied into it, and the new folder's lane opens as at session_start (or none: plain OMP), recording
		 * only what comes after the move. One notice when a lane is left. Returns whether the lane changed.
		 */
		const follow = async (event: { reason?: string }, ctx: ExtensionContext): Promise<boolean> => {
			// A lane opened by ORRERY_AGENT stays; its guard covers the folder the session moved to.
			if (state.guarded?.by === "env" && state.guarded.lane !== undefined) {
				const area = workArea(state.guarded.lane, ctx.cwd);
				if (area !== state.guarded.workArea) state.guarded = { ...state.guarded, workArea: area };
				return false;
			}
			// A refused ORRERY_AGENT opens no lane anywhere; its guard takes the rules of the folder it moved to.
			if (state.guarded?.by === "refused" && state.config !== undefined) {
				state.guarded = refusedGuard(ctx.cwd, state.config, options);
				return false;
			}
			// Nor does a session without a readable config: its default guard's work area is the folder it moved to.
			if (state.guarded?.by === "unreadable") {
				state.guarded = { ...state.guarded, workArea: workArea({}, ctx.cwd) };
				return false;
			}
			if (!moved(ctx)) return false;
			const before = state.guarded?.lane?.name;
			const closed = state.lane !== undefined;
			await leave(ctx);
			await open(event, ctx, state.config, true);
			if (before === undefined) return true;
			const opened = state.lane === undefined ? "" : ` Opened ${state.lane.config.name}: it records from here on.`;
			ctx.ui.notify(`Orrery: this session moved from ${before} to another folder${closed ? `; ${before}'s memory is closed.` : "."}${opened}`, "info");
			return true;
		};

		pi.on("before_agent_start", async (event, ctx) => {
			const started = Date.now();
			// OMP: /move took the session to another folder since the last message.
			if (omp) await follow({}, ctx);
			const lane = recordingLane(ctx);
			if (lane === undefined) return;
			try {
				copySession(lane.view, ctx.sessionManager, lane.config.memory.toolCap);
			} catch (error) {
				// The view still goes out: memory as it was, without what could not be logged.
				warn(ctx, `Orrery: logging this session into memory failed: ${errorText(error)}`);
			}
			let section: string | undefined;
			try {
				// Wait only for summaries that can come: not when the summarizer is off, stopped or failing.
				if (!lane.view.settled && lane.summaryTrouble() === undefined) {
					ctx.ui.setStatus("orrery", `Orrery · ${lane.config.name} · summarizing before this message…`);
					// pi emits this before the run starts, so ctx.signal is usually undefined and Esc cannot reach the wait:
					// the cap is what keeps a stuck summarizer from hanging the message.
					const wait = new AbortController();
					const stop = () => wait.abort();
					const timer = setTimeout(stop, summaryWaitMs(host, Date.now() - started, options.memoryWaitMs));
					ctx.signal?.addEventListener("abort", stop, { once: true });
					try {
						await lane.awaitSummaries(wait.signal);
					} finally {
						clearTimeout(timer);
						ctx.signal?.removeEventListener("abort", stop);
					}
				}
				if (recordingLane(ctx) !== lane) return;
				if (!lane.view.settled) {
					const trouble = lane.summaryTrouble();
					const why = trouble === undefined ? "summaries still pending" : `summaries are ${trouble.state} (${trouble.plain})`;
					warn(ctx, `Orrery: ${why}; this message sees unsummarized lines (the model can zoom them)`);
				}
				section = memorySection(lane.view, host);
			} catch (error) {
				// pi swallows a throwing handler; say so, and still trim this run.
				warn(ctx, `Orrery: memory for this message failed: ${errorText(error)}`);
			}
			state.runStart = Date.now();
			state.runSince = state.lastEnd;
			try {
				status(ctx);
			} catch {
				// The tick reports status failures once.
			}
			if (section === undefined) return undefined;
			// OMP's system prompt is a list of blocks: the section goes last, after OMP's own. pi's is one string.
			const prompt = event.systemPrompt as string | readonly string[];
			return (typeof prompt === "string" ? { systemPrompt: `${prompt}\n\n${section}` } : { systemPrompt: [...prompt, section] }) as { systemPrompt: string };
		});

		pi.on("context", (event, ctx) => {
			if (recordingLane(ctx) === undefined || state.runStart === undefined) return;
			return { messages: trimToRun(event.messages as { role: string; timestamp?: number }[], state.runStart, state.runSince) as typeof event.messages };
		});

		const log = (_event: unknown, ctx: ExtensionContext) => {
			// OMP: a session /move took elsewhere is not the lane's to record; the next message or the end closes the lane.
			const lane = recordingLane(ctx);
			if (lane === undefined || moved(ctx)) return;
			copySession(lane.view, ctx.sessionManager, lane.config.memory.toolCap);
			status(ctx);
		};
		pi.on("message_end", (event, ctx) => {
			noteRun(state, ctx);
			log(event, ctx);
		});
		pi.on("agent_end", (event, ctx) => {
			state.lastEnd = Date.now();
			noteRun(state, ctx);
			log(event, ctx);
			if (!moved(ctx)) recordingLane(ctx)?.afterTurn();
		});

		if (omp) {
			// OMP keeps this instance across /new, /resume, /fork and rewinds and says so with session_switch (new, resume,
			// fork) or session_branch (branch, fork, btw), where pi ends the session and starts a new one. Each branch, and
			// a fork, is a new session id over entries already in memory (same entry ids): start it at its tail. A "branch from
			// /btw" starts at the entry it branched at, so the side question and answer OMP adds after it are recorded.
			let btwLeaf: string | undefined;
			const switched = async (event: SessionEvent, ctx: ExtensionContext) => {
				// OMP loaded the session it switched to before saying so.
				state.loadedAt = Date.now();
				const leaf = event.type === "session_branch" && event.reason === "btw" ? btwLeaf : undefined;
				if (event.type === "session_branch") btwLeaf = undefined;
				// A /resume of another folder's session (or a /move before this) took the session there: that folder's lane, or
				// none, takes it from here.
				if (await follow(event, ctx)) return;
				const id = ctx.sessionManager.getSessionId();
				// The session now open is this lane's (or no lane's, under a refused ORRERY_AGENT), as at session_start.
				noteRun(state, ctx);
				const lane = recordingLane(ctx);
				if (lane === undefined || state.config === undefined) return;
				try {
					// From its tail: a session another agent owns or ran in since; and, for a lane opened by ORRERY_AGENT, any
					// switch into a session with turns in it (a resume, a fork, a reason OMP adds later): they were not said in
					// this run. A branch (a rewind, /btw) is this run's own session.
					const standing = sessionStanding(state.config.dataDir, id, lane.config.name);
					const byEnv = state.guarded?.by === "env" && event.type === "session_switch" && ctx.sessionManager.getBranch().length > 0;
					if (standing !== "own" || byEnv) startAtTail(lane.store, ctx.sessionManager);
					else if (event.type === "session_branch" || event.reason === "fork" || ctx.sessionManager.getHeader()?.parentSession !== undefined) markSessionCopied(lane.store, ctx.sessionManager, leaf);
					// Only once the tail is written: a write that failed (it threw) leaves the mark for the next open.
					if (standing === "visited") settleVisit(state.config.dataDir, id, state.loadedAt ?? 0);
					copySession(lane.view, ctx.sessionManager, lane.config.memory.toolCap);
				} catch (error) {
					warn(ctx, `Orrery: logging the new session into memory failed: ${errorText(error)}`);
				}
				state.runStart = Date.now();
				state.lastEnd = state.runSince = state.runStart;
				try {
					status(ctx);
				} catch {
					// The tick reports status failures once.
				}
			};
			// Bound: `on` is a method of OMP's API object.
			const on = pi.on.bind(pi) as unknown as (event: "session_switch" | "session_branch" | "session_before_branch", handler: (event: SessionEvent, ctx: ExtensionContext) => unknown) => void;
			on("session_switch", switched);
			on("session_branch", switched);
			// Only OMP's question before a branch names the entry a /btw branch starts at (its session_branch does not).
			on("session_before_branch", (event) => {
				btwLeaf = event.reason === "btw" ? event.entryId : undefined;
			});
		}

		pi.on("session_tree", (event, ctx) => {
			const lane = recordingLane(ctx);
			if (lane !== undefined) moveCursor(lane.store, ctx.sessionManager.getSessionId(), event.newLeafId);
		});

		pi.on("session_before_compact", (event, ctx) => {
			if (recordingLane(ctx) === undefined) return;
			const decision = compactionDecision(event.reason);
			if (decision !== undefined && event.reason === "manual") ctx.ui.notify("Orrery: pi's compaction is off in lanes; memory keeps the history.", "info");
			return decision;
		});
	};
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The lane's summary trouble as notices see it (never the raw provider text). */
function troubleState(lane: PiLane): TroubleState | null {
	const trouble = lane.summaryTrouble();
	return trouble === undefined ? null : { state: trouble.state, plain: trouble.plain };
}

/** Why this session runs without memory: the lane is open in Claude Code (its holder beats), in another session, or failed to open. */
function notOpened(lane: LaneConfig, error: unknown, label: string): string {
	if (!(error instanceof LaneHeld)) return `Orrery: ${lane.name}: ${lane.remote === undefined ? errorText(error) : remoteOpenNotice(lane, error)}; this ${label} runs without memory.`;
	if (lane.remote !== undefined) return `${lane.name} is open in another pi or Claude Code on this machine; this ${label} runs without memory.`;
	if (holderFresh(readHolder(lane.dir))) return `${lane.name} is open in Claude Code; this ${label} runs without memory.`;
	return error.message;
}

/** pi and OMP versions differ: prefer confirm when present, otherwise offer the same explicit choice in select. */
async function confirmTakeover(ctx: ExtensionContext, lane: LaneConfig, held: LockState, opening: AbortSignal): Promise<boolean> {
	const message = remoteOpenNotice(lane, heldMessage(lane.name, held));
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 60_000);
	const signal = AbortSignal.any([opening, controller.signal]);
	try {
		return await abortable(signal, async () => {
			if (typeof ctx.ui.confirm === "function") return ctx.ui.confirm(`Take over ${lane.name}?`, message, { timeout: 60_000, signal });
			return await ctx.ui.select(`${message} Take over?`, ["Take over", "Keep it closed"], { timeout: 60_000, signal }) === "Take over";
		});
	} catch (error) { if (!signal.aborted) throw error; return false; }
	finally { clearTimeout(timer); }
}

function warn(ctx: ExtensionContext, message: string): void {
	try {
		ctx.ui.notify(message, "warning");
	} catch {
		console.error(message);
	}
}

/**
 * The orrery config, or none: plain pi when there is no config at all (silent), and `unreadable` (the file) when one is
 * there or named but cannot be read (it warns; the session keeps the default guard, unreadableGuard).
 */
function orreryConfig(options: OrreryOptions, ctx: ExtensionContext): { readonly config?: HarnessConfig; readonly unreadable?: string } {
	if (options.config !== undefined) return { config: options.config };
	const file = defaultConfigPath();
	try {
		const config = loadConfig(file);
		configFiles.set(config, resolve(file));
		return { config };
	} catch (error) {
		const absent = (error as { code?: unknown }).code === "ENOENT" && !process.env.ORRERY_CONFIG;
		if (absent) return {};
		warn(ctx, `Orrery: ${file}: ${errorText(error)}; running without memory`);
		return { unreadable: resolve(file) };
	}
}

const commandsOn = new WeakSet<ExtensionAPI>();

/** How `/browse` opens its page, looked up when it runs. */
const lazyPageOpener = (options: OrreryOptions) => (path: string) => (options.openPage ?? pageOpener()?.open)?.(path);

/** Tools (and in pi, commands), registered once per runtime, the first time a lane opens in it. */
function register(pi: ExtensionAPI, state: OrreryState, config: HarnessConfig, openPage: (path: string) => void, host: "pi" | "omp"): void {
	if (registeredOn.has(pi)) return;
	registeredOn.add(pi);
	for (const tool of memoryTools(state, host)) pi.registerTool(tool);
	if ((state.lane?.config.reads.length ?? 0) > 0) for (const tool of readerTools(state, config, host)) pi.registerTool(tool);
	// OMP has its commands since load (createOrrery).
	if (host === "pi") registerCommands(pi, state, openPage, host);
}

/** The slash commands, once per runtime; they read `state`, so they see the lane whenever it opens or reopens. */
function registerCommands(pi: ExtensionAPI, state: OrreryState, openPage: (path: string) => void, host: "pi" | "omp"): void {
	if (commandsOn.has(pi)) return;
	commandsOn.add(pi);
	const label = host === "omp" ? "OMP" : "pi";
	const withLane = (ctx: ExtensionContext, use: (lane: PiLane) => string) => {
		if (state.lane === undefined) return ctx.ui.notify(`Orrery: no lane memory is open in this ${label}`, "warning");
		try {
			ctx.ui.notify(use(state.lane), "info");
		} catch (error) {
			ctx.ui.notify(errorText(error), "error");
		}
	};
	// OMP's own /memory runs before any extension command of that name: there Orrery's is /orrery.
	pi.registerCommand(host === "omp" ? "orrery" : "memory", { description: "Orrery: this lane's memory and token use", handler: async (_args, ctx) => withLane(ctx, memoryReport) });
	pi.registerCommand("compactor", {
		description: "Orrery: pick the summary model (a menu), or: signin|key|local …, provider/model [thinking], reset",
		handler: async (args, ctx) => {
			const lane = state.lane;
			const sources = state.sources;
			if (lane === undefined || sources === undefined) return ctx.ui.notify(`Orrery: no lane memory is open in this ${label}`, "warning");
			try {
				const words = args.trim().split(/\s+/).filter(Boolean);
				const text = words.length === 0 ? await compactorMenu(ctx.ui, sources, laneTarget(lane)) : await runCompactorText(sources, words, "/compactor", laneTarget(lane), (name) => signInFromMenu(ctx.ui, sources, name));
				ctx.ui.notify(text, "info");
			} catch (error) {
				ctx.ui.notify(errorText(error), "error");
			}
		},
	});
	pi.registerCommand("browse", {
		description: "Orrery: write and open this lane's memory explorer (HTML)",
		handler: async (_args, ctx) =>
			withLane(ctx, (lane) => {
				const page = browse(lane);
				openPage(page);
				return `Wrote ${page}`;
			}),
	});
}

/**
 * An entry loaded in the other tool (pi's in OMP, OMP's in pi: a shared extensions folder, `omp -e`, or a misdetection).
 * In a lane folder the lane's guard runs as the right entry would run it, with one notice; nothing else is registered:
 * no memory, tools or commands. Outside lane folders it does nothing.
 */
function mismatched(pi: ExtensionAPI, options: OrreryOptions, omp: boolean): void {
	const state: OrreryState = {};
	const notice = omp
		? "Orrery's OMP extension is loaded in pi: no memory in this session (the guard still runs). Install Orrery for pi from orrery's Tools page."
		: "Orrery's pi extension is loaded in OMP: no memory in this session (the guard still runs). Install Orrery for OMP from orrery's Tools page.";
	pi.on("session_start", async (_event, ctx) => {
		const { config, unreadable } = orreryConfig(options, ctx);
		if (config === undefined) {
			// A guard that cannot judge refuses: an unreadable config leaves the default guard on.
			if (unreadable !== undefined) {
				state.guarded = unreadableGuard(unreadable, ctx.cwd, options);
				guard(pi, state, insideOmp(pi) ? "omp" : "pi");
			}
			return;
		}
		const pick = pickFor(config, options, ctx.cwd);
		if (pick.kind === "none") return;
		state.config = config;
		state.guarded = pick.kind === "lane" ? guarded(pick.lane, pick.by, ctx.cwd, config, options) : refusedGuard(ctx.cwd, config, options);
		// Judged by the tool this runs in, not the entry's: OMP's tool shapes when pi's entry is loaded in OMP.
		guard(pi, state, insideOmp(pi) ? "omp" : "pi");
		// One notice per session: OMP starts each subagent too (its task tool), and a subagent says nothing.
		if (subagent(ctx)) return;
		// Whose session this is, as the right entry notes it, now and as the session goes on.
		noteRun(state, ctx);
		warn(ctx, notice);
	});
	const note = (_event: unknown, ctx: ExtensionContext) => noteRun(state, ctx);
	pi.on("message_end", note);
	pi.on("agent_end", note);
	pi.on("session_shutdown", note);
}

/** The lane guard on tool calls, registered once per runtime, whether or not the lane's memory opened. */
function guard(pi: ExtensionAPI, state: OrreryState, host: "pi" | "omp"): void {
	if (guardedOn.has(pi)) return;
	guardedOn.add(pi);
	// OMP's tools take other shapes (several files in one edit, ast_edit, eval, path lists): the same rules, read its way.
	const judge = host === "omp" ? guardOmpToolCall : guardToolCall;
	pi.on("tool_call", (event, ctx) => {
		if (state.guarded === undefined) return;
		const { workArea: area, allowedRoots, credentials, orreryData, home, foreignViews, fileModeViews, ownView, configFile } = state.guarded;
		const options = { workspace: area, allowedRoots, cwd: ctx.cwd, credentials, orreryData, home, foreignViews, fileModeViews, ownView, configFile };
		const reason = judge(event.toolName, event.input as Record<string, unknown>, options);
		return reason === undefined ? undefined : { block: true, reason };
	});
}

export default createOrrery();
