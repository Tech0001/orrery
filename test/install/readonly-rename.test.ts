import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureRelease } from "./support.ts";

// macOS 15 refuses to rename a folder its owner cannot write (EACCES), even inside one parent; Linux and macOS 26 allow
// it. This file's node:fs behaves like macOS 15, so the installer is checked against it on any machine.
vi.mock("node:fs", async (original) => {
	const actual = await original<typeof import("node:fs")>();
	return {
		...actual,
		renameSync: (from: string, to: string) => {
			const info = actual.lstatSync(from);
			if (info.isDirectory() && (info.mode & 0o200) === 0) throw Object.assign(new Error(`EACCES: permission denied, rename '${from}' -> '${to}'`), { code: "EACCES" });
			return actual.renameSync(from, to);
		},
	};
});

const { installFrom, removeVersion } = await import("../../src/install/install.ts");

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) removeVersion(d);
});

function scratch(): NodeJS.ProcessEnv {
	const home = mkdtempSync(join(tmpdir(), "orrery-macos15-"));
	dirs.push(home);
	const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ORRERY_HOME: join(home, ".orrery") };
	delete env.ORRERY_CONFIG;
	return env;
}

const mode = (path: string) => lstatSync(path).mode & 0o777;

describe("installing where a read-only folder cannot be renamed (macOS 15)", () => {
	it("installs a release, read-only like everywhere else", () => {
		const env = scratch();
		installFrom({ from: fixtureRelease("0.6.0"), env });
		const app = join(env.ORRERY_HOME as string, "app");
		expect(readlinkSync(join(app, "current"))).toBe("0.6.0");
		expect(mode(join(app, "0.6.0"))).toBe(0o555);
		expect(mode(join(app, "0.6.0", "bin"))).toBe(0o555);
		expect(readdirSync(app).filter((n) => n.startsWith("."))).toEqual([]);
	});

	it("removes an old version when a newer one is installed", () => {
		const env = scratch();
		const app = join(env.ORRERY_HOME as string, "app");
		for (const v of ["0.6.0", "0.6.1", "0.6.2", "0.6.3"]) installFrom({ from: fixtureRelease(v), env });
		expect(existsSync(join(app, "0.6.0"))).toBe(false);
		expect(readdirSync(app).filter((n) => n.startsWith("."))).toEqual([]);
	});

	it("re-stages a damaged copy of the same version", () => {
		const env = scratch();
		const app = join(env.ORRERY_HOME as string, "app");
		installFrom({ from: fixtureRelease("0.6.0"), env });
		// Damaged: its binary is gone.
		chmodSync(join(app, "0.6.0", "bin"), 0o755);
		rmSync(join(app, "0.6.0", "bin", "orrery"));
		installFrom({ from: fixtureRelease("0.6.0"), env });
		expect(existsSync(join(app, "0.6.0", "bin", "orrery"))).toBe(true);
		expect(mode(join(app, "0.6.0"))).toBe(0o555);
		expect(readdirSync(app).filter((n) => n.startsWith("."))).toEqual([]);
	});
});
