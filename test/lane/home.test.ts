import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { orreryHome } from "../../src/lane/home.ts";
import { DEFAULT_CONFIG_PATH, defaultConfigPath } from "../../src/lane/config.ts";
import { newConfigText, userConfigPath } from "../../src/lane/config-edit.ts";
import { parseConfig } from "../../src/lane/config.ts";
import { tempDir } from "./support.ts";

describe("Orrery's home", () => {
	it("is ~/.orrery unless ORRERY_HOME moves it, with ~ expanded", () => {
		const home = tempDir("orrery-home-");
		expect(orreryHome({ HOME: home })).toBe(join(home, ".orrery"));
		expect(orreryHome({ HOME: home, ORRERY_HOME: "/srv/orrery" })).toBe("/srv/orrery");
		expect(orreryHome({ HOME: home, ORRERY_HOME: "~/elsewhere" })).toBe(join(home, "elsewhere"));
	});

	it("refuses a relative ORRERY_HOME instead of resolving it against the current folder", () => {
		expect(() => orreryHome({ HOME: "/h", ORRERY_HOME: "orrery-data" })).toThrow(/ORRERY_HOME must be an absolute path/);
	});
});

describe("finding the config", () => {
	it("prefers ORRERY_CONFIG, then the home's config, then the server path, and ignores the old folders", () => {
		const home = tempDir("orrery-home-");
		const env = { HOME: home };
		mkdirSync(join(home, ".config", "orrery"), { recursive: true });
		writeFileSync(join(home, ".config", "orrery", "config.toml"), "");
		expect(defaultConfigPath(env)).toBe(DEFAULT_CONFIG_PATH);
		mkdirSync(join(home, ".orrery"), { recursive: true });
		writeFileSync(join(home, ".orrery", "config.toml"), "");
		expect(defaultConfigPath(env)).toBe(join(home, ".orrery", "config.toml"));
		expect(defaultConfigPath({ ...env, ORRERY_CONFIG: "/x/c.toml" })).toBe("/x/c.toml");
	});

	it("puts a new config in the home, and a new config keeps its data beside it", () => {
		const home = tempDir("orrery-home-");
		expect(userConfigPath({ HOME: home })).toBe(join(home, ".orrery", "config.toml"));
		expect(newConfigText()).not.toMatch(/data_dir/);
		expect(parseConfig(newConfigText(), join(home, ".orrery")).dataDir).toBe(join(home, ".orrery"));
		expect(newConfigText("/srv/memory")).toMatch(/^data_dir = "\/srv\/memory"$/m);
	});
});
