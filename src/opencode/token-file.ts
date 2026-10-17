/**
 * The agent's launch token for OpenCode (spec 2026-10-16-opencode-design, "Launch"; src/agent/pick.ts). OpenCode's
 * environment and OPENCODE_CONFIG_CONTENT reach the model's shell and MCP servers, so the token never goes there: the
 * plugin is given the path of a file holding it, mode 0600 in Orrery's own 0700 folder <Orrery's home>/tokens (the
 * guard keeps the model's tools out of Orrery's home). The launcher writes it just before OpenCode starts and removes
 * it when OpenCode exits, and when the launcher is stopped by SIGTERM or SIGHUP. Each file is named by its launcher's
 * pid, so one that a killed launcher left behind is removed by the next launch.
 */

import { randomBytes } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { orreryHome } from "../agent/home.ts";
import { writePrivate } from "../agent/private-file.ts";
import { processAlive } from "../agent/process.ts";
import { cleanUpOnSignals, type SignalTarget } from "../agent/signal-cleanup.ts";

/** The folder in Orrery's home that holds launch tokens. */
export const TOKEN_FOLDER = "tokens";
/** A token file's name: "opencode-<launcher's pid>-<12 hex digits>". */
const NAME = /^opencode-(\d+)-[0-9a-f]{12}$/;

/** A new token file's path for this process (nothing is written). */
export function tokenFilePath(env: NodeJS.ProcessEnv = process.env): string {
	return join(orreryHome(env), TOKEN_FOLDER, `opencode-${process.pid}-${randomBytes(6).toString("hex")}`);
}

/** Removes the token files whose launcher is gone. Never throws. */
export function pruneTokenFiles(folder: string, alive: (pid: number) => boolean = processAlive): void {
	let names: string[];
	try {
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

/** Removes the token file. Never throws. */
export function removeTokenFile(file: string): void {
	try {
		rmSync(file, { force: true });
	} catch {
		// the next launch's prune takes it
	}
}

/**
 * Removes `file` if this process is stopped by SIGTERM or SIGHUP (a closed terminal, kill) or exits while OpenCode
 * runs (src/agent/signal-cleanup.ts). Returns the undo.
 */
export function removeOnSignals(file: string, target?: SignalTarget): () => void {
	return cleanUpOnSignals(() => removeTokenFile(file), target);
}
