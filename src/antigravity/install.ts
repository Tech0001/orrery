/**
 * The Antigravity CLI's side of setup (spec 2026-11-20-antigravity-design, "Install"): one key of Orrery's in each of
 * three JSON files of Antigravity's, each added only where the file has none, and each file copied first
 * (src/agent/tools.ts rewriteKeepingCopy):
 * - `~/.gemini/config/hooks.json` (Antigravity's global hooks, which its App and IDE load too): `orrery`, with
 *   PreInvocation, PreToolUse (every tool) and Stop, each running a fixed shell line that execs Orrery's stable command
 *   (app/current's: src/install/layout.ts) as `agy-hook <event>`. A session with no ORRERY_AGENT (a plain agy, the App,
 *   the IDE) gets PreInvocation's and Stop's idle answer from the line itself, without starting Orrery; its tool calls
 *   still go to the guard. With no command there (Orrery removed) each reads its input and gives the idle answer (for
 *   PreToolUse, nothing, which agy takes as allow), so agy shows no hook error.
 * - `~/.gemini/config/mcp_config.json`: `mcpServers.orrery`, running `orrery mcp --tool antigravity`, its memory tools
 *   eager (agy then calls them as mcp_orrery_<tool>, and the guard approves them in an agent's session). agy gives its
 *   servers its own environment (seen live), so the server finds the launch's ORRERY_AGENT and token.
 * - `~/.gemini/antigravity-cli/settings.json`: `statusLine`, running `orrery agy-status` below agy's own row
 *   (`stack_with_default`); a status line of the person's own stays.
 * Only a version that answers `agy-hook` (AGY_SINCE on) is wired: an older Orrery answers the guard with an error, which
 * agy takes as a refusal of every tool call, so a rollback to one removes the wiring (unwireAgy).
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { safeText } from "../agent/source-labels.ts";
import type { InstallStep, ToolCheck } from "../agent/tools.ts";
import { ENTRY_TAILS, entries } from "../install/layout.ts";
import { newer } from "../install/update.ts";

/** The first Orrery that answers `orrery agy-hook`. */
export const AGY_SINCE = "0.11.0";

/** Whether the installed `version` answers Antigravity's hooks; a version that can't be read can't be trusted to. */
export function agySupported(version: string | undefined): boolean {
	return version !== undefined && /^[0-9]+\.[0-9]+\.[0-9]+/.test(version) && !newer(AGY_SINCE, version);
}

/** Antigravity's files Orrery edits, under HOME. */
export function agyFiles(env: NodeJS.ProcessEnv): { readonly folder: string; readonly hooks: string; readonly mcp: string; readonly settings: string } {
	const home = env.HOME || homedir();
	const gemini = join(home, ".gemini");
	return { folder: join(gemini, "antigravity-cli"), hooks: join(gemini, "config", "hooks.json"), mcp: join(gemini, "config", "mcp_config.json"), settings: join(gemini, "antigravity-cli", "settings.json") };
}

/** Whether the Antigravity CLI's folder is there: setup wires an agy that has run, though not on PATH. */
export function agyFolderThere(env: NodeJS.ProcessEnv): boolean {
	try {
		return statSync(agyFiles(env).folder).isDirectory();
	} catch {
		return false;
	}
}

/** `word` as one shell word, in single quotes. */
const quoted = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;

/** The idle answer of each event: PreInvocation's empty one, Stop's that lets agy stop, PreToolUse's nothing (allow). */
const IDLE = { "pre-invocation": "{}", stop: '{"decision":"stop"}', "pre-tool-use": "" } as const;
type Event = keyof typeof IDLE;

/** The shell line agy runs for `event`: Orrery's command when it is there (and, but for the guard, the session an agent's). */
export function agyHookCommand(orrery: string, event: Event): string {
	const idle = IDLE[event] === "" ? "" : ` printf '%s' ${quoted(IDLE[event])};`;
	const agentOnly = event === "pre-tool-use" ? "" : ' && [ -n "$ORRERY_AGENT" ]';
	return `o=${quoted(orrery)}; [ -x "$o" ]${agentOnly} || { cat >/dev/null;${idle} exit 0; }; exec "$o" agy-hook ${event}`;
}

/** How long agy gives each hook, in seconds: PreInvocation may wait for the recorder and the summaries. */
const TIMEOUTS: Readonly<Record<Event, number>> = { "pre-invocation": 30, "pre-tool-use": 10, stop: 10 };

/** Orrery's entry in Antigravity's hooks.json, for the Orrery command at `orrery`. */
export function agyHookEntry(orrery: string): Record<string, unknown> {
	const handler = (event: Event) => ({ type: "command", command: agyHookCommand(orrery, event), timeout: TIMEOUTS[event] });
	return { PreInvocation: [handler("pre-invocation")], PreToolUse: [{ matcher: "", hooks: [handler("pre-tool-use")] }], Stop: [handler("stop")] };
}

const SCRIPT_START = /^o='((?:[^']|'\\'')*)'; /;

/** The Orrery command an `orrery` hooks entry runs, when it is exactly what agyHookEntry writes; else undefined. */
export function agyHookTarget(entry: unknown): string | undefined {
	const command = (entry as { PreInvocation?: { command?: unknown }[] } | null)?.PreInvocation?.[0]?.command;
	const path = typeof command === "string" ? SCRIPT_START.exec(command)?.[1] : undefined;
	if (path === undefined) return undefined;
	const orrery = path.replaceAll("'\\''", "'");
	return isDeepStrictEqual(entry, agyHookEntry(orrery)) ? orrery : undefined;
}

/**
 * The memory tools agy registers up front, as mcp_orrery_<tool> (eager; seen live). The server's others (agents,
 * agent_memory, for an agent whose reads allow them) stay lazy: the model reaches them through call_mcp_tool.
 */
const MEMORY_TOOLS = ["zoom", "date", "search"];

/** Orrery's server in Antigravity's mcp_config.json, for the Orrery command at `orrery`. */
export function agyMcpEntry(orrery: string): Record<string, unknown> {
	return { command: orrery, args: ["mcp", "--tool", "antigravity"], tools: Object.fromEntries(MEMORY_TOOLS.map((tool) => [tool, { eager: true }])) };
}

/** Orrery's status line in agy's settings.json: nothing, quietly, when Orrery is gone; else it execs Orrery's row. */
export function agyStatusEntry(orrery: string): Record<string, unknown> {
	return { type: "command", command: `[ -x ${quoted(orrery)} ] || exit 0; exec ${quoted(orrery)} agy-status`, stack_with_default: true };
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** A JSON file's text as an object ("" or only blanks: none yet). Throws for anything that is no JSON object. */
function parseObject(text: string, path: string): Json {
	if (text.trim() === "") return {};
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error(`${path} is not JSON; nothing was changed`);
	}
	if (!isObject(value)) throw new Error(`${path} holds no JSON object; nothing was changed`);
	return value;
}

/** Which of Orrery's three entries, and where each sits in its file. */
export type AgyPart = "hooks" | "mcp" | "status";

/** The entry at its place in a parsed file, and that file's object with it set or removed. */
const PLACE: Readonly<Record<AgyPart, { readonly get: (json: Json) => unknown; readonly set: (json: Json, value: unknown) => Json; readonly drop: (json: Json) => Json }>> = {
	hooks: { get: (json) => json.orrery, set: (json, value) => ({ ...json, orrery: value }), drop: ({ orrery: _, ...rest }) => rest },
	mcp: {
		get: (json) => (isObject(json.mcpServers) ? json.mcpServers.orrery : undefined),
		set: (json, value) => ({ ...json, mcpServers: { ...(isObject(json.mcpServers) ? json.mcpServers : {}), orrery: value } }),
		drop: (json) => {
			if (!isObject(json.mcpServers)) return json;
			const { orrery: _, ...servers } = json.mcpServers;
			return { ...json, mcpServers: servers };
		},
	},
	status: { get: (json) => json.statusLine, set: (json, value) => ({ ...json, statusLine: value }), drop: ({ statusLine: _, ...rest }) => rest },
};

/** What Orrery writes for `part`, for the Orrery command at `orrery`. */
const entryOf = (part: AgyPart, orrery: string) => (part === "hooks" ? agyHookEntry(orrery) : part === "mcp" ? agyMcpEntry(orrery) : agyStatusEntry(orrery));

/** Whether an entry there is Orrery's for `orrery` (an MCP server's own on/off switch aside). */
function isOurs(part: AgyPart, present: unknown, orrery: string): boolean {
	if (part === "mcp" && isObject(present) && "disabled" in present) {
		const { disabled: _, ...rest } = present;
		return isDeepStrictEqual(rest, agyMcpEntry(orrery));
	}
	return isDeepStrictEqual(present, entryOf(part, orrery));
}

/** The file's text with Orrery's `part` added where it has none: `added`, or `kept` when one is there that isn't Orrery's. */
export function addAgyEntry(part: AgyPart, text: string, orrery: string, path: string = part): { readonly next: string; readonly added: boolean; readonly kept: boolean } {
	const json = parseObject(text, path);
	const present = PLACE[part].get(json);
	if (present !== undefined) return { next: text, added: false, kept: !isOurs(part, present, orrery) };
	return { next: `${JSON.stringify(PLACE[part].set(json, entryOf(part, orrery)), null, 2)}\n`, added: true, kept: false };
}

/** The file's text without Orrery's `part` for `orrery`, when it is there and still reads as Orrery wrote it. */
export function removeAgyEntry(part: AgyPart, text: string, orrery: string, path: string = part): { readonly next: string; readonly removed: boolean } {
	const json = parseObject(text, path);
	const present = PLACE[part].get(json);
	if (present === undefined || !isOurs(part, present, orrery)) return { next: text, removed: false };
	return { next: `${JSON.stringify(PLACE[part].drop(json), null, 2)}\n`, removed: true };
}

/** A file's text, "" when there is none; undefined when it can't be read. */
function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		return (error as { code?: unknown }).code === "ENOENT" ? "" : undefined;
	}
}

const sameCommand = (path: string, entry: string) => resolve(path) === resolve(entry);

/**
 * Antigravity's row in the tools check, for the Orrery at `root`: "installed" when its hooks entry runs this root's
 * command and its MCP config has an `orrery` server (Orrery's, or the person's own); "missing" when either is not there;
 * "other" when the hooks entry is not Orrery's or another Orrery's; "update available" when it is this root's other
 * install shape's; "unknown" when a file can't be read or is no JSON object.
 */
export function agyWiring(root: string, env: NodeJS.ProcessEnv): Pick<ToolCheck, "wiring" | "detail" | "now"> {
	const { hooks, mcp } = agyFiles(env);
	const orrery = entries(root).cli;
	const hooksText = readText(hooks);
	const mcpText = readText(mcp);
	if (hooksText === undefined) return { wiring: "unknown", detail: `cannot read ${safeText(hooks)}` };
	if (mcpText === undefined) return { wiring: "unknown", detail: `cannot read ${safeText(mcp)}` };
	let entry: unknown;
	let server: unknown;
	try {
		entry = PLACE.hooks.get(parseObject(hooksText, hooks));
		server = PLACE.mcp.get(parseObject(mcpText, mcp));
	} catch (error) {
		return { wiring: "unknown", detail: safeText(error instanceof Error ? error.message : String(error)) };
	}
	if (entry === undefined) return { wiring: "missing", detail: `${safeText(hooks)} has no orrery entry` };
	const target = agyHookTarget(entry);
	if (target === undefined) return { wiring: "other", detail: `the orrery entry in ${safeText(hooks)} is not Orrery's`, now: "not Orrery's" };
	const own = sameCommand(target, orrery);
	const otherShape = !own && ENTRY_TAILS.cli.map((tail) => join(root, tail)).some((path) => sameCommand(target, path));
	if (!own && !otherShape) return { wiring: "other", detail: `${safeText(hooks)} runs another Orrery: ${safeText(target)}`, now: `runs ${safeText(target)}` };
	if (otherShape) return { wiring: "update available", detail: "Orrery's hooks run this Orrery's other install shape; setup moves them to this version's", now: `runs ${safeText(target)}` };
	if (server === undefined) return { wiring: "missing", detail: `${safeText(mcp)} has no orrery server` };
	return { wiring: "installed", detail: safeText(hooks) };
}

/**
 * What connecting Orrery to Antigravity does for the Orrery at `root`: each of the three entries it lacks added, and an
 * `orrery` hooks entry of another Orrery's (or this one's other shape) replaced; each file copied first. A hooks entry
 * that is not Orrery's at all is the person's: setup says so and leaves it.
 */
export function agyInstallSteps(root: string, env: NodeJS.ProcessEnv): InstallStep[] {
	const files = agyFiles(env);
	const orrery = entries(root).cli;
	const steps: InstallStep[] = [];
	const hooksText = readText(files.hooks) ?? "";
	let entry: unknown;
	try {
		entry = PLACE.hooks.get(parseObject(hooksText, files.hooks));
	} catch {
		entry = undefined;
	}
	const target = entry === undefined ? undefined : agyHookTarget(entry);
	if (entry === undefined || (target !== undefined && !sameCommand(target, orrery))) {
		steps.push({
			kind: "edit",
			path: files.hooks,
			what: "Orrery's hooks",
			describe: `${entry === undefined ? "add" : "replace"} Orrery's hooks in ${safeText(files.hooks)} (every Antigravity session; a copy of it first)`,
			edit: (text) => {
				const json = parseObject(text, files.hooks);
				const present = PLACE.hooks.get(json);
				const theirs = present !== undefined && agyHookTarget(present) === undefined;
				if (theirs) return { next: text, said: [`kept the orrery entry in ${files.hooks}, which is not Orrery's: Antigravity runs no hooks of Orrery's while it is there`] };
				return { next: `${JSON.stringify(PLACE.hooks.set(json, agyHookEntry(orrery)), null, 2)}\n`, said: [`${present === undefined ? "added" : "replaced"} Orrery's hooks in ${files.hooks}`] };
			},
		});
	}
	for (const [part, path, what] of [["mcp", files.mcp, "Orrery's memory tools"], ["status", files.settings, "Orrery's status row"]] as const) {
		let lacks = true;
		try {
			lacks = addAgyEntry(part, readText(path) ?? "", orrery, path).added;
		} catch {
			// the edit says why
		}
		if (!lacks) continue;
		steps.push({
			kind: "edit",
			path,
			what,
			describe: `add ${what} to ${safeText(path)} unless it has its own (a copy of it first)`,
			edit: (text) => {
				const { next, added, kept } = addAgyEntry(part, text, orrery, path);
				const said = added ? [`added ${what} to ${path}`] : kept ? [part === "status" ? `kept your own status line in ${path}; for Orrery's row, run orrery agy-status from it (it reads agy's status JSON on stdin)` : `kept the orrery server in ${path}, which is not Orrery's: agy gets no memory tools from Orrery while it is there`] : [];
				return { next, said };
			},
		});
	}
	return steps;
}
