/**
 * Two processes claiming one ORRERY_AGENT_TOKEN at the same moment (src/lane/pick.ts claimToken). Each test runs the
 * second claim at an instant inside the first: between making its claim's file and publishing it (its link), or, for a
 * dead claim both would take over, at the first one's rename of that claim away. Exactly one must hold the token, and
 * the other must know it does not.
 */

import { existsSync, mkdirSync, mkdtempSync, type PathLike, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claimToken, newToken } from "../../src/lane/pick.ts";

/** Runs before a link or a rename (the hook clears itself first when it must not run again). */
const hook = vi.hoisted(() => ({
	beforeLink: undefined as ((source: string, target: string) => void) | undefined,
	beforeRename: undefined as ((source: string, target: string) => void) | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return {
		...fs,
		default: fs,
		linkSync: (source: PathLike, target: PathLike) => {
			hook.beforeLink?.(String(source), String(target));
			return fs.linkSync(source, target);
		},
		renameSync: (source: PathLike, target: PathLike) => {
			hook.beforeRename?.(String(source), String(target));
			return fs.renameSync(source, target);
		},
	};
});

/** A hook that runs `run` once, at the first call, and never again (nor inside `run`). */
const once = (slot: "beforeLink" | "beforeRename", run: () => void) => {
	hook[slot] = () => {
		hook[slot] = undefined;
		run();
	};
};

const dirs: string[] = [];
afterEach(() => {
	hook.beforeLink = undefined;
	hook.beforeRename = undefined;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const [first, second, gone] = [1001, 1002, 4243];
const alive = (pid: number) => pid === first || pid === second;

function lane() {
	const dir = mkdtempSync(join(tmpdir(), "orrery-claim-race-"));
	dirs.push(dir);
	mkdirSync(join(dir, "claims"));
	return dir;
}

/** Exactly one of the two holds the token, the claim names it, and nothing half-made or dead is left behind. */
function oneWinner(dir: string, token: string, mine: boolean, other: boolean | undefined) {
	expect(other).toBeDefined();
	expect([mine, other].filter((won) => won === true)).toHaveLength(1);
	expect(readFileSync(join(dir, "claims", token), "utf8")).toBe(`${mine ? first : second}\n`);
	expect(readdirSync(join(dir, "claims"))).toEqual([token]);
}

describe("claimToken, two claims at once", () => {
	it("a claim being made is never pruned as dead: exactly one of the two holds the token", () => {
		const dir = lane();
		const token = newToken();
		let other: boolean | undefined;
		once("beforeLink", () => {
			other = claimToken(dir, token, second, alive);
		});
		const mine = claimToken(dir, token, first, alive);
		oneWinner(dir, token, mine, other);
	});

	/**
	 * A dead claim that appears after the first claimer's prune, so its link fails and it takes the claim over: at its
	 * rename of the dead claim away, the second claimer runs whole. With `plants` of 1 the second prunes the dead claim
	 * and claims fresh; with 2 the dead claim appears before the second's link too, so both take the same dead claim
	 * over. Either way the first's rename then meets the second's live claim, not the dead one it judged.
	 */
	for (const plants of [1, 2]) {
		it(`two takers of one dead claim (${plants === 1 ? "one takes it over, one claims fresh" : "both take it over"}): exactly one wins, and the other knows`, () => {
			const dir = lane();
			const token = newToken();
			const claim = join(dir, "claims", token);
			let left = plants;
			hook.beforeLink = (source, target) => {
				if (target === claim && !existsSync(claim) && left > 0) {
					left -= 1;
					writeFileSync(claim, `${gone}\n`);
				}
			};
			let other: boolean | undefined;
			once("beforeRename", () => {
				other = claimToken(dir, token, second, alive);
			});
			const mine = claimToken(dir, token, first, alive);
			expect(left).toBe(0);
			oneWinner(dir, token, mine, other);
		});
	}

	it("a taker whose rename moves a live claim made since its judgment (another's whole takeover ran between) puts it back, and does not own the token", () => {
		const dir = lane();
		const token = newToken();
		const claim = join(dir, "claims", token);
		once("beforeLink", () => writeFileSync(claim, `${gone}\n`));
		once("beforeRename", () => {
			// The other taker's whole takeover, between this one's judgment and its rename.
			renameSync(claim, `${claim}.dead-000000000000`);
			rmSync(`${claim}.dead-000000000000`);
			writeFileSync(claim, `${second}\n`);
		});
		expect(claimToken(dir, token, first, alive)).toBe(false);
		expect(readFileSync(claim, "utf8")).toBe(`${second}\n`);
		expect(readdirSync(join(dir, "claims"))).toEqual([token]);
	});
});
