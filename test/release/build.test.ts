import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { builtRelease, bunReady, REPO, removeBuiltRelease } from "./support.ts";

const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { version: string };

describe.skipIf(!bunReady)("build-release (host)", () => {
	afterAll(removeBuiltRelease);

	it("lays out one release folder: VERSION, the binary, the plugin, deploy files and licenses, and no sources", async () => {
		const folder = await builtRelease();
		const version = readFileSync(join(folder, "VERSION"), "utf8").trim();
		expect(version).toMatch(new RegExp(`^${pkg.version.replace(/\./g, "\\.")}-[0-9a-f]{7}$`));
		expect(basename(folder)).toMatch(new RegExp(`^orrery-${version}-(linux|darwin)-(x64|arm64)$`));
		expect(statSync(join(folder, "bin", "orrery")).mode & 0o111).not.toBe(0);
		expect(readdirSync(join(folder, "bin"))).toEqual(["orrery"]);
		for (const file of [".claude-plugin/marketplace.json", "claude-plugin/.claude-plugin/plugin.json", "claude-plugin/hooks/mod.ts", "claude-plugin/bin/orrery-run", "deploy/workstation/backup.sh", "LICENSE", "THIRD_PARTY_LICENSES"]) {
			expect(existsSync(join(folder, file)), file).toBe(true);
		}
		expect(existsSync(join(folder, "claude-plugin", "tests"))).toBe(false);
		expect(readdirSync(folder).sort()).toEqual([".claude-plugin", "LICENSE", "THIRD_PARTY_LICENSES", "VERSION", "bin", "claude-plugin", "deploy", "extensions"].sort());
	});

	it("the binary answers --version with the release's version and --help with the usage", async () => {
		const folder = await builtRelease();
		const version = readFileSync(join(folder, "VERSION"), "utf8").trim();
		const v = spawnSync(join(folder, "bin", "orrery"), ["--version"], { encoding: "utf8" });
		expect(v.status).toBe(0);
		expect(v.stdout).toBe(`orrery ${version}\n`);
		const h = spawnSync(join(folder, "bin", "orrery"), ["--help"], { encoding: "utf8" });
		expect(h.stdout).toMatch(/^Usage: orrery <command>/);
	});

	it("names third-party licenses for what it packs", async () => {
		const text = readFileSync(join(await builtRelease(), "THIRD_PARTY_LICENSES"), "utf8");
		for (const name of ["smol-toml", "proper-lockfile", "undici"]) expect(text).toContain(`${name}@`);
	});
});
