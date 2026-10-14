/**
 * An agent made from a reviewed preview (spec 2026-10-13-orrery-agents-design §6, step 4): its instructions.md from the
 * template and the preview in its empty memory (one transaction, as `orrery import --commit` does), then its config
 * block, last, so the agent exists only once it is whole. Any failure takes back what this call made. The caller starts
 * the memory build. The source chats are never touched: only the preview is read.
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { addAgent, editConfigFile } from "../agent/config-edit.ts";
import { ConfigError, type HarnessConfig, agentNameProblem, type AgentTool, loadConfig, type ModelChoice } from "../agent/config.ts";
import { instructionsTemplate, readInstructions, writeInstructions } from "../agent/instructions.ts";
import { MemoryStore } from "../memory/index.ts";
import { commitPreview, type PreviewLine, readPreview } from "./preview.ts";

export interface NewAgentFromChat {
	readonly name: string;
	readonly tool: AgentTool;
	/** Its default folder; absent, it opens wherever it is opened. */
	readonly folder?: string;
	readonly summary: ModelChoice;
	readonly previewPath: string;
	/** The first chat's title, for the instructions' line of purpose. */
	readonly title: string;
}

/** The steps that write; tests put in failing ones. */
export interface CreateSteps {
	readonly writeInstructions: (agentDir: string, text: string) => void;
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

/** A file's text, or undefined when there is none. */
function textOf(path: string): string | undefined {
	return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/**
 * Why `name` can't be made in `dataDir`: its data folder already has a memory store, even an empty one (an archived
 * agent's, or an import that was cut short), which an import never writes into or takes away. Undefined when it can.
 */
export function storeRefusal(dataDir: string, name: string): string | undefined {
	const agentDir = join(dataDir, "agents", name);
	if (!present(join(agentDir, "memory.sqlite"))) return undefined;
	return `${agentDir} already has a memory store (an archived agent's, or an import that was cut short); nothing was written. Pick another name, or move that folder aside and try again.`;
}

/** What the config edit did, for putting it back: the text it started from, what it wrote, and the .bak it found. */
interface ConfigEdit {
	readonly target: string;
	readonly from: string;
	readonly wrote: string;
	readonly bak: string | undefined;
}

/**
 * Adds the agent and fills its memory from the preview. Everything that can refuse (the name, the preview, a memory
 * store already in its data folder, a config that would not take it) is checked before anything is written. On a later
 * failure the folders and files this call made are removed, and the config and its .bak put back only while they hold
 * what this call wrote there; nothing that was there before, or that another process made meanwhile, is removed.
 */
export function createFromPreview(configPath: string, request: NewAgentFromChat, steps: Partial<CreateSteps> = {}): { readonly agentDir: string; readonly messages: number } {
	const step = { ...STEPS, ...steps };
	const problem = agentNameProblem(request.name);
	if (problem !== undefined) throw new ConfigError(problem);
	const lines = readPreview(request.previewPath);
	const config = loadConfig(configPath);
	const agentDir = join(config.dataDir, "agents", request.name);
	const block = (text: string, dir: string) =>
		addAgent(text, dir, {
			name: request.name,
			...(request.folder === undefined ? {} : { folder: request.folder }),
			tool: request.tool,
			compactorModel: `${request.summary.provider}/${request.summary.modelId}`,
			compactorThinking: request.summary.thinking,
		});
	// The config would take it (a free name, a valid block): asked of today's text before anything is written.
	const configTarget = existsSync(configPath) ? realpathSync(configPath) : configPath;
	block(textOf(configTarget) ?? "", dirname(configTarget));
	const refusal = storeRefusal(config.dataDir, request.name);
	if (refusal !== undefined) throw new Error(refusal);
	// The first folder mkdir made (undefined: the agent's data folder was there): what a failure takes away, and no more.
	const made = mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	const before = made === undefined ? new Set(readdirSync(agentDir)) : undefined;
	let edit: ConfigEdit | undefined;
	try {
		if (readInstructions(agentDir) === undefined) step.writeInstructions(agentDir, instructionsTemplate(request.name, `Continues the chat "${request.title}".`));
		const store = MemoryStore.open(join(agentDir, "memory.sqlite"));
		let messages: number;
		try {
			messages = step.commit(store, lines);
		} finally {
			store.close();
		}
		step.editConfig(configPath, (text, dir) => {
			const wrote = block(text, dir);
			// Read here, just before the save copies the config over it.
			edit = { target: configTarget, from: text, wrote, bak: textOf(`${configTarget}.bak`) };
			return wrote;
		});
		return { agentDir, messages };
	} catch (error) {
		undo(agentDir, made, before);
		if (edit !== undefined) restoreConfig(edit);
		throw error;
	}
}

/**
 * Takes away what createFromPreview made. The agent's data folder whole when it made it, then each folder above it that it
 * made, while empty (another process may have put something there since); else only the data folder's new entries.
 */
function undo(agentDir: string, made: string | undefined, before: ReadonlySet<string> | undefined): void {
	try {
		if (made === undefined) {
			for (const entry of readdirSync(agentDir)) if (!before?.has(entry)) rmSync(join(agentDir, entry), { recursive: true, force: true });
			return;
		}
		rmSync(agentDir, { recursive: true, force: true });
		for (let dir = dirname(agentDir); agentDir !== made && dir.startsWith(made); dir = dirname(dir)) {
			rmdirSync(dir);
			if (dir === made) break;
		}
	} catch {
		// a folder that is not empty is someone else's too; the original error is the one to report
	}
}

/**
 * Puts the config and its .bak back, each only while it holds what this call put there: the config the text it wrote,
 * the .bak the copy the save made of the config it started from. Another process's later edit is never undone.
 */
function restoreConfig(edit: ConfigEdit): void {
	const bak = `${edit.target}.bak`;
	try {
		if (textOf(edit.target) === edit.wrote) replaceText(edit.target, edit.from);
	} catch {
		// the original error is the one to report
	}
	try {
		if (edit.bak !== edit.from && textOf(bak) === edit.from) {
			if (edit.bak === undefined) rmSync(bak, { force: true });
			else replaceText(bak, edit.bak);
		}
	} catch {
		// the original error is the one to report
	}
}

/** Replaces a file's text atomically, keeping its mode (and leaving any .bak alone, unlike saveConfigText). */
function replaceText(path: string, text: string): void {
	const mode = statSync(path).mode & 0o777;
	const temp = `${path}.restore-${process.pid}`;
	writeFileSync(temp, text, { mode, flag: "wx" });
	try {
		chmodSync(temp, mode);
		renameSync(temp, path);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}
