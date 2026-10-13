/** The memory tools (src/lane/memory-tools.ts) as pi tools (spec §6): zoom, date, search; lanes and lane_memory for readers. */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HarnessConfig } from "../lane/config.ts";
import { type LaneTool, memoryTools as laneMemoryTools, readerTools as laneReaderTools } from "../lane/memory-tools.ts";
import type { MemoryView } from "../memory/index.ts";
import type { OrreryState } from "./index.ts";

export const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: undefined });

export function ownView(state: OrreryState): MemoryView {
	if (state.lane === undefined) throw new Error("Orrery: this pi has no lane memory open");
	return state.lane.view;
}

// biome-ignore lint/suspicious/noExplicitAny: each tool has its own parameter schema.
type AnyTool = ToolDefinition<any, undefined>;

/** OMP folds a tool named search into its own grep (its tools/builtin-names.ts): there Orrery's is memory_search. */
export const OMP_TOOL_NAMES: Readonly<Record<string, string>> = { search: "memory_search" };

function piTool(tool: LaneTool, host: "pi" | "omp"): AnyTool {
	return {
		name: host === "omp" ? (OMP_TOOL_NAMES[tool.name] ?? tool.name) : tool.name,
		// OMP hides an extension tool behind its xd:// devices unless it is essential (its tools/essential-tools.ts).
		...(host === "omp" ? { loadMode: "essential" } : {}),
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		execute: async (_id: string, params: Record<string, unknown>) => text(await tool.run(params)),
	};
}

export function memoryTools(state: OrreryState, host: "pi" | "omp" = "pi"): AnyTool[] {
	return laneMemoryTools((use) => use(ownView(state))).map((tool) => piTool(tool, host));
}

export function readerTools(state: OrreryState, config: HarnessConfig, host: "pi" | "omp" = "pi"): AnyTool[] {
	const reader = () => {
		const lane = state.lane?.config;
		if (lane === undefined) throw new Error("Orrery: this pi has no lane memory open");
		return lane;
	};
	return laneReaderTools(reader, config).map((tool) => piTool(tool, host));
}
