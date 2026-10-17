/**
 * One scratch home for the whole test run (vitest's globalSetup, before any test process starts, so every one inherits
 * it): HOME, ORRERY_HOME and the XDG folders point into a fresh folder, removed after the run, and ORRERY_CONFIG is
 * unset. Code that falls back to the default home (os.homedir(), ~/.orrery, ~/.config) then finds the scratch one,
 * never the person's own Orrery home, config, logins or tools' settings. PATH is kept, and mise's own data and config
 * folders keep their real places, so real tool binaries (pi, OMP, Codex, OpenCode, Bun) still resolve; the tests that
 * run them make scratch homes of their own besides.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** The variable naming the run's scratch folder: test/setup-env.ts checks that the home is in it. */
export const SCRATCH_ENV = "ORRERY_TEST_SCRATCH";

export default function setup(): () => void {
	const realHome = process.env.HOME || homedir();
	const env = process.env;
	env.MISE_DATA_DIR ||= join(env.XDG_DATA_HOME || join(realHome, ".local", "share"), "mise");
	env.MISE_CONFIG_DIR ||= join(env.XDG_CONFIG_HOME || join(realHome, ".config"), "mise");
	const dir = mkdtempSync(join(tmpdir(), "orrery-test-run-"));
	const folders = { HOME: "home", XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", XDG_STATE_HOME: "state", XDG_CACHE_HOME: "cache" } as const;
	for (const [key, name] of Object.entries(folders)) {
		const folder = join(dir, name);
		mkdirSync(folder, { recursive: true });
		env[key] = folder;
	}
	// Where Orrery's home is by default under that HOME; Orrery makes it when it needs one.
	env.ORRERY_HOME = join(dir, "home", ".orrery");
	delete env.ORRERY_CONFIG;
	env[SCRATCH_ENV] = dir;
	return () => rmSync(dir, { recursive: true, force: true });
}
