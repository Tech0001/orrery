/**
 * npm run install-local [-- --yes]: builds this checkout's last commit as a release for this machine and installs it
 * with that release's own `orrery install --from` (spec 2026-10-13-orrery-releases-design §8), exactly as install.sh
 * and orrery update do. Needs the pinned Bun (.bun-version).
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRelease, hostTarget } from "./build-release.ts";

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const say = (line: string) => process.stdout.write(`${line}\n`);
const git = (...args: string[]) => spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });

const pinned = readFileSync(join(checkout, ".bun-version"), "utf8").trim();
if (Bun.version !== pinned) {
	process.stderr.write(`install-local builds with Bun ${pinned}; this is Bun ${Bun.version}. Install it (for example: mise install bun@${pinned}) and run it again.\n`);
	process.exit(1);
}
if (git("rev-parse", "--verify", "--quiet", "HEAD").status !== 0) throw new Error(`${checkout} has no commit yet`);
if (git("diff", "--quiet", "HEAD", "--", "package-lock.json").status !== 0) {
	process.stderr.write("package-lock.json has uncommitted changes, so node_modules may not match the last commit. Commit it (or undo it) and run npm ci first.\n");
	process.exit(1);
}
if (git("status", "--porcelain").stdout.trim() !== "") say("Installing the last commit; uncommitted changes are not included.");

const work = mkdtempSync(join(tmpdir(), "orrery-install-local-"));
let status = 1;
try {
	const source = join(work, "source");
	const archive = spawnSync("git", ["-C", checkout, "archive", "--format=tar", "--prefix=source/", "HEAD"], { maxBuffer: 1024 * 1024 * 1024 });
	if (archive.status !== 0) throw new Error(`git archive failed: ${String(archive.stderr)}`);
	const tar = spawnSync("tar", ["-x", "-f", "-", "-C", work], { input: archive.stdout });
	if (tar.status !== 0) throw new Error(`tar failed: ${String(tar.stderr)}`);
	symlinkSync(join(checkout, "node_modules"), join(source, "node_modules"));
	process.env.ORRERY_BUILD_COMMIT = git("rev-parse", "--short=7", "HEAD").stdout.trim();
	say(`Building for ${hostTarget()}...`);
	const { folders } = await buildRelease({ from: source, out: join(work, "out"), targets: [hostTarget()], official: false });
	// npm run puts node_modules/.bin first on PATH, and its dev pi would pass for an installed pi.
	const PATH = (process.env.PATH ?? "").split(delimiter).filter((dir) => !/[\\/]node_modules[\\/]\.bin$|[\\/]node-gyp-bin$/.test(dir)).join(delimiter);
	const folder = folders[0] as string;
	const yes = process.argv.slice(2).includes("--yes") ? ["--yes"] : [];
	status = spawnSync(join(folder, "bin", "orrery"), ["install", "--from", folder, ...yes], { stdio: "inherit", env: { ...process.env, PATH } }).status ?? 1;
} finally {
	rmSync(work, { recursive: true, force: true });
}
process.exit(status);
