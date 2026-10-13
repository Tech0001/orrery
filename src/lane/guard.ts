/**
 * A seatbelt, not a sandbox (spec §6).
 *
 * - write/edit must land inside the workspace and allowed roots.
 * - No file tool may touch ssh keys or credential stores.
 * - File paths are checked inside the tools themselves, resolved exactly the way pi's tools resolve them (`@`
 *   prefix, `~`, `file://`, relative to cwd) and then through symlinks, so the check and the write see the same file.
 *
 * Limits, by design:
 * - Shell commands cannot be parsed reliably, so bash only gets the sensitive-pattern check.
 * - A lane can still reach anything its OS account can. The real boundary is the account the tools run as.
 */

import { posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import { defineExtension, hook, type ToolRegistration, ToolTask, wrapTool } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { checkToolCall, type GuardOptions, sensitive, within } from "./guard-rules.ts";

export { checkToolCall, type GuardOptions };

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

/** Resolves symlinks along the longest existing prefix; the not-yet-existing tail is appended unchanged. */
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

/** The authoritative check: resolve like pi's tools, follow symlinks, then apply the rules. */
export async function checkResolvedPath(
	env: ExecutionEnv,
	path: string,
	mode: "read" | "write",
	options: GuardOptions,
	context: Context,
): Promise<string | undefined> {
	const resolved = await env.absolutePath(toolPath(path), context);
	if (!resolved.ok) return undefined; // The tool itself will fail on this path.
	const target = mode === "read" ? await readTarget(env, resolved.value, context) : resolved.value;
	const real = await realPath(env, target, context);
	if (sensitive(target) || sensitive(real)) return `${real} is a sensitive file (ssh keys or credentials).`;
	if (mode === "write") {
		const roots = await Promise.all([options.workspace, ...options.allowedRoots].map((root) => realPath(env, root, context)));
		if (!roots.some((root) => within(real, root))) return `${real} is outside this lane's workspace and allowed roots.`;
	}
	return undefined;
}

function guarded<T extends ToolRegistration>(tool: T, mode: "read" | "write", options: GuardOptions): T {
	const execute: T["execute"] = async (args, api, context) => {
		const path = (args as { path?: unknown }).path;
		if (typeof path === "string" && api.env !== undefined) {
			const reason = await checkResolvedPath(api.env, path, mode, options, context);
			if (reason !== undefined) throw new Error(`Blocked: ${reason}`);
		}
		return tool.execute(args, api, context);
	};
	return { ...tool, execute };
}

export function guardExtension(options: GuardOptions) {
	return defineExtension({
		name: "lane-guard",
		hooks: [
			hook(ToolTask, {
				beforeTool: (call) => {
					const reason = checkToolCall({ name: call.name, arguments: call.arguments }, options);
					return reason === undefined ? undefined : { block: reason };
				},
			}),
		],
		wraps: [
			wrapTool(createWriteTool() as ToolRegistration, (tool) => guarded(tool, "write", options)),
			wrapTool(createEditTool() as ToolRegistration, (tool) => guarded(tool, "write", options)),
			wrapTool(createReadTool() as ToolRegistration, (tool) => guarded(tool, "read", options)),
		],
	});
}
