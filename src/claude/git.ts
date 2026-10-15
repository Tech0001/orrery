/**
 * Git, as orrery asks it about an agent's folder (spec §4 "The view file and CLAUDE.md"). The view in
 * <folder>/.orrery/ is the user's memory: in a git work tree, git must ignore it and track nothing there.
 * - Git runs as an argument list (`git -C <folder> …`), never through a shell, for at most 5 s.
 * - It runs without git's local variables (GIT_DIR, GIT_INDEX_FILE, GIT_CONFIG…). Inherited, they would point it at
 *   another repo, or another index, than the folder's own.
 * - It fails closed: only "not a git repository", or no git at all, means no repo. Any other failure means git could
 *   not say ("unchecked"): the view is not written this time, and the next write asks again.
 * - What it reports never quotes the repo's file names: SessionStart passes it on to the model.
 */

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

/**
 * git's local variables (`git rev-parse --local-env-vars`), its discovery limit, and the pathspec switches (one would
 * read ':(icase).orrery' as a file name); every GIT_CONFIG* variable goes too.
 */
const LOCAL_VARS = new Set([
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_CEILING_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_DIR",
	"GIT_GLOB_PATHSPECS",
	"GIT_GRAFT_FILE",
	"GIT_ICASE_PATHSPECS",
	"GIT_IMPLICIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_LITERAL_PATHSPECS",
	"GIT_NAMESPACE",
	"GIT_NOGLOB_PATHSPECS",
	"GIT_NO_REPLACE_OBJECTS",
	"GIT_OBJECT_DIRECTORY",
	"GIT_PREFIX",
	"GIT_REPLACE_REF_BASE",
	"GIT_SHALLOW_FILE",
	"GIT_WORK_TREE",
]);

/** `env` without git's local variables, and with git's messages untranslated (LC_ALL=C), since inWorkTree reads one. */
export function gitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const kept = Object.entries(env).filter(([key]) => !LOCAL_VARS.has(key) && !key.startsWith("GIT_CONFIG"));
	return { ...Object.fromEntries(kept), LC_ALL: "C" };
}

/** One git run: its exit status (null when it was killed, at the timeout say), stdout and stderr. */
export interface GitRun {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

/** Runs git in `folder` (see the module doc); undefined when git is not installed. */
export function git(folder: string, args: readonly string[]): GitRun | undefined {
	const run = spawnSync("git", ["-C", folder, ...args], { encoding: "utf8", env: gitEnv(), stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
	if ((run.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return undefined;
	return { status: run.error === undefined ? run.status : null, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

/** Whether `folder` is in a git work tree: false when it is in no repository or git is missing, undefined when git could not say. */
export function inWorkTree(folder: string): boolean | undefined {
	const run = git(folder, ["rev-parse", "--is-inside-work-tree"]);
	if (run === undefined) return false;
	if (run.status === 0) return run.stdout.trim() === "true";
	return run.status === 128 && run.stderr.includes("not a git repository") ? false : undefined;
}

/**
 * Whether git tracks `path` (relative to `folder`): false when it does not, the folder is in no repository, or git
 * is missing; undefined when git could not say.
 */
export function gitTracks(folder: string, path: string): boolean | undefined {
	const run = git(folder, ["ls-files", "--error-unmatch", "--", path]);
	if (run === undefined) return false;
	if (run.status === 0) return true;
	if (run.status === 1) return false;
	return run.status === 128 && run.stderr.includes("not a git repository") ? false : undefined;
}

/**
 * What gitExposure found. "tracked", "not ignored" and "case variant" are definite: git would see the view.
 * "unchecked" means git could not say this time. `reason` is for the user; `kind` alone is safe for any log.
 */
export interface Exposure {
	readonly kind: "tracked" | "not ignored" | "case variant" | "unchecked";
	readonly reason: string;
}

/**
 * Whether git would see the folder's .orrery/; undefined when it would not (or the folder is in no repo, or git
 * is missing). In a work tree:
 * - an entry named .orrery in another case (.Orrery) counts: a case-insensitive disk takes it for .orrery, and git
 *   with core.ignorecase reads .orrery as it;
 * - git must track nothing in .orrery/, in any case (`:(icase)`), and must ignore .orrery/view.md;
 * - a git that cannot answer gives "unchecked".
 * It throws only when the folder cannot be listed.
 */
export function gitExposure(folder: string): Exposure | undefined {
	const unchecked: Exposure = { kind: "unchecked", reason: `git could not say whether it would see .orrery/ (\`git -C ${folder} status\` may show why)` };
	const inside = inWorkTree(folder);
	if (inside === false) return undefined;
	if (inside === undefined) return unchecked;
	const variant = readdirSync(folder).find((name) => name !== ".orrery" && name.toLowerCase() === ".orrery");
	if (variant !== undefined) return { kind: "case variant", reason: `the folder has ${variant}, which a case-insensitive disk takes for .orrery` };
	const tracked = git(folder, ["ls-files", "--", ":(icase).orrery"]);
	if (tracked?.status !== 0) return unchecked;
	if (tracked.stdout.trim() !== "") return { kind: "tracked", reason: "git tracks files in .orrery/ (`git rm --cached .orrery/view.md` untracks the view)" };
	const ignored = git(folder, ["check-ignore", "-q", ".orrery/view.md"]);
	if (ignored?.status === 0) return undefined;
	if (ignored?.status === 1) return { kind: "not ignored", reason: ".orrery/ is not ignored by git (a .gitignore rule may un-ignore it)" };
	return unchecked;
}
