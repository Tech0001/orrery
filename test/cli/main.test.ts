import { execFileSync, type SpawnSyncReturns, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addUnconfirmed } from "../../src/claude/transcript.ts";
import { statusCommand } from "../../src/cli/commands.ts";
import { parseConfig } from "../../src/agent/config.ts";
import { runningRoot, versionLine, versionNumber } from "../../src/agent/running.ts";
import { forgetSession, recordSession } from "../../src/agent/sessions.ts";
import { localIso, MemoryStore } from "../../src/memory/index.ts";
import { cliCommand } from "../claude/support.ts";
import { agentConfigToml, tempDir } from "../agent/support.ts";

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
	it("prints status and usage for configured agents without opening pi storage", () => {
		const dir = tempDir("orrery-main-");
		dirs.push(dir);
		const dataDir = join(dir, "data");
		const configPath = join(dir, "config.toml");
		writeFileSync(configPath, agentConfigToml({ dataDir, folder: join(dir, "ws") }));
		const agentDir = join(dataDir, "agents", "Test");
		mkdirSync(agentDir, { recursive: true });
		const store = MemoryStore.open(join(agentDir, "memory.sqlite"));
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
		expect(runCli([])).toContain("orrery help all");
	});

	// A fresh install has no config anywhere: say where Orrery looks, not a raw ENOENT for the server path.
	it.skipIf(existsSync("/etc/orrery/config.toml"))("status without any config says where Orrery looks and exits non-zero; an empty config lists no agents", () => {
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
		expect({ status: empty.status, stdout: empty.stdout }).toEqual({ status: 0, stdout: "No agents configured.\n" });
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

	it("starts the ChatGPT sign-in: a release binary carries pi-ai's OAuth flows", async () => {
		// pi-ai imports its OAuth flows by a file path that exists only in node_modules, not inside a compiled binary.
		const dir = tempDir("orrery-main-");
		dirs.push(dir);
		const configPath = join(dir, "config.toml");
		writeFileSync(configPath, "");
		const c = cliCommand(["login", "openai", "--manual", "--config", configPath]);
		// The flow prints its link, then waits for the pasted redirect URL: stop it at the link. A busy callback port (another
		// login running on this machine) fails inside the flow, which still proves the flow loaded.
		const reached = /Open: https:\/\/auth\.openai\.com\/|Port 1455 is in use/;
		const out = await new Promise<string>((done) => {
			const child = spawn(c.cmd, c.args, { env: { PATH: process.env.PATH, HOME: dir, ORRERY_HOME: dir }, stdio: ["pipe", "pipe", "pipe"] });
			let text = "";
			const stop = setTimeout(() => child.kill(), 15_000);
			const read = (d: Buffer) => {
				text += d.toString();
				if (reached.test(text)) child.kill();
			};
			child.stdout.on("data", read);
			child.stderr.on("data", read);
			child.on("close", () => {
				clearTimeout(stop);
				done(text);
			});
		});
		expect(out).not.toContain("Cannot find module");
		expect(out).toMatch(reached);
	}, 20_000);

	it("inside an agent's session (its parent recorded in the data folder) refuses remote key, and \".\" and status are that agent's", () => {
		const dir = tempDir("orrery-main-");
		dirs.push(dir);
		const dataDir = join(dir, "data");
		mkdirSync(dataDir);
		// In its data folder, as ~/.orrery keeps it, and that folder its ORRERY_HOME (not the test run's scratch home).
		const configPath = join(dataDir, "config.toml");
		const extra = `\n[agents.Other]\nfolder = ${JSON.stringify(join(dir, "other"))}\nmodel = "faux-agent/faux-1"\n`;
		writeFileSync(configPath, agentConfigToml({ dataDir, folder: join(dir, "ws"), extra }));
		const env = { ...process.env, ORRERY_HOME: dataDir };
		const run = (args: string[]) => {
			const c = cliCommand([...args, "--config", configPath]);
			return spawnSync(c.cmd, c.args, { encoding: "utf8", env, cwd: dir });
		};
		// This test process, the CLI's parent, stands for Test's pi: the CLI (ORRERY_TEST_BIN's binary too) runs inside it.
		expect(recordSession(dataDir, { agent: "Test", tool: "pi", pid: process.pid })).toBe(true);
		try {
			const key = run(["remote", "key", "home"]);
			expect({ status: key.status, stdout: key.stdout, stderr: key.stderr }).toEqual({
				status: 1,
				stdout: "",
				stderr: "orrery remote can't run inside an agent session (Test, pi): agents can't change memory or settings. Run it in your own terminal or the TUI.\n",
			});
			// "." is the session's agent, from a folder that is no agent's; with no name, only what Test may read.
			expect(run(["status", "."]).stdout).toMatch(/^Test\s+closed/);
			expect(run(["status"]).stdout.split("\n").filter(Boolean).map((line) => line.split(/\s+/)[0])).toEqual(["Test"]);
			const other = run(["status", "Other"]);
			expect([other.status, other.stderr]).toEqual([1, "Test may not read Other. Allow it in the TUI (C, Reads) or with: orrery agent set Test --reads Other\n"]);
			// A config of its own, naming the same data folder, changes nothing: refused.
			const fake = join(dir, "fake.toml");
			writeFileSync(fake, agentConfigToml({ dataDir, folder: join(dir, "ws"), extra: `${extra}reads = ["*"]\n` }));
			const c = cliCommand(["status", "Other", "--config", fake]);
			const forged = spawnSync(c.cmd, c.args, { encoding: "utf8", env });
			expect([forged.status, forged.stderr]).toEqual([1, "--config and ORRERY_CONFIG can't be changed inside an agent session.\n"]);
		} finally {
			forgetSession(dataDir, process.pid);
		}
		// Outside it again: every command runs (remote key fails on its own, naming the missing remote).
		expect(run(["remote", "key", "home"]).stderr).not.toContain("inside an agent session");
	});

	it("strips control sequences from status.json text", () => {
		const dir = tempDir("orrery-main-");
		dirs.push(dir);
		const config = parseConfig(agentConfigToml({ dataDir: join(dir, "data"), folder: join(dir, "ws") }), dir);
		const agentDir = join(dir, "data", "agents", "Test");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "status.json"),
			JSON.stringify({
				agent: "Test", pid: process.pid, open: true, busy: false, model: "pi", thinking: "off",
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
		const config = parseConfig(agentConfigToml({ dataDir: join(dir, "data"), folder: join(dir, "ws") }), dir);
		const parsed = JSON.parse(statusCommand(config, undefined, { json: true }));
		expect(parsed.agents[0].name).toBe("Test");
		expect(parsed.agents[0].lastBackup).toBeUndefined();
		mkdirSync(join(dir, "data", "backups", "2026-10-07", "Test"), { recursive: true });
		expect(JSON.parse(statusCommand(config, undefined, { json: true })).agents[0].lastBackup).toBe("2026-10-07");
	});

	it("counts the messages dropped because Claude Code's transcript or Codex's rollout never confirmed them, once there are any", () => {
		const dir = tempDir("orrery-main-");
		dirs.push(dir);
		const config = parseConfig(agentConfigToml({ dataDir: join(dir, "data"), folder: join(dir, "ws") }), dir);
		expect(statusCommand(config)).not.toContain("unconfirmed");
		expect(JSON.parse(statusCommand(config, undefined, { json: true })).agents[0].unconfirmedMessages).toBeUndefined();
		addUnconfirmed(config.agents.get("Test")!.dir);
		expect(statusCommand(config)).toMatch(/^Test .* · 1 unconfirmed message not recorded\n$/);
		addUnconfirmed(config.agents.get("Test")!.dir, 2);
		expect(statusCommand(config)).toContain(" · 3 unconfirmed messages not recorded\n");
		expect(JSON.parse(statusCommand(config, undefined, { json: true })).agents[0].unconfirmedMessages).toBe(3);
	});

	it("backs up every agent with memory, and rejects a bad --keep", () => {
		const dir = tempDir("orrery-main-");
		dirs.push(dir);
		const dataDir = join(dir, "data");
		const configPath = join(dir, "config.toml");
		writeFileSync(configPath, agentConfigToml({ dataDir, folder: join(dir, "ws") }));
		const store = MemoryStore.open(join(dataDir, "agents", "Test", "memory.sqlite"));
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
		writeFileSync(configPath, agentConfigToml({ dataDir: join(dir, "data"), folder: join(dir, "ws") }));
		for (const days of ["0", "x", "1.5"]) {
			const bad = spawnCli(["usage", "--config", configPath, "--days", days]);
			expect(bad.status, days).toBe(1);
			expect(bad.stderr).toContain("--days");
		}
		const config = parseConfig(readFileSync(configPath, "utf8"), dir);
		const agentDir = config.agents.get("Test")!.dir;
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "status.json"), JSON.stringify({ pid: "x", busy: "yes" }));
		expect(statusCommand(config)).toMatch(/Test\s+closed/);
		writeFileSync(join(agentDir, "status.json"), JSON.stringify({ pid: process.pid, busy: false, model: 7 }));
		expect(statusCommand(config)).toMatch(/Test\s+closed/);
		// A live pid and a fresh time, but no compactor model, or a trouble without its words: still no crash.
		const live = { agent: "Test", pid: process.pid, open: true, busy: false, model: "pi", thinking: "pi", lastError: null, updatedAt: localIso() };
		writeFileSync(join(agentDir, "status.json"), JSON.stringify({ ...live, compactor: { stopped: false, failing: 0, thinking: "low", source: "config" }, trouble: null }));
		expect(statusCommand(config)).toMatch(/Test\s+closed/);
		writeFileSync(join(agentDir, "status.json"), JSON.stringify({ ...live, compactor: { stopped: false, failing: 1, model: "a/b", thinking: "low", source: "config" }, trouble: { state: "failing" } }));
		expect(statusCommand(config)).toMatch(/Test\s+closed/);
		expect(JSON.parse(statusCommand(config, undefined, { json: true })).agents[0].state).toBe("closed");
	});

	it("restore needs --from and names the missing backup", () => {
		const dir = tempDir("orrery-main-");
		dirs.push(dir);
		const configPath = join(dir, "config.toml");
		writeFileSync(configPath, agentConfigToml({ dataDir: join(dir, "data"), folder: join(dir, "ws") }));
		const run = (args: string[]) => spawnCli([...args, "--config", configPath]);
		expect(run(["restore", "Test"]).stderr).toContain("--from");
		const missing = run(["restore", "Test", "--from", "2026-01-01"]);
		expect(missing.status).toBe(1);
		expect(missing.stderr).toContain("No backup of Test");
	});

	it("restore says what it did with the backup's instructions.md: put back when the agent has none, else kept aside", () => {
		const dir = tempDir("orrery-main-");
		dirs.push(dir);
		const dataDir = join(dir, "data");
		const configPath = join(dir, "config.toml");
		writeFileSync(configPath, agentConfigToml({ dataDir, folder: join(dir, "ws") }));
		const agentDir = join(dataDir, "agents", "Test");
		mkdirSync(agentDir, { recursive: true });
		const store = MemoryStore.open(join(agentDir, "memory.sqlite"));
		store.appendBatch([{ kind: "user", text: "hello" }]);
		store.close();
		writeFileSync(join(agentDir, "instructions.md"), "Test reviews pull requests.\n", { mode: 0o600 });
		const env = { ...process.env, HOME: dir, ORRERY_CONFIG: "", ORRERY_HOME: "" };
		const run = (args: string[]) => {
			const c = cliCommand([...args, "--config", configPath]);
			return execFileSync(c.cmd, c.args, { encoding: "utf8", env });
		};
		run(["backup"]);
		const day = readdirSync(join(dataDir, "backups")).find((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry))!;
		const from = join(dataDir, "backups", day, "Test");

		rmSync(join(agentDir, "instructions.md"));
		const restored = run(["restore", "Test", "--from", day]);
		expect(restored).toContain("(memory.sqlite, instructions.md)");
		expect(restored).toContain("Test had no instructions; put back the backup's instructions.md");
		expect(readFileSync(join(agentDir, "instructions.md"), "utf8")).toBe("Test reviews pull requests.\n");

		writeFileSync(join(agentDir, "instructions.md"), "Test reviews pull requests and releases.\n");
		const kept = run(["restore", "Test", "--from", day]);
		expect(kept).toContain(`Kept Test's own instructions.md; the backup's copy is ${join(from, "instructions.md")}`);
		expect(readFileSync(join(agentDir, "instructions.md"), "utf8")).toBe("Test reviews pull requests and releases.\n");
	});

	// Root reads a mode-000 file anyway: there is nothing unreadable to test with.
	it.skipIf(process.getuid?.() === 0)("backup warns about an instructions.md it can't read and still succeeds; an agent with instructions only says so, and restores", () => {
		const dir = tempDir("orrery-main-");
		dirs.push(dir);
		const dataDir = join(dir, "data");
		const configPath = join(dir, "config.toml");
		const extra = `\n[agents.Fresh]\nfolder = ${JSON.stringify(join(dir, "ws"))}\nmodel = "faux-agent/faux-1"\n`;
		writeFileSync(configPath, agentConfigToml({ dataDir, folder: join(dir, "ws"), extra }));
		const agentDir = join(dataDir, "agents", "Test");
		mkdirSync(agentDir, { recursive: true });
		const store = MemoryStore.open(join(agentDir, "memory.sqlite"));
		store.appendBatch([{ kind: "user", text: "hello" }]);
		store.close();
		writeFileSync(join(agentDir, "instructions.md"), "Test reviews pull requests.\n", { mode: 0o000 });
		const fresh = join(dataDir, "agents", "Fresh");
		mkdirSync(fresh, { recursive: true });
		writeFileSync(join(fresh, "instructions.md"), "Fresh answers questions.\n", { mode: 0o600 });
		const env = { ...process.env, HOME: dir, ORRERY_CONFIG: "", ORRERY_HOME: "" };
		const run = (args: string[]) => {
			const c = cliCommand([...args, "--config", configPath]);
			return spawnSync(c.cmd, c.args, { encoding: "utf8", env });
		};

		const backup = run(["backup"]);
		expect(backup.status).toBe(0);
		expect(backup.stdout).toMatch(/Test: 1 messages, 0 summaries -> .*\/Test/);
		expect(backup.stdout).toMatch(/Fresh: instructions only \(no memory yet\) -> .*\/Fresh/);
		expect(backup.stderr).toMatch(/Warning: Test: instructions\.md was not backed up \(EACCES/);

		const day = readdirSync(join(dataDir, "backups")).find((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry))!;
		rmSync(join(fresh, "instructions.md"));
		const restored = run(["restore", "Fresh", "--from", day]);
		expect(restored.status).toBe(0);
		expect(restored.stdout).toContain("holds instructions only; Fresh's memory is left as it is");
		expect(restored.stdout).toContain("Fresh had no instructions; put back the backup's instructions.md");
		expect(readFileSync(join(fresh, "instructions.md"), "utf8")).toBe("Fresh answers questions.\n");
	});

	it.skipIf(process.getuid?.() === 0)("restore puts the memory back and exits 0 when an instructions.md can't be read, naming it; a link to nothing is none in effect", () => {
		const dir = tempDir("orrery-main-");
		dirs.push(dir);
		const dataDir = join(dir, "data");
		const configPath = join(dir, "config.toml");
		writeFileSync(configPath, agentConfigToml({ dataDir, folder: join(dir, "ws") }));
		const agentDir = join(dataDir, "agents", "Test");
		mkdirSync(agentDir, { recursive: true });
		const store = MemoryStore.open(join(agentDir, "memory.sqlite"));
		store.appendBatch([{ kind: "user", text: "hello" }]);
		store.close();
		const own = join(agentDir, "instructions.md");
		writeFileSync(own, "Test reviews pull requests.\n", { mode: 0o600 });
		const env = { ...process.env, HOME: dir, ORRERY_CONFIG: "", ORRERY_HOME: "" };
		const run = (args: string[]) => {
			const c = cliCommand([...args, "--config", configPath]);
			return spawnSync(c.cmd, c.args, { encoding: "utf8", env });
		};
		expect(run(["backup"]).status).toBe(0);
		const day = readdirSync(join(dataDir, "backups")).find((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry))!;
		const saved = join(dataDir, "backups", day, "Test", "instructions.md");

		chmodSync(own, 0o000);
		const ownUnreadable = run(["restore", "Test", "--from", day]);
		chmodSync(own, 0o600);
		expect(ownUnreadable.status).toBe(0);
		expect(ownUnreadable.stdout).toContain("Restored Test from");
		expect(ownUnreadable.stdout).toContain("1 messages");
		expect(ownUnreadable.stderr).toContain(`Warning: could not read ${own} (EACCES); it was left as it is, and the backup's copy is ${saved}`);

		rmSync(own);
		chmodSync(saved, 0o000);
		const savedUnreadable = run(["restore", "Test", "--from", day]);
		chmodSync(saved, 0o600);
		expect(savedUnreadable.status).toBe(0);
		expect(savedUnreadable.stdout).toContain("Restored Test from");
		expect(savedUnreadable.stderr).toContain(`Warning: could not read ${saved} (EACCES); instructions.md was not restored`);
		expect(existsSync(own)).toBe(false);

		symlinkSync(join(dir, "nothing.md"), own);
		const dangling = run(["restore", "Test", "--from", day]);
		expect(dangling.status).toBe(0);
		expect(dangling.stdout).toContain(`Left Test's instructions.md as it is (not a regular file; none in effect); the backup's copy is ${saved}`);
	});
});
