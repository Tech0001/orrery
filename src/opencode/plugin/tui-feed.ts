/**
 * The reading side of the plugin's feed (src/opencode/feed.ts) for its TUI entry, tui.tsx, which imports it as
 * "./tui-feed.js": a release packs this file there (scripts/build-release.ts), and in a checkout Bun finds this one.
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FeedReader, feedFileIn } from "../feed.ts";

/**
 * The feed of the Orrery launch this TUI is (its OPENCODE_CONFIG_CONTENT names the plugin folder `entry`, the TUI
 * entry's file URL, is in), for this TUI's process; none outside one.
 */
export function tuiFeed(env: NodeJS.ProcessEnv, tui: number, entry: string): FeedReader | undefined {
	const file = feedFileIn(env.OPENCODE_CONFIG_CONTENT, dirname(fileURLToPath(entry)));
	return file === undefined ? undefined : new FeedReader(file, tui);
}
