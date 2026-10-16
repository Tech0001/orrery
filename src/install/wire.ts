/**
 * orrery setup, and the end of every install and rollback (spec 2026-10-13-orrery-releases-design §5, §6): the orrery
 * command, the backup service, pi, OMP and Claude Code are pointed at <home>/app/current, never at a version folder, in
 * the shape the version there has (layout.ts). What is already right is left alone; Orrery's own wiring of either shape
 * is moved without asking; a tool with no Orrery wiring yet is connected only after asking, and anything that is not
 * Orrery's own is replaced only after asking, with a copy of it kept beside it. Last, the config in use gets the [guard]
 * example once (guard-preset.ts).
 */

import { chmodSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { orreryHome } from "../agent/home.ts";
import { checkTools, findOnPath, setAside, type InstallStep, installSteps, ompExtensionFile, piExtensionFile, runInstall, type Runner, type ToolCheck } from "../agent/tools.ts";
import { type Confirm, pathAdvice } from "./ask.ts";
import { offerGuardPreset } from "./guard-preset.ts";
import { envRunner } from "./install.ts";
import { ENTRY_TAILS, endsWithSegments, entries, isOrreryCommand, oneLineTarget } from "./layout.ts";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const firstLine = (text: string) => text.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";

/** Puts a link to `target` at `link` in one rename, so the old one is never missing. */
function replaceLink(link: string, target: string): void {
	mkdirSync(dirname(link), { recursive: true });
	const next = `${link}.new`;
	rmSync(next, { force: true });
	symlinkSync(target, next);
	renameSync(next, link);
}

/**
 * ~/.local/bin/orrery → app/current's CLI. A link to Orrery's command (under this home's app/, or a provable Orrery
 * checkout or release elsewhere: layout.ts isOrreryCommand) is replaced; anything else, dangling links included, only
 * when confirmed, after it is set aside.
 */
async function linkCommand(env: NodeJS.ProcessEnv, current: string, confirm: Confirm, left: string[]): Promise<string> {
	const target = entries(current).cli;
	const link = join(env.HOME || homedir(), ".local", "bin", "orrery");
	let now: string | null | undefined;
	try {
		now = lstatSync(link).isSymbolicLink() ? readlinkSync(link) : null;
	} catch (error) {
		if ((error as { code?: unknown }).code !== "ENOENT") {
			left.push(`the orrery command (${link} could not be read)`);
			return `orrery command: cannot read ${link}: ${errorText(error)}`;
		}
	}
	if (now === target) return `orrery command: ${link} already links to ${target}`;
	const older = typeof now === "string" && isOrreryCommand(resolve(dirname(link), now), dirname(current));
	const foreign = now !== undefined && !older;
	if (foreign && !(await confirm(`replace ${link}?`))) {
		left.push(`the orrery command (${link} is not Orrery's link and was not replaced)`);
		return `orrery command: left ${link} as it is`;
	}
	let aside: string | undefined;
	try {
		if (foreign) aside = setAside(link);
		replaceLink(link, target);
	} catch (error) {
		left.push(`the orrery command (${link} could not be linked)`);
		return `orrery command: could not link ${link}: ${errorText(error)}${aside === undefined ? "" : ` (the one there before is now ${aside})`}`;
	}
	if (aside !== undefined) return `orrery command: ${link} links to ${target} (the one there before is now ${aside})`;
	return `orrery command: ${link} links to ${target}${typeof now === "string" ? ` (was ${now})` : ""}`;
}

/** The backup unit's ExecStart: %h/.orrery/... for the default home, else the home's absolute path. */
function backupScript(env: NodeJS.ProcessEnv, home: string): string {
	if (home === join(env.HOME || homedir(), ".orrery")) return "%h/.orrery/app/current/deploy/workstation/backup.sh";
	const path = join(home, "app", "current", "deploy", "workstation", "backup.sh");
	return /\s/.test(path) ? JSON.stringify(path) : path;
}

/** Rewrites the backup service's backup.sh line to app/current (same mode, one rename), then reloads systemd. */
function pointBackup(env: NodeJS.ProcessEnv, home: string, run: Runner, left: string[], platform: NodeJS.Platform): string[] {
	const unit = join(env.HOME || homedir(), ".config", "systemd", "user", "orrery-backup.service");
	let text: string;
	try {
		text = readFileSync(unit, "utf8");
	} catch (error) {
		if ((error as { code?: unknown }).code === "ENOENT") {
			// The backup service is a systemd unit; a launchd one for macOS is not built yet.
			return [platform === "darwin" ? "no scheduled backup on macOS yet; run `orrery backup` when you want one" : "no backup service; see docs/deploy.md"];
		}
		left.push(`the backup service (${unit} could not be read)`);
		return [`backup service: cannot read ${unit}: ${errorText(error)}`];
	}
	const line = `ExecStart=${backupScript(env, home)}`;
	const exec = /^ExecStart=.*backup\.sh"?[ \t]*$/m;
	if (!exec.test(text)) return [`backup service: ${unit} runs no backup.sh; left as it is`];
	const next = text.replace(exec, line);
	if (next === text) return [`backup service: already runs app/current`];
	try {
		const mode = statSync(unit).mode & 0o7777;
		const temp = `${unit}.tmp-${process.pid}`;
		try {
			writeFileSync(temp, next, { mode });
			chmodSync(temp, mode);
			renameSync(temp, unit);
		} catch (error) {
			rmSync(temp, { force: true });
			throw error;
		}
	} catch (error) {
		left.push(`the backup service (${unit} could not be rewritten)`);
		return [`backup service: could not rewrite ${unit}: ${errorText(error)}`];
	}
	const lines = [`backup service: ${line}`];
	const systemctl = findOnPath("systemctl", env);
	if (systemctl === undefined) {
		left.push("the backup service (systemd was not reloaded)");
		return [...lines, "backup service: no systemctl on PATH; run systemctl --user daemon-reload"];
	}
	const reload = run(systemctl, ["--user", "daemon-reload"]);
	if (reload.status !== 0) {
		left.push("the backup service (systemctl --user daemon-reload failed)");
		return [...lines, `backup service: systemctl --user daemon-reload failed (${firstLine(reload.stderr) || `exit ${reload.status}`}); run it again`];
	}
	return lines;
}

/** What connecting a tool does, for its question: the file it writes, or the commands it runs. */
const connectText = (steps: readonly InstallStep[]) => steps.map((step) => (step.kind === "write" ? `writes ${step.path}` : step.describe)).join(", ");

/**
 * pi, Claude Code and OMP through checkTools and installSteps against app/current: "update available" (Orrery's own
 * wiring of the other shape or an older plugin) runs without asking; "missing" (no Orrery wiring yet) and "other"
 * (another Orrery, or not Orrery's file) only after confirm, and a file that is not Orrery's is set aside first. A
 * missing pi or OMP extension is written only when that tool is on PATH.
 */
async function wireTools(env: NodeJS.ProcessEnv, current: string, run: { probe: Runner; install: Runner }, confirm: Confirm, left: string[], unchecked: string[], emit: (line: string) => void): Promise<void> {
	const look = () => checkTools({ root: current, env, run: run.probe });
	let checks = look();
	for (const id of ["pi", "claude-code", "omp"] as const) {
		const check = checks.find((c) => c.id === id) as ToolCheck;
		const steps = installSteps(check, current, env);
		if (steps.length === 0) {
			// "unknown" is a tool Orrery could not check; "other" with nothing to run is blocked (shared folder), only info.
			if (check.wiring === "unknown") unchecked.push(`${check.label}: ${check.detail}`);
			emit(`${check.label}: ${check.wiring === "installed" ? `already wired (${check.detail})` : check.detail}`);
			continue;
		}
		if (check.wiring === "missing" && check.path === undefined) {
			emit(`${check.label}: not found on PATH; not wired`);
			continue;
		}
		if (check.wiring === "missing" && !(await confirm(`Connect Orrery to ${check.label}? (${connectText(steps)})`))) {
			left.push(`${check.label} (not connected)`);
			emit(`${check.label}: not connected`);
			continue;
		}
		if (check.wiring === "other" && !(await confirm(`${check.label}: ${steps.map((step) => step.describe).join(", then ")}?`))) {
			left.push(`${check.label} (still wired to ${check.detail})`);
			emit(`${check.label}: left as it is (${check.detail})`);
			continue;
		}
		const result = runInstall(steps, run.install);
		for (const line of result.output.split("\n").filter((line) => line.trim() !== "")) emit(`${check.label}: ${line}`);
		if (!result.ok) {
			left.push(`${check.label} (${result.problem ?? "the install failed"})`);
			emit(`${check.label}: not wired; orrery tools install ${id} tries again`);
		}
		// pi and OMP may share one extensions folder: OMP is judged after pi's file is written.
		checks = look();
	}
}

/** What wiring did: one line per thing wired, skipped or failed, and what was left (skipped, declined or failed). */
export interface WireReport {
	lines: string[];
	left: string[];
	/** Tools Orrery could not check at all ("<tool>: <reason>"); the user checks them by hand. */
	unchecked: string[];
}

/**
 * Points everything at <home>/app/current. `onLine` gets each line as it happens, so what was already done is shown even
 * when a later question is answered with Ctrl-C (which stops the process). `platform` is for tests.
 */
export async function wireReport(env: NodeJS.ProcessEnv, options: { run?: Runner; confirm: Confirm; onLine?: (line: string) => void; platform?: NodeJS.Platform }): Promise<WireReport> {
	// A tool's --version or plugin list gets 15 s; installing the Claude Code plugin may take longer.
	const run = options.run ?? envRunner(env, 300_000);
	const probe = options.run ?? envRunner(env, 15_000);
	const home = orreryHome(env);
	const current = join(home, "app", "current");
	const left: string[] = [];
	const unchecked: string[] = [];
	const advice = pathAdvice(env, join(env.HOME || homedir(), ".local", "bin"));
	const lines: string[] = [];
	const emit = (line: string) => {
		lines.push(line);
		options.onLine?.(line);
	};
	emit(await linkCommand(env, current, options.confirm, left));
	if (advice !== undefined) emit(advice);
	for (const line of pointBackup(env, home, run, left, options.platform ?? process.platform)) emit(line);
	await wireTools(env, current, { probe, install: run }, options.confirm, left, unchecked, emit);
	// The [guard] example, once per config: nothing is left when it is not added.
	const preset = offerGuardPreset(env);
	if (preset !== undefined) emit(preset);
	return { lines, left, unchecked };
}

/** wireReport's lines. */
export async function wire(env: NodeJS.ProcessEnv, options: { run?: Runner; confirm: Confirm; platform?: NodeJS.Platform }): Promise<string[]> {
	return (await wireReport(env, options)).lines;
}

/** The closing warning: what was left (with the fix), and what could not be checked (to check by hand). */
export function leftWarning(left: string[], unchecked: string[] = []): string[] {
	return [
		...(left.length === 0
			? []
			: [
					"Not everything points at this install:",
					...left.map((item) => `  - ${item}`),
					"Fix it with: orrery setup --yes (or run orrery, then Tools, then I).",
				]),
		...(unchecked.length === 0 ? [] : ["Could not check these tools:", ...unchecked.map((item) => `  - check ${item.replace(": ", " by hand: ")}`)]),
	];
}
