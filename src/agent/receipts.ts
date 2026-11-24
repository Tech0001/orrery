/**
 * Turn receipts: which files an agent's file tools wrote during a turn, and the git branch and commit of each repository
 * they are in, kept beside the turn's reply (src/memory/store.ts receiptKey), shown by zoom on that message and found by
 * search; never in the view or the summaries. The guard notes each write it lets through in the agent's own session
 * (noteWrite, into `turn-writes` in the agent's data folder); the recorder takes them as it records the turn's reply
 * (turnReceipts, a MemoryView's ReceiptSource), which empties the file.
 *
 * Git is read from its files, never run: a repository's own config is the agent's to write, and running git there would
 * run what it says. A shell command's writes are not noted (its text says what it means to do, not what it did), so a
 * turn that only commits or merges has no receipt. A write the guard let through but the tool then failed is listed.
 * Node built-ins only: every gate loads it.
 */

import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** The file in an agent's data folder that holds the paths written since its last receipt, one per line. */
const SPOOL = "turn-writes";
/** Past this size, no more paths are noted until the next receipt empties it. */
const SPOOL_MAX = 64 * 1024;
/** How many files a receipt names; the rest are counted. */
const SHOWN = 12;
/** The longest path a receipt keeps (longer ones are cut, with "…"). */
const PATH_MAX = 240;
/** The longest a receipt is. */
const RECEIPT_MAX = 1200;
/** A git file the receipt reads (HEAD, a ref, packed-refs): no bigger than this. */
const GIT_FILE_MAX = 4 * 1024 * 1024;

/** A path as a receipt keeps it: one line, no control characters, at most PATH_MAX; undefined for one not absolute. */
function cleanPath(path: string): string | undefined {
	if (!isAbsolute(path)) return undefined;
	// Control characters, and the line and paragraph separators, would let a file name start a line of its own.
	const one = path.replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]/g, "?");
	return one.length <= PATH_MAX ? one : `${one.slice(0, PATH_MAX - 1)}…`;
}

/** Notes that the agent whose data folder is `agentDir` wrote `path` (absolute, where it really lands). Never throws. */
export function noteWrite(agentDir: string, path: string): void {
	try {
		const clean = cleanPath(path);
		if (clean === undefined) return;
		const spool = join(agentDir, SPOOL);
		let size = 0;
		try {
			size = statSync(spool).size;
		} catch {
			// Not there yet.
		}
		if (size > SPOOL_MAX) return;
		appendFileSync(spool, `${clean}\n`, { mode: 0o600 });
	} catch {
		// A receipt is a convenience: noting one never changes the guard's answer.
	}
}

/** The receipt source a live session's view takes its receipts from (src/memory/view.ts ReceiptSource). */
export function turnReceipts(agentDir: string, home: string = homedir()): { take(): string | undefined } {
	return { take: () => takeReceipt(agentDir, home) };
}

/** The receipt of the paths noted since the last one, which it clears; undefined when none were. */
export function takeReceipt(agentDir: string, home: string = homedir()): string | undefined {
	const spool = join(agentDir, SPOOL);
	let text: string;
	try {
		text = readFileSync(spool, "utf8");
	} catch {
		return undefined;
	}
	try {
		writeFileSync(spool, "", { mode: 0o600 });
	} catch {
		// Left as it is: the next receipt names these files again.
	}
	const paths = [...new Set(text.split("\n").filter((line) => line !== ""))];
	return paths.length === 0 ? undefined : receiptText(paths, home);
}

/** Where a git repository's files are: its git folder, and the folder its refs are shared in (a worktree's main one). */
interface GitPlace {
	readonly root: string;
	readonly dir: string;
	readonly common: string;
}

/** A small file's text, or undefined. */
function small(path: string): string | undefined {
	try {
		if (statSync(path).size > GIT_FILE_MAX) return undefined;
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

/** The repository `root`'s git folders: `.git` a folder, or a file naming it (a worktree, a submodule). */
function gitPlace(root: string): GitPlace | undefined {
	const dotGit = join(root, ".git");
	let dir: string;
	try {
		if (statSync(dotGit).isDirectory()) dir = dotGit;
		else {
			const named = /^gitdir: *(.+?)\s*$/m.exec(small(dotGit) ?? "")?.[1];
			if (named === undefined) return undefined;
			dir = resolve(root, named);
		}
	} catch {
		return undefined;
	}
	const shared = small(join(dir, "commondir"))?.trim();
	return { root, dir, common: shared === undefined || shared === "" ? dir : resolve(dir, shared) };
}

/** A ref's commit, from its own file or packed-refs; undefined when neither says. */
function refCommit(place: GitPlace, ref: string): string | undefined {
	if (ref.split("/").includes("..")) return undefined;
	for (const folder of [place.dir, place.common]) {
		const sha = small(join(folder, ref))?.trim();
		if (sha !== undefined && /^[0-9a-f]{40,64}$/.test(sha)) return sha;
	}
	for (const line of (small(join(place.common, "packed-refs")) ?? "").split("\n")) {
		const [sha, name] = line.trim().split(" ");
		if (name === ref && sha !== undefined && /^[0-9a-f]{40,64}$/.test(sha)) return sha;
	}
	return undefined;
}

/** "branch @ 1a2b3c4", "detached @ 1a2b3c4", "branch" (no commit yet), or undefined when git's files can't say. */
function headText(place: GitPlace): string | undefined {
	const head = small(join(place.dir, "HEAD"))?.trim();
	if (head === undefined) return undefined;
	if (/^[0-9a-f]{40,64}$/.test(head)) return `detached @ ${head.slice(0, 7)}`;
	const ref = /^ref: *(refs\/\S+)$/.exec(head)?.[1];
	if (ref === undefined) return undefined;
	const branch = (ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref).replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]/g, "?");
	const sha = refCommit(place, ref);
	return sha === undefined ? branch : `${branch} @ ${sha.slice(0, 7)}`;
}

/** The repository holding `path`: the nearest folder above it with a `.git`, or undefined. */
function repoOf(path: string, known: Map<string, string | null>): string | undefined {
	const seen: string[] = [];
	let found: string | undefined;
	for (let folder = dirname(path), hops = 0; hops < 128; folder = dirname(folder), hops++) {
		const cached = known.get(folder);
		if (cached !== undefined) {
			found = cached ?? undefined;
			break;
		}
		seen.push(folder);
		let here = false;
		try {
			statSync(join(folder, ".git"));
			here = true;
		} catch {
			// No repository here.
		}
		if (here) {
			found = folder;
			break;
		}
		if (dirname(folder) === folder) break;
	}
	for (const folder of seen) known.set(folder, found ?? null);
	return found;
}

/** `path` with the home folder as "~". */
function homeShort(path: string, home: string): string {
	return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/**
 * A receipt's text: "wrote ~/src/app (main @ 1a2b3c4): src/a.ts, test/a.test.ts; ~/notes.md", the files grouped by
 * repository (with its branch and commit as its git files say them, when they can), at most SHOWN files named and the
 * rest counted, at most RECEIPT_MAX long.
 */
export function receiptText(paths: readonly string[], home: string = homedir()): string {
	const known = new Map<string, string | null>();
	const groups = new Map<string, string[]>();
	for (const path of paths) {
		const repo = repoOf(path, known) ?? "";
		const group = groups.get(repo) ?? [];
		group.push(path);
		groups.set(repo, group);
	}
	let left = SHOWN;
	const parts: string[] = [];
	for (const [repo, files] of groups) {
		const shown = files.slice(0, Math.max(0, left));
		left -= shown.length;
		if (repo === "") {
			parts.push(...shown.map((file) => homeShort(file, home)));
			continue;
		}
		const place = gitPlace(repo);
		const head = place === undefined ? undefined : headText(place);
		const label = `${homeShort(repo, home)}${head === undefined ? "" : ` (${head})`}`;
		parts.push(shown.length === 0 ? label : `${label}: ${shown.map((file) => relative(repo, file)).join(", ")}`);
	}
	const more = paths.length - (SHOWN - Math.max(0, left));
	const text = `wrote ${parts.join("; ")}${more > 0 ? ` (+${more} more)` : ""}`;
	return text.length <= RECEIPT_MAX ? text : `${text.slice(0, RECEIPT_MAX - 1)}…`;
}
