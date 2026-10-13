/** The lane's summarizer: the oversized-source rule and usage rows (spec §5.5), for any CompactorModel. */
import { type CompactorModel, localIso, type MemoryStore, ModelSummarizer } from "../memory/index.ts";
import type { LaneConfig } from "./config.ts";

export function laneSummarizer(config: LaneConfig, model: CompactorModel, contextWindow: number, store: MemoryStore): ModelSummarizer {
	const maxSourceBytes = Math.max(16_000, (contextWindow - 16_384) * 3 - config.memory.viewBytes);
	return new ModelSummarizer(model, {
		nodeBytes: config.memory.nodeBytes,
		tries: config.memory.tries,
		maxSourceBytes,
		onUsage: (usage, ok) =>
			store.recordUsage({
				at: localIso(),
				role: "compactor",
				model: model.id,
				input: usage?.input ?? 0,
				cacheRead: usage?.cacheRead ?? 0,
				cacheWrite: usage?.cacheWrite ?? 0,
				output: usage?.output ?? 0,
				ok,
			}),
	});
}
