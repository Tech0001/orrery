/**
 * OpenCode run apart from the person's own setup, for Orrery's checks (its version, whether the plugin loads): a
 * scratch HOME, XDG folders and TMPDIR. OpenCode 2.0.30 keeps its config, data, logs, state and cache under the XDG
 * folders (util/src/global-roots.ts) and even `--version` writes a log line there, so nothing reaches
 * ~/.config/opencode, ~/.local/share/opencode, ~/.local/state/opencode or ~/.cache/opencode, nor the person's
 * background service (registered in the state folder). OPENCODE_* variables are left out (one could name the person's
 * own config, data or password), and so are ORRERY_* (the plugin finds no Orrery home there, so it opens no memory).
 *
 * OpenCode also reads opencode.json and .opencode/ (plugins among them) in every folder above the one it starts in. So
 * the scratch folder is made in a 0700 folder of Orrery's home (<Orrery's home>/scratch), never in a shared temporary
 * folder where another user could put them, and OPENCODE_DISABLE_PROJECT_CONFIG turns that search off besides.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { orreryHome } from "../agent/home.ts";
import { ownFolder } from "../agent/private-file.ts";

export interface Scratch {
	/** The folder OpenCode starts in, empty. */
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	/** Removes the scratch folder; never throws. */
	remove(): void;
}

/**
 * `env` for OpenCode in the scratch folder `dir`. mise's own folders keep their real places when they are not set,
 * so a mise shim on PATH still finds the OpenCode it runs (with a scratch HOME and XDG folders it would find none).
 * OpenCode's update check and model list download are off: a check makes no network call. No config from the folders
 * above the scratch folder is read.
 */
export function scratchEnv(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
	const home = env.HOME || homedir();
	const kept = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("OPENCODE_") && !key.startsWith("ORRERY_")));
	return {
		...kept,
		MISE_DATA_DIR: env.MISE_DATA_DIR || join(env.XDG_DATA_HOME || join(home, ".local", "share"), "mise"),
		MISE_CONFIG_DIR: env.MISE_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, ".config"), "mise"),
		HOME: join(dir, "home"),
		XDG_CONFIG_HOME: join(dir, "config"),
		XDG_DATA_HOME: join(dir, "data"),
		XDG_STATE_HOME: join(dir, "state"),
		XDG_CACHE_HOME: join(dir, "cache"),
		TMPDIR: join(dir, "tmp"),
		OPENCODE_DISABLE_AUTOUPDATE: "1",
		OPENCODE_DISABLE_MODELS_FETCH: "1",
		OPENCODE_DISABLE_PROJECT_CONFIG: "1",
	};
}

/** The folder scratch folders are made in: <Orrery's home>/scratch. */
export const scratchParent = (env: NodeJS.ProcessEnv): string => join(orreryHome(env), "scratch");

/**
 * A fresh scratch folder, opencode-XXXXXX in <Orrery's home>/scratch (made 0700, and only when it is a real folder of
 * this user's: never through a link), and the environment for it. Throws when it cannot be made.
 */
export function makeScratch(env: NodeJS.ProcessEnv): Scratch {
	const parent = scratchParent(env);
	mkdirSync(parent, { recursive: true, mode: 0o700 });
	if (ownFolder(parent) !== true) throw new Error(`${parent} is not a real folder of this user's (a symlink, or someone else's)`);
	chmodSync(parent, 0o700);
	const dir = mkdtempSync(join(parent, "opencode-"));
	try {
		for (const sub of ["home", "config", "data", "state", "cache", "tmp", "cwd"]) mkdirSync(join(dir, sub), { mode: 0o700 });
	} catch (error) {
		rmSync(dir, { recursive: true, force: true });
		throw error;
	}
	return {
		cwd: join(dir, "cwd"),
		env: scratchEnv(env, dir),
		remove: () => {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// left in the scratch folder
			}
		},
	};
}
