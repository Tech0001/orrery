/**
 * npm run install-local (spec 2026-10-13-orrery-home-and-install §5): the checkout's last commit is staged in
 * <home>/app/.staging-*, checked, renamed to app/<version>, and app/current is switched to it in one rename. Older
 * versions go, except the newest three and any a live lane runs. Lanes' data is never touched.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { defaultConfigPath, loadConfig } from "../lane/config.ts";
import { orreryHome } from "../lane/home.ts";
import { findOnPath, type Runner } from "../lane/tools.ts";

export interface InstallOptions {
	checkout: string;
	env: NodeJS.ProcessEnv;
	run?: Runner;
	/** False keeps dev packages in the installed copy (npm ci without --omit=dev). */
	omitDev?: boolean;
	/** "minimal" runs only `--help`; "full" (the default) also a read-only `status` and the Bun store check. */
	checks?: "minimal" | "full";
	log?: (line: string) => void;
}

/** Versions kept by history alone; current and versions live lanes run are kept besides. */
const KEEP = 3;

/** Runs commands with `env` (its PATH and HOME), never through a shell; npm runs no package scripts. */
export function envRunner(env: NodeJS.ProcessEnv, timeout = 600_000): Runner {
	const withEnv = { ...env, npm_config_ignore_scripts: "true", npm_config_update_notifier: "false" };
	return (cmd, args) => {
		const r = spawnSync(cmd, [...args], { encoding: "utf8", env: withEnv, timeout, maxBuffer: 64 * 1024 * 1024 });
		const why = r.error !== undefined ? r.error.message : r.signal !== null ? `stopped by ${r.signal}` : "";
		return { status: r.status, stdout: r.stdout ?? "", stderr: `${r.stderr ?? ""}${why === "" ? "" : `${r.stderr ? "\n" : ""}${why}`}` };
	};
}

const firstLine = (text: string) => text.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";
const failure = (r: { status: number | null; stderr: string }) => firstLine(r.stderr) || (r.status === null ? "did not finish" : `exit ${r.status}`);

/** A path as the user would type it: their home as ~. */
function shown(path: string, env: NodeJS.ProcessEnv): string {
	const home = (env.HOME || homedir()).replace(/\/+$/, "");
	return home !== "" && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

const appDir = (env: NodeJS.ProcessEnv) => join(orreryHome(env), "app");

/** `${package.json version}-${short commit}` of the checkout's HEAD. */
export function versionName(checkout: string, run: Runner): string {
	const pkg = run("git", ["-C", checkout, "show", "HEAD:package.json"]);
	if (pkg.status !== 0) throw new Error(`${checkout}'s last commit has no package.json`);
	let version: unknown;
	try {
		version = (JSON.parse(pkg.stdout) as { version?: unknown }).version;
	} catch {
		// not JSON: said below
	}
	if (typeof version !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(version)) throw new Error(`${checkout}'s last commit has no usable version in package.json`);
	const sha = run("git", ["-C", checkout, "rev-parse", "--short=7", "HEAD"]);
	if (sha.status !== 0) throw new Error(`${checkout}: git rev-parse failed: ${failure(sha)}`);
	return `${version}-${sha.stdout.trim()}`;
}

/** Takes app/.install.lock (app must exist); the returned function releases it. */
export function holdInstallLock(env: NodeJS.ProcessEnv): () => void {
	const lock = join(appDir(env), ".install.lock");
	let fd: number;
	try {
		fd = openSync(lock, "wx", 0o600);
	} catch (error) {
		if ((error as { code?: unknown }).code === "EEXIST") throw new Error(`another install is running (remove ${shown(lock, env)} if none is)`);
		throw error;
	}
	try {
		writeSync(fd, `${process.pid}\n`);
	} finally {
		closeSync(fd);
	}
	return () => rmSync(lock, { force: true });
}

/** The version app/current names, if any. */
function currentName(app: string): string | undefined {
	try {
		return basename(readlinkSync(join(app, "current")));
	} catch {
		return undefined;
	}
}

function readHistory(app: string): string[] {
	try {
		return readFileSync(join(app, "history"), "utf8").split("\n").map((line) => line.trim()).filter((line) => line !== "");
	} catch {
		return [];
	}
}

/** The version folders: every real folder in app/ but the dot ones (staging). */
function versionFolders(app: string): string[] {
	try {
		return readdirSync(app, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name);
	} catch {
		return [];
	}
}

const isFolder = (path: string) => {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
};

/**
 * Points app/current at `version` in one rename. app/history is install order: `record` appends the version (an install,
 * unless it already ends the list); a rollback records nothing, so walking back stays a walk back.
 */
function switchTo(app: string, version: string, record: boolean): void {
	const next = join(app, "current.new");
	rmSync(next, { force: true });
	symlinkSync(version, next);
	renameSync(next, join(app, "current"));
	if (record && readHistory(app).at(-1) !== version) appendFileSync(join(app, "history"), `${version}\n`, { mode: 0o600 });
}

function alive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid < 1) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as { code?: unknown }).code === "EPERM";
	}
}

/**
 * What one lane's status.json says about the version it runs: only pid (an integer), open (a boolean, may be absent) and
 * version (a string) are read. "none": no file, so no running lane. "unknown": a file that cannot be read that way.
 */
function laneRun(dir: string): { version: string; open: boolean; pid: number } | "none" | "unknown" {
	let text: string;
	try {
		text = readFileSync(join(dir, "status.json"), "utf8");
	} catch (error) {
		return (error as { code?: unknown }).code === "ENOENT" ? "none" : "unknown";
	}
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		return "unknown";
	}
	if (typeof json !== "object" || json === null) return "unknown";
	const { pid, open, version } = json as { pid?: unknown; open?: unknown; version?: unknown };
	if (typeof pid !== "number" || !Number.isInteger(pid) || typeof version !== "string" || (open !== undefined && typeof open !== "boolean")) return "unknown";
	return { version, open: open !== false, pid };
}

/**
 * Which lanes run each version, by their status files (open, process alive). `unreadable` says why the answer cannot be
 * trusted (config or a status file unreadable); then nothing may be deleted.
 */
function laneVersions(env: NodeJS.ProcessEnv): { versions: Map<string, string[]>; unreadable?: string } {
	const versions = new Map<string, string[]>();
	const path = defaultConfigPath(env);
	if (!existsSync(path)) return { versions };
	let config: ReturnType<typeof loadConfig>;
	try {
		config = loadConfig(path);
	} catch {
		return { versions, unreadable: `${shown(path, env)} could not be read to see which versions lanes run` };
	}
	let unreadable: string | undefined;
	for (const lane of config.lanes.values()) {
		const run = laneRun(lane.dir);
		if (run === "unknown") unreadable ??= `lane ${lane.name}'s status.json could not be read to see which version it runs`;
		if (run === "none" || run === "unknown" || !run.open || !alive(run.pid)) continue;
		versions.set(run.version, [...(versions.get(run.version) ?? []), lane.name]);
	}
	return { versions, ...(unreadable === undefined ? {} : { unreadable }) };
}

/** Removes the versions no one needs: beyond the newest three in history, not current, not run by a live lane. */
function collect(app: string, env: NodeJS.ProcessEnv, log: (line: string) => void): string[] {
	const { versions: live, unreadable } = laneVersions(env);
	if (unreadable !== undefined) {
		log(`Kept every older version: ${unreadable}.`);
		return [];
	}
	const keep = new Set<string>();
	const history = readHistory(app);
	for (let i = history.length - 1; i >= 0 && keep.size < KEEP; i--) keep.add(history[i]);
	const current = currentName(app);
	if (current !== undefined) keep.add(current);
	for (const version of live.keys()) keep.add(version);
	const removed = versionFolders(app).filter((name) => !keep.has(name)).sort();
	for (const name of removed) rmSync(join(app, name), { recursive: true, force: true });
	return removed;
}

/** Writes the checkout's HEAD into `into`: git archive piped to tar, so no ignored or untracked file comes along. */
function extract(checkout: string, into: string, env: NodeJS.ProcessEnv): void {
	const archive = spawnSync("git", ["-C", checkout, "archive", "--format=tar", "HEAD"], { env, maxBuffer: 1024 * 1024 * 1024 });
	if (archive.status !== 0) throw new Error(`git archive failed: ${firstLine(String(archive.stderr ?? archive.error ?? ""))}`);
	const tar = spawnSync("tar", ["-x", "-f", "-", "-C", into], { env, input: archive.stdout });
	if (tar.status !== 0) throw new Error(`tar could not unpack the commit: ${firstLine(String(tar.stderr ?? tar.error ?? ""))}`);
}

/** The staged copy must answer --help; "full" also runs a read-only status against the real config and the Bun store check. */
function check(staging: string, options: InstallOptions, run: Runner): void {
	const main = join(staging, "src", "cli", "main.ts");
	const cli = (command: string, ...args: string[]) => ({ show: `node src/cli/main.ts ${command}`, cmd: process.execPath, args: ["--disable-warning=ExperimentalWarning", main, command, ...args] });
	const checks = [cli("--help")];
	if (options.checks !== "minimal") {
		const config = defaultConfigPath(options.env);
		if (existsSync(config)) checks.push(cli("status", "--config", config));
		if (findOnPath("bun", options.env) !== undefined) checks.push({ show: "npm run test:bun", cmd: "npm", args: ["--prefix", staging, "run", "test:bun"] });
	}
	for (const { show, cmd, args } of checks) {
		const result = run(cmd, args);
		if (result.status !== 0) throw new Error(`check failed: ${show}: ${failure(result)}`);
	}
}

/** Builds app/<version> through a staging folder, which is removed if any step fails. */
function stage(checkout: string, app: string, version: string, options: InstallOptions, run: Runner, log: (line: string) => void): void {
	const staging = join(app, `.staging-${randomUUID()}`);
	mkdirSync(staging, { mode: 0o700 });
	try {
		extract(checkout, staging, options.env);
		log(`Installing packages for ${version} (npm ci${options.omitDev === false ? "" : " --omit=dev"})...`);
		const npm = run("npm", ["ci", "--prefix", staging, ...(options.omitDev === false ? [] : ["--omit=dev"]), "--ignore-scripts", "--no-audit", "--no-fund"]);
		if (npm.status !== 0) throw new Error(`npm ci failed in the staged copy: ${failure(npm)}`);
		log(`Checking ${version}...`);
		check(staging, options, run);
		renameSync(staging, join(app, version));
	} catch (error) {
		rmSync(staging, { recursive: true, force: true });
		throw error;
	}
}

/** Installs the checkout's HEAD and switches app/current to it. `previous` is what current named before a switch. */
export function install(options: InstallOptions): { version: string; previous?: string; removed: string[] } {
	const { env } = options;
	const run = options.run ?? envRunner(env);
	const log = options.log ?? (() => {});
	const top = run("git", ["-C", options.checkout, "rev-parse", "--show-toplevel"]);
	if (top.status !== 0) throw new Error(`${options.checkout} is not a git checkout`);
	const checkout = top.stdout.trim();
	if (run("git", ["-C", checkout, "rev-parse", "--verify", "--quiet", "HEAD"]).status !== 0) throw new Error(`${options.checkout} has no commit yet`);
	if (run("git", ["-C", checkout, "status", "--porcelain"]).stdout.trim() !== "") log("Installing the last commit; uncommitted changes are not included.");
	const version = versionName(checkout, run);
	const home = orreryHome(env);
	const app = join(home, "app");
	mkdirSync(home, { recursive: true, mode: 0o700 });
	chmodSync(home, 0o700); // an existing home may have been made looser
	mkdirSync(app, { recursive: true, mode: 0o700 });
	const release = holdInstallLock(env);
	try {
		// Under the lock, a staging folder is what an interrupted install left.
		for (const name of readdirSync(app)) {
			if (name.startsWith(".staging-")) rmSync(join(app, name), { recursive: true, force: true });
		}
		const previous = currentName(app);
		if (isFolder(join(app, version))) {
			if (previous === version) {
				log(`${version} is already installed.`);
				return { version, removed: [] };
			}
		} else {
			stage(checkout, app, version, options, run, log);
		}
		switchTo(app, version, true);
		return { version, ...(previous === undefined ? {} : { previous }), removed: collect(app, env, log) };
	} finally {
		release();
	}
}

/** Switches app/current back to the latest version before it in install order (app/history) that still has a folder. */
export function rollback(env: NodeJS.ProcessEnv): { from: string; to: string } {
	const app = appDir(env);
	if (currentName(app) === undefined) throw new Error("Orrery is not installed yet: run npm run install-local in a checkout");
	const release = holdInstallLock(env);
	try {
		const from = currentName(app) as string;
		const history = readHistory(app);
		const at = history.lastIndexOf(from);
		const to = history.slice(0, at < 0 ? history.length : at).reverse().find((name) => name !== from && isFolder(join(app, name)));
		if (to === undefined) throw new Error("no earlier version to roll back to");
		switchTo(app, to, false);
		return { from, to };
	} finally {
		release();
	}
}

/** Every installed version, oldest switch first, with current marked and the live lanes that run it. */
export function listVersions(env: NodeJS.ProcessEnv): { name: string; current: boolean; lanes: string[] }[] {
	const app = appDir(env);
	const folders = versionFolders(app);
	if (folders.length === 0) return [];
	const current = currentName(app);
	const history = readHistory(app);
	const lanes = laneVersions(env).versions;
	return folders
		.sort((a, b) => history.lastIndexOf(a) - history.lastIndexOf(b) || a.localeCompare(b))
		.map((name) => ({ name, current: name === current, lanes: lanes.get(name) ?? [] }));
}

/** listVersions as lines: `* ` marks current. */
export function versionLines(versions: ReturnType<typeof listVersions>): string[] {
	if (versions.length === 0) return ["No version is installed yet (npm run install-local in a checkout installs one)."];
	return versions.map((v) => `${v.current ? "*" : " "} ${v.name}${v.current ? "  (current)" : ""}${v.lanes.length === 0 ? "" : `  run by ${v.lanes.join(", ")}`}`);
}
