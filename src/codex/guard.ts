/**
 * The agent guard on Codex's tool calls (spec 2026-10-16-codex-design, "Guard"), as `orrery codex-hook pre-tool-use`.
 * Codex 0.162.1 hands its PreToolUse hook every tool call a model makes, a code cell's calls each on their own (the cell
 * itself never arrives), its subagents' too: exec_command as `Bash` with `{command}`, apply_patch with the whole patch as
 * `{command}`, MCP tools as `mcp__<server>__<tool>` with their arguments, and every other function tool by its name with
 * its JSON arguments (view_image, spawn_agent and the other agent tools, update_plan, request_permissions, the MCP
 * resource tools…); write_stdin and code mode's cells give it nothing. The guard judges each with the rules every other
 * gate applies (src/agent/guard-rules.ts, guard-paths.ts), mapped through Claude Code's guard (src/claude/guard.ts),
 * first by what the tool is, then by what the call carries, whatever the tool is named:
 * - apply_patch writes every `*** Add File:`, `*** Update File:`, `*** Delete File:` and `*** Move to:` target, read as
 *   Codex's parser reads them (readPatch, checked against the installed Codex) and placed as Codex places them
 *   (codexToolPath: joined onto the session's cwd, which is Codex's for this tool; ".." taken lexically, as Codex does;
 *   "~" a name, not home; links followed by realTarget; names matched in any case); what a patch writes is never judged;
 *   a patch the guard cannot read is refused, and so is one for another environment;
 * - view_image reads its path, placed as Codex places it;
 * - every tool, Bash and MCP tools among them, by Claude Code's heuristics: every command line (command, cmd, script,
 *   shell, args, argv) and every path or file: URI it names. spawn_agent's message is words for the new agent, which
 *   runs its own tools through this hook; a file its input hands that agent (an image, a skill) is a read;
 * - by content (byContent), in any tool: a string under input or code is shell text too; a command line that names
 *   apply_patch as a word (Codex applies `apply_patch <<'EOF'` itself, and puts the program on the shell's PATH, so any
 *   form runs) must be one of the forms the guard reads (shellPatch: Codex's own heredoc, with a `cd <dir> &&` before it
 *   or not and nothing after it; or one single-quoted argument; or ["apply_patch", patch] as a list), each target a write,
 *   a relative one judged from the cwd and the cd's folder (patchBases), and any other command that names it is refused
 *   (a patch from a file or a pipe, a second command, a heredoc that ends early, a path the shell could change, a cd the
 *   guard cannot place, and a command that only mentions it, `grep apply_patch`); and patch text in any string is read
 *   (patchText) and each target judged as a write, a patch that does not read or a hunk header outside one refused;
 * - an input that is no JSON object is refused, and so are an input over 1 MB and a command line over 64 KB, unread,
 *   and a call the guard cannot judge in its time (2 s at most, shared by all its checks, and done by
 *   CODEX_GUARD_DEADLINE_MS after the hook started; src/codex/guard-exit.ts refuses a crash or a stall).
 * The session's agent is the one ORRERY_AGENT names, with its token claimed by this Codex (src/codex/pick.ts): its
 * folder (or the folder Codex runs in, outside it) and allowed roots. Orrery's hooks come only with Orrery's launch, so
 * a session that is not the agent's (a token another process holds, none at all) keeps the guard with no agent's rules:
 * it may write only where it runs, and every agent's view is another's.
 * Limits, as Codex gives them: exec_command's `workdir` never reaches the hook, so a relative name in a command, and a
 * relative target of a patch a command carries, is judged from the session's folder and the command's cds (name rules
 * hold, path rules can be sidestepped; refusing every relative target would refuse ordinary patches); `write_stdin` into
 * a running command is never judged (the launch turns its terminal off); hosted web_search is no tool call here; and a
 * hook that crashes or times out lets the call through, so the guard answers in its own time budget and refuses what it
 * cannot judge.
 */

import { homedir } from "node:os";
import { isAbsolute, normalize, resolve } from "node:path";
import type { HarnessConfig } from "../agent/config.ts";
import { agentViews, movedAgentDirCredentials, ompCredentials, RUST_SPACE } from "../agent/guard-paths.ts";
import { inAnyReading, NEW_TEXT, patchNewText, shellWord } from "../agent/guard-rules.ts";
import { workArea } from "../agent/pick.ts";
import { type ClaudeGuardOptions, claudeGuard, movedConfigDirCredentials } from "../claude/guard.ts";
import { TOOL_INPUT_MAX } from "../claude/hooks.ts";
import { codexAgent } from "./pick.ts";

/** How long the guard may judge one call, in ms, at most (CodexGuardContext.deadline may leave it less). */
const JUDGE_MS = 2000;

/**
 * The longest command line the guard reads, 64 KB, as Claude Code's guard: reading one every way (brace groups, $'…')
 * takes up to about 0.2 s at this size, so no single read keeps the guard past its deadline for long.
 */
const CHECK_MAX = 64 * 1024;

const OUT_OF_TIME = "this call names more than the guard can check in time; nothing was run.";

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

type Hunks = { readonly targets: string[]; readonly next: number } | { readonly unreadable: string };

/**
 * Codex 0.162.1's hunk reader (codex-rs apply-patch streaming_parser.rs) over `lines` from `from`, the line after
 * "*** Begin Patch", through the line that ends the patch; `next` is the line after that. A hunk header is read from the
 * line trimmed (Rust's trim: U+0085 too, not U+FEFF) outside an update hunk, and only at its first column inside one, as
 * is `*** Move to:` (Codex moves only on one right after the header and refuses the patch for one elsewhere; every one
 * counts here, and no content line starts at the first column with "*"); the path is all that follows the marker's one
 * space. Line `last`, when given, ends the patch trimmed in any hunk, as Codex's parser reads its last line apart.
 * `quoted`: the patch sits in other text, and its end line may carry the quote that closes it.
 */
function readHunks(lines: readonly string[], from: number, last?: number, quoted = false): Hunks {
	const targets: string[] = [];
	let mode: "start" | "add" | "delete" | "update" = "start";
	for (let at = from; at < lines.length; at++) {
		const line = (lines[at] as string).replace(/\r$/, "");
		const trimmed = rustTrim(line);
		const header: string = mode === "update" ? line.replace(RUST_TRIM_END, "") : trimmed;
		if (mode === "start" && header.startsWith(ENVIRONMENT)) return { unreadable: "it picks another environment, whose files the guard cannot see" };
		if (header === END || (at === last && trimmed === END) || (quoted && /^\*\*\* End Patch["']/.test(trimmed))) return { targets, next: at + 1 };
		const marker: string | undefined = HEADERS.find((prefix) => header.startsWith(prefix));
		if (marker !== undefined) {
			targets.push(header.slice(marker.length));
			mode = marker === HEADERS[0] ? "add" : marker === HEADERS[1] ? "delete" : "update";
			continue;
		}
		if (mode === "update") {
			if (header.startsWith(MOVE_TO)) targets.push(header.slice(MOVE_TO.length));
			continue;
		}
		if (mode === "add" && line.startsWith("+")) continue;
		return { unreadable: "a line is neither a hunk header nor what its hunk takes" };
	}
	return { unreadable: "it does not end with *** End Patch" };
}

/**
 * A patch's targets as Codex 0.162.1's apply_patch parser reads them (codex-rs apply-patch parser.rs, lenient mode,
 * which it always uses): the text trimmed and split into lines, each without one "\r"; framed by "*** Begin Patch" and
 * "*** End Patch" (trimmed), or by a heredoc's `<<'EOF'` … `EOF` around them; then readHunks. Unreadable: whatever Codex
 * would not apply, and a patch that picks another environment (its paths are not here).
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
	const read = readHunks(lines, 1, lines.length - 1);
	if ("unreadable" in read) return read;
	if (lines.slice(read.next).some((line) => rustTrim(line) !== "")) return { unreadable: "it goes on after *** End Patch" };
	return { targets: read.targets };
}

/** The apply_patch program by name, as shell text may run it: Codex puts it on the shell's PATH. */
const APPLY_PATCH_WORD = shellWord(["apply_patch", "applypatch"]);

/** A `cd <dir> &&` before the program, as Codex's interception takes one (one plain or quoted word). */
const CD_PREFIX = String.raw`(?:cd[ \t]+(\S+)[ \t]*&&[ \t]*)?`;
/** The heredoc form's first line: the program, then `<<` and its end word, bare or quoted. */
const HEREDOC_HEAD = new RegExp(String.raw`^${CD_PREFIX}(?:apply_patch|applypatch)[ \t]*<<[ \t]*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|([A-Za-z_]\w*))[ \t]*$`, "i");
/** The argument form: the program and one single-quoted argument, which a shell passes as written. */
const QUOTED_ARGUMENT = new RegExp(String.raw`^${CD_PREFIX}(?:apply_patch|applypatch)[ \t]+'([^']*)'$`, "i");

/**
 * The patch a shell command carries, when the whole command is one of the forms the guard reads: Codex's own,
 * `apply_patch <<'EOF'` then the patch and the end word as its last line (a bare end word too, whose shell would expand
 * `$`, a backquote or a backslash, so no path may hold one), with a `cd <dir> &&` before it or not; or the program with
 * the patch as one single-quoted argument. `applypatch` is the same program, and the name is taken in any case (macOS
 * opens it so). Undefined for anything else: more after the heredoc, a heredoc whose end word comes early, another
 * command, a patch from a file or a variable.
 */
export function shellPatch(command: string): { readonly patch: string; readonly cd?: string; readonly expands: boolean } | undefined {
	const text = command.trim();
	const argument = QUOTED_ARGUMENT.exec(text);
	if (argument !== null) return { patch: argument[2] as string, expands: false, ...(argument[1] === undefined ? {} : { cd: argument[1] }) };
	const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
	const head = HEREDOC_HEAD.exec(lines[0] as string);
	if (head === null) return undefined;
	const word = head[2] ?? head[3] ?? head[4];
	const end = lines.indexOf(word as string, 1);
	if (end !== lines.length - 1) return undefined;
	return { patch: lines.slice(1, end).join("\n"), expands: head[4] !== undefined, ...(head[1] === undefined ? {} : { cd: head[1] }) };
}

/**
 * The folders a shell command's patch starts from: the session's cwd, and a `cd` before the program, joined onto it as
 * Codex joins it ("~" as a name) and as a shell reads it ("~" as home). Undefined when the cd's folder cannot be known
 * (a variable, a substitution, a glob, an escape, an option, "-").
 */
function patchBases(cd: string | undefined, cwd: string, home: string): string[] | undefined {
	if (cd === undefined) return [cwd];
	const quoted = /^(['"])(.*)\1$/.exec(cd);
	const dir = quoted === null ? cd : (quoted[2] as string);
	if (dir === "" || dir.startsWith("-") || /[$`\\*?[\]{}'"]/.test(dir)) return undefined;
	const bases = new Set([cwd, resolve(cwd, dir)]);
	if (dir === "~" || dir.startsWith("~/")) bases.add(resolve(home, `.${dir.slice(1)}`));
	return [...bases];
}

const CALL_UNREADABLE = "Orrery could not read this call; nothing was run.";
const PATCH_UNREADABLE = (why: string) => `Orrery could not read this patch (${why}); nothing was changed.`;
const SHELL_PATCH_UNREADABLE = (why: string) => `This command runs apply_patch with a patch Orrery could not read (${why}); nothing was run. Use the apply_patch tool.`;

/**
 * Each of `targets` judged as a write, from each of `bases`, within the guard's time; the first refusal. `patch`: the
 * patch text they come from, for what each puts in its file (guard-rules.ts patchNewText).
 */
function judgeWrites(targets: readonly string[], bases: readonly string[], options: ClaudeGuardOptions, patch: string): string | undefined {
	const written = patchNewText(patch);
	const deadline = performance.now() + (options.judgeMs ?? JUDGE_MS);
	if (targets.length > 0 && deadline <= performance.now()) return "this patch names more files than the guard can check in time; nothing was changed.";
	for (const target of new Set(targets)) {
		for (const cwd of isAbsolute(target) ? [options.cwd] : bases) {
			const left = deadline - performance.now();
			if (left <= 0) return "this patch names more files than the guard can check in time; nothing was changed.";
			const reason = claudeGuard("Write", { file_path: target, [NEW_TEXT]: written(target) }, { ...options, cwd, resolvePath: (raw, base) => codexToolPath(raw, base), judgeMs: left });
			if (reason !== undefined) return reason;
		}
	}
	return undefined;
}

/**
 * A command line in a shell command that names apply_patch: it must be a form the guard reads (shellPatch), and each
 * target is a write from its bases (patchBases); undefined when it does not name the program.
 */
function shellCommandPatch(command: string, options: ClaudeGuardOptions): string | undefined {
	if (!inAnyReading(command, (form) => APPLY_PATCH_WORD.test(form))) return undefined;
	const carried = shellPatch(command);
	if (carried === undefined) return SHELL_PATCH_UNREADABLE("the command is not one apply_patch <<'EOF' … EOF, with a cd && before it or not");
	const read = readPatch(carried.patch);
	if ("unreadable" in read) return SHELL_PATCH_UNREADABLE(read.unreadable);
	if (carried.expands && read.targets.some((target) => /[$`\\]/.test(target))) return SHELL_PATCH_UNREADABLE("a path holds what the shell would change");
	const bases = patchBases(carried.cd, options.cwd, options.home ?? homedir());
	if (bases === undefined) return SHELL_PATCH_UNREADABLE("its cd goes where the guard cannot tell");
	return judgeWrites(read.targets, bases, options, carried.patch) ?? "";
}

/** A line that opens or belongs to a patch: "*** Begin Patch" at its end, or a hunk header (trimmed) at its start. */
const PATCH_LINE = /\*\*\* Begin Patch[ \t\r]*$|^[ \t]*\*\*\* (?:Add File|Update File|Delete File|Move to): /m;

/**
 * The patch text a string holds anywhere, as some tool may apply it: each patch from a line that ends with
 * "*** Begin Patch" through its end (readHunks; the end line may carry the quote that closes it), each target a write
 * from the session's cwd. Refused when one does not read, or a hunk header stands outside every patch.
 */
function patchText(text: string, options: ClaudeGuardOptions): string | undefined {
	const lines = text.split("\n");
	const targets: string[] = [];
	for (let at = 0; at < lines.length; at++) {
		const line = (lines[at] as string).replace(/\r$/, "").replace(RUST_TRIM_END, "");
		if (line.endsWith(BEGIN)) {
			const read = readHunks(lines, at + 1, undefined, true);
			if ("unreadable" in read) return PATCH_UNREADABLE(read.unreadable);
			targets.push(...read.targets);
			at = read.next - 1;
		} else if ([...HEADERS, MOVE_TO].some((marker) => rustTrim(line).startsWith(marker))) {
			return PATCH_UNREADABLE("a hunk header stands outside *** Begin Patch and *** End Patch");
		}
	}
	return judgeWrites(targets, [options.cwd], options, text);
}

/**
 * A key whose string, or list of strings, is a command line or code to run, in any tool: Claude Code's guard reads
 * command, cmd, script and shell (and args and argv lists) as shell text; input (a freeform tool's) and code are read
 * so here too.
 */
const COMMAND_KEY = /^(command|cmd|script|shell|input|code|args|argv)$/i;
const SHELL_TEXT_HERE = /^(input|code)$/i;

/** Each string in a tool's input, at any depth, with its key and whether it is a command line (COMMAND_KEY), and each command list. */
function inputStrings(input: Readonly<Record<string, unknown>>): { readonly strings: { key: string; text: string; command: boolean }[]; readonly lists: string[][] } {
	const strings: { key: string; text: string; command: boolean }[] = [];
	const lists: string[][] = [];
	const stack: { key: string; value: unknown; command: boolean }[] = Object.entries(input).map(([key, value]) => ({ key, value, command: COMMAND_KEY.test(key) }));
	for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
		const { key, value } = next;
		if (typeof value === "string") strings.push({ key, text: value, command: next.command });
		else if (typeof value === "object" && value !== null) {
			if (Array.isArray(value) && next.command) lists.push(value.filter((item): item is string => typeof item === "string"));
			for (const [inner, item] of Object.entries(value)) stack.push({ key: Array.isArray(value) ? key : inner, value: item, command: next.command || (!Array.isArray(value) && COMMAND_KEY.test(inner)) });
		}
	}
	return { strings, lists };
}

/**
 * The guard by what a call carries, whatever the tool is named (MCP and dynamic tools may run commands or apply patches
 * under any name): a string under input or code is shell text too; a command line that names apply_patch must be a form
 * the guard reads, or the program's name and one patch as a list (["apply_patch", patch]); and any patch text, in any
 * string, is read and each target judged as a write. `timed`: the guard's options with what is left of the call's
 * time; `skip`: the string the tool's own rule has judged already.
 */
function byContent(input: Readonly<Record<string, unknown>>, timed: () => ClaudeGuardOptions, skip?: string): string | undefined {
	const { strings, lists } = inputStrings(input);
	// The strings a rule below has judged whole.
	const judged = new Set(skip === undefined ? [] : [skip]);
	for (const list of lists) {
		if ((timed().judgeMs ?? 0) <= 0) return OUT_OF_TIME;
		if (list.length === 2 && /^(?:apply_patch|applypatch)$/i.test(list[0] as string)) {
			const read = readPatch(list[1] as string);
			if ("unreadable" in read) return PATCH_UNREADABLE(read.unreadable);
			const reason = judgeWrites(read.targets, [timed().cwd], timed(), list[1] as string);
			if (reason !== undefined) return reason;
			for (const item of list) judged.add(item);
		}
	}
	for (const { key, text, command } of strings) {
		if (judged.has(text)) continue;
		if ((timed().judgeMs ?? 0) <= 0) return OUT_OF_TIME;
		if (command && text.length > CHECK_MAX) return "a command line is too long to check (over 64 KB); nothing was run.";
		if (command && SHELL_TEXT_HERE.test(key)) {
			const reason = claudeGuard("Bash", { command: text }, timed());
			if (reason !== undefined) return reason;
		}
		const shell = command ? shellCommandPatch(text, timed()) : undefined;
		if (shell === "") continue;
		if (shell !== undefined) return shell;
		if (PATCH_LINE.test(text)) {
			const reason = patchText(text, timed());
			if (reason !== undefined) return reason;
		}
	}
	return undefined;
}

/**
 * Why a Codex tool call is refused, or undefined to let it through (module doc). Every check shares the call's time
 * (`judgeMs`, default 2 s): one that has none left refuses, so the hook answers before Codex's timeout lets the call
 * through.
 */
export function codexGuard(toolName: string, input: unknown, options: ClaudeGuardOptions): string | undefined {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return CALL_UNREADABLE;
	const args = input as Readonly<Record<string, unknown>>;
	const deadline = performance.now() + (options.judgeMs ?? JUDGE_MS);
	const timed = (): ClaudeGuardOptions => ({ ...options, judgeMs: deadline - performance.now() });
	if (deadline <= performance.now()) return OUT_OF_TIME;
	if (toolName === "apply_patch") {
		if (typeof args.command !== "string") return PATCH_UNREADABLE("it is no text");
		const read = readPatch(args.command);
		if ("unreadable" in read) return PATCH_UNREADABLE(read.unreadable);
		return judgeWrites(read.targets, [options.cwd], timed(), args.command) ?? byContent(args, timed, args.command);
	}
	const reason = toolName === "view_image" ? claudeGuard("view_image", args, { ...timed(), resolvePath: (raw, cwd) => codexToolPath(raw, cwd) }) : claudeGuard(toolName, args, timed());
	return reason ?? byContent(args, timed);
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
	/**
	 * When the judgment must be done, as performance.now() reads it (the hook passes CODEX_GUARD_DEADLINE_MS, which counts
	 * from the process's start, src/codex/guard-exit.ts); default JUDGE_MS from now. The guard has at most JUDGE_MS.
	 */
	readonly deadline?: number;
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
	if (stdin === undefined) return "this call's input is too large for Orrery's guard to check (over 1 MB); nothing was run.";
	// Done by the context's deadline, and within JUDGE_MS of now.
	const by = Math.min(performance.now() + JUDGE_MS, ctx.deadline ?? Number.POSITIVE_INFINITY);
	if (by <= performance.now()) return OUT_OF_TIME;
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
		judgeMs: by - performance.now(),
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
