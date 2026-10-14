/**
 * An agent made from a reviewed preview (spec 2026-10-13-orrery-agents-design §6, step 4): its instructions.md from the
 * template and the preview in its empty memory (one transaction, as `orrery import --commit` does), then its config
 * block, last, so the agent exists only once it is whole. Any failure takes back what this call made. The caller starts
 * the memory build. The source chats are never touched: only the preview is read.
 */

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { addLane, editConfigFile, saveConfigText } from "../lane/config-edit.ts";
import { ConfigError, type HarnessConfig, laneNameProblem, type LaneTool, loadConfig, type ModelChoice } from "../lane/config.ts";
import { instructionsTemplate, readInstructions, writeInstructions } from "../lane/instructions.ts";
import { MemoryStore } from "../memory/index.ts";
import { commitPreview, type PreviewLine, readPreview } from "./preview.ts";

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

/** The steps that write; tests put in failing ones. */
export interface CreateSteps {
	readonly writeInstructions: (laneDir: string, text: string) => void;
	readonly commit: (store: MemoryStore, lines: readonly PreviewLine[]) => number;
	readonly editConfig: (path: string, edit: (text: string, configDir: string) => string) => HarnessConfig;
}

const STEPS: CreateSteps = { writeInstructions, commit: commitPreview, editConfig: editConfigFile };

/** Whether anything (a file, a folder, a symlink, even a broken one) is at `path`. */
function present(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

/** The highest folder on the way to `dir` (itself included) that is not there yet: what making `dir` creates. */
function firstMissing(dir: string): string | undefined {
	let top: string | undefined;
	for (let at = dir; !present(at); at = dirname(at)) {
		top = at;
		if (dirname(at) === at) break;
	}
	return top;
}

/** A file's text, or undefined when there is none. */
function textOf(path: string): string | undefined {
	return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/**
 * Adds the agent and fills its memory from the preview. Everything that can refuse (the name, the preview, a memory
 * store already in its folder, a config that would not take it) is checked before anything is written. On a later
 * failure the files and folders this call made are removed and the config (and its .bak) put back; nothing that was
 * there before is removed.
 */
export function createFromPreview(configPath: string, request: NewAgentFromChat, steps: Partial<CreateSteps> = {}): { readonly laneDir: string; readonly messages: number } {
	const step = { ...STEPS, ...steps };
	const problem = laneNameProblem(request.name);
	if (problem !== undefined) throw new ConfigError(problem);
	const lines = readPreview(request.previewPath);
	const config = loadConfig(configPath);
	const laneDir = join(config.dataDir, "lanes", request.name);
	const block = (text: string, dir: string) =>
		addLane(text, dir, {
			name: request.name,
			...(request.folder === undefined ? {} : { workspace: request.folder }),
			tool: request.tool,
			compactorModel: `${request.summary.provider}/${request.summary.modelId}`,
			compactorThinking: request.summary.thinking,
		});
	// The config would take it (a free name, a valid block): asked of today's text before anything is written.
	const configTarget = existsSync(configPath) ? realpathSync(configPath) : configPath;
	const configBefore = textOf(configTarget);
	const bakBefore = textOf(`${configTarget}.bak`);
	block(configBefore ?? "", dirname(configTarget));
	// Even an empty store may be an archived agent's: never written into, never taken away.
	if (present(join(laneDir, "memory.sqlite"))) throw new Error(`${laneDir} already has a memory store (an archived agent's?); pick another name.`);
	const made = firstMissing(laneDir);
	const before = made === undefined ? new Set(readdirSync(laneDir)) : undefined;
	try {
		if (readInstructions(laneDir) === undefined) step.writeInstructions(laneDir, instructionsTemplate(request.name, `Continues the chat "${request.title}".`));
		const store = MemoryStore.open(join(laneDir, "memory.sqlite"));
		let messages: number;
		try {
			messages = step.commit(store, lines);
		} finally {
			store.close();
		}
		step.editConfig(configPath, block);
		return { laneDir, messages };
	} catch (error) {
		undo(laneDir, made, before);
		restoreConfig(configTarget, configBefore, bakBefore);
		throw error;
	}
}

/** Takes away what createFromPreview made: the folder it made (the highest new one), else only the agent folder's new entries. */
function undo(laneDir: string, made: string | undefined, before: ReadonlySet<string> | undefined): void {
	try {
		if (made !== undefined) {
			rmSync(made, { recursive: true, force: true });
			return;
		}
		for (const entry of readdirSync(laneDir)) if (!before?.has(entry)) rmSync(join(laneDir, entry), { recursive: true, force: true });
	} catch {
		// the original error is the one to report
	}
}

/** Puts the config and its .bak back as they were, when the failed edit changed them. */
function restoreConfig(target: string, text: string | undefined, bak: string | undefined): void {
	try {
		if (text === undefined || textOf(target) === text) return;
		saveConfigText(target, text);
		if (bak === undefined) rmSync(`${target}.bak`, { force: true });
		else writeFileSync(`${target}.bak`, bak);
	} catch {
		// the original error is the one to report
	}
}
