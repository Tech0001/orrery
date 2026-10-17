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

/** The Bun releases are built with (.bun-version): bin/orrery carries this Bun's runtime. */
export const PINNED_BUN = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", ".bun-version"), "utf8").trim();

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
 * The compiled CLI at <folder>/bin/orrery. --bytecode starts it in about 20 ms instead of 80 (a Claude Code hook runs it
 * on every prompt); it needs --format=esm for Orrery's top-level await. --sourcemap embeds the source map, so a stack
 * names src/…ts files; the copy Bun also writes beside the binary (orrery.map, about 11 MB) is not needed and is removed.
 */
function compile(from: string, folder: string, target: Target): void {
	mkdirSync(join(folder, "bin"), { recursive: true });
	const flags = ["--compile", "--bytecode", "--format=esm", `--target=${BUN_TARGET[target]}`, "--sourcemap"];
	run(process.execPath, ["build", ...flags, "--outfile", join(folder, "bin", "orrery"), join(from, "src", "cli", "main.ts")], from);
	rmSync(join(folder, "bin", "orrery.map"), { force: true });
}

const BOTH = (names: string[]) => names.flatMap((n) => [`@earendil-works/${n}`, `@mariozechner/${n}`]);
/** What pi gives extensions, compiled (virtualModules) and npm (aliases) alike. */
export const PI_SUPPLIED: readonly string[] = [
	"typebox", "typebox/compile", "typebox/value", "@sinclair/typebox", "@sinclair/typebox/compile", "@sinclair/typebox/value",
	...BOTH(["pi-agent-core", "pi-tui", "pi-ai", "pi-ai/compat", "pi-ai/oauth", "pi-ai/providers/all", "pi-coding-agent"]),
];
/**
 * What OMP rewrites onto its own copies; providers/all and typebox are not among them, so omp.js carries those. The bare
 * pi-ai is left off too: Bun keeps out every subpath of an external package name, and that would leave providers/all
 * to OMP, which has none. OMP's config registry is its own; src/omp/settings.ts loads it inside a try.
 */
export const OMP_SUPPLIED: readonly string[] = [...BOTH(["pi-agent-core", "pi-tui", "pi-ai/compat", "pi-ai/oauth", "pi-coding-agent"]), "@oh-my-pi/pi-coding-agent/config/registry"];
/** src/agent/models.ts's import of this repo's own pi-ai, which only OMP takes: pi.js leaves it out (omp.js packs it). */
const OMP_FALLBACK = "*/node_modules/@earendil-works/pi-ai/dist/compat.js";
/**
 * What OpenCode 2.0.30 gives a plugin (packages/plugin/src/runtime.ts): its own "effect" and "@opencode/plugin", and
 * every subpath of them, and it refuses a plugin's own copies. Orrery's plugin imports neither; they stay out if it does.
 */
export const OPENCODE_SUPPLIED: readonly string[] = ["effect", "@opencode/plugin"];

/**
 * extensions/<name>.js (+ .map) from one entry point, leaving `external` to the host. `target`: the runtime it is for
 * (pi and OMP load extensions on Node or Bun, OpenCode only on Bun).
 */
function pack(from: string, folder: string, entry: string, name: string, external: readonly string[], target: "node" | "bun" = "node"): void {
	run(process.execPath, ["build", join(from, entry), `--target=${target}`, "--format=esm", "--sourcemap=linked", "--outdir", join(folder, "extensions"), `--entry-naming=${name}.[ext]`, ...external.flatMap((e) => ["--external", e])], from);
}

/** A package-lock.json (lockfileVersion 3) entry, keyed by its folder ("node_modules/a/node_modules/b"). */
interface LockEntry {
	name?: string;
	version?: string;
	dev?: boolean;
}

/** A package.json's license: its SPDX expression ("MIT", "(MIT OR Apache-2.0)"), from the older forms too. */
function licenseOf(json: { license?: unknown; licenses?: unknown }): string | undefined {
	const type = (value: unknown) => (typeof value === "string" ? value : typeof (value as { type?: unknown } | null)?.type === "string" ? (value as { type: string }).type : undefined);
	if (json.license !== undefined) return type(json.license);
	const types = Array.isArray(json.licenses) ? json.licenses.map(type) : [];
	return types.length > 0 && types.every((t) => t !== undefined) ? types.join(" OR ") : undefined;
}

/** A package.json person ("Name <email> (url)", or { name, email, url }) as one line. */
function personOf(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	const { name, email, url } = (value ?? {}) as { name?: unknown; email?: unknown; url?: unknown };
	if (typeof name !== "string") return undefined;
	return [name, typeof email === "string" ? `<${email}>` : "", typeof url === "string" ? `(${url})` : ""].filter((part) => part !== "").join(" ");
}

/** The license ids an SPDX expression names: "(MIT OR Apache-2.0)" gives MIT and Apache-2.0. */
function licenseIds(expression: string): string[] {
	return expression.replace(/[()]/g, " ").split(/\s+/).filter((word) => word !== "" && !/^(AND|OR|WITH)$/i.test(word));
}

/**
 * THIRD_PARTY_LICENSES: first the Bun runtime compiled into bin/orrery, with Bun's own LICENSE.md for the pinned version
 * kept verbatim in `texts` (bun-LICENSE.md: it names what Bun links statically, JavaScriptCore/WebKit under the LGPL
 * among them, and where Bun's WebKit source is; Bun itself is MIT). Then every production package (what the binary and
 * extensions may contain) with its license and author from its package.json, then its license file. A package that
 * ships none is under the standard text of each license it names, given once at the end from `texts` (<SPDX id>.txt,
 * from the SPDX license list; MIT's has no copyright line, as the author line names the holder). An id with no text
 * there fails the build, so a new dependency can't ship without its license.
 *
 * The packages are package-lock.json's, less the dev ones, each read from its folder; one not installed here (another
 * platform's optional binary) is left out. Not `npm ls`: it misreads a linked node_modules, and under `bun --bun` npm
 * runs on Bun and its output can come back cut short.
 */
export function thirdPartyLicenses(from: string, texts: string = join(from, "scripts", "licenses")): string {
	const lock = JSON.parse(readFileSync(join(from, "package-lock.json"), "utf8")) as { packages: Record<string, LockEntry> };
	const shipped = new Map<string, string>();
	for (const [folder, entry] of Object.entries(lock.packages)) {
		const path = join(from, folder);
		if (folder === "" || entry.dev === true || entry.version === undefined || !existsSync(path)) continue;
		shipped.set(`${entry.name ?? folder.slice(folder.lastIndexOf("node_modules/") + "node_modules/".length)}@${entry.version}`, path);
	}
	const parts = [
		"Orrery's release contains the Bun runtime (in bin/orrery) and code from these packages. Each one's license follows.\n",
		"A package that ships no license file is under the standard text of its license, given once at the end of this file;\n",
		"its author is the copyright holder.\n",
	];
	const bun = join(texts, "bun-LICENSE.md");
	if (!existsSync(bun)) throw new Error(`no ${bun}: add Bun's LICENSE.md from github.com/oven-sh/bun at the tag bun-v${PINNED_BUN}, as it is`);
	parts.push(
		`\n==== Bun runtime (inside bin/orrery) ====\nBun ${PINNED_BUN}'s LICENSE.md, from github.com/oven-sh/bun at the tag bun-v${PINNED_BUN}. Bun itself is under the MIT license, whose standard text is at the end of this file.\n`,
		readFileSync(bun, "utf8"),
	);
	const needed = new Map<string, string[]>([["MIT", ["the Bun runtime"]]]); // license id -> who needs its standard text
	for (const [key, path] of [...shipped].sort(([a], [b]) => a.localeCompare(b))) {
		const json = JSON.parse(readFileSync(join(path, "package.json"), "utf8")) as { license?: unknown; licenses?: unknown; author?: unknown };
		const license = licenseOf(json);
		parts.push(`\n==== ${key} ====\nLicense: ${license ?? "not given in the package"}\nAuthor: ${personOf(json.author) ?? "not given in the package"}\n`);
		const file = readdirSync(path).find((name) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name));
		if (file !== undefined) {
			parts.push(readFileSync(join(path, file), "utf8"));
			continue;
		}
		if (license === undefined) throw new Error(`${key} ships no license file and names no license`);
		const ids = licenseIds(license);
		parts.push(`(no license file in the package: the standard ${ids.join(" and ")} text${ids.length > 1 ? "s are" : " is"} at the end of this file)\n`);
		for (const id of ids) needed.set(id, [...(needed.get(id) ?? []), key]);
	}
	const textOf = (id: string) => join(texts, `${id}.txt`);
	const missing = [...needed].filter(([id]) => !/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(id) || !existsSync(textOf(id)));
	if (missing.length > 0) {
		throw new Error(`no standard license text for ${missing.map(([id, users]) => `${id} (${users.join(", ")})`).join("; ")}: add scripts/licenses/<id>.txt from the SPDX license list`);
	}
	if (needed.size > 0) {
		parts.push("\n==== Standard license texts ====\n");
		for (const id of [...needed.keys()].sort()) parts.push(`\n---- ${id} ----\n${readFileSync(textOf(id), "utf8")}`);
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
		pack(from, folder, "src/pi/index.ts", "pi", [...PI_SUPPLIED, OMP_FALLBACK]);
		pack(from, folder, "src/omp/index.ts", "omp", OMP_SUPPLIED);
		// OpenCode loads a plugin folder (extensions/opencode), from its server.* file.
		pack(from, folder, "src/opencode/plugin/server.ts", "opencode/server", OPENCODE_SUPPLIED, "bun");
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
	if (Bun.version !== PINNED_BUN) throw new Error(`build with Bun ${PINNED_BUN} (this is ${Bun.version}); see CONTRIBUTING.md`);
	const targets = (values.target ?? ["host"]).map((t) => (t === "host" ? hostTarget() : t)) as Target[];
	for (const t of targets) if (!TARGETS.includes(t)) throw new Error(`unknown target ${t} (${TARGETS.join(", ")} or host)`);
	const out = resolve(values.out ?? "dist");
	const built = await buildRelease({ from: values.from ?? join(dirname(fileURLToPath(import.meta.url)), ".."), out, targets, official: values.official === true, archive: values.archive === true });
	if (built.archives.length > 0) writeSums(out, built.archives);
	for (const folder of built.folders) process.stdout.write(`${folder}\n`);
}
