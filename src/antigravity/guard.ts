/**
 * The agent guard on the Antigravity CLI's tool calls (spec 2026-11-20-antigravity-design, "Guard"), as `orrery agy-hook
 * pre-tool-use`. agy 1.5.13 hands PreToolUse every tool call, a subagent's included (seen live), as `toolCall` {name,
 * args, id}, with `cwd` and `conversationId`. Each is judged with the rules every other gate applies, through Claude
 * Code's guard (src/claude/guard.ts), its tools mapped onto Claude Code's (AGY_AS_CLAUDE, from payloads logged live):
 * - run_command is Bash (CommandLine; its Cwd is a folder it runs in); read_file and view_file are Read; write_file and
 *   write_to_file are Write; edit_file, replace_file_content and multi_replace_file_content are Edit; list_dir is LS;
 *   find_by_name is Glob; grep_search is Grep;
 * - every other tool (MCP tools, call_mcp_tool, invoke_subagent, send_message, …) by Claude Code's heuristics: every
 *   command line and path it names, at any depth;
 * - then by content (src/codex/guard.ts contentGuard): shell text and patch text in any string but what a file tool
 *   writes.
 * agy reads the hook's answer as JSON: `{"decision": "deny", "reason": …}` blocks, `{"decision": "allow"}` lets the call
 * go on to agy's own permission rules, and `auto_approve` approves it. It blocks a hook that exits non-zero, prints
 * garbage or times out, but lets through one that prints nothing (seen live), so this guard always prints a decision,
 * and denies what it can't read or judge. Orrery's own memory tools (`mcp_orrery_*`, or call_mcp_tool naming the orrery
 * server) are approved in an agent's session, where they serve its memory.
 *
 * Whose rules: the agent ORRERY_AGENT names, with its token claimed by this agy (src/codex/pick.ts antigravityAgent),
 * both as the agy process was started with them (launchedEnv), gets its own; one started inside an agent's session gets
 * that agent's (src/agent/nested-rules.ts); one opened as an agent but refused may write only where it runs; a plain agy
 * (no ORRERY_AGENT: Orrery's hooks are global) gets Orrery's own rules (spec 2026-10-19-no-agent-sessions §3).
 */

import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import type { AgentConfig, HarnessConfig } from "../agent/config.ts";
import { GuardCall } from "../agent/guard-paths.ts";
import { nestedRules, type WriteRules } from "../agent/nested-rules.ts";
import { AGENT_ENV, workArea } from "../agent/pick.ts";
import { opensHere, type PlainDeps } from "../agent/plain-nested.ts";
import { agentGuardOptions, type ClaudeGuardOptions, claudeGuard, plainGuardOptions } from "../claude/guard.ts";
import { codexRefusal, contentGuard } from "../codex/guard.ts";
import { antigravityAgent, antigravityNested, LAUNCH_VARIABLES, launchedEnv, startEnvOf } from "../codex/pick.ts";

/** agy's tools as Claude Code's guard knows them (module doc), and the argument keys it reads under its own names. */
export const AGY_AS_CLAUDE: Readonly<Record<string, { readonly name: string; readonly keys: Readonly<Record<string, string>> }>> = {
	run_command: { name: "Bash", keys: { CommandLine: "command", Cwd: "cwd" } },
	read_file: { name: "Read", keys: { Path: "file_path" } },
	view_file: { name: "Read", keys: { AbsolutePath: "file_path" } },
	write_file: { name: "Write", keys: { Path: "file_path", Content: "content" } },
	write_to_file: { name: "Write", keys: { TargetFile: "file_path", CodeContent: "content" } },
	edit_file: { name: "Edit", keys: { Path: "file_path", Target: "old_string", Replacement: "new_string" } },
	replace_file_content: { name: "Edit", keys: { TargetFile: "file_path", TargetContent: "old_string", ReplacementContent: "new_string" } },
	multi_replace_file_content: { name: "Edit", keys: { TargetFile: "file_path" } },
	list_dir: { name: "LS", keys: { DirectoryPath: "path" } },
	find_by_name: { name: "Glob", keys: { SearchDirectory: "path", Pattern: "pattern" } },
	grep_search: { name: "Grep", keys: { SearchPath: "path", Query: "pattern" } },
};

/** Claude Code's file tools that write, and what they write (which no rule reads but the skills rule). */
const WRITERS = new Set(["Write", "Edit"]);
const WRITTEN = /^(content|old_string|new_string|ReplacementChunks)$/;

/** How long the guard may judge one call, in ms. agy kills a hook past its timeout, which blocks the call. */
const JUDGE_MS = 2000;

const CALL_UNREADABLE = "Orrery could not read this call; nothing was run.";
const OUT_OF_TIME = "this call names more than the guard can check in time; nothing was run.";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `input` with agy's argument names (`keys`) renamed to Claude Code's, so the guard judges the very value agy acts on;
 * undefined when the input also holds a key under one of the new names (a decoy the guard would judge in place of agy's
 * own argument), which refuses the call.
 */
function renamed(input: Readonly<Record<string, unknown>>, keys: Readonly<Record<string, string>>): Record<string, unknown> | undefined {
	if (Object.entries(keys).some(([from, to]) => from !== to && Object.hasOwn(input, to))) return undefined;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) out[Object.hasOwn(keys, key) ? (keys[key] as string) : key] = value;
	return out;
}

/** Why an agy tool call is refused, or undefined to let it through (module doc). */
export function agyGuard(toolName: string, input: unknown, options: ClaudeGuardOptions): string | undefined {
	if (!isObject(input)) return CALL_UNREADABLE;
	const deadline = performance.now() + Math.min(options.judgeMs ?? JUDGE_MS, JUDGE_MS);
	if (deadline <= performance.now()) return OUT_OF_TIME;
	const call = options.call ?? new GuardCall();
	const timed = (): ClaudeGuardOptions => ({ ...options, call, judgeMs: deadline - performance.now() });
	const as = Object.hasOwn(AGY_AS_CLAUDE, toolName) ? AGY_AS_CLAUDE[toolName] : undefined;
	const name = as?.name ?? toolName;
	const args = as === undefined ? { ...input } : renamed(input, as.keys);
	if (args === undefined) return CALL_UNREADABLE;
	const reason = claudeGuard(name, args, timed());
	if (reason !== undefined) return reason;
	const content = WRITERS.has(name) ? Object.fromEntries(Object.entries(args).filter(([key]) => !WRITTEN.test(key))) : args;
	return contentGuard(content, timed());
}

/** Whether a call is to Orrery's own memory tools: `mcp_orrery_<tool>`, or call_mcp_tool naming the orrery server. */
export function orreryMemoryTool(toolName: string, input: unknown): boolean {
	if (/^mcp_orrery_[a-z_]+$/.test(toolName)) return true;
	return toolName === "call_mcp_tool" && isObject(input) && input.ServerName === "orrery";
}

/** What the hook judges with: the config, agy's environment and process, and the config file in use. */
export interface AgyGuardContext {
	readonly config: HarnessConfig;
	readonly env: NodeJS.ProcessEnv;
	/** agy's process (src/antigravity/host.ts agyPid): the token's owner. */
	readonly agyPid: number;
	/** The process agyPid() started from (the hook's parent), for its proof (src/codex/pick.ts); undefined: none. */
	readonly agyParent?: number;
	/** The home folder "~" means (default: the OS's); tests set it. */
	readonly home?: string;
	/** The file the config came from (GuardOptions.configFile). */
	readonly configFile?: string;
	readonly alive?: (pid: number) => boolean;
	readonly plain?: PlainDeps;
	/** Named variables of the environment a process was started with (default startEnvOf). */
	readonly envOf?: (pid: number, names: readonly string[]) => Readonly<Record<string, string>> | undefined;
}

/** A session's rules: Orrery's own, for a session that is no agent's, or where it may write and its agent. */
type SessionRules = { readonly plain: true } | { readonly plain: false; readonly rules: WriteRules; readonly agent?: AgentConfig };

/** Whose rules a call of conversation `session` in `cwd` is judged by (module doc). */
function sessionRules(ctx: AgyGuardContext, cwd: string, session: string | undefined): SessionRules {
	const { config, env } = ctx;
	const noAgent = (): SessionRules => ((env[AGENT_ENV]?.trim() ?? "") === "" ? { plain: true } : { plain: false, rules: { workArea: workArea({}, cwd), allowedRoots: [] } });
	const launched = launchedEnv("antigravity", env, (ctx.envOf ?? startEnvOf)(ctx.agyPid, LAUNCH_VARIABLES));
	if ("refused" in launched) return noAgent();
	const own = launched.env;
	if ((own[AGENT_ENV]?.trim() ?? "") === "") {
		// A plain agy: started inside a session, it gets that session's rules; else Orrery's own.
		const nested = antigravityNested(config, own, ctx.agyPid, ctx.plain);
		if (nested?.kind === "nested") {
			const outer = nestedRules(config, nested.outer, cwd);
			if (outer !== undefined) return { plain: false, rules: outer };
			if (nested.plain !== undefined && !opensHere(config, own, cwd)) return { plain: true };
			return { plain: false, rules: { workArea: workArea({}, cwd), allowedRoots: [] } };
		}
		return { plain: true };
	}
	const pick = antigravityAgent(config, {
		env: own,
		pid: ctx.agyPid,
		takeover: false,
		...(ctx.agyParent === undefined ? {} : { parent: ctx.agyParent }),
		...(session === undefined ? {} : { session }),
		...(ctx.alive === undefined ? {} : { alive: ctx.alive }),
		...(ctx.plain === undefined ? {} : { plain: ctx.plain }),
	});
	if (pick.kind === "agent") return { plain: false, rules: { workArea: workArea(pick.agent, cwd), allowedRoots: pick.agent.allowedRoots }, agent: pick.agent };
	const nested = pick.kind === "nested" ? pick : pick.undecided === true ? antigravityNested(config, own, ctx.agyPid, ctx.plain) : undefined;
	if (nested?.kind === "nested") {
		const outer = nestedRules(config, nested.outer, cwd);
		if (outer !== undefined) return { plain: false, rules: outer };
		if (nested.plain !== undefined && !opensHere(config, own, cwd)) return { plain: true };
		return { plain: false, rules: { workArea: workArea({}, cwd), allowedRoots: [] } };
	}
	return noAgent();
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A refusal's reason as agy shows it to the model: "Orrery guard: …", on one line. */
export function agyRefusal(reason: string): string {
	return codexRefusal(reason.replace(/\s*[\r\n]+\s*/g, " "));
}

/** agy's answer: a decision, always (module doc). */
const decision = (value: "allow" | "auto_approve" | "deny", reason?: string) => JSON.stringify({ decision: value, ...(reason === undefined ? {} : { reason }) });

/**
 * The hook's answer to the call in `stdin` (agy's PreToolUse input; undefined when it held more than the hook reads):
 * deny with Orrery's reason, auto_approve for Orrery's own memory tools in an agent's session, else allow. What it
 * cannot read or judge, a failure included, is denied.
 */
export function runAgyGuard(stdin: string | undefined, ctx: AgyGuardContext): string {
	try {
		if (stdin === undefined) return decision("deny", agyRefusal("this call's input is too large for Orrery's guard to check (over 1 MB); nothing was run."));
		const by = performance.now() + JUDGE_MS;
		let parsed: unknown;
		try {
			parsed = JSON.parse(stdin) as unknown;
		} catch {
			// Never the parser's message: it quotes the input.
			return decision("deny", agyRefusal(CALL_UNREADABLE));
		}
		if (!isObject(parsed) || !isObject(parsed.toolCall)) return decision("deny", agyRefusal(CALL_UNREADABLE));
		const { name, args } = parsed.toolCall;
		const cwd = parsed.cwd;
		if (typeof name !== "string" || typeof cwd !== "string" || !isAbsolute(cwd)) return decision("deny", agyRefusal(CALL_UNREADABLE));
		const session = typeof parsed.conversationId === "string" ? parsed.conversationId : undefined;
		const rules = sessionRules(ctx, cwd, session);
		const home = ctx.home ?? homedir();
		const options = rules.plain ? plainGuardOptions(ctx.config, ctx.env, home, cwd, cwd, ctx.configFile) : agentGuardOptions(ctx.config, ctx.env, home, cwd, rules.rules, rules.agent, ctx.configFile);
		const reason = agyGuard(name, args ?? {}, { ...options, judgeMs: by - performance.now() });
		if (reason !== undefined) return decision("deny", agyRefusal(reason));
		return decision(!rules.plain && rules.agent !== undefined && orreryMemoryTool(name, args) ? "auto_approve" : "allow");
	} catch (error) {
		return decision("deny", agyRefusal(`this call could not be checked (${errorText(error)}); nothing was run.`));
	}
}
