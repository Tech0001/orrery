/**
 * Whether Orrery's side loads in a tool, asked once per version of the tool and of Orrery, without a model call:
 * Codex's hooks (src/codex/check.ts) and OpenCode's plugin (src/opencode/check.ts). The last result is kept in Orrery's
 * home, in <tool>-check.json, with the tool's version under the tool's own key ({"codex": "0.162.1", …}).
 */

import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { orreryHome } from "./home.ts";
import { writePrivate } from "./private-file.ts";

export type LoadCheck = { readonly ok: true } | { readonly ok: false; readonly why: string };

/** What the person is asked when Orrery's side doesn't load in `tool` (default no): a yes starts the tool without Orrery. */
export const withoutOrreryQuestion = (tool: string): string => `Start ${tool} without Orrery anyway? The session won't be recorded and the guard will be off.`;
/** What is said when they say yes. */
export const withoutOrrerySaid = (tool: string): string => `Starting ${tool} without Orrery: this session isn't recorded and the guard is off.`;

/** The last check: the tool's version, Orrery's version that checked, and what it found. */
export interface LoadCheckState {
	readonly version: string;
	readonly orrery: string;
	readonly ok: boolean;
	readonly why?: string;
	readonly at: string;
}

/** Where the tool's check is kept (`codex-check.json`), where Orrery's home really is (a home that is a link keeps it too). */
function stateFile(env: NodeJS.ProcessEnv, file: string): string {
	const home = orreryHome(env);
	try {
		return join(realpathSync(home), file);
	} catch {
		return join(home, file);
	}
}

/** The last check kept in `file`, the tool's version under `key`; undefined when there is none or it cannot be read. */
export function readLoadCheck(env: NodeJS.ProcessEnv, file: string, key: string): LoadCheckState | undefined {
	try {
		const read = JSON.parse(readFileSync(stateFile(env, file), "utf8")) as Record<string, unknown> | null;
		const version = read?.[key];
		if (typeof version !== "string" || typeof read?.orrery !== "string" || typeof read.ok !== "boolean") return undefined;
		return { version, orrery: read.orrery, ok: read.ok, ...(typeof read.why === "string" ? { why: read.why } : {}), at: typeof read.at === "string" ? read.at : "" };
	} catch {
		return undefined;
	}
}

/** Keeps the check's result. One that cannot be written is not fatal: the next launch checks again. */
function writeLoadCheck(env: NodeJS.ProcessEnv, file: string, key: string, state: LoadCheckState): void {
	const { version, ...rest } = state;
	try {
		writePrivate(stateFile(env, file), `${JSON.stringify({ [key]: version, ...rest }, null, 2)}\n`, { keepFolderMode: true });
	} catch {
		// not kept
	}
}

/**
 * Ok at once when this tool version was verified by this Orrery version (kept in `file`), else `probe`'s answer, kept
 * for next time when the version is known (an unknown one is asked at every launch). `onCheck` hears when it asks.
 */
export async function versionedCheck(
	version: string | undefined,
	options: { readonly env: NodeJS.ProcessEnv; readonly orrery: string; readonly file: string; readonly key: string; readonly now?: () => number; readonly onCheck?: () => void },
	probe: () => Promise<LoadCheck>,
): Promise<LoadCheck> {
	const saved = readLoadCheck(options.env, options.file, options.key);
	if (version !== undefined && saved?.ok === true && saved.version === version && saved.orrery === options.orrery) return { ok: true };
	options.onCheck?.();
	const result = await probe();
	if (version !== undefined) {
		const at = new Date((options.now ?? Date.now)()).toISOString();
		writeLoadCheck(options.env, options.file, options.key, { version, orrery: options.orrery, ok: result.ok, ...(result.ok ? {} : { why: result.why }), at });
	}
	return result;
}

/**
 * The Tools page's word on the check: which version it verified, or what happens at the next launch. `words`: what is
 * checked, as the start of a sentence ("hooks", "plugin"), its verb ("are", "is") and the tool's name ("Codex").
 */
export function loadCheckDetail(saved: LoadCheckState | undefined, version: string | undefined, orrery: string, words: { readonly what: string; readonly are: string; readonly tool: string }): string {
	const { what, are, tool } = words;
	if (saved === undefined) return version === undefined ? `${what} ${are} checked at each launch` : `${what} ${are} checked at the first launch`;
	if (version === undefined) return `${what} checked with ${tool} ${saved.version}; this ${tool} is checked at each launch`;
	if (saved.version !== version) return `${what} checked with ${tool} ${saved.version}; ${version} is checked at its first launch`;
	if (!saved.ok) return `${what} did not load in ${tool} ${version}: ${saved.why ?? "no reason kept"}`;
	if (saved.orrery !== orrery) return `${what} checked with ${tool} ${version} by Orrery ${saved.orrery}; checked again at the next launch`;
	return `${what} checked with ${tool} ${version}`;
}
