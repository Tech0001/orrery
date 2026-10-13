/**
 * After an install (spec 2026-10-13-orrery-home-and-install §5, step 5): the orrery command, the backup service, pi, OMP
 * and Claude Code are pointed at <home>/app/current, never at a version folder. What is already right is left alone;
 * anything that is not Orrery's own is replaced only after asking.
 */

import { chmodSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { orreryHome } from "../lane/home.ts";
import { checkTools, findOnPath, installSteps, runInstall, type Runner, type ToolCheck } from "../lane/tools.ts";
import { envRunner } from "./install.ts";

type Confirm = (what: string) => Promise<boolean>;

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

/** ~/.local/bin/orrery → app/current's CLI. An older Orrery's link is replaced; anything else only when confirmed. */
async function linkCommand(env: NodeJS.ProcessEnv, current: string, confirm: Confirm, left: string[]): Promise<string> {
	const target = join(current, "src", "cli", "main.ts");
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
	const older = typeof now === "string" && now.endsWith(join("src", "cli", "main.ts"));
	if (now !== undefined && !older && !(await confirm(`replace ${link}?`))) {
		left.push(`the orrery command (${link} is not Orrery's link and was not replaced)`);
		return `orrery command: left ${link} as it is`;
	}
	try {
		replaceLink(link, target);
	} catch (error) {
		left.push(`the orrery command (${link} could not be linked)`);
		return `orrery command: could not link ${link}: ${errorText(error)}`;
	}
	return `orrery command: ${link} links to ${target}${typeof now === "string" ? ` (was ${now})` : ""}`;
}

/** The backup unit's ExecStart: %h/.orrery/... for the default home, else the home's absolute path. */
function backupScript(env: NodeJS.ProcessEnv, home: string): string {
	if (home === join(env.HOME || homedir(), ".orrery")) return "%h/.orrery/app/current/deploy/workstation/backup.sh";
	const path = join(home, "app", "current", "deploy", "workstation", "backup.sh");
	return /\s/.test(path) ? JSON.stringify(path) : path;
}

/** Rewrites the backup service's backup.sh line to app/current (same mode, one rename), then reloads systemd. */
function pointBackup(env: NodeJS.ProcessEnv, home: string, run: Runner, left: string[]): string[] {
	const unit = join(env.HOME || homedir(), ".config", "systemd", "user", "orrery-backup.service");
	let text: string;
	try {
		text = readFileSync(unit, "utf8");
	} catch (error) {
		if ((error as { code?: unknown }).code === "ENOENT") return ["no backup service; see docs/deploy.md"];
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

/**
 * pi, Claude Code and OMP through checkTools and installSteps against app/current: "missing" and "update available" run
 * without asking, "other" (another Orrery, or not Orrery's file) after confirm. A missing pi or OMP extension is written
 * only when that tool is on PATH.
 */
async function wireTools(env: NodeJS.ProcessEnv, current: string, run: { probe: Runner; install: Runner }, confirm: Confirm, left: string[]): Promise<string[]> {
	const lines: string[] = [];
	const look = () => checkTools({ root: current, env, run: run.probe });
	let checks = look();
	for (const id of ["pi", "claude-code", "omp"] as const) {
		const check = checks.find((c) => c.id === id) as ToolCheck;
		const steps = installSteps(check, current, env);
		if (steps.length === 0) {
			// "unknown" is a tool Orrery could not check; "other" with nothing to run is blocked (shared folder), only info.
			if (check.wiring === "unknown") left.push(`couldn't check ${check.label}: ${check.detail}`);
			lines.push(`${check.label}: ${check.wiring === "installed" ? `already wired (${check.detail})` : check.detail}`);
			continue;
		}
		if (check.wiring === "missing" && check.path === undefined) {
			lines.push(`${check.label}: not found on PATH; not wired`);
			continue;
		}
		if (check.wiring === "other" && !(await confirm(`${check.label}: ${steps.map((step) => step.describe).join(", then ")}?`))) {
			left.push(`${check.label} (still wired to ${check.detail})`);
			lines.push(`${check.label}: left as it is (${check.detail})`);
			continue;
		}
		const result = runInstall(steps, run.install);
		lines.push(...result.output.split("\n").filter((line) => line.trim() !== "").map((line) => `${check.label}: ${line}`));
		if (!result.ok) {
			left.push(`${check.label} (the install failed)`);
			lines.push(`${check.label}: not wired; orrery tools install ${id} tries again`);
		}
		// pi and OMP may share one extensions folder: OMP is judged after pi's file is written.
		checks = look();
	}
	return lines;
}

/** What wiring did: one line per thing wired, skipped or failed, and what is still wired elsewhere (skipped, declined or failed). */
export interface WireReport {
	lines: string[];
	left: string[];
}

/** Points everything at <home>/app/current. */
export async function wireReport(env: NodeJS.ProcessEnv, options: { run?: Runner; confirm: Confirm }): Promise<WireReport> {
	// A tool's --version or plugin list gets 15 s; installing the Claude Code plugin may take longer.
	const run = options.run ?? envRunner(env, 300_000);
	const probe = options.run ?? envRunner(env, 15_000);
	const home = orreryHome(env);
	const current = join(home, "app", "current");
	const left: string[] = [];
	const lines = [
		await linkCommand(env, current, options.confirm, left),
		...pointBackup(env, home, run, left),
		...(await wireTools(env, current, { probe, install: run }, options.confirm, left)),
	];
	return { lines, left };
}

/** wireReport's lines. */
export async function wire(env: NodeJS.ProcessEnv, options: { run?: Runner; confirm: Confirm }): Promise<string[]> {
	return (await wireReport(env, options)).lines;
}

/** The closing warning when wiring left something behind: the list and the commands that fix it. */
export function leftWarning(left: string[]): string[] {
	if (left.length === 0) return [];
	return [
		"Not everything points at this install. Still wired elsewhere:",
		...left.map((item) => `  - ${item}`),
		"Fix it with: npm run install-local -- --yes (or run orrery, then Tools, then I).",
	];
}
