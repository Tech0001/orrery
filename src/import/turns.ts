import type { NewMessage } from "../memory/index.ts";

/** One user message and what belongs to it (subagent reports, the final reply), in order. */
export interface ImportTurn {
	readonly source: string;
	readonly start: string;
	readonly messages: NewMessage[];
}

export interface ExtractStats {
	files: number;
	lines: number;
	skipped: number;
	turns: number;
}

export interface Extracted {
	readonly turns: ImportTurn[];
	readonly stats: ExtractStats;
	/** History left out on purpose, one line each, for the dry-run summary and the report. */
	readonly omitted: string[];
}

export function emptyExtract(): Extracted {
	return { turns: [], stats: { files: 0, lines: 0, skipped: 0, turns: 0 }, omitted: [] };
}
