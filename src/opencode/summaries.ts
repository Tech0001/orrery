/**
 * The "OpenCode model" summary source in Orrery's plugin (src/agent/opencode-source.ts; spec 2026-10-16-opencode-design,
 * "Summaries through OpenCode", and the user's decision (b)): an agent's summaries made by a model OpenCode has, while
 * the agent is open in OpenCode.
 *
 * Through `ctx.session.generate`, not `ctx.generate.text`. OpenCode 2.0.30's generate.text (core/src/generate.ts) takes
 * one prompt string and sends it as a single user message, with no system prompt, no other turns and no reasoning
 * setting, so a summary's request (Orrery's system prompt, a user turn of several blocks, and on a too-long reply an
 * assistant turn and another user turn) could only go as one flattened message: its prompts would change, which they
 * must not. session.generate (core/src/session/generate.ts) runs a session's `generate` hook, where a plugin sets the
 * request's system parts, messages, tools and options, so the summary goes as it is; the model is the session's. So
 * each summary is one short-lived session of OpenCode's: made with the chosen model (and its variant for the thinking
 * level), its generate hook given Orrery's system prompt and turns (no tools, no options of OpenCode's), and removed
 * when the reply is in. Its title says it is Orrery's, and its metadata marks it, so the plugin never records it.
 * OpenCode sends it with its session headers, as it sends a chat's.
 *
 * Only paid and own-key models are offered: OpenCode's free tier (opencode-source.ts openCodeFree) is listed as
 * unavailable, with the reason. OpenCode gives no token counts for a generate request, so these summaries' usage rows
 * have none.
 */

import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { ModelSource, SourceModel } from "../agent/model-source.ts";
import { FREE_REASON, OPENCODE_SOURCE, openCodeFree, openCodeModelOf, openCodeRef, openCodeVariant } from "../agent/opencode-source.ts";
import type { GenerateEvent } from "./host.ts";

/** The metadata that marks a session as one of Orrery's summaries. */
export const SUMMARY_MARK = { orrery: "summary" } as const;

/** Whether OpenCode's session info or event data is one of Orrery's summary sessions. */
export const summarySession = (data: unknown): boolean => (data as { metadata?: { orrery?: unknown } } | null)?.metadata?.orrery === SUMMARY_MARK.orrery;

/** The API name Orrery gives OpenCode's models (no pi-ai adapter has it: nothing marks a cache prefix). */
export const OPENCODE_API = "opencode-session";

/** How long OpenCode's model list may take. */
const LIST_MS = 10_000;

/** A model OpenCode lists, as the summary source offers it. */
export interface OpenCodeModel {
	/** opencode/<provider>/<model>. */
	readonly ref: string;
	readonly providerID: string;
	readonly id: string;
	readonly name: string;
	readonly contextWindow: number;
	/** Dollars per million tokens, when OpenCode lists a price. */
	readonly price?: { readonly input: number; readonly output: number };
	/** Its variants (reasoning efforts), by OpenCode's names. */
	readonly variants: readonly string[];
	/** OpenCode's free tier: listed, never offered (FREE_REASON). */
	readonly free: boolean;
}

/** What the summary source asks of OpenCode, through one of the plugin's folders (its ctx). */
export interface OpenCodeAccess {
	/** The folder the plugin serves: summary sessions are made there. */
	readonly directory: string;
	listModels(): Promise<unknown>;
	createSession(input: object): Promise<unknown>;
	generate(input: { sessionID: string; prompt: string }, options: { signal?: AbortSignal }): Promise<unknown>;
	removeSession(input: { sessionID: string }): Promise<unknown>;
}


/** OpenCode's model list (`{data: ModelInfo[]}`, or the list itself) as the source's models; what can't be read is left out. */
export function readModelList(answer: unknown): OpenCodeModel[] {
	const list = Array.isArray(answer) ? answer : (answer as { data?: unknown } | null)?.data;
	if (!Array.isArray(list)) return [];
	const models: OpenCodeModel[] = [];
	for (const item of list as Record<string, unknown>[]) {
		const { providerID, id, name, enabled, limit, cost, variants } = item ?? {};
		if (typeof providerID !== "string" || typeof id !== "string" || providerID === "" || id === "" || enabled === false) continue;
		const costs = Array.isArray(cost) ? (cost as { input?: unknown; output?: unknown }[]).map((c) => ({ input: Number(c?.input ?? 0), output: Number(c?.output ?? 0) })) : [];
		const first = costs[0];
		models.push({
			ref: openCodeRef({ providerID, id }),
			providerID,
			id,
			name: typeof name === "string" && name !== "" ? name : id,
			contextWindow: Number((limit as { context?: unknown } | undefined)?.context) || 0,
			...(first === undefined || (first.input === 0 && first.output === 0) ? {} : { price: first }),
			variants: Array.isArray(variants) ? variants.map((variant) => (variant as { id?: unknown })?.id).filter((v): v is string => typeof v === "string") : [],
			free: openCodeFree({ providerID, id, cost: costs }),
		});
	}
	return models.sort((a, b) => a.ref.localeCompare(b.ref));
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** `work`, given up when `signal` aborts (OpenCode may not stop at once). */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (signal === undefined) return work;
	signal.throwIfAborted();
	return new Promise<T>((done, fail) => {
		const stop = () => fail(signal.reason ?? new Error("aborted"));
		signal.addEventListener("abort", stop, { once: true });
		work.then(
			(value) => {
				signal.removeEventListener("abort", stop);
				done(value);
			},
			(error) => {
				signal.removeEventListener("abort", stop);
				fail(error);
			},
		);
	});
}

/** A summary request's turns (pi-ai messages) as OpenCode's messages: each text block as it is, in order. */
function openCodeMessages(messages: readonly Message[]): unknown[] {
	return messages.map((message) => {
		const content = Array.isArray(message.content) ? message.content : [{ type: "text", text: String(message.content) }];
		return {
			role: message.role === "assistant" ? "assistant" : "user",
			content: content.filter((block) => (block as { type?: unknown }).type === "text").map((block) => ({ type: "text", text: (block as { text: string }).text })),
		};
	});
}

/**
 * OpenCode's models for an agent's summaries, in one OpenCode server: their list (read when the memory opens, and
 * again for the picker), and the summary requests, through whichever of the plugin's folders is open (the latest).
 */
export class OpenCodeSummaries {
	readonly #agent: string;
	#models: OpenCodeModel[] = [];
	readonly #hosts: OpenCodeAccess[] = [];
	/** Summary sessions waiting for their generate hook: what their request is to be. */
	readonly #pending = new Map<string, { readonly system: string; readonly messages: unknown[] }>();
	/** Why the list could not be read, if it could not. */
	listProblem: string | undefined;
	/** Why no summary can go through OpenCode here, if none can. */
	#off: string | undefined;

	constructor(agent: string) {
		this.#agent = agent;
	}

	/** No summary goes through OpenCode from now on, for `why`. */
	disable(why: string): void {
		this.#off = why;
	}

	/** A folder of the plugin's that summaries may go through, until removed. */
	addHost(host: OpenCodeAccess): void {
		this.#hosts.push(host);
	}

	removeHost(host: OpenCodeAccess): void {
		const at = this.#hosts.indexOf(host);
		if (at >= 0) this.#hosts.splice(at, 1);
	}

	/** Reads OpenCode's model list again (at most LIST_MS); keeps the last one when it can't. Never throws. */
	async refresh(): Promise<readonly OpenCodeModel[]> {
		const host = this.#hosts.at(-1);
		if (host === undefined) return this.#models;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const late = new Promise<never>((_, fail) => {
				timer = setTimeout(() => fail(new Error(`OpenCode did not list its models within ${LIST_MS / 1000} s`)), LIST_MS);
			});
			this.#models = readModelList(await Promise.race([host.listModels(), late]));
			this.listProblem = undefined;
		} catch (error) {
			this.listProblem = errorText(error);
		} finally {
			clearTimeout(timer);
		}
		return this.#models;
	}

	/**
	 * Reads the list again until it has `modelId`, for at most `ms`: OpenCode lists the providers of its config only
	 * once its plugins are set up, and this plugin's memory opens while they are being set up. Never throws.
	 */
	async waitFor(modelId: string, ms: number, signal?: AbortSignal): Promise<void> {
		const until = Date.now() + ms;
		await this.refresh();
		while (this.model(modelId) === undefined && Date.now() < until && signal?.aborted !== true) {
			await new Promise((wait) => setTimeout(wait, 200));
			await this.refresh();
		}
	}

	/** Every model OpenCode lists, free ones among them (marked). */
	get models(): readonly OpenCodeModel[] {
		return this.#models;
	}

	/** The model an OpenCode choice's model id (`<provider>/<model>`) names, if OpenCode lists it. */
	model(modelId: string): OpenCodeModel | undefined {
		const named = openCodeModelOf(modelId);
		return named === undefined ? undefined : this.#models.find((model) => model.providerID === named.providerID && model.id === named.id);
	}

	/** Why an OpenCode model can't make summaries (free, or not listed), or undefined when it can. */
	unavailable(modelId: string): string | undefined {
		if (this.#off !== undefined) return `OpenCode's models can't make summaries here: ${this.#off}`;
		const model = this.model(modelId);
		if (model === undefined) return `OpenCode lists no model ${OPENCODE_SOURCE}/${modelId}${this.listProblem === undefined ? "" : ` (${this.listProblem})`}`;
		return model.free ? FREE_REASON : undefined;
	}

	/** A summary model (SourceModel) for an offered OpenCode model; undefined for a free or unlisted one. */
	find(modelId: string): SourceModel | undefined {
		const model = this.model(modelId);
		if (model === undefined || model.free || this.#off !== undefined) return undefined;
		return { api: OPENCODE_API, provider: OPENCODE_SOURCE, id: modelId, contextWindow: model.contextWindow || 128_000 };
	}

	/** The generate hook's work: a summary session's request is Orrery's system prompt and turns, with no tools. */
	shape(event: GenerateEvent): void {
		const request = this.#pending.get(event.sessionID);
		if (request === undefined) return;
		event.system = [{ type: "text", text: request.system }];
		event.messages = request.messages;
		event.tools = {};
		for (const key of Object.keys(event.options)) delete event.options[key];
	}

	/** One summary reply from `model` (an offered OpenCode model): its text. */
	async complete(modelId: string, system: string, messages: readonly Message[], options: { readonly signal?: AbortSignal; readonly reasoning?: string }): Promise<string> {
		const host = this.#hosts.at(-1);
		if (host === undefined) throw new Error("OpenCode has no folder open with Orrery's plugin");
		const model = this.model(modelId);
		if (model === undefined || model.free) throw new Error(this.unavailable(modelId) ?? `no model ${modelId}`);
		const variant = openCodeVariant((options.reasoning ?? "off") as Parameters<typeof openCodeVariant>[0], model.variants);
		const made = await untilAborted(
			host.createSession({
				location: { directory: host.directory },
				title: `Orrery summary · ${this.#agent}`,
				model: { providerID: model.providerID, id: model.id, ...(variant === undefined ? {} : { variant }) },
				metadata: SUMMARY_MARK,
			}),
			options.signal,
		);
		const sessionID = (made as { id?: unknown; data?: { id?: unknown } } | null)?.id ?? (made as { data?: { id?: unknown } } | null)?.data?.id;
		if (typeof sessionID !== "string") throw new Error("OpenCode made no session for the summary");
		this.#pending.set(sessionID, { system, messages: openCodeMessages(messages) });
		try {
			const answer = await untilAborted(host.generate({ sessionID, prompt: "Summarize." }, { ...(options.signal === undefined ? {} : { signal: options.signal }) }), options.signal);
			const text = (answer as { text?: unknown } | null)?.text ?? (answer as { data?: { text?: unknown } } | null)?.data?.text;
			if (typeof text !== "string") throw new Error("OpenCode's reply had no text");
			return text;
		} finally {
			this.#pending.delete(sessionID);
			void host.removeSession({ sessionID }).catch(() => {});
		}
	}
}

/** A reply as Orrery's compactor reads one (model-source.ts sourceCompactorModel). */
function reply(text: string, model: SourceModel): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	} as unknown as AssistantMessage;
}

/** Orrery's own models (`orrery`), and OpenCode's under the "opencode" provider, as one model source. */
export function withOpenCode(orrery: ModelSource, opencode: OpenCodeSummaries): ModelSource {
	return {
		find: (provider, modelId) => (provider === OPENCODE_SOURCE ? opencode.find(modelId) : orrery.find(provider, modelId)),
		unavailable: (provider, modelId) => (provider === OPENCODE_SOURCE ? opencode.unavailable(modelId) : orrery.unavailable?.(provider, modelId)),
		streamSimple: (model, context, options) => {
			if (model.provider !== OPENCODE_SOURCE) return orrery.streamSimple(model, context, options);
			return { result: async () => reply(await opencode.complete(model.id, context.systemPrompt, context.messages, options ?? {}), model) };
		},
	};
}
