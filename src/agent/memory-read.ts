/**
 * Reading an agent's memory for a tool's launch or session start, from a read-only snapshot: the message count and the
 * memory section (Codex's hooks), or a section made to fit a size (Grok's launch).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore, MemoryView } from "../memory/index.ts";
import type { AgentConfig } from "./config.ts";
import { type Host, memorySection } from "./view-text.ts";

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

/** A memory section made to fit a size (fitMemory). */
export interface FittedMemory {
	/** The section, within the size asked for; undefined when no view of the memory fits. */
	readonly section?: string;
	/** Whether the view is smaller than the agent's view_bytes (or there is none). */
	readonly smaller: boolean;
}

/**
 * The agent's memory section for `host` (`readOnly` as memorySection takes it) within `maxBytes` UTF-8 bytes, from a
 * read-only snapshot: from the view at its view_bytes when that fits, else from a view at a smaller ceiling, its lines
 * merged with the summaries already built. Nothing is written to the store. A view merges only lines whose summary is
 * built, so a memory whose newer lines aren't summarized yet may fit at no ceiling: then there is no section.
 * Undefined: no memory yet.
 */
export function fitMemory(agent: AgentConfig, host: Host, maxBytes: number, options: { readonly readOnly?: boolean } = {}): FittedMemory | undefined {
	return withSnapshot(agent, (store) => {
		let ceiling = agent.memory.viewBytes;
		// The bytes of the previous view's lines: a smaller ceiling that merges nothing more won't fit either.
		let previous = Number.POSITIVE_INFINITY;
		for (;;) {
			const view = new MemoryView(store, ceiling);
			const section = memorySection(view, host, options);
			const bytes = Buffer.byteLength(section);
			if (bytes <= maxBytes) return { section, smaller: ceiling < agent.memory.viewBytes };
			if (view.size >= previous) return { smaller: true };
			previous = view.size;
			// A view merges once its lines pass its ceiling: aim under the lines it holds, by as much as the section is over.
			ceiling = Math.floor((Math.min(ceiling, view.size) * maxBytes) / bytes);
			if (ceiling < 1) return { smaller: true };
		}
	});
}
