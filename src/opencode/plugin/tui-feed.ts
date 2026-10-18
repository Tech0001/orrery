/**
 * The reading side of the plugin's feed (src/opencode/feed.ts) for its TUI entry, tui.tsx, which imports it as
 * "./tui-feed.js": a release packs this file there (scripts/build-release.ts), and in a checkout Bun finds this one. Also
 * what the TUI entry says when OpenCode has turned Orrery's server plugin off (pluginOff), and its /compactor picker.
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FeedReader, feedFileIn } from "../feed.ts";
import { findPlugin } from "../plugin-list.ts";

export { pickSummaryModel, SUMMARY_RPC, summaryCommandLayer } from "../summary-menu.ts";

/**
 * The feed of the Orrery launch this TUI is (its OPENCODE_CONFIG_CONTENT names the plugin folder `entry`, the TUI
 * entry's file URL, is in), for this TUI's process; none outside one.
 */
export function tuiFeed(env: NodeJS.ProcessEnv, tui: number, entry: string): FeedReader | undefined {
	const file = feedFileIn(env.OPENCODE_CONFIG_CONTENT, pluginFolder(entry));
	return file === undefined ? undefined : new FeedReader(file, tui);
}

/** The plugin folder the TUI entry `entry` (its file URL) is in. */
export function pluginFolder(entry: string): string {
	return dirname(fileURLToPath(entry));
}

/**
 * The footer's warning when OpenCode's plugin list (`answer`) has Orrery's plugin from `folder` failed: OpenCode turned
 * it off (a reload that failed, "failed to restore plugin; deactivating", or a load that failed), so this session has
 * neither Orrery's guard nor its memory. Undefined when it is active, not listed (still loading), or the list is in a
 * shape Orrery doesn't know.
 */
export function pluginOff(answer: unknown, folder: string): string | undefined {
	const entry = findPlugin(answer, folder)?.entry;
	if (entry?.status !== "failed") return undefined;
	const why = typeof entry.error === "string" && entry.error.trim() !== "" ? (entry.error.split("\n")[0] as string).trim().slice(0, 200) : "no reason given";
	return `Orrery · NO GUARD, NO MEMORY: OpenCode turned Orrery's plugin off (${why}). Quit OpenCode and open the agent again.`;
}
