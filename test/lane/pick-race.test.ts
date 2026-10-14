/**
 * Two processes claiming one ORRERY_AGENT_TOKEN at the same moment (src/lane/pick.ts claimToken). The test runs the
 * second claim at the instant the first has made its claim's file but not yet published its pid in it: inside the
 * first one's pid write (an exclusive create, then the write) or its publication (a whole temporary file, then a link).
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claimToken, newToken } from "../../src/lane/pick.ts";

/** Runs once, at the first claim's moment between making its file and publishing its pid. */
const hook = vi.hoisted(() => ({ between: undefined as (() => void) | undefined }));

vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	const first = <A extends unknown[], R>(call: (...args: A) => R) => (...args: A): R => {
		const between = hook.between;
		hook.between = undefined;
		between?.();
		return call(...args);
	};
	return { ...fs, default: fs, writeSync: first(fs.writeSync), linkSync: first(fs.linkSync) };
});

const dirs: string[] = [];
afterEach(() => {
	hook.between = undefined;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("claimToken, two claims at once", () => {
	it("a claim being made is never pruned as dead: exactly one of the two holds the token", () => {
		const lane = mkdtempSync(join(tmpdir(), "orrery-claim-race-"));
		dirs.push(lane);
		const token = newToken();
		const [first, second] = [1001, 1002];
		const alive = (pid: number) => pid === first || pid === second;
		let other: boolean | undefined;
		hook.between = () => {
			other = claimToken(lane, token, second, alive);
		};
		const mine = claimToken(lane, token, first, alive);
		expect(other).toBeDefined();
		expect([mine, other].filter((won) => won === true)).toHaveLength(1);
		expect(readFileSync(join(lane, "claims", token), "utf8")).toBe(`${mine ? first : second}\n`);
		// Nothing half-made is left behind.
		expect(readdirSync(join(lane, "claims"))).toEqual([token]);
	});
});
