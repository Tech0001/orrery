/**
 * The agent guard on Codex's tool calls (spec 2026-10-16-codex-design, "Guard"), as `orrery codex-hook pre-tool-use`.
 * Codex 0.162.1 hands its PreToolUse hook every tool call a model makes, a code cell's calls each on their own (the cell
 * itself never arrives), its subagents' too, and the guard judges each with the rules every other gate applies
 * (src/agent/guard-rules.ts, guard-paths.ts), mapped through Claude Code's guard (src/claude/guard.ts):
 * - `Bash` (exec_command; its input is only `{command}`) is judged by its command, as every gate judges shell text;
 * - `apply_patch` (its input is the whole patch as `{command}`) writes every `*** Add File:`, `*** Update File:`,
 *   `*** Delete File:` and `*** Move to:` target, read as Codex's parser reads them (readPatch) and resolved as Codex
 *   joins them onto its cwd (codexToolPath); what a patch writes is never judged; a patch the guard cannot read is
 *   refused, and so is one for another environment;
 * - `view_image` reads its path, resolved as Codex resolves it;
 * - everything else, MCP tools (`mcp__<server>__<tool>`) and `spawn_agent` among them, by Claude Code's heuristics:
 *   every command line and every path or file: URI it names. spawn_agent's message is words for the new agent, which
 *   runs its own tools through this hook; a file its input hands that agent (an image, a skill) is a read;
 * - an input that is no JSON object is refused.
 * The session's agent is the one ORRERY_AGENT names, with its token claimed by this Codex (src/codex/pick.ts): its
 * folder (or the folder Codex runs in, outside it) and allowed roots. Orrery's hooks come only with Orrery's launch, so
 * a session that is not the agent's (a token another process holds, none at all) keeps the guard with no agent's rules:
 * it may write only where it runs, and every agent's view is another's.
 * Limits, as Codex gives them: exec_command's `workdir` never reaches the hook, so a relative name in a command is judged
 * from the session's folder (name rules hold, path rules can be sidestepped); `write_stdin` into a running command is
 * never judged (the launch turns its terminal off); hosted web_search is no tool call here; and a hook that crashes or
 * times out lets the call through, so the guard answers in its own time budget and refuses what it cannot judge.
 */

import { homedir } from "node:os";
import { isAbsolute, normalize, resolve } from "node:path";
import type { HarnessConfig } from "../agent/config.ts";
import { agentViews, movedAgentDirCredentials, ompCredentials, RUST_SPACE } from "../agent/guard-paths.ts";
import { workArea } from "../agent/pick.ts";
import { type ClaudeGuardOptions, claudeGuard, movedConfigDirCredentials } from "../claude/guard.ts";
import { TOOL_INPUT_MAX } from "../claude/hooks.ts";
import { codexAgent } from "./pick.ts";

/** How long the guard may judge one call, in ms: a patch that names more than this allows is refused. */
const JUDGE_MS = 2000;

/** The longest hook input the guard reads (1 MB, as Claude Code's): a longer one is refused unread. */
export const CODEX_TOOL_INPUT_MAX = TOOL_INPUT_MAX;

/**
 * Mirrors how Codex 0.162.1 places a path its apply_patch and view_image name (codex-rs utils/path-uri PathUri::join):
 * an absolute path as it is, normalized; any other joined onto the cwd, "." and ".." taken as they stand. Nothing is
 * trimmed and "~" is a name like any other.
 */
export function codexToolPath(raw: string, cwd: string): string {
	return isAbsolute(raw) ? normalize(raw) : resolve(cwd, raw);
}

const RUST_TRIM = new RegExp(`^[${RUST_SPACE}]+|[${RUST_SPACE}]+$`, "g");
const RUST_TRIM_END = new RegExp(`[${RUST_SPACE}]+$`);
const rustTrim = (text: string) => text.replace(RUST_TRIM, "");

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const HEADERS = ["*** Add File: ", "*** Delete File: ", "*** Update File: "] as const;
const MOVE_TO = "*** Move to: ";
const ENVIRONMENT = "*** Environment ID:";
const HEREDOC_OPENERS = new Set(["<<EOF", "<<'EOF'", '<<"EOF"']);

/**
 * A patch's targets as Codex 0.162.1's apply_patch parser reads them (codex-rs apply-patch parser.rs and
 * streaming_parser.rs; lenient mode, which it always uses): the text trimmed and split into lines, each without one
 * "\r"; framed by "*** Begin Patch" and "*** End Patch" (trimmed), or by a heredoc's `<<'EOF'` … `EOF` around them; a
 * hunk header is read from the line trimmed (Rust's trim: U+0085 too) outside an update hunk, and only at its first
 * column inside one, as is `*** Move to:`; the path is all that follows the marker's one space.
 * Unreadable: whatever Codex would not apply, and a patch that picks another environment (its paths are not here).
 */
export function readPatch(text: string): { readonly targets: string[] } | { readonly unreadable: string } {
	let lines = rustTrim(text)
		.split("\n")
		.map((line) => line.replace(/\r$/, ""));
	const framed = (inner: readonly string[]) => inner.length > 0 && rustTrim(inner[0] as string) === BEGIN && rustTrim(inner.at(-1) as string) === END;
	if (!framed(lines)) {
		const inner = lines.slice(1, -1);
		if (!(lines.length >= 4 && HEREDOC_OPENERS.has(lines[0] as string) && (lines.at(-1) as string).endsWith("EOF") && framed(inner))) {
			return { unreadable: "it is not framed by *** Begin Patch and *** End Patch" };
		}
		lines = inner;
	}
	const targets: string[] = [];
	let mode: "start" | "add" | "delete" | "update" | "ended" = "start";
	const body = lines.slice(1);
	for (const [at, raw] of body.entries()) {
		const line = raw.replace(/\r$/, "");
		const trimmed = rustTrim(line);
		if (mode === "ended") {
			if (trimmed !== "") return { unreadable: "it goes on after *** End Patch" };
			continue;
		}
		// A header: the trimmed line, but inside an update hunk only a line that starts at its first column. The last line
		// ends the patch trimmed in any hunk (Codex reads it apart, in its parser's finish).
		const header: string = mode === "update" ? line.replace(RUST_TRIM_END, "") : trimmed;
		if (mode === "start" && header.startsWith(ENVIRONMENT)) return { unreadable: "it picks another environment, whose files the guard cannot see" };
		if (header === END || (at === body.length - 1 && trimmed === END)) {
			mode = "ended";
			continue;
		}
		const marker: string | undefined = HEADERS.find((prefix) => header.startsWith(prefix));
		if (marker !== undefined) {
			targets.push(header.slice(marker.length));
			mode = marker === HEADERS[0] ? "add" : marker === HEADERS[1] ? "delete" : "update";
			continue;
		}
		// Codex moves only on a `*** Move to:` right after the header, and refuses the patch for one anywhere else in the
		// hunk; every such line counts here (no content line starts at the first column with "*").
		if (mode === "update") {
			if (header.startsWith(MOVE_TO)) targets.push(header.slice(MOVE_TO.length));
			continue;
		}
		if (mode === "add" && line.startsWith("+")) continue;
		return { unreadable: `a line is neither a hunk header nor what its hunk takes` };
	}
	if (mode !== "ended") return { unreadable: "it does not end with *** End Patch" };
	return { targets };
}

const CALL_UNREADABLE = "Orrery could not read this call; nothing was run.";
const PATCH_UNREADABLE = (why: string) => `Orrery could not read this patch (${why}); nothing was changed.`;

/** Why a Codex tool call is refused, or undefined to let it through (module doc). */
export function codexGuard(toolName: string, input: unknown, options: ClaudeGuardOptions): string | undefined {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return CALL_UNREADABLE;
	const args = input as Readonly<Record<string, unknown>>;
	const asCodex: ClaudeGuardOptions = { ...options, resolvePath: (raw, cwd) => codexToolPath(raw, cwd) };
	if (toolName === "apply_patch") {
		if (typeof args.command !== "string") return PATCH_UNREADABLE("it is no text");
		const read = readPatch(args.command);
		if ("unreadable" in read) return PATCH_UNREADABLE(read.unreadable);
		const deadline = performance.now() + (options.judgeMs ?? JUDGE_MS);
		for (const target of new Set(read.targets)) {
			const left = deadline - performance.now();
			if (left <= 0) return "this patch names more files than the guard can check in time; nothing was changed.";
			const reason = claudeGuard("Write", { file_path: target }, { ...asCodex, judgeMs: left });
			if (reason !== undefined) return reason;
		}
		return undefined;
	}
	if (toolName === "view_image") return claudeGuard("view_image", args, asCodex);
	return claudeGuard(toolName, args, options);
}

/** A refusal as Codex shows it: "Orrery guard: " first, and no final period, since Codex adds its own. */
export function codexRefusal(reason: string): string {
	return `Orrery guard: ${reason.replace(/\.+$/, "")}`;
}

/** What the hook judges with: the config, Codex's environment and process, and the config file in use. */
export interface CodexGuardContext {
	readonly config: HarnessConfig;
	readonly env: NodeJS.ProcessEnv;
	/** Codex's process (src/codex/host.ts): the token's owner. */
	readonly codexPid: number;
	/** The home folder "~" means (default: the OS's); tests set it. */
	readonly home?: string;
	/** The file the config came from: kept read-only and named in no command (GuardOptions.configFile). */
	readonly configFile?: string;
	/** Whether a pid lives, for the token's claim (default processAlive); tests pass their own. */
	readonly alive?: (pid: number) => boolean;
}

/** The fields of Codex's PreToolUse input the guard reads; each is checked before use. */
interface ToolCall {
	readonly cwd?: unknown;
	readonly tool_name?: unknown;
	readonly tool_input?: unknown;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The hook's refusal of the call in `stdin` (Codex's PreToolUse input, or undefined when it held more than
 * CODEX_TOOL_INPUT_MAX), ready for Codex (codexRefusal), or undefined to let it through. What it cannot read or judge,
 * a failure included, is refused: a hook that fails lets the call through.
 */
export function runCodexGuard(stdin: string | undefined, ctx: CodexGuardContext): string | undefined {
	let reason: string | undefined;
	try {
		reason = judgeCall(stdin, ctx);
	} catch (error) {
		reason = `this call could not be checked (${errorText(error)}); nothing was run.`;
	}
	return reason === undefined ? undefined : codexRefusal(reason);
}

function judgeCall(stdin: string | undefined, ctx: CodexGuardContext): string | undefined {
	if (stdin === undefined) return "this call's input is over 1 MB, too long to check; nothing was run.";
	let call: ToolCall;
	try {
		const parsed = JSON.parse(stdin) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return CALL_UNREADABLE;
		call = parsed as ToolCall;
	} catch {
		// Never the parser's message: it quotes the input.
		return CALL_UNREADABLE;
	}
	if (typeof call.tool_name !== "string" || typeof call.cwd !== "string" || !isAbsolute(call.cwd)) return CALL_UNREADABLE;
	const { config, env } = ctx;
	const pick = codexAgent(config, { env, pid: ctx.codexPid, takeover: false, ...(ctx.alive === undefined ? {} : { alive: ctx.alive }) });
	const agent = pick.kind === "agent" ? pick.agent : undefined;
	const home = ctx.home ?? homedir();
	return codexGuard(call.tool_name, call.tool_input, {
		folder: workArea(agent ?? {}, call.cwd),
		allowedRoots: agent?.allowedRoots ?? [],
		cwd: call.cwd,
		credentials: [config.credentialsPath, ...movedAgentDirCredentials(env, home), ...movedConfigDirCredentials(env), ...ompCredentials(env, home)],
		orreryData: config.dataDir,
		home,
		protect: config.guard.protect,
		...agentViews(config, agent),
		...(ctx.configFile === undefined ? {} : { configFile: ctx.configFile }),
	});
}
