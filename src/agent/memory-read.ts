/**
 * Reading an agent's memory for a tool's launch or session start, from a read-only snapshot: the message count and the
 * memory section (Codex's hooks), or Grok's section made to fit a size (Grok's launch); and the message count alone,
 * without loading the memory (Grok's status row).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore, MemoryView } from "../memory/index.ts";
import type { AgentConfig } from "./config.ts";
import { memorySection } from "./view-text.ts";

/** `use` on a read-only snapshot of the agent's memory, closed after; undefined when it has no memory yet. */
function withSnapshot<T>(agent: AgentConfig, use: (store: MemoryStore) => T): T | undefined {
	const file = join(agent.dir, "memory.sqlite");
	if (!existsSync(file)) return undefined;
	const store = MemoryStore.openReadOnly(file);
	try {
		return use(store);
	} finally {
		store.close();
	}
}

/**
 * The agent's message count and, when `withSection`, its memory section (Codex's), read from a read-only snapshot; none
 * yet: {}.
 */
export function readMemory(agent: AgentConfig, withSection: boolean): { readonly messages?: number; readonly section?: string } {
	return withSnapshot(agent, (store) => ({ messages: store.root.length, ...(withSection ? { section: memorySection(new MemoryView(store, agent.memory.viewBytes), "codex") } : {}) })) ?? {};
}

/** The agent's message count alone (MemoryStore.messageCount: no writer lock, nothing loaded); undefined when it has no memory yet. */
export function readMessageCount(agent: AgentConfig): number | undefined {
	const file = join(agent.dir, "memory.sqlite");
	return existsSync(file) ? MemoryStore.messageCount(file) : undefined;
}

/** Grok's memory section made to fit a size (fitMemory). */
export interface FittedMemory {
	/** The section, within the size asked for; undefined when not even the newest line of the memory fits. */
	readonly section?: string;
	/** Whether the section holds less than the agent's own view: a view at a smaller ceiling, its newest lines, or none. */
	readonly smaller: boolean;
	/** The address of the first line the section keeps, when it leaves out the older lines (grokLeftOut). */
	readonly from?: string;
}

/**
 * Grok's memory section (`readOnly` as memorySection takes it) within `maxBytes` UTF-8 bytes, from a read-only snapshot:
 * from the view at the agent's view_bytes when that fits, else from a view at a smaller ceiling, its lines merged with
 * the summaries already built. A view merges only lines whose summary is built, so when the newer lines aren't
 * summarized yet no view may fit: then the section keeps the newest whole lines of the smallest view that fit, after a
 * line naming the first one kept. Every size is measured on the rendered section. Nothing is written to the store.
 * Undefined: no memory yet.
 */
export function fitMemory(agent: AgentConfig, maxBytes: number, options: { readonly readOnly?: boolean } = {}): FittedMemory | undefined {
	return withSnapshot(agent, (store) => {
		let ceiling = agent.memory.viewBytes;
		// The bytes of the previous view's lines: a smaller ceiling that merges nothing more won't fit either.
		let previous = Number.POSITIVE_INFINITY;
		let smallest: { readonly view: MemoryView; readonly bytes: number } | undefined;
		for (;;) {
			const view = new MemoryView(store, ceiling);
			const section = memorySection(view, "grok", options);
			const bytes = Buffer.byteLength(section);
			if (bytes <= maxBytes) return { section, smaller: ceiling < agent.memory.viewBytes };
			if (smallest === undefined || bytes < smallest.bytes) smallest = { view, bytes };
			if (view.size >= previous) return newestLines(smallest.view, maxBytes, options);
			previous = view.size;
			// A view merges once its lines pass its ceiling: aim under the lines it holds, by as much as the section is over.
			ceiling = Math.floor((Math.min(ceiling, view.size) * maxBytes) / bytes);
			if (ceiling < 1) return newestLines(smallest.view, maxBytes, options);
		}
	});
}

/**
 * Grok's section of `view`'s newest whole lines within `maxBytes`, as many as fit, after the line naming the first one
 * kept; `view` as a whole doesn't fit. The fewer lines, the smaller the section, so the first line kept is found by
 * halving, each try measured on the rendered section.
 */
function newestLines(view: MemoryView, maxBytes: number, options: { readonly readOnly?: boolean }): FittedMemory {
	const parts = view.parts;
	let found: { readonly first: number; readonly section: string } | undefined;
	// From line 0 is the whole view, which doesn't fit.
	let low = 1;
	let high = parts.length - 1;
	while (low <= high) {
		const first = (low + high) >> 1;
		const section = memorySection(view, "grok", { ...options, from: parts[first] });
		if (Buffer.byteLength(section) <= maxBytes) {
			found = { first, section };
			high = first - 1;
		} else low = first + 1;
	}
	return found === undefined ? { smaller: true } : { section: found.section, smaller: true, from: parts[found.first].address };
}
