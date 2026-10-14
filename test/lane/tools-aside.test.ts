import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Only this file's view of node:fs is wrapped; `failRename` picks the renames that should fail.
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

const { installSteps, piExtensionFile, runInstall } = await import("../../src/lane/tools.ts");

const dirs: string[] = [];
afterEach(() => {
	failRename = undefined;
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const FOREIGN = "// someone's own extension\nexport default () => {};\n";

function foreignPi() {
	const home = mkdtempSync(join(tmpdir(), "orrery-aside-"));
	dirs.push(home);
	const env = { PATH: "", HOME: home } as NodeJS.ProcessEnv;
	const file = piExtensionFile(env);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, FOREIGN);
	const steps = installSteps({ id: "pi", label: "pi", wiring: "other", detail: "x" }, "/opt/orrery/app/current", env);
	return { file, steps, names: () => readdirSync(dirname(file)).filter((n) => n.startsWith(basename(file))) };
}

describe("a foreign extension file that cannot be set aside or replaced", () => {
	it("says the set-aside failed, and leaves the file where it was", () => {
		const { file, steps, names } = foreignPi();
		failRename = (_from, to) => to.includes(".before-orrery-");
		const result = runInstall(steps);
		expect(result.ok).toBe(false);
		expect(result.problem).toBe(`could not set ${file} aside: rename refused`);
		expect(result.output).toContain(`could not set ${file} aside: rename refused`);
		expect(readFileSync(file, "utf8")).toBe(FOREIGN);
		expect(names()).toEqual([basename(file)]);
	});

	it("puts the original back when the final rename fails", () => {
		const { file, steps, names } = foreignPi();
		failRename = (from, to) => from.includes(".tmp-") && to === file;
		const result = runInstall(steps);
		expect(result.ok).toBe(false);
		expect(result.output).toContain("the original was put back");
		expect(readFileSync(file, "utf8")).toBe(FOREIGN);
		expect(names()).toEqual([basename(file)]);
	});

	it("names the copy when it cannot be put back either", () => {
		const { file, steps, names } = foreignPi();
		failRename = (from, to) => (from.includes(".tmp-") && to === file) || (from.includes(".before-orrery-") && to === file);
		const result = runInstall(steps);
		expect(result.ok).toBe(false);
		const aside = names().find((n) => n.includes(".before-orrery-")) as string;
		expect(result.output).toContain(`the original is at ${join(dirname(file), aside)}`);
		expect(readFileSync(join(dirname(file), aside), "utf8")).toBe(FOREIGN);
	});
});
