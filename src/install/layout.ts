/**
 * The two shapes an installed Orrery can have (spec 2026-10-13-orrery-releases-design §6, §7): a release (bin/orrery
 * and packed extensions/*.js, 0.6.0 on) or a source copy (src/ with node_modules, 0.5.0). Wiring follows the shape of
 * the version app/current names, so a rollback across shapes rewires correctly.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type Style = "binary" | "source";

export interface Entries {
	readonly style: Style;
	readonly cli: string;
	readonly pi: string;
	readonly omp: string;
}

/** Each entry's path under a root, binary style first, then source style. */
export const ENTRY_TAILS = {
	cli: [join("bin", "orrery"), join("src", "cli", "main.ts")],
	pi: [join("extensions", "pi.js"), join("src", "pi", "index.ts")],
	omp: [join("extensions", "omp.js"), join("src", "omp", "index.ts")],
} as const;

/** The entry points under `root` (kept literally, so app/current stays in the paths). */
export function entries(root: string): Entries {
	if (existsSync(join(root, "bin", "orrery"))) return { style: "binary", cli: join(root, ENTRY_TAILS.cli[0]), pi: join(root, ENTRY_TAILS.pi[0]), omp: join(root, ENTRY_TAILS.omp[0]) };
	return { style: "source", cli: join(root, ENTRY_TAILS.cli[1]), pi: join(root, ENTRY_TAILS.pi[1]), omp: join(root, ENTRY_TAILS.omp[1]) };
}

/** Release versions as folder names: 0.6.0, 0.6.0-<commit>, 1.0.0-rc.1 (no slashes, no leading dot). */
export const VERSION_NAME = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

/** `path` ends with `tail` as whole path segments: …/bin/orrery does, …/mybin/orrery does not. */
export function endsWithSegments(path: string, tail: string): boolean {
	return path === tail || path.endsWith(`${sep}${tail}`);
}

/** Whether `path` is `<app>/<one folder>/<tail>` for one of `tails` (by app's literal or real path): an entry in current or a version. */
export function inApp(app: string, path: string, tails: readonly string[]): boolean {
	let real = resolve(app);
	try {
		real = realpathSync(app);
	} catch {
		// no app folder: only the literal path
	}
	for (const root of new Set([resolve(app), real])) {
		const rel = relative(root, resolve(path));
		if (rel === "" || isAbsolute(rel)) continue;
		const [folder, ...rest] = rel.split(sep);
		if (folder === ".." || rest.includes("..")) continue;
		if (tails.includes(rest.join(sep))) return true;
	}
	return false;
}

/**
 * Whether `root` is provably an Orrery: a release (bin/orrery, and a VERSION that names a version) or a checkout
 * (src/cli/main.ts, and a package.json named orrery).
 */
export function isOrreryRoot(root: string): boolean {
	try {
		if (existsSync(join(root, ENTRY_TAILS.cli[0])) && VERSION_NAME.test(readFileSync(join(root, "VERSION"), "utf8").trim())) return true;
	} catch {
		// no VERSION
	}
	try {
		if (existsSync(join(root, ENTRY_TAILS.cli[1])) && (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: unknown }).name === "orrery") return true;
	} catch {
		// no package.json, or not JSON
	}
	return false;
}

/**
 * Whether an absolute path is Orrery's command, so setup may replace a link to it without asking: an entry under this
 * home's app/ (even one a switch left dangling), or the CLI entry of a provable Orrery root elsewhere (isOrreryRoot).
 */
export function isOrreryCommand(path: string, app: string): boolean {
	if (inApp(app, path, ENTRY_TAILS.cli)) return true;
	const full = resolve(path);
	return ENTRY_TAILS.cli.some((tail) => endsWithSegments(full, tail) && isOrreryRoot(full.slice(0, full.length - tail.length - 1) || sep));
}
