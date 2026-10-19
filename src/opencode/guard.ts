/**
 * The agent guard on OpenCode's tool calls (spec 2026-10-16-opencode-design, "Guard"), in Orrery's plugin
 * (src/opencode/plugin.ts) on `ctx.tool.hook("execute.before")`. OpenCode 2.0.30 runs that hook before every tool call a
 * model makes (the built-in tools, plugin and MCP tools, Code Mode's `execute`, and each tool a Code Mode program calls,
 * in a call of its own; core/src/tool.ts), and a throw there refuses the call: the model gets the message. The guard
 * judges each call with the rules every other gate applies (src/agent/guard-rules.ts, guard-paths.ts, through Claude
 * Code's guard, src/claude/guard.ts), paths placed as OpenCode places them (openCodeToolPath):
 * - shell: its command by the shell-text rules, and its workdir (the session's folder when it has none) as a read of
 *   that folder, as OMP's bash cwd is;
 * - read, write and edit: their path, a read or a write; read also each file OpenCode would open in its place when the
 *   path is missing (its "filename recovery": a name that differs only in Unicode form, no-break spaces or curly quotes);
 * - patch: each target of its patchText (Add, Update, Delete, Move to), read as OpenCode's parser reads it (readPatch,
 *   @opencode/util/patch at 2.0.30), each a write; a patch OpenCode would not apply is refused unread;
 * - glob and grep: their search root (and grep's include and glob's pattern by the names they match), as Claude Code's
 *   Glob and Grep;
 * - Code Mode's execute: its JavaScript by the shell-text rules (it names no file a built-in tool opens: it can call
 *   only Code Mode tools, MCP's, plugins' and OpenCode's own opencode_* ones, each judged in its own hook call, which
 *   catches a name built from pieces);
 * - opencode_session_move: its folder judged as a shell's workdir is (a move into a protected folder is refused: the
 *   session's shell and relative paths would start there);
 * - webfetch and websearch: allowed (the network, as everywhere), but a file: URL is a read;
 * - every other tool (MCP and plugin tools, opencode_* tools, subagent, skill, question, and a built-in another plugin
 *   renamed) by what it carries: Claude Code's heuristics (command lines, paths, file: URIs, destinations, a tool named
 *   for writing), a string under input or code as shell text, and every patch header line in any string, each target a
 *   write.
 * A built-in tool judged by name must carry the input its schema takes (OpenCode would not run it otherwise), and what
 * else it carries goes by content, so a tool another plugin renamed to one of these names is judged by what it takes.
 * Paths are placed from the folder of the plugin's location, which is the session's: OpenCode runs a session's tools in
 * its location, and a session moved elsewhere (session_move) runs in the new folder's location, with a plugin and guard
 * of its own. An empty path is that folder, as OpenCode resolves it.
 * OpenCode's own login store (its database, which holds provider keys and sign-ins, and the auth.json it had before) is a
 * credential store every gate keeps (src/agent/guard-paths.ts openCodeCredentials, guard-rules.ts by name); here its
 * database is also refused by name alone in shell text, wherever it is spelled.
 * OpenCode's config and code (a .opencode folder and opencode.json(c) in any folder, OpenCode's own config, cache, state
 * and database: src/agent/guard-rules.ts openCodeLoads, with OpenCode's source for each) are kept by the rules every gate
 * shares: a write to one (a write, an edit, a patch target, a path an MCP or plugin tool may write, through a link, in
 * any case) is refused, and so is shell text naming one; reading them is not. OpenCode's Plan folder (~/.opencode/plan,
 * below) is no config: its plan files may be written. The skills of .claude and .agents may be written, but never with
 * front matter that may run as code, and only where the guard can see what the file will start with (guard-rules.ts
 * openCodeSkillRefusal, fail-closed): a write by its text, an edit on the file it would leave, a patch by its lines;
 * the permission layer again on the diff OpenCode's request carries, applied to the file as it is.
 * The guard is fail-closed: an input it cannot read, an input over 1 MB, a command line over 64 KB and a call it cannot
 * judge within its time are refused (OpenCode has no time limit on a hook: a hook that never answers holds the call).
 * Limits, beyond the shell-text limits every gate has: a plugin of the person's own that changes a call's input after
 * Orrery's hook has judged it (the second layer, openCodePermission, judges what read and edit ask leave for, as
 * OpenCode placed it); a session whose OpenCode has turned Orrery's plugin off (a reload that failed: OpenCode logs
 * "failed to restore plugin; deactivating") runs with no guard at all, which the TUI's footer and a toast then say
 * (plugin/tui.tsx); Code Mode's fetch() (network only); a relative target in an MCP tool's patch text is judged from the session's folder.
 */

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { AgentConfig, HarnessConfig } from "../agent/config.ts";
import { agentViews, DATABASE_NAME, GuardCall, movedAgentDirCredentials, ompCredentials, openCodeCredentials, openCodeOf, realTarget } from "../agent/guard-paths.ts";
import { inAnyReading, NEW_TEXT, type NewText, OPENCODE_COMMAND, openCodeNamed, type OpenCodeRule, openCodeRule, openCodeSkillPath, patchNewText, SKILL_SHELL, skillsNamed } from "../agent/guard-rules.ts";
import type { WriteRules } from "../agent/nested-rules.ts";
import { workArea } from "../agent/pick.ts";
import { ownFolder } from "../agent/private-file.ts";
import { type ClaudeGuardOptions, claudeGuard, movedConfigDirCredentials } from "../claude/guard.ts";

/** The longest tool input the guard reads (1 MB, as Claude Code's and Codex's): a longer one is refused unread. */
export const OPENCODE_TOOL_INPUT_MAX = 1024 * 1024;

/** How long the guard may judge one call's rules, in ms, at most (the hook's own deadline, GUARD_MS, may leave it less). */
const JUDGE_MS = 2000;

/** The longest command line, Code Mode program or patch the guard reads (64 KB, as the other gates). */
const CHECK_MAX = 64 * 1024;

const OUT_OF_TIME = "this call names more than the guard can check in time; nothing was run.";
const CALL_TOO_LARGE = "this call's input is too large for Orrery's guard to check (over 1 MB); nothing was run.";
const PATCH_UNREADABLE = (why: string) => `Orrery could not read this patch (${why}); nothing was changed.`;
const OTHER_SESSION = "this moves another session by a folder relative to that session's own, which Orrery cannot place; give an absolute folder. Nothing was moved.";
const LOGIN = "This command touches sensitive files (OpenCode's login).";
const LOGIN_FILE = (path: string) => `${path} is a sensitive file (OpenCode's login).`;

/**
 * Mirrors OpenCode 2.0.30's FileAccess.resolvePath (core/src/file-access.ts), which its file tools, searches, patch and
 * shell workdir place a path with: "~" and "~/…" from `home` (OpenCode's own, Global.Path.home), anything else resolved
 * against the session's folder. Nothing is trimmed.
 */
export function openCodeToolPath(raw: string, cwd: string, home: string): string {
	return resolve(cwd, raw === "~" ? home : raw.startsWith("~/") ? join(home, raw.slice(2)) : raw);
}

/** The home OpenCode's "~" means: OPENCODE_TEST_HOME, else the account's (util/src/global.ts). */
export function openCodeHome(env: NodeJS.ProcessEnv = process.env): string {
	return env.OPENCODE_TEST_HOME || homedir();
}

/** OpenCode's login store (src/agent/guard-paths.ts openCodeCredentials, which every gate keeps). */
export const openCodeLogins = openCodeCredentials;

/** OpenCode's database named in shell text (DATABASE_NAME as a word): a command that names it is refused. */
const DATABASE_WORD = /(?:^|[\s"'=:/~<>;|&()`{,@])opencode(?:-[a-z0-9._-]+)?\.db(?:-wal|-shm|-journal)?(?=$|[\s"'/:;|&()<>`,}*?[])/;

/** Whether shell text names OpenCode's database, in any reading a shell may make of it. */
function loginNamed(command: string): boolean {
	return inAnyReading(command, (form) => DATABASE_WORD.test(form));
}

/**
 * OpenCode's own per-user state an agent may write, as Claude Code's plans folder is in Claude Code's gate: the folder
 * its Plan agent writes plan files in (~/.opencode/plan, plugin/plan.ts), when it is a real folder of this user's or not
 * there yet (the guard follows a root's links, so one planted as a link would open its target).
 */
export function openCodeStateRoots(home: string): string[] {
	const plan = join(home, ".opencode", "plan");
	try {
		return (ownFolder(plan) ?? true) === true ? [plan] : [];
	} catch {
		return [];
	}
}

/** The guard's options for one OpenCode session: where it runs, its agent's rules (or no agent's), and what is kept. */
export interface OpenCodeGuardOptions extends ClaudeGuardOptions {
	/** OpenCode's "~" (openCodeHome); default `home`. */
	readonly openCodeHome?: string;
	/** OpenCode's login store (openCodeLogins), judged as credentials, by name in commands too. */
	readonly logins?: readonly string[];
}

/**
 * The guard's options for a session of `agent` (or of no agent: the launch's token was refused, another process holds
 * it, or the plugin has no options) in OpenCode's folder `cwd`, as Codex's guard builds its own: the agent's folder (or
 * `cwd`, outside it) and allowed roots, Orrery's credentials and the tools' (pi's, OMP's, Claude Code's moved ones,
 * OpenCode's login), Orrery's home, [guard] protect and every other agent's view. `context.rules` stands in for the
 * agent's folder and allowed roots: a session started inside an agent's session (no agent: every view is another's)
 * writes by the outer agent's (src/agent/nested-rules.ts).
 */
export function openCodeGuardOptions(
	config: HarnessConfig,
	agent: AgentConfig | undefined,
	cwd: string,
	context: { readonly env?: NodeJS.ProcessEnv; readonly home?: string; readonly configFile?: string; readonly rules?: WriteRules } = {},
): OpenCodeGuardOptions {
	const env = context.env ?? process.env;
	const home = context.home ?? homedir();
	const logins = openCodeLogins(env, home);
	const tilde = context.home ?? openCodeHome(env);
	const rules = context.rules ?? { workArea: workArea(agent ?? {}, cwd), allowedRoots: agent?.allowedRoots ?? [] };
	return {
		folder: rules.workArea,
		allowedRoots: [...rules.allowedRoots, ...openCodeStateRoots(tilde)],
		cwd: resolve(cwd),
		credentials: [config.credentialsPath, ...movedAgentDirCredentials(env, home), ...movedConfigDirCredentials(env), ...ompCredentials(env, home), ...logins],
		orreryData: config.dataDir,
		home,
		openCodeHome: tilde,
		logins,
		protect: config.guard.protect,
		...agentViews(config, agent),
		...(context.configFile === undefined ? {} : { configFile: context.configFile }),
		// Made once for the session: a patch judges each of its targets by it.
		openCode: openCodeRules(env, [home, tilde]),
	};
}

/** OpenCode's config and code (guard-rules.ts openCodeRule) for each of `homes` (OpenCode's own "~" may differ from the account's). */
function openCodeRules(env: NodeJS.ProcessEnv, homes: readonly string[]): OpenCodeRule {
	const rules = [...new Set(homes)].map((home) => openCodeRule(env, home, realTarget));
	const all = (pick: (rule: OpenCodeRule) => readonly string[]) => [...new Set(rules.flatMap(pick))];
	return { own: all((rule) => rule.own), spelled: all((rule) => rule.spelled ?? []), plans: all((rule) => rule.plans), data: all((rule) => rule.data) };
}

// ---- OpenCode's patch format ----

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD = "*** Add File: ";
const DELETE = "*** Delete File: ";
const UPDATE = "*** Update File: ";
const MOVE = "*** Move to: ";
const END_OF_FILE = "*** End of File";
const ENVIRONMENT = "*** Environment ID:";

/** The heredoc OpenCode's parser takes a patch out of: `<<'EOF'` (or cat <<EOF), the patch, the end word (util/src/patch.ts). */
const HEREDOC = /^(?:cat\s+)?<<(['"]?)(\w+)\1\s*\n([\s\S]*?)\n\2\s*$/;

/** A line that ends an update hunk or starts another (util/src/patch.ts isBoundary). */
const boundary = (line: string) => line === END || line.startsWith(ADD) || line.startsWith(DELETE) || line.startsWith(UPDATE);

type Read = { readonly targets: string[] } | { readonly unreadable: string };

/**
 * An update hunk's lines from `start`, as OpenCode's parseUpdate reads them: up to the next boundary (its line with
 * trailing blanks gone), each a context (" "), removed ("-"), added ("+") or empty line, an "@@" chunk header, or
 * "*** End of File"; `next` is the boundary's line. Unreadable as OpenCode finds it.
 */
function readUpdate(lines: readonly string[], start: number, end: number): { readonly next: number } | { readonly unreadable: string } {
	let chunks = 0;
	let filled = false;
	let afterEnd = false;
	let index = start;
	for (; index < end; index++) {
		const line = lines[index] as string;
		const trimmed = line.trimEnd();
		if (afterEnd) {
			if (trimmed === "") continue;
			if (trimmed === "@@" || trimmed.startsWith("@@ ")) afterEnd = false;
			else if (boundary(trimmed)) break;
			else return { unreadable: "an update hunk goes on after *** End of File without @@" };
		}
		if (trimmed === END_OF_FILE) {
			if (chunks > 0 && !filled) return { unreadable: "an update hunk has no lines" };
			if (chunks > 0) afterEnd = true;
			continue;
		}
		if (boundary(trimmed)) break;
		if (trimmed === "@@" || trimmed.startsWith("@@ ")) {
			if (chunks > 0 && !filled) return { unreadable: "an update hunk has no lines" };
			chunks++;
			filled = false;
			continue;
		}
		if (chunks === 0) chunks = 1;
		if (line === "" || line.startsWith(" ") || line.startsWith("-") || line.startsWith("+")) {
			filled = true;
			continue;
		}
		return { unreadable: "a line of an update hunk is neither context, a change nor @@" };
	}
	if (chunks === 0 || !filled) return { unreadable: "an update hunk has no lines" };
	return { next: index };
}

/**
 * A patch's targets as OpenCode 2.0.30's patch tool reads them (util/src/patch.ts parse, which it applies only when it
 * reads): the text trimmed, out of a heredoc if it is in one, split into lines (each without one "\r"); the first line
 * "*** Begin Patch" and the last "*** End Patch" (each trimmed); an "*** Environment ID:" line right after the first is
 * skipped; then hunks, each a header (trimmed) and its lines: Add File's start with "+", Delete File has none, Update
 * File may have "*** Move to:" (after any "*** End of File" lines) and then its chunks. Each target is the header's path,
 * trimmed. Unreadable: what OpenCode would not apply.
 */
export function readPatch(text: string): Read {
	const trimmed = text.trim();
	const lines = (HEREDOC.exec(trimmed)?.[3] ?? trimmed).split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
	if (lines[0]?.trim() !== BEGIN) return { unreadable: "its first line is not *** Begin Patch" };
	const end = lines.length - 1;
	if (end <= 0 || lines[end]?.trim() !== END) return { unreadable: "its last line is not *** End Patch" };
	const targets: string[] = [];
	let index = 1;
	while (index < end) {
		const header = (lines[index] as string).trim();
		if (index === 1 && header.startsWith(ENVIRONMENT) && header.slice(ENVIRONMENT.length).trim() !== "") {
			index++;
			continue;
		}
		if (header.startsWith(ADD)) {
			targets.push(header.slice(ADD.length).trim());
			for (index++; index < end && !boundary((lines[index] as string).trim()); index++) {
				if (!(lines[index] as string).startsWith("+")) return { unreadable: "a line of an Add File hunk does not start with +" };
			}
			continue;
		}
		if (header.startsWith(DELETE)) {
			targets.push(header.slice(DELETE.length).trim());
			const next = lines[index + 1]?.trim();
			if (index + 1 < end && next !== undefined && !boundary(next)) return { unreadable: "a Delete File hunk has lines" };
			index++;
			continue;
		}
		if (header.startsWith(UPDATE)) {
			targets.push(header.slice(UPDATE.length).trim());
			let next = index + 1;
			while (lines[next]?.trimEnd() === END_OF_FILE) next++;
			const move = lines[next]?.trimEnd();
			if (move === "*** Move to:" || move?.startsWith(MOVE)) {
				const to = move.slice(MOVE.length).trim();
				if (to === "") return { unreadable: "a Move to names no file" };
				targets.push(to);
				next++;
			}
			const read = readUpdate(lines, next, end);
			if ("unreadable" in read) return read;
			index = read.next;
			continue;
		}
		return { unreadable: "a line is not a hunk header" };
	}
	return { targets };
}

/**
 * Every target a patch header line in `text` names, whatever the line's place: a line that, trimmed, starts with
 * "*** Add File: ", "*** Delete File: ", "*** Update File: " or "*** Move to: ", its path as written and trimmed. More
 * than any one parser reads (a context line that looks like a header counts too), so no applier reads a target this
 * misses by these headers.
 */
export function headerTargets(text: string): string[] {
	const targets = new Set<string>();
	for (const line of text.split("\n")) {
		const header = line.trim();
		for (const marker of [ADD, DELETE, UPDATE, MOVE]) {
			if (!header.startsWith(marker)) continue;
			const path = header.slice(marker.length);
			for (const form of [path, path.trim()]) if (form !== "") targets.add(form);
		}
	}
	return [...targets];
}

// ---- The guard ----

/** A key whose string is code or a command line to run, beside Claude Code's (command, cmd, script, shell): input and code. */
const CODE_KEY = /^(input|code)$/i;
/** Every key whose string is run as shell text, for OpenCode's login rule. */
const RUN_KEY = /^(command|cmd|script|shell|input|code|args|argv)$/i;

/** Each string in a tool's input, at any depth, with whether a key above it (or its own) runs it (RUN_KEY) and is code (CODE_KEY). */
function stringsIn(input: unknown): { readonly text: string; readonly runs: boolean; readonly code: boolean }[] {
	const found: { text: string; runs: boolean; code: boolean }[] = [];
	const stack: { value: unknown; runs: boolean; code: boolean }[] = [{ value: input, runs: false, code: false }];
	for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
		const { value } = next;
		if (typeof value === "string") found.push({ text: value, runs: next.runs, code: next.code });
		else if (typeof value === "object" && value !== null) {
			for (const [key, item] of Object.entries(value)) {
				const own = !Array.isArray(value);
				stack.push({ value: item, runs: next.runs || (own && RUN_KEY.test(key)), code: next.code || (own && CODE_KEY.test(key)) });
			}
		}
	}
	return found;
}

/** The guard's work for one call: the options with what is left of its time, and its judgments. */
class Judge {
	readonly #options: OpenCodeGuardOptions;
	readonly #deadline: number;

	/** OpenCode's login stores, as given and where they really are (folded), worked out once for the call. */
	#logins: string[] | undefined;

	constructor(options: OpenCodeGuardOptions) {
		// One guard call: the rules every path of it is judged by are worked out once (guard-paths.ts GuardCall).
		this.#options = options.call === undefined ? { ...options, call: new GuardCall() } : options;
		this.#deadline = performance.now() + Math.min(options.judgeMs ?? JUDGE_MS, JUDGE_MS);
	}

	get outOfTime(): boolean {
		return this.#deadline <= performance.now();
	}

	/** Claude Code's guard on one call, paths placed by `place` (default OpenCode's), with the time that is left. */
	claude(tool: string, input: Readonly<Record<string, unknown>>, place?: (raw: string, cwd: string) => string): string | undefined {
		if (this.outOfTime) return OUT_OF_TIME;
		const options = this.#options;
		const home = options.openCodeHome ?? options.home ?? homedir();
		const resolvePath = place ?? ((raw: string, cwd: string) => openCodeToolPath(raw, cwd, home));
		return claudeGuard(tool, input, { ...options, judgeMs: this.#deadline - performance.now(), resolvePath });
	}

	/** Shell text: the rules every gate gives a command line, and OpenCode's login and config by name. */
	shell(command: string): string | undefined {
		if (command.length > CHECK_MAX) return "a command line is too long to check (over 64 KB); nothing was run.";
		return this.claude("Bash", { command }) ?? this.named(command);
	}

	/** OpenCode's login, or its config and code (guard-rules.ts openCodeNamed), named in text a shell runs. */
	named(command: string): string | undefined {
		if (loginNamed(command)) return LOGIN;
		if (openCodeNamed(command, openCodeOf(this.#options, this.#options.home ?? homedir()))) return OPENCODE_COMMAND;
		return skillsNamed(command) ? SKILL_SHELL : undefined;
	}

	/** Where OpenCode's tools place `raw` (or `place` does), and where that lands. */
	#placed(raw: string, place?: (raw: string, cwd: string) => string): [string, string] {
		const home = this.#options.openCodeHome ?? this.#options.home ?? homedir();
		const placed = (place ?? ((path: string, cwd: string) => openCodeToolPath(path, cwd, home)))(raw, this.#options.cwd);
		return [placed, realTarget(placed)];
	}

	/**
	 * A path the call opens as `use`, placed as OpenCode places it; OpenCode's login by its path too. A write's `written`:
	 * what it puts in the file, for the rule on a skill's front matter (guard-rules.ts NewText; undefined: unseen).
	 */
	path(use: "read" | "write", given: string, place?: (raw: string, cwd: string) => string, written?: NewText): string | undefined {
		// An empty path is the session's folder to OpenCode (it resolves it from there); Claude Code's guard skips it.
		const raw = given === "" ? "." : given;
		const reason = this.claude(use === "write" ? "Write" : "Read", use === "write" ? { file_path: raw, [NEW_TEXT]: written } : { file_path: raw }, place);
		if (reason !== undefined) return reason;
		this.#logins ??= (this.#options.logins ?? []).flatMap((login) => [login, realTarget(login)]).map((login) => login.toLowerCase());
		const logins = this.#logins;
		const where = this.#placed(raw, place).map((path) => path.toLowerCase());
		// Its database by path, or by name in its data folder (a release channel's, made after the session started).
		const login = (path: string) => logins.includes(path) || (DATABASE_NAME.test(basename(path)) && logins.some((file) => dirname(file) === dirname(path)));
		return where.some(login) ? LOGIN_FILE(raw) : undefined;
	}

	/**
	 * Each patch target, a write, judged once (a patch may name a file in many hunks, and headerTargets names each again),
	 * with what the patch text `patch` puts in it (guard-rules.ts patchNewText).
	 */
	writes(targets: readonly string[], patch: string): string | undefined {
		const written = patchNewText(patch);
		for (const target of new Set(targets)) {
			const reason = this.path("write", target, undefined, written(target));
			if (reason !== undefined) return reason;
		}
		return undefined;
	}

	/**
	 * read's path, and each file OpenCode's read tool opens in its place when it is missing (read.ts alternatePath): a
	 * file beside it whose name is the same once both are in NFC, with no-break spaces as spaces and curly quotes straight.
	 */
	read(raw: string): string | undefined {
		const reason = this.path("read", raw);
		if (reason !== undefined) return reason;
		const home = this.#options.openCodeHome ?? this.#options.home ?? homedir();
		const absolute = openCodeToolPath(raw, this.#options.cwd, home);
		const canonical = (name: string) => name.normalize("NFC").replace(/[  ]/g, " ").replace(/[‘’]/g, "'");
		let names: string[];
		try {
			names = readdirSync(dirname(absolute));
		} catch {
			return undefined;
		}
		if (names.includes(basename(absolute))) return undefined;
		const want = canonical(basename(absolute));
		for (const name of names) {
			if (canonical(name) !== want) continue;
			const sibling = this.path("read", join(dirname(absolute), name));
			if (sibling !== undefined) return sibling;
		}
		return undefined;
	}

	/**
	 * What any tool carries: Claude Code's heuristics on its input (OpenCode's config and code among them), a string under
	 * input or code as shell text, OpenCode's login and config named in anything run as shell text, and every patch header
	 * line in any string, each target a write.
	 */
	content(tool: string, input: Readonly<Record<string, unknown>>): string | undefined {
		const reason = this.claude(tool, input);
		if (reason !== undefined) return reason;
		for (const { text, runs, code } of stringsIn(input)) {
			if (this.outOfTime) return OUT_OF_TIME;
			if (code) {
				const shell = this.shell(text);
				if (shell !== undefined) return shell;
			} else if (runs && text.length <= CHECK_MAX) {
				const named = this.named(text);
				if (named !== undefined) return named;
			}
			if (text.includes("*** ")) {
				const targets = headerTargets(text);
				const patch = targets.length > 0 ? this.writes(targets, text) : undefined;
				if (patch !== undefined) return patch;
			}
		}
		return undefined;
	}
}

/** The strings a list or a string holds, for glob's and grep's root: "undefined" and "null" are none to glob (glob.ts). */
const searchRoot = (path: unknown, glob: boolean): string =>
	typeof path === "string" && path !== "" && !(glob && (path === "undefined" || path === "null")) ? path : ".";

/**
 * Why an OpenCode tool call is refused, or undefined to let it through (module doc). `sessionID`: the call's session (a
 * session_move of another session places a relative folder from that session's own). The judgment has `judgeMs` (at
 * most 2 s): what it cannot judge in time is refused.
 */
export function openCodeGuard(tool: string, input: unknown, options: OpenCodeGuardOptions, sessionID?: string): string | undefined {
	let size: number;
	try {
		size = Buffer.byteLength(JSON.stringify(input ?? null) ?? "");
	} catch {
		return "Orrery could not read this call; nothing was run.";
	}
	if (size > OPENCODE_TOOL_INPUT_MAX) return CALL_TOO_LARGE;
	const judge = new Judge(options);
	if (judge.outOfTime) return OUT_OF_TIME;
	const shape = SHAPES[tool];
	// Any other tool goes by what it carries. A Code Mode program may call one with no input, or with a value that is no
	// object: judged by what it holds.
	if (shape === undefined) {
		const args = input === undefined || input === null ? {} : typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : { input };
		return judge.content(tool, args);
	}
	// A built-in tool's input as its schema has it, or OpenCode would not run it either; what else it carries (OpenCode
	// drops it, or a plugin renamed another tool to this name) goes by content.
	if (typeof input !== "object" || input === null || Array.isArray(input)) return CALL_UNREADABLE;
	const args = input as Readonly<Record<string, unknown>>;
	if (shape.required.some((key) => args[key] === undefined) || shape.strings.some((key) => args[key] !== undefined && typeof args[key] !== "string")) return CALL_UNREADABLE;
	const extra = Object.fromEntries(Object.entries(args).filter(([key]) => !shape.keys.includes(key)));
	const text = (key: string) => args[key] as string | undefined;
	const reason = byTool(tool, text, judge, sessionID);
	return reason ?? (Object.keys(extra).length === 0 ? undefined : judge.content(tool, extra));
}

const CALL_UNREADABLE = "Orrery could not read this call (its input is not what the tool takes); nothing was run.";

/**
 * OpenCode 2.0.30's built-in tools the guard judges by name, by their input schemas (tool/plugin/*.ts): the fields
 * OpenCode needs to run the tool, those that must be text, and every field the tool takes.
 */
const SHAPES: Readonly<Record<string, { readonly required: readonly string[]; readonly strings: readonly string[]; readonly keys: readonly string[] }>> = {
	shell: { required: ["command"], strings: ["command", "workdir"], keys: ["command", "workdir", "timeout", "background"] },
	read: { required: ["path"], strings: ["path"], keys: ["path", "offset", "limit"] },
	write: { required: ["path", "content"], strings: ["path", "content"], keys: ["path", "content"] },
	edit: { required: ["path", "oldString", "newString"], strings: ["path", "oldString", "newString"], keys: ["path", "oldString", "newString", "replaceAll"] },
	patch: { required: ["patchText"], strings: ["patchText"], keys: ["patchText"] },
	glob: { required: ["pattern"], strings: ["pattern", "path"], keys: ["pattern", "path", "hidden", "limit"] },
	grep: { required: ["pattern"], strings: ["pattern", "path", "include"], keys: ["pattern", "path", "include", "literal", "caseSensitive", "limit"] },
	webfetch: { required: ["url"], strings: ["url", "format"], keys: ["url", "format", "timeout"] },
	websearch: { required: ["query"], strings: ["query"], keys: ["query"] },
	opencode_session_move: { required: ["directory"], strings: ["directory", "sessionID"], keys: ["sessionID", "directory"] },
};

/** A built-in tool's own rule (module doc), its input read as its schema has it (`text`: a text field, or undefined). */
function byTool(tool: string, text: (key: string) => string | undefined, judge: Judge, sessionID: string | undefined): string | undefined {
	switch (tool) {
		case "shell":
			return judge.shell(text("command") as string) ?? judge.path("read", text("workdir") ?? ".");
		case "read":
			return judge.read(text("path") as string);
		case "write":
			return judge.path("write", text("path") as string, undefined, { whole: text("content") as string });
		case "edit":
			return judge.path("write", text("path") as string, undefined, { edits: [{ old: text("oldString") as string, new: text("newString") as string }] });
		case "patch": {
			const patch = text("patchText") as string;
			if (patch === "") return undefined;
			if (patch.length > CHECK_MAX) return "this patch is too long to check (over 64 KB); nothing was changed.";
			const read = readPatch(patch);
			if ("unreadable" in read) return PATCH_UNREADABLE(read.unreadable);
			return judge.writes([...read.targets, ...headerTargets(patch)], patch);
		}
		case "glob": {
			const root = searchRoot(text("path"), true);
			const pattern = text("pattern") as string;
			// Claude Code's Glob judges an absolute pattern's folder; OpenCode's searches the root whatever the pattern.
			return judge.claude("Glob", { pattern, path: root }) ?? (isAbsolute(pattern) ? judge.claude("LS", { path: root }) : undefined);
		}
		case "grep": {
			const include = text("include");
			return judge.claude("Grep", { pattern: text("pattern"), ...(include === undefined ? {} : { glob: include }), path: searchRoot(text("path"), false) });
		}
		case "webfetch": {
			const url = text("url") as string;
			return /^\s*file:/i.test(url) ? judge.claude("webfetch", { url }) : undefined;
		}
		case "opencode_session_move": {
			// OpenCode trims the folder, takes "~" from home and the rest from the moved session's folder (session/move.ts).
			const directory = (text("directory") as string).trim();
			const fromHome = directory === "~" || directory.startsWith("~/");
			const other = text("sessionID");
			if (other !== undefined && other !== sessionID && !isAbsolute(directory) && !fromHome) return OTHER_SESSION;
			return judge.path("read", directory);
		}
		default:
			return undefined;
	}
}

/**
 * A file's text after a unified diff (as OpenCode's write, edit and patch tools give it in their permission request:
 * `@@ -a,b +c,d @@` hunks of " ", "-" and "+" lines), applied to `before`; undefined when it doesn't apply as written.
 * Line ends are compared without their "\r".
 */
export function afterDiff(before: string, patch: string): string | undefined {
	const old = before.replace(/\r/g, "").split("\n");
	const out: string[] = [];
	let at = 0;
	let inHunk = false;
	for (const raw of patch.replace(/\r/g, "").split("\n")) {
		const header = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(raw);
		if (header !== null) {
			const start = Number(header[1]);
			const count = header[2] === undefined ? 1 : Number(header[2]);
			// An empty range names the line after which its lines go.
			const from = count === 0 ? start : start - 1;
			if (from < at || from > old.length) return undefined;
			out.push(...old.slice(at, from));
			at = from;
			inHunk = true;
			continue;
		}
		if (!inHunk || raw.startsWith("\\")) continue;
		const mark = raw[0];
		const text = raw.slice(1);
		if (mark === "+") out.push(text);
		else if (mark === " " || mark === "-") {
			if (old[at] !== text) return undefined;
			if (mark === " ") out.push(text);
			at++;
		} else if (raw !== "") inHunk = false;
	}
	if (!inHunk && at === 0 && out.length === 0) return undefined;
	out.push(...old.slice(at));
	return out.join("\n");
}

/** A file's text now (at most 1 MB, a byte-order mark dropped); "" for one that isn't there; undefined when it can't be read. */
function textNow(file: string): string | undefined {
	try {
		return readFileSync(file, "utf8").replace(/^\uFEFF/, "");
	} catch (error) {
		return (error as { code?: unknown }).code === "ENOENT" ? "" : undefined;
	}
}

/**
 * The second layer, on OpenCode's permission check (`ctx.permission.hook("evaluate")`, which runs as a tool asks leave,
 * with what it will touch as OpenCode itself placed it): a read's and an edit's resources (a path in the session's folder,
 * relative to it, or an absolute one) judged as reads and writes. It catches what changed after the first hook judged a
 * call (another plugin's hook may change its input), a file the read tool opens in place of a missing one, and a tool a
 * plugin renamed. An edit of a skill (guard-rules.ts openCodeSkillRefusal) is judged on the file OpenCode says it will
 * leave: the diff in the request's metadata (`files`), applied to the file as it is; a skill with no diff there, or one
 * that doesn't apply, is refused. Other actions (shell, external_directory, the searches…) are the first hook's.
 */
export function openCodePermission(action: string, resources: readonly unknown[], options: OpenCodeGuardOptions, metadata?: unknown): string | undefined {
	if (action !== "read" && action !== "edit") return undefined;
	const judge = new Judge(options);
	// A resource is placed as OpenCode wrote it: relative to the session's folder (a "~" there is a name), or absolute.
	const literal = (raw: string, cwd: string) => resolve(cwd, raw);
	const files = (metadata as { files?: unknown } | null | undefined)?.files;
	for (const resource of resources) {
		if (typeof resource !== "string") return "Orrery could not read what this tool asks leave for; nothing was run.";
		let written: NewText | undefined;
		const placed = literal(resource, options.cwd);
		if (action === "edit" && (openCodeSkillPath(placed) || openCodeSkillPath(realTarget(placed)))) {
			const file = Array.isArray(files) ? (files as { file?: unknown; patch?: unknown; status?: unknown }[]).find((each) => each?.file === resource) : undefined;
			const before = textNow(realTarget(placed));
			const after = file?.status === "deleted" ? "" : typeof file?.patch === "string" && before !== undefined ? afterDiff(before, file.patch) : undefined;
			written = after === undefined ? undefined : { whole: after };
		}
		const reason = judge.path(action === "read" ? "read" : "write", resource, literal, written);
		if (reason !== undefined) return reason;
	}
	return undefined;
}

/** A refusal as the model sees it, worded as the other gates word theirs. */
export function openCodeRefusal(reason: string): string {
	return `Orrery guard: ${reason}`;
}

// ---- The plugin's hooks ----

/**
 * How long the plugin's hook may take to answer one call, in ms, waiting for its rules included: OpenCode 2.0.30 has no
 * time limit on a hook (one that never answers holds the call until the person interrupts it), so past this the call
 * is refused (spec decision 4).
 */
export const GUARD_MS = 4000;

/** What the guard judges a session's calls by: the rules (an agent's, or no agent's), or none it can read. */
export type GuardRules = { readonly options: OpenCodeGuardOptions } | { readonly blind: string };

/** Why every call is refused when Orrery's config cannot be read (as Codex's guard says it). */
export const CONFIG_UNREADABLE = (why: string) => `Orrery's config could not be read (${why}), so no call can be checked; nothing was run. Fix the config file.`;

const NOT_IN_TIME = "this call could not be checked in time; nothing was run.";
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/\.+$/, "");

/** The call as OpenCode's execute.before hook gives it (only what the guard reads; each part is checked before use). */
export interface ToolCallEvent {
	readonly tool?: unknown;
	readonly sessionID?: unknown;
	readonly input?: unknown;
}

/** OpenCode's permission check as its evaluate hook gives it: setting effect "deny" with a message refuses the leave. */
export interface PermissionEvent {
	readonly action?: unknown;
	readonly resources?: unknown;
	/** What the tool will do, as OpenCode tells it: its write's, edit's or patch's diffs (`files`, each `{file, patch, status}`). */
	readonly metadata?: unknown;
	effect?: unknown;
	message?: unknown;
}

/**
 * The guard as the plugin's hooks run it: one per plugin (OpenCode makes one per folder). Its rules are set once, by the
 * plugin's start (decide); a call that comes before waits for them. Each call is answered within `ms` (GUARD_MS): late,
 * it is refused, and so is one whose judgment failed. Never throws.
 */
export class OpenCodeGuardHook {
	readonly #ms: number;
	readonly #rules: Promise<GuardRules>;
	#decide: ((rules: GuardRules) => void) | undefined;
	readonly #judge: typeof openCodeGuard;
	readonly #permit: typeof openCodePermission;

	constructor(options: { readonly ms?: number; readonly judge?: typeof openCodeGuard; readonly permit?: typeof openCodePermission } = {}) {
		this.#ms = options.ms ?? GUARD_MS;
		this.#judge = options.judge ?? openCodeGuard;
		this.#permit = options.permit ?? openCodePermission;
		this.#rules = new Promise((decide) => {
			this.#decide = decide;
		});
	}

	/** Sets the rules; the first call wins. */
	decide(rules: GuardRules): void {
		this.#decide?.(rules);
		this.#decide = undefined;
	}

	/** Whether the rules are set. */
	get decided(): boolean {
		return this.#decide === undefined;
	}

	/** `judge`'s answer for the rules, within the hook's time: a refusal (openCodeRefusal) or undefined to let it through. */
	async #answer(judge: (options: OpenCodeGuardOptions) => string | undefined): Promise<string | undefined> {
		const started = performance.now();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const late = new Promise<string>((done) => {
				timer = setTimeout(() => done(NOT_IN_TIME), this.#ms);
			});
			const judged = this.#rules.then((rules) => {
				if ("blind" in rules) return rules.blind;
				// What is left of the hook's time, for the rules' own budget (at most 2 s): a judgment that runs out refuses.
				return judge({ ...rules.options, judgeMs: this.#ms - (performance.now() - started) });
			});
			const reason = await Promise.race([judged, late]);
			// A judgment that held the thread past the hook's time is late too, whatever it found.
			if (performance.now() - started > this.#ms) return openCodeRefusal(NOT_IN_TIME);
			return reason === undefined ? undefined : openCodeRefusal(reason);
		} catch (error) {
			return openCodeRefusal(`this call could not be checked (${errorText(error)}); nothing was run.`);
		} finally {
			clearTimeout(timer);
		}
	}

	/** execute.before: the refusal for this call (throw it), or undefined. */
	beforeTool(event: ToolCallEvent): Promise<string | undefined> {
		const tool = typeof event?.tool === "string" ? event.tool : "";
		const sessionID = typeof event?.sessionID === "string" ? event.sessionID : undefined;
		return this.#answer((options) => (tool === "" ? "Orrery could not read this call; nothing was run." : this.#judge(tool, event.input, options, sessionID)));
	}

	/** permission evaluate: refuses the leave (effect "deny", with the reason) when the guard would. */
	async onPermission(event: PermissionEvent): Promise<void> {
		if (event.effect === "deny") return;
		const action = typeof event.action === "string" ? event.action : "";
		const resources = Array.isArray(event.resources) ? event.resources : [];
		const refusal = await this.#answer((options) => this.#permit(action, resources, options, event.metadata));
		if (refusal === undefined) return;
		event.effect = "deny";
		event.message = refusal;
	}
}
