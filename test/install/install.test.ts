import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { binaryTarget, holdInstallLock, installFrom, listVersions, makeReadOnly, releaseVersion, removeVersion, rollback } from "../../src/install/install.ts";
import { cleanupScratch, fixtureRelease, scratchPath } from "./support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) removeVersion(d);
	cleanupScratch();
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

/** v1..v5, current = v5. Agent Atlas starts on v1 and keeps running through the later installs. */
function fiveInstalls() {
	const { env, version } = freshInstall();
	const versions = [version];
	writeLiveStatus(env, "Atlas", version);
	while (versions.length < 5) versions.push(installNext(env).version);
	return { env, versions };
}

/** An agent in the home's config whose status.json says it runs `version` as `pid` (default: this process, alive). */
function writeLiveStatus(env: NodeJS.ProcessEnv, agent: string, version: string, pid = process.pid, open = true): void {
	const home = env.ORRERY_HOME as string;
	const config = join(home, "config.toml");
	const text = existsSync(config) ? readFileSync(config, "utf8") : `data_dir = ${JSON.stringify(join(home, "data"))}\n`;
	if (!text.includes(`[agents.${agent}]`)) writeFileSync(config, `${text}[agents.${agent}]\nfolder = ${JSON.stringify(join(home, "ws", agent))}\ncompactor_model = "local/m"\n`);
	const dir = join(home, "data", "agents", agent);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "status.json"),
		JSON.stringify({
			agent, pid, open, busy: false, model: "pi", thinking: "pi",
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

	it("refuses a release built for another os or arch, by its header, before running it", () => {
		const env = scratchEnv();
		const arch = process.arch === "arm64" ? "arm64" : "x64";
		const otherArch = arch === "x64" ? "arm64" : "x64";
		const elf = (machine: number) => {
			const head = Buffer.alloc(20);
			head.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
			head.writeUInt16LE(machine, 18);
			return head;
		};
		const macho = (cpu: number) => {
			const head = Buffer.alloc(32);
			head.writeUInt32LE(0xfeedfacf, 0);
			head.writeUInt32LE(cpu, 4);
			return head;
		};
		const cases: [Buffer, string][] = [
			[elf(otherArch === "x64" ? 62 : 183), `linux-${otherArch}`],
			[macho(otherArch === "x64" ? 0x01000007 : 0x0100000c), `darwin-${otherArch}`],
		];
		if (process.platform === "linux") cases.push([macho(arch === "x64" ? 0x01000007 : 0x0100000c), `darwin-${arch}`]);
		else cases.push([elf(arch === "x64" ? 62 : 183), `linux-${arch}`]);
		for (const [header, built] of cases) {
			const other = fixtureRelease("0.6.1");
			writeFileSync(join(other, "bin", "orrery"), header, { mode: 0o755 });
			expect(() => installFrom({ from: other, env })).toThrow(`this release is for ${built}, not this machine (${process.platform}-${process.arch}); download the archive for it`);
		}
		expect(existsSync(join(env.ORRERY_HOME as string, "app", "current"))).toBe(false);
	});

	it("reads a header only for a real ELF or Mach-O file", () => {
		const file = join(tempDir("orrery-bin-"), "x");
		writeFileSync(file, "#!/bin/sh\n");
		expect(binaryTarget(file)).toBeUndefined();
		writeFileSync(file, "");
		expect(binaryTarget(file)).toBeUndefined();
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

	it("removes a .removing-* folder a cleanup cut short left", () => {
		const env = scratchEnv();
		const leftover = join(env.ORRERY_HOME as string, "app", ".removing-interrupted");
		mkdirSync(join(leftover, "bin"), { recursive: true });
		writeFileSync(join(leftover, "VERSION"), "0.5.9\n");
		makeReadOnly(leftover);
		installFrom({ from: fixtureRelease("0.6.0"), env });
		expect(existsSync(leftover)).toBe(false);
	});

	it("a version folder that is not whole is skipped by rollback and staged again by install", () => {
		const { env, versions } = twoInstalls(); // 0.6.0, 0.6.1
		const broken = join(env.ORRERY_HOME as string, "app", versions[0] as string);
		chmodSync(join(broken, "bin"), 0o755);
		rmSync(join(broken, "bin", "orrery")); // as a removal cut short leaves it
		installNext(env); // 0.6.2
		expect(rollback(env)).toEqual({ from: "0.6.2", to: versions[1] });
		expect(() => rollback(env)).toThrow(/no earlier version to roll back to/);
		expect(currentOf(env)).toBe(versions[1]);
		const lines: string[] = [];
		installFrom({ from: fixtureRelease(versions[0] as string), env, log: (line) => lines.push(line) });
		expect(lines).toContain(`Installing ${versions[0]}...`);
		expect(currentOf(env)).toBe(versions[0]);
		expect(existsSync(join(broken, "bin", "orrery"))).toBe(true);
		expect(readdirSync(join(env.ORRERY_HOME as string, "app")).filter((n) => n.startsWith("."))).toEqual([]);
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

	it("keeps a damaged version folder and current as they were when the replacement copy fails its check", () => {
		const env = scratchEnv();
		installFrom({ from: fixtureRelease("0.6.0"), env });
		const app = join(env.ORRERY_HOME as string, "app");
		chmodSync(join(app, "0.6.0", "bin"), 0o755);
		rmSync(join(app, "0.6.0", "bin", "orrery")); // damaged: not whole
		const before = readdirSync(join(app, "0.6.0"));
		expect(() => installFrom({ from: fixtureRelease("0.6.0", { exit: 3 }), env })).toThrow(/--version failed: exit 3/);
		expect(readlinkSync(join(app, "current"))).toBe("0.6.0");
		expect(readdirSync(join(app, "0.6.0"))).toEqual(before);
		expect(readdirSync(app).filter((n) => n.startsWith("."))).toEqual([]);
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
		writeFileSync(join(env.ORRERY_HOME as string, "data", "agents", "Atlas", "status.json"), JSON.stringify({ pid: process.pid, version: versions[0], open: false }));
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

	it("keeps a source-style version a live agent runs (0.5.0-<commit>, no VERSION file)", () => {
		const env = scratchEnv();
		const app = join(env.ORRERY_HOME as string, "app");
		mkdirSync(join(app, "0.5.0-9d7452f", "src", "cli"), { recursive: true });
		writeFileSync(join(app, "history"), "0.5.0-9d7452f\n");
		symlinkSync("0.5.0-9d7452f", join(app, "current"));
		writeLiveStatus(env, "Birch", "0.5.0-9d7452f");
		for (const v of ["0.6.0", "0.6.1", "0.6.2", "0.6.3"]) installFrom({ from: fixtureRelease(v), env });
		expect(existsSync(join(app, "0.5.0-9d7452f"))).toBe(true);
	});

	it("keeps the newest three versions, current, and any version a live agent runs", () => {
		const { env, versions } = fiveInstalls(); // v1..v5, current = v5
		writeLiveStatus(env, "Atlas", versions[0]); // an agent still running v1, its pid alive (process.pid)
		const result = installNext(env); // v6
		expect(versionFolders(env)).toEqual([versions[0], versions[3], versions[4], currentOf(env)].sort());
		expect(result.removed).toEqual([versions[2]]);
		expect(result.previous).toBe(versions[4]);
	});

	it("does not keep a version for an agent that closed or whose process is gone", () => {
		const { env, versions } = fiveInstalls();
		writeLiveStatus(env, "Atlas", versions[0], deadPid());
		writeLiveStatus(env, "Bea", versions[2], process.pid, false);
		const { version } = installNext(env);
		expect(versionFolders(env)).toEqual([versions[3], versions[4], version].sort());
	});

	it("keeps every version when an agent's status.json cannot be read, and when it lacks a pid or version", () => {
		for (const bad of ["{not json", JSON.stringify({ open: true, version: "x" }), JSON.stringify({ pid: process.pid, open: true }), JSON.stringify({ pid: process.pid, version: "x", open: "yes" })]) {
			const { env } = fiveInstalls();
			const before = versionFolders(env).length;
			writeFileSync(join(env.ORRERY_HOME as string, "data", "agents", "Atlas", "status.json"), bad);
			const lines: string[] = [];
			const result = installNext(env, { log: (l) => lines.push(l) });
			expect(result.removed, bad).toEqual([]);
			expect(versionFolders(env).length, bad).toBe(before + 1);
			expect(lines.join("\n"), bad).toMatch(/Kept every older version/);
		}
	});

	it("does not let a status without a version block GC when the agent is closed or its process is gone", () => {
		for (const status of [{ pid: process.pid, open: false }, { pid: deadPid() }]) {
			const { env, versions } = fiveInstalls();
			writeFileSync(join(env.ORRERY_HOME as string, "data", "agents", "Atlas", "status.json"), JSON.stringify(status));
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
			writeFileSync(join(env.ORRERY_HOME as string, "data", "agents", "Atlas", "status.json"), bad);
			const lines: string[] = [];
			expect(installNext(env, { log: (l) => lines.push(l) }).removed, bad).toEqual([]);
			expect(lines.join("\n"), bad).toMatch(reason);
			expect(lines.join("\n"), bad).not.toMatch(/config.*could not be read/);
		}
	});

	it("reads only pid, open and version from a status: {pid, version} alone protects its version", () => {
		const { env, versions } = fiveInstalls();
		writeFileSync(join(env.ORRERY_HOME as string, "data", "agents", "Atlas", "status.json"), JSON.stringify({ pid: process.pid, version: versions[0] }));
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

	it("takes over a lock left by a dead process, and refuses one held by a live process or an unreadable one", () => {
		const env = scratchEnv();
		const app = join(env.ORRERY_HOME as string, "app");
		mkdirSync(app, { recursive: true });
		const lock = join(app, ".install.lock");
		writeFileSync(lock, `${deadPid()}\n`);
		expect(installFrom({ from: fixtureRelease("0.6.0"), env }).version).toBe("0.6.0");
		expect(existsSync(lock)).toBe(false);
		for (const text of [`${process.pid}\n`, "", "not a pid\n"]) {
			writeFileSync(lock, text);
			expect(() => installFrom({ from: fixtureRelease("0.6.1"), env }), JSON.stringify(text)).toThrow(/another install is running/);
			expect(readFileSync(lock, "utf8")).toBe(text);
		}
		expect(currentOf(env)).toBe("0.6.0");
	});

	// Timing a kill in the middle of a real copy is flaky, so the pieces are tested: a child that holds the lock with a
	// staging folder, as an install killed partway leaves them, is killed with SIGINT (the default abort), and the next
	// install takes over the lock, removes the staging folder and switches only itself.
	it("a SIGINT-killed install leaves current unchanged, and the next install cleans up after it", async () => {
		const { env } = freshInstall();
		const app = join(env.ORRERY_HOME as string, "app");
		const script = `import(${JSON.stringify(new URL("../../src/install/install.ts", import.meta.url).href)}).then((m) => { m.holdInstallLock(process.env); const fs = require("node:fs"); fs.mkdirSync(process.env.STAGING + "/bin", { recursive: true }); fs.writeFileSync(process.env.STAGING + "/bin/orrery", "x"); console.log("held"); setInterval(() => {}, 1000); })`;
		const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "-e", script], { env: { ...env, STAGING: join(app, ".staging-killed") }, stdio: ["ignore", "pipe", "inherit"] });
		try {
			await new Promise<void>((done) => child.stdout.once("data", () => done()));
			child.kill("SIGINT");
			const signal = await new Promise<string | null>((done) => child.once("exit", (_code, sig) => done(sig)));
			expect(signal).toBe("SIGINT");
		} finally {
			child.kill("SIGKILL");
		}
		expect(currentOf(env)).toBe("0.6.0");
		expect(existsSync(join(app, ".install.lock"))).toBe(true);
		installFrom({ from: fixtureRelease("0.6.1"), env });
		expect(currentOf(env)).toBe("0.6.1");
		expect(readdirSync(app).filter((n) => n.startsWith(".staging-"))).toEqual([]);
		expect(existsSync(join(app, ".install.lock"))).toBe(false);
	});

	it("lists the versions, which one is current, and which live agents run each", () => {
		const { env, versions } = twoInstalls();
		writeLiveStatus(env, "Atlas", versions[0]);
		writeLiveStatus(env, "Bea", versions[1], deadPid());
		expect(listVersions(env)).toEqual([
			{ name: versions[0], current: false, agents: ["Atlas"] },
			{ name: versions[1], current: true, agents: [] },
		]);
		expect(listVersions(scratchEnv())).toEqual([]);
	});
});

describe("orrery install", () => {
	/**
	 * Setup runs after install and rollback, so the command gets only the scratch home and a PATH with no real pi, OMP or
	 * Claude Code (and no PI_CODING_AGENT_DIR from the environment running the tests); `bin` puts fakes first.
	 */
	const runCli = (env: NodeJS.ProcessEnv, args: string[], bin?: string) =>
		spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", MAIN, ...args], { env: { HOME: env.HOME, ORRERY_HOME: env.ORRERY_HOME, PATH: [...(bin === undefined ? [] : [bin]), scratchPath()].join(":") }, encoding: "utf8" });
	const cli = (env: NodeJS.ProcessEnv, ...args: string[]) => runCli(env, args);
	const commandLink = (env: NodeJS.ProcessEnv) => readlinkSync(join(env.HOME as string, ".local", "bin", "orrery"));

	it("--list and --rollback work from the command, without a config", () => {
		const { env, versions } = twoInstalls();
		const list = cli(env, "install", "--list");
		expect(list.status, list.stderr).toBe(0);
		expect(list.stdout).toMatch(new RegExp(`^  ${versions[0]}$`, "m"));
		expect(list.stdout).toMatch(new RegExp(`^\\* ${versions[1]}  \\(current\\)$`, "m"));
		const back = cli(env, "install", "--rollback");
		expect(back.status, back.stderr).toBe(0);
		expect(back.stdout).toContain(`from ${versions[1]} to ${versions[0]}`);
		expect(back.stdout).toMatch(/^orrery command: /m);
		expect(currentOf(env)).toBe(versions[0]);
	});

	it("--from installs a release folder, wires it, and says what to do next", () => {
		const env = scratchEnv();
		const out = cli(env, "install", "--from", fixtureRelease("0.6.0"));
		expect(out.status, out.stderr).toBe(0);
		expect(out.stdout).toContain("Installed 0.6.0.");
		expect(currentOf(env)).toBe("0.6.0");
		expect(commandLink(env)).toBe(join(env.ORRERY_HOME as string, "app", "current", "bin", "orrery"));
		expect(out.stdout).toMatch(/~\/\.local\/bin is not on your PATH/);
		expect(out.stdout.trim().split("\n").at(-1)).toBe("Run ~/.local/bin/orrery (or open a new terminal after adding it to PATH) to add your first agent.");
		const onPath = scratchEnv();
		const plain = runCli(onPath, ["install", "--from", fixtureRelease("0.6.0")], join(onPath.HOME as string, ".local", "bin"));
		expect(plain.status, plain.stderr).toBe(0);
		expect(plain.stdout.trim().split("\n").at(-1)).toBe("Run orrery to add your first agent.");
		writeFileSync(join(env.ORRERY_HOME as string, "config.toml"), "");
		const again = cli(env, "install", "--from", fixtureRelease("0.6.0"));
		expect(again.status, again.stderr).toBe(0);
		expect(again.stdout).toContain("0.6.0 is already installed.");
		expect(again.stdout).not.toContain("to add your first agent.");
	});

	it("--from over another version (orrery update hands over to it), and --rollback, say, last, to restart open agent sessions", () => {
		const env = scratchEnv();
		const restart = "Restart open agent sessions now: sessions left open across the update aren't recorded until they restart.";
		const first = cli(env, "install", "--from", fixtureRelease("0.6.0"));
		expect(first.status, first.stderr).toBe(0);
		expect(first.stdout).not.toContain(restart);
		writeFileSync(join(env.ORRERY_HOME as string, "config.toml"), "");
		const update = cli(env, "install", "--from", fixtureRelease("0.6.1"));
		expect(update.status, update.stderr).toBe(0);
		expect(update.stdout.trim().split("\n").at(-1)).toBe(restart);
		// The same version again changes nothing that runs.
		const same = cli(env, "install", "--from", fixtureRelease("0.6.1"));
		expect(same.status, same.stderr).toBe(0);
		expect(same.stdout).not.toContain(restart);
		// Back to 0.6.0: an open session's hooks are the older version's from here on, its recorder the newer one's.
		const back = cli(env, "install", "--rollback");
		expect(back.status, back.stderr).toBe(0);
		expect(back.stdout).toMatch(/^Switched back from 0\.6\.1 to 0\.6\.0\.$/m);
		expect(back.stdout.trim().split("\n").at(-1)).toBe(restart);
	});

	it("says how to add the first agent even when setup left something", () => {
		const env = scratchEnv();
		const bin = mkdtempSync(join(tmpdir(), "orrery-bin-"));
		dirs.push(bin);
		writeFileSync(join(bin, "pi"), '#!/bin/sh\necho "pi 1.2.0"\n', { mode: 0o755 });
		// A folder where pi's extension file belongs cannot be checked: setup lists it and exits 1, asking nothing.
		mkdirSync(join(env.HOME as string, ".pi", "agent", "extensions", "orrery.ts"), { recursive: true });
		const out = runCli(env, ["install", "--from", fixtureRelease("0.6.0")], bin);
		expect(out.status).toBe(1);
		expect(out.stdout).toContain("check pi by hand");
		expect(out.stdout.trim().split("\n").at(-1)).toMatch(/to add your first agent\.$/);
	});

	it("install and rollback rewire between a source-style 0.5.0 and a binary 0.6.0, both ways", () => {
		const env = scratchEnv();
		const home = env.ORRERY_HOME as string;
		const bin = mkdtempSync(join(tmpdir(), "orrery-bin-"));
		dirs.push(bin);
		writeFileSync(join(bin, "pi"), '#!/bin/sh\necho "pi 1.2.0"\n', { mode: 0o755 });
		const old = join(home, "app", "0.5.0-9d7452f");
		for (const entry of ["src/cli/main.ts", "src/pi/index.ts", "src/omp/index.ts"]) {
			mkdirSync(join(old, entry, ".."), { recursive: true });
			writeFileSync(join(old, entry), "\n");
		}
		writeFileSync(join(home, "app", "history"), "0.5.0-9d7452f\n");
		symlinkSync("0.5.0-9d7452f", join(home, "app", "current"));
		const current = join(home, "app", "current");
		const piFile = join(env.HOME as string, ".pi", "agent", "extensions", "orrery.ts");
		// pi is wired to the 0.5.0 install already: moving Orrery's own wiring asks nothing.
		mkdirSync(join(piFile, ".."), { recursive: true });
		writeFileSync(piFile, `export { default } from ${JSON.stringify(join(current, "src", "pi", "index.ts"))};\n`);
		const up = runCli(env, ["install", "--from", fixtureRelease("0.6.0")], bin);
		expect(up.status, up.stdout + up.stderr).toBe(0);
		expect(commandLink(env)).toBe(join(current, "bin", "orrery"));
		expect(readFileSync(piFile, "utf8")).toBe(`export { default } from ${JSON.stringify(join(current, "extensions", "pi.js"))};\n`);
		const back = runCli(env, ["install", "--rollback"], bin);
		expect(back.status, back.stdout + back.stderr).toBe(0);
		expect(currentOf(env)).toBe("0.5.0-9d7452f");
		expect(commandLink(env)).toBe(join(current, "src", "cli", "main.ts"));
		expect(readFileSync(piFile, "utf8")).toBe(`export { default } from ${JSON.stringify(join(current, "src", "pi", "index.ts"))};\n`);
	});

	it("setup refuses before anything is installed", () => {
		const out = cli(scratchEnv(), "setup");
		expect(out.status).toBe(1);
		expect(out.stderr).toContain("Orrery is not installed yet");
	});

	it("refuses --from with --rollback or --list", () => {
		const env = scratchEnv();
		for (const flag of ["--rollback", "--list"]) {
			const out = cli(env, "install", "--from", fixtureRelease("0.6.0"), flag);
			expect(out.status).toBe(1);
			expect(out.stderr).toContain("one of --from DIR, --rollback or --list");
		}
		expect(existsSync(join(env.ORRERY_HOME as string, "app", "current"))).toBe(false);
	});

	it("tells a plain install to use --from", () => {
		const plain = cli(scratchEnv(), "install");
		expect(plain.status).toBe(1);
		expect(plain.stderr).toContain("--from");
	});

	it("answers install --help and help all, which list install --from", () => {
		const install = cli(scratchEnv(), "install", "--help");
		expect(install.status, install.stderr).toBe(0);
		expect(install.stdout).toContain("install --from DIR");
		expect(install.stdout).toContain("install --rollback [--yes] | --list");
		const help = cli(scratchEnv(), "help", "all");
		expect(help.status, help.stderr).toBe(0);
		expect(help.stdout).toContain("install --from DIR");
		expect(help.stdout).toContain("setup [--yes]");
		expect(help.stdout).toContain("uninstall [--purge]");
		expect(help.stdout).not.toContain("npm run install-local");
	});
});
