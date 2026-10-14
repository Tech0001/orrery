/**
 * A filesystem without hard links (FAT, exFAT, some network and FUSE mounts): every link fails with EPERM. Claims
 * (src/lane/pick.ts claimToken) and Claude Code's process records (src/claude/pick.ts claudeSession) are then made by
 * an exclusive create and a write (src/lane/exclusive.ts publish), and stay exclusive: a second claimer loses, even in
 * the moment the first's claim exists but is still empty.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeSession } from "../../src/claude/pick.ts";
import { claimToken, newToken } from "../../src/lane/pick.ts";
import { cleanupDirs, testLane } from "../claude/support.ts";

/** Runs once, before the first write into a file made by the exclusive create (the fallback's empty moment). */
const hook = vi.hoisted(() => ({ beforeWrite: undefined as (() => void) | undefined }));

vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return {
		...fs,
		default: fs,
		linkSync: () => {
			throw Object.assign(new Error("EPERM: operation not permitted, link"), { code: "EPERM" });
		},
		writeSync: (...args: Parameters<typeof fs.writeSync>) => {
			const before = hook.beforeWrite;
			hook.beforeWrite = undefined;
			before?.();
			return fs.writeSync(...args);
		},
	};
});

const dirs: string[] = [];
afterEach(() => {
	hook.beforeWrite = undefined;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	cleanupDirs();
});

const [first, second, gone] = [1001, 1002, 4243];
const alive = (pid: number) => pid === first || pid === second;

function lane() {
	const dir = mkdtempSync(join(tmpdir(), "orrery-no-links-"));
	dirs.push(dir);
	return dir;
}

describe("without hard links", () => {
	it("a claim is still exclusive: the first claimer holds the token, a second loses, a dead claim is taken over", () => {
		const dir = lane();
		const token = newToken();
		expect(claimToken(dir, token, first, alive)).toBe(true);
		expect(readFileSync(join(dir, "claims", token), "utf8")).toBe(`${first}\n`);
		expect(claimToken(dir, token, second, alive)).toBe(false);
		expect(claimToken(dir, token, first, alive)).toBe(true);
		expect(readdirSync(join(dir, "claims"))).toEqual([token]);
		const dead = newToken();
		writeFileSync(join(dir, "claims", dead), `${gone}\n`);
		expect(claimToken(dir, dead, second, alive)).toBe(true);
		expect(readFileSync(join(dir, "claims", dead), "utf8")).toBe(`${second}\n`);
	});

	it("a claim made but not yet written is one being made: a second claimer at that moment loses", () => {
		const dir = lane();
		const token = newToken();
		let other: boolean | undefined;
		hook.beforeWrite = () => {
			other = claimToken(dir, token, second, alive);
		};
		expect(claimToken(dir, token, first, alive)).toBe(true);
		expect(other).toBe(false);
		expect(readFileSync(join(dir, "claims", token), "utf8")).toBe(`${first}\n`);
		expect(readdirSync(join(dir, "claims"))).toEqual([token]);
	});

	it("a Claude Code process's record is still written, and read by its later events", () => {
		const t = testLane();
		const dir = lane();
		const env = { ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: newToken() };
		expect(claudeSession(t.config, { env, cwd: dir, pid: process.pid, decide: true })).toMatchObject({ kind: "lane", by: "env", lane: { name: "Test" } });
		const records = join(t.config.dataDir, "claude-processes");
		expect(readdirSync(records)).toEqual([`${process.pid}.json`]);
		expect(JSON.parse(readFileSync(join(records, `${process.pid}.json`), "utf8"))).toMatchObject({ kind: "lane", name: "Test", by: "env" });
		expect(claudeSession(t.config, { env, cwd: t.workspace, pid: process.pid, decide: false })).toMatchObject({ kind: "lane", lane: { name: "Test" } });
		// A stale record (another identity's) is still replaced.
		mkdirSync(records, { recursive: true });
		writeFileSync(join(records, `${process.pid}.json`), JSON.stringify({ agent: "Birch", token: "", kind: "none" }));
		expect(claudeSession(t.config, { env, cwd: dir, pid: process.pid, decide: true })).toMatchObject({ kind: "lane", lane: { name: "Test" } });
		expect(JSON.parse(readFileSync(join(records, `${process.pid}.json`), "utf8"))).toMatchObject({ agent: "Test", kind: "lane" });
		expect(readdirSync(records)).toEqual([`${process.pid}.json`]);
	});
});
