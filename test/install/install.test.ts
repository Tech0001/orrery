import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { holdInstallLock, installFrom, listVersions, makeReadOnly, releaseVersion, removeVersion, rollback } from "../../src/install/install.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) removeVersion(d);
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

const MAIN = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));

/** A scratch home. The environment running the tests may name a config of its own; the installer must not see it. */
function scratchEnv(): NodeJS.ProcessEnv {
	const home = tempDir("orrery-home-");
	const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ORRERY_HOME: join(home, ".orrery") };
	delete env.ORRERY_CONFIG;
	return env;
}

/** A release folder for `version`: a bin/orrery that answers --version (and can be told to fail), and the files a release has. */
function fixtureRelease(version: string, options: { versionOutput?: string; exit?: number } = {}): string {
	const dir = join(tempDir("orrery-release-"), `orrery-${version}-linux-x64`);
	mkdirSync(join(dir, "bin"), { recursive: true });
	mkdirSync(join(dir, "extensions"), { recursive: true });
	writeFileSync(join(dir, "VERSION"), `${version}\n`);
	writeFileSync(join(dir, "extensions", "pi.js"), "export default () => {};\n");
	const said = options.versionOutput ?? `orrery ${version}`;
	writeFileSync(join(dir, "bin", "orrery"), `#!/bin/sh\n[ "$1" = --version ] && { echo "${said}"; exit ${options.exit ?? 0}; }\nexit 0\n`, { mode: 0o755 });
	return dir;
}

/** The next version to install in each scratch env: 0.6.0, 0.6.1, ... */
const counters = new WeakMap<NodeJS.ProcessEnv, number>();

/** Installs the env's next version (0.6.<n>) and returns its name. */
function installNext(env: NodeJS.ProcessEnv, options: Partial<Parameters<typeof installFrom>[0]> = {}) {
	const n = counters.get(env) ?? 0;
	counters.set(env, n + 1);
	return installFrom({ from: fixtureRelease(`0.6.${n}`), env, ...options });
}

function freshInstall() {
	const env = scratchEnv();
	return { env, version: installNext(env).version };
}

function twoInstalls() {
	const { env, version } = freshInstall();
	return { env, versions: [version, installNext(env).version] };
}

/** v1..v5, current = v5. Lane Atlas starts on v1 and keeps running through the later installs. */
function fiveInstalls() {
	const { env, version } = freshInstall();
	const versions = [version];
	writeLiveStatus(env, "Atlas", version);
	while (versions.length < 5) versions.push(installNext(env).version);
	return { env, versions };
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
const versionFolders = (env: NodeJS.ProcessEnv) => readdirSync(join(env.ORRERY_HOME as string, "app")).filter((n) => /^0\.6\./.test(n)).sort();

/** A pid that was alive a moment ago and is not now. */
function deadPid(): number {
	return spawnSync(process.execPath, ["-e", ""]).pid as number;
}

describe("installFrom", () => {
	it("installs a release folder into app/<VERSION>, read-only, and points current at it", () => {
		const env = scratchEnv();
		const result = installFrom({ from: fixtureRelease("0.6.0"), env });
		const app = join(env.ORRERY_HOME as string, "app");
		expect(result.version).toBe("0.6.0");
		expect(readlinkSync(join(app, "current"))).toBe("0.6.0");
		expect(statSync(join(app, "0.6.0")).mode & 0o777).toBe(0o555);
		expect(statSync(join(app, "0.6.0", "VERSION")).mode & 0o777).toBe(0o444);
		expect(statSync(join(app, "0.6.0", "bin", "orrery")).mode & 0o777).toBe(0o555);
		expect(() => writeFileSync(join(app, "0.6.0", "VERSION"), "x")).toThrow();
		expect(readdirSync(app).filter((n) => n.startsWith(".staging-"))).toEqual([]);
		expect(readFileSync(join(app, "history"), "utf8").trim().split("\n")).toEqual(["0.6.0"]);
		expect(statSync(join(env.ORRERY_HOME as string)).mode & 0o777).toBe(0o700);
		expect(statSync(app).mode & 0o777).toBe(0o700);
		expect(statSync(join(app, "history")).mode & 0o777).toBe(0o600);
		expect(existsSync(join(app, ".install.lock"))).toBe(false);
	});

	it("refuses a folder with no usable VERSION, and one whose binary names another version; nothing changes", () => {
		const env = scratchEnv();
		installFrom({ from: fixtureRelease("0.6.0"), env });
		const bad = fixtureRelease("0.6.1");
		writeFileSync(join(bad, "VERSION"), "../x\n");
		expect(() => installFrom({ from: bad, env })).toThrow(/VERSION/);
		expect(() => installFrom({ from: fixtureRelease("0.6.1", { versionOutput: "orrery 0.5.9" }), env })).toThrow(/says orrery 0\.5\.9, not orrery 0\.6\.1/);
		const app = join(env.ORRERY_HOME as string, "app");
		expect(readlinkSync(join(app, "current"))).toBe("0.6.0");
		expect(readdirSync(app).filter((n) => n.startsWith("."))).toEqual([]);
	});

	it("refuses a folder that is not a release", () => {
		expect(() => releaseVersion(tempDir("orrery-empty-"))).toThrow(/no VERSION file/);
	});

	it("says a binary that cannot run here is for another machine", () => {
		const env = scratchEnv();
		const other = fixtureRelease("0.6.1");
		writeFileSync(join(other, "bin", "orrery"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]), { mode: 0o755 });
		expect(() => installFrom({ from: other, env })).toThrow(/cannot run on this machine/);
	});

	it("removes a staging folder an interrupted install left", () => {
		const env = scratchEnv();
		const leftover = join(env.ORRERY_HOME as string, "app", ".staging-interrupted");
		mkdirSync(leftover, { recursive: true });
		writeFileSync(join(leftover, "VERSION"), "0.1.0\n");
		makeReadOnly(leftover);
		chmodSync(env.ORRERY_HOME as string, 0o755);
		installFrom({ from: fixtureRelease("0.6.0"), env });
		expect(existsSync(leftover)).toBe(false);
		expect(statSync(env.ORRERY_HOME as string).mode & 0o777).toBe(0o700); // an existing 0755 home is tightened
	});

	it("leaves current alone and removes the staging folder when the binary fails", () => {
		const env = scratchEnv();
		const first = installFrom({ from: fixtureRelease("0.6.0"), env });
		expect(() => installFrom({ from: fixtureRelease("0.6.1", { exit: 3 }), env })).toThrow(/--version failed: exit 3/);
		const app = join(env.ORRERY_HOME as string, "app");
		expect(readlinkSync(join(app, "current"))).toBe(first.version);
		expect(readdirSync(app).filter((n) => n.startsWith(".staging-"))).toEqual([]);
		expect(versionFolders(env)).toEqual([first.version]);
		expect(existsSync(join(app, ".install.lock"))).toBe(false);
	});

	it("rolls back to the previous version", () => {
		const { env, versions } = twoInstalls();
		expect(rollback(env)).toEqual({ from: versions[1], to: versions[0] });
		expect(currentOf(env)).toBe(versions[0]);
		expect(historyOf(env)).toEqual([versions[0], versions[1]]); // history is install order; a rollback adds nothing
	});

	it("walks back in install order: a second rollback goes to the version before, a third refuses", () => {
		const { env, versions } = twoInstalls();
		const third = installNext(env).version;
		expect(rollback(env)).toEqual({ from: third, to: versions[1] });
		expect(rollback(env)).toEqual({ from: versions[1], to: versions[0] });
		expect(currentOf(env)).toBe(versions[0]);
		expect(() => rollback(env)).toThrow(/no earlier version to roll back to/);
		expect(currentOf(env)).toBe(versions[0]);
	});

	it("does not cycle: after v1..v3 and two rollbacks, installing v2 again puts it last, and rollback walks the true order", () => {
		const { env, versions } = twoInstalls();
		const v3 = installNext(env).version;
		const [v1, v2] = versions;
		rollback(env);
		rollback(env);
		expect(currentOf(env)).toBe(v1);
		expect(installFrom({ from: fixtureRelease(v2), env }).version).toBe(v2); // its folder already exists
		expect(historyOf(env)).toEqual([v1, v3, v2]);
		expect(rollback(env)).toEqual({ from: v2, to: v3 });
		expect(rollback(env)).toEqual({ from: v3, to: v1 });
		expect(() => rollback(env)).toThrow(/no earlier version to roll back to/);
	});

	it("rolls back after a downgrade by install (A, B, A again) to B, then refuses", () => {
		const { env, versions } = twoInstalls();
		const [a, b] = versions;
		installFrom({ from: fixtureRelease(a), env });
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
		const result = installNext(env); // v6
		expect(versionFolders(env)).toContain(versions[2]);
		expect(versionFolders(env)).toContain(versions[4]);
		expect(result.removed).not.toContain(versions[2]);
	});

	it("makes an install after a rollback current and newest, and rolls back from it to the version before", () => {
		const { env, versions } = twoInstalls();
		rollback(env); // current = v1
		const next = installNext(env).version; // v3
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
		const { env, versions } = twoInstalls();
		rollback(env);
		expect(installFrom({ from: fixtureRelease(versions[1]), env })).toEqual({ version: versions[1], previous: versions[0], removed: [] });
		expect(currentOf(env)).toBe(versions[1]);
		const lines: string[] = [];
		expect(installFrom({ from: fixtureRelease(versions[1]), env, log: (l) => lines.push(l) })).toEqual({ version: versions[1], removed: [] });
		expect(lines.join("\n")).toMatch(/already installed/);
		expect(historyOf(env)).toEqual([versions[0], versions[1]]);
	});

	it("cleanup removes read-only version folders", () => {
		const env = scratchEnv();
		for (const v of ["0.6.0", "0.6.1", "0.6.2", "0.6.3", "0.6.4"]) installFrom({ from: fixtureRelease(v), env });
		expect(listVersions(env).map((v) => v.name)).toEqual(["0.6.2", "0.6.3", "0.6.4"]);
	});

	it("keeps a source-style version a live lane runs (0.5.0-<commit>, no VERSION file)", () => {
		const env = scratchEnv();
		const app = join(env.ORRERY_HOME as string, "app");
		mkdirSync(join(app, "0.5.0-9d7452f", "src", "cli"), { recursive: true });
		writeFileSync(join(app, "history"), "0.5.0-9d7452f\n");
		symlinkSync("0.5.0-9d7452f", join(app, "current"));
		writeLiveStatus(env, "Birch", "0.5.0-9d7452f");
		for (const v of ["0.6.0", "0.6.1", "0.6.2", "0.6.3"]) installFrom({ from: fixtureRelease(v), env });
		expect(existsSync(join(app, "0.5.0-9d7452f"))).toBe(true);
	});

	it("keeps the newest three versions, current, and any version a live lane runs", () => {
		const { env, versions } = fiveInstalls(); // v1..v5, current = v5
		writeLiveStatus(env, "Atlas", versions[0]); // a lane still running v1, its pid alive (process.pid)
		const result = installNext(env); // v6
		expect(versionFolders(env)).toEqual([versions[0], versions[3], versions[4], currentOf(env)].sort());
		expect(result.removed).toEqual([versions[2]]);
		expect(result.previous).toBe(versions[4]);
	});

	it("does not keep a version for a lane that closed or whose process is gone", () => {
		const { env, versions } = fiveInstalls();
		writeLiveStatus(env, "Atlas", versions[0], deadPid());
		writeLiveStatus(env, "Bea", versions[2], process.pid, false);
		const { version } = installNext(env);
		expect(versionFolders(env)).toEqual([versions[3], versions[4], version].sort());
	});

	it("keeps every version when a lane's status.json cannot be read, and when it lacks a pid or version", () => {
		for (const bad of ["{not json", JSON.stringify({ open: true, version: "x" }), JSON.stringify({ pid: process.pid, open: true }), JSON.stringify({ pid: process.pid, version: "x", open: "yes" })]) {
			const { env } = fiveInstalls();
			const before = versionFolders(env).length;
			writeFileSync(join(env.ORRERY_HOME as string, "data", "lanes", "Atlas", "status.json"), bad);
			const lines: string[] = [];
			const result = installNext(env, { log: (l) => lines.push(l) });
			expect(result.removed, bad).toEqual([]);
			expect(versionFolders(env).length, bad).toBe(before + 1);
			expect(lines.join("\n"), bad).toMatch(/Kept every older version/);
		}
	});

	it("does not let a status without a version block GC when the lane is closed or its process is gone", () => {
		for (const status of [{ pid: process.pid, open: false }, { pid: deadPid() }]) {
			const { env, versions } = fiveInstalls();
			writeFileSync(join(env.ORRERY_HOME as string, "data", "lanes", "Atlas", "status.json"), JSON.stringify(status));
			const { removed } = installNext(env);
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
			expect(installNext(env, { log: (l) => lines.push(l) }).removed, bad).toEqual([]);
			expect(lines.join("\n"), bad).toMatch(reason);
			expect(lines.join("\n"), bad).not.toMatch(/config.*could not be read/);
		}
	});

	it("reads only pid, open and version from a status: {pid, version} alone protects its version", () => {
		const { env, versions } = fiveInstalls();
		writeFileSync(join(env.ORRERY_HOME as string, "data", "lanes", "Atlas", "status.json"), JSON.stringify({ pid: process.pid, version: versions[0] }));
		installNext(env);
		expect(versionFolders(env)).toContain(versions[0]);
		expect(versionFolders(env)).not.toContain(versions[2]);
	});

	it("refuses a second install while one holds the lock", () => {
		const env = scratchEnv();
		mkdirSync(join(env.ORRERY_HOME as string, "app"), { recursive: true });
		const release = holdInstallLock(env); // exported for tests from install.ts
		try {
			expect(() => installFrom({ from: fixtureRelease("0.6.0"), env })).toThrow(/another install is running/);
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

	it("a SIGINT while the lock is held releases it", async () => {
		const env = scratchEnv();
		mkdirSync(join(env.ORRERY_HOME as string, "app"), { recursive: true });
		const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "-e", `import(${JSON.stringify(new URL("../../src/install/install.ts", import.meta.url).href)}).then((m) => { m.holdInstallLock(process.env); console.log("held"); setInterval(() => {}, 1000); })`], { env, stdio: ["ignore", "pipe", "inherit"] });
		await new Promise<void>((done) => child.stdout.once("data", () => done()));
		child.kill("SIGINT");
		const code = await new Promise<number | null>((done) => child.once("exit", done));
		expect(code).toBe(130);
		expect(existsSync(join(env.ORRERY_HOME as string, "app", ".install.lock"))).toBe(false);
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

	it("--from installs a release folder and says so", () => {
		const env = scratchEnv();
		const out = cli(env, "install", "--from", fixtureRelease("0.6.0"));
		expect(out.status, out.stderr).toBe(0);
		expect(out.stdout).toContain("Installed 0.6.0.");
		expect(currentOf(env)).toBe("0.6.0");
	});

	it("tells a plain install to use --from", () => {
		const plain = cli(scratchEnv(), "install");
		expect(plain.status).toBe(1);
		expect(plain.stderr).toContain("--from");
	});

	it("answers --help, which lists install --from", () => {
		const help = cli(scratchEnv(), "--help");
		expect(help.status, help.stderr).toBe(0);
		expect(help.stdout).toContain("install --from DIR");
		expect(help.stdout).toContain("install --rollback | --list");
	});
});
