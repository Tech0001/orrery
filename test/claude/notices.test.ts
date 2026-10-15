import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeHolder } from "../../src/agent/handover.ts";
import { summaryNotice, updateNotice } from "../../src/claude/notices.ts";
import { cleanupFakes, releasesServer, scratch } from "../release/fake-releases.ts";
import { cleanupDirs, testAgent } from "./support.ts";

afterEach(cleanupDirs);
afterEach(cleanupFakes);

function status(dir: string, trouble: object | null) {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "status.json"), JSON.stringify({ trouble }));
}

describe("summaryNotice", () => {
	it("tells the user once when summaries start failing and once when they recover, per session", () => {
		const t = testAgent();
		status(t.agent.dir, null);
		expect(summaryNotice(t.agent, "s1")).toBeUndefined();
		status(t.agent.dir, { state: "failing", plain: "OpenRouter refused the key" });
		expect(summaryNotice(t.agent, "s1")).toBe(
			"Orrery: Test's summaries are failing: OpenRouter refused the key. They keep retrying; nothing is lost. Switch with /orrery:compactor.",
		);
		expect(summaryNotice(t.agent, "s1")).toBeUndefined();
		expect(summaryNotice(t.agent, "s2")).toMatch(/are failing/); // a new session hears it once too
		expect(statSync(join(t.agent.dir, "claude")).mode & 0o777).toBe(0o700);
		status(t.agent.dir, null);
		expect(summaryNotice(t.agent, "s2")).toBe("Orrery: Test's summaries are working again.");
	});

	it("stays silent when only the reason changes", () => {
		const t = testAgent();
		status(t.agent.dir, { state: "failing", plain: "a" });
		expect(summaryNotice(t.agent, "s1")).toMatch(/failing: a\./);
		status(t.agent.dir, { state: "failing", plain: "b" });
		expect(summaryNotice(t.agent, "s1")).toBeUndefined();
	});

	it("says nothing without a readable status file", () => {
		const t = testAgent();
		expect(summaryNotice(t.agent, "s1")).toBeUndefined();
	});
});

const AVAILABLE = "Orrery 0.6.1 is available. Run `orrery update`, then restart this session.";
const UPDATED = "Orrery was updated to 0.6.1; restart this session to use it.";

/** An Orrery home with `installed` as app/current and, if given, `latest` as the cached answer checked at `checkedAt`. */
function orreryHome(installed: string, latest?: string, checkedAt = Date.now()): string {
	const home = scratch();
	mkdirSync(join(home, "app", installed), { recursive: true });
	writeFileSync(join(home, "app", installed, "VERSION"), `${installed}\n`);
	symlinkSync(installed, join(home, "app", "current"));
	if (latest !== undefined) writeFileSync(join(home, "update-check.json"), JSON.stringify({ checkedAt, latest }));
	return home;
}

/** This session's recorder, beating now, running `version`. */
const recorder = (dir: string, session: string, version: string, updatedAt = Date.now()) =>
	writeHolder(dir, { pid: 1, session, claudePid: 4242, state: "recording", startedAt: updatedAt, updatedAt, version });

describe("updateNotice", () => {
	it("tells each session once that a newer release is out", () => {
		const t = testAgent();
		const env = { ORRERY_HOME: orreryHome("0.6.0", "0.6.1") };
		expect(updateNotice(t.agent, "s1", env, true)).toBe(AVAILABLE);
		expect(updateNotice(t.agent, "s1", env, true)).toBeUndefined();
		expect(updateNotice(t.agent, "s2", env, true)).toBe(AVAILABLE);
		expect(updateNotice(t.agent, "s1", env, true)).toBeUndefined();
		expect(statSync(join(t.agent.dir, "claude", "update-notices.json")).mode & 0o777).toBe(0o600);
	});

	it("tells the session once that Orrery was updated when its own recorder runs another build", () => {
		const t = testAgent();
		const env = { ORRERY_HOME: orreryHome("0.6.1") };
		recorder(t.agent.dir, "s1", "0.6.0-219a227");
		expect(updateNotice(t.agent, "s1", env, true)).toBe(UPDATED);
		expect(updateNotice(t.agent, "s1", env, true)).toBeUndefined();
		// another session's recorder, or one that stopped beating, says nothing of this one
		expect(updateNotice(t.agent, "s2", env, true)).toBeUndefined();
		recorder(t.agent.dir, "s3", "0.6.0", Date.now() - 60_000);
		expect(updateNotice(t.agent, "s3", env, true)).toBeUndefined();
		// with checks off too: it needs no network
		recorder(t.agent.dir, "s4", "0.6.0");
		expect(updateNotice(t.agent, "s4", env, false)).toBe(UPDATED);
	});

	it("says both when a release came out after the update, and nothing of a release with checks off", () => {
		const t = testAgent();
		recorder(t.agent.dir, "s1", "0.6.0");
		expect(updateNotice(t.agent, "s1", { ORRERY_HOME: orreryHome("0.6.1", "0.6.2") }, true)).toBe(`${UPDATED}\nOrrery 0.6.2 is available. Run \`orrery update\`, then restart this session.`);
		expect(updateNotice(t.agent, "s2", { ORRERY_HOME: orreryHome("0.6.0", "0.6.1") }, false)).toBeUndefined();
	});

	it("never asks the network, even with a day-old answer", async () => {
		const t = testAgent();
		const { base, hits } = await releasesServer("0.6.2", {});
		const home = orreryHome("0.6.0", "0.6.1", Date.now() - 3 * 86_400_000);
		const before = readFileSync(join(home, "update-check.json"), "utf8");
		expect(updateNotice(t.agent, "s1", { ORRERY_HOME: home, ORRERY_RELEASES_URL: base }, true)).toBe(AVAILABLE);
		await new Promise((done) => setTimeout(done, 100));
		expect(hits).toEqual([]);
		expect(readFileSync(join(home, "update-check.json"), "utf8")).toBe(before);
		expect(existsSync(join(home, "update-check.json.lock"))).toBe(false);
	});
});
