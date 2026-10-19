import { describe, expect, it } from "vitest";
import { bunFits } from "../../scripts/build-release.ts";
import { assertBunWhenRequired, assertPiWhenRequired } from "./support.ts";

describe("which Bun may build", () => {
	it("a local build takes the pinned Bun or a newer one, never an older or unreadable one", () => {
		for (const v of ["1.4.2", "1.4.3", "1.5.0", "2.0.0", "1.4.10", "1.4.3-canary.1+abc"]) expect(bunFits(v, false, "1.4.2"), v).toBe(true);
		for (const v of ["1.4.1", "1.3.9", "0.9.9", "", "bun", "1.4"]) expect(bunFits(v, false, "1.4.2"), v).toBe(false);
	});
	it("an official release takes only the pinned Bun", () => {
		expect(bunFits("1.4.2", true, "1.4.2")).toBe(true);
		for (const v of ["1.4.3", "1.4.1", "1.4.2-canary.1"]) expect(bunFits(v, true, "1.4.2"), v).toBe(false);
	});
});

describe("ORRERY_REQUIRE_BUN", () => {
	it("throws, naming the pinned version, when Bun is required and not ready", () => {
		expect(() => assertBunWhenRequired({ ORRERY_REQUIRE_BUN: "1" }, false, "9.9.9")).toThrow(/9\.9\.9/);
	});
	it("does nothing when Bun is ready, or when it is not required", () => {
		expect(() => assertBunWhenRequired({ ORRERY_REQUIRE_BUN: "1" }, true, "9.9.9")).not.toThrow();
		expect(() => assertBunWhenRequired({}, false, "9.9.9")).not.toThrow();
	});
});

describe("ORRERY_REQUIRE_PI", () => {
	it("throws when pi is required and not found", () => {
		expect(() => assertPiWhenRequired({ ORRERY_REQUIRE_PI: "1" }, null)).toThrow(/node_modules\/\.bin\/pi/);
	});
	it("does nothing when pi is found, or when it is not required", () => {
		expect(() => assertPiWhenRequired({ ORRERY_REQUIRE_PI: "1" }, "/x/pi")).not.toThrow();
		expect(() => assertPiWhenRequired({}, null)).not.toThrow();
	});
});
