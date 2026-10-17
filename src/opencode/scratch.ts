/**
 * OpenCode run apart from the person's own setup, for Orrery's checks (its version, whether the plugin loads): a
 * scratch HOME, XDG folders and TMPDIR. OpenCode 2.0.30 keeps its config, data, logs, state and cache under the XDG
 * folders (util/src/global-roots.ts) and even `--version` writes a log line there, so nothing reaches
 * ~/.config/opencode, ~/.local/share/opencode, ~/.local/state/opencode or ~/.cache/opencode, nor the person's
 * background service (registered in the state folder). OPENCODE_* variables are left out (one could name the person's
 * own config, data or password), and so are ORRERY_* (the plugin finds no Orrery home there, so it opens no memory).
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

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
 * OpenCode's update check and model list download are off: a check makes no network call.
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
	};
}

/** A fresh scratch folder (in the system's temporary folder) and the environment for it. Throws when it cannot be made. */
export function makeScratch(env: NodeJS.ProcessEnv): Scratch {
	const dir = mkdtempSync(join(tmpdir(), "orrery-opencode-"));
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
				// left in the temporary folder
			}
		},
	};
}
