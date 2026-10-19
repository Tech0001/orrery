/**
 * The agent's launch token for OpenCode (spec 2026-10-16-opencode-design, "Launch"; src/agent/pick.ts). OpenCode's
 * environment and OPENCODE_CONFIG_CONTENT reach the model's shell and MCP servers, so the token never goes there: the
 * plugin is given the path of a file holding it, mode 0600 in Orrery's own 0700 folder <Orrery's home>/tokens (the
 * guard keeps the model's tools out of Orrery's home). The launcher writes it just before OpenCode starts and removes
 * it when OpenCode exits, and when the launcher is stopped by SIGTERM or SIGHUP. Each file is named by its launcher's
 * pid, so one that a killed launcher left behind is removed by the next launch. Beside it, the plugin keeps its status
 * for OpenCode's TUI (<token file>.feed.json, src/opencode/feed.ts), which goes with it.
 */

import { randomBytes } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { orreryHome } from "../agent/home.ts";
import { ownFolder, readPrivate, writePrivate } from "../agent/private-file.ts";
import { processAlive } from "../agent/process.ts";
import { cleanUpOnSignals, type SignalTarget } from "../agent/signal-cleanup.ts";

/** The folder in Orrery's home that holds launch tokens. */
export const TOKEN_FOLDER = "tokens";
/** A token file's name, "opencode-<launcher's pid>-<12 hex digits>", or its feed's (FEED after it). */
const NAME = /^opencode-(\d+)-[0-9a-f]{12}(?:\.feed\.json)?$/;
/** A token file's name alone. */
const TOKEN_NAME = /^opencode-\d+-[0-9a-f]{12}$/;
/** What a token file's feed adds to its name. */
const FEED = ".feed.json";

/** The plugin's status for OpenCode's TUI, beside the token file (src/opencode/feed.ts). */
export const feedFileOf = (tokenFile: string): string => `${tokenFile}${FEED}`;

/**
 * Whether `file` can be a launch's token file: named as the launcher names one, in Orrery's tokens folder (for `env`'s
 * Orrery home), a real folder of this user's. The plugin reads no other, and writes its feed beside no other: its options
 * come from OpenCode's config, which a project's opencode.json can add to.
 */
export function launchTokenFile(file: string, env: NodeJS.ProcessEnv = process.env): boolean {
	try {
		const folder = join(orreryHome(env), TOKEN_FOLDER);
		return resolve(dirname(file)) === resolve(folder) && TOKEN_NAME.test(basename(file)) && ownFolder(folder) === true;
	} catch {
		return false;
	}
}

/** The most of a token file read: a token is 32 characters. */
const TOKEN_MAX = 256;

/**
 * The token in `file`, trimmed, for the plugin: a regular file of this user's, never through a link at its own name,
 * read up to TOKEN_MAX bytes. Throws when it cannot be read; whether it is a token is pickAgent's to say.
 */
export function readTokenFile(file: string): string {
	return readPrivate(file, TOKEN_MAX).trim();
}

/** A new token file's path for this process (nothing is written). */
export function tokenFilePath(env: NodeJS.ProcessEnv = process.env): string {
	return join(orreryHome(env), TOKEN_FOLDER, `opencode-${process.pid}-${randomBytes(6).toString("hex")}`);
}

/**
 * Removes the token files whose launcher is gone, only in a real folder of this user's (a link in its place could make
 * it remove files elsewhere). Never throws.
 */
export function pruneTokenFiles(folder: string, alive: (pid: number) => boolean = processAlive): void {
	let names: string[];
	try {
		if (ownFolder(folder) !== true) return;
		names = readdirSync(folder);
	} catch {
		return;
	}
	for (const name of names) {
		const pid = NAME.exec(name)?.[1];
		if (pid === undefined || alive(Number(pid))) continue;
		try {
			rmSync(join(folder, name), { force: true });
		} catch {
			// a later launch tries again
		}
	}
}

/** Writes `token` to `file`, 0600 in a 0700 folder of this user's (never through a link), after removing stale ones. Throws when it cannot. */
export function writeTokenFile(file: string, token: string): void {
	pruneTokenFiles(dirname(file));
	writePrivate(file, token);
}

/** Removes the token file and its feed. Never throws. */
export function removeTokenFile(file: string): void {
	for (const path of [file, feedFileOf(file)]) {
		try {
			rmSync(path, { force: true });
		} catch {
			// the next launch's prune takes it
		}
	}
}

/**
 * Removes `file` if this process is stopped by SIGTERM or SIGHUP (a closed terminal, kill) or exits while OpenCode
 * runs (src/agent/signal-cleanup.ts). Returns the undo.
 */
export function removeOnSignals(file: string, target?: SignalTarget): () => void {
	return cleanUpOnSignals(() => removeTokenFile(file), target);
}
