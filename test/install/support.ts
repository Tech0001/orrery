import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

/**
 * A scratch git checkout of this repository's work tree, committed: tracked and untracked files, never ignored ones.
 * Installing it installs the code under test, uncommitted changes included. The caller removes the folder.
 */
export function workingTreeCheckout(): string {
	const dir = mkdtempSync(join(tmpdir(), "orrery-tree-"));
	const files = execFileSync("git", ["-C", REPO, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).split("\0").filter((file) => file !== "");
	for (const file of files) {
		const from = join(REPO, file);
		let info: ReturnType<typeof lstatSync>;
		try {
			info = lstatSync(from);
		} catch {
			continue; // deleted in the work tree
		}
		const to = join(dir, file);
		mkdirSync(dirname(to), { recursive: true });
		if (info.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
		else if (info.isFile()) copyFileSync(from, to);
	}
	execFileSync("git", ["-C", dir, "init", "-q"]);
	commitAll(dir, "work tree");
	return dir;
}

/** Commits everything in `dir` (allowing an empty commit), so its next install is a new version. */
export function commitAll(dir: string, message: string): void {
	const git = (...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args]);
	git("add", "-A");
	git("commit", "-q", "--allow-empty", "-m", message);
}
