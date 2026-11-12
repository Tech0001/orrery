/**
 * Grok Build's side of `orrery install` and setup (spec 2026-10-29-grok-build-design, "Install"): Orrery's hooks, as one
 * global file, and two entries in Grok's config, all in Grok's folder ($GROK_HOME, else ~/.grok: grokHome).
 * - `hooks/orrery.json` has one group per event Orrery answers (GROK_HOOK_EVENTS), each running /bin/sh with arguments,
 *   which Grok starts without a shell of its own: one fixed script, the event its argument. The script execs Orrery's
 *   stable command (app/current's, which outlives an update: src/install/layout.ts) as `grok-hook <event>`, so the hook's
 *   parent stays Grok; with no command there (Orrery removed) it reads its input and exits 0, so Grok shows no hook error.
 *   Nothing of the hook's input is in the script: Grok gives it on stdin. SessionStart may wait for the recorder, so it
 *   gets 15 s; the others 10 s (Grok's default is 5).
 * - `config.toml` gets the status row (`[ui.status_line]`, running `orrery grok-status`; with no command there,
 *   nothing, as the hook file's script does) and Orrery's memory tools (`[mcp_servers.orrery]`, `orrery mcp --tool
 *   grok`, given the launch's ORRERY_AGENT and its token: Grok expands them at load time), each only when it has none.
 *   Every line already there stays as it was, and the edit is checked as src/agent/config-edit.ts checks its own: the
 *   result must parse, and differ from the file by exactly those tables. A status line of the person's own stays; they
 *   are told how to show Orrery's.
 * - Only a version that answers `grok-hook` (GROK_SINCE on) is wired: an older Orrery answers it with an error, which
 *   blocks every prompt, so a rollback to one removes the wiring (src/install/uninstall.ts unwireGrok).
 * Writing them is src/agent/tools.ts's (installSteps, runInstall); this file makes and reads their text. Each write keeps
 * the record of the Grok settings the person approved in step (src/grok/settings.ts keepInStep), and Grok's row in the
 * tools check, where it is shown, says when Grok's settings aren't the ones approved (grokSettingsWords).
 */

import { lstatSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse } from "smol-toml";
import { canonical } from "../agent/config-edit.ts";
import { AGENT_ENV, TOKEN_ENV } from "../agent/pick.ts";
import { safeText } from "../agent/source-labels.ts";
import type { InstallStep, ToolCheck } from "../agent/tools.ts";
import { tomlString } from "../codex/launch.ts";
import { ENTRY_TAILS, entries } from "../install/layout.ts";
import { newer } from "../install/update.ts";
import { grokHome } from "./log.ts";
import { GROK_HOOK_EVENTS } from "./names.ts";
import { checkGrokSettings, keepInStep } from "./settings.ts";
import { grokConfigKeys, grokHookKeys, settingsDataDir } from "./settings-keys.ts";

/** The first Orrery that answers `orrery grok-hook`. */
export const GROK_SINCE = "0.10.0";

/** Whether the installed `version` answers Grok's hooks; a version that can't be read can't be trusted to. */
export function grokSupported(version: string | undefined): boolean {
	return version !== undefined && /^[0-9]+\.[0-9]+\.[0-9]+/.test(version) && !newer(GROK_SINCE, version);
}

/** Grok's folder, the hook file Orrery writes there, and Grok's config. */
export function grokFiles(env: NodeJS.ProcessEnv): { readonly home: string; readonly hooks: string; readonly config: string } {
	const home = grokHome(env, env.HOME || homedir());
	return { home, hooks: join(home, "hooks", "orrery.json"), config: join(home, "config.toml") };
}

/** Whether Grok's folder is there: setup wires a Grok whose folder is there though `grok` is not on PATH. */
export function grokFolderThere(env: NodeJS.ProcessEnv): boolean {
	try {
		return statSync(grokFiles(env).home).isDirectory();
	} catch {
		return false;
	}
}

/** Grok's name for each event. */
const EVENT_NAMES: Readonly<Record<(typeof GROK_HOOK_EVENTS)[number], string>> = {
	"session-start": "SessionStart",
	"user-prompt-submit": "UserPromptSubmit",
	"pre-tool-use": "PreToolUse",
	stop: "Stop",
	"stop-cancelled": "StopCancelled",
	"session-end": "SessionEnd",
};

/** `word` as one shell word, in single quotes. */
const quoted = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;

/** The script after `o='<orrery>'; `: $1 is the event (the hook's arguments), $0 the name the script runs as. */
const RUN = '[ -x "$o" ] || { cat >/dev/null; exit 0; }; exec "$o" grok-hook "$1"';
const SCRIPT_START = /^o='((?:[^']|'\\'')*)'; /;

/** How long Grok gives Orrery's SessionStart, in seconds (its other hooks get 10): Grok goes on without it after that. */
export const GROK_SESSION_START_TIMEOUT = 15;

/** The hook file's text for the Orrery command at `orrery` (src/install/layout.ts entries(...).cli). */
export function grokHookFile(orrery: string): string {
	const script = `o=${quoted(orrery)}; ${RUN}`;
	const hooks = Object.fromEntries(
		GROK_HOOK_EVENTS.map((event) => [EVENT_NAMES[event], [{ hooks: [{ type: "command", command: "/bin/sh", args: ["-c", script, "orrery-grok", event], timeout: event === "session-start" ? GROK_SESSION_START_TIMEOUT : 10 }] }]]),
	);
	return `${JSON.stringify({ hooks }, null, 2)}\n`;
}

/** The Orrery command a hook file runs, when the file is exactly what grokHookFile writes (any layout of its JSON); else undefined. */
export function grokHookTarget(text: string): string | undefined {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		return undefined;
	}
	const script = (json as { hooks?: { SessionStart?: { hooks?: { args?: unknown[] }[] }[] } } | null)?.hooks?.SessionStart?.[0]?.hooks?.[0]?.args?.[1];
	const quotedPath = typeof script === "string" ? SCRIPT_START.exec(script)?.[1] : undefined;
	if (quotedPath === undefined) return undefined;
	const orrery = quotedPath.replaceAll("'\\''", "'");
	return isDeepStrictEqual(json, JSON.parse(grokHookFile(orrery))) ? orrery : undefined;
}

/** Whether a hook file is one Orrery wrote, for any Orrery. */
export function isOrreryHookFile(text: string): boolean {
	return grokHookTarget(text) !== undefined;
}

type Table = Record<string, unknown>;

/** The tables Orrery adds to Grok's config, by their names there, in the order they are added. */
const STATUS = "ui.status_line";
const SERVER = "mcp_servers.orrery";
const NAMES = [STATUS, SERVER] as const;
type Name = (typeof NAMES)[number];

/**
 * The status row's command for the Orrery command at `orrery`: a shell line, which Grok runs through sh. With no
 * command there (Orrery removed), it exits 0 and prints nothing, as the hook file's script does, so Grok shows no row
 * rather than an error; else it execs the command, so its parent stays Grok.
 */
export function grokStatusCommand(orrery: string): string {
	return `[ -x ${quoted(orrery)} ] || exit 0; exec ${quoted(orrery)} grok-status`;
}

/** What Orrery writes in each table, for the Orrery command at `orrery`. */
function orreryTables(orrery: string): Readonly<Record<Name, Table>> {
	return {
		[STATUS]: { type: "command", command: grokStatusCommand(orrery) },
		[SERVER]: { command: orrery, args: ["mcp", "--tool", "grok"], env: { [AGENT_ENV]: `\${${AGENT_ENV}:-}`, [TOKEN_ENV]: `\${${TOKEN_ENV}:-}` } },
	};
}

/** `value` as TOML: strings, arrays of them, and inline tables, which is all Orrery writes. */
function tomlText(value: unknown): string {
	if (typeof value === "string") return tomlString(value);
	if (Array.isArray(value)) return `[${value.map(tomlText).join(", ")}]`;
	if (typeof value === "number") return String(value);
	return `{ ${Object.entries(value as Table).map(([key, inner]) => `${key} = ${tomlText(inner)}`).join(", ")} }`;
}

const isTable = (value: unknown): value is Table => typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);

/** The value at a dotted name ("ui.status_line") in a parsed config. */
function at(table: Table, name: string): unknown {
	let value: unknown = table;
	for (const key of name.split(".")) value = isTable(value) ? value[key] : undefined;
	return value;
}

/** Whether a table there reads as Orrery wrote it; Orrery's server may also carry Grok's own on/off switch (`grok mcp disable`). */
function readsAsOrrerys(name: Name, present: unknown, want: Table): boolean {
	if (!isTable(present)) return false;
	if (name === SERVER && typeof present.enabled === "boolean") {
		const { enabled: _, ...rest } = present;
		return isDeepStrictEqual(canonical(rest), canonical(want));
	}
	return isDeepStrictEqual(canonical(present), canonical(want));
}

/** Two parsed configs with the same content, an empty `ui` or `mcp_servers` table counting as none. */
function sameConfig(a: Table, b: Table): boolean {
	const pruned = (table: Table) => Object.fromEntries(Object.entries(table).filter(([key, value]) => !((key === "ui" || key === "mcp_servers") && isTable(value) && Object.keys(value).length === 0)));
	return JSON.stringify(canonical(pruned(a))) === JSON.stringify(canonical(pruned(b)));
}

/**
 * Grok's config with Orrery's tables added where it has none: `added` names them, `kept` the ones there that are not as
 * Orrery writes them (the person's own), which stay. They go after every line already there, so each of those stays as
 * it was. Throws for a file that is not TOML, and when the result would not differ from it by exactly the added tables
 * (a `ui` or `mcp_servers` written inline, which no later table may extend).
 */
export function addGrokConfig(text: string, orrery: string): { next: string; added: string[]; kept: string[] } {
	const old = parse(text) as Table;
	const want = orreryTables(orrery);
	const added: Name[] = [];
	const kept: Name[] = [];
	for (const name of NAMES) {
		const present = at(old, name);
		if (present === undefined) added.push(name);
		else if (!readsAsOrrerys(name, present, want[name])) kept.push(name);
	}
	if (added.length === 0) return { next: text, added, kept };
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const block = added.map((name) => [`[${name}]`, ...Object.entries(want[name]).map(([key, value]) => `${key} = ${tomlText(value)}`)].join(eol)).join(eol + eol);
	const next = `${text}${text === "" ? "" : text.endsWith("\n") ? eol : eol + eol}${block}${eol}`;
	const expected: Table = { ...old };
	for (const name of added) {
		const [parent, key] = name.split(".") as [string, string];
		expected[parent] = { ...(isTable(expected[parent]) ? expected[parent] : {}), [key]: want[name] };
	}
	let parsed: Table | undefined;
	try {
		parsed = parse(next) as Table;
	} catch {
		parsed = undefined;
	}
	if (parsed === undefined || !sameConfig(parsed, expected)) throw new Error(`Orrery couldn't place ${added.map((name) => `[${name}]`).join(" and ")} safely (its ${added.map((name) => name.split(".")[0]).join(" or ")} table is written in a way Orrery can't add to); nothing was changed`);
	return { next, added, kept };
}

/** A table header line for `name` (bare keys, as Orrery writes it). */
const headerOf = (name: string) => {
	const [parent, key] = name.split(".") as [string, string];
	return new RegExp(`^[ \\t]*\\[[ \\t]*${parent}[ \\t]*\\.[ \\t]*${key}[ \\t]*\\][ \\t]*(?:#.*)?\\r?$`);
};
const TABLE_START = /^[ \t]*\[/;
const NOTHING = /^[ \t]*(?:#.*)?\r?$/;

/**
 * The text without table `name`: its header and its keys, and the blank lines right above it; comments and blank lines
 * after its last key stay with what follows. Undefined when it has no such header.
 */
function withoutTable(text: string, name: string): string | undefined {
	const lines = text.split("\n");
	const header = lines.findIndex((line) => headerOf(name).test(line));
	if (header < 0) return undefined;
	let end = header + 1;
	while (end < lines.length && !TABLE_START.test(lines[end] as string)) end++;
	while (end > header + 1 && NOTHING.test(lines[end - 1] as string)) end--;
	let start = header;
	while (start > 0 && (lines[start - 1] as string).trim() === "") start--;
	return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
}

/**
 * Grok's config without Orrery's tables for the Orrery command at `orrery`, each only when it still reads as Orrery wrote
 * it (Grok's on/off switch aside): `removed` names them; `kept` the ones of those names that don't (another Orrery's, the
 * person's own, or changed since), which stay. Every other line stays. Throws for a file that is not TOML.
 */
export function removeGrokConfig(text: string, orrery: string): { next: string; removed: string[]; kept: string[] } {
	const want = orreryTables(orrery);
	let next = text;
	let now = parse(text) as Table;
	const removed: Name[] = [];
	const kept: Name[] = [];
	for (const name of NAMES) {
		const present = at(now, name);
		if (present === undefined) continue;
		const cut = readsAsOrrerys(name, present, want[name]) ? withoutTable(next, name) : undefined;
		let after: Table | undefined;
		try {
			after = cut === undefined ? undefined : (parse(cut) as Table);
		} catch {
			after = undefined;
		}
		const [parent, key] = name.split(".") as [string, string];
		const { [key]: _, ...rest } = now[parent] as Table;
		if (cut === undefined || after === undefined || !sameConfig(after, { ...now, [parent]: rest })) {
			kept.push(name);
			continue;
		}
		next = cut;
		now = after;
		removed.push(name);
	}
	return { next, removed, kept };
}

/** `[a] and [b]`. */
const tables = (names: readonly string[]) => names.map((name) => `[${name}]`).join(" and ");

/**
 * The config edit setup makes (src/agent/tools.ts runInstall): Orrery's tables added (addGrokConfig), and what to say:
 * what was added, and each table of the person's own that stays.
 */
export function grokConfigEdit(orrery: string, config: string): (text: string) => { next: string; said: string[] } {
	return (text) => {
		const { next, added, kept } = addGrokConfig(text, orrery);
		const said = added.length === 0 ? [] : [`added ${tables(added)} to ${config}`];
		if (kept.includes(STATUS)) said.push(`kept your own status line in ${config}; for Orrery's row, run orrery grok-status from it (it reads Grok's status JSON on stdin)`);
		if (kept.includes(SERVER)) said.push(`kept the [${SERVER}] in ${config}, which is not Orrery's: Grok gets no memory tools from Orrery while it is there`);
		return { next, said };
	};
}

/** Whether `path` is `root`'s Orrery command (`entry`), by its literal path: app/current stays in it. */
const sameCommand = (path: string, entry: string) => resolve(path) === resolve(entry);

/** Grok's hook file as it is: its text, or why there is none to read. */
type HookFile = { readonly kind: "text"; readonly text: string } | { readonly kind: "none" | "not a plain file" | "unreadable" };

/** Reads Grok's hook file at `hooks`, a link there not followed. */
function readHookFile(hooks: string): HookFile {
	try {
		if (!lstatSync(hooks).isFile()) return { kind: "not a plain file" };
		return { kind: "text", text: readFileSync(hooks, "utf8") };
	} catch (error) {
		return { kind: (error as { code?: unknown }).code === "ENOENT" ? "none" : "unreadable" };
	}
}

/**
 * Whether Grok runs Orrery's own hooks for the Orrery at `root`: its hook file is exactly Orrery's, running this root's
 * command (grokWiring's "installed" also needs the config tables). Undefined when the file can't be read. Under Grok, the
 * Claude Code plugin's guard stands down only when this is true and its guard isn't switched off (grokGuardSwitchedOff,
 * src/cli/main.ts claudeHook).
 */
export function grokHooksInstalled(root: string, env: NodeJS.ProcessEnv): boolean | undefined {
	const file = readHookFile(grokFiles(env).hooks);
	if (file.kind === "unreadable") return undefined;
	const target = file.kind === "text" ? grokHookTarget(file.text) : undefined;
	return target !== undefined && sameCommand(target, entries(root).cli);
}

/** Grok's switch for each hook (its /hooks tab's Space): the file naming every hook switched off, one per line. */
const DISABLED_HOOKS = "disabled-hooks";

/**
 * The name Grok 1.0.70 gives a hook of Orrery's hook file (hooks/orrery.json) for `event` (Grok's snake_case name) in that
 * file: seen live, `global/orrery:pre_tool_use[0].hooks[0]` and `global/orrery:session_start[0].hooks[0]`.
 */
const orreryHook = (event: string) => new RegExp(`^global/orrery:${event}\\[\\d+\\]\\.hooks\\[\\d+\\]$`);

/** Grok's disabled-hooks file: its text, "" when there is none, undefined when it can't be read. */
function disabledHooks(env: NodeJS.ProcessEnv): string | undefined {
	try {
		return readFileSync(join(grokFiles(env).home, DISABLED_HOOKS), "utf8");
	} catch (error) {
		return (error as { code?: unknown }).code === "ENOENT" ? "" : undefined;
	}
}

/** Whether Grok's disabled-hooks file names a hook of Orrery's for one of `events`; `unreadable` when it can't be read. */
function switchedOff(env: NodeJS.ProcessEnv, events: readonly string[], unreadable: boolean): boolean {
	const text = disabledHooks(env);
	if (text === undefined) return unreadable;
	const hooks = events.map(orreryHook);
	return text.split("\n").some((line) => hooks.some((hook) => hook.test(line.trim())));
}

/**
 * Grok's disabled-hooks file when it is there but can't be read, so whether Orrery's hooks are switched off in Grok's
 * /hooks tab can't be told (the launch says so: src/agent/launch.ts); else undefined.
 */
export function grokSwitchesUnreadable(env: NodeJS.ProcessEnv): string | undefined {
	return disabledHooks(env) === undefined ? join(grokFiles(env).home, DISABLED_HOOKS) : undefined;
}

/**
 * Whether the guard of Orrery's Grok hook file is switched off in Grok's /hooks tab (its disabled-hooks file names it),
 * or that can't be told (a file there that can't be read). Under Grok the Claude Code plugin's guard then keeps guarding
 * (src/cli/main.ts grokGuarded). No file: nothing is switched off.
 */
export function grokGuardSwitchedOff(env: NodeJS.ProcessEnv): boolean {
	return switchedOff(env, ["pre_tool_use"], true);
}

/**
 * Whether a hook Orrery records with (SessionStart, UserPromptSubmit, Stop) is switched off in Grok's /hooks tab, for the
 * status row (src/grok/status.ts). A file that can't be read tells nothing: false.
 */
export function grokRecordingSwitchedOff(env: NodeJS.ProcessEnv): boolean {
	return switchedOff(env, ["session_start", "user_prompt_submit", "stop"], false);
}

/**
 * Whether Grok's config switches Orrery's memory-tools server off (`grok mcp disable orrery`, or Grok's /mcps tab): its
 * table's `enabled = false`, or `disabled_mcp_servers` naming it (Grok's manual, 07-mcp-servers.md and
 * 26-config-reference.md). Grok then serves the session no zoom, date or search, and says nothing. False when the
 * config isn't there, can't be read or isn't TOML (grokWiring says which).
 */
export function grokMemoryToolsSwitchedOff(env: NodeJS.ProcessEnv): boolean {
	let config: Table;
	try {
		config = parse(readFileSync(grokFiles(env).config, "utf8")) as Table;
	} catch {
		return false;
	}
	const server = at(config, SERVER);
	const disabled = config.disabled_mcp_servers;
	return (isTable(server) && server.enabled === false) || (Array.isArray(disabled) && disabled.includes("orrery"));
}

/**
 * What the tools check and the launch say when Grok's config switches Orrery's memory tools off
 * (grokMemoryToolsSwitchedOff).
 */
export const GROK_TOOLS_SWITCHED_OFF = "Orrery's memory tools are switched off in Grok's config, so its sessions get no zoom, date or search; grok mcp enable orrery, run in your own terminal, switches them back on.";

/**
 * What Grok's row says of Grok's settings (its `settings`, apart from its detail: the Tools page and orrery tools show it,
 * setup doesn't) against the record of the ones the person approved in `dataDir` (src/grok/settings.ts), Grok's own
 * folder's (the global ones): never approved (no record, or none for this Grok folder), changed since then, or nothing
 * when they are as approved.
 */
export function grokSettingsWords(dataDir: string, env: NodeJS.ProcessEnv): string | undefined {
	const check = checkGrokSettings(dataDir, env, undefined);
	if (check.state === "first" || (check.state === "changed" && check.record === "new-folder")) return "Grok settings not approved yet";
	return check.state === "changed" ? "Grok settings changed since you approved them" : undefined;
}

/**
 * Grok's row in the tools check: Orrery's hook file and config tables in Grok's folder, for the Orrery at `root`.
 * - "missing": no hook file; or Orrery's, for this root, with a table of Orrery's missing from the config (none written
 *   yet, or the person removed it): adding one is asked, as connecting is, and never done by an update on its own; a
 *   launch only says so (src/agent/launch.ts).
 * - "other": a hook file that is not Orrery's, or Orrery's for another Orrery (`now` says which).
 * - "update available": Orrery's for this root's other install shape, the config tables there.
 * - "installed": the hook file runs this root's command and the config has both tables (a status line of the person's
 *   own counts); its detail says so when the config switches Orrery's memory tools off (grokMemoryToolsSwitchedOff).
 *   "unknown": a file that can't be read, or a config that is not TOML.
 */
export function grokWiring(root: string, env: NodeJS.ProcessEnv): Pick<ToolCheck, "wiring" | "detail" | "now"> {
	const { hooks, config } = grokFiles(env);
	const orrery = entries(root).cli;
	const file = readHookFile(hooks);
	if (file.kind === "not a plain file") return { wiring: "other", detail: `${safeText(hooks)} is not a plain file`, now: "not a plain file" };
	if (file.kind === "unreadable") return { wiring: "unknown", detail: `cannot read ${safeText(hooks)}` };
	const target = file.kind === "text" ? grokHookTarget(file.text) : undefined;
	if (file.kind === "text" && target === undefined) return { wiring: "other", detail: `${safeText(hooks)} is not Orrery's hook file`, now: "not Orrery's hook file" };
	let configText = "";
	try {
		configText = readFileSync(config, "utf8");
	} catch (error) {
		if ((error as { code?: unknown }).code !== "ENOENT") return { wiring: "unknown", detail: `cannot read ${safeText(config)}` };
	}
	let added: string[];
	try {
		added = addGrokConfig(configText, orrery).added;
	} catch (error) {
		const why = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
		return { wiring: "unknown", detail: `${safeText(config)}: ${safeText(why)}` };
	}
	if (target === undefined) return { wiring: "missing", detail: `no ${safeText(hooks)}` };
	const own = sameCommand(target, orrery);
	const otherShape = !own && ENTRY_TAILS.cli.map((tail) => join(root, tail)).some((entry) => sameCommand(target, entry));
	if (!own && !otherShape) return { wiring: "other", detail: `${safeText(hooks)} runs another Orrery: ${safeText(target)}`, now: `runs ${safeText(target)}` };
	const moved = otherShape ? { now: `runs ${safeText(target)}` } : {};
	if (added.length > 0) return { wiring: "missing", detail: `${safeText(config)} has no ${added.map((name) => `[${name}]`).join(" or ")}`, ...moved };
	if (otherShape) return { wiring: "update available", detail: `Orrery's hook file runs this Orrery's other install shape; setup moves it to this version's`, ...moved };
	return { wiring: "installed", detail: grokMemoryToolsSwitchedOff(env) ? `${safeText(hooks)}; ${GROK_TOOLS_SWITCHED_OFF}` : safeText(hooks) };
}

/**
 * The tables of Orrery's that Grok's config lacks for the Orrery at `root`, in the order setup adds them; none when the
 * config can't be read or isn't TOML (grokWiring says "unknown" then).
 */
export function grokConfigLacks(root: string, env: NodeJS.ProcessEnv): Name[] {
	let text = "";
	try {
		text = readFileSync(grokFiles(env).config, "utf8");
	} catch (error) {
		if ((error as { code?: unknown }).code !== "ENOENT") return [];
	}
	try {
		return addGrokConfig(text, entries(root).cli).added as Name[];
	} catch {
		return [];
	}
}

/**
 * What installing Orrery's side of Grok does for the Orrery at `root`: write the hook file when it isn't this root's
 * already (a file that is not Orrery's is set aside first), then add the config tables it lacks (a copy of the config
 * first). `now`: what the hook file is now, for the step's text. Each write keeps the record of approved Grok settings
 * in step (keepInStep: the record in `dataDir`, else the one of the config Orrery runs with) for the file it writes and
 * the programs that runs.
 */
export function grokInstallSteps(root: string, env: NodeJS.ProcessEnv, now?: string, dataDir?: string): InstallStep[] {
	const { hooks, config } = grokFiles(env);
	const orrery = entries(root).cli;
	const keep = (keys: () => readonly string[]) => (write: () => void) => keepInStep(dataDir ?? settingsDataDir(env), env, keys(), write);
	const text = grokHookFile(orrery);
	const steps: InstallStep[] = [];
	let current: string | undefined;
	try {
		current = readFileSync(hooks, "utf8");
	} catch {
		current = undefined;
	}
	if (current !== text) {
		const describe = current === undefined ? `write ${safeText(hooks)} (Orrery's hooks for every Grok session)` : `replace ${safeText(hooks)} (now ${now ?? "something else"}) with Orrery's hooks for every Grok session`;
		// Grok keeps its folder private (0700); one made for the hook file is too.
		steps.push({ kind: "write", path: hooks, text, ours: isOrreryHookFile, folderMode: 0o700, describe, keep: keep(() => grokHookKeys(env)) });
	}
	let configText = "";
	try {
		configText = readFileSync(config, "utf8");
	} catch {
		// none yet: the edit makes it
	}
	let lacks = true;
	try {
		lacks = addGrokConfig(configText, orrery).added.length > 0;
	} catch {
		// the edit says why
	}
	if (lacks) {
		const what = "Orrery's status row and memory tools";
		steps.push({ kind: "edit", path: config, what, edit: grokConfigEdit(orrery, config), describe: `add ${what} to ${safeText(config)} unless it has its own (a copy of it first)`, keep: keep(() => grokConfigKeys(env, [orrery])) });
	}
	return steps;
}
