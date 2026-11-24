/**
 * The guard's rules for the Antigravity CLI's own files (spec 2026-11-20-antigravity-design, "Guard"), in every session
 * of every tool, an agent's or not (src/agent/guard-call.ts):
 * - its conversation records (`~/.gemini/antigravity-cli/brain/`, `conversations/`, `presence/`,
 *   `conversation_summaries.db*`): what Orrery records an Antigravity turn from, and how it proves a conversation agy's
 *   own; read with a file tool, written by none;
 * - what loads Orrery's hooks, memory tools and status row, and whatever else runs in a session: Antigravity's global
 *   `~/.gemini/config/hooks.json`, `mcp_config.json` and `plugins/`, its CLI's `settings.json`, and a project's
 *   `.agents/hooks.json` and `.agents/mcp_config.json`; read with a file tool, written by none.
 * Shell text that names any of them is refused, read or write (a seatbelt: a path assembled at run time, through a
 * variable or a link, gets through, as for every rule of the guard). Antigravity's folder is the one under HOME
 * (Antigravity reads no variable for it: names.ts agyFolder).
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { posix } from "node:path";

/** Antigravity's files the guard keeps (module doc), as written and as they really are, each folded to lower case. */
export interface AgyRule {
	readonly kept: readonly string[];
}

const KEPT = (home: string) => [
	posix.join(home, ".gemini", "antigravity-cli", "brain"),
	posix.join(home, ".gemini", "antigravity-cli", "conversations"),
	posix.join(home, ".gemini", "antigravity-cli", "presence"),
	posix.join(home, ".gemini", "antigravity-cli", "conversation_summaries.db"),
	posix.join(home, ".gemini", "antigravity-cli", "settings.json"),
	posix.join(home, ".gemini", "config", "hooks.json"),
	posix.join(home, ".gemini", "config", "mcp_config.json"),
	posix.join(home, ".gemini", "config", "plugins"),
];

/** A path as it really is, as far as it exists. */
function realish(path: string): string {
	const rest: string[] = [];
	for (let at = path; ; at = posix.dirname(at)) {
		try {
			return posix.join(realpathSync(at), ...rest.reverse());
		} catch {
			if (posix.dirname(at) === at) return path;
			rest.push(posix.basename(at));
		}
	}
}

/** The rule for `home` (default the OS's). */
export function agyRule(home: string = homedir()): AgyRule {
	const kept = KEPT(home).flatMap((path) => [path, realish(path)]).map((path) => posix.normalize(path).toLowerCase());
	return { kept: [...new Set(kept)] };
}

/** A project's own settings files, anywhere: `.agents/hooks.json` and `.agents/mcp_config.json`. */
const PROJECT = /(?:^|\/)\.agents\/+(?:hooks|mcp_config)\.json$/;

/** Whether `path` (absolute) is, or is in, one of Antigravity's kept files, or a project's settings file. */
export function agyKeeps(path: string, rule: AgyRule): boolean {
	const folded = posix.normalize(path).toLowerCase();
	if (PROJECT.test(folded)) return true;
	return rule.kept.some((kept) => folded === kept || folded.startsWith(`${kept}/`) || (kept.endsWith(".db") && folded.startsWith(kept)));
}

/** Shell text's names of Antigravity's kept files (readings are lower case), from any folder. */
const NAMED = new RegExp(
	[
		String.raw`\.gemini/+antigravity-cli/+(?:brain|conversations|presence|conversation_summaries\.db|settings\.json)(?:$|[/\-\s"'])`,
		String.raw`\.gemini/+config/+(?:hooks\.json|mcp_config\.json|plugins)(?:$|[/\s"'])`,
		String.raw`(?:^|[/\s"'=<>|;&(])\.agents/+(?:hooks|mcp_config)\.json(?:$|[\s"';|&)<>])`,
	].join("|"),
);

/** Whether a reading of shell text names one of Antigravity's kept files (module doc). */
export function agyNamed(form: string): boolean {
	return NAMED.test(form);
}

export const AGY_READ_ONLY = (path: string) =>
	`${path} is Antigravity's own (its conversation records, or a settings file that loads hooks and servers into its sessions): this agent may read it with a file tool, but no tool writes it.`;
export const AGY_READ_ONLY_PLAIN = (path: string) => `${path} is Antigravity's own (its conversation records, or a settings file that loads hooks and servers into its sessions): no tool writes it.`;
/**
 * Whether `path` (absolute, as the shell places it) is where Antigravity keeps what the person attached to a
 * conversation, `brain/<conversation>/.user_uploaded/`, or in it: written out, no ".." part, in the home's own case.
 */
export function agyUpload(path: string, home: string): boolean {
	if (path.split("/").includes("..")) return false;
	const brain = `${posix.join(home, ".gemini", "antigravity-cli", "brain")}/`;
	const normal = posix.normalize(path);
	if (!normal.startsWith(brain)) return false;
	const [conversation, folder] = normal.slice(brain.length).split("/");
	return conversation !== undefined && conversation !== "" && folder === ".user_uploaded";
}

export const AGY_COMMAND =
	"This command names Antigravity's own files (its conversation records, or settings that load hooks and servers into its sessions): agents may read them with a file tool, not in shell commands, and write them with no tool. What you attached (brain/<conversation>/.user_uploaded/) may be copied out with one plain cp, or read with one plain cat, head, tail, wc, ls or sed -n, that writes the full path out.";
export const AGY_COMMAND_PLAIN =
	"This command names Antigravity's own files (its conversation records, or settings that load hooks and servers into its sessions): read them with a file tool; no tool writes them. What you attached (brain/<conversation>/.user_uploaded/) may be copied out with one plain cp, or read with one plain cat, head, tail, wc, ls or sed -n, that writes the full path out.";
