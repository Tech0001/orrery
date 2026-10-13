/** Model choices stored in memory by /model and /compactor, which outlive restarts. */

import type { MemoryStore } from "../memory/index.ts";
import { type ModelChoice, parseModelChoice } from "./config.ts";

export const AGENT_MODEL_KEY = "lane.model";
export const COMPACTOR_MODEL_KEY = "lane.compactor-model";

/** A model choice stored by /model or /compactor, if there is one and its model is still available. */
export function storedChoice(
	store: MemoryStore,
	key: string,
	exists: (provider: string, modelId: string) => boolean,
): { choice?: ModelChoice; stale?: string } {
	const raw = store.getMeta(key);
	if (!raw) return {};
	try {
		const value = JSON.parse(raw) as { provider?: unknown; modelId?: unknown; thinking?: unknown };
		const choice = parseModelChoice(`${String(value.provider)}/${String(value.modelId)}`, String(value.thinking), key);
		if (exists(choice.provider, choice.modelId)) return { choice };
		return { stale: `${choice.provider}/${choice.modelId}` };
	} catch {
		return { stale: raw };
	}
}
