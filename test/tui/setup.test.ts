import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, parseConfig } from "../../src/lane/config.ts";
import { configWritable, editConfigFile } from "../../src/lane/config-edit.ts";
import { saveKey } from "../../src/lane/logins.ts";
import { explainFailure } from "../../src/lane/source-labels.ts";
import { laneOverview } from "../../src/lane/overview.ts";
import { summarySources } from "../../src/lane/summary-sources.ts";
import type { ToolCheck } from "../../src/lane/tools.ts";
import { lanesPage } from "../../src/tui/pages/lanes.ts";
import { firstRun } from "../../src/tui/setup.ts";
import { tempDir } from "../lane/support.ts";
import { answer, fakeDeps, makeApp, screen, settle, typed } from "./support.ts";

const ENTER = "\r";
const dirs: string[] = [];
beforeEach(() => {
	for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"]) vi.stubEnv(name, "");
});
afterEach(() => {
	vi.unstubAllEnvs();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function world() {
	const dir = tempDir("orrery-first-run-");
	dirs.push(dir);
	const configPath = join(dir, "config", "config.toml");
	const dataDir = join(dir, "memory");
	const ws = join(dir, "project");
	mkdirSync(ws);
	const fixes: string[] = [];
	const tools: ToolCheck[] = [
		{ id: "pi", label: "pi", path: "/bin/pi", wiring: "missing", detail: "" },
		{ id: "claude-code", label: "Claude Code", wiring: "missing", detail: "" },
		{ id: "codex", label: "Codex", wiring: "none", detail: "" },
	];
	const deps = fakeDeps({
		configPath,
		cwd: ws,
		loadConfig: () => loadConfig(configPath),
		editConfig: (edit) => editConfigFile(configPath, edit),
		configWritable: () => configWritable(configPath),
		overview: (config) => laneOverview(config),
		sources: async (config) => summarySources(config),
		saveKey,
		tools: () => tools,
		applyFix: (fix) => (fixes.push(fix), "fixed"),
	});
	const app = makeApp(deps, [lanesPage]);
	return { configPath, dataDir, ws, fixes, app, deps, dir };
}

/** Where first run keeps logins before the config exists: a config that only names the data folder. */
function dataOnly(dataDir: string) {
	mkdirSync(dataDir, { recursive: true, mode: 0o700 });
	return parseConfig(`data_dir = ${JSON.stringify(dataDir)}\n`, dataDir);
}

describe("first run", () => {
	it("asks where memory lives, a lane, a summary login and model, writes the config, and offers the wiring", async () => {
		const { configPath, dataDir, ws, fixes, app } = world();
		const done = firstRun(app);
		await answer(app, "Where should memory live", "\x15", ...typed(dataDir), ENTER);
		await answer(app, "first lane's name", ...typed("Main"), ENTER);
		await answer(app, "Its folder", ENTER);
		await answer(app, "Its tool", ENTER);
		await answer(app, "one way to make summaries", ...typed("anthropic"), ENTER);
		await answer(app, "Anthropic API key", "\x1b[200~sk-ant-setup-1\n\x1b[201~");
		await answer(app, "Summaries from:", ENTER);
		await answer(app, "Anthropic model:", ...typed("haiku-4-5"), ENTER);
		await answer(app, "Thinking", ...typed("low"), ENTER);
		await answer(app, "pi extension is not installed", "y");
		await answer(app, "Done", ENTER);
		expect(await done).toBe(true);
		const lane = loadConfig(configPath).lanes.get("Main");
		expect(lane).toMatchObject({ workspace: ws, tool: "pi", compactor: { model: { provider: "anthropic", modelId: "claude-haiku-4-5", thinking: "low" } } });
		expect(statSync(configPath).mode & 0o777).toBe(0o600);
		expect(readFileSync(configPath, "utf8")).toContain(`data_dir = ${JSON.stringify(dataDir)}`);
		// model too, so an orrery from before the TUI (which requires it) still reads this config.
		expect(readFileSync(configPath, "utf8")).toContain('tool = "pi"\nmodel = "anthropic/claude-haiku-4-5"\ncompactor_model = "anthropic/claude-haiku-4-5"\n');
		expect(await summarySources(dataOnly(dataDir)).credentials.read("anthropic")).toEqual({ type: "api_key", key: "sk-ant-setup-1" });
		expect(fixes).toEqual(["install-pi"]);
		expect(screen(app)).toContain("Orrery is set up. Main is ready: press L to launch it.");
	});

	it("shows the welcome while it asks, and leaves on Esc without writing a config", async () => {
		const { configPath, app } = world();
		const done = firstRun(app);
		await answer(app, "Where should memory live");
		expect(screen(app)).not.toContain("The config has a problem");
		await answer(app, "Where should memory live", "\x1b");
		expect(await done).toBe(false);
		expect(existsSync(configPath)).toBe(false);
	});

	it("uses a login that is already saved, without asking for one", async () => {
		const { configPath, dataDir, app } = world();
		await saveKey(summarySources(dataOnly(dataDir)), "anthropic", "sk-ant-earlier");
		const done = firstRun(app);
		await answer(app, "Where should memory live", "\x15", ...typed(dataDir), ENTER);
		await answer(app, "first lane's name", ...typed("Main"), ENTER);
		await answer(app, "Its folder", ENTER);
		await answer(app, "Its tool", ENTER);
		await answer(app, "Summaries from:", ENTER);
		await answer(app, "Anthropic model:", ...typed("haiku-4-5"), ENTER);
		await answer(app, "Thinking", ENTER);
		await answer(app, "pi extension is not installed", "n");
		expect(await done).toBe(true);
		expect(existsSync(configPath)).toBe(true);
	});

	it("refuses a lane name orrery agent uses, says why, and asks again", async () => {
		const { configPath, dataDir, app } = world();
		const done = firstRun(app);
		await answer(app, "Where should memory live", "\x15", ...typed(dataDir), ENTER);
		await answer(app, "first lane's name", ...typed("local"), ENTER);
		await answer(app, "Lane name");
		expect((app.host.current as unknown as { text: string }).text).toBe("local is a word orrery agent uses (add, set, edit, archive, push, pull, takeover, local); pick another name.");
		await answer(app, "Lane name", ENTER);
		await answer(app, "first lane's name", "\x1b");
		expect(await done).toBe(false);
		expect(existsSync(configPath)).toBe(false);
	});

	it("refuses an empty data folder and asks again", async () => {
		const { configPath, app } = world();
		const done = firstRun(app);
		await answer(app, "Where should memory live", "\x15", ENTER);
		await answer(app, "Where should memory live", "\x1b");
		expect(await done).toBe(false);
		expect(existsSync(configPath)).toBe(false);
	});

	it("shows why a data folder cannot be made and asks again", async () => {
		const { dir, app } = world();
		writeFileSync(join(dir, "afile"), "x");
		const done = firstRun(app);
		await answer(app, "Where should memory live", "\x15", ...typed(join(dir, "afile", "mem")), ENTER);
		await answer(app, "Memory folder", ENTER);
		await answer(app, "Where should memory live", "\x1b");
		expect(await done).toBe(false);
	});

	it("says when the config cannot be written, and writes nothing", async () => {
		const { configPath, app, deps } = world();
		Object.assign(deps, { configWritable: () => false });
		const done = firstRun(app);
		await answer(app, "Can't write the config");
		expect(screen(app)).toContain(configPath);
		expect(screen(app)).toContain("ORRERY_CONFIG");
		await answer(app, "Can't write the config", ENTER);
		expect(await done).toBe(false);
		expect(existsSync(configPath)).toBe(false);
	});

	it("explains a failed ChatGPT sign-in", async () => {
		const { dataDir, app, deps } = world();
		Object.assign(deps, {
			signIn: async () => {
				throw new Error("oauth refresh failed: invalid_grant");
			},
		});
		const done = firstRun(app);
		await answer(app, "Where should memory live", "\x15", ...typed(dataDir), ENTER);
		await answer(app, "first lane's name", ...typed("Main"), ENTER);
		await answer(app, "Its folder", ENTER);
		await answer(app, "Its tool", ENTER);
		await answer(app, "one way to make summaries", ENTER);
		await settle();
		expect(app.host.current?.title).toContain("That didn't work");
		expect(explainFailure("openai", "oauth refresh failed: invalid_grant")).toContain("ChatGPT sign-in");
		expect(screen(app)).toContain("ChatGPT");
		await answer(app, "That didn't work", "\x1b");
		await answer(app, "one way to make summaries", "\x1b");
		expect(await done).toBe(false);
	});

	it("stops with a message when the config cannot be written at the end", async () => {
		const { dataDir, app, deps } = world();
		Object.assign(deps, {
			editConfig: () => {
				throw new Error("EACCES: permission denied");
			},
		});
		const done = firstRun(app);
		await answer(app, "Where should memory live", "\x15", ...typed(dataDir), ENTER);
		await answer(app, "first lane's name", ...typed("Main"), ENTER);
		await answer(app, "Its folder", ENTER);
		await answer(app, "Its tool", ENTER);
		await answer(app, "one way to make summaries", ...typed("anthropic"), ENTER);
		await answer(app, "Anthropic API key", "\x1b[200~sk-ant-setup-2\n\x1b[201~");
		await answer(app, "Summaries from:", ENTER);
		await answer(app, "Anthropic model:", ...typed("haiku-4-5"), ENTER);
		await answer(app, "Thinking", ENTER);
		await answer(app, "Can't write the config", ENTER);
		expect(await done).toBe(false);
	});

	it("shows that it is testing the model while the test call waits", async () => {
		const { dataDir, app, deps } = world();
		let release: (r: { ok: true }) => void = () => {};
		Object.assign(deps, { testChoice: () => new Promise((resolve) => (release = resolve)) });
		const done = firstRun(app);
		await answer(app, "Where should memory live", "\x15", ...typed(dataDir), ENTER);
		await answer(app, "first lane's name", ...typed("Main"), ENTER);
		await answer(app, "Its folder", ENTER);
		await answer(app, "Its tool", ENTER);
		await answer(app, "one way to make summaries", ...typed("anthropic"), ENTER);
		await answer(app, "Anthropic API key", "\x1b[200~sk-ant-setup-3\n\x1b[201~");
		await answer(app, "Summaries from:", ENTER);
		await answer(app, "Anthropic model:", ...typed("haiku-4-5"), ENTER);
		await answer(app, "Thinking", ENTER);
		await settle();
		expect(screen(app)).toContain("Testing anthropic/claude-haiku-4-5…");
		release({ ok: true });
		await answer(app, "pi extension is not installed", "n");
		expect(await done).toBe(true);
	});
});
