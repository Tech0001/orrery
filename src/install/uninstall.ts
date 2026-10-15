/**
 * orrery uninstall [--purge] (spec 2026-10-13-orrery-releases-design §5): unwires pi, OMP and Claude Code, and removes
 * the command link, the Linux backup service and app/. Only what is provably Orrery's own is touched: an extension file
 * that is exactly Orrery's one line naming an entry under this home's app/, a command link, plugin or backup unit that
 * names this home's app/, and in app/ only what installs put there. Agents' memory, config and logins stay. --purge
 * asks first and then also deletes the whole home, only when the person types delete and the folder is a real Orrery
 * home that does not hold their home folder.
 */

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmdirSync, rmSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { realTarget } from "../agent/guard-paths.ts";
import { orreryHome } from "../agent/home.ts";
import { findOnPath, ompExtensionFile, orreryPlugin, piExtensionFile, type RunResult, type Runner } from "../agent/tools.ts";
import { dropVersion, envRunner, holdInstallLock, isLeftover, agentVersions, removeVersion } from "./install.ts";
import { ENTRY_TAILS, inApp, oneLineTarget, VERSION_NAME } from "./layout.ts";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const code = (error: unknown) => (error as { code?: unknown }).code;
const firstLine = (text: string) => text.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";
const failure = (r: RunResult) => firstLine(r.stderr) || (r.status === null ? "did not finish" : `exit ${r.status}`);

/** What each step says, and whether everything it found of Orrery's is gone. */
interface Report {
	readonly lines: string[];
	ok: boolean;
}

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
	const spec = oneLineTarget(text);
	if (spec === undefined) {
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
	const done = [...(timerIsOurs ? ["disabled orrery-backup.timer"] : []), ...(removed.length === 0 ? [] : [`removed ${removed.join(" and ")}`])];
	if (done.length > 0) report.lines.push(`backup service: ${done.join(", ")}`);
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

/**
 * Removes from app/ what installs put there (versions, staging and .removing- folders, current, history), then app/
 * itself if that empties it. The caller holds the install lock; `release` lets it go before app/ is removed.
 */
function removeApp(report: Report, app: string, release: () => void): void {
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
	const versions: string[] = [];
	const foreign: string[] = [];
	try {
		for (const entry of readdirSync(app, { withFileTypes: true })) {
			const path = join(app, entry.name);
			if (entry.name === ".install.lock") continue; // released below
			if (entry.isSymbolicLink() && (entry.name === "current" || entry.name === "current.new")) rmSync(path);
			else if (entry.isFile() && (entry.name === "history" || entry.name.startsWith("history.tmp-"))) rmSync(path);
			else if (entry.isDirectory() && isLeftover(entry.name)) removeVersion(path);
			else if (entry.isDirectory() && isVersionFolder(path, entry.name)) {
				dropVersion(app, entry.name);
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

/** The user's home folder by every account Orrery can see: $HOME as given, the process's, and the system's record. */
function userHomes(env: NodeJS.ProcessEnv): string[] {
	const homes = [env.HOME, homedir()];
	try {
		homes.push(userInfo().homedir);
	} catch {
		// no passwd entry
	}
	return homes.filter((home): home is string => typeof home === "string" && home !== "");
}

/** What Orrery keeps in a home: purge needs one of them as evidence that the folder is an Orrery home. */
const HOME_MARKS = ["config.toml", "agents", "credentials.json", "app"];
/** What a home from before 0.6.0 keeps instead: evidence too, though no message names it. */
const OLD_HOME_MARKS = ["lanes"];

/** Why `home` may not be purged, or undefined: it must be a real folder, not hold the user's home, and look like Orrery's. */
function purgeRefusal(home: string, env: NodeJS.ProcessEnv): string | undefined {
	try {
		if (lstatSync(home).isSymbolicLink()) return `${home} is a link to ${readlinkSync(home)}; --purge deletes only the folder itself (set ORRERY_HOME to it).`;
	} catch {
		return `${home} is not there, so there is nothing to purge.`;
	}
	for (const h of new Set([resolve(home), realTarget(home)])) {
		const holds = h === "/" || userHomes(env).some((user) => [resolve(user), realTarget(user)].some((u) => u === h || u.startsWith(`${h}/`)));
		if (holds) return `--purge deletes only a folder of Orrery's own, and ${home} is your home folder or holds it.`;
	}
	if (![...HOME_MARKS, ...OLD_HOME_MARKS].some((mark) => existsSync(join(home, mark)))) return `--purge deletes only an Orrery home, and ${home} holds none of ${HOME_MARKS.join(", ")}.`;
	return undefined;
}

/**
 * Unwires and removes this install; with `purge`, also deletes the home. Everything that can stop it (open agents, a home
 * that is not Orrery's, the purge question, an install holding the lock) comes before the first change, so a refusal or
 * a no changes nothing. The install lock is held from before the first change until app/ is emptied, so an install
 * cannot run in between. `confirmPurge` answers "no terminal" when there was none to ask.
 */
export async function uninstall(options: { env: NodeJS.ProcessEnv; purge: boolean; confirmPurge: () => Promise<boolean | "no terminal">; run?: Runner }): Promise<{ lines: string[]; ok: boolean }> {
	const { env } = options;
	const run = options.run ?? envRunner(env, 120_000);
	const home = orreryHome(env);
	const app = join(home, "app");
	const userHome = env.HOME || homedir();
	const refused = (why: string) => ({ lines: [`Not uninstalled: ${why}`], ok: false });
	if (options.purge) {
		const why = purgeRefusal(home, env);
		if (why !== undefined) return refused(why);
	}
	const { versions, unreadable } = agentVersions(env);
	const open = [...versions.values()].flat();
	if (open.length > 0) return { lines: [`Close these agents first: ${open.join(", ")}`], ok: false };
	if (unreadable !== undefined) return { lines: [`Cannot tell whether agents are open: ${unreadable}. Close every agent and fix that, then run orrery uninstall again.`], ok: false };
	if (options.purge) {
		const answer = await options.confirmPurge();
		if (answer === "no terminal") return refused("there is no terminal to ask before deleting everything; nothing changed.");
		if (answer !== true) return refused("you did not type delete; nothing changed.");
	}

	// The lock lives in app/; with no app/ folder there is nothing an install could be switching.
	let held: (() => void) | undefined;
	try {
		if (lstatSync(app).isDirectory()) held = holdInstallLock(env);
	} catch (error) {
		if (code(error) !== "ENOENT") return refused(`${errorText(error)}; nothing changed.`);
	}
	const release = () => {
		held?.();
		held = undefined; // once: the lock may be another install's by the time a second call came
	};

	const report: Report = { lines: [], ok: true };
	try {
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
		removeApp(report, app, release);
	} finally {
		release();
	}
	if (!options.purge) {
		report.lines.push(`Kept ${home}: your config, logins and agents' memory (orrery uninstall --purge deletes them).`);
		return report;
	}
	try {
		removeVersion(home); // makes read-only folders writable, then removes everything
	} catch (error) {
		report.lines.push(`Could not delete all of ${home}: ${errorText(error)}`);
		return { lines: report.lines, ok: false };
	}
	if (existsSync(home)) {
		report.lines.push(`Could not delete all of ${home}.`);
		return { lines: report.lines, ok: false };
	}
	report.lines.push(`Deleted ${home}.`);
	return report;
}
