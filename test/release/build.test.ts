import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

	it("refuses to name a version when copied out of its release, even beside a stray package.json", async () => {
		const stray = mkdtempSync(join(tmpdir(), "orrery-stray-"));
		try {
			mkdirSync(join(stray, "bin"));
			writeFileSync(join(stray, "package.json"), JSON.stringify({ name: "elsewhere", version: "9.9.9" }));
			const bin = join(stray, "bin", "orrery");
			copyFileSync(join(await builtRelease(), "bin", "orrery"), bin);
			chmodSync(bin, 0o755);
			const v = spawnSync(bin, ["--version"], { encoding: "utf8" });
			expect([v.status, v.stdout, v.stderr]).toEqual([1, "", `no VERSION beside this binary at ${realpathSync(bin)} (looked for ${join(realpathSync(stray), "VERSION")})\n`]);
		} finally {
			rmSync(stray, { recursive: true, force: true });
		}
	});

	it("names third-party licenses for what it packs, with the standard text for each that ships none", async () => {
		const text = readFileSync(join(await builtRelease(), "THIRD_PARTY_LICENSES"), "utf8");
		for (const name of ["smol-toml", "proper-lockfile", "undici"]) expect(text).toMatch(new RegExp(`\\n==== ${name}@\\S+ ====\\nLicense: \\S+\\nAuthor: `));
		const ids = new Set([...text.matchAll(/the standard (.+) texts? (?:is|are) at the end of this file/g)].flatMap((m) => (m[1] as string).split(" and ")));
		expect([...ids]).toContain("MIT");
		for (const id of ids) expect(text.split(readFileSync(join(REPO, "scripts", "licenses", `${id}.txt`), "utf8")).length - 1, id).toBe(1);
	});
});
