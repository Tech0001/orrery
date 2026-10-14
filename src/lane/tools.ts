/**
 * pi, Claude Code, Codex and OMP as orrery sees them (spec 2026-10-08-orrery-tui-design §3.4, §4.6): found on PATH, their
 * version, whether orrery's side is installed, and the steps that install it. Node only.
 */

import { execFile, spawnSync } from "node:child_process";
import { accessSync, constants, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ENTRY_TAILS, entries, type Style } from "../install/layout.ts";
import type { LaneTool } from "./config.ts";
import { realTarget } from "./guard-paths.ts";
import { runningRoot, wiringRoot } from "./running.ts";
import { safeText } from "./source-labels.ts";

export type Wiring = "installed" | "missing" | "other" | "update available" | "unknown" | "none";

export interface ToolCheck {
	readonly id: LaneTool | "ori" | "wrangler";
	readonly signin?: "signed in" | "not signed in" | "unknown";
	readonly label: string;
	readonly path?: string;
	readonly version?: string;
	readonly wiring: Wiring;
	readonly detail: string;
	/** pi, wiring "other": what the extension file is now ("points at /x/src/pi/index.ts"), for the install step's text. */
	readonly now?: string;
	/** Why Orrery will not install here although the entry is not its own: pi and OMP share one extensions folder. */
	readonly blocked?: string;
}

/** TUI-only path display: shorten the user's home, including paths embedded in detail text. */
export function shortHome(text: string, home = homedir()): string {
	const plain = safeText(text);
	const prefix = safeText(home).replace(/\/+$/, "");
	if (!prefix) return plain;
	const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return plain.replace(new RegExp(`(^|[\\s"'\x60(=])${escaped}(?=$|[/\\s"'\x60):;,])`, "g"), "$1~");
}

/** The compact TUI version; probe results and CLI output retain the original tool version line. */
export function toolVersionNumber(version: string | undefined): string {
	return version === undefined ? "—" : version.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/)?.[0] ?? "unknown";
}

export interface RunResult {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

export type Runner = (cmd: string, args: readonly string[]) => RunResult;

/** Runs an install command with a 300 s limit, never through a shell; a kill or failure to start is said in `stderr`. */
export const realRunner: Runner = (cmd, args) => {
	const r = spawnSync(cmd, [...args], { encoding: "utf8", timeout: 300_000 });
	const why = r.error !== undefined ? ((r.error as { code?: unknown }).code === "ETIMEDOUT" ? "timed out after 300 s" : r.error.message) : r.signal !== null ? `stopped by ${r.signal}` : "";
	return { status: r.status, stdout: r.stdout ?? "", stderr: `${r.stderr ?? ""}${why === "" ? "" : `${r.stderr ? "\n" : ""}${why}`}` };
};

const LABELS: Record<LaneTool, string> = { pi: "pi", "claude-code": "Claude Code", codex: "Codex", omp: "OMP" };
export const BINARIES: Record<LaneTool, string> = { pi: "pi", "claude-code": "claude", codex: "codex", omp: "omp" };

export { runningRoot, runningVersion, wiringRoot } from "./running.ts";
/** @deprecated alias for runningRoot */
export const orreryRoot = runningRoot;

/** The first executable file called `name` on PATH. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		if (dir === "") continue;
		const candidate = join(dir, name);
		try {
			accessSync(candidate, constants.X_OK);
			if (statSync(candidate).isFile()) return candidate;
		} catch {
			// not here
		}
	}
	return undefined;
}

/** pi's one-line orrery extension file ($PI_CODING_AGENT_DIR, default ~/.pi/agent). */
export function piExtensionFile(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.PI_CODING_AGENT_DIR || join(env.HOME || homedir(), ".pi", "agent"), "extensions", "orrery.ts");
}

/** The extension file's text: one line that re-exports the pi entry point of the shape `root` has (layout.ts). */
export function piExtensionText(root: string): string {
	return `export { default } from ${JSON.stringify(entries(root).pi)};\n`;
}

/** Why Orrery installs no second entry: with PI_CODING_AGENT_DIR set, pi and OMP read one extensions folder. */
const SHARED = "pi and OMP share one extensions folder (PI_CODING_AGENT_DIR)";

/** OMP's agent folder: $PI_CODING_AGENT_DIR (pi's variable too), else ~/$PI_CONFIG_DIR/agent (default ~/.omp/agent). */
export function ompAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_CODING_AGENT_DIR || join(env.HOME || homedir(), env.PI_CONFIG_DIR || ".omp", "agent");
}

/** OMP's one-line Orrery extension file. */
export function ompExtensionFile(env: NodeJS.ProcessEnv = process.env): string {
	return join(ompAgentDir(env), "extensions", "orrery.ts");
}

/**
 * The OMP extension file's text: one line re-exporting this orrery's OMP entry by a path relative to the file's real
 * folder. OMP rewrites the imports only of files it reaches by relative paths, so an absolute re-export fails to load
 * (research omp-eval.md section 3).
 */
export function ompExtensionText(root: string, file: string): string {
	// Resolve only the root's parent, so an install's "current" link stays in the path.
	const target = entries(join(realTarget(dirname(root)), basename(root))).omp;
	const spec = relative(realTarget(dirname(file)), target);
	return `export { default } from ${JSON.stringify(spec.startsWith(".") ? spec : `./${spec}`)};\n`;
}

/** Whether pi and OMP read the same extension file. */
function sharedFolder(env: NodeJS.ProcessEnv): boolean {
	return resolve(piExtensionFile(env)) === resolve(ompExtensionFile(env));
}

/** Which Orrery entry an extension file's target is, by its tail (either install shape's). */
function entryOf(file: string, target: string): "pi" | "omp" | undefined {
	const full = resolve(dirname(file), target);
	if (ENTRY_TAILS.pi.some((tail) => full.endsWith(tail))) return "pi";
	if (ENTRY_TAILS.omp.some((tail) => full.endsWith(tail))) return "omp";
	return undefined;
}

/** The other install shape, and its entry for `tool` under `root`. */
function otherShape(root: string, tool: "pi" | "omp"): { style: Style; entry: string } {
	const style: Style = entries(root).style === "binary" ? "source" : "binary";
	return { style, entry: join(root, ENTRY_TAILS[tool][style === "binary" ? 0 : 1]) };
}

/** A file naming Orrery's entry of the other shape under this root: written by setup before a switch between shapes. */
const otherShapeWiring = (style: Style, now: string) => ({ wiring: "update available" as const, detail: `Orrery's ${style} entry; setup moves it to this version's`, now });

/** The version in this orrery's claude-plugin/.claude-plugin/plugin.json. */
export function pluginVersion(root: string): string | undefined {
	try {
		const value = JSON.parse(readFileSync(join(root, "claude-plugin", ".claude-plugin", "plugin.json"), "utf8")) as { version?: unknown };
		return typeof value.version === "string" ? value.version : undefined;
	} catch {
		return undefined;
	}
}

const same = (a: string, b: string) => {
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return resolve(a) === resolve(b);
	}
};

/** An install names app/current; its wiring is compared literally so a version-folder path is "other". A checkout compares real paths. */
function sameAsRoot(path: string, rootPath: string, root: string): boolean {
	if (basename(root) === "current" && basename(dirname(root)) === "app") return resolve(path) === resolve(rootPath);
	return same(path, rootPath);
}

/** Whether version a is older than b ("0.1.0" < "0.2.0"). */
function older(a: string, b: string): boolean {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const x = pa[i] ?? 0;
		const y = pb[i] ?? 0;
		if (x !== y) return x < y;
	}
	return false;
}

/** The module specifier in an extension file's text, read as a real string literal. */
function specifier(text: string): string | undefined {
	const double = /from\s+("(?:[^"\\]|\\.)*")/.exec(text)?.[1];
	const single = /from\s+'((?:[^'\\]|\\.)*)'/.exec(text)?.[1];
	try {
		if (double !== undefined) return JSON.parse(double) as string;
		if (single !== undefined) return JSON.parse(`"${single.replace(/\\'/g, "'").replace(/"/g, '\\"')}"`) as string;
	} catch {
		// not a string literal
	}
	return undefined;
}

function piWiring(root: string, env: NodeJS.ProcessEnv): Pick<ToolCheck, "wiring" | "detail" | "now" | "blocked"> {
	const file = piExtensionFile(env);
	let info: ReturnType<typeof lstatSync>;
	try {
		info = lstatSync(file);
	} catch (error) {
		if ((error as { code?: unknown }).code === "ENOENT") return { wiring: "missing", detail: `no ${safeText(file)}` };
		return { wiring: "unknown", detail: `cannot read ${safeText(file)}` };
	}
	if (info.isSymbolicLink()) {
		let to = "somewhere unreadable";
		try {
			to = safeText(readlinkSync(file));
		} catch {
			// keep the default
		}
		return { wiring: "other", detail: `${safeText(file)} is a link to ${to}; install replaces it with a plain file`, now: `a link to ${to}` };
	}
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return { wiring: "unknown", detail: `cannot read ${safeText(file)}` };
	}
	if (text === piExtensionText(root)) return { wiring: "installed", detail: safeText(file) };
	const target = specifier(text);
	if (target === undefined) return { wiring: "other", detail: `${safeText(file)} is not Orrery's one-line extension`, now: "not Orrery's one-line extension" };
	if (sharedFolder(env) && entryOf(file, target) === "omp") {
		return { wiring: "other", detail: `${safeText(file)} is OMP's Orrery extension: ${SHARED}, so Orrery installs only one`, now: "OMP's Orrery extension", blocked: SHARED };
	}
	if (sameAsRoot(target, entries(root).pi, root)) return { wiring: "installed", detail: safeText(file) };
	const other = otherShape(root, "pi");
	if (sameAsRoot(target, other.entry, root)) return otherShapeWiring(other.style, `points at ${safeText(target)}`);
	return { wiring: "other", detail: `points at another Orrery: ${safeText(target)}`, now: `points at ${safeText(target)}` };
}

function ompWiring(root: string, env: NodeJS.ProcessEnv): Pick<ToolCheck, "wiring" | "detail" | "now" | "blocked"> {
	const file = ompExtensionFile(env);
	const shared = sharedFolder(env);
	let info: ReturnType<typeof lstatSync>;
	try {
		info = lstatSync(file);
	} catch (error) {
		if ((error as { code?: unknown }).code === "ENOENT") return { wiring: "missing", detail: `no ${safeText(file)}${shared ? " (pi and OMP share this folder through PI_CODING_AGENT_DIR: only one of them can have Orrery)" : ""}` };
		return { wiring: "unknown", detail: `cannot read ${safeText(file)}` };
	}
	if (info.isSymbolicLink()) {
		let to = "somewhere unreadable";
		try {
			to = safeText(readlinkSync(file));
		} catch {
			// keep the default
		}
		return { wiring: "other", detail: `${safeText(file)} is a link to ${to}; install replaces it with a plain file`, now: `a link to ${to}` };
	}
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return { wiring: "unknown", detail: `cannot read ${safeText(file)}` };
	}
	if (text === ompExtensionText(root, file)) return { wiring: "installed", detail: safeText(file) };
	const target = specifier(text);
	if (target === undefined) return { wiring: "other", detail: `${safeText(file)} is not Orrery's one-line extension`, now: "not Orrery's one-line extension" };
	if (shared && entryOf(file, target) === "pi") {
		return { wiring: "other", detail: `${safeText(file)} is pi's Orrery extension: ${SHARED}, so Orrery installs only one`, now: "pi's Orrery extension", blocked: SHARED };
	}
	const full = resolve(dirname(file), target);
	if (sameAsRoot(full, entries(root).omp, root)) {
		return isAbsolute(target) ? { wiring: "other", detail: `${safeText(file)} re-exports Orrery by an absolute path, which OMP cannot load`, now: "an absolute re-export" } : { wiring: "installed", detail: safeText(file) };
	}
	// The relative re-export names the root's parent by its real path (ompExtensionText).
	const other = otherShape(root, "omp");
	const realOther = join(realTarget(dirname(root)), basename(root), relative(root, other.entry));
	if (sameAsRoot(full, other.entry, root) || sameAsRoot(full, realOther, root)) return otherShapeWiring(other.style, `points at ${safeText(full)}`);
	return { wiring: "other", detail: `points at another Orrery: ${safeText(full)}`, now: `points at ${safeText(full)}` };
}

/** Claude Code's entry for the Orrery plugin (orrery@orrery) as `claude plugin list --json` gives it. */
export interface OrreryPlugin {
	readonly version?: unknown;
	readonly readFromFolder?: unknown;
	readonly enabled?: unknown;
}

/** The Orrery plugin in Claude Code's plugin list: its entry, missing, or why the list cannot be read. */
export function orreryPlugin(path: string, run: Runner): { plugin: OrreryPlugin } | "missing" | { unreadable: string } {
	const listed = run(path, ["plugin", "list", "--json"]);
	let plugins: unknown;
	try {
		// PATH wrappers (for example mise) can announce themselves before the tool's JSON.
		const lines = listed.stdout.split("\n");
		const start = lines.findIndex((line) => /^\s*[\[{]/.test(line));
		plugins = JSON.parse(start < 0 ? "" : lines.slice(start).join("\n"));
	} catch {
		return { unreadable: "claude plugin list --json gave something Orrery cannot read" };
	}
	if (!Array.isArray(plugins)) return { unreadable: "claude plugin list --json gave something Orrery cannot read" };
	// A list whose entries carry no string id is a shape orrery doesn't know: it cannot say the plugin is missing.
	const ids = plugins.filter((p) => typeof p === "object" && p !== null && typeof (p as { id?: unknown }).id === "string");
	if (plugins.length > 0 && ids.length === 0) return { unreadable: "claude plugin list --json lists plugins in a shape Orrery doesn't know" };
	const entry = plugins.find((p) => typeof p === "object" && p !== null && (p as { id?: unknown }).id === "orrery@orrery") as OrreryPlugin | undefined;
	return entry === undefined ? "missing" : { plugin: entry };
}

function claudeWiring(root: string, path: string, run: Runner): Pick<ToolCheck, "wiring" | "detail"> {
	const listed = orreryPlugin(path, run);
	if (listed === "missing") return { wiring: "missing", detail: "the Orrery plugin is not installed" };
	if ("unreadable" in listed) return { wiring: "unknown", detail: listed.unreadable };
	const entry = listed.plugin;
	if (typeof entry.readFromFolder === "string" && !sameAsRoot(entry.readFromFolder, join(root, "claude-plugin"), root)) return { wiring: "other", detail: `reads from another Orrery: ${safeText(entry.readFromFolder)}` };
	const mine = pluginVersion(root);
	if (typeof entry.version === "string" && mine !== undefined && older(entry.version, mine)) return { wiring: "update available", detail: `plugin ${safeText(entry.version)}, this Orrery has ${mine}` };
	return { wiring: "installed", detail: entry.enabled === false ? "installed but turned off in Claude Code" : `plugin ${safeText(String(entry.version ?? ""))}`.trim() };
}

/** Ignore wrapper announcements and trailing chatter; the tool's last version line wins. */
function versionLine(stdout: string): string | undefined {
	return stdout.split("\n").map((line) => safeText(line).trim()).findLast((line) => /^(?:[A-Za-z][A-Za-z -]*[ /])?v?\d+\.\d+\.\d+\b/.test(line));
}

/** pi, Claude Code, Codex and OMP, in that order. */
export function checkTools(options: { root?: string; env?: NodeJS.ProcessEnv; run?: Runner; probeWrangler?: boolean } = {}): ToolCheck[] {
	const env = options.env ?? process.env;
	const root = options.root ?? wiringRoot(env).root;
	const run: Runner = options.run ?? ((cmd, args) => {
		const r = spawnSync(cmd, [...args], { encoding: "utf8", timeout: 15_000, env });
		return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
	});
	const checks: ToolCheck[] = (["pi", "claude-code", "codex", "omp"] as const).map((id) => {
		const path = findOnPath(BINARIES[id], env);
		const version = path === undefined ? undefined : versionLine(run(path, ["--version"]).stdout);
		const found = { id, label: LABELS[id], ...(path === undefined ? {} : { path }), ...(version === undefined ? {} : { version }) };
		if (id === "codex") return { ...found, wiring: "none" as const, detail: "no memory yet" };
		if (id === "pi") return { ...found, ...piWiring(root, env) };
		if (id === "omp") return { ...found, ...ompWiring(root, env) };
		if (path === undefined) return { ...found, wiring: "missing" as const, detail: "Claude Code is not on PATH" };
		return { ...found, ...claudeWiring(root, path, run) };
	});
	// Keep the cheap inventory entry for CLI compatibility. Only Tools runs Wrangler.
	const wranglerPath = findOnPath("wrangler", env) ?? findOnPath("wrangler", { PATH: join(root, "worker", "node_modules", ".bin") });
	const wranglerVersion = options.probeWrangler !== true || wranglerPath === undefined ? undefined : versionLine(run(wranglerPath, ["--version"]).stdout);
	// Only people who installed Wrangler (for a Cloudflare remote) see its row.
	if (wranglerPath === undefined) return [...checks, oriCheck(env)];
	return [...checks, oriCheck(env), {
		id: "wrangler", label: "wrangler", wiring: "none",
		path: wranglerPath,
		...(wranglerVersion === undefined ? {} : { version: wranglerVersion }),
		detail: "Cloudflare Worker tools; setup in docs/remote.md",
	}];
}

/** Ori auth may contact the network, so an offline check cannot promise its sign-in state. */
function oriCheck(env: NodeJS.ProcessEnv): ToolCheck {
	const path = findOnPath("ori", env);
	return { id: "ori", label: "Ori", ...(path === undefined ? {} : { path }), wiring: "none", signin: "unknown", detail: "sign-in unknown (no offline auth command)" };
}

/** Only the public offline version command; never wait for this probe while rendering. */
export async function probeOri(options: { env?: NodeJS.ProcessEnv; timeout?: number } = {}): Promise<ToolCheck> {
	const env = options.env ?? process.env;
	const check = oriCheck(env);
	if (check.path === undefined) return check;
	const version = await new Promise<string>((done) => {
		execFile(check.path!, ["version", "--semver"], {
			env: { ...env, ORI_TELEMETRY: "0", ORI_NO_UPDATE_CHECK: "1", ORI_DISABLE_UPDATES: "1", ORI_CLAUDE_CLOUD_SESSION_SYNC: "0" },
			timeout: Math.max(1, Math.min(options.timeout ?? 3000, 5000)), killSignal: "SIGKILL", maxBuffer: 16_384, encoding: "utf8",
		}, (error, stdout) => {
			const text = versionLine(stdout) ?? "";
			done(error === null && /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(text) ? safeText(text) : "unknown");
		});
	});
	return { ...check, version };
}

export type InstallStep =
	| { readonly kind: "write"; readonly path: string; readonly text: string; readonly describe: string }
	| { readonly kind: "run"; readonly cmd: string; readonly args: readonly string[]; readonly describe: string };

/**
 * What installing or repairing orrery's side of a tool does; empty when there is nothing to do (already installed) or
 * nothing orrery can safely do. Each step's `describe` says what it writes or runs, and for pi what it replaces.
 */
export function installSteps(check: ToolCheck, root: string, env: NodeJS.ProcessEnv = process.env): InstallStep[] {
	// pi and OMP share one extensions folder: Orrery never replaces the other tool's entry.
	if (check.blocked !== undefined) return [];
	// pi and OMP: "update available" is Orrery's entry of the other install shape, rewritten like a missing file.
	if (check.id === "pi" || check.id === "omp") {
		if (check.wiring !== "missing" && check.wiring !== "other" && check.wiring !== "update available") return [];
		const path = check.id === "pi" ? piExtensionFile(env) : ompExtensionFile(env);
		const entry = safeText(check.id === "pi" ? entries(root).pi : entries(root).omp);
		const what = `${check.id === "omp" ? "a relative " : "a "}re-export of ${entry}`;
		const now = check.now ?? "something else";
		const describe =
			check.wiring === "missing"
				? `write ${safeText(path)} (${what})`
				: `${check.wiring === "update available" ? "rewrite" : "replace"} ${safeText(path)} (now ${now}) ${check.wiring === "update available" ? "as" : "with"} ${what}`;
		return [{ kind: "write", path, text: check.id === "pi" ? piExtensionText(root) : ompExtensionText(root, path), describe }];
	}
	if (check.id === "claude-code" && check.path !== undefined) {
		const run = (...args: string[]): InstallStep => ({ kind: "run", cmd: check.path as string, args, describe: `claude ${args.join(" ")}` });
		if (check.wiring === "missing") return [run("plugin", "marketplace", "add", root), run("plugin", "install", "orrery@orrery")];
		// Adding the same marketplace name from a new path repoints it, and the installed plugin follows. `marketplace remove`
		// would also uninstall the plugin and delete its saved options, so it is not used.
		if (check.wiring === "other") return [{ ...run("plugin", "marketplace", "add", root), describe: `claude plugin marketplace add ${root} (moves the Orrery plugin from the other Orrery to ${root})` }];
		if (check.wiring === "update available") return [run("plugin", "marketplace", "update", "orrery"), run("plugin", "update", "orrery@orrery")];
	}
	return [];
}

/** Writes `text` to a temporary file beside `path`, then renames it over `path`: a link there is replaced, never written through. */
function replaceFile(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.tmp-${process.pid}`;
	try {
		writeFileSync(temp, text);
		renameSync(temp, path);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

/** Runs the steps in order and stops at the first that fails; `output` is what each did, for showing. */
export function runInstall(steps: readonly InstallStep[], run: Runner = realRunner): { ok: boolean; output: string } {
	let output = "";
	for (const step of steps) {
		if (step.kind === "write") {
			try {
				replaceFile(step.path, step.text);
			} catch (error) {
				return { ok: false, output: `${output}could not write ${step.path}: ${error instanceof Error ? error.message : String(error)}\n` };
			}
			output += `wrote ${step.path}\n`;
			continue;
		}
		const result = run(step.cmd, step.args);
		output += `$ claude ${step.args.join(" ")}\n${result.stdout}${result.stderr}${result.stdout || result.stderr ? "\n" : ""}`;
		if (result.status !== 0) return { ok: false, output: `${output}${result.status === null ? "did not finish" : `exit ${result.status}`}\n` };
	}
	return { ok: true, output };
}
