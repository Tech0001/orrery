/**
 * Builds Orrery release folders (and, with --archive, orrery-<os>-<arch>.tar.gz plus SHA256SUMS) from a source tree
 * (spec 2026-10-13-orrery-releases-design §3, §4). Runs on Bun: `bun scripts/build-release.ts [--target T|host]...
 * [--official] [--archive] [--out DIR] [--from DIR]`. --official names the release by package.json's version alone
 * (CI, for a tag); otherwise the version is <package version>-<7-char commit of --from's HEAD>. Prints each release
 * folder's path, one per line, last.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export type Target = "linux-x64" | "linux-arm64" | "darwin-arm64" | "darwin-x64";
export const TARGETS: readonly Target[] = ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64"];
const BUN_TARGET: Record<Target, string> = {
	"linux-x64": "bun-linux-x64-baseline",
	"linux-arm64": "bun-linux-arm64",
	"darwin-arm64": "bun-darwin-arm64",
	"darwin-x64": "bun-darwin-x64",
};

export function hostTarget(): Target {
	const os = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : undefined;
	const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : undefined;
	if (os === undefined || arch === undefined) throw new Error(`no Orrery release for ${process.platform}-${process.arch}`);
	return `${os}-${arch}`;
}

function run(cmd: string, args: string[], cwd: string): string {
	const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
	if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${(r.stderr || r.stdout || String(r.error)).trim()}`);
	return r.stdout;
}

function versionOf(from: string, official: boolean): string {
	const { version } = JSON.parse(readFileSync(join(from, "package.json"), "utf8")) as { version: string };
	if (official) return version;
	const sha = (process.env.ORRERY_BUILD_COMMIT ?? run("git", ["-C", from, "rev-parse", "--short=7", "HEAD"], from)).trim();
	return `${version}-${sha}`;
}

/**
 * The compiled CLI at <folder>/bin/orrery. --sourcemap embeds the source map, so a stack names src/…ts files; the copy
 * Bun also writes beside the binary (orrery.map, about 11 MB) is not needed and is removed.
 */
function compile(from: string, folder: string, target: Target): void {
	mkdirSync(join(folder, "bin"), { recursive: true });
	run(process.execPath, ["build", "--compile", `--target=${BUN_TARGET[target]}`, "--sourcemap", "--outfile", join(folder, "bin", "orrery"), join(from, "src", "cli", "main.ts")], from);
	rmSync(join(folder, "bin", "orrery.map"), { force: true });
}

/** A package-lock.json (lockfileVersion 3) entry, keyed by its folder ("node_modules/a/node_modules/b"). */
interface LockEntry {
	name?: string;
	version?: string;
	dev?: boolean;
	devOptional?: boolean;
}

/**
 * Every production package's license text (what the binary and extensions may contain): package-lock.json's packages
 * less the dev ones, each read from its folder. A package not installed here, such as another platform's optional
 * binary, is left out. Not `npm ls`: it misreads a linked node_modules, and under `bun --bun` npm runs on Bun and its
 * output can come back cut short.
 */
function thirdPartyLicenses(from: string): string {
	const lock = JSON.parse(readFileSync(join(from, "package-lock.json"), "utf8")) as { packages: Record<string, LockEntry> };
	const seen = new Map<string, { path: string; license: string }>();
	for (const [folder, entry] of Object.entries(lock.packages)) {
		const path = join(from, folder);
		if (folder === "" || entry.dev === true || entry.devOptional === true || entry.version === undefined || !existsSync(path)) continue;
		const key = `${entry.name ?? folder.slice(folder.lastIndexOf("node_modules/") + "node_modules/".length)}@${entry.version}`;
		if (seen.has(key)) continue;
		const { license } = JSON.parse(readFileSync(join(path, "package.json"), "utf8")) as { license?: unknown };
		seen.set(key, { path, license: typeof license === "string" ? license : "see the package" });
	}
	const parts = ["Orrery's release contains code from these packages. Each package's license follows.\n"];
	for (const [key, { path, license }] of [...seen].sort(([a], [b]) => a.localeCompare(b))) {
		const file = readdirSync(path).find((name) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name));
		parts.push(`\n==== ${key} (${license}) ====\n${file === undefined ? "(no license file in the package)\n" : readFileSync(join(path, file), "utf8")}`);
	}
	return parts.join("");
}

export async function buildRelease(options: { from: string; out: string; targets: Target[]; official: boolean; archive?: boolean }): Promise<{ version: string; folders: string[]; archives: string[] }> {
	const from = resolve(options.from);
	const version = versionOf(from, options.official);
	const licenses = thirdPartyLicenses(from);
	mkdirSync(options.out, { recursive: true });
	const folders: string[] = [];
	const archives: string[] = [];
	for (const target of options.targets) {
		const top = `orrery-${version}-${target}`;
		const folder = join(options.out, top);
		rmSync(folder, { recursive: true, force: true });
		mkdirSync(join(folder, "extensions"), { recursive: true });
		compile(from, folder, target);
		cpSync(join(from, ".claude-plugin"), join(folder, ".claude-plugin"), { recursive: true });
		cpSync(join(from, "claude-plugin"), join(folder, "claude-plugin"), { recursive: true, filter: (src) => basename(src) !== "tests" });
		cpSync(join(from, "deploy", "workstation"), join(folder, "deploy", "workstation"), { recursive: true });
		cpSync(join(from, "LICENSE"), join(folder, "LICENSE"));
		writeFileSync(join(folder, "THIRD_PARTY_LICENSES"), licenses);
		writeFileSync(join(folder, "VERSION"), `${version}\n`);
		chmodSync(join(folder, "bin", "orrery"), 0o755);
		folders.push(folder);
		if (options.archive === true) {
			const archive = join(options.out, `orrery-${target}.tar.gz`);
			run("tar", ["-czf", archive, "-C", options.out, top], options.out);
			archives.push(archive);
		}
	}
	return { version, folders, archives };
}

/** SHA256SUMS beside the archives, in sha256sum's format ("<hex>  <name>"). */
export function writeSums(out: string, archives: string[]): string {
	const lines = archives.map((path) => `${createHash("sha256").update(readFileSync(path)).digest("hex")}  ${basename(path)}`).sort((a, b) => a.slice(66).localeCompare(b.slice(66)));
	const file = join(out, "SHA256SUMS");
	writeFileSync(file, `${lines.join("\n")}\n`);
	return file;
}

if (import.meta.main) {
	const { values } = parseArgs({ options: { target: { type: "string", multiple: true }, official: { type: "boolean" }, archive: { type: "boolean" }, out: { type: "string" }, from: { type: "string" } } });
	const pinned = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", ".bun-version"), "utf8").trim();
	if (Bun.version !== pinned) throw new Error(`build with Bun ${pinned} (this is ${Bun.version}); see CONTRIBUTING.md`);
	const targets = (values.target ?? ["host"]).map((t) => (t === "host" ? hostTarget() : t)) as Target[];
	for (const t of targets) if (!TARGETS.includes(t)) throw new Error(`unknown target ${t} (${TARGETS.join(", ")} or host)`);
	const out = resolve(values.out ?? "dist");
	const built = await buildRelease({ from: values.from ?? join(dirname(fileURLToPath(import.meta.url)), ".."), out, targets, official: values.official === true, archive: values.archive === true });
	if (built.archives.length > 0) writeSums(out, built.archives);
	for (const folder of built.folders) process.stdout.write(`${folder}\n`);
}
