/**
 * Where the running code lives: a checkout, or an install's version folder under <home>/app. Kept apart from tools.ts
 * (Node only) because every lane's status file records the version, inside pi and OMP too.
 */

import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { within } from "./guard-rules.ts";
import { orreryHome } from "./home.ts";

/** The folder this code runs from (its real path: Node and Bun load modules by real path). */
export function runningRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** What wiring should name: app/current when this code runs from an install, else this checkout. */
export function wiringRoot(env: NodeJS.ProcessEnv = process.env): { root: string; installed: boolean } {
	const app = join(orreryHome(env), "app");
	try {
		if (within(realpathSync(runningRoot()), realpathSync(app))) return { root: join(app, "current"), installed: true };
	} catch {
		// no app folder: not installed
	}
	return { root: runningRoot(), installed: false };
}

/** The version folder's name when this code runs from an install, else "checkout". */
export function runningVersion(env: NodeJS.ProcessEnv = process.env): string {
	return wiringRoot(env).installed ? basename(runningRoot()) : "checkout";
}
