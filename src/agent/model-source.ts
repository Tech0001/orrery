/**
 * Summary models from a model registry: orrery's (credentials.json), in pi and in Claude Code's holder alike, or a
 * test's. An agent needs two things from it: find a model, and get one reply from it.
 */

import type { AssistantMessage, Message, Models } from "@earendil-works/pi-ai";
import type { CompactorModel, CompactorReply } from "../memory/index.ts";
import { chatTurnsToMessages } from "./chat-turns.ts";
import { trackedSummaryCall } from "./cache-marks.ts";
import type { ModelChoice } from "./config.ts";

/** The few model fields an agent reads. */
export interface SourceModel {
	readonly api: string;
	readonly provider: string;
	readonly id: string;
	readonly contextWindow: number;
}

/** What an agent needs of a model registry: find a model, and stream one reply from it. */
export interface ModelSource {
	find(provider: string, modelId: string): SourceModel | undefined;
	/** Why a model this source knows of can't be used (OpenCode's free tier, say), when it says; undefined: unknown. */
	unavailable?(provider: string, modelId: string): string | undefined;
	streamSimple(
		model: SourceModel,
		context: { systemPrompt: string; messages: Message[] },
		options?: {
			signal?: AbortSignal;
			reasoning?: string;
			sessionId?: string;
			maxRetries?: number;
			onProviderStreamEvent?: (data: unknown) => void;
			onPayload?: (payload: unknown) => unknown;
		},
	): { result(): Promise<AssistantMessage> };
}

/** `sessionId` keys the provider's prompt cache across summary calls (the durable adapter passed `compactor:<agent>`). */
export function sourceCompactorModel(models: ModelSource, choice: ModelChoice, sessionId: string): { model: CompactorModel; contextWindow: number } {
	const found = models.find(choice.provider, choice.modelId);
	if (found === undefined) throw new Error(`Unknown model ${choice.provider}/${choice.modelId}`);
	const model: CompactorModel = {
		id: `${choice.provider}/${choice.modelId}`,
		async complete(system, turns, signal, onStart): Promise<CompactorReply> {
			// A failure before the request left (no login saved, say) sent nothing: it makes no usage row.
			const call = trackedSummaryCall(found.api, turns, onStart);
			let reply: AssistantMessage;
			try {
				reply = await models
					.streamSimple(found, { systemPrompt: system, messages: chatTurnsToMessages(turns, found) }, { signal, sessionId, maxRetries: 2, ...(choice.thinking === "off" ? {} : { reasoning: choice.thinking }), ...call.hooks })
					.result();
			} catch (error) {
				throw call.failed(error);
			}
			if (reply.stopReason === "error" || reply.stopReason === "aborted") throw call.failed(new Error(reply.errorMessage ?? `Compactor model ${reply.stopReason}`));
			return {
				text: reply.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
				usage: { input: reply.usage.input, cacheRead: reply.usage.cacheRead, cacheWrite: reply.usage.cacheWrite, output: reply.usage.output },
			};
		},
	};
	return { model, contextWindow: found.contextWindow };
}

/** orrery's own model registry (src/agent/models.ts: credentials.json and the config's servers) as a ModelSource. */
export function agentModelSource(models: Models): ModelSource {
	return {
		find: (provider, modelId) => models.getModel(provider, modelId),
		streamSimple: (model, context, options) => ({
			result: () =>
				models.completeSimple(model as unknown as Parameters<Models["completeSimple"]>[0], context, options as Parameters<Models["completeSimple"]>[2]),
		}),
	};
}
