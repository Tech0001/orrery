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

/** Case-insensitive: on a case-insensitive file system (macOS) ~/.SSH is ~/.ssh. */
export function sensitive(text: string): boolean {
	const lower = text.toLowerCase();
	return SENSITIVE.some((pattern) => pattern.test(lower));
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
		return "This command touches sensitive files (ssh keys or credentials).";
	}
	const raw = call.arguments.path;
	if (typeof raw !== "string") return undefined;
	const path = posix.normalize(posix.isAbsolute(raw) ? raw : posix.join(options.cwd ?? options.workspace, raw));
	if (sensitive(raw) || sensitive(path)) return `${path} is a sensitive file (ssh keys or credentials).`;
	if ((call.name === "write" || call.name === "edit") && ![options.workspace, ...options.allowedRoots].some((root) => within(path, root))) {
		return `${path} is outside this lane's workspace and allowed roots.`;
	}
	return undefined;
}
