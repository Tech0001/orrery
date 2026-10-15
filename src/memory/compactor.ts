/**
 * Background compression (Taelin's OptChat rev 3 §4; spec 2026-10-07-cache-view §4.4): up to `jobs` calls at once,
 * with ready nodes waiting in queues, never found by scanning the tree, and fixed-delay retries.
 */

import { byteSize, cutBytes, flatten } from "./bytes.ts";
import { COMPACTION_VIEW_BYTES, type CompactionContext, CompactionView } from "./compaction-view.ts";
import type { MemoryConfig } from "./config.ts";
import { bitLength, children, messageSource, Part, StoreError } from "./types.ts";
import type { MemoryView } from "./view.ts";

/** A message's node starts once fewer than this many lines before it are unbuilt (Taelin §4). */
export const LEAF_WINDOW = 8;

/** One node to build (spec §4.3). */
export interface SummaryTask {
	readonly part: Part;
	/** The compaction view up to the node, in blocks of 4 lines. */
	readonly context: CompactionContext;
	/** A leaf: its message, "kind: text", whole. A merge: its two lines, flattened, joined by a newline. */
	readonly source: string;
	/** Call once when the model's response begins: other calls on this prefix wait for it (one writer per prefix). */
	readonly onStart?: () => void;
}

export interface Summarizer {
	summarize(task: SummaryTask, signal: AbortSignal): Promise<string>;
}

/** Deterministic plumbing demo, explicitly NOT a semantic summarizer. Used by tests and the golden check. */
export class DemoSummarizer implements Summarizer {
	readonly limit: number;

	constructor(limit = 512) {
		this.limit = limit;
	}

	async summarize(task: SummaryTask): Promise<string> {
		await Promise.resolve();
		const suffix = " [offline demo excerpt]";
		return cutBytes(flatten(task.source), this.limit - byteSize(suffix)) + suffix;
	}
}

export type Report = (message: string) => void;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener("abort", done, { once: true });
	});
}

/** What the compactor needs from the memory config; `contextBytes` is the compaction view's ceiling (default `COMPACTION_VIEW_BYTES`). */
export type CompactorConfig = Pick<MemoryConfig, "nodeBytes" | "jobs" | "retrySeconds"> & { readonly contextBytes?: number };

/** First in, first out. */
class Queue<T> {
	#items: T[] = [];
	#head = 0;

	push(item: T): void {
		this.#items.push(item);
	}

	shift(): T | undefined {
		if (this.#head >= this.#items.length) return undefined;
		const item = this.#items[this.#head++];
		if (this.#head > 1024 && this.#head * 2 > this.#items.length) {
			this.#items = this.#items.slice(this.#head);
			this.#head = 0;
		}
		return item;
	}
}

export class Compactor {
	readonly view: MemoryView;
	/** Replaceable while running (a model switch): builds already in flight finish with the old one. */
	summarizer: Summarizer;
	readonly config: CompactorConfig;
	/** What each summary call reads: the chat merged further, 16–32 KB by default (spec §4.2). */
	readonly context: CompactionView;
	report: Report;
	readonly busy = new Map<string, Promise<void>>();
	readonly failed = new Set<string>();
	/** Why summaries last failed or stopped; cleared once no part is failing. */
	lastError: string | undefined;
	readonly #abort = new AbortController();
	readonly #closedSignal: Promise<void>;
	#wakeClosed: () => void = () => {};
	#pump: Promise<void> | undefined;
	#closed = false;
	#stopped = false;
	/** Merges whose halves are both built, oldest first. */
	readonly #merges = new Queue<Part>();
	/** The keys of the merges in `#merges`, so a merge is queued at most once. */
	readonly #queued = new Set<string>();
	/** The lowest leaf not built yet: every leaf below it is built. */
	#frontier = 0;
	/** The call writing the current prefix to the provider's cache, and when its response began. */
	#writer: { epoch: number; started: Promise<void> } | undefined;

	constructor(
		view: MemoryView,
		summarizer: Summarizer,
		config: CompactorConfig,
		report: Report = (message) => console.error(message),
	) {
		this.view = view;
		this.summarizer = summarizer;
		this.config = config;
		this.context = new CompactionView(view, config.contextBytes ?? COMPACTION_VIEW_BYTES);
		this.report = report;
		this.#closedSignal = new Promise((resolve) => {
			this.#wakeClosed = resolve;
		});
		// One pass at open finds the merges already ready; after that each built node queues its own parent.
		for (const node of view.store.nodes()) this.#queueParent(new Part(node.l, node.i));
	}

	start(): void {
		if (this.#pump === undefined) this.#pump = this.#run().catch((error) => this.#stop(errorMessage(error)));
	}

	/** True once the compactor gave up for good (the store refuses writes); the agent must restart. */
	get stopped(): boolean {
		return this.#stopped;
	}

	/** Reports through `report`, which must never take the process down. */
	#say(message: string): void {
		try {
			this.report(message);
		} catch (error) {
			console.error(message, error);
		}
	}

	#stop(reason: string): void {
		if (this.#stopped) return;
		this.#stopped = true;
		this.lastError = reason;
		this.#say(`Compactor stopped: ${reason}`);
		this.view.changes.notify();
	}

	/** Queues `part`'s parent if both its halves are built. */
	#queueParent(part: Part): void {
		this.#queueMerge(new Part(part.l + 1, part.i >> 1));
	}

	#queueMerge(merge: Part): void {
		const store = this.view.store;
		if (this.#queued.has(merge.key) || store.hasNode(merge) || children(merge).some((child) => !store.hasNode(child))) return;
		this.#queued.add(merge.key);
		this.#merges.push(merge);
	}

	/** Unbuilt leaves with fewer than LEAF_WINDOW unbuilt lines before them, not already running. */
	*#readyLeaves(): Generator<Part> {
		const store = this.view.store;
		const total = store.root.length;
		while (this.#frontier < total && store.hasNode(new Part(0, this.#frontier))) this.#frontier++;
		let unbuilt = 0;
		for (let i = this.#frontier; i < total && unbuilt < LEAF_WINDOW; i++) {
			const leaf = new Part(0, i);
			if (store.hasNode(leaf)) continue;
			unbuilt++;
			if (!this.busy.has(leaf.key)) yield leaf;
		}
	}

	#launch(part: Part): void {
		// Register before the build starts, like Python's create_task: an async function runs synchronously until its
		// first await, and a verbatim build has none, so it would unregister before being registered.
		this.busy.set(part.key, Promise.resolve().then(() => this.#build(part)));
	}

	/** Starts ready nodes up to `jobs`. Merges go first, or a long build fills every job with leaves and the tree waits. */
	#fill(): void {
		while (this.busy.size < this.config.jobs) {
			const merge = this.#merges.shift();
			if (merge === undefined) break;
			this.#queued.delete(merge.key);
			if (!this.view.store.hasNode(merge) && !this.busy.has(merge.key)) this.#launch(merge);
		}
		for (const leaf of this.#readyLeaves()) {
			if (this.busy.size >= this.config.jobs) break;
			this.#launch(leaf);
		}
	}

	async #run(): Promise<void> {
		while (!this.#closed && !this.#stopped) {
			const changed = this.view.changes.next();
			this.#fill();
			await Promise.race([changed, this.#closedSignal]);
		}
	}

	/**
	 * One writer per prefix (Taelin §3.3; spec §2). The first call since the compaction view last batched starts alone;
	 * the rest start once its response begins, or once it ends, so the provider writes the new prefix to its cache once.
	 * Returns the writer's release; a call that waited gets a no-op.
	 */
	async #takeTurn(): Promise<() => void> {
		const writer = this.#writer;
		if (writer !== undefined && writer.epoch === this.context.epoch) {
			await Promise.race([writer.started, this.#closedSignal]);
			return () => {};
		}
		let release: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.#writer = { epoch: this.context.epoch, started };
		return release;
	}

	async #build(part: Part): Promise<void> {
		try {
			// Scheduled before close()/stop but not yet started. And a node already saved, as by an earlier attempt that
			// failed after its save, is not built again: the store refuses a second save of a node.
			if (this.#closed || this.#stopped || this.view.store.hasNode(part)) return;
			if (!this.view.store.writable) {
				// A failed write poisons the store; calling the model again would only burn usage.
				this.#stop("the memory store refuses writes; restart the agent");
				return;
			}
			let source =
				part.l === 0
					? messageSource(this.view.store.root[part.i])
					: children(part)
							.map((child) => this.view.text(child))
							.join("\n");
			let text: string;
			if (byteSize(source) <= this.config.nodeBytes) {
				text = source;
			} else {
				if (part.l > 0) {
					source = children(part)
						.map((child) => flatten(this.view.text(child)))
						.join("\n");
				}
				const release = await this.#takeTurn();
				try {
					if (this.#closed) return;
					text = await this.summarizer.summarize(
						{ part, context: this.context.context(part), source, onStart: release },
						this.#abort.signal,
					);
				} finally {
					release();
				}
			}
			if (this.#closed) return;
			this.view.store.saveNode(part, text);
			this.failed.delete(part.key);
			if (this.failed.size === 0 && !this.#stopped) this.lastError = undefined;
			this.view.built(part);
			this.context.built(part);
			this.#queueParent(part);
		} catch (error) {
			if (this.#closed) return;
			// Any failed write poisons the store, so `!writable` also catches a raw SQLite error from `saveNode` or the view's
			// save. Retrying could not help: a node saved before the view's save failed is never built again, its parent is
			// never queued, and nothing else would stop the compactor, so `drain()` would wait forever.
			if (error instanceof StoreError || !this.view.store.writable) {
				this.#stop(`${errorMessage(error)}; restart the agent`);
				return;
			}
			this.lastError = errorMessage(error);
			if (!this.failed.has(part.key)) {
				this.failed.add(part.key);
				this.#say(
					`Compactor ${part.address}: ${errorMessage(error)}; retrying every ${this.config.retrySeconds}s`,
				);
				// Tell waiters now, not after the retry delay: a message waiting for summaries must not wait for this one.
				this.view.changes.notify();
			}
			await sleep(this.config.retrySeconds * 1000, this.#abort.signal);
		} finally {
			this.busy.delete(part.key);
			// A merge that failed goes back in its queue; a failed leaf is found again by the window. This also runs after a
			// stop, which is harmless: the pump exits at its next wake without filling, so nothing reads the queue again.
			if (part.l > 0 && !this.#closed) this.#queueMerge(part);
			this.view.changes.notify();
		}
	}

	/** Resolves once every node of the whole tree (not just the view) exists. For import and one-shot commands. */
	async drain(): Promise<void> {
		const total = this.view.store.root.length;
		let expected = 0;
		for (let level = 0; level < bitLength(total); level++) expected += total >> level;
		while (this.view.store.nodeCount < expected) {
			if (this.#stopped) throw new StoreError("Compactor stopped; restart the agent");
			await this.view.changes.next();
		}
	}

	/**
	 * Stops scheduling and aborts in-flight calls. In-flight builds are not awaited: each checks the closed flag
	 * before touching the store, and a model call that ignores its abort signal must not hold up shutdown.
	 */
	async close(): Promise<void> {
		this.#closed = true;
		this.#abort.abort();
		this.#wakeClosed();
		await this.#pump;
		this.busy.clear();
	}
}
