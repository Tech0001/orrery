import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { removeVersion } from "../../src/install/install.ts";
import { piExtensionFile, type Runner } from "../../src/lane/tools.ts";

const dirs: string[] = [];

/** Removes every folder tempDir made, read-only version folders included (register with afterEach). */
export function cleanupScratch(): void {
	for (const d of dirs.splice(0)) removeVersion(d);
}

export function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

export const VERSION = "0.6.0-abc1234";

/** Runs only the scratch bins' fake commands: anything else (a real systemctl or claude) is refused, never run. */
export const fakeRun: Runner = (cmd, args) => {
	if (!isAbsolute(cmd) || !cmd.startsWith(join(tmpdir(), "orrery-wire-"))) return { status: 127, stdout: "", stderr: `not a scratch command: ${cmd}` };
	const r = spawnSync(cmd, [...args], { encoding: "utf8", env: { PATH: dirname(cmd) } });
	return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

export type Style = "source" | "binary";

/** The files each installed shape has: a release (binary) or a 0.5.0 source copy. */
const SHAPES: Record<Style, string[]> = {
	binary: ["VERSION", "bin/orrery", "extensions/pi.js", "extensions/omp.js", "deploy/workstation/backup.sh"],
	source: ["src/cli/main.ts", "src/pi/index.ts", "src/omp/index.ts", "deploy/workstation/backup.sh"],
};

export interface Scratch {
	readonly env: NodeJS.ProcessEnv;
	readonly home: string;
	readonly orreryHome: string;
	readonly bin: string;
	readonly calls: () => string[][];
	readonly current: string;
}

/**
 * A scratch home with an installed version (`style`, default the source shape) and app/current; env.PATH holds only a
 * scratch bin of fake commands that log their arguments (claude lists no plugins; `tools` adds more, such as a fake
 * pi). calls() reads the log.
 */
export function installedScratch(options: { tools?: Record<string, string>; orreryHome?: string; style?: Style } = {}): Scratch {
	const home = tempDir("orrery-wire-");
	const bin = join(home, "bin");
	const log = join(home, "calls.log");
	mkdirSync(bin);
	const logLine = `{ printf '%s' "\${0##*/}"; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\n'; } >> ${JSON.stringify(log)}`;
	const scripts: Record<string, string> = {
		claude: `if [ "$1" = "--version" ]; then echo "2.1.294 (Claude Code)"; elif [ "$1 $2" = "plugin list" ]; then printf '%s' "\${FAKE_PLUGINS:-[]}"; fi`,
		systemctl: "",
		...options.tools,
	};
	for (const [name, body] of Object.entries(scripts)) {
		writeFileSync(join(bin, name), `#!/bin/sh\n${logLine}\n${body}\n`);
		chmodSync(join(bin, name), 0o755);
	}
	const orreryHome = options.orreryHome ?? join(home, ".orrery");
	const t = {
		env: { HOME: home, ORRERY_HOME: orreryHome, PATH: bin } as NodeJS.ProcessEnv,
		home,
		orreryHome,
		bin,
		calls: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l !== "").map((line) => line.split("\t")) : []),
		current: join(orreryHome, "app", "current"),
	};
	addVersion(t, VERSION, options.style ?? "source");
	symlinkSync(VERSION, t.current);
	return t;
}

/** Writes app/<name> in `style`'s shape. */
export function addVersion(t: Pick<Scratch, "orreryHome">, name: string, style: Style): void {
	for (const entry of SHAPES[style]) {
		const file = join(t.orreryHome, "app", name, entry);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, "\n", { mode: entry === "bin/orrery" ? 0o755 : 0o644 });
	}
}

/** Relinks app/current to `name`. */
export function pointCurrent(t: Pick<Scratch, "current">, name: string): void {
	rmSync(t.current, { force: true });
	symlinkSync(name, t.current);
}

export function writePiExtension(env: NodeJS.ProcessEnv, target: string): void {
	const file = piExtensionFile(env);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `export { default } from ${JSON.stringify(target)};\n`);
}

/** A release folder for `version`: a bin/orrery that answers --version (and can be told to fail), and the files a release has. */
export function fixtureRelease(version: string, options: { versionOutput?: string; exit?: number } = {}): string {
	const dir = join(tempDir("orrery-release-"), `orrery-${version}-linux-x64`);
	mkdirSync(join(dir, "bin"), { recursive: true });
	mkdirSync(join(dir, "extensions"), { recursive: true });
	writeFileSync(join(dir, "VERSION"), `${version}\n`);
	writeFileSync(join(dir, "extensions", "pi.js"), "export default () => {};\n");
	const said = options.versionOutput ?? `orrery ${version}`;
	writeFileSync(join(dir, "bin", "orrery"), `#!/bin/sh\n[ "$1" = --version ] && { echo "${said}"; exit ${options.exit ?? 0}; }\nexit 0\n`, { mode: 0o755 });
	return dir;
}

/**
 * A PATH for a spawned orrery that must find no pi, OMP, Claude Code, Codex or systemctl, wherever the machine installs
 * them: one scratch folder holding links to only the system commands named (found on the test runner's PATH).
 */
export function scratchPath(commands: readonly string[] = []): string {
	const dir = tempDir("orrery-path-");
	for (const name of commands) {
		const found = (process.env.PATH ?? "").split(":").map((d) => join(d, name)).find((file) => existsSync(file));
		if (found === undefined) throw new Error(`${name} is not on PATH`);
		symlinkSync(found, join(dir, name));
	}
	return dir;
}

/** A system command's absolute path, for spawning it under a scratch PATH; undefined when it is not installed. */
export function systemCommand(name: string): string | undefined {
	return ["/usr/bin", "/bin", ...(process.env.PATH ?? "").split(":")].map((d) => join(d, name)).find((file) => existsSync(file));
}
