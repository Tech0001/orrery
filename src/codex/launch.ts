/**
 * What `orrery agent <Name> --tool codex` adds to Codex's command line (spec 2026-10-16-codex-design, "Launch"): the
 * hooks, their trust values, the memory tools' MCP server, the agent's instructions and three features, every one a
 * `-c` flag, so nothing is written to Codex's own config. The trust values are computed as Codex 0.162.1 computes them
 * (codex-rs hooks/src/engine/discovery.rs); a different Codex is checked before launching (src/codex/check.ts).
 */

import { createHash } from "node:crypto";
import { cutNotice, instructionsSection, readInstructions } from "../agent/instructions.ts";
import { AGENT_ENV, TOKEN_ENV } from "../agent/pick.ts";
import { compiled, wiringRoot } from "../agent/running.ts";
import { entries } from "../install/layout.ts";

export type CodexEvent =
	| "PreToolUse"
	| "PermissionRequest"
	| "PostToolUse"
	| "PreCompact"
	| "PostCompact"
	| "SessionStart"
	| "SessionEnd"
	| "UserPromptSubmit"
	| "SubagentStart"
	| "SubagentStop"
	| "Stop"
	| "Interrupt";

/** Each event's name in Codex's trust key and hash. */
const LABELS: Record<CodexEvent, string> = {
	PreToolUse: "pre_tool_use",
	PermissionRequest: "permission_request",
	PostToolUse: "post_tool_use",
	PreCompact: "pre_compact",
	PostCompact: "post_compact",
	SessionStart: "session_start",
	SessionEnd: "session_end",
	UserPromptSubmit: "user_prompt_submit",
	SubagentStart: "subagent_start",
	SubagentStop: "subagent_stop",
	Stop: "stop",
	Interrupt: "interrupt",
};

/** Events that take no matcher: Codex leaves one out of the hash. */
const NO_MATCHER: ReadonlySet<CodexEvent> = new Set(["UserPromptSubmit", "Stop", "Interrupt"]);
/** Events that can add context: only theirs count an additionalContextLimit. */
const CONTEXT_EVENTS: ReadonlySet<CodexEvent> = new Set(["PreToolUse", "PostToolUse", "SessionStart", "UserPromptSubmit", "SubagentStart"]);
/** The limit Codex uses when none is set (2,500 tokens): a hook that names it hashes as one that doesn't. */
const DEFAULT_CONTEXT_LIMIT = 2500;

/** A command hook as Codex's config gives it. */
export interface CodexHook {
	readonly command: string;
	/** Seconds; Codex's default is 600, SessionEnd's and Interrupt's 1 (at most 3). */
	readonly timeout?: number;
	readonly statusMessage?: string;
	/** Tokens of additionalContext kept inline; 0: no limit. */
	readonly additionalContextLimit?: number;
	readonly async?: boolean;
}

/** JSON with every object's keys sorted, as serde_json writes a BTreeMap. */
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
	}
	return value;
}

/**
 * The trust value Codex keeps for a hook: "sha256:" and the hex SHA-256 of the compact JSON, keys sorted, of
 * {event_name, matcher?, hooks: [the handler as Codex normalizes it]}.
 */
export function trustHash(event: CodexEvent, hook: CodexHook, matcher?: string): string {
	const timeout = event === "SessionEnd" || event === "Interrupt" ? Math.min(Math.max(hook.timeout ?? 1, 1), 3) : Math.max(hook.timeout ?? 600, 1);
	const handler: Record<string, unknown> = { type: "command", command: hook.command, timeout, async: hook.async === true };
	if (hook.statusMessage !== undefined) handler.statusMessage = hook.statusMessage;
	if (CONTEXT_EVENTS.has(event) && hook.additionalContextLimit !== undefined && hook.additionalContextLimit !== DEFAULT_CONTEXT_LIMIT) {
		handler.additionalContextLimit = hook.additionalContextLimit;
	}
	const identity: Record<string, unknown> = { event_name: LABELS[event], hooks: [handler] };
	if (matcher !== undefined && !NO_MATCHER.has(event)) identity.matcher = matcher;
	return `sha256:${createHash("sha256").update(JSON.stringify(canonical(identity))).digest("hex")}`;
}

/** Where Codex looks up a hook given by -c: the session flags' pseudo-file, the event, the group and the handler. */
export function trustKey(event: CodexEvent, group = 0, handler = 0): string {
	return `/<session-flags>/config.toml:${LABELS[event]}:${group}:${handler}`;
}

/**
 * Orrery's hooks: one per event, each run as `<orrery> codex-hook <arg>`. SessionStart brings the memory view, so its
 * context is not cut (additionalContextLimit 0) and it may take 30 s; SessionEnd is at most 3 s in Codex.
 */
export const CODEX_HOOKS: readonly { readonly event: CodexEvent; readonly arg: string; readonly timeout: number; readonly additionalContextLimit?: number }[] = [
	{ event: "SessionStart", arg: "session-start", timeout: 30, additionalContextLimit: 0 },
	{ event: "UserPromptSubmit", arg: "user-prompt-submit", timeout: 10 },
	{ event: "Stop", arg: "stop", timeout: 10 },
	{ event: "SessionEnd", arg: "session-end", timeout: 3 },
	{ event: "PreToolUse", arg: "pre-tool-use", timeout: 10 },
];

/** The variables `orrery mcp` needs, passed by name: Codex starts MCP servers with almost none of its environment. */
const MCP_ENV = [AGENT_ENV, TOKEN_ENV, "ORRERY_CONFIG", "ORRERY_HOME"] as const;

/** The longest `developer_instructions=…` argument: Linux takes at most 128 KiB in one argument. */
export const CODEX_ARG_MAX = 100 * 1024;

/** A word the shell reads as it is. */
const PLAIN_WORD = /^[A-Za-z0-9_\/.,:@%+=-]+$/;

/**
 * `words` as one shell command (Codex 0.162.1 runs a hook as `<the account's shell> -c <command>`, not a login shell and not $SHELL):
 * a word that needs it in single quotes.
 */
export function shellWords(words: readonly string[]): string {
	return words.map((word) => (PLAIN_WORD.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`)).join(" ");
}

const SHORT_ESCAPES: Record<string, string> = { "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r", '"': '\\"', "\\": "\\\\" };

/** One character of a TOML basic string: the quote, the backslash and the control characters (DEL among them) escaped. */
function tomlChar(ch: string): string {
	const short = SHORT_ESCAPES[ch];
	if (short !== undefined) return short;
	const code = ch.codePointAt(0) as number;
	return code < 0x20 || code === 0x7f ? `\\u${code.toString(16).toUpperCase().padStart(4, "0")}` : ch;
}

/** `text` as a TOML basic string. */
export function tomlString(text: string): string {
	let out = '"';
	for (const ch of text) out += tomlChar(ch);
	return `${out}"`;
}

/** `text` as a TOML basic string of at most `maxBytes`, cut at a whole character when it is longer. */
function tomlStringWithin(text: string, maxBytes: number): { readonly value: string; readonly cut: boolean } {
	let out = '"';
	let bytes = 2;
	for (const ch of text) {
		const piece = tomlChar(ch);
		const size = Buffer.byteLength(piece);
		if (bytes + size > maxBytes) return { value: `${out}"`, cut: true };
		out += piece;
		bytes += size;
	}
	return { value: `${out}"`, cut: false };
}

/** A TOML inline table of keys that need no quotes and values already written as TOML. */
const inlineTable = (fields: Readonly<Record<string, string>>) => `{${Object.entries(fields).map(([key, value]) => `${key}=${value}`).join(",")}}`;
const tomlArray = (values: readonly string[]) => `[${values.join(",")}]`;

/** Said when the instructions are cut to fit Codex's command line (the file itself may be under 32 KB). */
export function codexCutNotice(name: string): string {
	return `Orrery: ${name}'s instructions are too long for Codex's command line; only the first part reaches the model. Shorten instructions.md.`;
}

/**
 * The command words that run this Orrery's CLI from a hook: an install's app/current binary (it outlives an update,
 * where a version folder may be removed), a release's own binary, or this runtime with the CLI's source.
 */
export function orreryCommand(env: NodeJS.ProcessEnv = process.env): string[] {
	const { style, cli } = entries(wiringRoot(env).root);
	if (style === "binary") return [cli];
	return compiled ? [process.execPath] : [process.execPath, ...process.execArgv, cli];
}

export interface CodexLaunch {
	/** What goes before the person's own arguments: --no-daemon, then `config`. */
	readonly args: readonly string[];
	/** The `-c` flags alone (the hook check gives Codex these). */
	readonly config: readonly string[];
	/** What to say before Codex starts (the instructions were cut). */
	readonly notices: readonly string[];
}

/**
 * Codex's arguments for `agent`: hooks for SessionStart, UserPromptSubmit, Stop, SessionEnd and PreToolUse running
 * `<orrery> codex-hook <event>`, their trust values as one inline table, the `orrery mcp` server with the variables it
 * needs, the agent's instructions as `developer_instructions` (cut to fit one argument, never failing), Codex's own
 * memories off, `write_stdin` into a terminal off (the guard never sees it), hooks on. --no-daemon keeps Codex in this
 * process, with this environment, rather than the shared server's.
 */
export function codexLaunch(agent: { readonly name: string; readonly dir: string }, orrery: readonly string[]): CodexLaunch {
	const config: string[] = [];
	const state: string[] = [];
	for (const hook of CODEX_HOOKS) {
		const fields: CodexHook = { command: shellWords([...orrery, "codex-hook", hook.arg]), timeout: hook.timeout, ...(hook.additionalContextLimit === undefined ? {} : { additionalContextLimit: hook.additionalContextLimit }) };
		const handler = inlineTable({ type: tomlString("command"), command: tomlString(fields.command), timeout: String(fields.timeout), ...(fields.additionalContextLimit === undefined ? {} : { additionalContextLimit: String(fields.additionalContextLimit) }) });
		config.push("-c", `hooks.${hook.event}=${tomlArray([inlineTable({ hooks: tomlArray([handler]) })])}`);
		// enabled=true: the person's config may hold enabled=false under the same key (a toggle in Codex's /hooks screen),
		// which would merge with these flags and turn Orrery's hook off in every session.
		state.push(`${tomlString(trustKey(hook.event))}=${inlineTable({ enabled: "true", trusted_hash: tomlString(trustHash(hook.event, fields)) })}`);
	}
	config.push("-c", `hooks.state={${state.join(",")}}`);
	const [command = "", ...rest] = orrery;
	// --tool codex: the server serves ORRERY_AGENT's agent only, for this Codex (src/codex/pick.ts).
	config.push("-c", `mcp_servers.orrery=${inlineTable({ command: tomlString(command), args: tomlArray([...rest, "mcp", "--tool", "codex"].map(tomlString)), env_vars: tomlArray(MCP_ENV.map(tomlString)), default_tools_approval_mode: tomlString("approve") })}`);
	const notices: string[] = [];
	const found = readInstructions(agent.dir);
	if (found !== undefined) {
		const key = "developer_instructions=";
		const fitted = tomlStringWithin(instructionsSection(agent.name, found), CODEX_ARG_MAX - Buffer.byteLength(key));
		config.push("-c", `${key}${fitted.value}`);
		if (fitted.cut) notices.push(codexCutNotice(agent.name));
		else if (found.cut) notices.push(cutNotice(agent.name));
	}
	config.push("-c", "features.memories=false", "-c", "features.unified_exec_tty=false", "-c", "features.hooks=true");
	return { args: ["--no-daemon", ...config], config, notices };
}
