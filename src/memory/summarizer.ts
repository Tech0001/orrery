/**
 * A compactor summarizer over any chat model (port of the Python ModelSummarizer) with Taelin's rev 3 compaction texts
 * (spec 2026-10-07-cache-view §4.3). One conversation per summary: oversize answers get byte-exact feedback in the same
 * conversation, and the shortest attempt wins.
 */

import { byteSize, cutBytes, tailBytes } from "./bytes.ts";
import type { Summarizer, SummaryTask } from "./compactor.ts";
import { COMPACT, ELIDED_NOTE, LEAF_TASK, MERGE_TASK, TOO_LONG } from "./prompts.ts";
import { children, type TokenUsage } from "./types.ts";

export type ChatTurn =
	| {
			readonly role: "user";
			readonly blocks: readonly string[];
			/** A block whose end a provider that needs marks (Anthropic) should cache; absent or -1 for none. */
			readonly mark?: number;
	  }
	| { readonly role: "assistant"; readonly text: string };

export interface CompactorReply {
	readonly text: string;
	readonly usage?: TokenUsage;
}

/** The only thing the memory core needs from a model. Plan 2 implements it with pi-ai. */
export interface CompactorModel {
	readonly id: string;
	/**
	 * Must settle promptly (reject) once `signal` aborts; the compactor does not wait for it on close. `onStart`, if
	 * given, is called once when the response begins (the first stream event); adapters that cannot tell never call it.
	 */
	complete(system: string, turns: readonly ChatTurn[], signal: AbortSignal, onStart?: () => void): Promise<CompactorReply>;
}

/** Fills `{name}` fields as Python's str.format does; values go in as they are and are never read again. */
export function fill(template: string, values: Readonly<Record<string, string | number>>): string {
	return template.replace(/\{(\w+)\}/g, (_, name: string) => {
		if (!Object.hasOwn(values, name)) throw new Error(`No value for {${name}}`);
		return String(values[name]);
	});
}

/** `limit` dashes: the model sees the length without a sample line to copy (Taelin §4). */
export function ruler(limit: number): string {
	return "-".repeat(limit);
}

/** "about N words" for a limit, rounded half up: 70 at 512 bytes, the same in the Python reference. */
export function aboutWords(limit: number): number {
	return Math.floor((limit * 70 + 256) / 512);
}

export interface FittedSource {
	readonly text: string;
	readonly elided: number;
}

/** The oversized-source rule (spec §5.5): beyond `maxBytes`, keep the head and tail and mark the elided middle. */
export function fitSource(source: string, maxBytes: number): FittedSource {
	const total = byteSize(source);
	if (total <= maxBytes) return { text: source, elided: 0 };
	const half = Math.floor(maxBytes / 2);
	const head = cutBytes(source, half);
	const tail = tailBytes(source, half);
	const elided = total - byteSize(head) - byteSize(tail);
	return { text: `${head}\n[… ${elided} bytes elided; zoom for full text …]\n${tail}`, elided };
}

const SENT_NOTHING = Symbol.for("orrery.summary.sent-nothing");

/**
 * Marks a summary attempt's error as one that sent no request (no login saved, a model no longer offered): the attempt
 * makes no usage row. Its message and kind stay as they are.
 */
export function sentNothing<E extends Error>(error: E): E {
	Object.defineProperty(error, SENT_NOTHING, { value: true });
	return error;
}

/** Whether a summary attempt's error sent no request (sentNothing). */
export function sentNoRequest(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { [SENT_NOTHING]?: unknown })[SENT_NOTHING] === true;
}

export interface ModelSummarizerOptions {
	readonly nodeBytes: number;
	readonly tries: number;
	/** Largest source the model can read whole; larger sources are fitted with `fitSource`. Default: unlimited. */
	readonly maxSourceBytes?: number;
	/** Each call's usage, a failed one's too (undefined usage), but not an attempt that sent no request (sentNothing). */
	readonly onUsage?: (usage: TokenUsage | undefined, ok: boolean) => void;
}

export class ModelSummarizer implements Summarizer {
	readonly model: CompactorModel;
	readonly options: ModelSummarizerOptions;

	constructor(model: CompactorModel, options: ModelSummarizerOptions) {
		this.model = model;
		this.options = options;
	}

	async summarize(task: SummaryTask, signal: AbortSignal): Promise<string> {
		const limit = this.options.nodeBytes;
		const words = aboutWords(limit);
		let step: string;
		if (task.part.l === 0) {
			const fitted = fitSource(task.source, this.options.maxSourceBytes ?? Number.POSITIVE_INFINITY);
			const note = fitted.elided > 0 ? `${fill(ELIDED_NOTE, { elided: fitted.elided })}\n` : "";
			step = fill(LEAF_TASK, { id: task.part.start, limit, words, ruler: ruler(limit), note, source: fitted.text });
		} else {
			const [a, b] = children(task.part);
			step = fill(MERGE_TASK, { a: a.address, b: b.address, limit, words, ruler: ruler(limit), id: task.part.start, end: task.part.end - 1, source: task.source });
		}
		const turns: ChatTurn[] = [{ role: "user", blocks: [...task.context.blocks, step], mark: task.context.mark }];
		const attempts: string[] = [];
		for (let attempt = 0; attempt < this.options.tries; attempt++) {
			let reply: CompactorReply;
			try {
				reply = await this.model.complete(COMPACT, turns, signal, task.onStart);
			} catch (error) {
				if (!sentNoRequest(error)) this.options.onUsage?.(undefined, false);
				throw error;
			}
			this.options.onUsage?.(reply.usage, true);
			const line = reply.text.trim();
			if (!line) throw new Error("Compactor returned an empty summary");
			attempts.push(line);
			const size = byteSize(line);
			if (size <= limit) break;
			turns.push({ role: "assistant", text: reply.text }, { role: "user", blocks: [fill(TOO_LONG, { size, limit, cut: cutBytes(line, limit) })] });
		}
		return attempts.reduce((best, line) => (byteSize(line) < byteSize(best) ? line : best));
	}
}
