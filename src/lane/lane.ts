/** A lane: one pi-durable conversation with OptChat memory, its compactor, projector, tools and status file. */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { type Conversation, createRegistry, Harness, LiveDoc } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import {
	Compactor,
	localIso,
	MemoryStore,
	MemoryView,
	ModelSummarizer,
} from "../memory/index.ts";
import { attachRemoteStore, checkOutLane, remoteOpenNotice } from "../remote/checkout.ts";
import type { RemoteSession } from "../remote/session.ts";
import { holdWriterLock, type WriterLock } from "../memory/store.ts";
import { findLane, type HarnessConfig, type LaneConfig, type ModelChoice, parseModelChoice } from "./config.ts";
import { FileCredentialStore } from "./credentials.ts";
import { AGENT_MODEL_KEY, COMPACTOR_MODEL_KEY, storedChoice } from "./choices.ts";
import { createLaneEnv, type LaneEnv } from "./env.ts";
import { memoryExtension } from "./extension.ts";
import { guardExtension } from "./guard.ts";
import { compactorModel, createLaneModels, modelContextWindow, savedSummaryLoginsOnly } from "./models.ts";
import { Projector } from "./projector.ts";
import { laneSummarizer } from "./summarizer.ts";
export { type LaneStatus, type ModelSource, readStatus } from "./status-file.ts";
import type { LaneStatus, ModelSource } from "./status-file.ts";
import { laneSubmit, type SubmitResult } from "./submit.ts";

/** Compaction only as a blocking in-run overflow guard (spec §5.3). Never pass undefined fields (pi 1.0.x). */
export const LANE_SETTINGS = { compaction: { enabled: true, backgroundTokens: 0 } } as const;

export interface OpenLaneOptions {
	readonly config: HarnessConfig;
	readonly lane: string;
	readonly models?: Models;
	readonly context?: Context;
	readonly onFatal?: (reason: string) => void;
}

/** The summarizer for a lane's compactor model: the oversized-source rule and usage rows (spec §5.5). */
export function createLaneSummarizer(config: LaneConfig, models: Models, store: MemoryStore, choice: ModelChoice): ModelSummarizer {
	return laneSummarizer(config, compactorModel(models, choice, `compactor:${config.name}`), modelContextWindow(models, choice), store);
}

/** The compactor for a lane, with its configured model unless `choice` overrides it. */
export function createLaneCompactor(
	config: LaneConfig,
	models: Models,
	store: MemoryStore,
	view: MemoryView,
	report: (message: string) => void,
	choice: ModelChoice = config.compactor.model,
): Compactor {
	return new Compactor(
		view,
		createLaneSummarizer(config, models, store, choice),
		{ nodeBytes: config.memory.nodeBytes, jobs: config.compactor.jobs, retrySeconds: config.memory.retrySeconds, contextBytes: config.compactor.contextBytes },
		report,
	);
}

export class Lane {
	readonly config: LaneConfig;
	readonly models: Models;
	readonly remote?: RemoteSession;
	readonly store: MemoryStore;
	readonly view: MemoryView;
	readonly compactor: Compactor;
	readonly harness: Harness;
	readonly conversation: Conversation;
	readonly projector: Projector;
	readonly #env: LaneEnv;
	readonly #context: Context;
	readonly #onFatal: ((reason: string) => void) | undefined;
	readonly #configModel: ModelChoice;
	readonly #summaryModels: Models;
	model: ModelChoice;
	modelSource: ModelSource;
	compactorModel: ModelChoice;
	compactorSource: ModelSource;
	report: (message: string) => void = (message) => process.stderr.write(`${message}\n`);
	#lastError: string | null = null;
	#fatal = false;
	#statusTimer: NodeJS.Timeout | undefined;
	#unsubscribe: () => void = () => {};
	#closing = false;
	readonly #writer?: WriterLock;
	readonly #memoryLost = new AbortController();
	#saveTimer: NodeJS.Immediate | undefined;
	#saving: Promise<void> = Promise.resolve();

	private constructor(parts: {
		config: LaneConfig;
		remote?: RemoteSession;
		writer?: WriterLock;
		models: Models;
		store: MemoryStore;
		view: MemoryView;
		compactor: Compactor;
		harness: Harness;
		conversation: Conversation;
		projector: Projector;
		env: LaneEnv;
		context: Context;
		onFatal: ((reason: string) => void) | undefined;
		configModel: ModelChoice;
		summaryModels: Models;
		model: ModelChoice;
		modelSource: ModelSource;
		compactorModel: ModelChoice;
		compactorSource: ModelSource;
	}) {
		this.config = parts.config;
		this.remote = parts.remote;
		this.#writer = parts.writer;
		this.models = parts.models;
		this.store = parts.store;
		this.view = parts.view;
		this.compactor = parts.compactor;
		this.harness = parts.harness;
		this.conversation = parts.conversation;
		this.projector = parts.projector;
		this.#env = parts.env;
		this.#context = parts.context;
		this.#onFatal = parts.onFatal;
		this.#configModel = parts.configModel;
		this.#summaryModels = parts.summaryModels;
		this.model = parts.model;
		this.modelSource = parts.modelSource;
		this.compactorModel = parts.compactorModel;
		this.compactorSource = parts.compactorSource;
	}

	static async open(options: OpenLaneOptions): Promise<Lane> {
		const config = findLane(options.config, options.lane);
		const configModel = config.model;
		if (configModel === undefined) throw new Error(`${config.name} has no model in the config; orrery run needs one (model = "provider/id").`);
		const context = options.context ?? BACKGROUND_CONTEXT;
		let lane: Lane | undefined;
		// Before the lane exists, a local lane drops reports as it always did; a remote lane's check-out notices go to stderr.
		const relay = (message: string) => {
			if (lane !== undefined) lane.handleReport(message);
			else if (config.remote !== undefined) process.stderr.write(`${message}\n`);
		};
		let remote: RemoteSession | undefined;
		const writer = config.remote === undefined ? undefined : holdWriterLock(join(config.dir, "memory.sqlite"));
		try {
			remote = await checkOutLane(options.config, config, { report: relay, writer });
		} catch (error) {
			writer?.();
			throw new Error(remoteOpenNotice(config, error), { cause: error });
		}
		let store: MemoryStore;
		try {
			mkdirSync(config.dir, { recursive: true, mode: 0o700 });
			store = MemoryStore.open(join(config.dir, "memory.sqlite"), writer);
		} catch (error) {
			try { await remote?.close(); } finally { writer?.(); }
			throw error;
		}
		if (remote !== undefined) attachRemoteStore(remote, store, () => {
			writer?.();
			if (lane !== undefined) lane.#memoryLost.abort();
			void lane?.projector.stop();
			void lane?.compactor.close();
			void lane?.writeStatus(false, false).catch(() => {});
		});
		try {
			const models =
				options.models ??
				createLaneModels({ credentials: new FileCredentialStore(options.config.credentialsPath), providers: options.config.providers });
			if (models.getModel(configModel.provider, configModel.modelId) === undefined) {
				throw new Error(`Unknown model ${configModel.provider}/${configModel.modelId}`);
			}
			// Models chosen in chat (/model, /compactor) outlive restarts; one no longer available falls back to the config.
			const exists = (provider: string, modelId: string) => models.getModel(provider, modelId) !== undefined;
			const agentChoice = storedChoice(store, AGENT_MODEL_KEY, exists);
			const compactorChoice = storedChoice(store, COMPACTOR_MODEL_KEY, exists);
			const model = agentChoice.choice ?? configModel;
			const compactorChosen = compactorChoice.choice ?? config.compactor.model;
			const view = new MemoryView(store, config.memory.viewBytes);
			const summaryModels = options.models ?? (savedSummaryLoginsOnly(config)
				? createLaneModels({ credentials: new FileCredentialStore(options.config.credentialsPath), providers: options.config.providers, savedLoginsOnly: true })
				: models);
			const compactor = createLaneCompactor(config, summaryModels, store, view, relay, compactorChosen);
			const env = createLaneEnv(config.host, config.workspace, options.config.sshDir, context);
			const instructionsPath = posix.isAbsolute(config.instructions) ? config.instructions : posix.join(config.workspace, config.instructions);
			const fresh = await env.readText(instructionsPath);
			if (fresh !== undefined && store.getMeta("instructions") !== fresh) store.setMeta("instructions", fresh);
			const instructions = fresh ?? store.getMeta("instructions") ?? "";
			const registry = createRegistry();
			registry.install(CodingTools);
			registry.install(memoryExtension({ view, instructions: () => instructions }));
			registry.install(guardExtension({ workspace: config.workspace, allowedRoots: config.allowedRoots, credentials: [options.config.credentialsPath], orreryData: options.config.dataDir }));
			const storage = await openNodeSqliteStorage(join(config.dir, "session.sqlite"));
			const harness = await Harness.open(
				storage,
				{ models, registry, settings: LANE_SETTINGS, env: (target) => env.env(target.cwd), onReport: (error) => relay(`pi: ${String(error)}`) },
				context,
			);
			const conversation = await harness.root(context, {
				agent: { model: { provider: model.provider, modelId: model.modelId }, thinkingLevel: model.thinking, cwd: config.workspace },
			});
			// An existing conversation keeps its own settings: apply the lane's model explicitly before anything runs.
			await conversation.configure({ model: { provider: model.provider, modelId: model.modelId }, thinkingLevel: model.thinking }, context);
			const projector = new Projector(conversation, view, { toolCap: config.memory.toolCap, context, report: relay });
			lane = new Lane({
				config,
				remote,
				writer,
				models,
				store,
				view,
				compactor,
				harness,
				conversation,
				projector,
				env,
				context,
				onFatal: options.onFatal,
				summaryModels,
				configModel,
				model,
				modelSource: agentChoice.choice ? "chat" : "config",
				compactorModel: compactorChosen,
				compactorSource: compactorChoice.choice ? "chat" : "config",
			});
			for (const stale of [agentChoice.stale, compactorChoice.stale]) {
				if (stale !== undefined) lane.report(`The model chosen in chat (${stale}) is no longer available; using the config's.`);
			}
			compactor.start();
			projector.start(harness);
			await projector.drain();
			harness.resume();
			lane.#unsubscribe = harness.subscribeCommits(() => {
				lane?.scheduleStatus();
				if (lane !== undefined) lane.#scheduleSave();
			});
			lane.#scheduleSave();
			await lane.writeStatus();
			return lane;
		} catch (error) {
			if (lane === undefined) {
				try { await remote?.close(); } finally { try { store.close(); } finally { writer?.(); } }
			}
			else await lane.close();
			throw error;
		}
	}

	/** Report a problem, remember it for status, and escalate if memory can no longer be written. */
	handleReport(message: string): void {
		this.#lastError = message;
		this.report(message);
		if (!this.remote?.lost && !this.#fatal && (this.compactor.stopped || !this.store.writable)) {
			this.#fatal = true;
			this.#onFatal?.("Memory can no longer be written (store refused a write or the compactor stopped); restart the lane.");
		}
		this.scheduleStatus();
	}

	async #renderView(signal?: AbortSignal): Promise<string | undefined> {
		if (this.remote?.lost) return "";
		if (this.remote === undefined) {
			await this.projector.drain();
			if (!(await this.view.settle(signal))) return undefined;
			return this.view.render();
		}
		let wake!: () => void;
		const lost = new Promise<void>((resolve) => { wake = resolve; });
		this.#memoryLost.signal.addEventListener("abort", wake, { once: true });
		try { await Promise.race([this.projector.drain(), lost]); }
		catch (error) { if (!this.remote.lost) throw error; }
		finally { this.#memoryLost.signal.removeEventListener("abort", wake); }
		if (this.remote?.lost) return "";
		const waitSignal = signal === undefined ? this.#memoryLost.signal : AbortSignal.any([signal, this.#memoryLost.signal]);
		const settled = await this.view.settle(waitSignal);
		if (this.remote?.lost) return "";
		if (!settled) return undefined;
		return this.view.render();
	}

	submit(text: string, requestId: string, signal?: AbortSignal): Promise<SubmitResult | undefined> {
		return laneSubmit(
			{ harness: this.harness, conversation: this.conversation, context: this.#context, renderView: (s) => this.#renderView(s) },
			text,
			requestId,
			signal,
		).catch((error: unknown) => {
			this.handleReport(error instanceof Error ? error.message : String(error));
			throw error;
		});
	}

	/** Switches the agent model for the next runs and remembers it across restarts; `undefined` returns to the config. */
	async setModel(choice: ModelChoice | undefined): Promise<void> {
		const next = choice ?? this.#configModel;
		if (this.models.getModel(next.provider, next.modelId) === undefined) throw new Error(`Unknown model ${next.provider}/${next.modelId}`);
		await this.conversation.configure({ model: { provider: next.provider, modelId: next.modelId }, thinkingLevel: next.thinking }, this.#context);
		this.store.setMeta(AGENT_MODEL_KEY, choice === undefined ? "" : JSON.stringify(choice));
		this.model = next;
		this.modelSource = choice === undefined ? "config" : "chat";
		this.scheduleStatus();
	}

	/** Switches the compactor model for the next summaries and remembers it across restarts; `undefined` returns to the config. */
	async setCompactorModel(choice: ModelChoice | undefined): Promise<void> {
		const next = choice ?? this.config.compactor.model;
		if (this.#summaryModels.getModel(next.provider, next.modelId) === undefined) throw new Error(`Unknown model ${next.provider}/${next.modelId}`);
		this.compactor.summarizer = createLaneSummarizer(this.config, this.#summaryModels, this.store, next);
		this.store.setMeta(COMPACTOR_MODEL_KEY, choice === undefined ? "" : JSON.stringify(choice));
		this.compactorModel = next;
		this.compactorSource = choice === undefined ? "config" : "chat";
		this.scheduleStatus();
	}

	async status(): Promise<LaneStatus> {
		const live = await this.harness.snapshot(LiveDoc, this.conversation.id, this.#context);
		return this.#status(live?.run !== undefined);
	}

	/** Cached memory state is still readable after fencing closes the store. */
	#status(busy: boolean): LaneStatus {
		return {
			lane: this.config.name,
			pid: process.pid,
			...(this.remote?.lost ? { open: false } : {}),
			busy: this.remote?.lost ? false : busy,
			model: `${this.model.provider}/${this.model.modelId}`,
			thinking: this.model.thinking,
			memory: this.view.stats(),
			modelSource: this.modelSource,
			compactor: {
				stopped: this.compactor.stopped,
				failing: this.compactor.failed.size,
				model: `${this.compactorModel.provider}/${this.compactorModel.modelId}`,
				thinking: this.compactorModel.thinking,
				source: this.compactorSource,
			},
			lastError: this.#lastError,
			updatedAt: localIso(),
		};
	}

	async writeStatus(busy?: boolean, open?: boolean): Promise<void> {
		// Explicit state (onLost) is written synchronously, without waiting on the still-running agent's harness.
		let status = busy === undefined ? await this.status() : this.#status(busy);
		if (open !== undefined) status = { ...status, open };
		// Recheck after awaits: an older pending heartbeat must never reopen a fenced-out working copy.
		if (this.remote?.lost) status = { ...status, open: false, busy: false };
		const file = join(this.config.dir, "status.json");
		const temp = `${file}.${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
		renameSync(temp, file);
	}

	scheduleStatus(): void {
		if (this.#statusTimer !== undefined) return;
		this.#statusTimer = setTimeout(() => {
			this.#statusTimer = undefined;
			this.writeStatus().catch(() => {});
		}, 250);
	}

	/** Observe the idle boundary outside the commit listener; this also covers turns resumed after a restart. */
	#scheduleSave(): void {
		if (this.remote === undefined || this.remote.lost || this.#closing || this.#saveTimer !== undefined) return;
		this.#saveTimer = setImmediate(() => {
			this.#saveTimer = undefined;
			this.#saving = this.#saving.then(async () => {
				if (this.#closing || this.remote?.lost) return;
				const live = await this.harness.snapshot(LiveDoc, this.conversation.id, this.#context);
				if (live?.run !== undefined) return;
				await this.projector.drain();
				await this.remote?.save();
			}).catch((error: unknown) => {
				if (!this.#closing && !this.remote?.lost) this.handleReport(String(error));
			});
		});
	}

	async close(): Promise<void> {
		if (this.#closing) return;
		this.#closing = true;
		if (this.#saveTimer !== undefined) clearImmediate(this.#saveTimer);
		this.#unsubscribe();
		if (this.#statusTimer !== undefined) clearTimeout(this.#statusTimer);
		try {
			await this.projector.stop();
			await this.compactor.close();
			await this.#saving;
		} finally {
			try {
				await this.remote?.close();
				await this.writeStatus().catch(() => {});
				await this.harness.close(this.#context);
				await this.#env.close();
			} finally { try { this.store.close(); } finally { this.#writer?.(); } }
		}
	}
}
