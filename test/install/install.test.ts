import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { holdInstallLock, install, listVersions, rollback } from "../../src/install/install.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
const MAIN = join(SRC, "cli", "main.ts");
/** What src/lane/tools.ts loads: the installed-copy probe below runs it from app/current. */
const TOOLS_FILES = ["lane/tools.ts", "lane/running.ts", "lane/guard-rules.ts", "lane/guard-paths.ts", "lane/home.ts", "lane/source-labels.ts", "import/scrub.ts"];

/** A scratch home. The environment running the tests may name a config of its own; the installer must not see it. */
function scratchEnv(): NodeJS.ProcessEnv {
	const home = tempDir("orrery-home-");
	const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ORRERY_HOME: join(home, ".orrery") };
	delete env.ORRERY_CONFIG;
	return env;
}

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, "-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" });

/**
 * A tiny committed tree: no dependencies (npm ci stays offline and fast), a CLI that answers --help, one ignored file.
 * `tools`: also the real src/lane/tools.ts and what it loads, with probe.ts printing what the running copy reports.
 */
function fixtureCheckout(options: { tools?: boolean; scripts?: Record<string, string> } = {}): string {
	const dir = tempDir("orrery-fixture-");
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "orrery", version: "0.6.0", type: "module", ...(options.scripts === undefined ? {} : { scripts: options.scripts }) }));
	writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ name: "orrery", version: "0.6.0", lockfileVersion: 3, requires: true, packages: { "": { name: "orrery", version: "0.6.0" } } }));
	mkdirSync(join(dir, "src", "cli"), { recursive: true });
	writeFileSync(join(dir, "src", "cli", "main.ts"), 'if (process.argv.includes("--help")) console.log("ok");\n');
	writeFileSync(join(dir, ".gitignore"), "secret.env\n");
	writeFileSync(join(dir, "secret.env"), "never copied\n");
	if (options.tools === true) {
		for (const file of TOOLS_FILES) {
			mkdirSync(dirname(join(dir, "src", file)), { recursive: true });
			copyFileSync(join(SRC, file), join(dir, "src", file));
		}
		writeFileSync(join(dir, "probe.ts"), 'import { runningVersion, wiringRoot } from "./src/lane/tools.ts";\nconsole.log(JSON.stringify({ version: runningVersion(), wiring: wiringRoot() }));\n');
	}
	execFileSync("git", ["-C", dir, "init", "-q"]);
	git(dir, "add", "-A");
	git(dir, "commit", "-qm", "fixture");
	return dir;
}

/** Each scratch env's fixture checkout, for commitAgain. */
const checkouts = new WeakMap<NodeJS.ProcessEnv, string>();

/** An empty commit in env's checkout, so the next install is a new version. */
function commitAgain(env: NodeJS.ProcessEnv): string {
	const checkout = checkouts.get(env) as string;
	git(checkout, "commit", "-q", "--allow-empty", "-m", "again");
	return checkout;
}

function freshInstall() {
	const checkout = fixtureCheckout();
	const env = scratchEnv();
	checkouts.set(env, checkout);
	return { checkout, env, version: install({ checkout, env, checks: "minimal" }).version };
}

function twoInstalls() {
	const { checkout, env, version } = freshInstall();
	return { checkout, env, versions: [version, install({ checkout: commitAgain(env), env, checks: "minimal" }).version] };
}

/** v1..v5, current = v5. Lane Atlas starts on v1 and keeps running through the later installs. */
function fiveInstalls() {
	const { checkout, env, version } = freshInstall();
	const versions = [version];
	writeLiveStatus(env, "Atlas", version);
	while (versions.length < 5) versions.push(install({ checkout: commitAgain(env), env, checks: "minimal" }).version);
	return { checkout, env, versions };
}

/** A lane in the home's config whose status.json says it runs `version` as `pid` (default: this process, alive). */
function writeLiveStatus(env: NodeJS.ProcessEnv, lane: string, version: string, pid = process.pid, open = true): void {
	const home = env.ORRERY_HOME as string;
	const config = join(home, "config.toml");
	const text = existsSync(config) ? readFileSync(config, "utf8") : `data_dir = ${JSON.stringify(join(home, "data"))}\n`;
	if (!text.includes(`[lanes.${lane}]`)) writeFileSync(config, `${text}[lanes.${lane}]\nworkspace = ${JSON.stringify(join(home, "ws", lane))}\ncompactor_model = "local/m"\n`);
	const dir = join(home, "data", "lanes", lane);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "status.json"),
		JSON.stringify({
			lane, pid, open, busy: false, model: "pi", thinking: "pi",
			compactor: { stopped: false, failing: 0, model: "local/m", thinking: "off", source: "config" },
			trouble: null, lastError: null, updatedAt: new Date().toISOString(), version,
		}),
	);
}

const currentOf = (env: NodeJS.ProcessEnv) => readlinkSync(join(env.ORRERY_HOME as string, "app", "current"));
const historyOf = (env: NodeJS.ProcessEnv) => readFileSync(join(env.ORRERY_HOME as string, "app", "history"), "utf8").trim().split("\n");
const versionFolders = (env: NodeJS.ProcessEnv) => readdirSync(join(env.ORRERY_HOME as string, "app")).filter((n) => /^0\.6\.0-/.test(n)).sort();

/** A pid that was alive a moment ago and is not now. */
function deadPid(): number {
	return spawnSync(process.execPath, ["-e", ""]).pid as number;
}

describe("install", () => {
	it("installs the committed tree into app/<version> and points current at it", () => {
		const checkout = fixtureCheckout();
		const env = scratchEnv();
		const home = env.HOME as string;
		const sha = execFileSync("git", ["-C", checkout, "rev-parse", "--short=7", "HEAD"], { encoding: "utf8" }).trim();
		const result = install({ checkout, env, checks: "minimal" });
		expect(result.version).toBe(`0.6.0-${sha}`);
		const app = join(home, ".orrery", "app");
		expect(readlinkSync(join(app, "current"))).toBe(`0.6.0-${sha}`);
		expect(existsSync(join(app, result.version, "secret.env"))).toBe(false);
		expect(readdirSync(app).filter((n) => n.startsWith(".staging-"))).toEqual([]);
		expect(readFileSync(join(app, "history"), "utf8").trim().split("\n")).toEqual([result.version]);
		expect(statSync(join(home, ".orrery")).mode & 0o777).toBe(0o700);
		expect(statSync(app).mode & 0o777).toBe(0o700);
		expect(statSync(join(app, "history")).mode & 0o777).toBe(0o600);
		expect(existsSync(join(app, ".install.lock"))).toBe(false);
	});

	it("removes a staging folder an interrupted install left", () => {
		const env = scratchEnv();
		const leftover = join(env.ORRERY_HOME as string, "app", ".staging-interrupted");
		mkdirSync(leftover, { recursive: true });
		writeFileSync(join(leftover, "package.json"), "{}");
		chmodSync(env.ORRERY_HOME as string, 0o755);
		install({ checkout: fixtureCheckout(), env, checks: "minimal" });
		expect(existsSync(leftover)).toBe(false);
		expect(statSync(env.ORRERY_HOME as string).mode & 0o777).toBe(0o700); // an existing 0755 home is tightened
	});

	it("says uncommitted changes are not included", () => {
		const checkout = fixtureCheckout();
		writeFileSync(join(checkout, "src", "cli", "main.ts"), "changed\n");
		const lines: string[] = [];
		const env = scratchEnv();
		const { version } = install({ checkout, env, checks: "minimal", log: (l) => lines.push(l) });
		expect(lines.join("\n")).toMatch(/uncommitted changes are not included/);
		expect(readFileSync(join(env.ORRERY_HOME as string, "app", version, "src", "cli", "main.ts"), "utf8")).toContain("--help");
	});

	it("leaves current alone and removes the staging folder when a check fails", () => {
		const checkout = fixtureCheckout();
		const env = scratchEnv();
		const first = install({ checkout, env, checks: "minimal" });
		writeFileSync(join(checkout, "src", "cli", "main.ts"), "process.exit(3);\n");
		execFileSync("git", ["-C", checkout, "-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qam", "broken"]);
		expect(() => install({ checkout, env, checks: "minimal" })).toThrow(/check failed/);
		const app = join(env.ORRERY_HOME as string, "app");
		expect(readlinkSync(join(app, "current"))).toBe(first.version);
		expect(readdirSync(app).filter((n) => n.startsWith(".staging-"))).toEqual([]);
		expect(versionFolders(env)).toEqual([first.version]);
		expect(existsSync(join(app, ".install.lock"))).toBe(false);
	});

	it("names the failing check and its first error line", () => {
		const checkout = fixtureCheckout();
		writeFileSync(join(checkout, "src", "cli", "main.ts"), 'console.error("boom: no config");\nconsole.error("second line");\nprocess.exit(1);\n');
		git(checkout, "commit", "-qam", "broken");
		expect(() => install({ checkout, env: scratchEnv(), checks: "minimal" })).toThrow("check failed: node src/cli/main.ts --help: boom: no config");
	});

	it("full checks run a read-only status against the config when there is one, and the Bun store check when bun is on PATH", () => {
		const checkout = fixtureCheckout({ scripts: { "test:bun": `node -e "console.error('bun store broke'); process.exit(4)"` } });
		writeFileSync(join(checkout, "src", "cli", "main.ts"), 'if (process.argv.includes("status")) { console.error("status read " + process.argv.at(-1)); process.exit(2); }\n');
		git(checkout, "commit", "-qam", "status fails");
		const bin = tempDir("orrery-bun-");
		writeFileSync(join(bin, "bun"), "#!/bin/sh\n", { mode: 0o755 });
		const env: NodeJS.ProcessEnv = { ...scratchEnv(), PATH: `${bin}:${process.env.PATH ?? ""}` };
		// No config: status is skipped, the Bun check runs.
		expect(() => install({ checkout, env, checks: "full" })).toThrow("check failed: npm run test:bun: bun store broke");
		const config = join(env.ORRERY_HOME as string, "config.toml");
		writeFileSync(config, "");
		expect(() => install({ checkout, env, checks: "full" })).toThrow(`check failed: node src/cli/main.ts status: status read ${config}`);
		expect(existsSync(join(env.ORRERY_HOME as string, "app", "current"))).toBe(false);
	});

	it("rolls back to the previous version", () => {
		const { env, versions } = twoInstalls();
		expect(rollback(env)).toEqual({ from: versions[1], to: versions[0] });
		expect(readlinkSync(join(env.ORRERY_HOME as string, "app", "current"))).toBe(versions[0]);
		expect(historyOf(env)).toEqual([versions[0], versions[1]]); // history is install order; a rollback adds nothing
	});

	it("walks back in install order: a second rollback goes to the version before, a third refuses", () => {
		const { checkout, env, versions } = twoInstalls();
		const third = install({ checkout: commitAgain(env), env, checks: "minimal" }).version;
		expect(rollback(env)).toEqual({ from: third, to: versions[1] });
		expect(rollback(env)).toEqual({ from: versions[1], to: versions[0] });
		expect(currentOf(env)).toBe(versions[0]);
		expect(() => rollback(env)).toThrow(/no earlier version to roll back to/);
		expect(currentOf(env)).toBe(versions[0]);
		expect(checkout).toBeTruthy();
	});

	it("does not cycle: after v1..v3 and two rollbacks, installing v2 again puts it last, and rollback walks the true order", () => {
		const { checkout, env, versions } = twoInstalls();
		const v3 = install({ checkout: commitAgain(env), env, checks: "minimal" }).version;
		const [v1, v2] = versions;
		rollback(env);
		rollback(env);
		expect(currentOf(env)).toBe(v1);
		git(checkout, "checkout", "-q", v2.split("-").at(-1) as string); // v2's commit; its folder already exists
		expect(install({ checkout, env, checks: "minimal" }).version).toBe(v2);
		expect(historyOf(env)).toEqual([v1, v3, v2]);
		expect(rollback(env)).toEqual({ from: v2, to: v3 });
		expect(rollback(env)).toEqual({ from: v3, to: v1 });
		expect(() => rollback(env)).toThrow(/no earlier version to roll back to/);
	});

	it("rolls back after a downgrade by install (A, B, A again) to B, then refuses", () => {
		const { checkout, env, versions } = twoInstalls();
		const [a, b] = versions;
		git(checkout, "checkout", "-q", a.split("-").at(-1) as string);
		install({ checkout, env, checks: "minimal" });
		expect(historyOf(env)).toEqual([b, a]);
		expect(rollback(env)).toEqual({ from: a, to: b });
		expect(() => rollback(env)).toThrow(/no earlier version to roll back to/);
		expect(statSync(join(env.ORRERY_HOME as string, "app", "history")).mode & 0o777).toBe(0o600);
	});

	it("keeps the version the user rolled back to, and the one a rollback would go to next, through the next install's GC", () => {
		const { env, versions } = fiveInstalls(); // folders v1 (Atlas), v3, v4, v5; history v1..v5
		writeFileSync(join(env.ORRERY_HOME as string, "data", "lanes", "Atlas", "status.json"), JSON.stringify({ pid: process.pid, version: versions[0], open: false }));
		rollback(env);
		rollback(env); // current = v3
		expect(currentOf(env)).toBe(versions[2]);
		const result = install({ checkout: commitAgain(env), env, checks: "minimal" }); // v6
		expect(versionFolders(env)).toContain(versions[2]);
		expect(versionFolders(env)).toContain(versions[4]);
		expect(result.removed).not.toContain(versions[2]);
	});

	it("makes an install after a rollback current and newest, and rolls back from it to the version before", () => {
		const { env, versions } = twoInstalls();
		rollback(env); // current = v1
		const next = install({ checkout: commitAgain(env), env, checks: "minimal" }).version; // v3
		expect(currentOf(env)).toBe(next);
		expect(historyOf(env).at(-1)).toBe(next);
		expect(rollback(env)).toEqual({ from: next, to: versions[1] });
	});

	it("refuses to roll back with no earlier version", () => {
		const { env } = freshInstall();
		expect(() => rollback(env)).toThrow(/no earlier version to roll back to/);
		expect(() => rollback(scratchEnv())).toThrow(/not installed/);
	});

	it("switches back to an installed version without staging it again, and says when it is already current", () => {
		const { checkout, env, versions } = twoInstalls();
		rollback(env);
		expect(install({ checkout, env, checks: "minimal" })).toEqual({ version: versions[1], previous: versions[0], removed: [] });
		expect(currentOf(env)).toBe(versions[1]);
		const lines: string[] = [];
		expect(install({ checkout, env, checks: "minimal", log: (l) => lines.push(l) })).toEqual({ version: versions[1], removed: [] });
		expect(lines.join("\n")).toMatch(/already installed/);
		expect(historyOf(env)).toEqual([versions[0], versions[1]]);
	});

	it("keeps the newest three versions, current, and any version a live lane runs", () => {
		const { env, versions } = fiveInstalls(); // v1..v5, current = v5
		writeLiveStatus(env, "Atlas", versions[0]); // a lane still running v1, its pid alive (process.pid)
		const result = install({ checkout: commitAgain(env), env, checks: "minimal" }); // v6
		const left = readdirSync(join(env.ORRERY_HOME as string, "app")).filter((n) => /^0\.6\.0-/.test(n));
		expect(left.sort()).toEqual([versions[0], versions[3], versions[4], currentOf(env)].sort());
		expect(result.removed).toEqual([versions[2]]);
		expect(result.previous).toBe(versions[4]);
	});

	it("does not keep a version for a lane that closed or whose process is gone", () => {
		const { env, versions } = fiveInstalls();
		writeLiveStatus(env, "Atlas", versions[0], deadPid());
		writeLiveStatus(env, "Bea", versions[2], process.pid, false);
		const { version } = install({ checkout: commitAgain(env), env, checks: "minimal" });
		expect(versionFolders(env)).toEqual([versions[3], versions[4], version].sort());
	});

	it("keeps every version when a lane's status.json cannot be read, and when it lacks a pid or version", () => {
		for (const bad of ["{not json", JSON.stringify({ open: true, version: "x" }), JSON.stringify({ pid: process.pid, open: true }), JSON.stringify({ pid: process.pid, version: "x", open: "yes" })]) {
			const { env } = fiveInstalls();
			const before = versionFolders(env).length;
			writeFileSync(join(env.ORRERY_HOME as string, "data", "lanes", "Atlas", "status.json"), bad);
			const lines: string[] = [];
			const result = install({ checkout: commitAgain(env), env, checks: "minimal", log: (l) => lines.push(l) });
			expect(result.removed, bad).toEqual([]);
			expect(versionFolders(env).length, bad).toBe(before + 1);
			expect(lines.join("\n"), bad).toMatch(/Kept every older version/);
		}
	});

	it("does not let a status without a version block GC when the lane is closed or its process is gone", () => {
		for (const status of [{ pid: process.pid, open: false }, { pid: deadPid() }]) {
			const { env, versions } = fiveInstalls();
			writeFileSync(join(env.ORRERY_HOME as string, "data", "lanes", "Atlas", "status.json"), JSON.stringify(status));
			const { removed } = install({ checkout: commitAgain(env), env, checks: "minimal" });
			expect(removed, JSON.stringify(status)).toContain(versions[0]);
		}
	});

	it("keeps everything for a live pid without a version, and the log names the real reason", () => {
		for (const [bad, reason] of [
			[JSON.stringify({ pid: process.pid, open: true }), /Atlas.*live process but no version/],
			["{not json", /Atlas.*cannot be parsed/],
			[JSON.stringify({ open: true, version: "x" }), /Atlas.*no pid/],
		] as const) {
			const { env } = fiveInstalls();
			writeFileSync(join(env.ORRERY_HOME as string, "data", "lanes", "Atlas", "status.json"), bad);
			const lines: string[] = [];
			expect(install({ checkout: commitAgain(env), env, checks: "minimal", log: (l) => lines.push(l) }).removed, bad).toEqual([]);
			expect(lines.join("\n"), bad).toMatch(reason);
			expect(lines.join("\n"), bad).not.toMatch(/config.*could not be read/);
		}
	});

	it("reads only pid, open and version from a status: {pid, version} alone protects its version", () => {
		const { env, versions } = fiveInstalls();
		writeFileSync(join(env.ORRERY_HOME as string, "data", "lanes", "Atlas", "status.json"), JSON.stringify({ pid: process.pid, version: versions[0] }));
		install({ checkout: commitAgain(env), env, checks: "minimal" });
		expect(versionFolders(env)).toContain(versions[0]);
		expect(versionFolders(env)).not.toContain(versions[2]);
	});

	it("refuses a second install while one holds the lock", () => {
		const env = scratchEnv();
		mkdirSync(join(env.ORRERY_HOME as string, "app"), { recursive: true });
		const release = holdInstallLock(env); // exported for tests from install.ts
		try {
			expect(() => install({ checkout: fixtureCheckout(), env, checks: "minimal" })).toThrow(/another install is running/);
		} finally {
			release();
		}
		expect(readdirSync(join(env.ORRERY_HOME as string, "app"))).toEqual([]);
		const { env: installed, versions } = twoInstalls();
		const hold = holdInstallLock(installed);
		try {
			expect(() => rollback(installed)).toThrow(/another install is running/);
		} finally {
			hold();
		}
		expect(currentOf(installed)).toBe(versions[1]);
	});

	it("refuses outside a git checkout or before the first commit, and creates nothing", () => {
		const env = scratchEnv();
		const plain = tempDir("orrery-plain-");
		expect(() => install({ checkout: plain, env, checks: "minimal" })).toThrow(/not a git checkout/);
		execFileSync("git", ["-C", plain, "init", "-q"]);
		expect(() => install({ checkout: plain, env, checks: "minimal" })).toThrow(/no commit yet/);
		expect(existsSync(join(env.ORRERY_HOME as string, "app"))).toBe(false);
	});

	it("lists the versions, which one is current, and which live lanes run each", () => {
		const { env, versions } = twoInstalls();
		writeLiveStatus(env, "Atlas", versions[0]);
		writeLiveStatus(env, "Bea", versions[1], deadPid());
		expect(listVersions(env)).toEqual([
			{ name: versions[0], current: false, lanes: ["Atlas"] },
			{ name: versions[1], current: true, lanes: [] },
		]);
		expect(listVersions(scratchEnv())).toEqual([]);
	});

	it("runs from app/current: the installed code names its version folder and wires app/current", () => {
		const checkout = fixtureCheckout({ tools: true });
		const env = scratchEnv();
		const { version } = install({ checkout, env, checks: "minimal" });
		const current = join(env.ORRERY_HOME as string, "app", "current");
		const out = execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", join(current, "probe.ts")], { env, encoding: "utf8" });
		expect(JSON.parse(out)).toEqual({ version, wiring: { root: current, installed: true } });
	});
});

describe("orrery install", () => {
	const cli = (env: NodeJS.ProcessEnv, ...args: string[]) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", MAIN, ...args], { env, encoding: "utf8" });

	it("--list and --rollback work from the command, without a config", () => {
		const { env, versions } = twoInstalls();
		const list = cli(env, "install", "--list");
		expect(list.status, list.stderr).toBe(0);
		expect(list.stdout).toMatch(new RegExp(`^  ${versions[0]}$`, "m"));
		expect(list.stdout).toMatch(new RegExp(`^\\* ${versions[1]}  \\(current\\)$`, "m"));
		const back = cli(env, "install", "--rollback");
		expect(back.status, back.stderr).toBe(0);
		expect(back.stdout).toContain(`from ${versions[1]} to ${versions[0]}`);
		expect(currentOf(env)).toBe(versions[0]);
	});

	it("points a plain install at npm run install-local", () => {
		const plain = cli(scratchEnv(), "install");
		expect(plain.status).toBe(1);
		expect(plain.stderr).toContain("npm run install-local");
	});

	it("answers --help, which the installer's first check runs", () => {
		const help = cli(scratchEnv(), "--help");
		expect(help.status, help.stderr).toBe(0);
		expect(help.stdout).toContain("install --rollback | --list");
	});
});
