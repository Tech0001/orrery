/**
 * The compaction view (Taelin's OptChat rev 3 §4; spec 2026-10-07-cache-view §4.2): what each summary call reads. At
 * open it is the chat's view merged further down to its floor (16 KB by default); then it runs its own sawtooth up to
 * its ceiling (32 KB) over the same lines. In memory only, never saved.
 */

import { flatten } from "./bytes.ts";
import { Sawtooth } from "./sawtooth.ts";
import { Part } from "./types.ts";
import { type MemoryView, storeLines } from "./view.ts";

/** The compaction view's default ceiling (`compactor_context_bytes`); its floor is half. */
export const COMPACTION_VIEW_BYTES = 32_000;

/** A summary call's context: `<chat>` lines in blocks of 4, and the index of the last whole block (-1 if none). */
export interface CompactionContext {
	readonly blocks: readonly string[];
	readonly mark: number;
}

/**
 * Lines in blocks of 4 (Taelin §3.3): the first block opens with "<chat>\n", each whole block ends with "\n", and the
 * last block holds the rest and "</chat>". Joined, they read `<chat>\n` + lines + `\n</chat>`. Block boundaries stay
 * put as the view grows, so a cache entry at `mark` is found again by the next call.
 */
export function contextBlocks(lines: readonly string[]): CompactionContext {
	const blocks: string[] = [];
	let next = 0;
	for (; next + 4 <= lines.length; next += 4) blocks.push(`${next === 0 ? "<chat>\n" : ""}${lines.slice(next, next + 4).join("\n")}\n`);
	const mark = blocks.length - 1;
	blocks.push(`${next === 0 ? "<chat>\n" : ""}${lines.slice(next).map((line) => `${line}\n`).join("")}</chat>`);
	return { blocks, mark };
}

export class CompactionView {
	readonly #view: MemoryView;
	readonly #saw: Sawtooth;
	/** Counts batches: calls between two batches share their prefix (one writer per prefix, spec §2). */
	epoch = 0;

	constructor(view: MemoryView, ceiling = COMPACTION_VIEW_BYTES) {
		this.#view = view;
		this.#saw = new Sawtooth(view.parts, ceiling, Math.floor(ceiling / 2), storeLines(view.store), true);
		this.#saw.fit(view.store.root.length);
	}

	get ceiling(): number {
		return this.#saw.ceiling;
	}

	get parts(): readonly Part[] {
		this.#sync();
		return this.#saw.parts;
	}

	/** Bytes of its built lines. */
	get size(): number {
		this.#sync();
		return this.#saw.size;
	}

	/** New messages join as lines, as in the chat's view. */
	#sync(): void {
		const end = this.#saw.end;
		const total = this.#view.store.root.length;
		if (end < total) this.#saw.append(Array.from({ length: total - end }, (_, k) => new Part(0, end + k)));
	}

	/** Tells the view `part` was just built. A batch here starts a new epoch. */
	built(part: Part): void {
		this.#sync();
		if (this.#saw.built(part, this.#view.store.root.length)) this.epoch++;
	}

	/**
	 * The context for building `part`: its lines from the start up to the node (before the message, or up to a merge's
	 * last message), stopping at the first unbuilt line, so a call never sees a placeholder or half a message.
	 */
	context(part: Part): CompactionContext {
		this.#sync();
		const end = part.l === 0 ? part.i : part.end;
		const lines: string[] = [];
		for (const line of this.#saw.lines()) {
			const node = this.#view.store.node(line);
			if (line.end > end || node === undefined) break;
			lines.push(`${line.address}|${flatten(node.text)}`);
		}
		return contextBlocks(lines);
	}
}
