import { describe, expect, it } from "vitest";
import { leaveHostEnv } from "../../src/agent/host-env.ts";
import { HOST_ENV } from "../../src/agent/sessions.ts";

describe("the host pid a session leaves its shell (ORRERY_HOST)", () => {
	it("sets it, and the undo puts back what was there, once", () => {
		const env: NodeJS.ProcessEnv = {};
		const undo = leaveHostEnv(41, env);
		expect(env[HOST_ENV]).toBe("41");
		undo();
		expect(HOST_ENV in env).toBe(false);
		const before: NodeJS.ProcessEnv = { [HOST_ENV]: "7" };
		const again = leaveHostEnv(41, before);
		again();
		expect(before[HOST_ENV]).toBe("7");
		before[HOST_ENV] = "9";
		again();
		expect(before[HOST_ENV]).toBe("9");
	});

	it("leaves a value another session in this process set since; two sessions of one process end with none, in either order", () => {
		const env: NodeJS.ProcessEnv = {};
		const first = leaveHostEnv(41, env);
		env[HOST_ENV] = "52";
		first();
		expect(env[HOST_ENV]).toBe("52");
		for (const order of [["a", "b"], ["b", "a"]]) {
			const same: NodeJS.ProcessEnv = {};
			const undo: Record<string, () => void> = { a: leaveHostEnv(41, same), b: leaveHostEnv(41, same) };
			for (const key of order) undo[key]!();
			expect(HOST_ENV in same).toBe(false);
		}
	});
});
