/**
 * The agent guard on Claude Code's tool calls (spec §4 PreToolUse). Claude Code's tool inputs are mapped onto the
 * checks pi's tool calls get (src/agent/guard-paths.ts over src/agent/guard-rules.ts):
 * - Read, Write, Edit, MultiEdit and NotebookEdit name one file;
 * - Grep and Glob search a folder: the cwd by default, or the folder an absolute Glob pattern starts with;
 * - Bash is judged by its command, and so is any other tool's command line, at any depth: a command, cmd, script or
 *   shell string, or a command, cmd, script, shell, args or argv list (Monitor, PowerShell, an MCP shell);
 * - any tool, MCP tools included, is judged by every path it names (file_path, notebook_path, path, filePath,
 *   file_paths, out_dir, source, destination and the like, at any depth), and by any file: URI outside what a tool
 *   writes;
 * - those paths are writes for Write, Edit, MultiEdit and NotebookEdit and for any other tool named for writing
 *   (mcp__fs__write_file, move_file, create_directory), else reads;
 * - a destination (out_dir, output_path, dest, destination, target, save_path) is a write in every tool;
 * - every string that starts like a path (/, ~/, ./, ../) is also read, in every tool, whatever its key: one line of
 *   at most 4096 characters once normalized, and not what a tool writes (content, new_source, old_string,
 *   new_string);
 * - a command line, Grep glob, Glob pattern or path over 64 KB is refused before any pattern runs on it, and a call
 *   that names more than can be judged in 2 s is refused, since a hook that times out lets it through.
 * What differs from pi:
 * - paths resolve as Claude Code resolves them (claudeToolPath), not as pi does, unless the caller says otherwise (Codex's
 *   gate, src/codex/guard.ts, which judges Codex's tools through this one);
 * - Claude Code's login files are credentials too;
 * - the PreToolUse hook adds Claude Code's own state to the roots an agent may write (claudeStateRoots, ruling C10).
 * In a session that is no agent's (orreryOnly, spec 2026-10-19-no-agent-sessions §3) only Orrery's own rules apply: not
 * Claude Code's login, nor OpenCode's config and skills in a tool Orrery doesn't know. The caps on what can be judged in
 * time (64 KB, the time budget, PATH_MAX) stay.
 */

import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { guardToolCall, openCodeOf, type PathGuardOptions, realTarget } from "../agent/guard-paths.ts";
import { NEW_TEXT, type NewText, OPENCODE_READ_ONLY, openCodeLoads, openCodeSkillPath, SKILL_UNSEEN } from "../agent/guard-rules.ts";
import { ownFolder } from "../agent/private-file.ts";

/** Claude Code's tool names as pi's guard knows them. */
const AS_PI: Readonly<Record<string, string>> = {
	Read: "read",
	Write: "write",
	Edit: "edit",
	MultiEdit: "edit",
	NotebookEdit: "edit",
	Grep: "grep",
	Glob: "find",
	LS: "ls",
	Bash: "bash",
};

/**
 * An argument that names files, by its key: file_path, notebook_path, path, filePath, file_paths, files, out_dir, cwd,
 * and a copy's or move's source and destination. Not url, prompt, command, content or new_source, which are not files.
 */
const PATH_KEY = /(path|paths|file|files|file_?name|dir|dirs|directory|folder|root|cwd)$|^(source|src|dest|destination|target)$/i;

/** A tool the guard does not know that writes, by the verb in its name (the last part of an MCP tool's). */
const WRITE_VERB = /(write|edit|create|save|move|copy|rename|delete|remove|append|mkdir)/i;

/** An argument that names where a tool writes, by its key: a write in every tool, whatever the tool's name. */
const DESTINATION_KEY = /^(out_?dir|output(_?(dir|path|file))?|dest|destination|target|save_?path)$/i;

/** A string that starts like a path: absolute, home, or relative to the cwd. */
const PATH_LIKE = /^(\/|~\/|\.\/|\.\.\/)/;

/** What a tool writes, which may start like a path without being one. */
const CONTENT_KEY = /^(content|new_source|old_string|new_string)$/i;

/**
 * Linux's PATH_MAX: no file has a longer path. A string over it is text, and a declared path over it is refused at
 * once (realTarget walks a path one folder at a time, and tens of thousands of folders overflow its stack).
 */
const PATH_MAX = 4096;

/**
 * A string that may be a path: one line, at most PATH_MAX characters once normalized (the tool opens the normalized
 * path, so padding like x/../ hides nothing).
 */
const oneLine = (text: string) => !/[\r\n]/.test(text) && normalize(text).length <= PATH_MAX;

/**
 * How long the guard may judge one call. Claude Code lets a call through when the hook times out (the plugin's
 * PreToolUse timeout is 10 s), and realTarget takes about 0.3 s for a missing path 2000 folders deep, so a call that
 * names more than can be judged in time is refused.
 */
export const JUDGE_MS = 2000;

/**
 * The longest text the guard runs its patterns on: 64 KB (65,536 characters) of a command line, a Grep glob, a Glob
 * pattern or a path. pi's patterns (guard-rules.ts) take time that grows faster than the text: through the hook, 0.36 s
 * at 64 KB and 4.9 s at 256 KB. Longer text is refused before any pattern sees it. What a tool writes is never
 * pattern-checked, so it has no cap here; the hook's whole input has one (TOOL_INPUT_MAX, hooks.ts).
 */
const CHECK_MAX = 64 * 1024;
const TOO_LONG = (what: string) => `${what} is too long to check (over 64 KB); nothing was run.`;

/** A command line, by its key: a string under SHELL_TEXT, a list under SHELL_LIST (args as a string is text). */
const SHELL_TEXT = /^(command|cmd|script|shell)$/i;
const SHELL_LIST = /^(command|cmd|script|shell|args|argv)$/i;

/** Claude Code's login, by name: ~/.claude.json (OAuth account, API key, MCP servers' env) and its backups. */
const CLAUDE_LOGIN = /(^|[\s"'=:/~])\.claude\.json\b/;
const loginNamed = (text: string) => CLAUDE_LOGIN.test(text.toLowerCase());
const LOGIN_FILE = (path: string) => `${path} is a sensitive file (Claude Code's login).`;

/** Claude Code's login files under a home folder; .credentials.json holds its OAuth tokens. */
function claudeLoginFiles(home: string): string[] {
	return [join(home, ".claude.json"), join(home, ".claude", ".credentials.json"), join(home, ".claude", "backups")];
}

/** Claude Code's login files in a config folder CLAUDE_CONFIG_DIR moves away from ~/.claude. */
export function movedConfigDirCredentials(env: NodeJS.ProcessEnv): string[] {
	const dir = env.CLAUDE_CONFIG_DIR;
	if (!dir) return [];
	const config = resolve(dir);
	return [join(config, ".claude.json"), join(config, ".credentials.json"), join(config, "backups")];
}

/** The local file a file: URI names (file:///…, or file:/… without the //; an MCP resource, say), or undefined. */
function fileUriPath(text: string): string | undefined {
	const uri = text.trim();
	if (!/^file:\S*$/i.test(uri)) return undefined;
	try {
		return fileURLToPath(uri);
	} catch {
		return undefined; // another host's file, or no URI at all
	}
}

/**
 * Mirrors Claude Code's expandPath (2.1.291), which its file tools, Grep and Glob call on a path: trimmed, "~" and
 * "~/…" to the home folder, an absolute path normalized, anything else resolved against the cwd. Unlike pi's, it
 * keeps a leading "@", "file://" and unicode spaces as they are, so a folder link spelled that way is where the
 * file lands.
 */
export function claudeToolPath(raw: string, cwd: string, home: string = homedir()): string {
	const path = raw.trim();
	if (path === "") return normalize(cwd);
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	return isAbsolute(path) ? normalize(path) : resolve(cwd, path);
}

/**
 * The folder Claude Code's Glob searches for an absolute pattern: the fixed folders before the first wildcard, or
 * the pattern's folder when it has none. A relative pattern searches `path`, or the cwd.
 */
function globRoot(pattern: string): string | undefined {
	if (!isAbsolute(pattern)) return undefined;
	const wild = pattern.search(/[*?[{]/);
	if (wild === -1) return dirname(pattern);
	return pattern.slice(0, pattern.lastIndexOf("/", wild)) || "/";
}

/** What a tool's input names, for the guard. */
interface Named {
	/** Strings under a path-like key, at any depth, the strings in a list or map under one, and file: URIs. */
	readonly paths: string[];
	/** Strings under a destination key, and in a list or map under one. */
	readonly destinations: string[];
	/** Every string that starts like a path, whatever its key, but for what a tool writes (oneLine). */
	readonly pathLike: string[];
	/** Command lines: strings under a command key, and lists under one joined with spaces. */
	readonly commands: string[];
	/** Every string of one word (no blank) with a ".", "/" or "~", whatever its key, but for what a tool writes: a path may be one. */
	readonly words: string[];
}

/**
 * Walks a tool's input, at any depth, for what it names (Named). Under a path or destination key's list or map, a
 * string counts only if it may be a path (oneLine): the rest is text or data.
 */
function named(input: Readonly<Record<string, unknown>>): Named {
	const found: Named = { paths: [], destinations: [], pathLike: [], commands: [], words: [] };
	const stack: { key: string; value: unknown; under: boolean; into: boolean }[] = Object.entries(input).map(([key, value]) => ({ key, value, under: false, into: false }));
	for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
		const { key, value } = next;
		const pathKey = PATH_KEY.test(key);
		const destinationKey = DESTINATION_KEY.test(key);
		if (typeof value === "string") {
			const text = value.trim();
			if (SHELL_TEXT.test(key)) found.commands.push(value);
			if (value !== "" && (pathKey || (next.under && oneLine(text)))) found.paths.push(value);
			if (value !== "" && (destinationKey || (next.into && oneLine(text)))) found.destinations.push(value);
			if (!CONTENT_KEY.test(key) && oneLine(text) && PATH_LIKE.test(text)) found.pathLike.push(value);
			if (!CONTENT_KEY.test(key) && /[./~]/.test(text) && !/\s/.test(text) && text.length <= PATH_MAX) found.words.push(text);
			const local = CONTENT_KEY.test(key) ? undefined : fileUriPath(value);
			if (local !== undefined) found.paths.push(local);
		} else if (typeof value === "object" && value !== null) {
			if (Array.isArray(value) && SHELL_LIST.test(key)) found.commands.push(value.filter((item) => typeof item === "string").join(" "));
			for (const [inner, item] of Object.entries(value)) {
				stack.push({ key: inner, value: item, under: next.under || pathKey, into: next.into || destinationKey });
			}
		}
	}
	return found;
}

/**
 * pi's judgment of one call (guardToolCall), then Claude Code's login by name: in a search's names, or in the path. Not
 * in a session that is no agent's (orreryOnly): Claude Code's login is no file of Orrery's.
 */
function judge(tool: string, args: Readonly<Record<string, unknown>>, options: PathGuardOptions & { readonly home: string }): string | undefined {
	const reason = guardToolCall(tool, args, options);
	if (reason !== undefined || options.orreryOnly === true) return reason;
	const nameKey = tool === "grep" ? "glob" : tool === "find" ? "pattern" : undefined;
	const names = nameKey === undefined ? undefined : args[nameKey];
	if (typeof names === "string" && loginNamed(names)) return `${tool} ${nameKey} "${names}" names sensitive files (Claude Code's login).`;
	const raw = args.path;
	if (typeof raw !== "string" || raw === "") return undefined;
	// All three forms, as guardToolCall checks them: what the model wrote, where the tool resolves it, where it lands.
	const resolved = (options.resolvePath ?? claudeToolPath)(raw, options.cwd, options.home);
	return [raw, resolved, realTarget(resolved)].some(loginNamed) ? LOGIN_FILE(raw) : undefined;
}

/**
 * judge, but a path longer than any path can be is refused before anything walks it, and one too long to check
 * (padded: it may resolve short) before any pattern runs on it.
 */
function judgeBounded(tool: string, args: Readonly<Record<string, unknown>>, options: PathGuardOptions & { readonly home: string }): string | undefined {
	const raw = args.path;
	if (typeof raw === "string" && (options.resolvePath ?? claudeToolPath)(raw, options.cwd, options.home).length > PATH_MAX) {
		return `${raw.slice(0, 60)}… is longer than a path can be (${PATH_MAX} characters); nothing was checked.`;
	}
	if (typeof raw === "string" && raw.length > CHECK_MAX) return TOO_LONG(`${raw.slice(0, 60)}…`);
	return judge(tool, args, options);
}

/**
 * Where a Claude Code tool call runs, for the guard (PathGuardOptions), and how long the guard may judge it. Paths
 * resolve as Claude Code resolves them unless `resolvePath` says otherwise (Codex's apply_patch and view_image,
 * src/codex/guard.ts).
 */
export interface ClaudeGuardOptions extends PathGuardOptions {
	/** The time the guard may take to judge one call, in ms (default 2000): a call it cannot judge in time is refused. */
	readonly judgeMs?: number;
}

/**
 * Why the call is refused, or undefined to let it through. In a session that is no agent's (orreryOnly) Orrery's own
 * rules alone: Claude Code's login and the rules for OpenCode's config and skills are an agent's.
 */
export function claudeGuard(toolName: string, input: Readonly<Record<string, unknown>>, options: ClaudeGuardOptions): string | undefined {
	const { judgeMs = JUDGE_MS, ...where } = options;
	const deadline = performance.now() + judgeMs;
	const home = where.home ?? homedir();
	const agent = where.orreryOnly !== true;
	const guard = { ...where, home, credentials: [...(where.credentials ?? []), ...(agent ? claudeLoginFiles(home) : [])], resolvePath: where.resolvePath ?? claudeToolPath };
	const found = named(input);
	const as = AS_PI[toolName];
	// Text too long to check in time is refused before any pattern runs (paths in judgeBounded).
	if (found.commands.some((command) => command.length > CHECK_MAX)) return TOO_LONG("a command line");
	const nameKey = as === "grep" ? "glob" : as === "find" ? "pattern" : undefined;
	const names = nameKey === undefined ? undefined : input[nameKey];
	if (typeof names === "string" && names.length > CHECK_MAX) return TOO_LONG(`${toolName}'s ${nameKey}`);
	// A command line, whatever tool runs it.
	for (const command of found.commands) {
		if (performance.now() >= deadline) return "this call has more command lines than the guard can check in time; nothing was run.";
		const reason = guardToolCall("bash", { command }, guard) ?? (agent && loginNamed(command) ? "This command touches sensitive files (Claude Code's login)." : undefined);
		if (reason !== undefined) return reason;
	}
	if (as === "grep") return judgeBounded("grep", { pattern: input.pattern, glob: input.glob, path: input.path }, guard);
	if (as === "find") {
		const root = typeof input.pattern === "string" ? globRoot(input.pattern) : undefined;
		return judgeBounded("find", { pattern: input.pattern, path: root ?? input.path }, guard);
	}
	if (as === "ls") return judgeBounded("ls", { path: input.path }, guard);
	const verb = as === undefined && WRITE_VERB.test(toolName.split("__").at(-1) ?? toolName);
	const mode = as === "write" || as === "edit" ? as : verb ? "write" : "read";
	// A path-looking string is a read in every tool; a path key keeps the tool's mode, and a destination is a write.
	// Later entries win for the same string.
	const how = new Map<string, string>([
		...found.pathLike.map((path) => [path, "read"] as const),
		...found.paths.map((path) => [path, mode] as const),
		...found.destinations.map((path) => [path, "write"] as const),
	]);
	// What a write puts in its file, for the rule on a skill's front matter (guard-rules.ts openCodeSkillRefusal); a
	// destination's (a copy's or a move's) is the file it takes, which the guard can't see.
	const written = newTextOf(toolName, input);
	const destinations = new Set(found.destinations);
	for (const [path, use] of how) {
		if (performance.now() >= deadline) return "this call names more paths than the guard can check in time; nothing was run.";
		const reason = judgeBounded(use, use === "read" ? { path } : { path, [NEW_TEXT]: destinations.has(path) ? undefined : written }, guard);
		if (reason !== undefined) return reason;
	}
	// A tool Orrery doesn't know, named neither for writing nor only for reading, may write what it names, under any key:
	// OpenCode's config and code (guard-rules.ts openCodeLoads), which no tool may write, are refused by every string
	// that may be a path.
	const last = toolName.split("__").at(-1) ?? toolName;
	if (agent && as === undefined && !verb && !READS_ONLY.test(last)) {
		const openCode = openCodeOf(guard, home);
		for (const text of new Set([...how.keys(), ...found.words])) {
			if (performance.now() >= deadline) return "this call names more paths than the guard can check in time; nothing was run.";
			const resolved = guard.resolvePath(text, guard.cwd, home);
			if (resolved.length > PATH_MAX) continue;
			const real = realTarget(resolved);
			if (openCodeLoads(resolved, openCode) || openCodeLoads(real, openCode)) return OPENCODE_READ_ONLY(text);
			if (openCodeSkillPath(resolved) || openCodeSkillPath(real)) return SKILL_UNSEEN(text);
		}
	}
	return undefined;
}

/**
 * What a write puts in its file, as far as the call shows (guard-rules.ts NewText): a gate's own (NEW_TEXT, Codex's and
 * OpenCode's), Write's whole content, Edit's and MultiEdit's exact replacements; undefined for anything else (a notebook
 * cell, a tool named for writing), which the skills rule refuses.
 */
function newTextOf(toolName: string, input: Readonly<Record<string, unknown>>): NewText | undefined {
	if (NEW_TEXT in input) return (input as { readonly [NEW_TEXT]?: NewText })[NEW_TEXT];
	if (toolName === "Write") return typeof input.content === "string" ? { whole: input.content } : undefined;
	const edits = toolName === "Edit" ? [input] : toolName === "MultiEdit" && Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : [];
	if (edits.length === 0 || !edits.every((edit) => typeof edit?.old_string === "string" && typeof edit.new_string === "string")) return undefined;
	return { edits: edits.map((edit) => ({ old: edit.old_string as string, new: edit.new_string as string })) };
}

/** A tool that only reads, by the verb in its name (no download among them): it may name OpenCode's config to read it. */
const READS_ONLY = /^(?!.*download)(?=.*(read|get|view|list|cat|show|search|find|grep|glob|stat|head|tail|fetch|inspect|describe|info|query|look))/i;

/**
 * The folder Claude Code keeps a project's state in under ~/.claude/projects: the project folder with every
 * character but a letter or digit made "-" (its sanitizePath). Past 200 characters Claude Code shortens the name and
 * adds a hash orrery does not compute, so there is none (writes there stay refused).
 */
export function claudeProjectFolder(projectDir: string): string | undefined {
	const name = projectDir.replace(/[^a-zA-Z0-9]/g, "-");
	return name === "" || name.length > 200 ? undefined : name;
}

/**
 * Claude Code's own per-user state, which an agent may write (ruling C10): this project's folder under
 * ~/.claude/projects (its auto memory), ~/.claude/plans, and the session scratch root <temp>/claude-<uid>, where temp
 * is Claude Code's own: CLAUDE_CODE_TMPDIR, else TMPDIR, else /tmp (a relative one is skipped).
 * - The guard follows a root's links, so a root planted as a link (to home, say) would open its target to writes.
 *   So ~/.claude's folders count when they are real folders of this user's, or not there yet (ownFolder); the
 *   scratch root, under a temp folder others can write, only when it already is one.
 * - A root that cannot be checked is left out.
 */
export function claudeStateRoots(projectDir: string, home: string, env: NodeJS.ProcessEnv): string[] {
	const folder = claudeProjectFolder(projectDir);
	const tmp = [env.CLAUDE_CODE_TMPDIR, env.TMPDIR].find((dir) => dir !== undefined && isAbsolute(dir)) ?? "/tmp";
	const uid = process.getuid?.();
	const ours = (root: string, missing: boolean) => {
		try {
			return (ownFolder(root) ?? missing) === true;
		} catch {
			return false;
		}
	};
	return [
		...(folder === undefined ? [] : [join(home, ".claude", "projects", folder)]),
		join(home, ".claude", "plans"),
	]
		.filter((root) => ours(root, true))
		.concat(uid === undefined ? [] : [join(tmp, `claude-${uid}`)].filter((root) => ours(root, false)));
}
