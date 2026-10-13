import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = fileURLToPath(new URL("../..", import.meta.url));
export const PINNED_BUN = readFileSync(join(REPO, ".bun-version"), "utf8").trim();

/** bun on PATH at the pinned version: the release tests build with it and skip without it. */
export const bunReady: boolean = (() => {
	const r = spawnSync("bun", ["--version"], { encoding: "utf8" });
	return r.status === 0 && r.stdout.trim() === PINNED_BUN;
})();

let built: Promise<string> | undefined;
let out: string | undefined;

/**
 * One host release folder for this test file, built once (about a second). It is about 100 MB, and a temp folder can
 * be memory (tmpfs): a file that builds one removes it with afterAll(removeBuiltRelease).
 */
export function builtRelease(): Promise<string> {
	built ??= (async () => {
		out = mkdtempSync(join(tmpdir(), "orrery-release-"));
		const r = spawnSync("bun", [join(REPO, "scripts", "build-release.ts"), "--target", "host", "--out", out], { encoding: "utf8", cwd: REPO });
		if (r.status !== 0) throw new Error(`build-release failed: ${r.stderr || r.stdout}`);
		const folder = r.stdout.trim().split("\n").at(-1) as string;
		return folder;
	})();
	return built;
}

/** Removes the folder builtRelease made, if any. */
export function removeBuiltRelease(): void {
	if (out !== undefined) rmSync(out, { recursive: true, force: true });
	out = undefined;
	built = undefined;
}
