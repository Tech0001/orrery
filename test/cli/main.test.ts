import { execFileSync, type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { statusCommand } from "../../src/cli/commands.ts";
import { parseConfig } from "../../src/lane/config.ts";
import { runningRoot, versionLine, versionNumber } from "../../src/lane/running.ts";
import { localIso, MemoryStore } from "../../src/memory/index.ts";
import { cliCommand } from "../claude/support.ts";
import { laneConfigToml, tempDir } from "../lane/support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The CLI's stdout; a failure throws. */
function runCli(args: string[]): string {
	const c = cliCommand(args);
	return execFileSync(c.cmd, c.args, { encoding: "utf8" });
}

/** The CLI's exit status and both outputs. */
function spawnCli(args: string[]): SpawnSyncReturns<string> {
	const c = cliCommand(args);
	return spawnSync(c.cmd, c.args, { encoding: "utf8" });
}

describe("orrery", () => {
	it("prints status and usage for configured lanes without opening pi storage", () => {
		const dir = tempDir("orrery-main-");
		dirs.push(dir);
		const dataDir = join(dir, "data");
		const configPath = join(dir, "config.toml");
		writeFileSync(configPath, laneConfigToml({ dataDir, workspace: join(dir, "ws") }));
		const laneDir = join(dataDir, "lanes", "Test");
		mkdirSync(laneDir, { recursive: true });
		const store = MemoryStore.open(join(laneDir, "memory.sqlite"));
		store.appendBatch([{ kind: "user", text: "hello" }], {}, [
			{ at: "2026-10-05T10:00:00.000-05:00", role: "agent", model: "openai/gpt-6.1-sol", input: 100, cacheRead: 50, cacheWrite: 0, output: 20, ok: true },
			{ at: "2026-10-05T10:01:00.000-05:00", role: "compactor", model: "omlx/Bonsai", input: 30, cacheRead: 0, cacheWrite: 0, output: 5, ok: true },
		]);
		store.close();
		const status = runCli(["status", "--config", configPath]);
		expect(status).toContain("Test");
		expect(status).toContain("closed");
		expect(status).toContain("1 messages");
		const usage = runCli(["usage", "--config", configPath, "--days", "36500"]);
		expect(usage).toContain("openai/gpt-6.1-sol");
		expect(usage).toMatch(/agent\s+openai\/gpt-6\.1-sol\s+1\s+100\s+50\s+0\s+20/);
		expect(usage).toMatch(/compactor\s+omlx\/Bonsai\s+1\s+30/);
		expect(runCli([])).toContain("Usage: orrery");
	});

	// A fresh install has no config anywhere: say where Orrery looks, not a raw ENOENT for the server path.
	it.skipIf(existsSync("/etc/orrery/config.toml"))("status without any config says where Orrery looks and exits non-zero; an empty config lists no lanes", () => {
		const home = tempDir("orrery-main-");
		dirs.push(home);
		const c = cliCommand(["status"]);
		const env = { ...process.env, HOME: home, ORRERY_CONFIG: "", ORRERY_HOME: "" };
		const none = spawnSync(c.cmd, c.args, { encoding: "utf8", env });
		expect(none.status).not.toBe(0);
		expect(none.stderr).toContain(`no Orrery config at ${join(home, ".orrery", "config.toml")}; run orrery to set one up`);
		expect(none.stderr).not.toContain("/etc/orrery");
		mkdirSync(join(home, ".orrery"));
		writeFileSync(join(home, ".orrery", "config.toml"), "");
		const empty = spawnSync(c.cmd, c.args, { encoding: "utf8", env });
		expect({ status: empty.status, stdout: empty.stdout }).toEqual({ status: 0, stdout: "No lanes configured.\n" });
	});

	it("prints its version: a release's VERSION, or a checkout's package.json version and path", () => {
		const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
		// A built binary (ORRERY_TEST_BIN) is a release's bin/orrery: it prints that release's VERSION, not this checkout.
		const bin = process.env.ORRERY_TEST_BIN;
		const line = bin ? `orrery ${readFileSync(join(dirname(bin), "..", "VERSION"), "utf8").trim()}\n` : `orrery ${version} (checkout ${runningRoot()})\n`;
		expect(runCli(["--version"])).toBe(line);
		expect(runCli(["-v"])).toBe(line);
		expect(runCli(["version"])).toBe(line);
		expect(versionLine("0.5.0-ca3c41d")).toBe("orrery 0.5.0-ca3c41d\n");
		const release = tempDir("orrery-main-");
		dirs.push(release);
		writeFileSync(join(release, "VERSION"), "0.6.0\n");
		expect(versionNumber(release)).toBe("0.6.0");
		expect(versionNumber()).toBe(version);
	});

	it("strips control sequences from status.json text", () => {
		const dir = tempDir("orrery-main-");
		dirs.push(dir);
		const config = parseConfig(laneConfigToml({ dataDir: join(dir, "data"), workspace: join(dir, "ws") }), dir);
		const laneDir = join(dir, "data", "lanes", "Test");
		mkdirSync(laneDir, { recursive: true });
		writeFileSync(
			join(laneDir, "status.json"),
			JSON.stringify({
				lane: "Test", pid: process.pid, open: true, busy: false, model: "pi", thinking: "off",
				compactor: { stopped: false, failing: 1, model: "m\x1b]0;evil\x07", thinking: "off", source: "config" },
				trouble: { state: "failing", plain: "boom\x1b]52;c;ZXZpbA==\x07" }, lastError: null, updatedAt: localIso(),
			}),
		);
		const out = statusCommand(config);
		expect(out).toContain("failing: boom");
		expect(out).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
	});

	it("prints status as JSON with --json", () => {
		const dir = tempDir("orrery-main-");
		dirs.push(dir);
		const config = parseConfig(laneConfigToml({ dataDir: join(dir, "data"), workspace: join(dir, "ws") }), dir);
		const parsed = JSON.parse(statusCommand(config, undefined, { json: true }));
		expect(parsed.lanes[0].name).toBe("Test");
		expect(parsed.lanes[0].lastBackup).toBeUndefined();
		mkdirSync(join(dir, "data", "backups", "2026-10-07", "Test"), { recursive: true });
		expect(JSON.parse(statusCommand(config, undefined, { json: true })).lanes[0].lastBackup).toBe("2026-10-07");
	});

	it("backs up every lane with memory, and rejects a bad --keep", () => {
		const dir = tempDir("orrery-main-");
		dirs.push(dir);
		const dataDir = join(dir, "data");
		const configPath = join(dir, "config.toml");
		writeFileSync(configPath, laneConfigToml({ dataDir, workspace: join(dir, "ws") }));
		const store = MemoryStore.open(join(dataDir, "lanes", "Test", "memory.sqlite"));
		store.appendBatch([{ kind: "user", text: "hello" }]);
		store.close();
		const out = runCli(["backup", "--config", configPath, "--keep", "3"]);
		expect(out).toMatch(/Test: 1 messages, 0 summaries -> .*backups\/\d{4}-\d{2}-\d{2}\/Test/);
		expect(existsSync(join(dataDir, "backups"))).toBe(true);
		const bad = spawnCli(["backup", "--config", configPath, "--keep", "0"]);
		expect(bad.status).toBe(1);
		expect(bad.stderr).toContain("--keep");
	});

	it("rejects a bad --days and survives a malformed status.json", () => {
		const dir = tempDir("orrery-main-");
		dirs.push(dir);
		const configPath = join(dir, "config.toml");
		writeFileSync(configPath, laneConfigToml({ dataDir: join(dir, "data"), workspace: join(dir, "ws") }));
		for (const days of ["0", "x", "1.5"]) {
			const bad = spawnCli(["usage", "--config", configPath, "--days", days]);
			expect(bad.status, days).toBe(1);
			expect(bad.stderr).toContain("--days");
		}
		const config = parseConfig(readFileSync(configPath, "utf8"), dir);
		const laneDir = config.lanes.get("Test")!.dir;
		mkdirSync(laneDir, { recursive: true });
		writeFileSync(join(laneDir, "status.json"), JSON.stringify({ pid: "x", busy: "yes" }));
		expect(statusCommand(config)).toMatch(/Test\s+closed/);
		writeFileSync(join(laneDir, "status.json"), JSON.stringify({ pid: process.pid, busy: false, model: 7 }));
		expect(statusCommand(config)).toMatch(/Test\s+closed/);
		// A live pid and a fresh time, but no compactor model, or a trouble without its words: still no crash.
		const live = { lane: "Test", pid: process.pid, open: true, busy: false, model: "pi", thinking: "pi", lastError: null, updatedAt: localIso() };
		writeFileSync(join(laneDir, "status.json"), JSON.stringify({ ...live, compactor: { stopped: false, failing: 0, thinking: "low", source: "config" }, trouble: null }));
		expect(statusCommand(config)).toMatch(/Test\s+closed/);
		writeFileSync(join(laneDir, "status.json"), JSON.stringify({ ...live, compactor: { stopped: false, failing: 1, model: "a/b", thinking: "low", source: "config" }, trouble: { state: "failing" } }));
		expect(statusCommand(config)).toMatch(/Test\s+closed/);
		expect(JSON.parse(statusCommand(config, undefined, { json: true })).lanes[0].state).toBe("closed");
	});

	it("restore needs --from and names the missing backup", () => {
		const dir = tempDir("orrery-main-");
		dirs.push(dir);
		const configPath = join(dir, "config.toml");
		writeFileSync(configPath, laneConfigToml({ dataDir: join(dir, "data"), workspace: join(dir, "ws") }));
		const run = (args: string[]) => spawnCli([...args, "--config", configPath]);
		expect(run(["restore", "Test"]).stderr).toContain("--from");
		const missing = run(["restore", "Test", "--from", "2026-01-01"]);
		expect(missing.status).toBe(1);
		expect(missing.stderr).toContain("No backup of Test");
	});
});
