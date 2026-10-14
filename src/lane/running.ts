/**
 * Where the running code lives and how to start it again: a checkout (TypeScript on Node), a release's compiled binary
 * (bin/orrery), or a release's packed pi/OMP extension (extensions/*.js, inside pi or OMP). A release folder holds a
 * VERSION file; a checkout holds package.json. Kept apart from tools.ts (Node only) because every lane's status file
 * records the version, inside pi and OMP too.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { within } from "./guard-rules.ts";
import { orreryHome } from "./home.ts";

/** True inside a binary made by `bun build --compile`, whose modules live in Bun's embedded /$bunfs/ file system. */
export const compiled: boolean = fileURLToPath(import.meta.url).startsWith("/$bunfs/");

/**
 * This module's own file by real path, taken when it loads. Through app/current an install can switch the link at any
 * time; a running pi or OMP keeps the version it loaded, and its status file must say so. Undefined where the path
 * cannot be resolved (the binary's embedded /$bunfs/ file system).
 */
const loadedFrom: string | undefined = (() => {
	try {
		return realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return undefined;
	}
})();

let foundRoot: string | undefined;

/**
 * The folder this code runs from, found on the first call and kept: for the binary, the folder above its bin/ (by the
 * real path of process.execPath), which must hold VERSION (a binary copied out of its release fails rather than read
 * whatever package.json lies above it); otherwise the nearest folder above the file this module loaded from (its real
 * path at load time) that holds VERSION (a release) or package.json (a checkout).
 */
export function runningRoot(): string {
	foundRoot ??= findRoot();
	return foundRoot;
}

function findRoot(): string {
	if (compiled) {
		const binary = realpathSync(process.execPath);
		const root = resolve(dirname(binary), "..");
		if (!existsSync(join(root, "VERSION"))) throw new Error(`no VERSION beside this binary at ${binary} (looked for ${join(root, "VERSION")})`);
		return root;
	}
	const here = loadedFrom ?? fileURLToPath(import.meta.url);
	for (let dir = dirname(here); ; dir = dirname(dir)) {
		if (existsSync(join(dir, "VERSION")) || existsSync(join(dir, "package.json"))) return dir;
		if (dirname(dir) === dir) throw new Error(`no Orrery folder above ${here}`);
	}
}

/** What wiring should name: app/current when this code runs from an install, else the folder it runs from. */
export function wiringRoot(env: NodeJS.ProcessEnv = process.env): { root: string; installed: boolean } {
	const app = join(orreryHome(env), "app");
	try {
		if (within(realpathSync(runningRoot()), realpathSync(app))) return { root: join(app, "current"), installed: true };
	} catch {
		// no app folder: not installed
	}
	return { root: runningRoot(), installed: false };
}

/** A release's VERSION ("0.6.0", or "0.6.0-<commit>" for a local build), else the checkout's package.json version. */
export function versionNumber(root: string = runningRoot()): string {
	const file = join(root, "VERSION");
	if (existsSync(file)) return readFileSync(file, "utf8").trim();
	return (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
}

/** What a lane's status file records: a release's version, an installed source copy's folder name (0.5.0), or "checkout". */
export function runningVersion(env: NodeJS.ProcessEnv = process.env): string {
	const root = runningRoot();
	if (existsSync(join(root, "VERSION"))) return versionNumber(root);
	return wiringRoot(env).installed ? basename(root) : "checkout";
}

/** What `orrery --version` prints: a release's or an installed copy's version, or a checkout's version and path. */
export function versionLine(running: string = runningVersion()): string {
	if (running !== "checkout") return `orrery ${running}\n`;
	return `orrery ${versionNumber()} (checkout ${runningRoot()})\n`;
}

/** The command that runs this Orrery's CLI with `args`: the binary itself, or this runtime with the checkout's main.ts. */
export function selfCommand(args: readonly string[]): { cmd: string; args: string[] } {
	if (compiled) return { cmd: process.execPath, args: [...args] };
	return { cmd: process.execPath, args: [...process.execArgv, join(runningRoot(), "src", "cli", "main.ts"), ...args] };
}
