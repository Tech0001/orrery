import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installFrom } from "../../src/install/install.ts";
import { cleanupScratch, fixtureRelease, tempDir } from "./support.ts";

/** Set by a test: the next recursive removal throws before deleting anything, as a Ctrl-C partway through cleanup stops it. */
const cut = vi.hoisted(() => ({ next: false }));

vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	const rmSync: typeof fs.rmSync = (path, options) => {
		if (cut.next && options?.recursive === true) {
			cut.next = false;
			throw new Error("cut short");
		}
		fs.rmSync(path, options);
	};
	return { ...fs, rmSync, default: { ...fs, rmSync } };
});

afterEach(() => {
	cut.next = false;
	cleanupScratch();
});

/** A scratch home; the environment running the tests may name a config of its own, which the installer must not see. */
function scratchEnv(): NodeJS.ProcessEnv {
	const home = tempDir("orrery-cut-");
	const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ORRERY_HOME: join(home, ".orrery") };
	delete env.ORRERY_CONFIG;
	return env;
}

describe("cleanup cut short", () => {
	it("leaves no folder under a removed version's name, and the next install finishes the removal", () => {
		const env = scratchEnv();
		const app = join(env.ORRERY_HOME as string, "app");
		for (const v of ["0.6.0", "0.6.1", "0.6.2"]) installFrom({ from: fixtureRelease(v), env });
		// Installing 0.6.3 removes 0.6.0 (beyond the newest three, not the rollback target or the previous current).
		cut.next = true;
		expect(() => installFrom({ from: fixtureRelease("0.6.3"), env })).toThrow("cut short");
		const names = readdirSync(app);
		expect(names).not.toContain("0.6.0");
		expect(names.filter((n) => n.startsWith(".removing-"))).toHaveLength(1);
		installFrom({ from: fixtureRelease("0.6.4"), env });
		expect(readdirSync(app).filter((n) => n.startsWith("."))).toEqual([]);
	});
});
