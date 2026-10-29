/**
 * What opening an agent in Grok Build adds to its command line: `--no-leader` (grokArgs), and one `--rules` value, which
 * Grok appends to the system prompt for the whole session and keeps through /compact. It holds the agent's memory
 * section, then its instructions. Grok 1.0.70 accepts `--rules` once only ("cannot be used multiple times"), and Linux takes at most 128 KiB in one
 * argument. The instructions go in whole (at most 32 KB, as for every tool: readInstructions), and the memory section
 * takes the room they leave: a view at a smaller ceiling when the agent's own is too large, or that view's newest
 * lines, the older left out, which the zoom and search tools still reach (fitMemory, src/agent/memory-read.ts).
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
	/** What the value holds, in order. */
	readonly holds: readonly ("memory" | "instructions")[];
	/** What to say before Grok starts (the memory view was made smaller or its older lines left out, the file was over 32 KB). */
	readonly notices: readonly string[];
}

/** Between the memory section and the instructions. */
const JOIN = "\n\n";

/** The most bytes the memory section may take: GROK_ARG_MAX, less the whole instructions section and the join before it. */
export function grokMemoryRoom(name: string, instructions: Instructions | undefined): number {
	return instructions === undefined ? GROK_ARG_MAX : GROK_ARG_MAX - Buffer.byteLength(JOIN + instructionsSection(name, instructions));
}

/**
 * Grok's arguments for `agent`: `memory` (its memory section, "" when it has none yet), then its instructions section
 * whole, as one `--rules` value of at most GROK_ARG_MAX bytes. A file cut at 32 KB is said in `notices` (cutNotice). A
 * value over GROK_ARG_MAX throws: the caller fits the memory into grokMemoryRoom first.
 */
export function grokLaunch(agent: { readonly name: string }, memory: string, instructions: Instructions | undefined): GrokLaunch {
	const holds: ("memory" | "instructions")[] = [];
	const values: string[] = [];
	if (memory !== "") {
		holds.push("memory");
		values.push(memory);
	}
	if (instructions !== undefined) {
		holds.push("instructions");
		values.push(instructionsSection(agent.name, instructions));
	}
	const rules = values.join(JOIN);
	const bytes = Buffer.byteLength(rules);
	if (bytes > GROK_ARG_MAX) throw new RangeError(`${agent.name}'s --rules value is ${bytes} bytes, over the ${GROK_ARG_MAX} bytes one argument may hold`);
	return { args: rules === "" ? [] : ["--rules", rules], holds, notices: instructions?.cut === true ? [cutNotice(agent.name)] : [] };
}

/**
 * Grok's launch for `agent`: its memory section (`readOnly`: another session has the agent, so the section says this one
 * records nothing), fitted into the room its whole instructions leave, then its instructions (grokLaunch). A memory too
 * large at its view_bytes starts with a smaller view, or with that view's newest lines; one that can't be read starts
 * without it. Each is said in `notices`.
 */
export function grokRules(agent: AgentConfig, readOnly: boolean): GrokLaunch {
	const instructions = readInstructions(agent.dir);
	const notices: string[] = [];
	let memory = "";
	try {
		const fitted = fitMemory(agent, grokMemoryRoom(agent.name, instructions), { readOnly });
		memory = fitted?.section ?? "";
		if (fitted?.smaller === true) {
			if (fitted.section === undefined) notices.push(`Orrery: ${agent.name}'s memory doesn't fit on Grok's command line, not even its newest line, so this session starts without it.`);
			else if (fitted.from !== undefined) notices.push(`Orrery: ${agent.name}'s memory is too large for Grok's command line, so this session starts with its newest lines, from line ${fitted.from}; older lines are left out, and the zoom and search tools reach them.`);
			else notices.push(`Orrery: ${agent.name}'s memory view is too large for Grok's command line, so this session starts with a smaller view of it.`);
		}
	} catch (error) {
		notices.push(`Orrery: ${agent.name}'s memory could not be read: ${safeText(error instanceof Error ? error.message : String(error))}`);
	}
	const launch = grokLaunch(agent, memory, instructions);
	return { ...launch, notices: [...notices, ...launch.notices] };
}

/** Grok's spellings of `--rules`. */
const RULES_FLAGS = ["--rules", "--append-system-prompt"];

/**
 * Grok 1.0.70's options that take a value (`grok --help`): the word after one is its value, never a command. The optional
 * values of --resume and --worktree are not among them, so a command after either is still read as one.
 */
const VALUE_OPTIONS = new Set([
	...["--add-dir", "--agent", "--agents", "--allow", "--allowedTools", "--allowed-tools", "--cwd", "--debug-file", "--deny", "--disallowedTools", "--disallowed-tools"],
	...["--json-schema", "--leader-socket", "-m", "--model", "--output-format", "-p", "--single", "--permission-mode", "--prompt-file", "--prompt-json"],
	...["--reasoning-effort", "--effort", "--rules", "--append-system-prompt", "-s", "--session-id", "--sandbox", "--system-prompt-override", "--system-prompt"],
	...["--tools", "--worktree-ref", "--ref"],
]);

/**
 * What in the person's arguments starts Grok's shared leader before a `--`, as a refusal names it, or undefined: the
 * `--leader` flag; `agent … leader`, Grok's own; or Grok's commands that run a leader in the calling process, `leader
 * worker start` and `worker start` (1.0.70's help: "Run a leader in this terminal"), read as any `leader` or `worker`
 * word that is no option's value, named with the words after it up to the next option.
 */
function startsLeader(args: readonly string[]): string | undefined {
	const until = args.indexOf("--");
	const own = until < 0 ? args : args.slice(0, until);
	if (hasFlag(own, ["--leader"])) return "--leader";
	const agent = own.indexOf("agent");
	if (agent >= 0 && own.indexOf("leader", agent + 1) > agent) return "Grok's agent leader command";
	const at = own.findIndex((word, index) => (word === "leader" || word === "worker") && !VALUE_OPTIONS.has(own[index - 1] ?? ""));
	if (at < 0) return undefined;
	const next = own.findIndex((word, index) => index > at && word.startsWith("-"));
	return `Grok's ${own.slice(at, next < 0 ? undefined : next).join(" ")} command`;
}

/**
 * Why the person's arguments can't open `name` in Grok beside Orrery's flags (`launch`, grokArgs), or undefined: Grok's
 * leader mode, which Orrery opens agents without (grokArgs), naming what in them starts it, or rules of their own, which
 * Grok refuses as a second `--rules`.
 */
export function grokArgsRefusal(name: string, launch: GrokLaunch, args: readonly string[]): string | undefined {
	const leader = startsLeader(args);
	if (leader !== undefined) return `Orrery opens Grok with --no-leader: in leader mode Grok runs every session's hooks and memory tools in one shared process, where one agent's session can't be told from another's. Open ${name} without ${leader}.`;
	if (launch.holds.length === 0 || !hasFlag(args, RULES_FLAGS)) return undefined;
	return `Orrery gives Grok ${name}'s ${launch.holds.join(" and ")} as its --rules, which Grok takes once: put your rules in ${name}'s instructions.md, or open ${name} without them.`;
}

/** Whether the person's arguments give one of `flags` (alone, or with `=` and a value) before a `--`. */
function hasFlag(args: readonly string[], flags: readonly string[]): boolean {
	for (const word of args) {
		if (word === "--") return false;
		if (flags.some((flag) => word === flag || word.startsWith(`${flag}=`))) return true;
	}
	return false;
}

/** Grok's flags that resume a session, which takes no --rules again (Grok 1.0.70 keeps its system prompt as it was). */
const RESUME_FLAGS = ["--resume", "-r", "--continue", "-c"];

/**
 * What to say when the person's arguments resume a Grok session: it keeps the memory section of its first launch, since
 * Grok doesn't apply --rules on a resume. Undefined when they don't resume one.
 */
export function grokResumeNotice(name: string, args: readonly string[]): string | undefined {
	if (!hasFlag(args, RESUME_FLAGS)) return undefined;
	return `Orrery: a resumed Grok session keeps ${name}'s memory as it was at that session's first launch; newer memory is reachable with the zoom and search tools. Start a new session for a fresh view.`;
}

/**
 * Grok's command line for `launch` and the person's arguments: Orrery's flags first, `--no-leader` (once: Grok refuses it
 * twice, so not when the person gives it) and `--rules`. Grok's leader mode (`--leader`, or `[cli] use_leader = true` in
 * its config, which --no-leader overrides: seen live, 1.0.70) runs every session's hooks and memory tools in one shared
 * process with its first client's environment, where this session's agent can't be told from another's
 * (src/grok/host.ts isGrokLeader); the person's own `--leader` is refused (grokArgsRefusal).
 */
export function grokArgs(launch: GrokLaunch, userArgs: readonly string[]): string[] {
	return [...(hasFlag(userArgs, ["--no-leader"]) ? [] : ["--no-leader"]), ...launch.args, ...userArgs];
}
