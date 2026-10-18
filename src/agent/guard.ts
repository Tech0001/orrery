/**
 * A seatbelt, not a sandbox (spec §6).
 *
 * - write/edit must land inside the folder and allowed roots, and never in Orrery's config or installed program.
 * - No file tool may touch ssh keys or credential stores (tool logins under home such as ~/.npmrc among them), .env
 *   files and the other built-in secret names, what the config's [guard] protect names, or another agent's memory view
 *   (GuardOptions.foreignViews).
 * - File paths are checked inside the tools themselves, resolved exactly the way pi's tools resolve them (`@`
 *   prefix, `~`, `file://`, relative to cwd) and then through symlinks, so the check and the write see the same file.
 *
 * Limits, by design:
 * - Shell commands cannot be parsed reliably, so bash only gets the sensitive-pattern check.
 * - An agent can still reach anything its OS account can. The real boundary is the account the tools run as.
 * - No search-root rule here: a grep or find over a folder holding a credential store or another agent's view is not
 *   refused (pi's, OMP's and Claude Code's guards refuse it; src/agent/guard-paths.ts).
 * - A hard link to another agent's view is another name for the same file; links are not counted.
 * - A dangling link is not followed (realPath below stops where nothing resolves, so the link's own path stands for
 *   it): a write through one in the work area, pointing into Orrery's installed program (app/) or outside the roots,
 *   is judged by the link's path and goes through, making the target. pi's, OMP's and Claude Code's guards read where
 *   such a link points (src/agent/guard-paths.ts realTarget).
 */

import { homedir } from "node:os";
import { posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import { defineExtension, hook, type ToolRegistration, ToolTask, wrapTool } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import {
	APP_READ_ONLY,
	CONFIG_READ_ONLY,
	checkToolCall,
	foldName,
	type GuardOptions,
	inOrreryHome,
	type NewText,
	OPENCODE_READ_ONLY,
	openCodeLoads,
	openCodeRule,
	openCodeSkillPath,
	openCodeSkillRefusal,
	piNewText,
	orreryAppNamed,
	orreryConfigNamed,
	PROTECTED_FILE,
	pathProtected,
	protection,
	secretPath,
	sensitive,
	viewRules,
	within,
} from "./guard-rules.ts";

export { checkToolCall, type GuardOptions };

/**
 * The durable harness's guard: the agent's roots, plus orrery's credentials file and home (data_dir) when known, and
 * the config's [guard] protect (GuardOptions.protect).
 */
export interface DurableGuardOptions extends GuardOptions {
	readonly credentials?: readonly string[];
	readonly orreryData?: string;
	/** The home "~/" in [guard] protect and the built-in home secrets are under; default: the OS's. */
	readonly home?: string;
}

/** The pre-check on every tool call (checkToolCall), [guard] protect and the built-in home secrets from options.home. */
export function durablePreCheck(call: { readonly name: string; readonly arguments: Readonly<Record<string, unknown>> }, options: DurableGuardOptions): string | undefined {
	return checkToolCall(call, options, undefined, undefined, protection(options.protect, options.home ?? homedir()));
}

// Mirrors pi-durable's normalizeToolPath (tools/path-utils): unicode spaces become spaces, a leading "@" is dropped.
const UNICODE_SPACES = /[  -   　]/g;

function toolPath(path: string): string {
	const normalized = path.replace(UNICODE_SPACES, " ");
	return normalized.startsWith("@") ? normalized.slice(1) : normalized;
}

const NARROW_NO_BREAK_SPACE = "\u202F";

/** Mirrors pi-durable's resolveReadToolPath: the read tool opens the first spelling variant that exists. */
async function readTarget(env: ExecutionEnv, resolved: string, context: Context): Promise<string> {
	const variants = [
		resolved,
		resolved.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`),
		resolved.normalize("NFD"),
		resolved.replace(/'/g, "\u2019"),
		resolved.normalize("NFD").replace(/'/g, "\u2019"),
	];
	for (const variant of new Set(variants)) {
		const exists = await env.exists(variant, context);
		if (exists.ok && exists.value) return variant;
	}
	return resolved;
}

/**
 * Resolves symlinks along the longest existing prefix; the not-yet-existing tail is appended unchanged. A dangling link
 * is part of that tail: it is not read (a known limit, above), so the path it points to is not judged.
 */
async function realPath(env: ExecutionEnv, absolute: string, context: Context): Promise<string> {
	const rest: string[] = [];
	let current = absolute;
	for (;;) {
		const result = await env.canonicalPath(current, context);
		if (result.ok) return rest.length === 0 ? result.value : posix.join(result.value, ...rest.reverse());
		const parent = posix.dirname(current);
		if (parent === current) return absolute;
		rest.push(posix.basename(current));
		current = parent;
	}
}

/**
 * The authoritative check: resolve like pi's tools, follow symlinks, then apply the rules. `written`: what a write puts
 * in the file (guard-rules.ts NewText), for the rule on a skill's front matter; undefined: unseen.
 */
export async function checkResolvedPath(
	env: ExecutionEnv,
	path: string,
	mode: "read" | "write",
	options: DurableGuardOptions,
	context: Context,
	written?: NewText,
): Promise<string | undefined> {
	const resolved = await env.absolutePath(toolPath(path), context);
	if (!resolved.ok) return undefined; // The tool itself will fail on this path.
	const target = mode === "read" ? await readTarget(env, resolved.value, context) : resolved.value;
	const real = await realPath(env, target, context);
	const refused = `${real} is a sensitive file (keys, credentials or Orrery's private data).`;
	// Which view files the path may be (GuardOptions.foreignViews): the session's own, as given and where it really is.
	const views = viewRules(options, options.ownView === undefined ? [] : [options.ownView, await realPath(env, options.ownView, context)]);
	if (sensitive(target, views.path(target)) || sensitive(real, views.path(real))) return refused;
	const lower = real.toLowerCase();
	for (const credential of options.credentials ?? []) if (within(lower, (await realPath(env, credential, context)).toLowerCase())) return refused;
	// The built-in home secrets (~/.npmrc, ~/.azure and the like): where they are, as written, and where they really are.
	const protect = protection(options.protect, options.home ?? homedir());
	if (secretPath(target, protect) || secretPath(real, protect)) return refused;
	const secrets = await Promise.all(protect.secrets.map((secret) => realPath(env, secret, context)));
	if (secrets.some((secret) => within(lower, secret.toLowerCase()))) return refused;
	// [guard] protect ("~" is options.home, by default the OS's): inside a path entry, where it is or where it really is,
	// or with a part a name entry names.
	for (const entry of protect.paths) if (within(foldName(real), foldName(await realPath(env, entry.path, context)))) return PROTECTED_FILE(real);
	if (pathProtected(target, protect) !== undefined || pathProtected(real, protect) !== undefined) return PROTECTED_FILE(real);
	// Another agent's view file, as given and where it really is.
	for (const view of options.foreignViews) {
		if (within(lower, view.toLowerCase()) || within(lower, (await realPath(env, view, context)).toLowerCase())) return `${real} is another agent's memory view.`;
	}
	const data = options.orreryData === undefined ? undefined : await realPath(env, options.orreryData, context);
	if (data !== undefined && inOrreryHome(real, data)) return refused;
	if (mode === "write") {
		// Orrery's config is read, never written: an agent's view and these rules come from it.
		if (orreryConfigNamed(target) || orreryConfigNamed(real) || (data !== undefined && lower === posix.join(data, "config.toml").toLowerCase())) return CONFIG_READ_ONLY(real);
		const config = options.configFile === undefined ? [] : [options.configFile, await realPath(env, options.configFile, context)];
		if (config.some((file) => lower === posix.normalize(file).toLowerCase())) return CONFIG_READ_ONLY(real);
		// So is Orrery's installed program (app/).
		if (orreryAppNamed(target) || orreryAppNamed(real) || (data !== undefined && within(lower, posix.join(data, "app").toLowerCase()))) return APP_READ_ONLY(real);
		// OpenCode's config and code (guard-rules.ts openCodeLoads), where the tool writes and where that really is.
		const openCode = options.openCode ?? openCodeRule(process.env, options.home ?? homedir());
		if (openCodeLoads(target, openCode) || openCodeLoads(real, openCode)) return OPENCODE_READ_ONLY(real);
		// A skill OpenCode loads: not with front matter it may run as code (guard-rules.ts), an edit judged on the file it
		// would leave, read where the tool runs.
		if (openCodeSkillPath(target) || openCodeSkillPath(real)) {
			const now = await env.readTextFile(real, context);
			const skill = openCodeSkillRefusal(target, real, written, now.ok ? now.value : undefined);
			if (skill !== undefined) return skill;
		}
		const roots = await Promise.all([options.folder, ...options.allowedRoots].map((root) => realPath(env, root, context)));
		if (!roots.some((root) => within(real, root))) return `${real} is outside this agent's folder and allowed roots.`;
	}
	return undefined;
}

function guarded<T extends ToolRegistration>(tool: T, kind: "read" | "write" | "edit", options: DurableGuardOptions): T {
	const mode = kind === "read" ? "read" : "write";
	const execute: T["execute"] = async (args, api, context) => {
		const path = (args as { path?: unknown }).path;
		if (typeof path === "string" && api.env !== undefined) {
			const reason = await checkResolvedPath(api.env, path, mode, options, context, kind === "read" ? undefined : piNewText(kind, args as Record<string, unknown>));
			if (reason !== undefined) throw new Error(`Blocked: ${reason}`);
		}
		return tool.execute(args, api, context);
	};
	return { ...tool, execute };
}

export function guardExtension(options: DurableGuardOptions) {
	return defineExtension({
		name: "lane-guard",
		hooks: [
			hook(ToolTask, {
				beforeTool: (call) => {
					const reason = durablePreCheck({ name: call.name, arguments: call.arguments }, options);
					return reason === undefined ? undefined : { block: reason };
				},
			}),
		],
		wraps: [
			wrapTool(createWriteTool() as ToolRegistration, (tool) => guarded(tool, "write", options)),
			wrapTool(createEditTool() as ToolRegistration, (tool) => guarded(tool, "edit", options)),
			wrapTool(createReadTool() as ToolRegistration, (tool) => guarded(tool, "read", options)),
		],
	});
}
