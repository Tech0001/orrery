/**
 * A history import's preview (spec 2026-10-05 §7; the TUI's "From an existing chat", spec 2026-10-13-orrery-agents-design
 * §6): read the chats and notes, split long pastes with the summary model, scrub secrets, and write preview.jsonl and
 * report.md for review. Nothing goes into memory here; `orrery import --commit` and the TUI's Import do that.
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Models } from "@earendil-works/pi-ai";
import type { HarnessConfig, ModelChoice } from "../lane/config.ts";
import { FileCredentialStore } from "../lane/credentials.ts";
import { compactorModel, createLaneModels } from "../lane/models.ts";
import { ownFolder } from "../lane/private-file.ts";
import type { CompactorModel } from "../memory/index.ts";
import { extractClaudeFiles } from "./claude.ts";
import { extractCodex } from "./codex.ts";
import { interleave, splitNote } from "./merge.ts";
import { buildPreview, type PreviewSummary, writePreview } from "./preview.ts";
import { type SplitResult, splitMessage } from "./split.ts";
import type { ExtractStats } from "./turns.ts";

export interface DryRunInput {
	readonly config: HarnessConfig;
	/** The lane the history is for: a paste "from" it is addressed to it. */
	readonly name: string;
	/** The lanes a paste's source is matched against. */
	readonly names: readonly string[];
	readonly summaryModel: ModelChoice;
	/** Summaries only through Orrery's saved logins (src/lane/models.ts savedSummaryLoginsOnly). */
	readonly savedLoginsOnly: boolean;
	readonly claudeFiles: readonly string[];
	readonly codexFiles: readonly string[];
	readonly notes: readonly string[];
	readonly pasteThreshold: number;
	readonly split: boolean;
	/** Where preview.jsonl, report.md and the split cache go (made 0700). */
	readonly out: string;
	readonly models?: Models;
	/** Aborts the split calls and stops between turns (the TUI's Esc); then nothing more is written. */
	readonly signal?: AbortSignal;
	readonly progress?: (line: string) => void;
}

export interface DryRunResult {
	readonly claude: ExtractStats;
	readonly codex: ExtractStats;
	readonly omitted: readonly string[];
	readonly noteParts: number;
	readonly splitCalls: number;
	readonly usage: { readonly input: number; readonly cacheRead: number; readonly output: number };
	readonly summary: PreviewSummary;
	readonly report: string;
	readonly previewPath: string;
	readonly reportPath: string;
}

/** The TUI's previews live in <data folder>/imports: Orrery's own folder, which agents are kept out of. */
export const PREVIEWS_FOLDER = "imports";
const PREVIEW_PREFIX = "preview-";
/** A preview folder older than this was left by a TUI that never finished (killed mid-preview): the next one sweeps it. */
export const PREVIEW_LEFTOVER_MS = 24 * 60 * 60 * 1000;

/**
 * A fresh private folder (0700) for one TUI preview under <dataDir>/imports (0700), after sweeping away preview folders
 * left there more than a day ago. The caller removes its own when done. `orrery import --dry-run` writes where it is told.
 */
export function newPreviewFolder(dataDir: string, now = Date.now()): string {
	const root = join(dataDir, PREVIEWS_FOLDER);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	if (ownFolder(root) !== true) throw new Error(`${root} is not a real folder of this user's (a symlink, or someone else's); nothing was written`);
	chmodSync(root, 0o700);
	for (const entry of readdirSync(root)) {
		if (!entry.startsWith(PREVIEW_PREFIX)) continue;
		const path = join(root, entry);
		try {
			if (now - lstatSync(path).mtimeMs > PREVIEW_LEFTOVER_MS) rmSync(path, { recursive: true, force: true });
		} catch {
			// another TUI swept it first
		}
	}
	return mkdtempSync(join(root, PREVIEW_PREFIX));
}

/** Lets the event loop run: a TUI draws the progress line and takes Esc in between. */
const breathe = () => new Promise<void>((resolve) => setImmediate(resolve));

export async function dryRun(input: DryRunInput): Promise<DryRunResult> {
	const say = input.progress ?? (() => {});
	const chats = input.claudeFiles.length + input.codexFiles.length;
	say(`Reading ${chats} ${chats === 1 ? "chat" : "chats"}…`);
	await breathe();
	input.signal?.throwIfAborted();
	const claude = extractClaudeFiles(input.claudeFiles);
	const codex = extractCodex(input.codexFiles);
	input.signal?.throwIfAborted();
	const notes = input.notes.flatMap((file) =>
		splitNote(basename(file), readFileSync(file, "utf8"), new Date(statSync(file).mtimeMs).toISOString()).map((message) => ({
			source: `note:${basename(file)}`,
			message,
		})),
	);
	mkdirSync(input.out, { recursive: true, mode: 0o700 });
	const cachePath = join(input.out, "split-cache.json");
	const cache = new Map<string, SplitResult>(
		existsSync(cachePath) ? Object.entries(JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, SplitResult>) : [],
	);
	const usage = { calls: 0, input: 0, cacheRead: 0, output: 0 };
	// Resolve the split model up front, so a misconfigured model fails now rather than once per long message.
	const model: CompactorModel | undefined = input.split
		? compactorModel(
				input.models ?? createLaneModels({ credentials: new FileCredentialStore(input.config.credentialsPath), providers: input.config.providers, savedLoginsOnly: input.savedLoginsOnly }),
				input.summaryModel,
				`import:${input.name}`,
			)
		: undefined;
	const splitModel = {
		complete: async (system: string, user: string) => {
			if (model === undefined) throw new Error("the split model is off (--no-split)");
			usage.calls++;
			if (usage.calls % 10 === 0) say(`${usage.calls} long messages sent to the split model`);
			const timeout = AbortSignal.timeout(300_000);
			const reply = await model.complete(system, [{ role: "user", blocks: [user] }], input.signal === undefined ? timeout : AbortSignal.any([input.signal, timeout]));
			usage.input += reply.usage?.input ?? 0;
			usage.cacheRead += reply.usage?.cacheRead ?? 0;
			usage.output += reply.usage?.output ?? 0;
			return reply.text;
		},
	};
	let failures = 0;
	const split = async (text: string): Promise<SplitResult> => {
		input.signal?.throwIfAborted();
		const threshold = input.split ? input.pasteThreshold : Number.POSITIVE_INFINITY;
		const result = await splitMessage(text, splitModel, { threshold, lanes: [...input.names], lane: input.name, cache });
		// A call cut short by the signal is no model failure: stop here.
		input.signal?.throwIfAborted();
		if (input.split) writeFileSync(cachePath, JSON.stringify(Object.fromEntries(cache)), { mode: 0o600 });
		// A model or transport error (not a bad answer) will repeat for every message: stop and say so.
		failures = result.note?.startsWith("split failed") ? failures + 1 : 0;
		if (failures >= 3) {
			throw new Error(`The split model failed 3 times in a row (${result.note}). Fix the model or credentials, or rerun with --no-split.`);
		}
		return result;
	};
	const omitted = [...claude.omitted, ...codex.omitted];
	const { lines, report, summary } = await buildPreview({
		turns: interleave(claude.turns, codex.turns),
		notes,
		split,
		omitted,
		progress: async (done, total) => {
			if (done % 50 !== 0 && done !== total) return;
			say(`Preparing the preview: ${done} of ${total} turns`);
			await breathe();
			input.signal?.throwIfAborted();
		},
	});
	input.signal?.throwIfAborted();
	const { previewPath, reportPath } = writePreview(input.out, lines, report);
	return {
		claude: claude.stats,
		codex: codex.stats,
		omitted,
		noteParts: notes.length,
		splitCalls: usage.calls,
		usage: { input: usage.input, cacheRead: usage.cacheRead, output: usage.output },
		summary,
		report,
		previewPath,
		reportPath,
	};
}
