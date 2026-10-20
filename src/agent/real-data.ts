/**
 * The user's real Orrery data (spec 2026-10-19-no-agent-sessions-design §2): the Orrery home under the home the system's
 * password database records for this user, never $HOME, and what its config (and the server path's) names of it. A
 * coding tool's session that is no agent's is judged only where it would touch this data: the CLI's gate
 * (src/cli/gate.ts) for a command, and each tool's integration for a tool started from such a session
 * (src/agent/plain-nested.ts). So test suites that run Orrery against scratch homes keep working from any session. No
 * option or variable changes which home is real: that would be the way around it.
 * Node built-ins, smol-toml (which config.ts loads already) and relative modules only, for pi and OMP, which load it.
 */

import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse } from "smol-toml";
import { viewFile } from "../claude/paths.ts";
import { DEFAULT_CONFIG_PATH, type HarnessConfig } from "./config.ts";
import { passwordHome } from "./home.ts";
import { realOrNone, startsOf } from "./sessions.ts";

/**
 * The user's real Orrery data: the Orrery home under `deps.home`, by default the home the password database records for
 * this user (`deps.passwordHome`, default passwordHome: never $HOME); and what the home's config.toml and the server
 * path's config name of it (ownData): the data folder (data_dir), and the files that hold logins. Each with its links
 * resolved; those not there are left out. With no record of this user the real home can't be told: every folder counts
 * (fail closed).
 */
export function realOrreryData(deps: { readonly home?: string; readonly passwordHome?: () => string | undefined } = {}): string[] {
	return realData(deps.home ?? (deps.passwordHome ?? passwordHome)());
}

/** realOrreryData for the real home `home` (undefined: the password database has no record of this user). */
export function realData(home: string | undefined): string[] {
	if (home === undefined) return [sep];
	const found = [join(home, ".orrery"), ...ownConfigs(home).flatMap((file) => ownData(file, home))];
	return [...new Set(found.map(realOrNone).filter((dir) => dir !== undefined))];
}

/** The user's own configs: the Orrery home's under the real home `home`, and the server path's. */
const ownConfigs = (home: string | undefined): string[] => [...(home === undefined ? [] : [join(home, ".orrery", "config.toml")]), DEFAULT_CONFIG_PATH];

/** Whether `config` was read from one of the user's own configs (ownConfigs), compared by real path. */
export function ownConfig(config: HarnessConfig, home: string | undefined): boolean {
	const file = config.file === undefined ? undefined : realOrNone(config.file);
	return file !== undefined && ownConfigs(home).some((own) => realOrNone(own) === file);
}

/**
 * What the user's own config `file` names of their data: its data folder (data_dir, else the config's own folder), the
 * logins file (credentials), and each SSH host's identity_file and known_hosts. Read raw, never validated: a setting
 * elsewhere in it that Orrery rejects hides none of them. Read as Orrery reads them, but with `~` the real home `home`,
 * never $HOME: a relative data_dir from the config's folder, the rest from the data folder. None when it can't be read.
 */
function ownData(file: string, home: string): string[] {
	let root: Record<string, unknown>;
	try {
		root = parse(readFileSync(file, "utf8")) as Record<string, unknown>;
	} catch {
		// none there, or no TOML
		return [];
	}
	const at = (value: unknown, base: string): string | undefined => {
		if (typeof value !== "string" || value === "") return undefined;
		if (value === "~" || value.startsWith("~/")) return join(home, value.slice(1));
		return isAbsolute(value) ? value : resolve(base, value);
	};
	const dataDir = at(root.data_dir, dirname(file)) ?? dirname(file);
	const found = [dataDir];
	const credentials = at(root.credentials, dataDir);
	if (credentials !== undefined) found.push(credentials);
	const hosts = root.hosts;
	if (typeof hosts === "object" && hosts !== null) {
		for (const host of Object.values(hosts as Record<string, unknown>)) {
			if (typeof host !== "object" || host === null) continue;
			const { identity_file, known_hosts } = host as Record<string, unknown>;
			for (const path of [at(identity_file, dataDir), at(known_hosts, dataDir)]) if (path !== undefined) found.push(path);
		}
	}
	return found;
}

/**
 * `path` as the file system names it (realpath.native: on a case-insensitive disk, the case it is stored in); for a path
 * not there, its nearest existing folder's, and the rest as given.
 */
function canonical(path: string, realpath: (path: string) => string): string {
	const rest: string[] = [];
	for (let dir = resolve(path); ; ) {
		try {
			return join(realpath(dir), ...rest);
		} catch {
			const parent = dirname(dir);
			if (parent === dir) return join(dir, ...rest);
			rest.unshift(basename(dir));
			dir = parent;
		}
	}
}

/** Whether `path` is `root` or inside it, both as the file system names them (canonical). */
export function within(root: string, path: string, realpath: (path: string) => string = realpathSync.native): boolean {
	const rel = relative(canonical(root, realpath), canonical(path, realpath));
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Whether `a` and `b` are one folder, as the file system names them. */
export const sameFolder = (a: string, b: string): boolean => canonical(a, realpathSync.native) === canonical(b, realpathSync.native);

/** Whether one of `paths`, or where one leads (startsOf), is in or under the real data (`real`, realOrreryData). */
export const touchesReal = (paths: readonly string[], real: readonly string[]): boolean => paths.some((path) => startsOf(path).some((start) => real.some((root) => within(root, start))));

/**
 * Every file or folder `config` names: the file it was read from, its data folder, credentials, device id and ssh folder,
 * each SSH host's identity_file and known_hosts, and each agent's data folder and the files in it (agentFiles), folder,
 * view file and allowed_roots.
 */
export function configPaths(config: HarnessConfig): string[] {
	const paths = [...(config.file === undefined ? [] : [config.file]), config.dataDir, config.credentialsPath, config.deviceIdPath, config.sshDir];
	for (const host of config.hosts.values()) if (host.kind === "ssh") paths.push(host.identityFile, host.knownHostsFile);
	for (const agent of config.agents.values()) {
		paths.push(agent.dir, ...agentFiles(agent.dir), ...(agent.folder === undefined ? [] : [agent.folder, viewFile(agent.folder)]), ...agent.allowedRoots);
	}
	return paths;
}

/**
 * The links in an agent's data folder `dir` and in its claude folder (the hooks' spool and the holder's state): the
 * memory store (memory.sqlite, with SQLite's -wal, -shm and -journal), status.json, instructions.md and the rest of what
 * Orrery opens there by name, so that one which is a link to another agent's file is judged where it leads (startsOf).
 * Any other file there, and one not there yet, is judged with `dir` itself. A hard link can't be told from the file it
 * links.
 */
function agentFiles(dir: string): string[] {
	const links: string[] = [];
	for (const folder of [dir, join(dir, "claude")]) {
		try {
			for (const entry of readdirSync(folder, { withFileTypes: true })) if (entry.isSymbolicLink()) links.push(join(folder, entry.name));
		} catch {
			// not there yet, or no folder
		}
	}
	return links;
}
