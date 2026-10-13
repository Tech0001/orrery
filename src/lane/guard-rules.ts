/** The lane guard's pure rules (spec §6): which tool calls and paths are refused. No pi-durable here. */

import { posix } from "node:path";

export interface GuardOptions {
	readonly workspace: string;
	readonly allowedRoots: readonly string[];
	/** Where a relative path starts (pi's cwd, which may be a subfolder of the workspace); default: the workspace. */
	readonly cwd?: string;
}

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
];

/**
 * Case-insensitive: on a case-insensitive file system (macOS) ~/.SSH is ~/.ssh. The text is judged as written and as the
 * shell reads it (readings), each by the credential patterns and by Orrery's own names.
 */
export function sensitive(text: string): boolean {
	return readings(text.toLowerCase()).some((form) => SENSITIVE.some((pattern) => pattern.test(form)) || orreryNamed(form));
}

/**
 * The ways a shell (or a path tool) may read a text: as written; with line continuations, quotes, backslashes and empty
 * substitutions gone (bash joins "~/.orr''ery" and "~/.orr$()ery"); with "//", "./" and "x/.." collapsed; and, for those
 * two, with each brace group {p,q} read as its first, a middle, or its last alternative.
 */
function readings(lower: string): string[] {
	let bare = lower.replace(/\\\n/g, "").replace(/\$(?=['"])/g, "");
	for (let pass = 0; pass < 4; pass++) {
		const next = bare.replace(/\$\(\)|``/g, "");
		if (next === bare) break;
		bare = next;
	}
	bare = bare.replace(/[\\'"]/g, "");
	const collapsed = bare.replace(/[^\s;|&()<>`]+/g, collapse);
	const forms = [lower, bare, collapsed];
	for (const base of [bare, collapsed]) {
		for (const pick of [0, 1, 2, -1]) forms.push(braces(base, pick));
	}
	return [...new Set(forms)];
}

/** One word as a path with "//" and "/." joined and "x/.." removed (a stack, so any depth, in linear time). */
function collapse(word: string): string {
	const stack: string[] = [];
	for (const part of word.split("/")) {
		if (part === "" || part === ".") continue;
		if (part !== "..") stack.push(part);
		else if (stack.length > 0 && stack[stack.length - 1] !== "..") stack.pop();
		else stack.push(part);
	}
	return `${word.startsWith("/") ? "/" : ""}${stack.join("/")}${stack.length > 0 && word.endsWith("/") ? "/" : ""}`;
}

// A brace expansion: one word with a comma inside the braces. Braces holding spaces or no comma (jq, JSON, code) are not.
const BRACE = /\{([^{}\s,]*(?:,[^{}\s,]*)+)\}/g;

/** Each brace group read as alternative `pick` (-1: the last; past the end: the last). */
function braces(text: string, pick: number): string {
	let out = text;
	for (let pass = 0; pass < 4; pass++) {
		const next = out.replace(BRACE, (_group, body: string) => {
			const alternatives = body.split(",");
			return alternatives[pick < 0 ? alternatives.length - 1 : Math.min(pick, alternatives.length - 1)];
		});
		if (next === out) break;
		out = next;
	}
	return out;
}

// What follows a folder name: the end, a separator, a shell terminator or a glob, then the rest of that word.
const AFTER = String.raw`(?=$|[\s/;|&)<>*?[{$\x60\\])([^\s|;&)<>]*)`;
// Orrery's home is named by its folder, whatever spells the path before it: .orrery as a path segment.
const ORRERY_NAME = /(?:^|[\s/=:~])\.orrery(?=$|[/\s|;&)<>])([^\s|;&)<>]*)/g;
const ORRERY_GLOB = /\.orrery\/+[^\s/|;&)<>]*[*?[]/;
// The old folders, which are links to the whole home after move-home (and the XDG variables that name their parents).
const OLD_CONFIG = new RegExp(String.raw`(?:\.config|xdg_config_home)\}?/+orrery${AFTER}`, "g");
const OLD_DATA = new RegExp(String.raw`(?:\.local/share|xdg_data_home)\}?/+orrery${AFTER}`, "g");

/** The path words after the folder; undefined when a variable or escape could still change them. */
function words(rest: string): string[] | undefined {
	const bare = rest.replace(/["']/g, "");
	return /[$\x60\\]/.test(bare) ? undefined : bare.split("/").filter(Boolean);
}

/** Orrery's program (app/ below, with no "." or ".." or glob in the way) is open. */
function program(parts: string[] | undefined): boolean {
	return parts !== undefined && parts[0] === "app" && parts.every((part) => part !== ".." && part !== "." && !/[*?[{]/.test(part));
}

const only = (parts: string[] | undefined, name: string) => parts?.length === 1 && parts[0] === name;

/** Whether a reading names Orrery's home or an old folder, beyond the program (app/), config.toml and a lane's view.md. */
function orreryNamed(form: string): boolean {
	if (ORRERY_GLOB.test(form)) return true;
	for (const match of form.matchAll(ORRERY_NAME)) {
		const parts = words(match[1]);
		if (!program(parts) && !only(parts, "config.toml") && !only(parts, "view.md")) return true;
	}
	for (const match of form.matchAll(OLD_CONFIG)) if (!only(words(match[1]), "config.toml")) return true;
	for (const match of form.matchAll(OLD_DATA)) if (!program(words(match[1]))) return true;
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
