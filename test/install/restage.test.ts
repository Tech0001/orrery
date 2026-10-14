import { chmodSync, existsSync, mkdtempSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureRelease } from "./support.ts";

// Only this file's view of node:fs is wrapped; `failRename` picks the one rename that should fail.
let failRename: ((from: string, to: string) => boolean) | undefined;
vi.mock("node:fs", async (original) => {
	const actual = await original<typeof import("node:fs")>();
	return {
		...actual,
		renameSync: (from: string, to: string) => {
			if (failRename?.(String(from), String(to))) throw new Error("rename refused");
			return actual.renameSync(from, to);
		},
	};
});

const { installFrom, removeVersion } = await import("../../src/install/install.ts");

const dirs: string[] = [];
afterEach(() => {
	failRename = undefined;
	for (const d of dirs.splice(0)) removeVersion(d);
});

function scratch(): NodeJS.ProcessEnv {
	const home = mkdtempSync(join(tmpdir(), "orrery-restage-"));
	dirs.push(home);
	return { ...process.env, HOME: home, ORRERY_HOME: join(home, ".orrery") };
}

function damage(app: string, version: string) {
	chmodSync(join(app, version, "bin"), 0o755);
	rmSync(join(app, version, "bin", "orrery"));
}

describe("re-staging a damaged version", () => {
	it("leaves a whole folder and a current that resolves", () => {
		const env = scratch();
		installFrom({ from: fixtureRelease("0.6.0"), env });
		const app = join(env.ORRERY_HOME as string, "app");
		damage(app, "0.6.0");
		installFrom({ from: fixtureRelease("0.6.0"), env });
		expect(existsSync(join(app, "0.6.0", "bin", "orrery"))).toBe(true);
		expect(readlinkSync(join(app, "current"))).toBe("0.6.0");
		expect(existsSync(join(app, "current", "bin", "orrery"))).toBe(true);
		expect(readdirSync(app).filter((n) => n.startsWith("."))).toEqual([]);
	});

	it("puts the damaged folder back when the new copy cannot be moved in", () => {
		const env = scratch();
		installFrom({ from: fixtureRelease("0.6.0"), env });
		const app = join(env.ORRERY_HOME as string, "app");
		damage(app, "0.6.0");
		const before = readdirSync(join(app, "0.6.0"));
		failRename = (from, to) => from.includes("/.staging-") && to === join(app, "0.6.0");
		expect(() => installFrom({ from: fixtureRelease("0.6.0"), env })).toThrow(/rename refused/);
		failRename = undefined;
		expect(readdirSync(join(app, "0.6.0"))).toEqual(before);
		expect(readlinkSync(join(app, "current"))).toBe("0.6.0");
		expect(readdirSync(app).filter((n) => n.startsWith(".staging-"))).toEqual([]);
	});
});
