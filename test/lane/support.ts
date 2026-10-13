import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStore } from "../../src/memory/index.ts";

export const ctx = BACKGROUND_CONTEXT;

export function tempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** Two independent scripted providers: one for the agent, one for the compactor (which answers forever). */
export function fauxModels() {
	const agent = fauxProvider({ provider: "faux-agent" });
	const compactor = fauxProvider({ provider: "faux-compactor" });
	compactor.setResponses(Array.from({ length: 1000 }, () => fauxAssistantMessage("user: summarized")));
	const models = createModels();
	models.setProvider(agent.provider);
	models.setProvider(compactor.provider);
	return { agent, compactor, models };
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

export function laneConfigToml(options: { dataDir: string; workspace: string; extra?: string }): string {
	return `data_dir = ${JSON.stringify(options.dataDir)}

[lanes.Test]
workspace = ${JSON.stringify(options.workspace)}
model = "faux-agent/faux-1"
thinking = "off"
compactor_model = "faux-compactor/faux-1"
compactor_thinking = "off"
compactor_jobs = 2
allowed_roots = [${JSON.stringify(options.workspace)}]
${options.extra ?? ""}
`;
}

/** A pi-world root with Atlas's memory holding one February exchange (data/lanes/Atlas/memory.sqlite). */
export function seedAtlas(root: string): void {
	mkdirSync(join(root, "data", "lanes", "Atlas"), { recursive: true });
	const store = MemoryStore.open(join(root, "data", "lanes", "Atlas", "memory.sqlite"));
	store.appendBatch([
		{ kind: "user", text: "In February we chose garden-plants as a plant group.", date: "2026-02-10T10:00:00.000Z" },
		{ kind: "talk", text: "Noted.", date: "2026-02-10T10:01:00.000Z" },
	]);
	store.close();
}
