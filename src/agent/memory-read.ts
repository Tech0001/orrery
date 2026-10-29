/** Reading an agent's memory for a tool's launch or session start: the message count and the memory section. */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore, MemoryView } from "../memory/index.ts";
import type { AgentConfig } from "./config.ts";
import { type Host, memorySection } from "./view-text.ts";

/**
 * The agent's message count and, when `withSection`, its memory section for `host` (Codex's by default; `readOnly` as
 * memorySection takes it), read from a read-only snapshot; none yet: {}.
 */
export function readMemory(agent: AgentConfig, withSection: boolean, host: Host = "codex", options: { readonly readOnly?: boolean } = {}): { readonly messages?: number; readonly section?: string } {
	const file = join(agent.dir, "memory.sqlite");
	if (!existsSync(file)) return {};
	const store = MemoryStore.openReadOnly(file);
	try {
		return { messages: store.root.length, ...(withSection ? { section: memorySection(new MemoryView(store, agent.memory.viewBytes), host, options) } : {}) };
	} finally {
		store.close();
	}
}
