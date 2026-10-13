import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sessionDir } from "../../src/claude/paths.ts";
import { dropEventsSince, eventName, listSessions, pendingEvents, readEvent, readMode, spoolEvent, writeMode } from "../../src/claude/spool.ts";
import { cleanupDirs, testLane } from "./support.ts";

afterEach(cleanupDirs);

describe("the spool", () => {
	it("names events so they sort in arrival order and never collide, and writes them private", () => {
		const t = testLane();
		const a = spoolEvent(t.lane.dir, "s1", { kind: "prompt", at: 1_000, claudePid: 7, text: "first" });
		const b = spoolEvent(t.lane.dir, "s1", { kind: "prompt", at: 1_000, claudePid: 7, text: "same millisecond" });
		const c = spoolEvent(t.lane.dir, "s1", { kind: "reply", at: 999, claudePid: 7, text: "earlier" });
		expect(a).toMatch(/^000000000001000-\d{10}-\d{6}-prompt\.json$/);
		expect([a, b, c].sort()).toEqual([c, a, b]);
		expect(pendingEvents(t.lane.dir, "s1").map((e) => [e.name, e.at])).toEqual([[c, 999], [a, 1000], [b, 1000]]);
		expect(readEvent(join(sessionDir(t.lane.dir, "s1"), b))).toEqual({ kind: "prompt", at: 1_000, claudePid: 7, text: "same millisecond" });
		expect(statSync(join(sessionDir(t.lane.dir, "s1"), a)).mode & 0o777).toBe(0o600);
		expect(statSync(sessionDir(t.lane.dir, "s1")).mode & 0o777).toBe(0o700);
		expect(readdirSync(sessionDir(t.lane.dir, "s1")).filter((name) => name.startsWith("."))).toEqual([]);
	});

	it("refuses a session id that could leave the spool, and lists only real sessions", () => {
		const t = testLane();
		expect(() => spoolEvent(t.lane.dir, "../escape", { kind: "end", at: 1, claudePid: 1 })).toThrow(/session id/);
		spoolEvent(t.lane.dir, "s1", { kind: "end", at: 1, claudePid: 1 });
		expect(listSessions(t.lane.dir)).toEqual(["s1"]);
	});

	it("reads back only well-formed events, and removes those at or before the cursor", () => {
		const t = testLane();
		const one = spoolEvent(t.lane.dir, "s1", { kind: "prompt", at: 1, claudePid: 1, text: "one" });
		spoolEvent(t.lane.dir, "s1", { kind: "prompt", at: 2, claudePid: 1, text: "two" });
		const bad = join(sessionDir(t.lane.dir, "s1"), eventName(3, "reply"));
		writeFileSync(bad, '{"kind":"reply"}');
		expect(readEvent(bad)).toBeUndefined();
		// A time no date can hold would make the memory refuse the event on every look, and hold up every event after it.
		writeFileSync(bad, '{"kind":"reply","at":1e300,"claudePid":1,"text":"x"}');
		expect(readEvent(bad)).toBeUndefined();
		expect(pendingEvents(t.lane.dir, "s1", one).map((e) => readEvent(e.path)?.kind ?? "bad")).toEqual(["prompt", "bad"]);
		expect(pendingEvents(t.lane.dir, "s1").length).toBe(2);
	});

	it("keeps the mode a session's holder chose, and drops only what came after a turn to read-only", () => {
		const t = testLane();
		spoolEvent(t.lane.dir, "s1", { kind: "prompt", at: 100, claudePid: 1, text: "while recording" });
		spoolEvent(t.lane.dir, "s1", { kind: "prompt", at: 300, claudePid: 1, text: "while undecided" });
		writeMode(t.lane.dir, "s1", { mode: "read-only", pid: 5, claudePid: 1, nonce: "n", since: 200, reason: "held" });
		dropEventsSince(t.lane.dir, "s1", 200);
		expect(readMode(t.lane.dir, "s1")).toEqual({ mode: "read-only", pid: 5, claudePid: 1, nonce: "n", since: 200, reason: "held" });
		expect(pendingEvents(t.lane.dir, "s1").map((e) => e.at)).toEqual([100]);
		expect(readMode(t.lane.dir, "s2")).toBeUndefined();
	});
});
