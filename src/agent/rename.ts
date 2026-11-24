/**
 * Renaming an agent (`orrery agent rename <Old> <New>`, the TUI's R): its config block and the other agents' reads that
 * name it (config-edit.ts renameAgent), and its data folder (memory, instructions, records), which must carry the same
 * name or the agent starts without its memory. The memory itself names no agent, so it carries over whole. Refused while
 * the agent is open anywhere, for an agent with a remote (its copy there is kept under its name), and where the new
 * name's data folder exists already.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ConfigFile, configOf, findAgent } from "./config.ts";
import { configText, configWritable, editConfigOnce, readOnlyConfigText, renameAgent } from "./config-edit.ts";
import { agentOverview, archiveRefusal } from "./overview.ts";

/** What a rename did. */
export interface Renamed {
	readonly from: string;
	readonly to: string;
	/** The data folder's new place; undefined when the agent had none yet (never opened). */
	readonly dir?: string;
	/** How often instructions.md names the old name, as a word: the person may want those changed. */
	readonly mentions: number;
}

/** Why `agent` (as the config spells it) can't be renamed now, or undefined. */
export function renameRefusal(file: ConfigFile, agent: string): string | undefined {
	const config = configOf(file);
	const found = findAgent(config, agent);
	const row = agentOverview(config).find((r) => r.name === found.name);
	const open = row === undefined ? undefined : archiveRefusal(row);
	if (open !== undefined) return open;
	if (found.remote !== undefined) return `${found.name} has a remote (${found.remote}), which keeps its copy under its name; rename it after orrery agent local ${found.name}.`;
	if (!configWritable(file.path)) return readOnlyConfigText(file.path);
	return undefined;
}

/** Renames `agent` to `name` (module doc); the config is written last, and the folder moved back when that fails. */
export function renameAgentNow(file: ConfigFile, agent: string, name: string): Renamed {
	const config = configOf(file);
	const found = findAgent(config, agent);
	const refusal = renameRefusal(file, found.name);
	if (refusal !== undefined) throw new Error(refusal);
	// Checked first, so a name the config refuses moves nothing.
	const text = configText(file);
	if (text === undefined) throw new Error(`${file.path} could not be read.`);
	renameAgent(text, dirname(file.path), found.name, name);
	const from = found.dir;
	const to = join(dirname(from), name);
	// A change of case alone is the same folder on a file system that ignores case: moved through a third name.
	const caseOnly = name.toLowerCase() === found.name.toLowerCase();
	if (!caseOnly && existsSync(to)) throw new Error(`${to} already exists; move it away or pick another name.`);
	const move = (a: string, b: string) => {
		if (!caseOnly) return renameSync(a, b);
		const step = `${a}.renaming-${randomBytes(4).toString("hex")}`;
		renameSync(a, step);
		renameSync(step, b);
	};
	const moved = existsSync(from);
	if (moved) move(from, to);
	try {
		editConfigOnce(file, (current, dir) => renameAgent(current, dir, found.name, name));
	} catch (error) {
		if (moved) move(to, from);
		throw error;
	}
	return { from: found.name, to: name, ...(moved ? { dir: to } : {}), mentions: moved ? mentionsIn(join(to, "instructions.md"), found.name) : 0 };
}

/** How often `file` names `name` as a word; 0 when it can't be read. */
function mentionsIn(file: string, name: string): number {
	try {
		return [...readFileSync(file, "utf8").matchAll(new RegExp(`(?<![A-Za-z0-9_-])${name}(?![A-Za-z0-9_-])`, "g"))].length;
	} catch {
		return 0;
	}
}

/** What `orrery agent rename` and the TUI say after a rename. */
export function renamedText(done: Renamed): string {
	const lines = [`Renamed ${done.from} to ${done.to}.${done.dir === undefined ? "" : ` Its memory is in ${done.dir}.`}`];
	if (done.mentions > 0) {
		lines.push(`Its instructions.md names ${done.from} ${done.mentions === 1 ? "once" : `${done.mentions} times`}; change ${done.mentions === 1 ? "it" : "them"} if they should say ${done.to} (E in the TUI).`);
	}
	lines.push(`Its memory still says ${done.from} where earlier messages did. Open it as ${done.to} from now on.`);
	return `${lines.join("\n")}\n`;
}
