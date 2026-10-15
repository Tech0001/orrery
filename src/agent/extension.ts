/**
 * The OptChat memory extension for pi-durable (spec §5.3–§5.4): the system prompt is MASTER + VIEW_DOC, the agent's
 * AGENTS.md, then the view stored for this run; zoom/date read memory; requests put the system messages first.
 */

import { type Message, Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool, GenerationTask, hook, section } from "@earendil-works/pi-durable";
import { MASTER, type MemoryView, VIEW_DOC } from "../memory/index.ts";

export const AgentViewDoc = defineDoc<{ text: string; run: number }>({
	kind: "lane.view",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ text: "", run: 0 }),
});

/**
 * pi appends the run's system baseline after the run's first user message. Move the system messages that precede
 * the first assistant message to the front, so the model reads system prompt and view before the new input and the
 * provider sees a stable prefix.
 */
export function systemFirst(messages: readonly Message[]): readonly Message[] {
	const firstAssistant = messages.findIndex((m) => m.role === "assistant");
	const head = firstAssistant === -1 ? messages : messages.slice(0, firstAssistant);
	const firstNonSystem = head.findIndex((m) => m.role !== "system");
	const lastSystem = head.map((m) => m.role).lastIndexOf("system");
	if (lastSystem === -1 || firstNonSystem === -1 || lastSystem < firstNonSystem) return messages;
	return [
		...head.filter((m) => m.role === "system"),
		...head.filter((m) => m.role !== "system"),
		...(firstAssistant === -1 ? [] : messages.slice(firstAssistant)),
	];
}

export function memoryTools(view: MemoryView) {
	return [
		defineTool({
			name: "zoom",
			description: "Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole.",
			parameters: Type.Object({ id: Type.Integer(), n: Type.Integer() }),
			replay: "safe",
			// Exact retrieval is exempt from pi's default 50 KiB tool-output bound.
			outputLimits: { maxBytes: 256 * 1024 * 1024, maxLines: 100_000_000 },
			execute: async (args) => ({ content: [{ type: "text", text: view.zoom(args.id, args.n) }] }),
		}),
		defineTool({
			name: "date",
			description: "The date and time of message id.",
			parameters: Type.Object({ id: Type.Integer() }),
			replay: "safe",
			execute: async (args) => ({ content: [{ type: "text", text: view.date(args.id) }] }),
		}),
	];
}

export interface MemoryExtensionOptions {
	readonly view: MemoryView;
	readonly instructions: () => string;
}

export function memoryExtension(options: MemoryExtensionOptions) {
	return defineExtension({
		name: "optchat-memory",
		sections: [
			section("optchat", () => `${MASTER}\n\n${VIEW_DOC}`, { tag: false }),
			section("lane-instructions", () => options.instructions() || undefined, { tag: false }),
			section(
				"memory",
				async (input, context) => (await input.read.snapshot(AgentViewDoc, input.conversationId, context))?.text || undefined,
				{ tag: false },
			),
		],
		tools: memoryTools(options.view),
		hooks: [hook(GenerationTask, { beforeRequest: (request) => ({ messages: systemFirst(request.messages) }) })],
	});
}
