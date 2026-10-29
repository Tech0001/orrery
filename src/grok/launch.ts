/**
 * What opening an agent in Grok Build adds to its command line: one `--rules` value, which Grok appends to the system
 * prompt for the whole session and keeps through /compact. It holds the agent's memory section, then its instructions.
 * Grok 1.0.70 accepts `--rules` once only ("cannot be used multiple times"), and Linux takes at most 128 KiB in one
 * argument, so the instructions are cut to the room the memory section leaves; the memory section is never cut.
 */

import { cutNotice, type Instructions, instructionsSection } from "../agent/instructions.ts";

/** The most bytes (UTF-8) one argument may hold: Linux's limit is 131,072; this leaves some room. */
export const GROK_ARG_MAX = 131_000;

export interface GrokLaunch {
	/** `--rules` and its value (none when there is no memory and no instructions): what goes before the person's own arguments. */
	readonly args: readonly string[];
	/** What to say before Grok starts (the instructions were cut). */
	readonly notices: readonly string[];
}

/** Said when the instructions are cut to fit Grok's command line (the file itself may be under 32 KB). */
export function grokCutNotice(name: string): string {
	return `Orrery: ${name}'s instructions are too long for Grok's command line; only the first part reaches the model. Shorten instructions.md.`;
}

/** The longest start of `text` within `maxBytes` UTF-8 bytes, at a line boundary when it has one, else at a whole character. */
function within(text: string, maxBytes: number): string {
	let end = 0;
	let bytes = 0;
	for (const ch of text) {
		bytes += Buffer.byteLength(ch);
		if (bytes > maxBytes) break;
		end += ch.length;
	}
	const head = text.slice(0, end);
	if (end === text.length) return head;
	const line = head.lastIndexOf("\n");
	return line > 0 ? head.slice(0, line) : head;
}

/**
 * Grok's arguments for `agent`: `memory` (its memory section, "" when it has none yet) and its instructions as one
 * `--rules` value. Over GROK_ARG_MAX bytes, the instructions are cut at a line (their notice, cutNotice, ends the value)
 * and said so in `notices`. A memory section alone over the limit cannot be passed: it throws.
 */
export function grokLaunch(agent: { readonly name: string }, memory: string, instructions: Instructions | undefined): GrokLaunch {
	const notices: string[] = [];
	const memoryBytes = Buffer.byteLength(memory);
	if (memoryBytes > GROK_ARG_MAX) throw new Error(`${agent.name}'s memory section is ${memoryBytes} bytes, over the ${GROK_ARG_MAX} bytes Grok takes in one argument; lower view_bytes in the agent's memory settings.`);
	let rules = memory;
	if (instructions !== undefined) {
		const section = instructionsSection(agent.name, instructions);
		const join = memory === "" ? "" : "\n\n";
		const room = GROK_ARG_MAX - memoryBytes - Buffer.byteLength(join);
		if (Buffer.byteLength(section) <= room) {
			rules += join + section;
			if (instructions.cut) notices.push(cutNotice(agent.name));
		} else {
			// Room for the notice that tells the model the rest is missing, then as much of the instructions as is left.
			const tail = `\n\n${cutNotice(agent.name)}`;
			const kept = within(section, room - Buffer.byteLength(tail)).trimEnd();
			if (kept !== "") rules += join + kept + tail;
			notices.push(grokCutNotice(agent.name));
		}
	}
	return { args: rules === "" ? [] : ["--rules", rules], notices };
}

/** Grok's command line for `launch` and the person's arguments: Orrery's `--rules` first. */
export function grokArgs(launch: GrokLaunch, userArgs: readonly string[]): string[] {
	return [...launch.args, ...userArgs];
}
