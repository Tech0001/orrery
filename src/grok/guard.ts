/**
 * The agent guard on Grok Build's tool calls (spec 2026-10-29-grok-build-design, "Guard"), as `orrery grok-hook
 * pre-tool-use`. Grok 1.0.70 hands PreToolUse every tool call a model makes, a subagent's and a workflow's agents'
 * included (seen live), as `toolName`, `toolInput` and `toolInputTruncated` (with Claude Code's snake_case aliases): its
 * own tools by their names, and an MCP call by its qualified `<server>__<tool>` name with `use_tool`'s envelope as its
 * input (`{tool_name, tool_input}`, the arguments loaded when the model gave them in a file; seen live). The guard judges
 * each with the rules every other gate applies (src/agent/guard-rules.ts, guard-paths.ts), through Claude Code's guard
 * (src/claude/guard.ts), its tools mapped onto Claude Code's (GROK_AS_CLAUDE):
 * - run_terminal_command and monitor are Bash (their command line); read_file, hashline_read and view_image are Read;
 *   search_replace and hashline_edit are Edit (by name: "replace" is no verb the write heuristic reads); write is
 *   Write; grep, hashline_grep and the codex toolset's grep_files are Grep; list_dir is LS; the codex toolset's
 *   apply_patch is Codex's (src/codex/guard.ts), its targets writes; the Cursor preset's Shell, StrReplace,
 *   EditNotebook and List are Bash, Edit, Edit and LS;
 * - every other tool, MCP tools among them, by Claude Code's heuristics: every command line and every path or file: URI
 *   it names, at any depth, as a write for a tool named for writing, else as a read; a `cwd` or `workdir` (a shell's,
 *   spawn_subagent's) is a folder it reads. spawn_subagent's prompt is words for a subagent, whose own calls come here;
 *   a workflow's script runs agents whose calls come here, and has no host call of its own that reaches a file or a
 *   shell but its own run's scratch files and `git_diff_since`, which takes a commit hash only (both seen live);
 * - then by content, in any tool (src/codex/guard.ts contentGuard): shell text under input or code, apply_patch run
 *   from a shell, patch text in any string, but what Grok's own file tools write;
 * - a call whose arguments are in a file the guard doesn't see (use_tool's tool_input_file or file, not loaded), and an
 *   input that is no JSON object, are refused.
 * Grok cuts a tool input whose JSON passes 128 KiB, string by string, past a shared length of at least 4 KiB, and says
 * so with toolInputTruncated (its manual, 10-hooks.md "Input"). A cut string hides its end, so with toolInputTruncated
 * anything but false, a string past 4 KiB is taken as cut: one a rule reads (a command line, a patch, a path, a
 * prompt, any MCP argument) refuses the call; what Grok's own file tools write (content, old_string, new_string) is no
 * rule's, so it goes through, but the skills rule then sees no text (src/agent/guard-rules.ts openCodeSkillRefusal).
 *
 * Whose rules (runGrokGuard): the agent ORRERY_AGENT names, with its token claimed by this Grok (src/codex/pick.ts
 * grokAgent), gets its own: where it may write (its folder, or the folder it was opened in, and its allowed roots) and
 * every other agent's view another's. A Grok started inside an agent's session gets that agent's rules, never looser
 * than the folder's own (src/agent/nested-rules.ts); one opened as an agent but refused, or started inside a session
 * nothing proves the agent of, may write only where it runs. A plain grok (no ORRERY_AGENT: Orrery's Grok hooks are
 * global), and one started from a coding tool's session that is no agent's where no agent would open, get Orrery's own
 * rules (spec 2026-10-19-no-agent-sessions §3): every agent's memory and Orrery's settings and data, Grok's folder and
 * the session records. So does every session of Grok's shared leader (leader mode: src/grok/host.ts), which runs every
 * session's hooks with its first client's environment, so no session there can be told to be an agent's or not.
 * Limits, as Grok gives them: a hook that crashes or times out lets the call through (only an explicit deny or exit 2
 * blocks), so the guard answers within its own time and src/codex/guard-exit.ts refuses a crash or a stall; `!` bash
 * mode commands are the person's own and raise no hook; and the shell-text limits every gate has.
 */

import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import type { AgentConfig, HarnessConfig } from "../agent/config.ts";
import { GuardCall } from "../agent/guard-paths.ts";
import { NEW_TEXT } from "../agent/guard-rules.ts";
import { nestedRules, type WriteRules } from "../agent/nested-rules.ts";
import { AGENT_ENV, workArea } from "../agent/pick.ts";
import { opensHere, type PlainDeps } from "../agent/plain-nested.ts";
import { agentGuardOptions, type ClaudeGuardOptions, claudeGuard, plainGuardOptions } from "../claude/guard.ts";
import { TOOL_INPUT_MAX } from "../claude/hooks.ts";
import { codexGuard, codexRefusal, contentGuard } from "../codex/guard.ts";
import { grokAgent, grokNested } from "../codex/pick.ts";
import { grokHostRefusal } from "./host.ts";

/**
 * Grok's tools as Claude Code's guard knows them (module doc), and the input keys it reads under another name: Grok
 * 1.0.70's own toolset, its hashline toolset and the codex toolset it carries.
 */
export const GROK_AS_CLAUDE: Readonly<Record<string, { readonly name: string; readonly keys?: Readonly<Record<string, string>> }>> = {
	run_terminal_command: { name: "Bash" },
	monitor: { name: "Bash" },
	read_file: { name: "Read", keys: { target_file: "file_path" } },
	hashline_read: { name: "Read", keys: { target_file: "file_path" } },
	view_image: { name: "Read" },
	search_replace: { name: "Edit" },
	hashline_edit: { name: "Edit", keys: { target_file: "file_path" } },
	write: { name: "Write" },
	grep: { name: "Grep" },
	hashline_grep: { name: "Grep" },
	grep_files: { name: "Grep", keys: { include: "glob" } },
	list_dir: { name: "LS", keys: { target_directory: "path", dir_path: "path" } },
	apply_patch: { name: "apply_patch", keys: { input: "command", patch: "command" } },
	// The Cursor preset's tools, with their own input keys (manual, 10-hooks.md "Tool Name Aliases"): StrReplace and Write
	// name the file in `path`; Write, Read and Grep are Claude Code's names already.
	Shell: { name: "Bash" },
	StrReplace: { name: "Edit" },
	EditNotebook: { name: "Edit", keys: { target_notebook: "notebook_path" } },
	List: { name: "LS" },
};

/** Claude Code's file tools that write, and what they write (which no rule reads but the skills rule). */
const WRITERS = new Set(["Write", "Edit"]);
const WRITTEN = /^(content|old_string|new_string|new_source)$/;

/** How long the guard may judge one call, in ms, at most (GrokGuardContext.deadline may leave it less). */
const JUDGE_MS = 2000;

/** The longest string Grok never cuts (its manual: "A string of 4 KiB or less is never cut"), in UTF-8 bytes. */
const WHOLE_MAX = 4 * 1024;

/** The longest hook input the guard reads (1 MB, as Claude Code's and Codex's): a longer one is refused unread. */
export const GROK_TOOL_INPUT_MAX = TOOL_INPUT_MAX;

const CALL_UNREADABLE = "Orrery could not read this call; nothing was run.";
const OUT_OF_TIME = "this call names more than the guard can check in time; nothing was run.";
const CUT = (key: string) => `this call's input is over 128 KiB, so Grok cut its ${key} short, and Orrery's guard can't check what was cut; nothing was run.`;
const FILE_ARGUMENTS = "this call's arguments are in a file Orrery's guard doesn't see; nothing was run. Give them inline (tool_input).";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** `input` with `keys` renamed (a key already there under the new name keeps its value). */
function renamed(input: Readonly<Record<string, unknown>>, keys: Readonly<Record<string, string>> | undefined): Record<string, unknown> {
	if (keys === undefined) return { ...input };
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		const to = keys[key];
		if (to === undefined) out[key] = value;
		else if (!(to in input) && !(to in out)) out[to] = value;
		else out[key] = value;
	}
	return out;
}

/**
 * In an input Grok cut (module doc), the key of the first string a rule reads that may be cut (none when there is none),
 * and whether what a file tool writes may be cut (`written`). `writer`: a file tool's input, whose written text (WRITTEN,
 * at its top) no rule reads but the skills rule.
 */
function cutString(input: Readonly<Record<string, unknown>>, writer: boolean): { readonly key?: string; readonly written: boolean } {
	let written = false;
	const stack: { key: string; value: unknown; top: boolean }[] = Object.entries(input).map(([key, value]) => ({ key, value, top: true }));
	for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
		const { key, value } = next;
		if (typeof value === "string") {
			if (Buffer.byteLength(value) <= WHOLE_MAX) continue;
			if (writer && next.top && WRITTEN.test(key)) written = true;
			else return { key, written };
		} else if (typeof value === "object" && value !== null) {
			for (const [inner, item] of Object.entries(value)) stack.push({ key: Array.isArray(value) ? key : inner, value: item, top: false });
		}
	}
	return { written };
}

/** `input` without what a file tool writes (WRITTEN), for the content rules: a file's text is no command or patch. */
function withoutWritten(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(input).filter(([key]) => !WRITTEN.test(key)));
}

/**
 * Why a Grok tool call is refused, or undefined to let it through (module doc). `truncated`: Grok may have cut the
 * input's strings (toolInputTruncated anything but false). Every check shares the call's time (`judgeMs`, default 2 s).
 */
export function grokGuard(toolName: string, input: unknown, options: ClaudeGuardOptions, truncated: boolean): string | undefined {
	if (!isObject(input)) return CALL_UNREADABLE;
	const deadline = performance.now() + Math.min(options.judgeMs ?? JUDGE_MS, JUDGE_MS);
	if (deadline <= performance.now()) return OUT_OF_TIME;
	const call = options.call ?? new GuardCall();
	const timed = (): ClaudeGuardOptions => ({ ...options, call, judgeMs: deadline - performance.now() });
	// use_tool's envelope: the tool it calls, and its arguments, loaded. Arguments still in a file are unseen.
	const mcp = toolName === "use_tool" || toolName.includes("__");
	const name = toolName === "use_tool" && typeof input.tool_name === "string" ? input.tool_name : toolName;
	if (mcp && !isObject(input.tool_input) && ("tool_input_file" in input || "file" in input)) return FILE_ARGUMENTS;
	const as = Object.hasOwn(GROK_AS_CLAUDE, name) ? GROK_AS_CLAUDE[name] : undefined;
	const claudeName = as?.name ?? name;
	const writer = WRITERS.has(claudeName);
	let args = renamed(input, as?.keys);
	if (truncated) {
		const cut = cutString(args, writer);
		if (cut.key !== undefined) return CUT(cut.key);
		// What a write puts in its file may be cut: the skills rule sees none of it.
		if (cut.written) args = { ...args, [NEW_TEXT]: undefined };
	}
	if (claudeName === "apply_patch") return codexGuard("apply_patch", args, timed());
	const reason = claudeGuard(claudeName, args, timed());
	if (reason !== undefined) return reason;
	return contentGuard(writer ? withoutWritten(args) : args, timed());
}

/** What the hook judges with: the config, Grok's environment and process, and the config file in use. */
export interface GrokGuardContext {
	readonly config: HarnessConfig;
	readonly env: NodeJS.ProcessEnv;
	/** Grok's process (src/grok/host.ts grokPid): the token's owner. */
	readonly grokPid: number;
	/** The process grokPid() started from (the hook's parent), for its proof (src/codex/pick.ts); undefined: none. */
	readonly grokParent?: number;
	/** The home folder "~" means (default: the OS's); tests set it. */
	readonly home?: string;
	/** The file the config came from: kept read-only and named in no command (GuardOptions.configFile). */
	readonly configFile?: string;
	/** Whether a pid lives, for the token's claim (default processAlive); tests pass their own. */
	readonly alive?: (pid: number) => boolean;
	/**
	 * When the judgment must be done, as performance.now() reads it (the hook passes CODEX_GUARD_DEADLINE_MS, which counts
	 * from the process's start, src/codex/guard-exit.ts); default JUDGE_MS from now. The guard has at most JUDGE_MS.
	 */
	readonly deadline?: number;
	/** How a coding tool's session that is no agent's is looked for (src/agent/plain-nested.ts); tests pass their own. */
	readonly plain?: PlainDeps;
	/** A process's command line (default processArgv): whether grokPid is Grok's shared leader (src/grok/host.ts). */
	readonly argvOf?: (pid: number) => readonly string[] | undefined;
}

/** The fields of Grok's PreToolUse input the guard reads (camelCase, else Claude Code's aliases); each is checked before use. */
interface ToolCall {
	readonly sessionId?: unknown;
	readonly session_id?: unknown;
	readonly cwd?: unknown;
	readonly toolName?: unknown;
	readonly tool_name?: unknown;
	readonly toolInput?: unknown;
	readonly tool_input?: unknown;
	readonly toolInputTruncated?: unknown;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * A refusal as Grok shows it: Codex's ("Orrery guard: " first, no final period: src/codex/guard.ts codexRefusal), on one
 * line, since Grok takes the first line of the hook's stderr as the reason.
 */
export function grokRefusal(reason: string): string {
	return codexRefusal(reason.replace(/\s*[\r\n]+\s*/g, " "));
}

/**
 * The hook's refusal of the call in `stdin` (Grok's PreToolUse input, or undefined when it held more than
 * GROK_TOOL_INPUT_MAX), ready for Grok (grokRefusal), or undefined to let it through. What it cannot read or judge, a
 * failure included, is refused: a hook that fails lets the call through.
 */
export function runGrokGuard(stdin: string | undefined, ctx: GrokGuardContext): string | undefined {
	let reason: string | undefined;
	try {
		reason = judgeCall(stdin, ctx);
	} catch (error) {
		reason = `this call could not be checked (${errorText(error)}); nothing was run.`;
	}
	return reason === undefined ? undefined : grokRefusal(reason);
}

/** A session's rules (module doc): Orrery's own, for a session that is no agent's, or where it may write and its agent. */
type SessionRules = { readonly plain: true } | { readonly plain: false; readonly rules: WriteRules; readonly agent?: AgentConfig };

/** Whose rules a call of `session` in `cwd` is judged by (module doc). */
function sessionRules(ctx: GrokGuardContext, cwd: string, session: string | undefined): SessionRules {
	// Grok's shared leader: no session there can be told to be an agent's, or no agent's.
	if (grokHostRefusal(ctx.grokPid, ctx.argvOf) !== undefined) return { plain: true };
	const { config, env } = ctx;
	const pick = grokAgent(config, {
		env,
		pid: ctx.grokPid,
		takeover: false,
		...(ctx.grokParent === undefined ? {} : { parent: ctx.grokParent }),
		...(session === undefined ? {} : { session }),
		...(ctx.alive === undefined ? {} : { alive: ctx.alive }),
		...(ctx.plain === undefined ? {} : { plain: ctx.plain }),
	});
	if (pick.kind === "agent") return { plain: false, rules: { workArea: workArea(pick.agent, cwd), allowedRoots: pick.agent.allowedRoots }, agent: pick.agent };
	// A Grok whose SessionStart made no decision (a plain grok's decides nothing) is looked up now: was it started inside
	// a session?
	const nested = pick.kind === "nested" ? pick : pick.undecided === true ? grokNested(config, env, ctx.grokPid, ctx.plain) : undefined;
	if (nested?.kind === "nested") {
		const outer = nestedRules(config, nested.outer, cwd);
		if (outer !== undefined) return { plain: false, rules: outer };
		// Started from a coding tool's session that is no agent's, where no agent would open: a plain one.
		if (nested.plain !== undefined && !opensHere(config, env, cwd)) return { plain: true };
		return { plain: false, rules: { workArea: workArea({}, cwd), allowedRoots: [] } };
	}
	// A plain grok: Orrery's own rules. One opened as an agent but refused: no agent's, only where it runs.
	if ((env[AGENT_ENV]?.trim() ?? "") === "") return { plain: true };
	return { plain: false, rules: { workArea: workArea({}, cwd), allowedRoots: [] } };
}

function judgeCall(stdin: string | undefined, ctx: GrokGuardContext): string | undefined {
	if (stdin === undefined) return "this call's input is too large for Orrery's guard to check (over 1 MB); nothing was run.";
	// Done by the context's deadline, and within JUDGE_MS of now.
	const by = Math.min(performance.now() + JUDGE_MS, ctx.deadline ?? Number.POSITIVE_INFINITY);
	if (by <= performance.now()) return OUT_OF_TIME;
	let call: ToolCall;
	try {
		const parsed = JSON.parse(stdin) as unknown;
		if (!isObject(parsed)) return CALL_UNREADABLE;
		call = parsed as ToolCall;
	} catch {
		// Never the parser's message: it quotes the input.
		return CALL_UNREADABLE;
	}
	const toolName = call.toolName ?? call.tool_name;
	const input = "toolInput" in call ? call.toolInput : call.tool_input;
	if (typeof toolName !== "string" || typeof call.cwd !== "string" || !isAbsolute(call.cwd)) return CALL_UNREADABLE;
	const id = call.sessionId ?? call.session_id;
	const rules = sessionRules(ctx, call.cwd, typeof id === "string" ? id : undefined);
	const home = ctx.home ?? homedir();
	const options = rules.plain
		? plainGuardOptions(ctx.config, ctx.env, home, call.cwd, call.cwd, ctx.configFile)
		: agentGuardOptions(ctx.config, ctx.env, home, call.cwd, rules.rules, rules.agent, ctx.configFile);
	return grokGuard(toolName, input, { ...options, judgeMs: by - performance.now() }, call.toolInputTruncated !== false);
}
