import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { updateNotices } from "../../src/agent/update-notices.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.parse("2026-10-15T12:00:00Z");

/** A scratch Orrery home with `installed` as app/current and `latest` as the cached answer (checked an hour ago). */
function home(options: { installed?: string; latest?: string; checkedAt?: number } = {}): NodeJS.ProcessEnv {
	const dir = mkdtempSync(join(tmpdir(), "orrery-update-notices-"));
	dirs.push(dir);
	if (options.installed !== undefined) {
		mkdirSync(join(dir, "app", options.installed), { recursive: true });
		writeFileSync(join(dir, "app", options.installed, "VERSION"), `${options.installed}\n`);
		symlinkSync(options.installed, join(dir, "app", "current"));
	}
	if (options.latest !== undefined) writeFileSync(join(dir, "update-check.json"), JSON.stringify({ checkedAt: options.checkedAt ?? NOW - 3600_000, latest: options.latest }));
	// No releases server: a test that made a request would fail on it.
	return { HOME: dir, ORRERY_HOME: dir, ORRERY_RELEASES_URL: "http://127.0.0.1:9/releases" };
}

const texts = (env: NodeJS.ProcessEnv, running: string | undefined, enabled = true) => updateNotices(env, NOW, { enabled, running }).map((n) => n.text);

describe("updateNotices", () => {
	it("says a newer release is out when the cached latest is newer than the installed version", () => {
		expect(texts(home({ installed: "0.6.0", latest: "0.6.1" }), "0.6.0")).toEqual(["Orrery 0.6.1 is available. Run `orrery update`, then restart this session."]);
		expect(texts(home({ installed: "0.6.1", latest: "0.6.1" }), "0.6.1")).toEqual([]);
		// a local build counts as its release
		expect(texts(home({ installed: "0.6.0-219a227", latest: "0.6.1" }), "0.6.0-219a227")).toEqual(["Orrery 0.6.1 is available. Run `orrery update`, then restart this session."]);
		// nothing installed: compared with what runs, and never with a checkout
		expect(texts(home({ latest: "0.6.1" }), "0.6.0")).toHaveLength(1);
		expect(texts(home({ latest: "0.6.1" }), "checkout")).toEqual([]);
	});

	it("says Orrery was updated under the session, with the installed version, and needs no cache", () => {
		expect(texts(home({ installed: "0.6.1" }), "0.6.0")).toEqual(["Orrery was updated to 0.6.1; restart this session to use it."]);
		expect(texts(home({ installed: "0.6.0" }), "0.6.0-219a227")).toEqual(["Orrery was updated to 0.6.0; restart this session to use it."]);
		expect(texts(home({ installed: "0.6.0-bbb2222" }), "0.6.0-aaa1111")).toEqual(["Orrery was updated to 0.6.0-bbb2222; restart this session to use it."]);
		for (const running of ["0.6.1", "0.6.2", "checkout", "unknown", undefined]) expect(texts(home({ installed: "0.6.1" }), running)).toEqual([]);
		expect(texts(home(), "0.6.0")).toEqual([]);
	});

	it("does not say a release is out when the update is already installed, only that the session should restart", () => {
		expect(texts(home({ installed: "0.6.1", latest: "0.6.1" }), "0.6.0")).toEqual(["Orrery was updated to 0.6.1; restart this session to use it."]);
		expect(texts(home({ installed: "0.6.1", latest: "0.6.2" }), "0.6.0")).toEqual([
			"Orrery was updated to 0.6.1; restart this session to use it.",
			"Orrery 0.6.2 is available. Run `orrery update`, then restart this session.",
		]);
	});

	it("with checks off, says nothing of a release but still says Orrery was updated", () => {
		expect(texts(home({ installed: "0.6.0", latest: "0.6.1" }), "0.6.0", false)).toEqual([]);
		expect(texts(home({ installed: "0.6.1", latest: "0.6.2" }), "0.6.0", false)).toEqual(["Orrery was updated to 0.6.1; restart this session to use it."]);
	});

	it("keys each notice by what it says, so a session hears each change once", () => {
		const env = home({ installed: "0.6.1", latest: "0.6.2" });
		expect(updateNotices(env, NOW, { enabled: true, running: "0.6.0" }).map((n) => n.key)).toEqual(["updated:0.6.1", "available:0.6.2"]);
	});

	it("reads a day-old answer too, and never a malformed one", () => {
		expect(texts(home({ installed: "0.6.0", latest: "0.6.1", checkedAt: NOW - 3 * 86_400_000 }), "0.6.0")).toHaveLength(1);
		expect(texts(home({ installed: "0.6.0", latest: "0.6.1; rm -rf ~" }), "0.6.0")).toEqual([]);
	});
});
