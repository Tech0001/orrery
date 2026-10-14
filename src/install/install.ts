/**
 * orrery install --from DIR (spec 2026-10-13-orrery-releases-design §5): a release folder is copied to
 * <home>/app/.staging-*, its binary checked, renamed to app/<VERSION>, made read-only, and app/current is switched to
 * it in one rename. Older versions go, except the newest three and any a live lane runs, each renamed to a dot folder
 * before it is deleted. Lanes' data is never touched.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { defaultConfigPath, loadConfig } from "../lane/config.ts";
import { orreryHome } from "../lane/home.ts";
import type { Runner } from "../lane/tools.ts";
import { ENTRY_TAILS, VERSION_NAME } from "./layout.ts";

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

/** Takes app/.install.lock (app must exist); the returned function releases it. */
export function holdInstallLock(env: NodeJS.ProcessEnv): () => void {
	const lock = join(appDir(env), ".install.lock");
	let fd: number | undefined;
	for (let attempt = 0; fd === undefined; attempt++) {
		try {
			fd = openSync(lock, "wx", 0o600);
		} catch (error) {
			if ((error as { code?: unknown }).code !== "EEXIST") throw error;
			// A lock whose recorded process is gone (an install killed partway) is taken over; anything unreadable is refused.
			if (attempt > 0 || !lockIsStale(lock)) throw new Error(`another install is running (remove ${shown(lock, env)} if none is)`);
			rmSync(lock, { force: true });
		}
	}
	try {
		writeSync(fd, `${process.pid}\n`);
	} finally {
		closeSync(fd);
	}
	return () => rmSync(lock, { force: true });
}

/** True only when the lock file names a pid that no process has (ESRCH). */
function lockIsStale(lock: string): boolean {
	let text: string;
	try {
		text = readFileSync(lock, "utf8").trim();
	} catch {
		return false;
	}
	if (!/^[0-9]+$/.test(text)) return false;
	const pid = Number(text);
	if (!Number.isSafeInteger(pid) || pid < 1) return false;
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (error as { code?: unknown }).code === "ESRCH";
	}
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

/** The version folders: every real folder in app/ but the dot ones (staging, and folders being removed). */
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
 * Whether a version folder looks whole, so current may name it: VERSION and bin/orrery (a release), or src/cli/main.ts
 * (a 0.5.0 source copy). A removal cut short by an older Orrery can leave a folder that is neither.
 */
function isWhole(path: string): boolean {
	return (existsSync(join(path, "VERSION")) && existsSync(join(path, ENTRY_TAILS.cli[0]))) || existsSync(join(path, ENTRY_TAILS.cli[1]));
}

/**
 * Points app/current at `version` in one rename. app/history is install order, each version once, latest install last:
 * `record` (an install) drops the version's earlier entries and appends it, through a temp file and a rename. A rollback
 * records nothing, so walking back stays a walk back.
 */
function switchTo(app: string, version: string, record: boolean): void {
	const next = join(app, "current.new");
	rmSync(next, { force: true });
	symlinkSync(version, next);
	renameSync(next, join(app, "current"));
	if (!record) return;
	const history = join(app, "history");
	const temp = `${history}.tmp-${process.pid}`;
	try {
		writeFileSync(temp, `${[...readHistory(app).filter((name) => name !== version), version].join("\n")}\n`, { mode: 0o600 });
		renameSync(temp, history);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

/** The version a rollback from `from` goes to: the latest earlier one in install order that still has a whole folder. */
function rollbackTarget(app: string, from: string): string | undefined {
	const history = readHistory(app);
	const at = history.lastIndexOf(from);
	return history.slice(0, at < 0 ? history.length : at).reverse().find((name) => name !== from && isWhole(join(app, name)));
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
 * What one lane's status.json says about the version it runs. Only pid (an integer), open (a boolean, may be absent) and
 * version (a string) are read. "none": no file, or a lane that needs no version (closed, or its process is gone).
 * Otherwise, a live lane's version, or why the file cannot be trusted ("unknown": nothing may then be deleted).
 */
function laneRun(dir: string): { version: string } | "none" | { unknown: string } {
	let text: string;
	try {
		text = readFileSync(join(dir, "status.json"), "utf8");
	} catch (error) {
		return (error as { code?: unknown }).code === "ENOENT" ? "none" : { unknown: "cannot be read" };
	}
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		return { unknown: "cannot be parsed" };
	}
	if (typeof json !== "object" || json === null) return { unknown: "cannot be parsed" };
	const { pid, open, version } = json as { pid?: unknown; open?: unknown; version?: unknown };
	if (typeof pid !== "number" || !Number.isInteger(pid)) return { unknown: "has no pid" };
	if (open !== undefined && typeof open !== "boolean") return { unknown: "has an open field that is not true or false" };
	if (open === false || !alive(pid)) return "none";
	if (typeof version !== "string") return { unknown: "names a live process but no version" };
	return { version };
}

/**
 * Which lanes run each version, by their status files (open, process alive). `unreadable` says why the answer cannot be
 * trusted (config or a status file); then nothing may be deleted.
 */
export function laneVersions(env: NodeJS.ProcessEnv): { versions: Map<string, string[]>; unreadable?: string } {
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
		if (run === "none") continue;
		if ("unknown" in run) {
			unreadable ??= `lane ${lane.name}'s status.json ${run.unknown}, so Orrery cannot tell which version it runs`;
			continue;
		}
		versions.set(run.version, [...(versions.get(run.version) ?? []), lane.name]);
	}
	return { versions, ...(unreadable === undefined ? {} : { unreadable }) };
}

/** Removes the versions no one needs: beyond the newest three in history, not current, its rollback target, the previous current, or run by a live lane. */
function collect(app: string, env: NodeJS.ProcessEnv, log: (line: string) => void, previous: string | undefined): string[] {
	const { versions: live, unreadable } = laneVersions(env);
	if (unreadable !== undefined) {
		log(`Kept every older version: ${unreadable}.`);
		return [];
	}
	const keep = new Set<string>();
	const history = readHistory(app);
	for (let i = history.length - 1; i >= 0 && keep.size < KEEP; i--) keep.add(history[i]);
	const current = currentName(app);
	if (current !== undefined) {
		keep.add(current);
		const back = rollbackTarget(app, current);
		if (back !== undefined) keep.add(back); // what a rollback goes to next
	}
	if (previous !== undefined) keep.add(previous); // what the user was on before this switch (maybe just rolled back to)
	for (const version of live.keys()) keep.add(version);
	const removed = versionFolders(app).filter((name) => !keep.has(name)).sort();
	for (const name of removed) dropVersion(app, name);
	return removed;
}

/** A release folder's VERSION, checked. */
export function releaseVersion(folder: string): string {
	let text: string;
	try {
		text = readFileSync(join(folder, "VERSION"), "utf8").trim();
	} catch {
		throw new Error(`${folder} is not an Orrery release (no VERSION file)`);
	}
	if (!VERSION_NAME.test(text)) throw new Error(`${folder}'s VERSION is not a version: ${JSON.stringify(text.slice(0, 40))}`);
	return text;
}

/** Folders 555, files 444, executables 555, deepest first; links are left as they are. */
export function makeReadOnly(path: string): void {
	const info = lstatSync(path);
	if (info.isSymbolicLink()) return;
	if (info.isDirectory()) {
		for (const name of readdirSync(path)) makeReadOnly(join(path, name));
		chmodSync(path, 0o555);
		return;
	}
	chmodSync(path, info.mode & 0o111 ? 0o555 : 0o444);
}

/** Removes a version folder, making its folders writable first (a read-only folder's entries cannot be removed). */
export function removeVersion(path: string): void {
	const open = (dir: string) => {
		const info = lstatSync(dir);
		if (!info.isDirectory() || info.isSymbolicLink()) return;
		chmodSync(dir, 0o700);
		for (const name of readdirSync(dir)) open(join(dir, name));
	};
	try {
		open(path);
	} catch {
		// removed below as far as it can be
	}
	rmSync(path, { recursive: true, force: true });
}

/**
 * Removes app/<name>, renamed to app/.removing-<random> first: a removal cut short (Ctrl-C) leaves a dot folder, which
 * the next install removes, never a half-deleted folder under a version's name for a switch to land on.
 */
export function dropVersion(app: string, name: string): void {
	const doomed = join(app, `.removing-${randomUUID()}`);
	renameSync(join(app, name), doomed);
	removeVersion(doomed);
}

/** What an install or a removal cut short left in app/: staging folders and folders being removed. */
export const isLeftover = (name: string) => name.startsWith(".staging-") || name.startsWith(".removing-");

/** The os-arch a binary was built for, from its ELF or Mach-O header; undefined for anything else (a script). */
export function binaryTarget(file: string): string | undefined {
	const head = Buffer.alloc(20);
	let length: number;
	const fd = openSync(file, "r");
	try {
		length = readSync(fd, head, 0, 20, 0);
	} finally {
		closeSync(fd);
	}
	if (length >= 20 && head.readUInt32BE(0) === 0x7f454c46 && head[5] === 1) {
		const machine = head.readUInt16LE(18);
		return machine === 62 ? "linux-x64" : machine === 183 ? "linux-arm64" : "linux-other";
	}
	if (length >= 8 && head.readUInt32LE(0) === 0xfeedfacf) {
		const cpu = head.readUInt32LE(4);
		return cpu === 0x01000007 ? "darwin-x64" : cpu === 0x0100000c ? "darwin-arm64" : "darwin-other";
	}
	return undefined;
}

/** Copies a release folder into app/.staging-*, runs its binary's --version, then renames it to app/<VERSION>. */
function stageRelease(from: string, app: string, version: string, run: Runner): void {
	const staging = join(app, `.staging-${randomUUID()}`);
	try {
		cpSync(from, staging, { recursive: true, verbatimSymlinks: true });
		const built = binaryTarget(join(staging, "bin", "orrery"));
		const here = `${process.platform}-${process.arch}`;
		if (built !== undefined && built !== here) throw new Error(`this release is for ${built}, not this machine (${here}); download the archive for it`);
		const said = run(join(staging, "bin", "orrery"), ["--version"]);
		if (said.status !== 0 && /ENOEXEC|Exec format error|cannot execute binary/i.test(said.stderr)) throw new Error(`this release cannot run on this machine (${process.platform}-${process.arch}); download the archive for it`);
		if (said.status !== 0) throw new Error(`the release's orrery --version failed: ${failure(said)}`);
		if (said.stdout.trim() !== `orrery ${version}`) throw new Error(`the release's binary says ${said.stdout.trim() || "nothing"}, not orrery ${version}`);
		makeReadOnly(staging); // before the rename, so a folder under app/<VERSION> is never writable
		const target = join(app, version);
		// A damaged folder is moved aside, the new copy moved in, and only then is the old one deleted: the name is
		// never empty for longer than two renames, and a failed second rename puts the old folder back.
		const damaged = isFolder(target) ? join(app, `.removing-${randomUUID()}`) : undefined;
		if (damaged !== undefined) renameSync(target, damaged);
		try {
			renameSync(staging, target);
		} catch (error) {
			if (damaged !== undefined) renameSync(damaged, target);
			throw error;
		}
		if (damaged !== undefined) removeVersion(damaged);
	} catch (error) {
		removeVersion(staging);
		throw error;
	}
}

/** Installs a release folder and switches app/current to it. `previous` is what current named before the switch. */
export function installFrom(options: { from: string; env: NodeJS.ProcessEnv; log?: (line: string) => void; run?: Runner }): { version: string; previous?: string; removed: string[] } {
	const { env } = options;
	const run = options.run ?? envRunner(env, 60_000);
	const log = options.log ?? (() => {});
	const version = releaseVersion(options.from);
	const home = orreryHome(env);
	const app = join(home, "app");
	mkdirSync(home, { recursive: true, mode: 0o700 });
	chmodSync(home, 0o700); // an existing home may have been made looser
	mkdirSync(app, { recursive: true, mode: 0o700 });
	const release = holdInstallLock(env);
	try {
		// Under the lock, a staging or .removing- folder is what an interrupted install or cleanup left.
		for (const name of readdirSync(app)) if (isLeftover(name)) removeVersion(join(app, name));
		const previous = currentName(app);
		if (isWhole(join(app, version))) {
			if (previous === version) {
				log(`${version} is already installed.`);
				return { version, removed: [] };
			}
		} else {
			log(`Installing ${version}...`);
			stageRelease(options.from, app, version, run);
		}
		switchTo(app, version, true);
		return { version, ...(previous === undefined ? {} : { previous }), removed: collect(app, env, log, previous) };
	} finally {
		release();
	}
}

/** Switches app/current back to the latest version before it in install order (app/history) that still has a folder. */
export function rollback(env: NodeJS.ProcessEnv): { from: string; to: string } {
	const app = appDir(env);
	if (currentName(app) === undefined) throw new Error("Orrery is not installed yet: see the install line in the README");
	const release = holdInstallLock(env);
	try {
		const from = currentName(app) as string;
		const to = rollbackTarget(app, from);
		if (to === undefined) throw new Error("no earlier version to roll back to");
		switchTo(app, to, false);
		return { from, to };
	} finally {
		release();
	}
}

/** Every installed version, oldest install first (app/history order), with current marked and the live lanes that run it. */
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
	if (versions.length === 0) return ["No version is installed yet."];
	return versions.map((v) => `${v.current ? "*" : " "} ${v.name}${v.current ? "  (current)" : ""}${v.lanes.length === 0 ? "" : `  run by ${v.lanes.join(", ")}`}`);
}
