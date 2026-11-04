import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStore, MemoryView, Part } from "../../src/memory/index.ts";

export const ctx = BACKGROUND_CONTEXT;

export function tempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** Two independent scripted providers: one for the chat model, one for the compactor (which answers forever). */
export function fauxModels() {
	const chat = fauxProvider({ provider: "faux-agent" });
	const compactor = fauxProvider({ provider: "faux-compactor" });
	compactor.setResponses(Array.from({ length: 1000 }, () => fauxAssistantMessage("user: summarized")));
	const models = createModels();
	models.setProvider(chat.provider);
	models.setProvider(compactor.provider);
	return { chat, compactor, models };
}

export function messageText(message: Message): string {
	if (message.role === "system") {
		const content = typeof message.content === "string" ? message.content : message.content.map((b) => b.text).join("");
		return content || Object.values(message.sections ?? {}).filter((v) => typeof v === "string").join("\n");
	}
	if (message.role === "assistant") {
		return message.content.map((b) => (b.type === "text" ? b.text : b.type === "toolCall" ? `toolCall(${b.name})` : "")).join("");
	}
	if (typeof message.content === "string") return message.content;
	return message.content.map((b) => (b.type === "text" ? b.text : "[image]")).join("");
}

/** One "role:text" line per message, for asserting request shapes. */
export function contextLines(context: { messages: readonly Message[] }): string[] {
	return context.messages.map((m) => `${m.role}:${messageText(m)}`);
}

export function agentConfigToml(options: { dataDir: string; folder: string; extra?: string }): string {
	return `data_dir = ${JSON.stringify(options.dataDir)}

[agents.Test]
folder = ${JSON.stringify(options.folder)}
model = "faux-agent/faux-1"
thinking = "off"
compactor_model = "faux-compactor/faux-1"
compactor_thinking = "off"
compactor_jobs = 2
allowed_roots = [${JSON.stringify(options.folder)}]
${options.extra ?? ""}
`;
}

/** A pi-world root with Atlas's memory holding one February exchange (data/agents/Atlas/memory.sqlite). */
export function seedAtlas(root: string): void {
	mkdirSync(join(root, "data", "agents", "Atlas"), { recursive: true });
	const store = MemoryStore.open(join(root, "data", "agents", "Atlas", "memory.sqlite"));
	store.appendBatch([
		{ kind: "user", text: "In February we chose garden-plants as a plant group.", date: "2026-02-10T10:00:00.000Z" },
		{ kind: "talk", text: "Noted.", date: "2026-02-10T10:01:00.000Z" },
	]);
	store.close();
}

/**
 * A new memory store at `file` holding `count` user messages, `text(i)` each, with every message's line built as saved
 * verbatim (`user: <text>`) and, with `summaries`, every summary above them built too, as a summarizer that kept up
 * leaves it; without, as one that never ran. The saved view is the messages' lines, none merged: a view that has not
 * passed its ceiling yet.
 */
export function fillMemory(file: string, count: number, text: (i: number) => string, summaries: boolean): void {
	const store = MemoryStore.open(file);
	try {
		new MemoryView(store, 2 ** 30).appendBatch(Array.from({ length: count }, (_, i) => ({ kind: "user" as const, text: text(i) })));
		for (let i = 0; i < count; i++) store.saveNode(new Part(0, i), `user: ${text(i)}`);
		for (let l = 1; summaries && 2 ** l <= count; l++) {
			for (let i = 0; (i + 1) * 2 ** l <= count; i++) store.saveNode(new Part(l, i), `summary of ${new Part(l, i).address}`);
		}
	} finally {
		store.close();
	}
}
