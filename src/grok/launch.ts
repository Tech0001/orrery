/**
 * What opening an agent in Grok Build adds to its command line: one `--rules` value, which Grok appends to the system
 * prompt for the whole session and keeps through /compact. It holds the agent's memory section, then its instructions.
 * Grok 1.0.70 accepts `--rules` once only ("cannot be used multiple times"), and Linux takes at most 128 KiB in one
 * argument. So the memory section, never cut, is made to fit (a view at a smaller ceiling when the agent's is too large:
 * fitMemory, src/agent/memory-read.ts), and the instructions get the room it leaves, cut with a note that says so.
 * The text is on Grok's command line, where other users of the computer can read it (docs/architecture.md, Limits).
 */

import type { AgentConfig } from "../agent/config.ts";
import { cutNotice, type Instructions, instructionsSection, readInstructions } from "../agent/instructions.ts";
import { fitMemory } from "../agent/memory-read.ts";
import { safeText } from "../agent/source-labels.ts";

/** The most bytes (UTF-8) one argument may hold: Linux's limit is 131,072; this leaves some room. */
export const GROK_ARG_MAX = 131_000;

export interface GrokLaunch {
	/** `--rules` and its value (none when there is no memory and no instructions): what goes before the person's own arguments. */
	readonly args: readonly string[];
	/** What to say before Grok starts (the memory view was made smaller or left out, the instructions were cut). */
	readonly notices: readonly string[];
}

/** Said to the person when the instructions are cut to fit Grok's command line (the file itself may be under 32 KB). */
export function grokCutNotice(name: string): string {
	return `Orrery: ${name}'s instructions don't all fit on Grok's command line beside the memory, so the rest of them is left out of this session. Shorten instructions.md.`;
}

/** Ends the `--rules` value where the instructions are cut to fit, for the model: true also when none of them fit. */
export function grokCutNote(name: string): string {
	return `Orrery: ${name}'s instructions are cut here, to fit Grok's command line; the rest of them is not in this session.`;
}

/** Between the memory section and the instructions, and before the cut note. */
const JOIN = "\n\n";

/**
 * The most bytes the memory section may take: GROK_ARG_MAX, less, when there are instructions, the room to say they were
 * cut (grokCutNote) should none of them fit beside it.
 */
export function grokMemoryRoom(name: string, instructions: Instructions | undefined): number {
	return instructions === undefined ? GROK_ARG_MAX : GROK_ARG_MAX - Buffer.byteLength(JOIN + grokCutNote(name));
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
 * `--rules` value of at most GROK_ARG_MAX bytes. Instructions that don't fit whole are cut at a line and end with
 * grokCutNote (the note alone when none of them fit), said in `notices`. `memory` over grokMemoryRoom throws.
 */
export function grokLaunch(agent: { readonly name: string }, memory: string, instructions: Instructions | undefined): GrokLaunch {
	const notices: string[] = [];
	const memoryBytes = Buffer.byteLength(memory);
	const room = grokMemoryRoom(agent.name, instructions);
	if (memoryBytes > room) throw new RangeError(`${agent.name}'s memory section is ${memoryBytes} bytes, over the ${room} it may take on Grok's command line`);
	let rules = memory;
	if (instructions !== undefined) {
		const section = instructionsSection(agent.name, instructions);
		const join = memory === "" ? "" : JOIN;
		if (memoryBytes + Buffer.byteLength(join + section) <= GROK_ARG_MAX) {
			rules += join + section;
			if (instructions.cut) notices.push(cutNotice(agent.name));
		} else {
			// As much of the instructions as leaves room for the note, then the note.
			const note = grokCutNote(agent.name);
			const kept = within(section, room - memoryBytes - Buffer.byteLength(join)).trimEnd();
			rules += join + (kept === "" ? note : kept + JOIN + note);
			notices.push(grokCutNotice(agent.name));
		}
	}
	return { args: rules === "" ? [] : ["--rules", rules], notices };
}

/**
 * Grok's launch for `agent`: its memory section (`readOnly`: another session has the agent, so the section says this one
 * records nothing), made to fit, and its instructions (grokLaunch). A memory too large at its view_bytes starts with a
 * smaller view; one that fits at no view, or can't be read, starts without it. Each is said in `notices`.
 */
export function grokRules(agent: AgentConfig, readOnly: boolean): GrokLaunch {
	const instructions = readInstructions(agent.dir);
	const notices: string[] = [];
	let memory = "";
	try {
		const fitted = fitMemory(agent, "grok", grokMemoryRoom(agent.name, instructions), { readOnly });
		if (fitted?.section !== undefined) memory = fitted.section;
		if (fitted !== undefined && fitted.section === undefined) notices.push(`Orrery: ${agent.name}'s memory doesn't fit on Grok's command line until more of it is summarized, so this session starts without it.`);
		else if (fitted?.smaller === true) notices.push(`Orrery: ${agent.name}'s memory view is too large for Grok's command line, so this session starts with a smaller view of it.`);
	} catch (error) {
		notices.push(`Orrery: ${agent.name}'s memory could not be read: ${safeText(error instanceof Error ? error.message : String(error))}`);
	}
	const launch = grokLaunch(agent, memory, instructions);
	return { args: launch.args, notices: [...notices, ...launch.notices] };
}

/** Grok's spellings of `--rules`. */
const RULES_FLAGS = ["--rules", "--append-system-prompt"];

/**
 * Why the person's arguments can't open `name` in Grok beside Orrery's `--rules` (`launch`), or undefined: rules of their
 * own, which Grok refuses as a second `--rules`.
 */
export function grokArgsRefusal(name: string, launch: GrokLaunch, args: readonly string[]): string | undefined {
	if (launch.args.length === 0) return undefined;
	for (const word of args) {
		if (word === "--") break;
		if (RULES_FLAGS.some((flag) => word === flag || word.startsWith(`${flag}=`))) {
			return `Orrery gives Grok ${name}'s memory and instructions as its --rules, which Grok takes once: put your rules in ${name}'s instructions.md, or open ${name} without them.`;
		}
	}
	return undefined;
}

/** Grok's command line for `launch` and the person's arguments: Orrery's `--rules` first. */
export function grokArgs(launch: GrokLaunch, userArgs: readonly string[]): string[] {
	return [...launch.args, ...userArgs];
}
