import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { cleanEnv } from "./support.ts";

describe("cleanEnv", () => {
	it("gives the processes tests start a scratch HOME, never the user's, unless the test names one", () => {
		const home = cleanEnv({}).HOME!;
		expect(home).not.toBe(homedir());
		expect(home.startsWith(tmpdir())).toBe(true);
		expect(existsSync(home)).toBe(true);
		expect(cleanEnv({ ORRERY_CONFIG: "/c" }).HOME).toBe(home);
		expect(cleanEnv({ HOME: "/scratch/named" }).HOME).toBe("/scratch/named");
	});
});
