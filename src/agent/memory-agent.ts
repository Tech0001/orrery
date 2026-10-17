/** An agent's open memory, in whichever tool holds it (pi, OMP, OpenCode, or Claude Code's or Codex's holder): its store (the single writer), view, compactor and status file. */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Compactor, localIso, MemoryStore, MemoryView, type Summarizer } from "../memory/index.ts";
import { COMPACTOR_MODEL_KEY, storedChoice } from "./choices.ts";
import type { HarnessConfig, AgentConfig, ModelChoice } from "./config.ts";
import { type ModelSource, sourceCompactorModel } from "./model-source.ts";
import { instructionsFacts } from "./instructions.ts";
import { explainFailure, safeText } from "./source-labels.ts";
import { agentSummarizer } from "./summarizer.ts";
import type { Host } from "./view-text.ts";
import { attachRemoteStore, checkOutAgent, remoteFooter } from "../remote/checkout.ts";
import type { RemoteSession } from "../remote/session.ts";
import type { LockState, Storage } from "../remote/types.ts";
import { holdWriterLock, type WriterLock } from "../memory/store.ts";
import { openYielding } from "./handover.ts";
import { statusVersion } from "./status-file.ts";

type MemoryAgentOptions = { agent: AgentConfig; models: ModelSource; report(message: string): void; host?: Host; writer?: WriterLock };

/** Another writer already holds the agent's store. */
export class AgentHeld extends Error {
	constructor(agent: string, host: Host = "pi") {
		// In OMP and OpenCode the holder may be any tool; pi keeps its words.
		const label = host === "omp" ? "OMP" : host === "opencode" ? "OpenCode" : undefined;
		super(label !== undefined ? `${agent} is already open in another session; this ${label} runs without memory.` : `${agent} is already open in another pi; this one runs without memory.`);
		this.name = "AgentHeld";
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

const compactorSession = (agent: AgentConfig) => `compactor:${agent.name}`;

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

/** An open agent: store, view, compactor and status file for `host`. */
export class MemoryAgent {
	readonly config: AgentConfig;
	#remote?: RemoteSession;
	#writer?: WriterLock;
	get remote(): RemoteSession | undefined { return this.#remote; }
	readonly store: MemoryStore;
	readonly view: MemoryView;
	readonly compactor: Compactor;
	readonly #models: ModelSource;
	readonly host: Host;
	compactorModel: ModelChoice;
	compactorSource: "config" | "chat";
	/** Why the compactor never started (its summary model is unknown here); cleared when /compactor starts it. */
	summariesOff: string | undefined;
	/**
	 * instructions.md's modification time when the session last read it (undefined: it had none): when this agent opened,
	 * and again at an OMP session switch (src/pi/index.ts). status.json carries it.
	 */
	instructionsAt: number | undefined;

	private constructor(parts: {
		config: AgentConfig;
		store: MemoryStore;
		view: MemoryView;
		compactor: Compactor;
		models: ModelSource;
		choice: ModelChoice;
		source: "config" | "chat";
		off: string | undefined;
		host: Host;
		instructionsAt: number | undefined;
	}) {
		this.config = parts.config;
		this.store = parts.store;
		this.view = parts.view;
		this.compactor = parts.compactor;
		this.#models = parts.models;
		this.compactorModel = parts.choice;
		this.compactorSource = parts.source;
		this.summariesOff = parts.off;
		this.host = parts.host;
		this.instructionsAt = parts.instructionsAt;
	}

	/** Reserve the local writer through handover first; keep it across remote checkout, restore and the writer's life. */
	static async openChecked(options: MemoryAgentOptions & {
		config: HarnessConfig;
		confirmTakeover?: (held: LockState) => Promise<boolean>;
		storage?: Storage;
		signal?: AbortSignal;
		open?: (open: () => MemoryAgent) => Promise<MemoryAgent>;
	}): Promise<MemoryAgent> {
		if (options.agent.remote === undefined) return options.open === undefined ? MemoryAgent.open(options) : options.open(() => MemoryAgent.open(options));
		const reserve = (): Promise<MemoryAgent> => {
			options.signal?.throwIfAborted();
			let writer: WriterLock;
			try { writer = holdWriterLock(join(options.agent.dir, "memory.sqlite")); }
			catch (error) {
				if (/already open/i.test(String(error))) throw new AgentHeld(options.agent.name, options.host);
				throw error;
			}
			return (async () => {
				let remote: RemoteSession | undefined;
				try {
					remote = await checkOutAgent(options.config, options.agent, { ...options, writer });
					options.signal?.throwIfAborted();
					const memory = MemoryAgent.open({ ...options, writer });
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
		// Keep their synchronous factory signature compatible, but acquire synchronously so AgentHeld still retries.
		const handover = options.open as ((open: () => Promise<MemoryAgent>) => Promise<MemoryAgent>) | undefined;
		return handover === undefined ? openYielding(reserve, options.agent.dir) : handover(reserve);
	}

	static open(options: MemoryAgentOptions): MemoryAgent {
		const { agent, models } = options;
		mkdirSync(agent.dir, { recursive: true, mode: 0o700 });
		let store: MemoryStore;
		try {
			store = MemoryStore.open(join(agent.dir, "memory.sqlite"), options.writer);
		} catch (error) {
			if (/already open/i.test(error instanceof Error ? error.message : String(error))) throw new AgentHeld(agent.name, options.host);
			throw error;
		}
		try {
			const stored = storedChoice(store, COMPACTOR_MODEL_KEY, (p, id) => models.find(p, id) !== undefined);
			if (stored.stale !== undefined) options.report(`Orrery: the summary model chosen in chat (${stored.stale}) is gone; using the config's.`);
			const choice = stored.choice ?? agent.compactor.model;
			const view = new MemoryView(store, agent.memory.viewBytes);
			// An unknown summary model must not cost the agent its memory, logging or guard: the agent opens and the
			// compactor waits for /compactor to name a model pi knows.
			const off = models.find(choice.provider, choice.modelId) === undefined ? `unknown model ${choice.provider}/${choice.modelId}` : undefined;
			let summarizer: Summarizer = { summarize: async () => Promise.reject(new Error(`Orrery: summaries are off: ${off}`)) };
			if (off === undefined) {
				const { model, contextWindow } = sourceCompactorModel(models, choice, compactorSession(agent));
				summarizer = agentSummarizer(agent, model, contextWindow, store);
			}
			const compactor = new Compactor(
				view,
				summarizer,
				{ nodeBytes: agent.memory.nodeBytes, jobs: agent.compactor.jobs, retrySeconds: agent.memory.retrySeconds, contextBytes: agent.compactor.contextBytes },
				compactorReport(options.report),
			);
			if (off === undefined) compactor.start();
			else options.report(`Orrery: ${agent.name}: summaries are off: ${off}. Choose a summary model with /compactor provider/id.`);
			// After a remote check-out (openChecked), which may bring newer instructions with the memory.
			const { at: instructionsAt } = instructionsFacts(agent.dir);
			return new MemoryAgent({ config: agent, store, view, compactor, models, choice, source: stored.choice ? "chat" : "config", off, host: options.host ?? "pi", instructionsAt });
		} catch (error) {
			store.close();
			throw error;
		}
	}

	/** Switches the summary model for the next summaries; undefined returns to the config. Survives restarts. */
	setCompactorModel(choice: ModelChoice | undefined): void {
		const next = choice ?? this.config.compactor.model;
		const { model, contextWindow } = sourceCompactorModel(this.#models, next, compactorSession(this.config));
		this.compactor.summarizer = agentSummarizer(this.config, model, contextWindow, this.store);
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

	/** `open: false` marks an agent whose pi closed it (the process may live on in another folder). */
	writeStatus(busy = false, open = true): void {
		const m = this.compactorModel;
		const trouble = this.summaryTrouble();
		const status = {
			agent: this.config.name,
			pid: process.pid,
			open: this.remote?.lost ? false : open,
			busy: this.remote?.lost ? false : busy,
			model: this.host,
			thinking: this.host,
			memory: this.view.stats(),
			compactor: {
				stopped: this.compactor.stopped || this.summariesOff !== undefined,
				failing: this.compactor.failed.size,
				model: `${m.provider}/${m.modelId}`,
				thinking: m.thinking,
				source: this.compactorSource,
			},
			trouble: trouble === undefined ? null : { state: trouble.state, plain: trouble.plain },
			// Whether a summary has worked in this process: without one, no trouble is not yet news that summaries work.
			summarized: this.compactor.summarized > 0,
			lastError: trouble?.plain ?? null,
			updatedAt: localIso(),
			version: statusVersion(),
			// 0: the agent had no instructions when this agent opened, so any written since are newer.
			instructionsAt: this.instructionsAt ?? 0,
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
