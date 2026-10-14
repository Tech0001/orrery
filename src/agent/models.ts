/** pi-ai model wiring for agents: built-in providers, OpenAI-compatible servers from config, the compactor adapter. */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
// A compiled pi loads this file with only its own embedded copies of these two entry points; any other pi-ai subpath
// resolves from Orrery's node_modules and fails at call time (test/pi/pi-entry-points.test.ts). /compat is the
// entry pi embeds; under Node the bare specifier is a different module without the lazy APIs.
import * as hostPiAi from "@earendil-works/pi-ai/compat";
import type { CredentialStore, Model, Models, Provider } from "@earendil-works/pi-ai/compat";
import { builtinProviders, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { ChatTurn, CompactorModel, CompactorReply } from "../memory/index.ts";
import { summaryCallHooks } from "./cache-marks.ts";
import { chatTurnsToMessages } from "./chat-turns.ts";
import type { CustomProviderConfig, AgentConfig, ModelChoice } from "./config.ts";

/**
 * pi-ai's compat API: the host's copy when it has the model registry (pi embeds one), else `load()`. OMP serves
 * @earendil-works/pi-ai/compat from its own pi-ai, which has none of these functions (spec 2026-10-10-omp-design §2).
 */
export async function compatApi<T extends object>(host: T, load: () => Promise<T>): Promise<T> {
	return typeof (host as { createModels?: unknown }).createModels === "function" ? host : load();
}

// OMP only: this repo's own pi-ai, by a relative path. OMP rewrites the bare imports of files it reaches by relative
// paths, so the provider SDKs resolve; an absolute or bare path would not get that. pi never takes this branch.
const { createModels, createProvider, envApiKeyAuth, openAICompletionsApi, openAIResponsesApi } = await compatApi(hostPiAi, () => import("../../node_modules/@earendil-works/pi-ai/dist/compat.js"));

export type AgentModels = ReturnType<typeof createModels>;

/** An OpenAI-compatible server (oMLX, llama.cpp, ...), shaped like the user's verified pi `bonsai` entry. */
export function customProvider(config: CustomProviderConfig): Provider {
	const models: Model<"openai-completions">[] = config.models.map((m) => ({
		id: m.id,
		name: m.name,
		api: "openai-completions",
		provider: config.id,
		baseUrl: config.baseUrl,
		reasoning: m.reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
		thinkingLevelMap: { minimal: null, low: "low", medium: "medium", high: "xhigh", xhigh: null, max: null },
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsStrictMode: false,
			supportsLongCacheRetention: false,
			maxTokensField: "max_tokens",
			supportsReasoningEffort: true,
			thinkingFormat: "chat-template",
			chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" }, reasoning_effort: { $var: "thinking.effort" } },
		},
	}));
	return createProvider({
		id: config.id,
		baseUrl: config.baseUrl,
		models,
		api: openAICompletionsApi(),
		auth: {
			apiKey: {
				name: config.id,
				// The completions adapter refuses an empty key, so keyless servers get a placeholder.
				resolve: async () => ({
					auth: { apiKey: (config.apiKeyEnv && process.env[config.apiKeyEnv]) || "none" },
					source: config.apiKeyEnv ?? "config",
				}),
			},
		},
	});
}

/**
 * OpenAI on an API key, beside the ChatGPT sign-in under "openai". pi-ai keeps one credential per provider id, so the
 * two need two ids (spec 2026-10-07-summary-sources-design §4.2).
 */
export function openaiKeyProvider(): Provider {
	return createProvider({
		id: "openai-api",
		name: "OpenAI (API key)",
		baseUrl: "https://api.openai.com/v1",
		auth: { apiKey: envApiKeyAuth("OpenAI API key", ["OPENAI_API_KEY"]) },
		models: getBuiltinModels("openai").map((model) => ({ ...model, provider: "openai-api" })) as never,
		api: openAIResponsesApi(),
	});
}

/** One of pi-ai's built-in providers, by id. */
function builtinProvider(id: string): Provider {
	const provider = builtinProviders().find((candidate) => candidate.id === id);
	if (provider === undefined) throw new Error(`pi-ai has no built-in provider "${id}"`);
	return provider;
}

/** Ori 0.15.7 sets this marker in execAgent, including hand-typed `ori pi` (spec §7). */
export function savedSummaryLoginsOnly(agent?: Pick<AgentConfig, "launcher">, env: NodeJS.ProcessEnv = process.env): boolean {
	return agent?.launcher === "ori" || Boolean(env.ORI_OPENROUTER_SESSION_ID);
}

export function createAgentModels(options: {
	readonly credentials: CredentialStore;
	readonly providers: readonly CustomProviderConfig[];
	readonly savedLoginsOnly?: boolean;
}): AgentModels {
	const models = createModels({ credentials: options.credentials });
	for (const provider of [builtinProvider("anthropic"), builtinProvider("openai"), builtinProvider("openai-codex"), openaiKeyProvider(), builtinProvider("openrouter")]) {
		// Keep saved API keys and OAuth, but give the registry no ambient key resolver in an Ori summary agent.
		models.setProvider(options.savedLoginsOnly && provider.auth?.apiKey !== undefined
			? { ...provider, auth: { ...provider.auth, apiKey: envApiKeyAuth(provider.auth.apiKey.name, []) } }
			: provider);
	}
	for (const provider of options.providers) models.setProvider(customProvider(provider));
	return models;
}

function requireModel(models: Models, choice: ModelChoice): Model<string> {
	const model = models.getModel(choice.provider, choice.modelId);
	if (model === undefined) throw new Error(`Unknown model ${choice.provider}/${choice.modelId}`);
	return model;
}

export function modelContextWindow(models: Models, choice: ModelChoice): number {
	return requireModel(models, choice).contextWindow;
}

/** Adapts a pi-ai model to the memory core's CompactorModel: one-shot text completions, errors thrown. */
export function compactorModel(models: Models, choice: ModelChoice, sessionId: string): CompactorModel {
	const model = requireModel(models, choice);
	return {
		id: `${choice.provider}/${choice.modelId}`,
		async complete(system: string, turns: readonly ChatTurn[], signal: AbortSignal, onStart?: () => void): Promise<CompactorReply> {
			const messages = chatTurnsToMessages(turns, model);
			const reply = await models.completeSimple(
				model,
				{ systemPrompt: system, messages },
				{ signal, sessionId, maxRetries: 2, ...(choice.thinking === "off" ? {} : { reasoning: choice.thinking }), ...summaryCallHooks(model.api, turns, onStart) },
			);
			if (reply.stopReason === "error" || reply.stopReason === "aborted") {
				throw new Error(reply.errorMessage ?? `Compactor model ${reply.stopReason}`);
			}
			return {
				text: reply.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
				usage: { input: reply.usage.input, cacheRead: reply.usage.cacheRead, cacheWrite: reply.usage.cacheWrite, output: reply.usage.output },
			};
		},
	};
}

/** The stable per-installation UUID "Sign in with ChatGPT" requires. */
export function ensureDeviceId(path: string): string {
	if (existsSync(path)) {
		const id = readFileSync(path, "utf8").trim();
		if (/^[0-9a-f-]{36}$/.test(id)) return id;
	}
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const id = randomUUID();
	writeFileSync(path, `${id}\n`, { mode: 0o600 });
	return id;
}

export interface ModelGroup {
	readonly provider: string;
	/** How the provider is signed in: "ChatGPT sign-in", "signed in" (OAuth), "API key", or "" (no login needed). */
	readonly label: string;
	readonly ids: readonly string[];
}

/**
 * The chat models each signed-in provider can use, for /models. pi lists every OpenAI API model for the openai
 * provider; a ChatGPT sign-in can use only the ChatGPT-plan models, which are pi's own Codex catalog.
 */
export async function availableModels(models: Models): Promise<ModelGroup[]> {
	const plan = new Set(models.getModels("openai-codex").map((model) => model.id));
	const byProvider = new Map<string, string[]>();
	for (const model of await models.getAvailable()) byProvider.set(model.provider, [...(byProvider.get(model.provider) ?? []), model.id]);
	const groups: ModelGroup[] = [];
	for (const [provider, ids] of byProvider) {
		const auth = await models.checkAuth(provider);
		const chatgpt = provider === "openai" && auth?.type === "oauth";
		groups.push({
			provider,
			label: chatgpt ? "ChatGPT sign-in" : auth?.type === "oauth" ? "signed in" : auth?.type === "api_key" ? "API key" : "",
			ids: chatgpt ? ids.filter((id) => plan.has(id)) : ids,
		});
	}
	return groups;
}
