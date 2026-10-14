import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NO_AGENT, noteSession, sessionStanding, settleVisit } from "../../src/lane/session-owner.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function data(): string {
	const dir = mkdtempSync(join(tmpdir(), "orrery-owners-"));
	dirs.push(dir);
	return dir;
}

const hash = (id: string) => createHash("sha256").update(id).digest("hex");
const record = (dir: string, id: string) => join(dir, "session-owners", hash(id));

describe("session owners", () => {
	it("the first agent to see a session owns it: its name only, in a file named by the id's sha256, 600 in a 700 folder", () => {
		const dir = data();
		noteSession(dir, "s1", "Atlas");
		expect(readFileSync(record(dir, "s1"), "utf8")).toBe("Atlas\n");
		expect(statSync(record(dir, "s1")).mode & 0o777).toBe(0o600);
		expect(statSync(join(dir, "session-owners")).mode & 0o777).toBe(0o700);
		noteSession(dir, "s1", "Birch");
		expect(readFileSync(record(dir, "s1"), "utf8")).toBe("Atlas\n");
		expect(sessionStanding(dir, "s1", "Birch")).toBe("foreign");
	});

	it("the owner records its session from the tail after another agent ran in it, until the visit is settled", () => {
		const dir = data();
		noteSession(dir, "s1", "Atlas");
		expect(sessionStanding(dir, "s1", "Atlas")).toBe("own");
		noteSession(dir, "s1", "Birch");
		expect(readFileSync(`${record(dir, "s1")}.visited`, "utf8")).toBe("");
		// The mark stays until the tail is written (a failed write leaves it for the next open).
		expect(sessionStanding(dir, "s1", "Atlas")).toBe("visited");
		expect(sessionStanding(dir, "s1", "Atlas")).toBe("visited");
		settleVisit(dir, "s1");
		expect(sessionStanding(dir, "s1", "Atlas")).toBe("own");
		// Noting the visit again while it is marked changes nothing; after it is settled, a later turn marks it again.
		noteSession(dir, "s1", "Birch");
		noteSession(dir, "s1", "Birch");
		expect(sessionStanding(dir, "s1", "Atlas")).toBe("visited");
	});

	it("a session under an ORRERY_AGENT that names no agent is foreign to every lane", () => {
		const dir = data();
		noteSession(dir, "s1", NO_AGENT);
		expect(readFileSync(record(dir, "s1"), "utf8")).toBe("-\n");
		expect(sessionStanding(dir, "s1", "Atlas")).toBe("foreign");
		expect(sessionStanding(dir, "s1", "Birch")).toBe("foreign");
	});

	it("a session without a record (from before records, or an empty record) is the lane's own: as before", () => {
		const dir = data();
		expect(sessionStanding(dir, "legacy", "Atlas")).toBe("own");
		noteSession(dir, "other", "Atlas");
		writeFileSync(record(dir, "empty"), "");
		expect(sessionStanding(dir, "empty", "Atlas")).toBe("own");
	});

	it("records any id pi takes (dots, any length, path-like), only ever inside session-owners; no id names a mark", () => {
		const dir = data();
		const ids = ["s.x", "x".repeat(300), "../escape", "a/b", ".", ".."];
		for (const id of ids) noteSession(dir, id, "Atlas");
		for (const id of ids) expect(sessionStanding(dir, id, "Birch")).toBe("foreign");
		expect(readdirSync(dir)).toEqual(["session-owners"]);
		expect(readdirSync(join(dir, "session-owners")).sort()).toEqual(ids.map(hash).sort());
		// An id ending in .visited is a session of its own, not another session's mark.
		noteSession(dir, "s1", "Atlas");
		noteSession(dir, "s1.visited", "Birch");
		expect(sessionStanding(dir, "s1", "Atlas")).toBe("own");
		// An empty id has no record.
		noteSession(dir, "", "Atlas");
		expect(sessionStanding(dir, "", "Birch")).toBe("own");
	});

	it("when the data folder cannot be written there is no record, and the session is copied as before (never all tailed)", () => {
		const dir = data();
		const locked = join(dir, "data");
		mkdirSync(locked);
		chmodSync(locked, 0o500);
		try {
			noteSession(locked, "s1", "Atlas");
			noteSession(locked, "s1", "Birch");
			expect(existsSync(join(locked, "session-owners"))).toBe(false);
			expect(sessionStanding(locked, "s1", "Birch")).toBe("own");
		} finally {
			chmodSync(locked, 0o700);
		}
	});
});
