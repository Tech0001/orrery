/**
 * The two shapes an installed Orrery can have (spec 2026-10-13-orrery-releases-design §6, §7): a release (bin/orrery
 * and packed extensions/*.js, 0.6.0 on) or a source copy (src/ with node_modules, 0.5.0). Wiring follows the shape of
 * the version app/current names, so a rollback across shapes rewires correctly.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

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
