/**
 * `orrery claude-setup <Agent>` (spec §4 "The view file and CLAUDE.md") makes Claude Code load the agent's AGENTS.md
 * and memory view.
 * - An agent folder of its own gets the import lines in CLAUDE.md.
 * - A git repo (shared with other people) stays untouched: the lines go in CLAUDE.local.md, and CLAUDE.local.md
 *   and .orrery/ are listed in the repo's info/exclude, which is local and never committed.
 * - A CLAUDE.md that is a symlink (often to AGENTS.md) is never written through: the lines go in CLAUDE.local.md.
 * - It then leaves its marker in the agent's data folder (view-file.ts), the only way a folder starts receiving the
 *   view.
 * The folder is untrusted, since a shared repo decides what is in it:
 * - it never writes through a symlink; it refuses, writing nothing, when CLAUDE.local.md, .orrery, the repo's
 *   info/exclude or its folder is one (or is not a regular file or folder of the user's);
 * - in a repo, git must ignore .orrery/ and track nothing in it, in any case (a .gitignore rule can undo
 *   info/exclude). Otherwise it refuses, and takes back an earlier setup's marker and the view it wrote
 *   (withdrawView). When git cannot say (src/claude/git.ts), it refuses too, and an earlier setup's view is taken out
 *   until git answers (takeOutView); its marker stays.
 * `claudeSetupMod` (`--mod`) switches an agent to the Orrery mod: it takes the import lines back out (see there).
 * Git runs as an argument list (`git -C <folder> …`), never through a shell, without inherited GIT_DIR and the
 * like. Safe to rerun.
 */

import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AgentConfig } from "../agent/config.ts";
import { ownFolder, writePrivate } from "../agent/private-file.ts";
import { git, gitExposure, inWorkTree } from "./git.ts";
import { samePath, viewFile } from "./paths.ts";
import { deleteViewFile, importsView, messageCount, READ_LIMIT, readHead, refreshViewFile, type SetupFile, takeOutView, VIEW_IMPORT, withdrawView, writeSetupMarker } from "./view-file.ts";

/** The CLAUDE.md line that loads the agent's AGENTS.md (pi reads AGENTS.md; Claude Code reads CLAUDE.md). */
export const AGENTS_IMPORT = "@AGENTS.md";
const EXCLUDES = ["CLAUDE.local.md", ".orrery/"];

/** What claude-setup did, for setupReport. */
export interface SetupResult {
	readonly agent: string;
	/** The file holding the import lines: CLAUDE.md, or CLAUDE.local.md. */
	readonly file: string;
	readonly added: readonly string[];
	/** The repo's info/exclude and the lines added to it, in a git repo. */
	readonly exclude?: { readonly file: string; readonly added: readonly string[] };
	readonly view: string;
	/** The agent's message count, once it has memory. */
	readonly messages?: number;
	/** Where CLAUDE.md links to, when it is a symlink (so the lines went in CLAUDE.local.md). */
	readonly claudeMdLink?: string;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The repo's info/exclude when the folder is inside a git work tree; undefined otherwise, without git, or when git
 * fails (claudeSetup's gitExposure check then refuses).
 */
export function gitExclude(folder: string): string | undefined {
	const run = git(folder, ["rev-parse", "--is-inside-work-tree", "--git-path", "info/exclude"]);
	if (run?.status !== 0) return undefined;
	const [inside, path] = run.stdout.trim().split("\n");
	return inside === "true" && path ? resolve(folder, path) : undefined;
}

/**
 * The text of a file setup edits, "" when there is none. It must be a regular file (never a symlink) of at most
 * READ_LIMIT bytes; anything else is refused before setup writes anything.
 */
function editable(path: string): string {
	try {
		if (lstatSync(path).isSymbolicLink()) throw new Error(`${path} is a symlink; Orrery never writes through one`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
	let head: { text: string; whole: boolean };
	try {
		head = readHead(path);
	} catch (error) {
		throw new Error(`${path} cannot be edited safely: ${errorText(error)}`);
	}
	if (!head.whole) throw new Error(`${path} is larger than ${READ_LIMIT / 1024} KB; add the lines by hand`);
	return head.text;
}

/** Refuses a folder setup writes in (directly, or through the view) unless it is absent or a real folder of the user's. */
function writableFolder(dir: string): void {
	if (ownFolder(dir) === false) throw new Error(`${dir} is not a real folder of yours (a symlink, a file, or someone else's); Orrery never writes through one`);
}

/** The lines of `wanted` that `text` lacks (as whole lines, ignoring surrounding spaces). */
function missing(text: string, wanted: readonly string[]): string[] {
	const have = new Set(text.split("\n").map((line) => line.trim()));
	return wanted.filter((line) => !have.has(line));
}

/** Appends `added` to `text` (already read through editable) and writes it whole, never through a symlink. */
function append(path: string, text: string, added: readonly string[]): void {
	if (added.length === 0) return;
	// The folder is the user's (a folder's root, a repo's .git/info), not orrery's: its mode stays.
	writePrivate(path, `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${added.join("\n")}\n`, { keepFolderMode: true });
}

/** Whether the folder's CLAUDE.md already loads AGENTS.md: it imports it, or it is a symlink to it. */
function agentsLoaded(root: string): boolean {
	const claudeMd = join(root, "CLAUDE.md");
	try {
		if (lstatSync(claudeMd).isSymbolicLink()) return samePath(claudeMd, join(root, "AGENTS.md"));
		return missing(readHead(claudeMd).text, [AGENTS_IMPORT]).length === 0;
	} catch {
		return false;
	}
}

/** The link's target when `path` is a symlink; undefined otherwise. */
function linkTarget(path: string): string | undefined {
	try {
		return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : undefined;
	} catch {
		return undefined;
	}
}

/** The file claudeSetup puts the import lines in: CLAUDE.md only outside a git repo and when it is not a symlink. */
function setupFileName(exclude: string | undefined, claudeMdLink: string | undefined): SetupFile {
	return exclude === undefined && claudeMdLink === undefined ? "CLAUDE.md" : "CLAUDE.local.md";
}

/** Sets the agent's folder up for Claude Code (see the module doc). Throws, with what to fix, when it refuses. */
export function claudeSetup(agent: AgentConfig): SetupResult {
	const folder = agent.folder;
	if (folder === undefined) throw new Error(`${agent.name} has no folder; Claude Code's file setup needs one. Use orrery claude-setup ${agent.name} --mod.`);
	if (!existsSync(folder)) throw new Error(`${agent.name}'s folder ${folder} does not exist`);
	// The configured path is trusted, even through a symlink; what is inside the folder is not.
	const root = realpathSync(folder);
	if (ownFolder(root) !== true) throw new Error(`${agent.name}'s folder ${folder} is not a folder of yours`);
	const exclude = gitExclude(root);
	const claudeMdLink = linkTarget(join(root, "CLAUDE.md"));
	const name = setupFileName(exclude, claudeMdLink);

	// Every check comes before the first write: a refusal leaves everything as it was.
	const text = editable(join(root, name));
	writableFolder(join(root, ".orrery"));
	let excludeText = "";
	if (exclude !== undefined) {
		writableFolder(dirname(exclude));
		excludeText = editable(exclude);
	}
	// CLAUDE.md is loaded too: a CLAUDE.local.md that imported AGENTS.md again would load it twice.
	const added = missing(text, name === "CLAUDE.local.md" && agentsLoaded(root) ? [VIEW_IMPORT] : [AGENTS_IMPORT, VIEW_IMPORT]);
	const excludeAdded = exclude === undefined ? [] : missing(excludeText, EXCLUDES);

	// The exclude lines go first (local, never committed), so git can say whether .orrery/ is now ignored. Git is asked
	// even when gitExclude found no repo: a git that failed there must not pass for "no repo".
	if (exclude !== undefined) append(exclude, excludeText, excludeAdded);
	const exposure = gitExposure(root);
	if (exposure !== undefined) {
		const kept = exclude !== undefined && excludeAdded.length > 0 ? ` The lines it listed in ${exclude} stay; they only make git ignore more.` : "";
		const stuck = (error: unknown) => ` The view there could not be removed (${errorText(error)}); remove ${viewFile(folder)} yourself.`;
		if (exposure.kind === "unchecked") {
			// Git could not say this time: an earlier setup's view is taken out until it can, and its marker stays.
			let left = "";
			try {
				takeOutView(agent);
			} catch (error) {
				left = stuck(error);
			}
			throw new Error(`${agent.name}: ${exposure.reason}. Nothing was set up; try again.${left}${kept}`);
		}
		let left = "";
		try {
			withdrawView(agent);
		} catch (error) {
			left = stuck(error);
		}
		const fix = `Make git ignore .orrery/ and track nothing there, then rerun \`orrery claude-setup ${agent.name}\`.`;
		throw new Error(`${agent.name}: ${exposure.reason}, so the memory view in ${join(folder, ".orrery")} could reach a commit. ${fix} Claude Code was not set up.${left}${kept}`);
	}
	append(join(root, name), text, added);
	writeSetupMarker(agent.dir, folder, name);
	const messages = refreshViewFile(agent);
	return {
		agent: agent.name,
		file: join(folder, name),
		added,
		...(exclude === undefined ? {} : { exclude: { file: exclude, added: excludeAdded } }),
		view: viewFile(folder),
		...(messages === undefined ? {} : { messages }),
		...(claudeMdLink === undefined ? {} : { claudeMdLink }),
	};
}

/**
 * `text` quoted for a terminal: JSON's escapes, plus DEL and the C1 controls (an 8-bit CSI is U+009B), so nothing in
 * it can act on the terminal. For what a repo decides, such as a symlink's target.
 */
function quoted(text: string): string {
	return JSON.stringify(text).replace(/[\u007f-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** What claude-setup did, as lines for the terminal. A CLAUDE.md link's target comes from the repo: it is quoted. */
export function setupReport(result: SetupResult): string {
	const out: string[] = [];
	if (result.claudeMdLink !== undefined) {
		out.push(`CLAUDE.md is a symlink (to ${quoted(result.claudeMdLink)}); Orrery never writes through one, so the lines go in CLAUDE.local.md.`);
	}
	out.push(result.added.length > 0 ? `${result.agent}: added ${result.added.join(", ")} to ${result.file}` : `${result.agent}: ${result.file} already loads the memory view`);
	if (result.exclude !== undefined) {
		out.push(result.exclude.added.length > 0 ? `Listed ${result.exclude.added.join(", ")} in ${result.exclude.file}` : `${result.exclude.file} already lists CLAUDE.local.md and .orrery/`);
	}
	out.push(result.messages === undefined ? `View: ${result.view} is written once the agent has memory` : `View: ${result.view} (${result.messages} messages)`);
	out.push("Start Claude Code in the agent's folder; a new session loads the view.");
	return `${out.join("\n")}\n`;
}

/** What `orrery claude-setup <Agent> --mod` did, for modSetupReport. */
export interface ModSetupResult {
	readonly agent: string;
	/** The files whose view import line was removed. */
	readonly removedFrom: readonly string[];
	readonly viewDeleted: boolean;
	/** A CLAUDE.md in a git repo that still imports the view: the repo's own line, left alone. */
	readonly keptIn?: string;
	/** The agent's message count, once it has memory. */
	readonly messages?: number;
	/** The agent has no folder: only the marker was written, and the file setup cannot switch it back. */
	readonly noFolder?: true;
}

/**
 * `orrery claude-setup <Agent> --mod` (spec 2026-10-08-claude-code-mod §4.6): the Orrery mod gives Claude Code the view
 * in the system prompt. It
 * - removes the view import line from CLAUDE.local.md, and from CLAUDE.md only where plain claudeSetup would have put it
 *   there: git definitely says the folder is in no work tree (a git that cannot answer counts as a repo), and
 *   CLAUDE.md is no symlink. A file it edits must be a regular file of at most 256 KB, never a symlink; AGENTS.md import
 *   lines stay. In a repo CLAUDE.md's line is the repo's: that file is only read, never edited, so it never refuses;
 * - deletes .orrery/view.md (not one git tracks) and then .orrery/ if empty;
 * - writes the marker with file "mod".
 * Every check comes before the first write. Plain claudeSetup switches back. An agent with no folder gets the marker
 * alone (folder ""): there is no CLAUDE.md to take a line out of, and mod mode holds in whatever folder it opens.
 */
export function claudeSetupMod(agent: AgentConfig): ModSetupResult {
	if (agent.folder === undefined) {
		writeSetupMarker(agent.dir, "", "mod");
		const messages = messageCount(agent);
		return { agent: agent.name, removedFrom: [], viewDeleted: false, noFolder: true, ...(messages === undefined ? {} : { messages }) };
	}
	const folder = agent.folder;
	if (!existsSync(folder)) throw new Error(`${agent.name}'s folder ${folder} does not exist`);
	const root = realpathSync(folder);
	if (ownFolder(root) !== true) throw new Error(`${agent.name}'s folder ${folder} is not a folder of yours`);
	const ownsClaudeMd = linkTarget(join(root, "CLAUDE.md")) === undefined && inWorkTree(root) === false;
	const edits: { name: string; text: string }[] = [];
	let keptIn: string | undefined;
	for (const name of ["CLAUDE.md", "CLAUDE.local.md"]) {
		const path = join(root, name);
		if (linkTarget(path) !== undefined) continue; // a symlink is never written through, and setup never wrote there
		if (name === "CLAUDE.md" && !ownsClaudeMd) {
			// The repo's file and its line, not Orrery's: read only to say that the line stays.
			if (importsView(path)) keptIn = join(folder, name);
			continue;
		}
		const text = editable(path);
		const lines = text.split("\n");
		const kept = lines.filter((line) => line.trim() !== VIEW_IMPORT);
		if (kept.length !== lines.length) edits.push({ name, text: kept.join("\n") });
	}
	for (const { name, text } of edits) writePrivate(join(root, name), text, { keepFolderMode: true });
	const viewDeleted = deleteViewFile(folder);
	writeSetupMarker(agent.dir, folder, "mod");
	const messages = messageCount(agent);
	return { agent: agent.name, removedFrom: edits.map((e) => join(folder, e.name)), viewDeleted, ...(keptIn === undefined ? {} : { keptIn }), ...(messages === undefined ? {} : { messages }) };
}

/** What claude-setup --mod did, as lines for the terminal. */
export function modSetupReport(result: ModSetupResult): string {
	const out = [`${result.agent}: mod mode. Claude Code gets the memory view from the Orrery mod, in the system prompt.`];
	for (const file of result.removedFrom) out.push(`Removed ${VIEW_IMPORT} from ${file}`);
	if (result.keptIn !== undefined) out.push(`${result.keptIn} imports ${VIEW_IMPORT}; that line is the repo's and stays (harmless: the view file is no longer written).`);
	if (result.viewDeleted) out.push("Deleted the view file .orrery/view.md");
	out.push(result.messages === undefined ? "Memory: none yet; the mod adds it once the agent has some." : `Memory: ${result.messages} messages.`);
	out.push(
		result.noFolder === true
			? `Open it with \`orrery agent ${result.agent}\` in any folder (Claude Code 2.1.287 or newer, Orrery plugin 0.3.0).`
			: `Open it with \`orrery agent ${result.agent}\` in any folder, or start Claude Code in its folder (Claude Code 2.1.287 or newer, Orrery plugin 0.3.0). \`orrery claude-setup ${result.agent}\` switches back.`,
	);
	return `${out.join("\n")}\n`;
}
