/**
 * Copies an agent conversation's committed pi entries into OptChat memory exactly once and in order (spec §5.2).
 * The cursor and the agent usage rows commit in the same memory.sqlite transaction as the messages they produced.
 */

import type { Context } from "@earendil-works/chord";
import type { Conversation, Cursor, EntryId, EntryRecord, Harness } from "@earendil-works/pi-durable";
import type { MemoryView, NewMessage, UsageRow } from "../memory/index.ts";
import { messageItems } from "./messages.ts";

export const CURSOR_KEY = "projector.cursor";
const PAGE = 256;
const BATCH = 200;

export interface Projection {
	readonly messages: NewMessage[];
	readonly usage: UsageRow[];
}

export function projectEntry(entry: EntryRecord, toolCap: number): Projection {
	const message = entry.model?.[0];
	if (message === undefined) return { messages: [], usage: [] };
	// An entry's kind must pair with its message's role.
	const pairs = (entry.kind === "pi.user" && message.role === "user") || (entry.kind === "pi.assistant" && message.role === "assistant") || (entry.kind === "pi.tool-result" && message.role === "toolResult");
	return pairs ? messageItems(message, toolCap) : { messages: [], usage: [] };
}

export interface ProjectorOptions {
	readonly toolCap: number;
	readonly context: Context;
	readonly report: (message: string) => void;
}

export class Projector {
	readonly #conversation: Conversation;
	readonly #view: MemoryView;
	readonly #options: ProjectorOptions;
	#queue: Promise<void> = Promise.resolve();
	#unsubscribe: (() => void) | undefined;
	#scheduled = false;
	#stopped = false;

	constructor(conversation: Conversation, view: MemoryView, options: ProjectorOptions) {
		this.#conversation = conversation;
		this.#view = view;
		this.#options = options;
	}

	/** Wakes on every commit that touches entries. The listener only schedules; it never calls Session APIs. */
	start(harness: Harness): void {
		this.#unsubscribe = harness.subscribeCommits((publication) => {
			if (this.#scheduled || this.#stopped) return;
			if (!publication.changes.some((change) => change.type === "entry")) return;
			this.#scheduled = true;
			setImmediate(() => {
				this.#scheduled = false;
				this.drain().catch(() => {});
			});
		});
	}

	/** Serialized catch-up from the stored cursor. Rejects if memory refuses the write. */
	drain(): Promise<void> {
		const run = this.#queue.then(() => this.#drainOnce());
		this.#queue = run.catch((error) => this.#options.report(`Projector: ${error instanceof Error ? error.message : String(error)}`));
		return run;
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		this.#unsubscribe?.();
		await this.#queue;
	}

	async #drainOnce(): Promise<void> {
		if (this.#stopped) return;
		const cursor = Number(this.#view.store.getMeta(CURSOR_KEY) ?? "0");
		const entries = await this.#entriesAfter(cursor);
		for (let start = 0; start < entries.length; start += BATCH) {
			const chunk = entries.slice(start, start + BATCH);
			const messages: NewMessage[] = [];
			const usage: UsageRow[] = [];
			for (const entry of chunk) {
				const projection = projectEntry(entry, this.#options.toolCap);
				messages.push(...projection.messages);
				usage.push(...projection.usage);
			}
			this.#view.appendBatch(messages, { [CURSOR_KEY]: String(chunk[chunk.length - 1].id) }, usage);
		}
	}

	/** Entries with id > cursor, oldest first (pi pages newest-first). */
	async #entriesAfter(cursor: number): Promise<EntryRecord[]> {
		const out: EntryRecord[] = [];
		let next: Cursor | undefined;
		do {
			const page = await this.#conversation.entries(
				cursor > 0 ? { minEntryId: (cursor + 1) as EntryId } : {},
				PAGE,
				next,
				this.#options.context,
			);
			out.push(...page.items);
			next = page.next;
		} while (next !== undefined);
		return out.reverse();
	}
}
