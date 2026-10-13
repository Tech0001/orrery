/** The lane guard's pure rules (spec §6): which tool calls and paths are refused. No pi-durable here. */

import { posix } from "node:path";

export interface GuardOptions {
	readonly workspace: string;
	readonly allowedRoots: readonly string[];
	/** Where a relative path starts (pi's cwd, which may be a subfolder of the workspace); default: the workspace. */
	readonly cwd?: string;
}

const ORRERY_SEP = String.raw`["']*\/+(?:\.\/+|app\/+\.\.\/+|["'])*`;

const SENSITIVE = [
	/(^|[\s"'=:/~])\.ssh(\/|$|[\s"'])/,
	/\bid_(rsa|ed25519|ecdsa|dsa)\b/,
	/\bauth\.json\b/,
	/\bcredentials\.json\b/,
	/\.aws\/credentials\b/,
	/\.netrc\b/,
	/(^|\/)\.gnupg(\/|$)/,
	/\.kube\/config\b/,
	/\.docker\/config\.json\b/,
	/\.config\/gh\/hosts\.yml\b/,
	/\.git-credentials\b/,
	/\.pgpass\b/,
	// pi's provider settings (API keys may sit in it) and any process's environment (/proc/self/environ and the like).
	/\.pi\/agent\/models\.json\b/,
	/(^|[\s"'=:;|&<>(])\/proc\/([^/\s"']+\/)+environ\b/,
	// OMP's credential stores: agent.db (its logins) and models.yml (API keys) in ~/.omp/agent or a profile's, and agent.db
	// under $XDG_DATA_HOME/omp once OMP moved its data there.
	/\.omp\/(?:profiles\/[^/\s"']+\/)?agent\/(?:agent\.db|models\.ya?ml)\b/,
	/(^|[\s"'=:/])omp\/(?:profiles\/[^/\s"']+\/)?agent\.db\b/,
	// The .env OMP loads from its config root and agent dir (utils/src/env.ts) and its secrets.yml (secrets/index.ts), in
	// ~/.omp, a profile's or a project's .omp.
	/\.omp\/(?:profiles\/[^/\s"']+\/)?(?:agent\/)?(?:\.env|secrets\.ya?ml)\b/,
	// Orrery's own home, named by folder (any spelling of the path before it): its keys, other lanes' memory, backups and
	// build scripts, not app/, not config.toml, and not a lane folder's .orrery/view.md, which these names never match.
	// Between .orrery and the name: "/", "//", "./", "app/../" and quotes. The whole home and the old folders are
	// judged by homeNamed below.
	new RegExp(`\\.orrery${ORRERY_SEP}(?:lanes|backups|builds|ssh)(?:\\/|$|[\\s"'|;&)<>*])`),
	new RegExp(`\\.orrery${ORRERY_SEP}(?:remotes\\.json|device-id|backup\\.env)\\b`),
	/\/\.orrery\/+[^\s/"']*[*?[{]/,
	// A brace group that spells orrery can build any of the names above.
	/\{[^{}]*orrery/,
];

/** Case-insensitive: on a case-insensitive file system (macOS) ~/.SSH is ~/.ssh. */
export function sensitive(text: string): boolean {
	const lower = text.toLowerCase();
	// The shell drops quotes and backslashes inside a word and joins "//", "./" and "x/.." in a path: test those readings
	// too.
	const bare = lower.replace(/[\\'"]/g, "");
	return [...new Set([lower, bare, flatten(bare)])].some((form) => SENSITIVE.some((pattern) => pattern.test(form)) || homeNamed(form));
}

/** A path text with "//" and "/." joined and "/x/.." removed (a few levels deep: the guard is a seatbelt). */
function flatten(text: string): string {
	let out = text.replace(/\/{2,}/g, "/").replace(/\/\.(?=\/)/g, "");
	for (let pass = 0; pass < 8; pass++) {
		const next = out.replace(/\/(?!\.\.(?:\/|$))[^/\s;|&()<>]+\/\.\.(?=\/|$|[\s;|&()<>])/g, "");
		if (next === out) break;
		out = next;
	}
	return out;
}

// What follows a folder name: the end, a path separator, a shell terminator or a glob, then the rest of that word.
const AFTER = String.raw`(?=$|[\s"'/;|&)<>*?[{\\$\x60])([^\s|;&)<>]*)`;
// What comes before ~/.orrery and the old folders: some spelling of the home folder (~, ~user, /home/x, /var/home/x,
// /Users/x, /root), or an expansion that may be one ($VAR, ${...}, $(...), a backtick, a brace group). The old folders
// are links to the whole home after move-home: the folder itself and all in it is refused, except the program (app/) and
// config.toml.
const HOME_WORD = String.raw`(?:(?:^|[\s"'=:;|&(<>{,])(?:~[\w.-]*|/(?:var/)?home/[^/\s"']+|/users/[^/\s"']+|/root)|\$\{[^}\s]*\}|\$[a-z_]\w*|[)}\x60])`;
const ORRERY_HOME = new RegExp(String.raw`${HOME_WORD}/\.orrery${AFTER}`, "g");
const OLD_FOLDERS = new RegExp(String.raw`${HOME_WORD}/\.(config|local/share)/orrery${AFTER}`, "g");

/** The path words after the folder, quotes dropped; undefined when a variable or escape could still change them. */
function words(rest: string): string[] | undefined {
	const bare = rest.replace(/["']/g, "");
	return /[$\x60\\]/.test(bare) ? undefined : bare.split("/").filter(Boolean);
}

/** Orrery's program (app/ below, with no "." or ".." or glob in the way) is open; so is config.toml. */
function program(parts: string[] | undefined): boolean {
	return parts !== undefined && parts[0] === "app" && parts.every((part) => part !== ".." && part !== "." && !/[*?[{]/.test(part));
}

const config = (parts: string[] | undefined) => parts?.length === 1 && parts[0] === "config.toml";

/** Whether a command (or path) text names Orrery's home as a whole, or the old folders, beyond what is open to the agent. */
function homeNamed(lower: string): boolean {
	for (const match of lower.matchAll(ORRERY_HOME)) {
		const parts = words(match[1]);
		if (!program(parts) && !config(parts)) return true;
	}
	for (const match of lower.matchAll(OLD_FOLDERS)) {
		const parts = words(match[2]);
		if (!(match[1] === "config" ? config(parts) : program(parts))) return true;
	}
	return false;
}

/**
 * Whether the real path `where` is inside Orrery's home (`realData`, also real) beyond what is open: app/ and config.toml.
 * Both exceptions are compared on the real path with no link followed from them, so a planted link named app or
 * config.toml cannot widen them. Case-insensitive, like the other path rules.
 */
export function inOrreryHome(where: string, realData: string): boolean {
	const path = where.toLowerCase();
	const data = realData.toLowerCase();
	return within(path, data) && path !== posix.join(data, "config.toml") && !within(path, posix.join(data, "app"));
}

export function within(path: string, root: string): boolean {
	const normalizedRoot = posix.normalize(root).replace(/\/+$/, "");
	return path === normalizedRoot || path.startsWith(`${normalizedRoot}/`);
}

/** A cheap pre-filter on the raw arguments; the authoritative file check is checkResolvedPath. */
export function checkToolCall(
	call: { readonly name: string; readonly arguments: Readonly<Record<string, unknown>> },
	options: GuardOptions,
): string | undefined {
	const command = call.arguments.command;
	if (call.name === "bash" && typeof command === "string" && sensitive(command)) {
		return "This command touches sensitive files (keys, credentials or Orrery's private data).";
	}
	const raw = call.arguments.path;
	if (typeof raw !== "string") return undefined;
	const path = posix.normalize(posix.isAbsolute(raw) ? raw : posix.join(options.cwd ?? options.workspace, raw));
	if (sensitive(raw) || sensitive(path)) return `${path} is a sensitive file (keys, credentials or Orrery's private data).`;
	if ((call.name === "write" || call.name === "edit") && ![options.workspace, ...options.allowedRoots].some((root) => within(path, root))) {
		return `${path} is outside this lane's workspace and allowed roots.`;
	}
	return undefined;
}
