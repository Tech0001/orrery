/** A name for an agent made from a chat (spec 2026-10-13-orrery-agents-design §6, step 2). */

import { RESERVED_NAMES } from "../agent/config.ts";

/** Agent names are at most this long (src/agent/config.ts). */
const MAX = 32;

/**
 * A valid, free name from a chat's title: its Latin words and digits joined by "-" ("Set up the build cache" →
 * "Set-up-the-build-cache"), accents dropped, as many whole words as fit. It starts with a letter ("Chat" before a
 * number, or alone when nothing is left), is never a word `orrery agent` uses, and gets "-2", "-3", … when taken
 * (compared without case) or `blocked` (its data folder already has a memory store, say).
 */
export function suggestName(title: string, taken: readonly string[], blocked: (name: string) => boolean = () => false): string {
	const words = title.normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/[^A-Za-z0-9]+/).filter(Boolean);
	let base = "";
	for (const word of words) {
		const next = base === "" ? word : `${base}-${word}`;
		if (next.length > MAX) break;
		base = next;
	}
	if (base === "" && words.length > 0) base = (words[0] as string).slice(0, MAX);
	if (!/^[A-Za-z]/.test(base)) base = (base === "" ? "Chat" : `Chat-${base}`).slice(0, MAX).replace(/-+$/, "");
	if (RESERVED_NAMES.includes(base.toLowerCase())) base = `${base}-agent`;
	const free = (name: string) => !taken.some((other) => other.toLowerCase() === name.toLowerCase()) && !blocked(name);
	if (free(base)) return base;
	for (let n = 2; ; n++) {
		const suffix = `-${n}`;
		const name = `${base.slice(0, MAX - suffix.length).replace(/-+$/, "")}${suffix}`;
		if (free(name)) return name;
	}
}
