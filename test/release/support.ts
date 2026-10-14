import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

/** A release installed under a scratch home by installRelease. */
export interface InstalledRelease {
	readonly version: string;
	/** <home>/.orrery/app/<version>, read-only. */
	readonly folder: string;
	/** <home>/.orrery/app/current, a link to the version folder. */
	readonly current: string;
	/** A file written after the install, for changedSince. */
	readonly marker: string;
	/** Makes the version folder writable again and removes it. */
	readonly remove: () => void;
}

/** `release` installed under `home` as the spec lays it out (§3): copied to .orrery/app/<VERSION>, made read-only, linked from app/current. */
export function installRelease(release: string, home: string): InstalledRelease {
	const version = readFileSync(join(release, "VERSION"), "utf8").trim();
	const app = join(home, ".orrery", "app");
	const folder = join(app, version);
	mkdirSync(app, { recursive: true });
	cpSync(release, folder, { recursive: true });
	chmodTree(folder, "a-w");
	symlinkSync(version, join(app, "current"));
	const marker = join(home, ".orrery", "installed-at");
	writeFileSync(marker, "");
	return {
		version,
		folder,
		current: join(app, "current"),
		marker,
		remove: () => {
			chmodTree(folder, "u+w");
			rmSync(folder, { recursive: true, force: true });
		},
	};
}

function chmodTree(folder: string, mode: string): void {
	const r = spawnSync("chmod", ["-R", mode, folder], { encoding: "utf8" });
	if (r.status !== 0) throw new Error(`chmod -R ${mode} failed: ${r.stderr}`);
}

/** What under `folder` changed after `marker` was written (find -newer): nothing, for a release a host only loads. */
export function changedSince(folder: string, marker: string): string[] {
	const r = spawnSync("find", [folder, "-newer", marker], { encoding: "utf8" });
	if (r.status !== 0) throw new Error(`find failed: ${r.stderr}`);
	return r.stdout.split("\n").filter((line) => line !== "");
}
