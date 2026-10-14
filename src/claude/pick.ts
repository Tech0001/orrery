/**
 * Which lane a Claude Code session belongs to, one answer for its hooks, the MCP server, `claude-mod view` and the
 * commands' "." (src/lane/pick.ts), with one rule of Claude Code's own: an agent opened by ORRERY_AGENT in another lane's
 * folder that is set up the file way is refused. That folder's CLAUDE.md (or CLAUDE.local.md) imports the other lane's
 * memory view, and Claude Code loads it into the session whatever Orrery does, so the session would carry that lane's
 * memory into this one's. Refused: no memory, nothing recorded, no tools, and the guard with the folder lane's rules.
 */

import { type HarnessConfig, laneForCwd } from "../lane/config.ts";
import { type Picked, pickLane, refusedNotice, type Where } from "../lane/pick.ts";
import { laneMode } from "./view-file.ts";

/** ORRERY_AGENT named `name`, but the session runs in `host`'s folder, which loads `host`'s view (file mode). */
export interface InViewFolder {
	readonly kind: "in-view-folder";
	readonly name: string;
	readonly host: string;
}

export type ClaudePicked = Picked | InViewFolder;

/** pickLane, and a by-ORRERY_AGENT pick in another lane's file-mode folder refused (see the module doc). */
export function claudePick(config: HarnessConfig, where: Where): ClaudePicked {
	const pick = pickLane(config, where);
	if (pick.kind !== "lane" || pick.by !== "env") return pick;
	const host = laneForCwd(config, where.cwd);
	if (host === undefined || host.name === pick.lane.name || laneMode(host) !== "file") return pick;
	return { kind: "in-view-folder", name: pick.lane.name, host: host.name };
}

/** What a session whose ORRERY_AGENT was refused says, once. */
export function claudeRefusedNotice(pick: Exclude<ClaudePicked, { kind: "lane" } | { kind: "none" }>): string {
	if (pick.kind !== "in-view-folder") return refusedNotice(pick);
	const { name, host } = pick;
	return `Orrery: this folder is ${host}'s, set up to load ${host}'s memory view into Claude Code, so ${name} does not open here (${host}'s memory would be in its session); this session runs without memory. Open ${name} in another folder, or switch ${host} to the mod (\`orrery claude-setup ${host} --mod\`).`;
}
