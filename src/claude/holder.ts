/**
 * The lane holder (spec §4 "The lane holder"):
 * `orrery holder <Lane> --session <id> --claude-pid <pid> --nonce <n> --since <ms>`, started detached by SessionStart,
 * one per Claude Code session.
 * - While it holds the lane's store (the same writer lock pi takes), it ingests the hooks' spool in order, runs the
 *   compactor on orrery's own login, and keeps <workspace>/.orrery/view.md current.
 * - If pi, or a live session of another Claude Code process, holds the lane, it marks its session read-only and exits.
 * - It exits once its session has ended (SessionEnd, or the Claude Code process is gone) and the summaries have
 *   settled, cannot come (stopped or failing), or took longer than `finishMs`.
 * - Until then, a newcomer may ask it to yield (src/lane/handover.ts).
 * It logs lifecycle and errors only, never message contents.
 */

import { appendFileSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { findLane, type HarnessConfig, type LaneConfig } from "../lane/config.ts";
import { clearYield, holderFresh, openYielding, readHolder, readYield, removeHolder, writeHolder } from "../lane/handover.ts";
import { compactorCommand } from "../lane/lane-commands.ts";
import { LaneHeld, MemoryLane } from "../lane/memory-lane.ts";
import { laneModelSource, type ModelSource } from "../lane/model-source.ts";
import { processAlive } from "../lane/process.ts";
import { localIso, type NewMessage } from "../memory/index.ts";
import { holdWriterLock } from "../memory/store.ts";
import { remoteFooter, remoteOpenNotice } from "../remote/checkout.ts";
import { RemoteError, type RemoteStatus, type LockState } from "../remote/types.ts";
import { holderLog, validSession } from "./paths.ts";
import { dropEventsSince, listSessions, type Pending, pendingEvents, readEvent, readMode, removeSession, spoolKey, writeMode } from "./spool.ts";
import { type ViewGate, writeViewFile } from "./view-file.ts";

/** What a holder records, for whom, with which models, and how patiently. */
export interface HolderOptions {
	/** Required for a remote lane; local callers retain their synchronous open path. */
	readonly config?: HarnessConfig;
	readonly lane: LaneConfig;
	readonly session: string;
	/** Claude Code's process: when it is gone, the session has ended. */
	readonly claudePid: number;
	/** SessionStart's token, written into the mode file so the hook knows this holder answered. */
	readonly nonce: string;
	/**
	 * When SessionStart ran (default: when the holder starts). The session's events from then on belong to this run: a
	 * read-only run drops them, even those spooled while the holder was still starting.
	 */
	readonly since?: number;
	readonly models: ModelSource;
	/** Whether a process runs (default: processAlive); tests replace it. */
	readonly alive?: (pid: number) => boolean;
	readonly log?: (line: string) => void;
	/** How often it looks at the spool, the session and yield requests (default 500 ms). */
	readonly tickMs?: number;
	/** The longest it finishes summaries after its session ended (default 10 minutes). */
	readonly finishMs?: number;
	/** How long it waits for a finishing holder to yield the lane (default 5 s). */
	readonly yieldWaitMs?: number;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const READ_ONLY = "the lane is open elsewhere (pi, or a session of another Claude Code)";
const YIELDED = "yielded the lane";

/** One Claude Code session's hold on a lane: the single writer while it runs. */
export class Holder {
	readonly lane: MemoryLane;
	readonly session: string;
	/** Resolves once the holder has released the lane. */
	readonly done: Promise<void>;
	readonly #claudePid: number;
	readonly #nonce: string;
	readonly #startedAt: number;
	readonly #since: number;
	readonly #alive: (pid: number) => boolean;
	readonly #log: (line: string) => void;
	readonly #finishMs: number;
	#state: "recording" | "finishing" = "recording";
	#ended = false;
	#busy = false;
	#closing = false;
	#finishingSince = 0;
	#beat = 0;
	#savesPending = 0;
	#written = "";
	/** The last thing #viewNote logged about the view, so a retry that fails the same way is not logged again. */
	#lastViewNote: string | undefined;
	/** The steps of work failing right now: each is logged once, not on every tick, until it works again. */
	readonly #failing = new Set<string>();
	/** Sessions whose next reply answers one of orrery's own commands, and stays out of memory (a prompt clears it). */
	readonly #afterCommand = new Set<string>();
	#timer: ReturnType<typeof setInterval> | undefined;
	#release: () => void = () => {};

	private constructor(lane: MemoryLane, options: HolderOptions, startedAt: number, since: number) {
		this.lane = lane;
		this.session = options.session;
		this.#claudePid = options.claudePid;
		this.#nonce = options.nonce;
		this.#startedAt = startedAt;
		this.#since = since;
		this.#alive = options.alive ?? processAlive;
		this.#log = options.log ?? (() => {});
		this.#finishMs = options.finishMs ?? 600_000;
		this.done = new Promise((resolve) => {
			this.#release = resolve;
		});
	}

	/** "recording" while its session runs; "finishing" once it ended and only summaries are left. */
	get state(): "recording" | "finishing" {
		return this.#state;
	}

	/** Opens the lane and starts recording; or, when another writer keeps it, marks the session read-only and returns undefined. */
	static async start(options: HolderOptions): Promise<Holder | undefined> {
		const { lane, session } = options;
		const log = options.log ?? (() => {});
		const startedAt = Date.now();
		// SessionStart runs before its holder starts; a later `since` cannot be right (it would hide this run's own end).
		const since = Math.min(options.since ?? startedAt, startedAt);
		const mode = (recording: boolean, reason?: string) =>
			writeMode(lane.dir, session, {
				mode: recording ? "recording" : "read-only",
				pid: process.pid,
				claudePid: options.claudePid,
				nonce: options.nonce,
				since,
				...(reason === undefined ? {} : { reason }),
			});
		const notices: string[] = [];
		let opening = true;
		const report = (message: string) => { if (opening) notices.push(message); log(message); };
		let memory: MemoryLane;
		let takeover: LockState | undefined;
		try {
			const open = (sync: () => MemoryLane) => openYielding(sync, lane.dir, { claudePid: options.claudePid, waitMs: options.yieldWaitMs ?? 5000 });
			if (lane.remote === undefined) memory = await open(() => MemoryLane.open({ lane, models: options.models, report: log, agent: "claude-code" }));
			else {
				if (options.config === undefined) throw new Error("A remote recorder needs its harness config");
				const checked = () => {
					takeover = undefined;
					return MemoryLane.openChecked({ config: options.config!, lane, models: options.models, report, agent: "claude-code", open,
						confirmTakeover: async (held) => { takeover = held; return false; },
					});
				};
				try {
					memory = await checked();
				} catch (error) {
					const previous = readHolder(lane.dir);
					if (!(error instanceof RemoteError) || error.kind !== "held" || !holderFresh(previous) ||
						(previous.state !== "finishing" && previous.claudePid !== options.claudePid)) throw error;
					// Remote checkout can reject before the normal local handover runs. Ask only an eligible local
					// recorder to yield, probing its lock without opening memory, then retry checkout before open.
					await openYielding(() => {
						try { holdWriterLock(join(lane.dir, "memory.sqlite"))(); }
						catch (probe) {
							if (/already open/i.test(errorText(probe))) throw new LaneHeld(lane.name, "claude-code");
							throw probe;
						}
					}, lane.dir, { claudePid: options.claudePid, waitMs: options.yieldWaitMs ?? 5000 });
					memory = await checked();
				}
			}
		} catch (error) {
			if (!(error instanceof LaneHeld) && !(lane.remote !== undefined && error instanceof RemoteError)) throw error;
			const reason = error instanceof LaneHeld ? READ_ONLY : `${remoteOpenNotice(lane, error)}${takeover !== undefined ? `; run orrery lane takeover ${lane.name}` : ""}`;
			mode(false, error instanceof LaneHeld ? undefined : reason);
			dropEventsSince(lane.dir, session, since);
			log(`${session}: read-only: ${reason}`);
			return undefined;
		} finally {
			opening = false;
		}
		const holder = new Holder(memory, options, startedAt, since);
		mode(true, notices.length === 0 ? undefined : notices.join("\n"));
		log(`${session}: recording`);
		holder.#attempt("the heartbeat", () => holder.#heartbeat());
		// The timer first: a first tick that already stops the holder clears it, so none is left running.
		holder.#timer = setInterval(() => holder.tick(), options.tickMs ?? 500);
		holder.tick();
		return holder;
	}

	/**
	 * One look at the spool, the session and yield requests; the timer runs it every tickMs. Each step of work runs on
	 * its own (#attempt): one that keeps failing must not hide the session's end, a yield request, the exit rules or
	 * the heartbeat, or the lane would stay held.
	 */
	tick(): void {
		if (this.#closing) return;
		if (this.lane.remote?.lost) {
			void this.stop(remoteFooter(this.#remoteStatus()!));
			return;
		}
		this.#attempt("recording the spool", () => this.#ingest());
		this.#attempt("sweeping the spool", () => this.#sweep());
		const now = Date.now();
		if (!this.#ended && !this.#alive(this.#claudePid)) {
			this.#ended = true;
			this.#log(`${this.session}: Claude Code (pid ${this.#claudePid}) is gone`);
		}
		if (this.#ended && this.#state === "recording") {
			this.#state = "finishing";
			this.#finishingSince = now;
			this.#attempt("the heartbeat", () => this.#heartbeat());
		}
		this.#attempt("writing the view", () => this.#writeView(false));
		if (!this.lane.store.writable) {
			void this.stop("the memory store refuses writes");
			return;
		}
		const request = readYield(this.lane.config.dir, now);
		if (request !== undefined && request.at >= this.#startedAt && (this.#state === "finishing" || request.claudePid === this.#claudePid)) {
			void this.stop(YIELDED);
			return;
		}
		const over = this.lane.view.settled || this.lane.summaryTrouble() !== undefined || now - this.#finishingSince >= this.#finishMs;
		if (this.#state === "finishing" && over) {
			void this.stop("session over");
			return;
		}
		if (now - this.#beat >= 5000) this.#attempt("the heartbeat", () => this.#heartbeat());
	}

	/** Records what is left, writes the view, and releases the lane. */
	async stop(why: string): Promise<void> {
		if (this.#closing) return this.done;
		this.#closing = true;
		if (this.#timer !== undefined) clearInterval(this.#timer);
		const dir = this.lane.config.dir;
		if (this.lane.remote?.lost) {
			this.#rememberRemoteLoss();
		} else {
			this.#attempt("recording the spool", () => this.#ingest());
			this.#attempt("writing the view", () => this.#writeView(true));
		}
		this.#attempt("writing the status", () => this.lane.writeStatus(false, false));
		try {
			await this.lane.close();
		} finally {
			// The final save can be the first operation fenced out by a takeover.
			this.#attempt("remembering the remote lock loss", () => this.#rememberRemoteLoss());
			this.#attempt("handing the lane over", () => {
				removeHolder(dir, process.pid, this.session);
				if (why === YIELDED) clearYield(dir);
			});
			// The session's folder goes once it is spent, but a new holder of the same session (resumed at once) may
			// already be writing into it: removeSession leaves what that one wrote.
			if (this.#ended && pendingEvents(dir, this.session).length === 0) {
				this.#attempt("cleaning up the spool", () => removeSession(dir, this.session, [], { pid: process.pid, nonce: this.#nonce }));
			}
			this.#log(`${this.session}: stopped: ${why}`);
			this.#release();
		}
	}

	/**
	 * Records every pending event this holder owns, oldest first, each with its cursor in one transaction. The reply to
	 * one of orrery's own commands is not recorded, as in pi: only the cursor moves past it.
	 */
	#ingest(): void {
		for (const event of this.#eligible()) {
			const parsed = readEvent(event.path);
			const items: NewMessage[] = [];
			const commandReply = parsed?.kind === "reply" && this.#afterCommand.has(event.session);
			if ((parsed?.kind === "prompt" || parsed?.kind === "reply") && parsed.text.trim() && !commandReply) {
				items.push({ kind: parsed.kind === "prompt" ? "user" : "talk", text: parsed.text, date: localIso(new Date(parsed.at)) });
			}
			this.lane.view.appendBatch(items, { [spoolKey(event.session)]: event.name });
			rmSync(event.path, { force: true });
			if (parsed === undefined) this.#log(`${event.session}: skipped an unreadable event ${event.name}`);
			else if (parsed.kind === "prompt" || parsed.kind === "command") {
				this.#busy = true;
				// A prompt starts a turn of the user's again: its reply is memory.
				if (parsed.kind === "command") this.#afterCommand.add(event.session);
				else this.#afterCommand.delete(event.session);
			} else if (parsed.kind === "reply") {
				this.#busy = false;
				this.#afterCommand.delete(event.session);
				if (this.lane.remote !== undefined) this.#savesPending += 1;
				this.lane.afterTurn(() => {
					this.#savesPending -= 1;
					if (!this.#closing) this.#attempt("the heartbeat", () => this.#heartbeat());
				});
				if (this.lane.remote !== undefined) this.#attempt("the heartbeat", () => this.#heartbeat());
			} else if (parsed.kind === "end" && event.session === this.session && parsed.at >= this.#since) {
				// An end from before SessionStart belongs to an earlier run of the same session id (a crash, then --resume).
				this.#ended = true;
			} else if (parsed.kind === "compactor") this.#applyCompactor(parsed.args);
		}
	}

	/** Pending events this holder records, oldest first: its own session's, and those no other holder will come back for. */
	#eligible(): Pending[] {
		const dir = this.lane.config.dir;
		const events: Pending[] = [];
		for (const session of listSessions(dir)) {
			const pending = pendingEvents(dir, session, this.lane.store.getMeta(spoolKey(session)));
			events.push(...(session === this.session ? pending : this.#adoptable(session, pending)));
		}
		return events.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	}

	/**
	 * The share of another session's events that is this holder's to record. This holder has the lane, so that
	 * session's holder is gone.
	 * - A session that recorded: all of it.
	 * - A read-only session: only what came before it turned read-only.
	 * - A session whose holder never answered: all of it, once its Claude Code is gone (until then its holder may
	 *   still be starting).
	 */
	#adoptable(session: string, pending: Pending[]): Pending[] {
		const mode = readMode(this.lane.config.dir, session);
		if (mode?.mode === "recording") return pending;
		if (mode?.mode === "read-only") return pending.filter((event) => event.at < mode.since);
		return pending.every((event) => !this.#alive(readEvent(event.path)?.claudePid ?? 0)) ? pending : [];
	}

	/**
	 * Removes other sessions' folders once nothing in them is left to record and their Claude Code is gone. Only what
	 * it checked goes (removeSession): the session may be resumed meanwhile, and its new holder and hooks write there.
	 */
	#sweep(): void {
		const dir = this.lane.config.dir;
		for (const session of listSessions(dir)) {
			if (session === this.session) continue;
			const mode = readMode(dir, session);
			const pending = pendingEvents(dir, session);
			const pids = [mode?.claudePid, ...pending.map((event) => readEvent(event.path)?.claudePid)];
			if (pids.some((pid) => pid !== undefined && this.#alive(pid))) continue;
			if (this.#adoptable(session, pending).length > 0) continue;
			removeSession(dir, session, pending, mode);
		}
	}

	/**
	 * Writes the view file when the view changed and settled (or cannot settle soon); `force` writes it regardless. A
	 * write that failed is not tried again until the view changes. Returns whether it wrote the file.
	 */
	#writeView(force: boolean): boolean {
		const stats = this.lane.view.stats();
		const mark = `${stats.messages}/${stats.nodes}/${stats.viewParts}`;
		if (!force && (mark === this.#written || (!stats.settled && this.lane.summaryTrouble() === undefined))) return false;
		this.#written = mark;
		return writeViewFile(this.lane.config, this.lane.view, (gate) => this.#viewNote(gate));
	}

	/**
	 * Logs what the view's gate did to the view: withdrawn, a withdrawal that failed, or taken out while git cannot
	 * answer. The lane and the kind only (a reason may name the workspace; nothing from the repo goes in the log), and
	 * once until it changes: a failing withdrawal is retried at every view change.
	 */
	#viewNote(gate: ViewGate): void {
		const view = `${this.session}: ${this.lane.config.name}'s memory view`;
		let note: string | undefined;
		if (gate.mod === true && gate.failed !== undefined) note = `${view} (mod mode): the old view file could not be removed; trying again`;
		else if (gate.exposed !== undefined && gate.failed !== undefined) note = `${view} could not be withdrawn: git would see it (${gate.exposed.kind}); trying again`;
		else if (gate.exposed !== undefined) note = `${view} withdrawn: git would see it (${gate.exposed.kind})`;
		else if (gate.unchecked !== undefined && gate.removed === true) note = `${view} taken out until git answers again (unchecked)`;
		if (note !== undefined && note !== this.#lastViewNote) this.#log(note);
		this.#lastViewNote = note;
	}

	/**
	 * Runs one step of work. A failure stops nothing else, and is logged once, not on every tick, until the step works
	 * again (a step that returns false did nothing, so it has not).
	 */
	#attempt(what: string, run: () => boolean | void): void {
		try {
			if (run() !== false) this.#failing.delete(what);
		} catch (error) {
			if (!this.#failing.has(what)) this.#log(`${this.session}: ${what}: ${errorText(error)}`);
			this.#failing.add(what);
		}
	}

	/** A known lost lock must never look saved while the remote looks up the new machine's name. */
	#remoteStatus(): RemoteStatus | undefined {
		const remote = this.lane.remote;
		if (remote === undefined) return undefined;
		const status = remote.status();
		if (remote.lost && status.state !== "lost") return { remote: status.remote, state: "lost" };
		return status.state === "saved" && this.#savesPending > 0 ? { ...status, state: "pending" } : status;
	}

	#rememberRemoteLoss(): void {
		if (!this.lane.remote?.lost) return;
		const mode = readMode(this.lane.config.dir, this.session);
		// A new recorder can already have opened this same session after our writer lock was released.
		if (mode?.pid !== process.pid || mode.nonce !== this.#nonce) return;
		const remote = this.#remoteStatus()!;
		writeMode(this.lane.config.dir, this.session, { ...mode, mode: "read-only", reason: remoteFooter(remote), remote });
	}

	#heartbeat(): void {
		this.#beat = Date.now();
		const remote = this.#remoteStatus();
		writeHolder(this.lane.config.dir, {
			pid: process.pid,
			session: this.session,
			claudePid: this.#claudePid,
			state: this.#state,
			startedAt: this.#startedAt,
			updatedAt: this.#beat,
			...(remote === undefined ? {} : { remote }),
		});
		this.lane.writeStatus(this.#busy);
	}

	#applyCompactor(args: string): void {
		try {
			this.#log(`${this.session}: ${compactorCommand(this.lane, args)}`);
		} catch (error) {
			this.#log(`${this.session}: compactor ${args}: ${errorText(error)}`);
		}
	}
}

/** Appends a line to <lane.dir>/claude/holder.log (0600), starting over past 1 MB. Callers never pass message contents. */
export function holderLogger(laneDir: string): (line: string) => void {
	const path = holderLog(laneDir);
	return (line) => {
		try {
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
			let size = 0;
			try {
				size = statSync(path).size;
			} catch {
				size = 0;
			}
			const text = `${localIso()} [${process.pid}] ${line}\n`;
			if (size > 1_000_000) writeFileSync(path, text, { mode: 0o600 });
			else appendFileSync(path, text, { mode: 0o600 });
		} catch {
			// A log that cannot be written must not stop the holder.
		}
	};
}

/** `orrery holder`: runs one holder until it releases the lane. Summaries use orrery's own logins. */
export async function runHolder(
	config: HarnessConfig,
	laneName: string,
	options: { session: string; claudePid: number; nonce: string; since?: number },
): Promise<number> {
	const lane = findLane(config, laneName);
	if (!validSession(options.session)) throw new Error("holder: --session must be a Claude Code session id");
	const log = holderLogger(lane.dir);
	try {
		const [{ createLaneModels, savedSummaryLoginsOnly }, { FileCredentialStore }, { configureHttp }] = await Promise.all([
			import("../lane/models.ts"),
			import("../lane/credentials.ts"),
			import("../lane/http.ts"),
		]);
		configureHttp();
		const models = laneModelSource(createLaneModels({ credentials: new FileCredentialStore(config.credentialsPath), providers: config.providers, savedLoginsOnly: savedSummaryLoginsOnly(lane) }));
		const holder = await Holder.start({ config, lane, ...options, models, log });
		if (holder === undefined) return 0;
		process.once("SIGTERM", () => void holder.stop("SIGTERM"));
		await holder.done;
		return 0;
	} catch (error) {
		log(`holder failed: ${errorText(error)}`);
		throw error;
	}
}
