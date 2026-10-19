/**
 * The agent holder (spec §4 "The agent holder"):
 * `orrery holder <Name> --session <id> --claude-pid <pid> --nonce <n> --since <ms>`, started detached by SessionStart,
 * one per Claude Code session; for a Codex session (spec 2026-10-16-codex-design, "Recorder"), `--host-pid <pid> --tool
 * codex` in place of --claude-pid. Codex's hooks spool into the same folders, so a holder takes in any session's leftovers.
 * - While it holds the agent's store (the same writer lock pi takes), it ingests the hooks' spool in order, runs the
 *   compactor on orrery's own login, and keeps <folder>/.orrery/view.md current (Claude Code's file mode only).
 * - If pi, or a live session of another host process, holds the agent, it marks its session read-only and exits.
 * - It exits once its session has ended (SessionEnd, or the host process is gone) and the summaries have settled,
 *   cannot come (stopped or failing), or took longer than `finishMs`.
 * - Until then, a newcomer may ask it to yield (src/agent/handover.ts).
 * - A Claude Code prompt (any but Codex's) is held until Claude Code's transcript confirms it (spec
 *   2026-10-18-agent-permissions §3c, src/claude/transcript.ts): the user's words are recorded, a peer's report as
 *   "[subagent] …", a task notification not at all. Its session's later events wait behind it, so the order holds. One
 *   not confirmed once its turn is over (a later event of its session, or its Claude Code gone) and `graceMs` have
 *   passed is dropped and counted (unconfirmed.json). Each session's transcript place is kept in memory meta, so a holder
 *   that starts with a prompt still held looks for it first, where its predecessor left off.
 * It logs lifecycle and errors only, never message contents; its lines name the host (Claude Code or Codex).
 */

import { appendFileSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { findAgent, type HarnessConfig, type AgentConfig } from "../agent/config.ts";
import { clearYield, HOST_LABELS, type HolderHost, holderFresh, openYielding, readHolder, readYield, removeHolder, writeHolder } from "../agent/handover.ts";
import { compactorCommand } from "../agent/agent-commands.ts";
import { AgentHeld, MemoryAgent } from "../agent/memory-agent.ts";
import { agentModelSource, type ModelSource } from "../agent/model-source.ts";
import { processAlive } from "../agent/process.ts";
import { statusVersion } from "../agent/status-file.ts";
import { refreshEvery } from "../install/update.ts";
import { localIso, type NewMessage } from "../memory/index.ts";
import { holdWriterLock } from "../memory/store.ts";
import { remoteFooter, remoteOpenNotice } from "../remote/checkout.ts";
import { RemoteError, type RemoteStatus, type LockState } from "../remote/types.ts";
import { holderLog, validSession } from "./paths.ts";
import { dropEventsSince, listSessions, type Pending, pendingEvents, readEvent, readMode, removeSession, type SpoolEvent, spoolKey, writeMode } from "./spool.ts";
import { addUnconfirmed, parseMark, type PromptVerdict, TranscriptReader, transcriptIn } from "./transcript.ts";
import { type ViewGate, writeViewFile } from "./view-file.ts";

/** The meta key holding a session's transcript place (src/claude/transcript.ts TranscriptMark). */
export const transcriptKey = (session: string) => `claude.transcript.${session}`;

/** How long a Claude Code prompt may stay unconfirmed once its turn is over (default for HolderOptions.graceMs). */
export const PROMPT_GRACE_MS = 30_000;

/** What a holder records, for whom, with which models, and how patiently. */
export interface HolderOptions {
	/** Required for a remote agent; local callers retain their synchronous open path. */
	readonly config?: HarnessConfig;
	readonly agent: AgentConfig;
	readonly session: string;
	/** The host's process (Claude Code's, or Codex's): when it is gone, the session has ended. */
	readonly claudePid: number;
	/** Whose session it records (default Claude Code): named in its log, its status file and holder.json. */
	readonly host?: HolderHost;
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
	/** How long it waits for a finishing holder to yield the agent (default 5 s). */
	readonly yieldWaitMs?: number;
	/** How long a Claude Code prompt may stay unconfirmed once its turn is over (default PROMPT_GRACE_MS). */
	readonly graceMs?: number;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** Why a session runs read-only, in the log: the agent is open elsewhere. */
const READ_ONLY: Record<HolderHost, string> = {
	"claude-code": "the agent is open elsewhere (pi, or a session of another Claude Code)",
	codex: "the agent is open elsewhere (pi, Claude Code, or another Codex session)",
};
const YIELDED = "yielded the agent";

/** One Claude Code or Codex session's hold on an agent: the single writer while it runs. */
export class Holder {
	readonly agent: MemoryAgent;
	readonly session: string;
	/** Resolves once the holder has released the agent. */
	readonly done: Promise<void>;
	readonly #claudePid: number;
	readonly #host: HolderHost;
	readonly #nonce: string;
	readonly #startedAt: number;
	readonly #since: number;
	readonly #alive: (pid: number) => boolean;
	readonly #log: (line: string) => void;
	readonly #finishMs: number;
	readonly #graceMs: number;
	/** Each session's transcript, as read so far (loaded from memory meta when first needed). */
	readonly #transcripts = new Map<string, TranscriptReader>();
	/** When each held prompt's grace began (its turn was over), by event name. */
	readonly #graceFrom = new Map<string, number>();
	/** Whether the last look left a prompt of its own session held. */
	#holding = false;
	/** The Orrery version this process runs, for the heartbeat: an update leaves it on the old one until the session restarts. */
	readonly #version = statusVersion();
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

	private constructor(agent: MemoryAgent, options: HolderOptions, startedAt: number, since: number) {
		this.agent = agent;
		this.session = options.session;
		this.#claudePid = options.claudePid;
		this.#host = options.host ?? "claude-code";
		this.#nonce = options.nonce;
		this.#startedAt = startedAt;
		this.#since = since;
		this.#alive = options.alive ?? processAlive;
		this.#log = options.log ?? (() => {});
		this.#finishMs = options.finishMs ?? 600_000;
		this.#graceMs = options.graceMs ?? PROMPT_GRACE_MS;
		this.done = new Promise((resolve) => {
			this.#release = resolve;
		});
	}

	/** "recording" while its session runs; "finishing" once it ended and only summaries are left. */
	get state(): "recording" | "finishing" {
		return this.#state;
	}

	/** Opens the agent and starts recording; or, when another writer keeps it, marks the session read-only and returns undefined. */
	static async start(options: HolderOptions): Promise<Holder | undefined> {
		const { agent, session } = options;
		const host = options.host ?? "claude-code";
		const log = options.log ?? (() => {});
		const startedAt = Date.now();
		// SessionStart runs before its holder starts; a later `since` cannot be right (it would hide this run's own end).
		const since = Math.min(options.since ?? startedAt, startedAt);
		const mode = (recording: boolean, reason?: string) =>
			writeMode(agent.dir, session, {
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
		let memory: MemoryAgent;
		let takeover: LockState | undefined;
		try {
			const open = (sync: () => MemoryAgent) => openYielding(sync, agent.dir, { claudePid: options.claudePid, waitMs: options.yieldWaitMs ?? 5000 });
			if (agent.remote === undefined) memory = await open(() => MemoryAgent.open({ agent, models: options.models, report: log, host }));
			else {
				if (options.config === undefined) throw new Error("A remote recorder needs its harness config");
				const checked = () => {
					takeover = undefined;
					return MemoryAgent.openChecked({ config: options.config!, agent, models: options.models, report, host, open,
						confirmTakeover: async (held) => { takeover = held; return false; },
					});
				};
				try {
					memory = await checked();
				} catch (error) {
					const previous = readHolder(agent.dir);
					if (!(error instanceof RemoteError) || error.kind !== "held" || !holderFresh(previous) ||
						(previous.state !== "finishing" && previous.claudePid !== options.claudePid)) throw error;
					// Remote checkout can reject before the normal local handover runs. Ask only an eligible local
					// recorder to yield, probing its lock without opening memory, then retry checkout before open.
					await openYielding(() => {
						try { holdWriterLock(join(agent.dir, "memory.sqlite"))(); }
						catch (probe) {
							if (/already open/i.test(errorText(probe))) throw new AgentHeld(agent.name, host);
							throw probe;
						}
					}, agent.dir, { claudePid: options.claudePid, waitMs: options.yieldWaitMs ?? 5000 });
					memory = await checked();
				}
			}
		} catch (error) {
			if (!(error instanceof AgentHeld) && !(agent.remote !== undefined && error instanceof RemoteError)) throw error;
			const reason = error instanceof AgentHeld ? READ_ONLY[host] : `${remoteOpenNotice(agent, error)}${takeover !== undefined ? `; run orrery agent takeover ${agent.name}` : ""}`;
			mode(false, error instanceof AgentHeld ? undefined : reason);
			dropEventsSince(agent.dir, session, since);
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
	 * the heartbeat, or the agent would stay held.
	 */
	tick(): void {
		if (this.#closing) return;
		if (this.agent.remote?.lost) {
			void this.stop(remoteFooter(this.#remoteStatus()!));
			return;
		}
		this.#attempt("recording the spool", () => this.#ingest());
		this.#attempt("sweeping the spool", () => this.#sweep());
		const now = Date.now();
		if (!this.#ended && !this.#alive(this.#claudePid)) {
			this.#ended = true;
			this.#log(`${this.session}: ${HOST_LABELS[this.#host]} (pid ${this.#claudePid}) is gone`);
		}
		if (this.#ended && this.#state === "recording") {
			this.#state = "finishing";
			this.#finishingSince = now;
			this.#attempt("the heartbeat", () => this.#heartbeat());
		}
		this.#attempt("writing the view", () => this.#writeView(false));
		if (!this.agent.store.writable) {
			void this.stop("the memory store refuses writes");
			return;
		}
		const request = readYield(this.agent.config.dir, now);
		if (request !== undefined && request.at >= this.#startedAt && (this.#state === "finishing" || request.claudePid === this.#claudePid)) {
			void this.stop(YIELDED);
			return;
		}
		// A prompt of its own still held finishes first: within its grace, it is confirmed or dropped.
		const over = ((this.agent.view.settled || this.agent.summaryTrouble() !== undefined) && !this.#holding) || now - this.#finishingSince >= this.#finishMs;
		if (this.#state === "finishing" && over) {
			void this.stop("session over");
			return;
		}
		if (now - this.#beat >= 5000) this.#attempt("the heartbeat", () => this.#heartbeat());
	}

	/** Records what is left, writes the view, and releases the agent. */
	async stop(why: string): Promise<void> {
		if (this.#closing) return this.done;
		this.#closing = true;
		if (this.#timer !== undefined) clearInterval(this.#timer);
		const dir = this.agent.config.dir;
		if (this.agent.remote?.lost) {
			this.#rememberRemoteLoss();
		} else {
			this.#attempt("recording the spool", () => this.#ingest());
			this.#attempt("writing the view", () => this.#writeView(true));
		}
		this.#attempt("writing the status", () => this.agent.writeStatus(false, false));
		try {
			await this.agent.close();
		} finally {
			// The final save can be the first operation fenced out by a takeover.
			this.#attempt("remembering the remote lock loss", () => this.#rememberRemoteLoss());
			this.#attempt("handing the agent over", () => {
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
	 * one of orrery's own commands is not recorded, as in pi: only the cursor moves past it. A Claude Code prompt not yet
	 * confirmed holds its session's later events back (module doc).
	 */
	#ingest(): void {
		const held = new Set<string>();
		const events = this.#eligible();
		const now = Date.now();
		for (const [index, event] of events.entries()) {
			if (held.has(event.session)) continue;
			const parsed = readEvent(event.path);
			const items: NewMessage[] = [];
			const meta: Record<string, string> = { [spoolKey(event.session)]: event.name };
			const commandReply = parsed?.kind === "reply" && this.#afterCommand.has(event.session);
			let unconfirmed = false;
			// Every prompt but Codex's is Claude Code's, recorded only as its transcript confirms it (none without a promptId).
			if (parsed?.kind === "prompt" && parsed.host !== "codex") {
				const prompt = { promptId: parsed.promptId ?? "", text: parsed.text };
				const { verdict, line } = this.#verdict(event, prompt, parsed.claudePid, events.slice(index + 1), now);
				if (verdict === "wait") {
					held.add(event.session);
					continue;
				}
				this.#graceFrom.delete(event.name);
				const reader = this.#transcripts.get(event.session);
				// A line recorded before (a resume or a fork replays history, uuids and all) is not recorded again.
				if ((verdict === "user" || verdict === "report") && parsed.text.trim() && (line === undefined || reader?.recordedBefore(line) !== true)) {
					items.push({ kind: "user", text: verdict === "user" ? parsed.text : `[subagent] ${parsed.text}`, date: localIso(new Date(parsed.at)) });
					if (line !== undefined) reader?.remember(line);
				}
				unconfirmed = verdict === "unconfirmed";
				if (reader !== undefined) meta[transcriptKey(event.session)] = JSON.stringify(reader.mark());
			} else if (parsed?.kind === "transcript") {
				const reader = this.#startTranscript(event.session, parsed);
				meta[transcriptKey(event.session)] = reader === undefined ? "{}" : JSON.stringify(reader.mark());
			} else if ((parsed?.kind === "prompt" || parsed?.kind === "reply") && parsed.text.trim() && !commandReply) {
				items.push({ kind: parsed.kind === "prompt" ? "user" : "talk", text: parsed.text, date: localIso(new Date(parsed.at)) });
			}
			this.agent.view.appendBatch(items, meta);
			rmSync(event.path, { force: true });
			if (unconfirmed) {
				this.#log(`${event.session}: a prompt Claude Code's transcript does not confirm was not recorded`);
				this.#attempt("counting unconfirmed prompts", () => addUnconfirmed(this.agent.config.dir));
			}
			if (parsed === undefined) this.#log(`${event.session}: skipped an unreadable event ${event.name}`);
			else if (parsed.kind === "prompt" || parsed.kind === "command") {
				this.#busy = true;
				// A prompt starts a turn of the user's again: its reply is memory.
				if (parsed.kind === "command") this.#afterCommand.add(event.session);
				else this.#afterCommand.delete(event.session);
			} else if (parsed.kind === "reply") {
				this.#busy = false;
				this.#afterCommand.delete(event.session);
				if (this.agent.remote !== undefined) this.#savesPending += 1;
				this.agent.afterTurn(() => {
					this.#savesPending -= 1;
					if (!this.#closing) this.#attempt("the heartbeat", () => this.#heartbeat());
				});
				if (this.agent.remote !== undefined) this.#attempt("the heartbeat", () => this.#heartbeat());
			} else if (parsed.kind === "end" && event.session === this.session && parsed.at >= this.#since) {
				// An end from before SessionStart belongs to an earlier run of the same session id (a crash, then --resume).
				this.#ended = true;
			} else if (parsed.kind === "compactor") this.#applyCompactor(parsed.args);
		}
		this.#holding = held.has(this.session);
	}

	/**
	 * What a Claude Code prompt was, by its session's transcript, and the line that said so: "unconfirmed" when nothing
	 * can confirm it (no transcript for its session, no promptId) or nothing did by the end of its grace, which begins once
	 * its turn is over (a later event of its session, or its Claude Code gone).
	 */
	#verdict(event: Pending, prompt: { promptId: string; text: string }, host: number, later: readonly Pending[], now: number): { verdict: PromptVerdict | "unconfirmed"; line?: string } {
		const reader = this.#transcript(event.session);
		if (reader === undefined || prompt.promptId === "") return { verdict: "unconfirmed" };
		reader.read(now);
		const confirmed = reader.confirm(prompt);
		if (confirmed.verdict !== "wait") return confirmed;
		let since = this.#graceFrom.get(event.name);
		if (since === undefined && (later.some((next) => next.session === event.session) || !this.#alive(host))) {
			since = now;
			this.#graceFrom.set(event.name, now);
		}
		return { verdict: since !== undefined && now - since >= this.#graceMs ? "unconfirmed" : "wait" };
	}

	/** A session's transcript: as read so far, else where memory meta says the last holder left it, else none. */
	#transcript(session: string): TranscriptReader | undefined {
		const known = this.#transcripts.get(session);
		if (known !== undefined) return known;
		const mark = parseMark(this.agent.store.getMeta(transcriptKey(session)));
		if (mark === undefined || transcriptIn(mark.path, mark.projects) === undefined) return undefined;
		const reader = new TranscriptReader(mark);
		this.#transcripts.set(session, reader);
		return reader;
	}

	/**
	 * A session's (new) transcript, from its SessionStart: read from the offset SessionStart saw. What was recorded from
	 * the session before is remembered, so a resume's replay is not recorded twice. One not under Claude Code's projects
	 * folder is none: the session's prompts are not confirmed.
	 */
	#startTranscript(session: string, event: Extract<SpoolEvent, { kind: "transcript" }>): TranscriptReader | undefined {
		const before = this.#transcript(session)?.mark().recorded;
		this.#transcripts.delete(session);
		const path = transcriptIn(event.path, event.projects);
		if (path === undefined) return undefined;
		const reader = new TranscriptReader({ path, projects: event.projects, offset: event.offset, ...(before === undefined ? {} : { recorded: before }) });
		this.#transcripts.set(session, reader);
		return reader;
	}

	/** Pending events this holder records, oldest first: its own session's, and those no other holder will come back for. */
	#eligible(): Pending[] {
		const dir = this.agent.config.dir;
		const events: Pending[] = [];
		for (const session of listSessions(dir)) {
			const pending = pendingEvents(dir, session, this.agent.store.getMeta(spoolKey(session)));
			events.push(...(session === this.session ? pending : this.#adoptable(session, pending)));
		}
		return events.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	}

	/**
	 * The share of another session's events that is this holder's to record. This holder has the agent, so that
	 * session's holder is gone.
	 * - A session that recorded: all of it.
	 * - A read-only session: only what came before it turned read-only.
	 * - A session whose holder never answered: all of it, once its host (Claude Code or Codex) is gone (until then its
	 *   holder may still be starting).
	 */
	#adoptable(session: string, pending: Pending[]): Pending[] {
		const mode = readMode(this.agent.config.dir, session);
		if (mode?.mode === "recording") return pending;
		if (mode?.mode === "read-only") return pending.filter((event) => event.at < mode.since);
		return pending.every((event) => !this.#alive(readEvent(event.path)?.claudePid ?? 0)) ? pending : [];
	}

	/**
	 * Removes other sessions' folders once nothing in them is left to record and their host process is gone. Only what
	 * it checked goes (removeSession): the session may be resumed meanwhile, and its new holder and hooks write there.
	 */
	#sweep(): void {
		const dir = this.agent.config.dir;
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
		const stats = this.agent.view.stats();
		const mark = `${stats.messages}/${stats.nodes}/${stats.viewParts}`;
		if (!force && (mark === this.#written || (!stats.settled && this.agent.summaryTrouble() === undefined))) return false;
		this.#written = mark;
		return writeViewFile(this.agent.config, this.agent.view, (gate) => this.#viewNote(gate));
	}

	/**
	 * Logs what the view's gate did to the view: withdrawn, a withdrawal that failed, or taken out while git cannot
	 * answer. The agent and the kind only (a reason may name the folder; nothing from the repo goes in the log), and
	 * once until it changes: a failing withdrawal is retried at every view change.
	 */
	#viewNote(gate: ViewGate): void {
		const view = `${this.session}: ${this.agent.config.name}'s memory view`;
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
		const remote = this.agent.remote;
		if (remote === undefined) return undefined;
		const status = remote.status();
		if (remote.lost && status.state !== "lost") return { remote: status.remote, state: "lost" };
		return status.state === "saved" && this.#savesPending > 0 ? { ...status, state: "pending" } : status;
	}

	#rememberRemoteLoss(): void {
		if (!this.agent.remote?.lost) return;
		const mode = readMode(this.agent.config.dir, this.session);
		// A new recorder can already have opened this same session after our writer lock was released.
		if (mode?.pid !== process.pid || mode.nonce !== this.#nonce) return;
		const remote = this.#remoteStatus()!;
		writeMode(this.agent.config.dir, this.session, { ...mode, mode: "read-only", reason: remoteFooter(remote), remote });
	}

	#heartbeat(): void {
		this.#beat = Date.now();
		const remote = this.#remoteStatus();
		writeHolder(this.agent.config.dir, {
			pid: process.pid,
			session: this.session,
			claudePid: this.#claudePid,
			...(this.#host === "codex" ? { host: "codex" as const } : {}),
			state: this.#state,
			startedAt: this.#startedAt,
			updatedAt: this.#beat,
			...(remote === undefined ? {} : { remote }),
			version: this.#version,
		});
		this.agent.writeStatus(this.#busy);
	}

	#applyCompactor(args: string): void {
		try {
			this.#log(`${this.session}: ${compactorCommand(this.agent, args)}`);
		} catch (error) {
			this.#log(`${this.session}: compactor ${args}: ${errorText(error)}`);
		}
	}
}

/** Appends a line to <agent.dir>/claude/holder.log (0600), starting over past 1 MB. Callers never pass message contents. */
export function holderLogger(agentDir: string): (line: string) => void {
	const path = holderLog(agentDir);
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

/** `orrery holder`: runs one holder until it releases the agent. Summaries use orrery's own logins. */
export async function runHolder(
	config: HarnessConfig,
	agentName: string,
	options: { session: string; claudePid: number; nonce: string; since?: number; host?: HolderHost },
): Promise<number> {
	const agent = findAgent(config, agentName);
	if (!validSession(options.session)) throw new Error(`holder: --session must be a ${HOST_LABELS[options.host ?? "claude-code"]} session id`);
	const log = holderLogger(agent.dir);
	try {
		const [{ createAgentModels, savedSummaryLoginsOnly }, { FileCredentialStore }, { configureHttp }] = await Promise.all([
			import("../agent/models.ts"),
			import("../agent/credentials.ts"),
			import("../agent/http.ts"),
		]);
		configureHttp();
		const models = agentModelSource(createAgentModels({ credentials: new FileCredentialStore(config.credentialsPath), providers: config.providers, savedLoginsOnly: savedSummaryLoginsOnly(agent) }));
		const holder = await Holder.start({ config, agent, ...options, models, log });
		if (holder === undefined) return 0;
		// The daily update check for this session's hooks (src/claude/notices.ts): here, in the session's long-lived
		// process, because a hook must never wait on the network. A later hook shows the answer.
		const stopChecks = config.updates.check ? refreshEvery(process.env) : () => {};
		process.once("SIGTERM", () => void holder.stop("SIGTERM"));
		await holder.done;
		stopChecks();
		return 0;
	} catch (error) {
		log(`holder failed: ${errorText(error)}`);
		throw error;
	}
}
