/** Interleave turns by time without splitting them, and cut long notes into labeled parts (spec §7). */

import { byteSize, type NewMessage } from "../memory/index.ts";
import type { ImportTurn } from "./turns.ts";

export function interleave(...groups: readonly (readonly ImportTurn[])[]): ImportTurn[] {
	const keyed = groups.flatMap((group, groupIndex) =>
		group.map((turn, position) => ({ turn, time: Date.parse(turn.start), groupIndex, position })),
	);
	keyed.sort((a, b) => a.time - b.time || a.groupIndex - b.groupIndex || a.position - b.position);
	return keyed.map((entry) => entry.turn);
}

/** Splits text into pieces of at most `maxBytes`, preferring heading boundaries, then line boundaries. */
function pieces(text: string, maxBytes: number): string[] {
	const sections: string[] = [];
	let current: string[] = [];
	for (const line of text.split("\n")) {
		if (/^#{1,3} /.test(line) && current.length > 0) {
			sections.push(current.join("\n"));
			current = [];
		}
		current.push(line);
	}
	if (current.length > 0) sections.push(current.join("\n"));
	const out: string[] = [];
	let chunk = "";
	const push = (piece: string) => {
		const candidate = chunk ? `${chunk}\n${piece}` : piece;
		if (byteSize(candidate) <= maxBytes) {
			chunk = candidate;
			return;
		}
		if (chunk) out.push(chunk);
		chunk = piece;
	};
	for (const section of sections) {
		if (byteSize(section) <= maxBytes) push(section);
		else for (const line of section.split("\n")) push(line);
	}
	if (chunk) out.push(chunk);
	return out;
}

export function splitNote(name: string, text: string, date: string, maxBytes = 16_000): NewMessage[] {
	const parts = pieces(text, maxBytes);
	if (parts.length <= 1) return [{ kind: "note", text: `${name}\n\n${text}`, date }];
	return parts.map((part, i) => ({ kind: "note", text: `${name} (part ${i + 1} of ${parts.length})\n\n${part}`, date }));
}
