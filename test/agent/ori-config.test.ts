import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../../src/agent/config.ts";
import { setAgentKey } from "../../src/agent/config-edit.ts";
import { agentOverview } from "../../src/agent/overview.ts";
import { tempDir } from "./support.ts";
import { cleanEnv } from "../claude/support.ts";

const base = '[agents.Atlas]\nfolder = "/w/atlas"\ncompactor_model = "a/b"\n';
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("Ori agent settings", () => {
	it("defaults old configs to direct and exposes both settings in the overview", () => {
		const dir = tempDir("orrery-ori-config-");
		dirs.push(dir);
		const old = parseConfig(base, dir);
		expect(old.agents.get("Atlas")?.launcher).toBe("direct");
		expect(old.agents.get("Atlas")?.oriModel).toBeUndefined();
		expect(agentOverview(old)[0].launcher).toBe("direct");
		const config = parseConfig(`${base}launcher = "ori"\nori_model = "vendor/model:free"\n`, dir);
		expect(agentOverview(config)[0]).toMatchObject({ launcher: "ori", oriModel: "vendor/model:free" });
	});

	it.each(['launcher = "other"', 'launcher = ""', 'launcher = 1', 'ori_model = ""', 'ori_model = "a b"', 'ori_model = "a\\tb"', 'ori_model = "a\\u007fb"', 'ori_model = 3'])("rejects %s", (line) => {
		expect(() => parseConfig(`${base}${line}\n`, "/tmp")).toThrow(/agents.Atlas.(launcher|ori_model)/);
	});

	it("sets and clears keys without losing comments, CRLF or other values", () => {
		const text = `${base}launcher = "direct" # how\nori_model = "old/model" # model\n`.replaceAll("\n", "\r\n").trimEnd();
		const next = setAgentKey(text, "/tmp", "Atlas", "launcher", "ori");
		expect(next).toContain('launcher = "ori" # how\r\n');
		const cleared = setAgentKey(next, "/tmp", "Atlas", "ori_model", "");
		expect(cleared).toContain("# model");
		expect(cleared).not.toMatch(/^ori_model =/m);
		expect(cleared.replaceAll("\r\n", "")).not.toContain("\n");
		expect(parseConfig(cleared, "/tmp").agents.get("Atlas")?.oriModel).toBeUndefined();
		expect(parseConfig(setAgentKey(cleared, "/tmp", "Atlas", "launcher", ""), "/tmp").agents.get("Atlas")?.launcher).toBe("direct");
		expect(setAgentKey(base, "/tmp", "Atlas", "ori_model", "")).toBe(base);
	});

	it("CLI accepts positional keys and flags, saves a backup, and clears an empty value", () => {
		const dir = tempDir("orrery-ori-cli-");
		dirs.push(dir);
		const config = join(dir, "config.toml");
		writeFileSync(config, base);
		const run = (...args: string[]) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", resolve("src/cli/main.ts"), "agent", "set", "atlas", ...args], { encoding: "utf8", env: cleanEnv({ HOME: dir, ORRERY_CONFIG: config }) });
		for (const args of [["launcher", "ori"], ["--ori-model", "vendor/model"], ["ori_model", ""]]) {
			const out = run(...args);
			expect(out.stderr).toBe("");
			expect(out.status).toBe(0);
		}
		expect(readFileSync(`${config}.bak`, "utf8")).toContain('ori_model = "vendor/model"');
		expect(parseConfig(readFileSync(config, "utf8"), dir).agents.get("Atlas")).toMatchObject({ launcher: "ori" });
		expect(readFileSync(config, "utf8")).not.toContain("ori_model");
	});
});

it("status text and JSON show the launcher", async () => {
	const { statusCommand } = await import("../../src/cli/commands.ts");
	const dir = tempDir("orrery-ori-status-");
	dirs.push(dir);
	const config = parseConfig(`${base}launcher = "ori"\nori_model = "vendor/model"\n`, dir);
	expect(statusCommand(config)).toContain("pi · Ori");
	expect(JSON.parse(statusCommand(config, undefined, { json: true })).agents[0]).toMatchObject({ launcher: "ori", oriModel: "vendor/model" });
});


it("aligns status memory columns beside Claude Code through Ori", async () => {
	const { statusCommand } = await import("../../src/cli/commands.ts");
	const dir = tempDir("orrery-ori-columns-"); dirs.push(dir);
	const config = parseConfig(`${base}tool = "claude-code"\nlauncher = "ori"\n[agents.Other]\nfolder = "/w/other"\ncompactor_model = "a/b"\n`, dir);
	const lines = statusCommand(config).trimEnd().split("\n");
	expect(lines[0]).toContain("Claude Code · Ori");
	expect(lines[0].indexOf("no memory yet")).toBe(lines[1].indexOf("no memory yet"));
});
