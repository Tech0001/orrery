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

/** The config's place before Orrery moved into one folder. */
export function legacyConfigPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.HOME || homedir(), ".config", "orrery", "config.toml");
}

/** The data's place before Orrery moved into one folder (the old default data_dir). */
export function legacyDataDir(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.HOME || homedir(), ".local", "share", "orrery");
}

export function isLegacyConfig(path: string, env: NodeJS.ProcessEnv = process.env): boolean {
	return resolve(path) === legacyConfigPath(env);
}

export const LEGACY_NOTICE = "Orrery still uses ~/.config/orrery and ~/.local/share/orrery. Run `orrery move-home` to move everything to ~/.orrery.";
