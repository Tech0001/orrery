/**
 * OMP's own features that would fight an agent's memory, switched off for this session only (spec 2026-10-10-omp-design
 * §2): compaction (which also stops shake and the frame rescue, both of which rewrite the session), OMP's memory
 * backend, the project CLAUDE.md (only in a Claude Code agent, where it imports a stale .orrery/view.md), and auto-titles
 * (their side calls resend the system prompt, memory view and all). Nothing is persisted and nothing is written to the
 * folder.
 *
 * OMP has no public settings API. This reaches the session's live settings through two OMP internals, by dynamic import
 * so that pi never loads them: its pi shim's SettingsManager.create(cwd), which returns the active session's Settings
 * while a hook runs, and config/registry's lookup(id).override(), a runtime-only layer (OMP 18.8.7, research
 * omp-eval.md §13). test/omp/real-omp.test.ts checks them before OMP upgrades.
 *
 * Each result carries `restore`, which takes all of it back: OMP keeps the overrides when the session moves to another
 * folder (its /resume of another folder's session, /move), and Orrery then leaves the agent.
 */

import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentSettingsResult } from "../pi/index.ts";

/** OMP's context-file id for the project CLAUDE.md. */
export const PROJECT_CLAUDE_MD = "context-file:project:CLAUDE.md";

/** The CLAUDE.md line that loads a Claude Code agent's view (src/claude/view-file.ts VIEW_IMPORT). */
export const VIEW_IMPORT = "@.orrery/view.md";

/** How much of CLAUDE.md is searched for the import line (src/claude/view-file.ts READ_LIMIT). */
const READ_LIMIT = 256 * 1024;

/**
 * Whether `folder`'s CLAUDE.md imports the Claude Code view, checked as Claude Code's own importsView checks it: a
 * regular file opened never through a symlink, the import line among the whole lines of its first 256 KB. A copy, not
 * an import: src/claude/view-file.ts brings modules OMP's entry may not load (test/pi/pi-entry-points.test.ts), and
 * test/omp/settings.test.ts holds the two to the same answers.
 */
export function importsClaudeView(folder: string): boolean {
	let fd: number;
	try {
		// O_NOFOLLOW: a symlink fails to open. O_NONBLOCK: a pipe opens at once, and fstat then refuses it unread.
		fd = openSync(join(folder, "CLAUDE.md"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch {
		return false;
	}
	try {
		if (!fstatSync(fd).isFile()) return false;
		// One byte past the limit tells whether the file goes on; a line cut off at the limit is not a whole line.
		const buffer = Buffer.alloc(READ_LIMIT + 1);
		let length = 0;
		while (length <= READ_LIMIT) {
			const read = readSync(fd, buffer, length, READ_LIMIT + 1 - length, null);
			if (read === 0) break;
			length += read;
		}
		const lines = buffer.toString("utf8", 0, Math.min(length, READ_LIMIT)).split("\n");
		if (length > READ_LIMIT) lines.pop();
		return lines.some((line) => line.trim() === VIEW_IMPORT);
	} catch {
		return false;
	} finally {
		closeSync(fd);
	}
}

/** One OMP setting, as its config registry hands it out. */
export interface OmpSetting {
	get(settings: object): unknown;
	override(settings: object, value: unknown): void;
}

/** The two OMP internals this file uses. */
export interface OmpInternals {
	/** The session's live settings for `cwd` (OMP's legacy SettingsManager.create). */
	create(cwd: string): object;
	lookup(id: string): OmpSetting | undefined;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Puts PI_NO_TITLE back to `before`: removed when it was not set. */
function titlesBack(env: NodeJS.ProcessEnv, before: string | undefined): void {
	if (before === undefined) delete env.PI_NO_TITLE;
	else env.PI_NO_TITLE = before;
}

/** OMP's internals, or why they are not there. */
export async function loadInternals(): Promise<OmpInternals | string> {
	let shim: { SettingsManager?: { create?: unknown } };
	let registry: { lookup?: unknown };
	try {
		shim = await import("@earendil-works/pi-coding-agent");
		registry = await import("@oh-my-pi/pi-coding-agent/config/registry");
	} catch (error) {
		return `OMP internals did not load: ${errorText(error)}`;
	}
	const manager = shim.SettingsManager;
	const create = manager?.create;
	const lookup = registry.lookup;
	if (typeof create !== "function") return "OMP has no SettingsManager.create";
	if (typeof lookup !== "function") return "OMP's config registry has no lookup";
	return { create: (cwd) => create.call(manager, cwd) as object, lookup: (id) => lookup(id) as OmpSetting | undefined };
}

/**
 * Switches the four off with `internals` for the session in `cwd`, in the agent whose folder is `folder`. Titles go
 * first and always: OMP reads PI_NO_TITLE live, a public switch. The rest only when OMP gives this session's live
 * settings and knows the ids. The project CLAUDE.md goes off only where it collides: the agent's CLAUDE.md imports the
 * Claude Code view.
 */
export function applyWith(internals: OmpInternals, cwd: string, folder: string, env: NodeJS.ProcessEnv = process.env): AgentSettingsResult {
	const title = env.PI_NO_TITLE;
	env.PI_NO_TITLE = "1";
	// What takes it all back: only the overrides set here (override(scope, undefined) removes one, OMP's registry.ts),
	// each tried even when one fails, then PI_NO_TITLE as it was.
	const overridden: OmpSetting[] = [];
	const restore = () => {
		let failed: unknown;
		for (const setting of overridden.splice(0)) {
			try {
				setting.override(settings, undefined);
			} catch (error) {
				failed ??= error;
			}
		}
		titlesBack(env, title);
		if (failed !== undefined) throw failed;
	};
	const settings = internals.create(cwd);
	// With no live settings for this session OMP hands out a new isolated object each time: overrides there change nothing.
	if (internals.create(cwd) !== settings) return { applied: false, why: "no live session settings", restore };
	// Only where the agent's CLAUDE.md imports the view: OMP's extensions dashboard writes the whole effective list,
	// this override included, back to the user's global config when any entry is toggled, and then no OMP project would
	// load its CLAUDE.md. Elsewhere the list is left alone.
	const claudeMd = importsClaudeView(folder);
	const ids = claudeMd ? (["compaction.enabled", "memory.backend", "disabledExtensions"] as const) : (["compaction.enabled", "memory.backend"] as const);
	const found = ids.map((id) => internals.lookup(id));
	const [compaction, memory, disabled] = found;
	if (compaction === undefined || memory === undefined || (claudeMd && disabled === undefined)) {
		return { applied: false, why: `OMP has no setting ${ids.filter((_, i) => found[i] === undefined).join(", ")}`, restore };
	}
	// Each override is listed before it is set, so restore also takes back the ones set before one OMP refuses.
	try {
		overridden.push(compaction);
		compaction.override(settings, false);
		overridden.push(memory);
		memory.override(settings, "off");
		let listTook = true;
		if (disabled !== undefined) {
			// The override replaces the whole list: keep the user's own entries.
			const current = disabled.get(settings);
			const list = Array.isArray(current) ? current.filter((entry): entry is string => typeof entry === "string") : [];
			if (!list.includes(PROJECT_CLAUDE_MD)) {
				overridden.push(disabled);
				disabled.override(settings, [...list, PROJECT_CLAUDE_MD]);
			}
			const after = disabled.get(settings);
			listTook = Array.isArray(after) && after.includes(PROJECT_CLAUDE_MD);
		}
		const took = compaction.get(settings) === false && memory.get(settings) === "off" && listTook;
		return took ? { applied: true, restore } : { applied: false, why: "OMP did not take the overrides", restore };
	} catch (error) {
		return { applied: false, why: errorText(error), restore };
	}
}

/** applyWith on OMP's own internals; anything missing or thrown comes back as not applied, with why. */
export async function applyAgentSettings(
	ctx: Pick<ExtensionContext, "cwd">,
	folder: string,
	env: NodeJS.ProcessEnv = process.env,
	load: () => Promise<OmpInternals | string> = loadInternals,
): Promise<AgentSettingsResult> {
	const title = env.PI_NO_TITLE;
	env.PI_NO_TITLE = "1";
	let inner: (() => void) | undefined;
	const restore = () => {
		try {
			inner?.();
		} finally {
			titlesBack(env, title);
		}
	};
	try {
		const internals = await load();
		if (typeof internals === "string") return { applied: false, why: internals, restore };
		const result = applyWith(internals, ctx.cwd, folder, env);
		inner = result.restore;
		return { ...result, restore };
	} catch (error) {
		return { applied: false, why: errorText(error), restore };
	}
}
