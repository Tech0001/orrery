/**
 * The view's lines and when they merge (Taelin's OptChat, revision 3c190e06, §3.2; spec 2026-10-07-cache-view §2).
 * Lines are tree nodes covering messages [0, end), oldest first, and new lines only ever join at the end. Once the
 * built lines pass the ceiling, one batch merges the most due sibling pairs whose parent is built until they are at
 * most the floor. A batch that runs out of built parents is "short" and keeps merging as parents get built. Lines
 * never split.
 */

import { children, Part } from "./types.ts";

/** What the sawtooth needs to know about a line: whether its node is built, and its size in bytes (0 when unbuilt). */
export interface LineSizes {
	built(part: Part): boolean;
	size(part: Part): number;
}

/**
 * How due the pair (left, its right sibling) is to merge with `total` messages in the chat: how long ago the pair ended,
 * in its own line size, `(total - last) / 2^l`, written shifted by 2 as in Taelin's code. Measuring from the pair's
 * first message instead was the bug that rewrote old lines. Higher merges first; equal pairs, the oldest first.
 */
export function due(total: number, left: Part): number {
	return (total + 1) / 2 ** left.l - left.i;
}

/** The candidate pairs (by their left line), most due first, for a fixed total. */
class PairHeap {
	readonly total: number;
	readonly #items: Part[] = [];

	constructor(total: number) {
		this.total = total;
	}

	#first(a: Part, b: Part): boolean {
		const da = due(this.total, a);
		const db = due(this.total, b);
		return da > db || (da === db && a.start < b.start);
	}

	push(part: Part): void {
		const items = this.#items;
		items.push(part);
		let k = items.length - 1;
		while (k > 0) {
			const up = (k - 1) >> 1;
			if (!this.#first(items[k], items[up])) break;
			[items[k], items[up]] = [items[up], items[k]];
			k = up;
		}
	}

	pop(): Part | undefined {
		const items = this.#items;
		const top = items[0];
		const last = items.pop();
		if (items.length > 0 && last !== undefined) {
			items[0] = last;
			let k = 0;
			for (;;) {
				const a = 2 * k + 1;
				const b = a + 1;
				let best = k;
				if (a < items.length && this.#first(items[a], items[best])) best = a;
				if (b < items.length && this.#first(items[b], items[best])) best = b;
				if (best === k) break;
				[items[k], items[best]] = [items[best], items[k]];
				k = best;
			}
		}
		return top;
	}
}

export class Sawtooth {
	readonly ceiling: number;
	readonly floor: number;
	readonly #lines: LineSizes;
	/** The lines by first message: each line's successor starts at its end. */
	readonly #byStart = new Map<number, Part>();
	/**
	 * The bytes `size` holds for each line, by first message. A line can be built before it joins (a message saved
	 * verbatim joins the compaction view built) and then be reported built; the record keeps it from counting twice.
	 */
	readonly #counted = new Map<number, number>();
	#end = 0;
	#size = 0;
	#short: boolean;
	/** Candidate pairs, kept between events while the total stays the same (a bulk build); rebuilt when it changes. */
	#heap: PairHeap | undefined;
	#cached: Part[] | undefined;

	/** `parts` must cover [0, end) contiguously. `short` true makes the next fit batch to the floor (a first build). */
	constructor(parts: readonly Part[], ceiling: number, floor: number, lines: LineSizes, short = false) {
		if (!Number.isInteger(ceiling) || ceiling < 1 || !Number.isInteger(floor) || floor < 0 || floor > ceiling) {
			throw new RangeError("A view needs whole sizes with 0 <= floor <= ceiling and ceiling >= 1");
		}
		this.ceiling = ceiling;
		this.floor = floor;
		this.#lines = lines;
		this.#short = short;
		for (const part of parts) this.#add(part);
	}

	#add(part: Part): void {
		if (part.start !== this.#end) throw new RangeError(`Line ${part.address} does not continue the view at ${this.#end}`);
		this.#byStart.set(part.start, part);
		this.#end = part.end;
		this.#count(part);
		this.#cached = undefined;
	}

	/** Counts `part`, a line, at its size now, replacing what was counted for it before. */
	#count(part: Part): void {
		const size = this.#lines.size(part);
		this.#size += size - (this.#counted.get(part.start) ?? 0);
		this.#counted.set(part.start, size);
	}

	/** The view covers messages [0, end). */
	get end(): number {
		return this.#end;
	}

	/** Bytes of the built lines; unbuilt lines count 0. */
	get size(): number {
		return this.#size;
	}

	/** True while a batch has not reached the floor for want of built parents. */
	get short(): boolean {
		return this.#short;
	}

	get parts(): readonly Part[] {
		if (this.#cached === undefined) this.#cached = [...this.lines()];
		return this.#cached;
	}

	/** The lines oldest first; a caller may stop early to read only a prefix. */
	*lines(): Generator<Part> {
		for (let part = this.#byStart.get(0); part !== undefined; part = this.#byStart.get(part.end)) yield part;
	}

	/** One new line per message, at the end. Nothing merges. */
	append(leaves: readonly Part[]): void {
		for (const leaf of leaves) {
			if (leaf.l !== 0) throw new RangeError(`Only messages join the view, not ${leaf.address}`);
			this.#add(leaf);
		}
	}

	/** `left` if it and its right sibling are both lines and their parent is built; otherwise undefined. */
	#pair(left: Part | undefined): Part | undefined {
		if (left === undefined || left.i % 2 !== 0) return undefined;
		const right = this.#byStart.get(left.end);
		if (right === undefined || right.l !== left.l) return undefined;
		return this.#lines.built(new Part(left.l + 1, left.i / 2)) ? left : undefined;
	}

	/**
	 * Records that `part` was just built, then fits. True if lines merged. Idempotent: a line counts once however often
	 * it is reported, including a line that was already built when it joined.
	 */
	built(part: Part, total: number): boolean {
		const line = this.#byStart.get(part.start);
		if (line !== undefined && line.l === part.l) this.#count(part);
		// A built parent may complete a pair of lines; the heap stays current only while the total is unchanged.
		if (part.l > 0 && this.#heap?.total === total) {
			const pair = this.#pair(this.#byStart.get(children(part)[0].start));
			if (pair !== undefined && pair.l === part.l - 1) this.#heap.push(pair);
		}
		return this.fit(total);
	}

	/** Recounts every line's size and the candidate pairs, then fits: for nodes built without `built`. */
	resync(total: number): boolean {
		this.#size = 0;
		this.#counted.clear();
		for (const part of this.lines()) this.#count(part);
		this.#heap = undefined;
		return this.fit(total);
	}

	/** Every pair that can merge now, in merge order for `total` messages. */
	#candidates(total: number): PairHeap {
		const heap = new PairHeap(total);
		for (const part of this.lines()) {
			const pair = this.#pair(part);
			if (pair !== undefined) heap.push(pair);
		}
		this.#heap = heap;
		return heap;
	}

	/** Batches down to the floor once the built lines pass the ceiling, or goes on with a short batch. True if lines merged. */
	fit(total: number): boolean {
		if (this.#size <= this.ceiling && !this.#short) return false;
		const heap = this.#heap?.total === total ? this.#heap : this.#candidates(total);
		let merged = false;
		while (this.#size > this.floor) {
			const left = heap.pop();
			if (left === undefined) break;
			// Each line is in at most one pair, so a popped pair is current unless a duplicate entry already merged it.
			if (this.#byStart.get(left.start) !== left || this.#pair(left) !== left) continue;
			const right = this.#byStart.get(left.end) as Part;
			const parent = new Part(left.l + 1, left.i / 2);
			this.#byStart.delete(right.start);
			this.#byStart.set(parent.start, parent);
			// The parent's record replaces both halves': what leaves `size` is what was counted for them.
			this.#size -= (this.#counted.get(left.start) ?? 0) + (this.#counted.get(right.start) ?? 0);
			this.#counted.delete(left.start);
			this.#counted.delete(right.start);
			this.#count(parent);
			merged = true;
			// The new line pairs with its sibling: on its right if its index is even, on its left if odd.
			const next = parent.i % 2 === 0 ? this.#pair(parent) : this.#pair(this.#byStart.get(parent.start - parent.n));
			if (next !== undefined) heap.push(next);
		}
		if (merged) this.#cached = undefined;
		this.#short = this.#size > this.floor;
		return merged;
	}
}
