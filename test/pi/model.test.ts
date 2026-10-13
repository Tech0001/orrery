import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { type ModelSource, piCompactorModel } from "../../src/pi/model.ts";

describe("piCompactorModel", () => {
	it("passes what the durable adapter passed: a session id for prompt-cache reuse, retries, and the thinking level", async () => {
		const calls: unknown[] = [];
		const models: ModelSource = {
			find: (provider, id) => ({ api: "faux", provider, id, contextWindow: 200_000 }),
			streamSimple: (_model, _context, options) => {
				calls.push(options);
				return { result: async () => fauxAssistantMessage("a summary") as AssistantMessage };
			},
		};
		const { model } = piCompactorModel(models, { provider: "p", modelId: "m", thinking: "low" }, "compactor:Atlas");
		const signal = new AbortController().signal;
		expect((await model.complete("system", [{ role: "user", blocks: ["hi"] }], signal)).text).toBe("a summary");
		expect(calls).toEqual([{ signal, sessionId: "compactor:Atlas", maxRetries: 2, reasoning: "low" }]);
	});

	it("tells the compactor once when the response begins, and marks the cache only for Anthropic", async () => {
		const seen: Array<{ onProviderStreamEvent?: (data: unknown) => void; onPayload?: (payload: unknown) => unknown }> = [];
		const make = (api: string): ModelSource => ({
			find: (provider, id) => ({ api, provider, id, contextWindow: 200_000 }),
			streamSimple: (_model, _context, options) => {
				seen.push(options ?? {});
				return {
					result: async () => {
						options?.onProviderStreamEvent?.({});
						options?.onProviderStreamEvent?.({});
						return fauxAssistantMessage("a summary") as AssistantMessage;
					},
				};
			},
		});
		const turns = [{ role: "user" as const, blocks: ["<chat>\na\nb\nc\nd\n", "</chat>", "task"], mark: 0 }];
		const signal = new AbortController().signal;
		let starts = 0;
		const choice = { provider: "p", modelId: "m", thinking: "off" as const };
		await piCompactorModel(make("anthropic-messages"), choice, "s").model.complete("system", turns, signal, () => starts++);
		await piCompactorModel(make("openai-responses"), choice, "s").model.complete("system", turns, signal);
		expect(starts).toBe(1);
		expect(seen[0].onPayload).toBeDefined();
		expect(seen[1].onPayload).toBeUndefined();
		expect(seen[1].onProviderStreamEvent).toBeUndefined();
	});
});
