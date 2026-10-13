/**
 * The chat's view (spec 2026-10-07-cache-view §4.1): summary lines on Taelin's sawtooth, saved with the memory, and
 * exact-history navigation.
 */

import { flatten, localIso } from "./bytes.ts";
import { type LineSizes, Sawtooth } from "./sawtooth.ts";
import { type MemoryStore, VIEW_KEY } from "./store.ts";
import { bitLength, children, type Kind, type Message, messageSource, type NewMessage, Part, type UsageRow } from "./types.ts";

export const PLACEHOLDER = "(not summarized yet: zoom it)";

/** A level-free "something changed" broadcast: `next()` resolves on the following `notify()`. */
export class ChangeSignal {
	#waiters: Array<() => void> = [];

	next(): Promise<void> {
		return new Promise((resolve) => this.#waiters.push(resolve));
	}

	notify(): void {
		const waiters = this.#waiters;
		this.#waiters = [];
		for (const resolve of waiters) resolve();
	}
}

export interface MemoryStats {
	readonly messages: number;
	readonly nodes: number;
	readonly viewParts: number;
	readonly viewBytes: number;
	readonly viewBudget: number;
	readonly settled: boolean;
	readonly firstUnsummarized: number;
}

/** Line sizes from the store: a built line's bytes; an unbuilt line counts 0. */
export function storeLines(store: MemoryStore): LineSizes {
	return { built: (part) => store.hasNode(part), size: (part) => store.node(part)?.size ?? 0 };
}

/** A view's saved form: `[[l, i], …]`. */
export function serializeView(parts: Iterable<Part>): string {
	return JSON.stringify(Array.from(parts, (part) => [part.l, part.i]));
}

/** A saved view, if it is a view of this store: lines contiguous from message 0, inside the log, merged lines built. */
export function parseSavedView(saved: string | undefined, store: MemoryStore): Part[] | undefined {
	if (saved === undefined) return undefined;
	let raw: unknown;
	try {
		raw = JSON.parse(saved);
	} catch {
		return undefined;
	}
	if (!Array.isArray(raw)) return undefined;
	const parts: Part[] = [];
	let end = 0;
	for (const item of raw) {
		if (!Array.isArray(item) || item.length !== 2 || !Number.isSafeInteger(item[0]) || !Number.isSafeInteger(item[1])) return undefined;
		const [l, i] = item as [number, number];
		if (l < 0 || l > 30 || i < 0) return undefined;
		const part = new Part(l, i);
		if (part.start !== end || part.end > store.root.length || (l > 0 && !store.hasNode(part))) return undefined;
		parts.push(part);
		end = part.end;
	}
	return parts;
}

export class MemoryView {
	readonly store: MemoryStore;
	readonly changes = new ChangeSignal();
	readonly #saw: Sawtooth;

	/**
	 * Opens the lane's saved view. It never rebuilds a saved view from the log, because a rebuilt view differs from the
	 * live one and every cache entry dies (Taelin §3.2). A lane without a saved view, or with a damaged one, builds it
	 * once: every message a line, merged down to the floor. Messages appended without the view (an import) join as
	 * lines. A writer saves what changed; a read-only reader keeps it in memory.
	 */
	constructor(store: MemoryStore, ceiling = 128_000) {
		if (!Number.isInteger(ceiling) || ceiling < 1) throw new RangeError("View budget must be positive");
		this.store = store;
		const total = store.root.length;
		const savedText = store.savedView();
		const saved = parseSavedView(savedText, store);
		const covered = saved?.at(-1)?.end ?? 0;
		this.#saw = new Sawtooth(saved ?? [], ceiling, Math.floor(ceiling / 2), storeLines(store), saved === undefined);
		this.#saw.append(Array.from({ length: total - covered }, (_, k) => new Part(0, covered + k)));
		this.#saw.fit(total);
		if (store.writable) {
			const now = serializeView(this.#saw.parts);
			if (now !== savedText) store.setMeta(VIEW_KEY, now);
		}
	}

	get ceiling(): number {
		return this.#saw.ceiling;
	}

	get floor(): number {
		return this.#saw.floor;
	}

	/** The view's lines, oldest first. */
	get parts(): readonly Part[] {
		return this.#saw.parts;
	}

	text(part: Part): string {
		return this.store.node(part)?.text ?? PLACEHOLDER;
	}

	/** Bytes of the built lines, which the ceiling and floor measure. Unbuilt lines (placeholders) count 0. */
	get size(): number {
		return this.#saw.size;
	}

	get first(): number {
		const unbuilt = this.parts.find((part) => !this.store.hasNode(part));
		return unbuilt === undefined ? this.store.root.length : unbuilt.start;
	}

	get settled(): boolean {
		return this.parts.every((part) => this.store.hasNode(part));
	}

	append(kind: Kind, text: string, date?: string): Message {
		return this.appendBatch([{ kind, text, date }])[0];
	}

	/** Appends messages, each a new line at the end; nothing merges. The view is saved in the same transaction. */
	appendBatch(
		items: readonly NewMessage[],
		meta: Readonly<Record<string, string>> = {},
		usage: readonly UsageRow[] = [],
	): Message[] {
		const total = this.store.root.length;
		const leaves = items.map((_, k) => new Part(0, total + k));
		const messages = this.store.appendBatch(items, { ...meta, [VIEW_KEY]: serializeView([...this.#saw.parts, ...leaves]) }, usage);
		this.#saw.append(leaves);
		this.changes.notify();
		return messages;
	}

	/** Tells the view `part` was just saved to the store (the compactor does). Its line now has a size; a due batch runs. */
	built(part: Part): void {
		this.#after(this.#saw.built(part, this.store.root.length));
	}

	/** Recounts every line from the store and runs a due batch: for nodes saved without `built`. */
	fit(): void {
		this.#after(this.#saw.resync(this.store.root.length));
	}

	/** Saves a batch once it reaches the floor; a short one is saved when it does, or with the next message. */
	#after(merged: boolean): void {
		if (merged && !this.#saw.short && this.store.writable) this.store.setMeta(VIEW_KEY, serializeView(this.#saw.parts));
		this.changes.notify();
	}

	render(options: { ids?: boolean; end?: number } = {}): string {
		const ids = options.ids ?? true;
		const lines: string[] = [];
		for (const part of this.parts) {
			if (options.end !== undefined && part.end > options.end) break;
			if (!ids && !this.store.hasNode(part)) throw new Error("Compactor context must contain only built summaries");
			lines.push((ids ? `${part.address}|` : "") + flatten(this.text(part)));
		}
		return `<chat>\n${lines.join("\n")}\n</chat>`;
	}

	/** Resolves true once every view part is built; false if `signal` aborts first. */
	async settle(signal?: AbortSignal): Promise<boolean> {
		while (!this.settled) {
			if (signal?.aborted) return false;
			const changed = this.changes.next();
			if (signal === undefined) {
				await changed;
				continue;
			}
			let onAbort: () => void = () => {};
			const aborted = new Promise<void>((resolve) => {
				onAbort = resolve;
				signal.addEventListener("abort", onAbort, { once: true });
			});
			await Promise.race([changed, aborted]);
			signal.removeEventListener("abort", onAbort);
		}
		return true;
	}

	zoom(id: unknown, n: unknown): string {
		if (!Number.isInteger(id) || !Number.isInteger(n)) return `No line ${String(id)}+${String(n)}.`;
		const start = id as number;
		const count = n as number;
		const total = this.store.root.length;
		if (start < 0 || count < 1 || start + count > total || count > 2 ** 30) return `No line ${start}+${count}.`;
		if ((count & (count - 1)) !== 0 || start % count !== 0) return `No line ${start}+${count}.`;
		if (count === 1) return `${start}+0|${messageSource(this.store.root[start])}`;
		const pair = children(new Part(bitLength(count) - 1, start / count));
		if (pair.some((child) => !this.store.hasNode(child))) return `No line ${start}+${count}.`;
		return pair.map((child) => `${child.address}|${flatten(this.text(child))}`).join("\n");
	}

	date(id: unknown): string {
		if (!Number.isInteger(id) || (id as number) < 0 || (id as number) >= this.store.root.length) {
			return `No message ${String(id)}.`;
		}
		return localIso(new Date(this.store.root[id as number].date));
	}

	stats(): MemoryStats {
		return {
			messages: this.store.root.length,
			nodes: this.store.nodeCount,
			viewParts: this.parts.length,
			viewBytes: this.size,
			viewBudget: this.ceiling,
			settled: this.settled,
			firstUnsummarized: this.first,
		};
	}
}
