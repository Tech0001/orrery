import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig, readConfigFile } from "../../src/agent/config.ts";
import { GUARD_PRESET, newConfigText } from "../../src/agent/config-edit.ts";
import { offerGuardPreset } from "../../src/install/guard-preset.ts";
import { wire } from "../../src/install/wire.ts";
import { cleanupScratch, fakeRun, installedScratch, tempDir } from "./support.ts";
import { fifos, readOnce, stopWriters } from "../cli/read-once.ts";

/**
 * Setup adds the [guard] preset once to a config that has no [guard] table (spec 2026-10-16-guard-presets): through the
 * comment-keeping editor, atomically, the old file kept as .bak; never again once offered, even after the user deletes
 * it; never to a config with [guard] or one Orrery cannot read.
 */

afterEach(cleanupScratch);

const OLD = `# my agents
data_dir = "/m"   # memory

[agents.Atlas]
folder = "/w/atlas"
compactor_model = "openai/gpt-6.1-sol"
`;

/** A scratch home: HOME and ORRERY_HOME, and the config's path in it. */
function scratch() {
	const home = tempDir("orrery-preset-");
	const orrery = join(home, ".orrery");
	mkdirSync(orrery, { recursive: true, mode: 0o700 });
	return { env: { HOME: home, ORRERY_HOME: orrery } as NodeJS.ProcessEnv, home, orrery, config: join(orrery, "config.toml") };
}

const withoutPreset = (text: string) => text.replace(`${GUARD_PRESET}\n\n`, "");

describe("offering the [guard] preset", () => {
	it("adds it to a config without [guard], keeping every other line, atomically, with the old file as .bak and its mode", () => {
		const t = scratch();
		writeFileSync(t.config, OLD, { mode: 0o640 });
		chmodSync(t.config, 0o640);
		const line = offerGuardPreset(t.env);
		expect(line).toBe(`config: added a [guard] example to ${t.config}, where you can list more files and folders to keep from agents (the old file is ${realpathSync(t.config)}.bak)`);
		const next = readFileSync(t.config, "utf8");
		expect(next).toContain(GUARD_PRESET);
		expect(withoutPreset(next)).toBe(OLD);
		expect(readFileSync(`${t.config}.bak`, "utf8")).toBe(OLD);
		expect(statSync(t.config).mode & 0o777).toBe(0o640);
		expect(parseConfig(next, t.orrery).guard.protect).toEqual([]);
		expect(readdirSync(t.orrery).filter((name) => name.includes(".tmp"))).toEqual([]);
	});

	it("offers it once: not again, and not after the user deletes it", () => {
		const t = scratch();
		writeFileSync(t.config, OLD);
		expect(offerGuardPreset(t.env)).toMatch(/added a \[guard\] example/);
		const added = readFileSync(t.config, "utf8");
		expect(offerGuardPreset(t.env)).toBeUndefined();
		expect(readFileSync(t.config, "utf8")).toBe(added);
		writeFileSync(t.config, OLD);
		writeFileSync(`${t.config}.bak`, "earlier");
		expect(offerGuardPreset(t.env)).toBeUndefined();
		expect(readFileSync(t.config, "utf8")).toBe(OLD);
		expect(readFileSync(`${t.config}.bak`, "utf8")).toBe("earlier");
	});

	it("leaves a config that has [guard] alone, and does not add it later when the user takes [guard] out", () => {
		const t = scratch();
		const own = `${OLD}\n[guard]\nprotect = ["secrets.yml"]\n`;
		writeFileSync(t.config, own);
		expect(offerGuardPreset(t.env)).toBeUndefined();
		expect(readFileSync(t.config, "utf8")).toBe(own);
		expect(existsSync(`${t.config}.bak`)).toBe(false);
		writeFileSync(t.config, OLD);
		expect(offerGuardPreset(t.env)).toBeUndefined();
		expect(readFileSync(t.config, "utf8")).toBe(OLD);
	});

	it("leaves a config Orrery cannot read alone, and offers it once the config reads again", () => {
		const t = scratch();
		const broken = `${OLD}[agents.Beta\n`;
		writeFileSync(t.config, broken);
		expect(offerGuardPreset(t.env)).toBeUndefined();
		expect(readFileSync(t.config, "utf8")).toBe(broken);
		expect(existsSync(`${t.config}.bak`)).toBe(false);
		writeFileSync(t.config, OLD);
		expect(offerGuardPreset(t.env)).toMatch(/added a \[guard\] example/);
	});

	it("does not add it to a config created after setup ran without one: a new config starts with it", () => {
		const t = scratch();
		expect(offerGuardPreset(t.env)).toBeUndefined();
		expect(existsSync(t.config)).toBe(false);
		// The user makes a config, then takes the block out of it.
		writeFileSync(t.config, withoutPreset(newConfigText()));
		expect(offerGuardPreset(t.env)).toBeUndefined();
		expect(readFileSync(t.config, "utf8")).toBe(withoutPreset(newConfigText()));
	});

	it("works on the file ORRERY_CONFIG names, wherever it is, and leaves the home's config alone", () => {
		const t = scratch();
		writeFileSync(t.config, OLD);
		const elsewhere = join(tempDir("orrery-preset-elsewhere-"), "my.toml");
		writeFileSync(elsewhere, OLD);
		const env = { ...t.env, ORRERY_CONFIG: elsewhere };
		expect(offerGuardPreset(env)).toMatch(new RegExp(`added a \\[guard\\] example to ${elsewhere.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		expect(readFileSync(elsewhere, "utf8")).toContain(GUARD_PRESET);
		expect(readFileSync(t.config, "utf8")).toBe(OLD);
		expect(offerGuardPreset(env)).toBeUndefined();
		// The home's own config is another file: offered on its own.
		expect(offerGuardPreset(t.env)).toMatch(/added a \[guard\] example/);
	});

	it("follows a config that is a link, keeping the link", () => {
		const t = scratch();
		const real = join(tempDir("orrery-preset-dotfiles-"), "orrery.toml");
		writeFileSync(real, OLD);
		symlinkSync(real, t.config);
		expect(offerGuardPreset(t.env)).toMatch(/added a \[guard\] example/);
		expect(readFileSync(real, "utf8")).toContain(GUARD_PRESET);
		expect(readFileSync(`${real}.bak`, "utf8")).toBe(OLD);
		expect(statSync(t.config).isFile()).toBe(true);
		expect(readdirSync(t.orrery)).not.toContain("config.toml.bak");
	});

	it("keeps the marker when Orrery's home is a link to another folder", () => {
		const t = scratch();
		const elsewhere = join(tempDir("orrery-preset-disk-"), "orrery");
		mkdirSync(elsewhere, { mode: 0o700 });
		const linked = join(t.home, "linked-home");
		symlinkSync(elsewhere, linked);
		const env = { HOME: t.home, ORRERY_HOME: linked } as NodeJS.ProcessEnv;
		writeFileSync(join(elsewhere, "config.toml"), OLD);
		expect(offerGuardPreset(env)).toMatch(/added a \[guard\] example/);
		expect(existsSync(join(elsewhere, "guard-preset.json"))).toBe(true);
		writeFileSync(join(elsewhere, "config.toml"), OLD);
		expect(offerGuardPreset(env)).toBeUndefined();
		expect(readFileSync(join(elsewhere, "config.toml"), "utf8")).toBe(OLD);
	});

	it("does not count a config that is a link leading nowhere yet, and offers it once the link leads to a file", () => {
		const t = scratch();
		const target = join(tempDir("orrery-preset-dotfiles-"), "orrery.toml");
		symlinkSync(target, t.config);
		expect(offerGuardPreset(t.env)).toBeUndefined();
		expect(existsSync(target)).toBe(false);
		writeFileSync(target, OLD);
		expect(offerGuardPreset(t.env)).toMatch(/added a \[guard\] example/);
		expect(readFileSync(target, "utf8")).toContain(GUARD_PRESET);
	});

	it("leaves a config it may not write alone, saying nothing", () => {
		const t = scratch();
		writeFileSync(t.config, OLD);
		chmodSync(t.config, 0o400);
		chmodSync(t.orrery, 0o500);
		try {
			expect(offerGuardPreset(t.env)).toBeUndefined();
		} finally {
			chmodSync(t.orrery, 0o700);
			chmodSync(t.config, 0o600);
		}
		expect(readFileSync(t.config, "utf8")).toBe(OLD);
	});

	it("leaves a writable config in a folder it may not write alone, saying nothing, and offers it once the folder is writable", () => {
		const t = scratch();
		const folder = join(tempDir("orrery-preset-locked-"), "conf");
		mkdirSync(folder);
		const config = join(folder, "config.toml");
		writeFileSync(config, OLD, { mode: 0o600 });
		const env = { ...t.env, ORRERY_CONFIG: config };
		chmodSync(folder, 0o555);
		try {
			expect(offerGuardPreset(env)).toBeUndefined();
			expect(offerGuardPreset(env)).toBeUndefined();
		} finally {
			chmodSync(folder, 0o755);
		}
		expect(readFileSync(config, "utf8")).toBe(OLD);
		expect(offerGuardPreset(env)).toMatch(/added a \[guard\] example/);
	});
});

describe("setup", () => {
	it("prints one line when it adds the preset, and none the next time", async () => {
		const t = installedScratch();
		const config = join(t.orreryHome, "config.toml");
		writeFileSync(config, OLD);
		const connect = async () => true;
		const lines = await wire(t.env, { run: fakeRun, confirm: connect });
		expect(lines.filter((line) => line.startsWith("config:"))).toEqual([expect.stringMatching(/added a \[guard\] example/)]);
		expect(readFileSync(config, "utf8")).toContain(GUARD_PRESET);
		const again = await wire(t.env, { run: fakeRun, confirm: connect });
		expect(again.filter((line) => line.startsWith("config:"))).toEqual([]);
	});
});

describe("the [guard] preset with the config the gate read", () => {
	afterEach(stopWriters);

	it.skipIf(!fifos)("in a coding tool's session goes to the file the gate read, from the text it read, never read again", async () => {
		const t = scratch();
		const once = await readOnce(t.config, OLD, "# another config\n");
		expect(offerGuardPreset(t.env, once.file)).toMatch(/^config: added a \[guard\] example to /);
		expect(await once.readAgain()).toBe(false);
		expect(withoutPreset(readFileSync(t.config, "utf8"))).toBe(OLD);
		expect(readFileSync(`${t.config}.bak`, "utf8")).toBe(OLD);
	});

	it("in a coding tool's session leaves a config swapped since alone, and offers it again later", () => {
		const t = scratch();
		writeFileSync(t.config, OLD);
		const read = { ...readConfigFile(t.config), checked: true };
		const swapped = "# swapped in\n";
		writeFileSync(`${t.config}.new`, swapped);
		renameSync(`${t.config}.new`, t.config);
		expect(offerGuardPreset(t.env, read)).toBe(`config: could not add a [guard] example to ${t.config}: The config (${t.config}) changed after Orrery read it, so nothing was written to it. Run the command again.`);
		expect(readFileSync(t.config, "utf8")).toBe(swapped);
		expect(existsSync(`${t.config}.bak`)).toBe(false);
		// Not counted as offered: a later setup's read gets it.
		expect(offerGuardPreset(t.env, { ...readConfigFile(t.config), checked: true })).toMatch(/^config: added a \[guard\] example to /);
	});

	it("goes only to the user's own config (ORRERY_CONFIG, else the home's), as 0.9.0: a --config or the server's config the gate read is left alone", () => {
		const t = scratch();
		writeFileSync(t.config, OLD);
		// --config naming another file: neither it nor the user's config is touched, and neither is counted.
		const given = join(tempDir("orrery-preset-given-"), "given.toml");
		writeFileSync(given, OLD);
		for (const checked of [false, true]) expect(offerGuardPreset(t.env, { ...readConfigFile(given), checked }), `checked ${checked}`).toBeUndefined();
		expect(readFileSync(given, "utf8")).toBe(OLD);
		expect(existsSync(`${given}.bak`)).toBe(false);
		expect(readFileSync(t.config, "utf8")).toBe(OLD);
		// The server's config, the only one there (a stand-in at another path): left alone, the home's none counted.
		const bare = scratch();
		const server = join(tempDir("orrery-preset-server-"), "config.toml");
		writeFileSync(server, OLD);
		expect(offerGuardPreset(bare.env, { ...readConfigFile(server), checked: false })).toBeUndefined();
		expect(readFileSync(server, "utf8")).toBe(OLD);
		expect(existsSync(`${server}.bak`)).toBe(false);
		expect(existsSync(join(bare.orrery, "guard-preset.json"))).toBe(false);
		// The user's config, named by the gate however it was spelled: the example is added, as before.
		const linked = join(t.home, "linked-orrery");
		symlinkSync(t.orrery, linked);
		expect(offerGuardPreset(t.env, { ...readConfigFile(join(linked, "config.toml")), checked: false })).toMatch(/^config: added a \[guard\] example to /);
		expect(withoutPreset(readFileSync(t.config, "utf8"))).toBe(OLD);
		expect(offerGuardPreset(t.env, { ...readConfigFile(given), checked: false })).toBeUndefined();
		expect(readFileSync(given, "utf8")).toBe(OLD);
	});

	it("in the user's own terminal adds it to the config's text now, keeping an edit made since the read, as 0.9.0", () => {
		const t = scratch();
		writeFileSync(t.config, OLD);
		const read = { ...readConfigFile(t.config), checked: false };
		writeFileSync(t.config, `${OLD}# theirs\n`);
		expect(offerGuardPreset(t.env, read)).toMatch(/^config: added a \[guard\] example to /);
		expect(withoutPreset(readFileSync(t.config, "utf8"))).toBe(`${OLD}# theirs\n`);
	});
});
