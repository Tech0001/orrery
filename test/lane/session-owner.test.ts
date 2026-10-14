import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { foreignSession, NO_AGENT, noteSession } from "../../src/lane/session-owner.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function data(): string {
	const dir = mkdtempSync(join(tmpdir(), "orrery-owners-"));
	dirs.push(dir);
	return dir;
}

describe("session owners", () => {
	it("the first agent to see a session owns it: its name only, file 600 in a 700 folder; a later one leaves the record", () => {
		const dir = data();
		noteSession(dir, "s1", "Atlas");
		const file = join(dir, "session-owners", "s1");
		expect(readFileSync(file, "utf8")).toBe("Atlas\n");
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(statSync(join(dir, "session-owners")).mode & 0o777).toBe(0o700);
		noteSession(dir, "s1", "Birch");
		expect(readFileSync(file, "utf8")).toBe("Atlas\n");
		expect(foreignSession(dir, "s1", "Birch")).toBe(true);
	});

	it("the owner records its session from the tail once after another agent ran in it, then as usual", () => {
		const dir = data();
		noteSession(dir, "s1", "Atlas");
		expect(foreignSession(dir, "s1", "Atlas")).toBe(false);
		noteSession(dir, "s1", "Birch");
		expect(foreignSession(dir, "s1", "Atlas")).toBe(true);
		expect(foreignSession(dir, "s1", "Atlas")).toBe(false);
	});

	it("a session under an ORRERY_AGENT that names no agent is foreign to every lane", () => {
		const dir = data();
		noteSession(dir, "s1", NO_AGENT);
		expect(readFileSync(join(dir, "session-owners", "s1"), "utf8")).toBe("-\n");
		expect(foreignSession(dir, "s1", "Atlas")).toBe(true);
		expect(foreignSession(dir, "s1", "Birch")).toBe(true);
	});

	it("a session without a record (from before records, or an empty record) is not foreign: as before", () => {
		const dir = data();
		expect(foreignSession(dir, "legacy", "Atlas")).toBe(false);
		noteSession(dir, "other", "Atlas");
		writeFileSync(join(dir, "session-owners", "empty"), "");
		expect(foreignSession(dir, "empty", "Atlas")).toBe(false);
	});

	it("an id that is no safe file name has no record, and nothing is written for it", () => {
		const dir = data();
		for (const id of ["../escape", "a/b", "", ".", "s1.visited", "x".repeat(129)]) {
			noteSession(dir, id, "Atlas");
			expect(foreignSession(dir, id, "Birch")).toBe(false);
		}
		expect(existsSync(join(dir, "session-owners"))).toBe(false);
		expect(readdirSync(dir)).toEqual([]);
	});
});
