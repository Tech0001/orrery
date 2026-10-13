/** Keyword or /regex/ search over a lane's raw log: finds what the summaries left out (spec §6). */

import { flatten } from "./bytes.ts";
import type { MemoryStore } from "./store.ts";
import type { Kind } from "./types.ts";

export interface SearchHit {
	readonly id: number;
	readonly date: string;
	readonly kind: Kind;
	readonly snippet: string;
}

const SNIPPET = 150;

function matcher(query: string): (text: string) => number {
	const regex = /^\/(.+)\/([a-z]*)$/.exec(query.trim());
	// `/src/memory` parses as pattern "src" with flags "memory": not a regex query, so it is keywords.
	if (regex !== null && /^[dgimsuvy]*$/.test(regex[2])) {
		let pattern: RegExp;
		try {
			// g and y are stripped: y would anchor every match at index 0, and g is meaningless for a search.
			const flags = regex[2].replace(/[gy]/g, "");
			pattern = new RegExp(regex[1], flags.includes("i") ? flags : `${flags}i`);
		} catch (error) {
			throw new Error(`Invalid search pattern ${query}: ${error instanceof Error ? error.message : String(error)}`);
		}
		return (text) => text.search(pattern);
	}
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	return (text) => {
		const lower = text.toLowerCase();
		if (words.length === 0 || !words.every((word) => lower.includes(word))) return -1;
		return lower.indexOf(words[0]);
	};
}

export function searchLog(store: MemoryStore, query: string, options: { limit?: number } = {}): SearchHit[] {
	const match = matcher(query);
	const limit = options.limit ?? 20;
	const hits: SearchHit[] = [];
	for (let i = store.root.length - 1; i >= 0 && hits.length < limit; i--) {
		const message = store.root[i];
		const at = match(message.text);
		if (at < 0) continue;
		const start = Math.max(0, at - SNIPPET);
		const end = Math.min(message.text.length, at + SNIPPET);
		const snippet = `${start > 0 ? "…" : ""}${flatten(message.text.slice(start, end))}${end < message.text.length ? "…" : ""}`;
		hits.push({ id: message.i, date: message.date, kind: message.kind, snippet });
	}
	return hits;
}

export function formatHits(hits: readonly SearchHit[], query: string): string {
	if (hits.length === 0) return `No message matches "${query}".`;
	const lines = hits.map((hit) => `#${hit.id} ${hit.date.slice(0, 10)} ${hit.kind}: ${hit.snippet}`);
	return `${hits.length} match${hits.length === 1 ? "" : "es"} for "${query}" (newest first; read more with zoom(id, 1) or date(id)):\n${lines.join("\n")}`;
}
