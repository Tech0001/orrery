import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { statusCommand } from "../../src/cli/commands.ts";
import { parseConfig } from "../../src/lane/config.ts";
import { runningRoot, versionLine } from "../../src/lane/running.ts";
import { localIso, MemoryStore } from "../../src/memory/index.ts";
import { laneConfigToml, tempDir } from "../lane/support.ts";

const MAIN = new URL("../../src/cli/main.ts", import.meta.url).pathname;
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function runCli(args: string[]): string {
	return execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", MAIN, ...args], { encoding: "utf8" });
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

	it("prints its version: an install's version folder, or a checkout's package.json version", () => {
		const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
		const line = `orrery ${version} (checkout ${runningRoot()})\n`;
		expect(runCli(["--version"])).toBe(line);
		expect(runCli(["-v"])).toBe(line);
		expect(runCli(["version"])).toBe(line);
		expect(versionLine("0.5.0-ca3c41d")).toBe("orrery 0.5.0-ca3c41d\n");
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
		const bad = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", MAIN, "backup", "--config", configPath, "--keep", "0"], { encoding: "utf8" });
		expect(bad.status).toBe(1);
		expect(bad.stderr).toContain("--keep");
	});

	it("rejects a bad --days and survives a malformed status.json", () => {
		const dir = tempDir("orrery-main-");
		dirs.push(dir);
		const configPath = join(dir, "config.toml");
		writeFileSync(configPath, laneConfigToml({ dataDir: join(dir, "data"), workspace: join(dir, "ws") }));
		for (const days of ["0", "x", "1.5"]) {
			const bad = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", MAIN, "usage", "--config", configPath, "--days", days], { encoding: "utf8" });
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
		const run = (args: string[]) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", MAIN, ...args, "--config", configPath], { encoding: "utf8" });
		expect(run(["restore", "Test"]).stderr).toContain("--from");
		const missing = run(["restore", "Test", "--from", "2026-01-01"]);
		expect(missing.status).toBe(1);
		expect(missing.stderr).toContain("No backup of Test");
	});
});
