import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { summaryNotice } from "../../src/claude/notices.ts";
import { cleanupDirs, testLane } from "./support.ts";

afterEach(cleanupDirs);

function status(dir: string, trouble: object | null) {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "status.json"), JSON.stringify({ trouble }));
}

describe("summaryNotice", () => {
	it("tells the user once when summaries start failing and once when they recover, per session", () => {
		const t = testLane();
		status(t.lane.dir, null);
		expect(summaryNotice(t.lane, "s1")).toBeUndefined();
		status(t.lane.dir, { state: "failing", plain: "OpenRouter refused the key" });
		expect(summaryNotice(t.lane, "s1")).toBe(
			"Orrery: Test's summaries are failing: OpenRouter refused the key. They keep retrying; nothing is lost. Switch with /orrery:compactor.",
		);
		expect(summaryNotice(t.lane, "s1")).toBeUndefined();
		expect(summaryNotice(t.lane, "s2")).toMatch(/are failing/); // a new session hears it once too
		expect(statSync(join(t.lane.dir, "claude")).mode & 0o777).toBe(0o700);
		status(t.lane.dir, null);
		expect(summaryNotice(t.lane, "s2")).toBe("Orrery: Test's summaries are working again.");
	});

	it("stays silent when only the reason changes", () => {
		const t = testLane();
		status(t.lane.dir, { state: "failing", plain: "a" });
		expect(summaryNotice(t.lane, "s1")).toMatch(/failing: a\./);
		status(t.lane.dir, { state: "failing", plain: "b" });
		expect(summaryNotice(t.lane, "s1")).toBeUndefined();
	});

	it("says nothing without a readable status file", () => {
		const t = testLane();
		expect(summaryNotice(t.lane, "s1")).toBeUndefined();
	});
});
