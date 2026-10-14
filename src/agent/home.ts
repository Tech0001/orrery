/** Where Orrery lives: one folder holding config, logins, memory, backups and the installed program. */

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** Defined here, not in config.ts, so home.ts and config.ts do not import each other; config.ts re-exports it. */
export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

/** $ORRERY_HOME (a leading ~/ expanded), else ~/.orrery. */
export function orreryHome(env: NodeJS.ProcessEnv = process.env): string {
	const home = env.HOME || homedir();
	const set = env.ORRERY_HOME;
	if (set === undefined || set === "") return join(home, ".orrery");
	const expanded = set === "~" ? home : set.startsWith("~/") ? join(home, set.slice(2)) : set;
	if (!isAbsolute(expanded)) throw new ConfigError(`ORRERY_HOME must be an absolute path (got ${set})`);
	return resolve(expanded);
}
