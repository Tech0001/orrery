/**
 * An agent made from a reviewed preview (spec 2026-10-13-orrery-agents-design §6, step 4): its config block, its
 * instructions.md from the template, then the preview into its empty memory in one transaction, as `orrery import
 * --commit` does. The caller starts the memory build. The source chats are never touched: only the preview is read.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { addLane, editConfigFile } from "../lane/config-edit.ts";
import { ConfigError, laneNameProblem, type LaneTool, loadConfig, type ModelChoice } from "../lane/config.ts";
import { instructionsTemplate, readInstructions, writeInstructions } from "../lane/instructions.ts";
import { MemoryStore } from "../memory/index.ts";
import { commitPreview, readPreview } from "./preview.ts";

export interface NewAgentFromChat {
	readonly name: string;
	readonly tool: LaneTool;
	/** Its default folder; absent, it opens wherever it is opened. */
	readonly folder?: string;
	readonly summary: ModelChoice;
	readonly previewPath: string;
	/** The first chat's title, for the instructions' line of purpose. */
	readonly title: string;
}

/** Whether a lane folder already holds memory (an archived lane's, say): an import never goes into that. */
function holdsMemory(laneDir: string): boolean {
	const file = join(laneDir, "memory.sqlite");
	if (!existsSync(file)) return false;
	const store = MemoryStore.openReadOnly(file);
	try {
		return store.root.length > 0;
	} finally {
		store.close();
	}
}

/**
 * Adds the agent and fills its memory from the preview. Everything that can refuse (the name, the preview, memory
 * already in its folder) is checked before the config is written.
 */
export function createFromPreview(configPath: string, request: NewAgentFromChat): { readonly laneDir: string; readonly messages: number } {
	const problem = laneNameProblem(request.name);
	if (problem !== undefined) throw new ConfigError(problem);
	const lines = readPreview(request.previewPath);
	const planned = join(loadConfig(configPath).dataDir, "lanes", request.name);
	if (holdsMemory(planned)) throw new Error(`${planned} already holds memory (an archived agent's?); pick another name.`);
	const config = editConfigFile(configPath, (text, dir) =>
		addLane(text, dir, {
			name: request.name,
			...(request.folder === undefined ? {} : { workspace: request.folder }),
			tool: request.tool,
			compactorModel: `${request.summary.provider}/${request.summary.modelId}`,
			compactorThinking: request.summary.thinking,
		}),
	);
	const laneDir = config.lanes.get(request.name)?.dir ?? planned;
	// An archived agent's folder may keep its instructions: they are never written over.
	if (readInstructions(laneDir) === undefined) writeInstructions(laneDir, instructionsTemplate(request.name, `Continues the chat "${request.title}".`));
	const store = MemoryStore.open(join(laneDir, "memory.sqlite"));
	try {
		return { laneDir, messages: commitPreview(store, lines) };
	} finally {
		store.close();
	}
}
