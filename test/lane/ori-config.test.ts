import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../../src/lane/config.ts";
import { setLaneKey } from "../../src/lane/config-edit.ts";
import { laneOverview } from "../../src/lane/overview.ts";
import { tempDir } from "./support.ts";
import { cleanEnv } from "../claude/support.ts";

const base = '[lanes.Atlas]\nworkspace = "/w/atlas"\ncompactor_model = "a/b"\n';
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("Ori lane settings", () => {
	it("defaults old configs to direct and exposes both settings in the overview", () => {
		const dir = tempDir("orrery-ori-config-");
		dirs.push(dir);
		const old = parseConfig(base, dir);
		expect(old.lanes.get("Atlas")?.launcher).toBe("direct");
		expect(old.lanes.get("Atlas")?.oriModel).toBeUndefined();
		expect(laneOverview(old)[0].launcher).toBe("direct");
		const config = parseConfig(`${base}launcher = "ori"\nori_model = "vendor/model:free"\n`, dir);
		expect(laneOverview(config)[0]).toMatchObject({ launcher: "ori", oriModel: "vendor/model:free" });
	});

	it.each(['launcher = "other"', 'launcher = ""', 'launcher = 1', 'ori_model = ""', 'ori_model = "a b"', 'ori_model = "a\\tb"', 'ori_model = "a\\u007fb"', 'ori_model = 3'])("rejects %s", (line) => {
		expect(() => parseConfig(`${base}${line}\n`, "/tmp")).toThrow(/lanes.Atlas.(launcher|ori_model)/);
	});

	it("sets and clears keys without losing comments, CRLF or other values", () => {
		const text = `${base}launcher = "direct" # how\nori_model = "old/model" # model\n`.replaceAll("\n", "\r\n").trimEnd();
		const next = setLaneKey(text, "/tmp", "Atlas", "launcher", "ori");
		expect(next).toContain('launcher = "ori" # how\r\n');
		const cleared = setLaneKey(next, "/tmp", "Atlas", "ori_model", "");
		expect(cleared).toContain("# model");
		expect(cleared).not.toMatch(/^ori_model =/m);
		expect(cleared.replaceAll("\r\n", "")).not.toContain("\n");
		expect(parseConfig(cleared, "/tmp").lanes.get("Atlas")?.oriModel).toBeUndefined();
		expect(parseConfig(setLaneKey(cleared, "/tmp", "Atlas", "launcher", ""), "/tmp").lanes.get("Atlas")?.launcher).toBe("direct");
		expect(setLaneKey(base, "/tmp", "Atlas", "ori_model", "")).toBe(base);
	});

	it("CLI accepts positional keys and flags, saves a backup, and clears an empty value", () => {
		const dir = tempDir("orrery-ori-cli-");
		dirs.push(dir);
		const config = join(dir, "config.toml");
		writeFileSync(config, base);
		const run = (...args: string[]) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", resolve("src/cli/main.ts"), "lane", "set", "atlas", ...args], { encoding: "utf8", env: cleanEnv({ HOME: dir, ORRERY_CONFIG: config }) });
		for (const args of [["launcher", "ori"], ["--ori-model", "vendor/model"], ["ori_model", ""]]) {
			const out = run(...args);
			expect(out.stderr).toBe("");
			expect(out.status).toBe(0);
		}
		expect(readFileSync(`${config}.bak`, "utf8")).toContain('ori_model = "vendor/model"');
		expect(parseConfig(readFileSync(config, "utf8"), dir).lanes.get("Atlas")).toMatchObject({ launcher: "ori" });
		expect(readFileSync(config, "utf8")).not.toContain("ori_model");
	});
});

it("status text and JSON show the launcher", async () => {
	const { statusCommand } = await import("../../src/cli/commands.ts");
	const dir = tempDir("orrery-ori-status-");
	dirs.push(dir);
	const config = parseConfig(`${base}launcher = "ori"\nori_model = "vendor/model"\n`, dir);
	expect(statusCommand(config)).toContain("pi · Ori");
	expect(JSON.parse(statusCommand(config, undefined, { json: true })).lanes[0]).toMatchObject({ launcher: "ori", oriModel: "vendor/model" });
});


it("aligns status memory columns beside Claude Code through Ori", async () => {
	const { statusCommand } = await import("../../src/cli/commands.ts");
	const dir = tempDir("orrery-ori-columns-"); dirs.push(dir);
	const config = parseConfig(`${base}tool = "claude-code"\nlauncher = "ori"\n[lanes.Other]\nworkspace = "/w/other"\ncompactor_model = "a/b"\n`, dir);
	const lines = statusCommand(config).trimEnd().split("\n");
	expect(lines[0]).toContain("Claude Code · Ori");
	expect(lines[0].indexOf("no memory yet")).toBe(lines[1].indexOf("no memory yet"));
});
