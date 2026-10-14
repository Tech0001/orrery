/**
 * orrery uninstall [--purge] (spec 2026-10-13-orrery-releases-design §5): unwires pi, OMP and Claude Code, and removes
 * the command link, the Linux backup service and app/. Only what is provably Orrery's own is touched: an extension file
 * that is exactly Orrery's one line naming an entry under this home's app/, a command link, plugin or backup unit that
 * names this home's app/, and in app/ only what installs put there. Lanes' memory, config and logins stay; --purge
 * deletes the whole home after the person types delete.
 */

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { realTarget } from "../lane/guard-paths.ts";
import { orreryHome } from "../lane/home.ts";
import { findOnPath, ompExtensionFile, orreryPlugin, piExtensionFile, type RunResult, type Runner } from "../lane/tools.ts";
import { envRunner, holdInstallLock, laneVersions, removeVersion, VERSION_NAME } from "./install.ts";
import { ENTRY_TAILS } from "./layout.ts";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const code = (error: unknown) => (error as { code?: unknown }).code;
const firstLine = (text: string) => text.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";
const failure = (r: RunResult) => firstLine(r.stderr) || (r.status === null ? "did not finish" : `exit ${r.status}`);

/** What each step says, and whether everything it found of Orrery's is gone. */
interface Report {
	readonly lines: string[];
	ok: boolean;
}

/** Whether `path` is `<app>/<one folder>/<tail>` for one of `tails`: an entry in this home's current or a version. */
function inApp(app: string, path: string, tails: readonly string[]): boolean {
	for (const root of new Set([resolve(app), realTarget(app)])) {
		const rel = relative(root, resolve(path));
		if (rel === "" || isAbsolute(rel)) continue;
		const [folder, ...rest] = rel.split(sep);
		if (folder === ".." || rest.includes("..")) continue;
		if (tails.includes(rest.join(sep))) return true;
	}
	return false;
}

/** Orrery's extension file is exactly this one line (tools.ts piExtensionText, ompExtensionText). */
const ONE_LINE = /^export \{ default \} from ("(?:[^"\\]|\\.)*");\n$/;

/** Removes pi's or OMP's extension file when it is Orrery's one line naming an entry under this home's app/. */
function unwireExtension(report: Report, label: string, file: string, app: string): void {
	let text: string;
	try {
		if (!lstatSync(file).isFile()) {
			report.lines.push(`${label}: left ${file} as it is (not a plain file, so not Orrery's)`);
			return;
		}
		text = readFileSync(file, "utf8");
	} catch (error) {
		if (code(error) === "ENOENT") {
			report.lines.push(`${label}: no Orrery extension (${file} is not there)`);
			return;
		}
		report.lines.push(`${label}: could not read ${file}: ${errorText(error)}`);
		report.ok = false;
		return;
	}
	const quoted = ONE_LINE.exec(text)?.[1];
	let spec: unknown;
	try {
		spec = quoted === undefined ? undefined : JSON.parse(quoted);
	} catch {
		spec = undefined;
	}
	if (typeof spec !== "string" || JSON.stringify(spec) !== quoted) {
		report.lines.push(`${label}: left ${file} as it is (not Orrery's one-line extension)`);
		return;
	}
	// OMP's re-export is relative to the file's real folder (ompExtensionText); pi's is absolute.
	const target = resolve(realTarget(dirname(file)), spec);
	if (!inApp(app, target, [...ENTRY_TAILS.pi, ...ENTRY_TAILS.omp])) {
		report.lines.push(`${label}: left ${file} as it is (it re-exports ${target}, not this install)`);
		return;
	}
	try {
		rmSync(file);
	} catch (error) {
		report.lines.push(`${label}: could not remove ${file}: ${errorText(error)}`);
		report.ok = false;
		return;
	}
	report.lines.push(`${label}: removed ${file}`);
}

/** Uninstalls the Claude Code plugin, then its marketplace, when the plugin reads from this home's app/. */
function unwireClaude(report: Report, env: NodeJS.ProcessEnv, app: string, run: Runner): void {
	const claude = findOnPath("claude", env);
	if (claude === undefined) {
		report.lines.push("Claude Code: not on PATH, so not checked (if it has the Orrery plugin: claude plugin uninstall orrery@orrery)");
		return;
	}
	const listed = orreryPlugin(claude, run);
	if (listed === "missing") {
		report.lines.push("Claude Code: the Orrery plugin is not installed");
		return;
	}
	if ("unreadable" in listed) {
		report.lines.push(`Claude Code: ${listed.unreadable}; check it by hand (claude plugin list)`);
		report.ok = false;
		return;
	}
	const from = listed.plugin.readFromFolder;
	if (typeof from !== "string") {
		report.lines.push("Claude Code: claude plugin list does not say where the Orrery plugin reads from; left as it is (claude plugin uninstall orrery@orrery removes it)");
		return;
	}
	if (!inApp(app, from, ["claude-plugin"])) {
		report.lines.push(`Claude Code: the Orrery plugin reads from ${from}, not this install; left as it is`);
		return;
	}
	for (const args of [["plugin", "uninstall", "orrery@orrery"], ["plugin", "marketplace", "remove", "orrery"]]) {
		const r = run(claude, args);
		if (r.status !== 0) {
			report.lines.push(`Claude Code: claude ${args.join(" ")} failed (${failure(r)})`);
			report.ok = false;
			return;
		}
		report.lines.push(`Claude Code: claude ${args.join(" ")}`);
	}
}

/** The script a unit's ExecStart value runs: %h is the user's home; a quoted value is read as setup writes it. */
function execScript(value: string, userHome: string): string | undefined {
	let path = value;
	if (value.startsWith('"')) {
		try {
			path = JSON.parse(value) as string;
		} catch {
			return undefined;
		}
	}
	if (typeof path !== "string") return undefined;
	if (path.startsWith("%h/")) path = join(userHome, path.slice(3));
	return isAbsolute(path) ? path : undefined;
}

/** Disables and removes the backup timer and service when the service runs this home's backup.sh, then reloads systemd. */
function unwireBackup(report: Report, env: NodeJS.ProcessEnv, userHome: string, app: string, run: Runner): void {
	const dir = join(userHome, ".config", "systemd", "user");
	const service = join(dir, "orrery-backup.service");
	const timer = join(dir, "orrery-backup.timer");
	let text: string;
	try {
		text = readFileSync(service, "utf8");
	} catch (error) {
		if (code(error) === "ENOENT") {
			report.lines.push("backup service: none");
			return;
		}
		report.lines.push(`backup service: could not read ${service}: ${errorText(error)}`);
		report.ok = false;
		return;
	}
	const exec = /^ExecStart=(.*)$/m.exec(text)?.[1]?.trim();
	const script = exec === undefined ? undefined : execScript(exec, userHome);
	if (script === undefined || !inApp(app, script, [join("deploy", "workstation", "backup.sh")])) {
		report.lines.push(`backup service: ${service} runs ${exec ?? "nothing"}, not this install's backup; left as it is`);
		return;
	}
	const systemctl = findOnPath("systemctl", env);
	if (systemctl === undefined) {
		report.lines.push(`backup service: no systemctl on PATH; left ${service} (run systemctl --user disable --now orrery-backup.timer, then remove it and its timer)`);
		report.ok = false;
		return;
	}
	let timerText: string | undefined;
	try {
		timerText = readFileSync(timer, "utf8");
	} catch {
		timerText = undefined;
	}
	// A timer names its service with Unit=, or by sharing its name.
	const unit = timerText === undefined ? undefined : /^Unit=(.*)$/m.exec(timerText)?.[1]?.trim();
	const timerIsOurs = timerText !== undefined && (unit === undefined || unit === "orrery-backup.service");
	if (timerIsOurs) {
		const off = run(systemctl, ["--user", "disable", "--now", "orrery-backup.timer"]);
		if (off.status !== 0) {
			report.lines.push(`backup service: systemctl --user disable --now orrery-backup.timer failed (${failure(off)}); left ${service} and ${timer}`);
			report.ok = false;
			return;
		}
	} else if (timerText !== undefined) {
		report.lines.push(`backup service: left ${timer} as it is (it starts ${unit}, not orrery-backup.service)`);
	}
	const removed: string[] = [];
	for (const file of timerIsOurs ? [timer, service] : [service]) {
		try {
			rmSync(file);
			removed.push(file);
		} catch (error) {
			report.lines.push(`backup service: could not remove ${file}: ${errorText(error)}`);
			report.ok = false;
		}
	}
	report.lines.push(`backup service: ${timerIsOurs ? "disabled orrery-backup.timer, " : ""}removed ${removed.join(" and ")}`);
	const reload = run(systemctl, ["--user", "daemon-reload"]);
	if (reload.status !== 0) {
		report.lines.push(`backup service: systemctl --user daemon-reload failed (${failure(reload)}); run it again`);
		report.ok = false;
	}
}

/** Removes ~/.local/bin/orrery when it links to Orrery's command under this home's app/. */
function unlinkCommand(report: Report, userHome: string, app: string): void {
	const link = join(userHome, ".local", "bin", "orrery");
	let now: string;
	try {
		if (!lstatSync(link).isSymbolicLink()) {
			report.lines.push(`orrery command: left ${link} as it is (not Orrery's link)`);
			return;
		}
		now = readlinkSync(link);
	} catch (error) {
		if (code(error) === "ENOENT") {
			report.lines.push(`orrery command: no ${link}`);
			return;
		}
		report.lines.push(`orrery command: could not read ${link}: ${errorText(error)}`);
		report.ok = false;
		return;
	}
	if (!inApp(app, resolve(dirname(link), now), ENTRY_TAILS.cli)) {
		report.lines.push(`orrery command: left ${link} as it is (it links to ${now}, not this install)`);
		return;
	}
	try {
		rmSync(link);
	} catch (error) {
		report.lines.push(`orrery command: could not remove ${link}: ${errorText(error)}`);
		report.ok = false;
		return;
	}
	report.lines.push(`orrery command: removed ${link}`);
}

/** A version folder an install made: named like a version, holding VERSION (a release) or Orrery's command. */
function isVersionFolder(path: string, name: string): boolean {
	return VERSION_NAME.test(name) && [join(path, "VERSION"), ...ENTRY_TAILS.cli.map((tail) => join(path, tail))].some((file) => existsSync(file));
}

/** Removes from app/ what installs put there (versions, staging, current, history), then app/ itself if that empties it. */
function removeApp(report: Report, env: NodeJS.ProcessEnv, app: string): void {
	try {
		if (!lstatSync(app).isDirectory()) {
			report.lines.push(`left ${app} as it is (not a folder, so not Orrery's)`);
			report.ok = false;
			return;
		}
	} catch (error) {
		if (code(error) === "ENOENT") {
			report.lines.push(`no ${app}: nothing installed there`);
			return;
		}
		report.lines.push(`could not read ${app}: ${errorText(error)}`);
		report.ok = false;
		return;
	}
	let release: () => void;
	try {
		release = holdInstallLock(env);
	} catch (error) {
		report.lines.push(`left ${app}: ${errorText(error)}`);
		report.ok = false;
		return;
	}
	const versions: string[] = [];
	const foreign: string[] = [];
	try {
		for (const entry of readdirSync(app, { withFileTypes: true })) {
			const path = join(app, entry.name);
			if (entry.name === ".install.lock") continue; // released below
			if (entry.isSymbolicLink() && (entry.name === "current" || entry.name === "current.new")) rmSync(path);
			else if (entry.isFile() && (entry.name === "history" || entry.name.startsWith("history.tmp-"))) rmSync(path);
			else if (entry.isDirectory() && entry.name.startsWith(".staging-")) removeVersion(path);
			else if (entry.isDirectory() && isVersionFolder(path, entry.name)) {
				removeVersion(path);
				versions.push(entry.name);
			} else foreign.push(entry.name);
		}
	} catch (error) {
		report.lines.push(`could not empty ${app}: ${errorText(error)}`);
		report.ok = false;
		return;
	} finally {
		release();
	}
	if (foreign.length > 0) {
		report.lines.push(`removed ${versions.length === 0 ? "no versions" : versions.sort().join(", ")}; left ${app}: it holds files Orrery did not put there (${foreign.sort().join(", ")})`);
		report.ok = false;
		return;
	}
	try {
		rmdirSync(app);
	} catch (error) {
		report.lines.push(`could not remove ${app}: ${errorText(error)}`);
		report.ok = false;
		return;
	}
	report.lines.push(`removed ${app}${versions.length === 0 ? "" : ` (${versions.sort().join(", ")})`}`);
}

/** Whether `home` is the user's home folder, holds it, or is the file system's root: never purged. */
function holdsUserHome(home: string, userHome: string): boolean {
	for (const h of new Set([resolve(home), realTarget(home)])) {
		if (h === "/") return true;
		for (const u of new Set([resolve(userHome), realTarget(userHome)])) if (u === h || u.startsWith(`${h}/`)) return true;
	}
	return false;
}

export async function uninstall(options: { env: NodeJS.ProcessEnv; purge: boolean; confirmPurge: () => Promise<boolean>; run?: Runner }): Promise<{ lines: string[]; ok: boolean }> {
	const { env } = options;
	const run = options.run ?? envRunner(env, 120_000);
	const home = orreryHome(env);
	const app = join(home, "app");
	const userHome = env.HOME || homedir();
	if (options.purge && holdsUserHome(home, userHome)) {
		return { lines: [`Not uninstalled: --purge deletes only a folder of Orrery's own, and ${home} is your home folder or holds it.`], ok: false };
	}
	const { versions, unreadable } = laneVersions(env);
	const open = [...versions.values()].flat();
	if (open.length > 0) return { lines: [`Close these lanes first: ${open.join(", ")}`], ok: false };
	if (unreadable !== undefined) return { lines: [`Cannot tell whether lanes are open: ${unreadable}. Close every lane and fix that, then run orrery uninstall again.`], ok: false };

	const report: Report = { lines: [], ok: true };
	const pi = piExtensionFile(env);
	const omp = ompExtensionFile(env);
	if (resolve(pi) === resolve(omp)) unwireExtension(report, "pi and OMP", pi, app);
	else {
		unwireExtension(report, "pi", pi, app);
		unwireExtension(report, "OMP", omp, app);
	}
	unwireClaude(report, env, app, run);
	unwireBackup(report, env, userHome, app, run);
	unlinkCommand(report, userHome, app);
	removeApp(report, env, app);
	if (!options.purge) {
		report.lines.push(`Kept ${home}: your config, logins and lanes' memory (orrery uninstall --purge deletes them).`);
		return report;
	}
	if (!(await options.confirmPurge())) {
		report.lines.push(`Kept ${home} (you did not type delete).`);
		return { lines: report.lines, ok: false };
	}
	removeVersion(home); // makes read-only folders writable, then removes everything
	if (existsSync(home)) {
		report.lines.push(`Could not delete all of ${home}.`);
		return { lines: report.lines, ok: false };
	}
	report.lines.push(`Deleted ${home}.`);
	return report;
}
