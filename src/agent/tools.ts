/**
 * pi, Claude Code, Codex, OMP, OpenCode and Grok as orrery sees them (spec 2026-10-08-orrery-tui-design §3.4, §4.6): found on
 * PATH, their version, whether orrery's side is installed (Codex's and OpenCode's come with each launch: the last hook
 * or plugin check is said; Grok's memory comes with each launch, its hooks and config entries are installed:
 * src/grok/install.ts), and the steps that install it. Node only.
 */

import { execFile, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, chmodSync, constants, copyFileSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ENTRY_TAILS, endsWithSegments, entries, oneLineTarget, type Style } from "../install/layout.ts";
import type { AgentTool } from "./config.ts";
import { codexCheckDetail } from "../codex/check.ts";
import { grokFolderThere, grokInstallSteps, grokWiring } from "../grok/install.ts";
import { opencodeCheckDetail } from "../opencode/check.ts";
import { makeScratch } from "../opencode/scratch.ts";
import { realTarget } from "./guard-paths.ts";
import { runningRoot, versionNumber, wiringRoot } from "./running.ts";
import { safeText } from "./source-labels.ts";

/** "memory": Orrery's side comes with each launch, nothing is installed (Codex: src/codex/launch.ts; OpenCode: src/opencode/launch.ts). */
export type Wiring = "installed" | "missing" | "other" | "update available" | "unknown" | "memory" | "none";

export interface ToolCheck {
	readonly id: AgentTool | "ori" | "wrangler";
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

const LABELS: Record<AgentTool, string> = { pi: "pi", "claude-code": "Claude Code", codex: "Codex", omp: "OMP", opencode: "OpenCode", grok: "Grok" };
export const BINARIES: Record<AgentTool, string> = { pi: "pi", "claude-code": "claude", codex: "codex", omp: "omp", opencode: "opencode", grok: "grok" };

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
	if (ENTRY_TAILS.pi.some((tail) => endsWithSegments(full, tail))) return "pi";
	if (ENTRY_TAILS.omp.some((tail) => endsWithSegments(full, tail))) return "omp";
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

/**
 * A tool's version number from its version line ("codex-cli 0.162.1" → "0.162.1", "opencode v2.0.30" → "2.0.30");
 * undefined when there is none. Codex's and OpenCode's checks are kept by it.
 */
export function codexVersion(line: string | undefined): string | undefined {
	const number = toolVersionNumber(line);
	return /^\d+\.\d+\.\d+/.test(number) ? number : undefined;
}

/** This Orrery's version, as the Codex hook check keeps it; "unknown" for a binary copied out of its release. */
export function orreryVersion(): string {
	try {
		return versionNumber();
	} catch {
		return "unknown";
	}
}

/** Ignore wrapper announcements and trailing chatter; the tool's last version line wins. */
function versionLine(stdout: string): string | undefined {
	return stdout.split("\n").map((line) => safeText(line).trim()).findLast((line) => /^(?:[A-Za-z][A-Za-z -]*[ /])?v?\d+\.\d+\.\d+\b/.test(line));
}

/**
 * `opencode --version` in a scratch home (src/opencode/scratch.ts): OpenCode writes a log line into its data folder
 * even for that, and the person's OpenCode setup is never written to. Empty output when it cannot run.
 */
export function opencodeVersionOutput(path: string, env: NodeJS.ProcessEnv): RunResult {
	let scratch: ReturnType<typeof makeScratch>;
	try {
		scratch = makeScratch(env);
	} catch (error) {
		return { status: null, stdout: "", stderr: reason(error) };
	}
	try {
		const r = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 15_000, env: scratch.env, cwd: scratch.cwd });
		return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
	} finally {
		scratch.remove();
	}
}

/** The Grok Build Orrery was tested with. */
export const GROK_TESTED = "1.0.70";

/**
 * Grok's row: Orrery's hook file and config entries in Grok's folder (src/grok/install.ts grokWiring; the memory itself
 * comes with each launch, in `--rules`), and the version tested. A Grok whose folder is there counts as found, though
 * `grok` is not on PATH.
 */
function grokRow(root: string, env: NodeJS.ProcessEnv, path: string | undefined, version: string | undefined): Pick<ToolCheck, "wiring" | "detail" | "now"> {
	if (path === undefined && !grokFolderThere(env)) return { wiring: "missing", detail: "Grok Build is not on PATH" };
	const wiring = grokWiring(root, env);
	const tested = version === undefined || version === GROK_TESTED ? `tested with Grok ${GROK_TESTED}` : `tested with Grok ${GROK_TESTED}, this is ${version}`;
	return { ...wiring, detail: `${wiring.detail}; ${tested}` };
}

/** pi, Claude Code, Codex, OMP, OpenCode and Grok, in that order. */
export function checkTools(options: { root?: string; env?: NodeJS.ProcessEnv; run?: Runner; probeWrangler?: boolean } = {}): ToolCheck[] {
	const env = options.env ?? process.env;
	const root = options.root ?? wiringRoot(env).root;
	const run: Runner = options.run ?? ((cmd, args) => {
		const r = spawnSync(cmd, [...args], { encoding: "utf8", timeout: 15_000, env });
		return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
	});
	const checks: ToolCheck[] = (["pi", "claude-code", "codex", "omp", "opencode", "grok"] as const).map((id) => {
		const path = findOnPath(BINARIES[id], env);
		const asked = path === undefined ? undefined : id === "opencode" && options.run === undefined ? opencodeVersionOutput(path, env) : run(path, ["--version"]);
		const version = asked === undefined ? undefined : versionLine(asked.stdout);
		const found = { id, label: LABELS[id], ...(path === undefined ? {} : { path }), ...(version === undefined ? {} : { version }) };
		if (id === "codex") return { ...found, wiring: "memory" as const, detail: codexCheckDetail(env, codexVersion(version), orreryVersion()) };
		if (id === "opencode") return { ...found, wiring: "memory" as const, detail: opencodeCheckDetail(env, codexVersion(version), orreryVersion()) };
		if (id === "grok") return { ...found, ...grokRow(root, env, path, codexVersion(version)) };
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
	/**
	 * `text` written to `path` in one rename. A file already there that is not Orrery's is set aside first: by `ours`, a
	 * test of its text (default: pi's and OMP's one-line extension, foreignExtension). `folderMode`: the mode of folders
	 * made for it (default: the umask's).
	 */
	| { readonly kind: "write"; readonly path: string; readonly text: string; readonly describe: string; readonly ours?: (text: string) => boolean; readonly folderMode?: number }
	| { readonly kind: "run"; readonly cmd: string; readonly args: readonly string[]; readonly describe: string }
	/**
	 * Another tool's config at `path` (its text, "" when there is none), changed by `edit` when it is run, after a copy of
	 * it (rewriteKeepingCopy); `said` is shown. `what` is what the edit adds, for the question that asks first.
	 */
	| { readonly kind: "edit"; readonly path: string; readonly what: string; readonly edit: (text: string) => { readonly next: string; readonly said: readonly string[] }; readonly describe: string };

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
	// Grok: the hook file (a file that is not Orrery's set aside), then the config tables it lacks.
	if (check.id === "grok") {
		if (check.wiring !== "missing" && check.wiring !== "other" && check.wiring !== "update available") return [];
		return grokInstallSteps(root, env, check.now);
	}
	return [];
}

/** Today's date as YYYY-MM-DD, local time. */
function today(now = new Date()): string {
	const two = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}

const taken = (path: string) => {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
};

/**
 * Renames something that is not Orrery's out of the way before it is replaced: <path>.before-orrery-<date>, or
 * -2, -3… after it when that name is taken. pi and OMP load only files ending in .ts or .js, so a set-aside extension
 * file is not loaded. Returns the new name. `how: "copy"` copies the file's bytes there instead, never over a file
 * already there, and leaves `path` as it is (a config Orrery is about to change: rewriteKeepingCopy).
 */
export function setAside(path: string, how: "rename" | "copy" = "rename"): string {
	const base = `${path}.before-orrery-${today()}`;
	for (let n = 1; ; n++) {
		const aside = n === 1 ? base : `${base}-${n}`;
		if (taken(aside)) continue;
		if (how === "rename") renameSync(path, aside);
		else {
			try {
				copyFileSync(path, aside, constants.COPYFILE_EXCL);
			} catch (error) {
				if ((error as { code?: unknown }).code === "EEXIST") continue; // taken since: the next name
				throw error;
			}
		}
		return aside;
	}
}

/**
 * Puts `next` in place of the file at `path` (where a link there leads: the person's own file), after a copy of it
 * beside `path` (setAside's name; undefined when there was no file). The new text goes to a fresh file beside it first,
 * with the old file's mode (0600 for a new one, in a 0700 folder made for it), then one rename puts it in place, so the
 * file is never half written.
 */
export function rewriteKeepingCopy(path: string, next: string): string | undefined {
	let target = path;
	let mode = 0o600;
	let there = true;
	try {
		target = realpathSync(path);
		mode = statSync(target).mode & 0o7777;
	} catch (error) {
		if ((error as { code?: unknown }).code !== "ENOENT") throw error;
		there = false;
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	}
	const aside = there ? setAside(path, "copy") : undefined;
	const temp = `${target}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
	try {
		writeFileSync(temp, next, { mode, flag: "wx" });
		chmodSync(temp, mode);
		renameSync(temp, target);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
	return aside;
}

/**
 * Whether pi's or OMP's extension file is someone else's: a link, or anything but Orrery's one line naming an Orrery
 * entry (of any install). Orrery's own line pointing elsewhere is replaced without a copy.
 */
function foreignExtension(file: string): boolean {
	try {
		if (!lstatSync(file).isFile()) return true;
		const spec = oneLineTarget(readFileSync(file, "utf8"));
		return spec === undefined || ![...ENTRY_TAILS.pi, ...ENTRY_TAILS.omp].some((tail) => endsWithSegments(resolve(dirname(file), spec), tail));
	} catch {
		return false; // gone, or unreadable (then checkTools said "unknown" and nothing is replaced)
	}
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Whether the file at `path` is someone else's by `ours`: a link, or text `ours` refuses. Gone or unreadable: no. */
function foreignFile(path: string, ours: (text: string) => boolean): boolean {
	try {
		return !lstatSync(path).isFile() || !ours(readFileSync(path, "utf8"));
	} catch {
		return false;
	}
}

/**
 * Writes `text` to a temporary file beside `path`, then renames it over `path`: a link there is replaced, never written
 * through. A file that is not Orrery's (by `ours`, else Orrery's one-line extension) is renamed aside first (setAside);
 * the new name is returned. If the final rename fails after that, the original is put back; when that fails too, the
 * error names where it is.
 */
function replaceFile(path: string, text: string, ours?: (text: string) => boolean, folderMode?: number): string | undefined {
	mkdirSync(dirname(path), { recursive: true, ...(folderMode === undefined ? {} : { mode: folderMode }) });
	const temp = `${path}.tmp-${process.pid}`;
	try {
		writeFileSync(temp, text);
	} catch (error) {
		rmSync(temp, { force: true });
		throw new Error(`could not write ${path}: ${reason(error)}`);
	}
	let aside: string | undefined;
	try {
		aside = (ours === undefined ? foreignExtension(path) : foreignFile(path, ours)) ? setAside(path) : undefined;
	} catch (error) {
		rmSync(temp, { force: true });
		throw new Error(`could not set ${path} aside: ${reason(error)}`);
	}
	try {
		renameSync(temp, path);
	} catch (error) {
		rmSync(temp, { force: true });
		if (aside === undefined) throw new Error(`could not write ${path}: ${reason(error)}`);
		try {
			renameSync(aside, path);
		} catch {
			throw new Error(`could not write ${path}: ${reason(error)}; the original is at ${aside}`);
		}
		throw new Error(`could not write ${path}: ${reason(error)}; the original was put back`);
	}
	return aside;
}

/**
 * An edit step, run: the file's text as it is now ("" when there is none) through its edit; a change is written with
 * rewriteKeepingCopy, and nothing is written when there is none. What it did, as lines.
 */
function editFile(step: Extract<InstallStep, { kind: "edit" }>): string {
	let text: string | undefined;
	try {
		text = readFileSync(step.path, "utf8");
	} catch (error) {
		if ((error as { code?: unknown }).code !== "ENOENT") throw error;
	}
	const { next, said } = step.edit(text ?? "");
	let output = "";
	if (next !== (text ?? "")) {
		const copy = rewriteKeepingCopy(step.path, next);
		if (copy !== undefined) output += `kept a copy of ${step.path} as ${copy}\n`;
	}
	for (const line of said) output += `${line}\n`;
	return output;
}

/** Runs the steps in order and stops at the first that fails; `output` is what each did, for showing. */
export function runInstall(steps: readonly InstallStep[], run: Runner = realRunner): { ok: boolean; output: string; problem?: string } {
	let output = "";
	for (const step of steps) {
		if (step.kind === "write") {
			try {
				const aside = replaceFile(step.path, step.text, step.ours, step.folderMode);
				if (aside !== undefined) output += `set ${step.path} aside as ${aside}\n`;
			} catch (error) {
				return { ok: false, output: `${output}${reason(error)}\n`, problem: reason(error) };
			}
			output += `wrote ${step.path}\n`;
			continue;
		}
		if (step.kind === "edit") {
			try {
				const edited = editFile(step);
				output += edited;
			} catch (error) {
				const problem = `could not change ${step.path}: ${reason(error)}`;
				return { ok: false, output: `${output}${problem}\n`, problem };
			}
			continue;
		}
		const result = run(step.cmd, step.args);
		output += `$ claude ${step.args.join(" ")}\n${result.stdout}${result.stderr}${result.stdout || result.stderr ? "\n" : ""}`;
		if (result.status !== 0) return { ok: false, output: `${output}${result.status === null ? "did not finish" : `exit ${result.status}`}\n` };
	}
	return { ok: true, output };
}
