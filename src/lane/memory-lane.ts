/** A lane's open memory, in whichever agent holds it (pi, or Claude Code's holder): its store (the single writer), view, compactor and status file. */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Compactor, localIso, MemoryStore, MemoryView, type Summarizer } from "../memory/index.ts";
import { COMPACTOR_MODEL_KEY, storedChoice } from "./choices.ts";
import type { HarnessConfig, LaneConfig, ModelChoice } from "./config.ts";
import { type ModelSource, sourceCompactorModel } from "./model-source.ts";
import { explainFailure, safeText } from "./source-labels.ts";
import { laneSummarizer } from "./summarizer.ts";
import type { Agent } from "./view-text.ts";
import { attachRemoteStore, checkOutLane, remoteFooter } from "../remote/checkout.ts";
import type { RemoteSession } from "../remote/session.ts";
import type { LockState, Storage } from "../remote/types.ts";
import { holdWriterLock, type WriterLock } from "../memory/store.ts";
import { openYielding } from "./handover.ts";

type MemoryLaneOptions = { lane: LaneConfig; models: ModelSource; report(message: string): void; agent?: Agent; writer?: WriterLock };

/** Another writer already holds the lane's store. */
export class LaneHeld extends Error {
	constructor(lane: string, agent: Agent = "pi") {
		// In OMP the holder may be pi, OMP or Claude Code; pi keeps its words.
		super(agent === "omp" ? `${lane} is already open in another session; this OMP runs without memory.` : `${lane} is already open in another pi; this one runs without memory.`);
		this.name = "LaneHeld";
	}
}

/** Why summaries cannot come now, if they cannot: `stopped` waits for a fix, `failing` retries on its own. */
export interface SummaryTrouble {
	readonly state: "stopped" | "failing";
	/** The raw provider text. Internal only: never shown to the user, never written to status.json. */
	readonly reason?: string;
	/** For the user: which source and what went wrong, never a key (source-labels explainFailure). */
	readonly plain: string;
}

const compactorSession = (lane: LaneConfig) => `compactor:${lane.name}`;

/** The compactor's per-part line (src/memory/compactor.ts): `Compactor <start>+<n>: <raw error>; retrying every <s>s`. */
const PART_RETRY = /^Compactor \d+\+\d+: [\s\S]*; retrying every \d+(\.\d+)?s$/;

/**
 * The compactor's reports as the user may see them: its per-part retry lines carry raw provider text and come once
 * per newly failing part, so they are dropped (the state notices cover failures); anything else is cleaned.
 */
export function compactorReport(report: (message: string) => void): (message: string) => void {
	return (message) => {
		if (!PART_RETRY.test(message)) report(safeText(message));
	};
}

/** An open lane: store, view, compactor and status file for `agent`. */
export class MemoryLane {
	readonly config: LaneConfig;
	#remote?: RemoteSession;
	#writer?: WriterLock;
	get remote(): RemoteSession | undefined { return this.#remote; }
	readonly store: MemoryStore;
	readonly view: MemoryView;
	readonly compactor: Compactor;
	readonly #models: ModelSource;
	readonly agent: Agent;
	compactorModel: ModelChoice;
	compactorSource: "config" | "chat";
	/** Why the compactor never started (its summary model is unknown here); cleared when /compactor starts it. */
	summariesOff: string | undefined;

	private constructor(parts: {
		config: LaneConfig;
		store: MemoryStore;
		view: MemoryView;
		compactor: Compactor;
		models: ModelSource;
		choice: ModelChoice;
		source: "config" | "chat";
		off: string | undefined;
		agent: Agent;
	}) {
		this.config = parts.config;
		this.store = parts.store;
		this.view = parts.view;
		this.compactor = parts.compactor;
		this.#models = parts.models;
		this.compactorModel = parts.choice;
		this.compactorSource = parts.source;
		this.summariesOff = parts.off;
		this.agent = parts.agent;
	}

	/** Reserve the local writer through handover first; keep it across remote checkout, restore and the writer's life. */
	static async openChecked(options: MemoryLaneOptions & {
		config: HarnessConfig;
		confirmTakeover?: (held: LockState) => Promise<boolean>;
		storage?: Storage;
		signal?: AbortSignal;
		open?: (open: () => MemoryLane) => Promise<MemoryLane>;
	}): Promise<MemoryLane> {
		if (options.lane.remote === undefined) return options.open === undefined ? MemoryLane.open(options) : options.open(() => MemoryLane.open(options));
		const reserve = (): Promise<MemoryLane> => {
			options.signal?.throwIfAborted();
			let writer: WriterLock;
			try { writer = holdWriterLock(join(options.lane.dir, "memory.sqlite")); }
			catch (error) {
				if (/already open/i.test(String(error))) throw new LaneHeld(options.lane.name, options.agent);
				throw error;
			}
			return (async () => {
				let remote: RemoteSession | undefined;
				try {
					remote = await checkOutLane(options.config, options.lane, { ...options, writer });
					options.signal?.throwIfAborted();
					const memory = MemoryLane.open({ ...options, writer });
					memory.#writer = writer;
					memory.#remote = remote;
					if (remote !== undefined) attachRemoteStore(remote, memory.store, () => {
						writer();
						void memory.compactor.close();
						memory.view.changes.notify();
						memory.writeStatus(false, false);
					});
					return memory;
				} catch (error) {
					try { await remote?.close(); } finally { writer(); }
					throw error;
				}
			})();
		};
		// Existing callers wrap the factory in openYielding, which preserves its result (and awaits a promise).
		// Keep their synchronous factory signature compatible, but acquire synchronously so LaneHeld still retries.
		const handover = options.open as ((open: () => Promise<MemoryLane>) => Promise<MemoryLane>) | undefined;
		return handover === undefined ? openYielding(reserve, options.lane.dir) : handover(reserve);
	}

	static open(options: MemoryLaneOptions): MemoryLane {
		const { lane, models } = options;
		mkdirSync(lane.dir, { recursive: true, mode: 0o700 });
		let store: MemoryStore;
		try {
			store = MemoryStore.open(join(lane.dir, "memory.sqlite"), options.writer);
		} catch (error) {
			if (/already open/i.test(error instanceof Error ? error.message : String(error))) throw new LaneHeld(lane.name, options.agent);
			throw error;
		}
		try {
			const stored = storedChoice(store, COMPACTOR_MODEL_KEY, (p, id) => models.find(p, id) !== undefined);
			if (stored.stale !== undefined) options.report(`Orrery: the summary model chosen in chat (${stored.stale}) is gone; using the config's.`);
			const choice = stored.choice ?? lane.compactor.model;
			const view = new MemoryView(store, lane.memory.viewBytes);
			// An unknown summary model must not cost the lane its memory, logging or guard: the lane opens and the
			// compactor waits for /compactor to name a model pi knows.
			const off = models.find(choice.provider, choice.modelId) === undefined ? `unknown model ${choice.provider}/${choice.modelId}` : undefined;
			let summarizer: Summarizer = { summarize: async () => Promise.reject(new Error(`Orrery: summaries are off: ${off}`)) };
			if (off === undefined) {
				const { model, contextWindow } = sourceCompactorModel(models, choice, compactorSession(lane));
				summarizer = laneSummarizer(lane, model, contextWindow, store);
			}
			const compactor = new Compactor(
				view,
				summarizer,
				{ nodeBytes: lane.memory.nodeBytes, jobs: lane.compactor.jobs, retrySeconds: lane.memory.retrySeconds, contextBytes: lane.compactor.contextBytes },
				compactorReport(options.report),
			);
			if (off === undefined) compactor.start();
			else options.report(`Orrery: ${lane.name}: summaries are off: ${off}. Choose a summary model with /compactor provider/id.`);
			return new MemoryLane({ config: lane, store, view, compactor, models, choice, source: stored.choice ? "chat" : "config", off, agent: options.agent ?? "pi" });
		} catch (error) {
			store.close();
			throw error;
		}
	}

	/** Switches the summary model for the next summaries; undefined returns to the config. Survives restarts. */
	setCompactorModel(choice: ModelChoice | undefined): void {
		const next = choice ?? this.config.compactor.model;
		const { model, contextWindow } = sourceCompactorModel(this.#models, next, compactorSession(this.config));
		this.compactor.summarizer = laneSummarizer(this.config, model, contextWindow, this.store);
		this.store.setMeta(COMPACTOR_MODEL_KEY, choice === undefined ? "" : JSON.stringify(choice));
		this.compactorModel = next;
		this.compactorSource = choice === undefined ? "config" : "chat";
		if (this.summariesOff !== undefined) {
			this.summariesOff = undefined;
			this.compactor.start();
		}
	}

	/** Why pending summaries will not come soon (off, stopped, or failing), or undefined when they can. */
	summaryTrouble(): SummaryTrouble | undefined {
		if (this.summariesOff !== undefined) return { state: "stopped", reason: this.summariesOff, plain: this.summariesOff };
		if (this.compactor.stopped) {
			return { state: "stopped", reason: this.compactor.lastError, plain: this.compactor.lastError === undefined ? "stopped" : explainFailure(this.compactorModel.provider, this.compactor.lastError) };
		}
		if (this.compactor.failed.size > 0) {
			return { state: "failing", reason: this.compactor.lastError, plain: explainFailure(this.compactorModel.provider, this.compactor.lastError) };
		}
		return undefined;
	}

	/** Waits for the view to settle; returns early once summaries cannot come (see summaryTrouble) or `signal` aborts. */
	async awaitSummaries(signal: AbortSignal): Promise<void> {
		while (!this.remote?.lost && !this.view.settled && this.summaryTrouble() === undefined && !signal.aborted) {
			const changed = this.view.changes.next();
			await new Promise<void>((resolve) => {
				const done = () => {
					signal.removeEventListener("abort", done);
					resolve();
				};
				signal.addEventListener("abort", done, { once: true });
				void changed.then(done);
			});
		}
	}

	statusLine(): string {
		const stats = this.view.stats();
		let summaries = stats.settled ? "" : " · summarizing";
		if (this.summariesOff !== undefined) summaries = ` · SUMMARIES STOPPED: ${this.summariesOff}`;
		else if (this.compactor.stopped) summaries = " · SUMMARIES STOPPED";
		else if (this.compactor.failed.size > 0) summaries = ` · SUMMARIES FAILING: ${this.summaryTrouble()?.plain} · /compactor`;
		return `Orrery · ${this.config.name} · ${stats.messages} msgs${summaries}${this.remote === undefined ? "" : ` · ${remoteFooter(this.remote.status())}`}`;
	}

	/** `open: false` marks a lane whose pi closed it (the process may live on in another folder). */
	writeStatus(busy = false, open = true): void {
		const m = this.compactorModel;
		const trouble = this.summaryTrouble();
		const status = {
			lane: this.config.name,
			pid: process.pid,
			open: this.remote?.lost ? false : open,
			busy: this.remote?.lost ? false : busy,
			model: this.agent,
			thinking: this.agent,
			memory: this.view.stats(),
			compactor: {
				stopped: this.compactor.stopped || this.summariesOff !== undefined,
				failing: this.compactor.failed.size,
				model: `${m.provider}/${m.modelId}`,
				thinking: m.thinking,
				source: this.compactorSource,
			},
			trouble: trouble === undefined ? null : { state: trouble.state, plain: trouble.plain },
			lastError: trouble?.plain ?? null,
			updatedAt: localIso(),
		};
		const file = join(this.config.dir, "status.json");
		writeFileSync(`${file}.tmp`, JSON.stringify(status), { mode: 0o600 });
		renameSync(`${file}.tmp`, file);
	}

	/** The completed turn is durable locally; sending it must not hold up the next turn. The callback observes success or failure. */
	afterTurn(onSaveSettled?: () => void): void {
		void this.remote?.save().then(onSaveSettled);
	}

	/** Closes the store (releasing the writer lock) even if the compactor fails to close. */
	async close(): Promise<void> {
		try {
			await this.compactor.close();
		} finally {
			try {
				await this.remote?.close();
			} finally {
				try { this.store.close(); } finally { this.#writer?.(); }
			}
		}
	}
}
