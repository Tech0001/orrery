import type { Kind } from "../../src/memory/index.ts";

export interface FixtureMessage {
	readonly kind: Kind;
	readonly text: string;
	readonly date: string;
}

const WORDS = ["path", "meadow", "chart", "garden", "station", "é", "第一", "🌳", "commit", "PASS", "relay", "zoom"];
const KINDS: Kind[] = ["user", "talk", "tool", "echo", "note"];

function mulberry32(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Deterministic messages: mostly short, some multi-KB, with unicode and newlines. */
export function makeFixture(count: number, seed = 7): FixtureMessage[] {
	const random = mulberry32(seed);
	const messages: FixtureMessage[] = [];
	for (let i = 0; i < count; i++) {
		const words = 1 + Math.floor(random() ** 3 * 400);
		const parts: string[] = [];
		for (let w = 0; w < words; w++) {
			parts.push(WORDS[Math.floor(random() * WORDS.length)] + (random() < 0.05 ? "\n" : ""));
		}
		messages.push({
			kind: KINDS[Math.floor(random() * KINDS.length)],
			text: `m${i} ${parts.join(" ")}`,
			date: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
		});
	}
	return messages;
}
