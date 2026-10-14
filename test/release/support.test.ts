import { describe, expect, it } from "vitest";
import { assertBunWhenRequired, assertPiWhenRequired } from "./support.ts";

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
