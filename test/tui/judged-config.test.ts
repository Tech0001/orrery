import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setAgentKey } from "../../src/agent/config-edit.ts";
import { type ConfigFile, readConfigFile } from "../../src/agent/config.ts";
import { GateRefusal } from "../../src/cli/gate.ts";
import { realDeps } from "../../src/tui/deps.ts";
import { tempDir } from "../agent/support.ts";
import { fifos, readOnce, stopWriters } from "../cli/read-once.ts";

const dirs: string[] = [];
afterEach(() => {
	stopWriters();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tui = { requestRender: () => {} } as unknown as TUI;

describe("the TUI's config, as the gate read it", () => {
	it.skipIf(!fifos)("is the one its gate read until the file changes; every read after is judged again, never a bare read, and a write goes only to the file judged", async () => {
		const dir = tempDir("orrery-tui-judged-");
		dirs.push(dir);
		const path = join(dir, "config.toml");
		const text = `data_dir = ${JSON.stringify(join(dir, "data"))}\n[agents.Atlas]\nfolder = ${JSON.stringify(dir)}\ncompactor_model = "openai/gpt-6.1-sol"\n`;
		// The gate read it; a second read would get a config of another data folder, with no agents.
		const once = await readOnce(path, text, `data_dir = ${JSON.stringify(join(dir, "elsewhere"))}\n`);
		// The gate in a coding tool's session: written back only as it was read.
		const judge = vi.fn((): ConfigFile => ({ ...readConfigFile(path), checked: true }));
		const deps = realDeps({ configPath: path, tui, quit: () => {}, config: { file: once.file, judge } });
		for (let i = 0; i < 3; i++) expect(deps.loadConfig().agents.has("Atlas")).toBe(true);
		expect(judge).not.toHaveBeenCalled();
		// Its own write goes to the file the gate read, and what it wrote is judged before it is used.
		const written = deps.editConfig((source, configDir) => setAgentKey(source, configDir, "Atlas", "view_bytes", 96000));
		expect(written.agents.get("Atlas")?.memory.viewBytes).toBe(96000);
		expect(judge).toHaveBeenCalledTimes(1);
		expect(readFileSync(path, "utf8")).toContain("view_bytes = 96000");
		expect(await once.readAgain()).toBe(false);
		// Unchanged since: no read at all.
		deps.loadConfig();
		expect(judge).toHaveBeenCalledTimes(1);
		// Another config put in its place: judged first; refused there, it is neither used nor written.
		const swapped = `# swapped in\ndata_dir = ${JSON.stringify(join(dir, "elsewhere"))}\n`;
		writeFileSync(`${path}.new`, swapped);
		renameSync(`${path}.new`, path);
		judge.mockImplementation(() => {
			throw new GateRefusal("refused by the gate");
		});
		expect(() => deps.loadConfig()).toThrow("refused by the gate");
		expect(() => deps.editConfig((source) => `${source}# mine\n`)).toThrow("refused by the gate");
		expect(readFileSync(path, "utf8")).toBe(swapped);
	});
});
