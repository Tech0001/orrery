import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cachedUpdate, downloadRelease, latestVersion, needsRestart, newer, platformAsset, refreshUpdateCache, updateCheck } from "../../src/install/update.ts";
import { cliCommand } from "../claude/support.ts";
import { cleanupFakes, PLATFORM, release, releasesServer, scratch, servers } from "../release/fake-releases.ts";

afterEach(cleanupFakes);
afterEach(() => {
	vi.unstubAllGlobals();
});

describe("newer", () => {
	it("compares releases, counting a local build as its release", () => {
		expect(newer("0.6.1", "0.6.0")).toBe(true);
		expect(newer("0.7.0", "0.6.9-abc1234")).toBe(true);
		expect(newer("1.0.0", "0.9.9")).toBe(true);
		expect(newer("0.6.0", "0.6.0-abc1234")).toBe(false);
		expect(newer("0.6.0", "0.6.1")).toBe(false);
	});
});

describe("latestVersion", () => {
	it("reads where /latest redirects", async () => {
		const { base } = await releasesServer("0.6.1", {});
		expect(await latestVersion({ ORRERY_RELEASES_URL: base })).toBe("0.6.1");
	});

	it("rejects a redirect to anything that is not a release tag", async () => {
		const server = createServer((_req, res) => void res.writeHead(302, { location: "http://127.0.0.1:1/elsewhere" }).end());
		servers.push(server);
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/releases`;
		await expect(latestVersion({ ORRERY_RELEASES_URL: base })).rejects.toThrow("could not tell the latest release");
	});
});

describe("downloadRelease", () => {
	it("returns the checked, unpacked release folder", async () => {
		const { base } = await releasesServer("0.6.1", release("0.6.1"));
		const into = join(scratch(), "dl");
		const folder = await downloadRelease({ ORRERY_RELEASES_URL: base }, "0.6.1", into);
		expect(readFileSync(join(folder, "VERSION"), "utf8").trim()).toBe("0.6.1");
	});

	it("refuses a wrong checksum and leaves nothing", async () => {
		const files = release("0.6.1");
		files["0.6.1/SHA256SUMS"] = Buffer.from(`${"0".repeat(64)}  ${platformAsset()}\n`);
		const { base } = await releasesServer("0.6.1", files);
		const into = join(scratch(), "dl");
		await expect(downloadRelease({ ORRERY_RELEASES_URL: base }, "0.6.1", into)).rejects.toThrow("does not match SHA256SUMS");
		expect(existsSync(into)).toBe(false);
	});

	it("refuses SHA256SUMS with no line for this platform", async () => {
		const files = release("0.6.1");
		files["0.6.1/SHA256SUMS"] = Buffer.from(`${"0".repeat(64)}  orrery-other-arch.tar.gz\n`);
		const { base } = await releasesServer("0.6.1", files);
		const into = join(scratch(), "dl");
		await expect(downloadRelease({ ORRERY_RELEASES_URL: base }, "0.6.1", into)).rejects.toThrow("has no line for");
		expect(existsSync(into)).toBe(false);
	});

	it("accepts a redirect whose location has a query or fragment", async () => {
		const { base } = await releasesServer("0.6.1", {}, { query: true });
		expect(await latestVersion({ ORRERY_RELEASES_URL: base })).toBe("0.6.1");
	});

	it("says so when the release does not exist", async () => {
		const { base } = await releasesServer("0.6.1", {});
		const into = join(scratch(), "dl");
		await expect(downloadRelease({ ORRERY_RELEASES_URL: base }, "0.9.9", into)).rejects.toThrow(/^no Orrery release 0\.9\.9 \(http/);
		expect(existsSync(into)).toBe(false);
	});

	it("refuses an archive whose VERSION is not the one asked for", async () => {
		const { base } = await releasesServer("0.6.1", release("0.6.1", undefined, "0.6.2"));
		const into = join(scratch(), "dl");
		await expect(downloadRelease({ ORRERY_RELEASES_URL: base }, "0.6.1", into)).rejects.toThrow("holds Orrery 0.6.2, not 0.6.1");
		expect(existsSync(into)).toBe(false);
	});

	it("keeps going while a slow body keeps arriving, and reports progress", async () => {
		const { base } = await releasesServer("0.6.1", release("0.6.1"), { slow: 120 });
		const into = join(scratch(), "dl");
		const seen: number[] = [];
		const start = Date.now();
		const folder = await downloadRelease({ ORRERY_RELEASES_URL: base }, "0.6.1", into, { idleMs: 400, onProgress: (bytes) => seen.push(bytes) });
		expect(Date.now() - start).toBeGreaterThan(400);
		expect(readFileSync(join(folder, "VERSION"), "utf8").trim()).toBe("0.6.1");
		expect(seen.length).toBeGreaterThan(1);
	});

	it("from an https base, follows https redirects and refuses one to http before requesting it", async () => {
		const files = release("0.6.1");
		const requested: string[] = [];
		// GitHub's way: the asset URL redirects to another https host. One answer below sends the archive to http instead.
		const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const url = String(input);
			requested.push(url);
			const hop = (to: string) => {
				if (init?.redirect === "manual") return new Response(null, { status: 302, headers: { location: to } });
				return fake(to, init); // a fetch that follows by itself
			};
			if (url === "https://releases.invalid/r/download/v0.6.1/SHA256SUMS") return hop("https://objects.invalid/sums");
			if (url === "https://objects.invalid/sums") return new Response(files["0.6.1/SHA256SUMS"]);
			if (url === `https://releases.invalid/r/download/v0.6.1/${platformAsset()}`) return hop("http://objects.invalid/archive");
			if (url === "http://objects.invalid/archive") return new Response(files[`0.6.1/${platformAsset()}`]);
			return new Response(null, { status: 404 });
		};
		vi.stubGlobal("fetch", fake);
		const into = join(scratch(), "dl");
		await expect(downloadRelease({ ORRERY_RELEASES_URL: "https://releases.invalid/r" }, "0.6.1", into)).rejects.toThrow(`https://releases.invalid/r/download/v0.6.1/${platformAsset()} redirects to http://objects.invalid/archive, which is not https; nothing was installed`);
		expect(requested).toContain("https://objects.invalid/sums");
		expect(requested).not.toContain("http://objects.invalid/archive");
		expect(existsSync(into)).toBe(false);
	});

	it("gives up on a server that never answers", async () => {
		const { base } = await releasesServer("0.6.1", release("0.6.1"), { stall: true });
		const into = join(scratch(), "dl");
		const start = Date.now();
		await expect(downloadRelease({ ORRERY_RELEASES_URL: base }, "0.6.1", into, { idleMs: 300 })).rejects.toThrow();
		expect(Date.now() - start).toBeLessThan(1500);
		expect(existsSync(into)).toBe(false);
	});
});

/** Installs `version` under `home` as app/current points to it: a folder with its VERSION. */
function installAt(home: string, version: string): void {
	mkdirSync(join(home, "app", version), { recursive: true });
	writeFileSync(join(home, "app", version, "VERSION"), `${version}\n`);
	symlinkSync(version, join(home, "app", "current"));
}

describe("needsRestart", () => {
	it("is true when a session runs another build than the installed one, unless it runs a newer release", () => {
		expect(needsRestart("0.6.0", "0.6.1")).toBe(true);
		expect(needsRestart("0.6.0-219a227", "0.6.1")).toBe(true);
		// another local build of the same release, and a local build against its release
		expect(needsRestart("0.6.0-aaa1111", "0.6.0-bbb2222")).toBe(true);
		expect(needsRestart("0.6.1-aaa1111", "0.6.1")).toBe(true);
		expect(needsRestart("0.6.1", "0.6.1")).toBe(false);
		// left newer by a rollback
		expect(needsRestart("0.6.2", "0.6.1")).toBe(false);
		for (const [running, installed] of [["checkout", "0.6.1"], ["unknown", "0.6.1"], [undefined, "0.6.1"], ["0.6.0", undefined]]) expect(needsRestart(running, installed)).toBe(false);
	});
});

describe("cachedUpdate and refreshUpdateCache", () => {
	it("reads the cached answer with no request, and refreshes a missing or day-old one", async () => {
		const home = scratch();
		const { base, hits } = await releasesServer("0.6.1", {});
		const env = { ORRERY_HOME: home, ORRERY_RELEASES_URL: base };
		const now = Date.parse("2026-10-15T12:00:00Z");
		expect(cachedUpdate(env, now)).toEqual({ stale: true });
		expect(hits).toEqual([]);
		await refreshUpdateCache(env, now);
		expect(hits).toEqual(["/releases/latest"]);
		expect(cachedUpdate(env, now + 3600_000)).toEqual({ latest: "0.6.1", stale: false });
		await refreshUpdateCache(env, now + 3600_000);
		expect(hits).toHaveLength(1);
		// a day later it is stale, and still says what it knew
		expect(cachedUpdate(env, now + 25 * 3600_000)).toEqual({ latest: "0.6.1", stale: true });
		await refreshUpdateCache(env, now + 25 * 3600_000);
		expect(hits).toHaveLength(2);
	});

	it("makes one request when several processes find the cache stale at once", async () => {
		const home = scratch();
		const { base, hits } = await releasesServer("0.6.1", {});
		const env = { ORRERY_HOME: home, ORRERY_RELEASES_URL: base };
		const now = Date.now();
		await Promise.all([refreshUpdateCache(env, now), refreshUpdateCache(env, now), refreshUpdateCache(env, now)]);
		expect(hits).toEqual(["/releases/latest"]);
		expect(existsSync(join(home, "update-check.json.lock"))).toBe(false);
	});

	it("takes over a lock left by a process that died while asking", async () => {
		const home = scratch();
		const { base, hits } = await releasesServer("0.6.1", {});
		const env = { ORRERY_HOME: home, ORRERY_RELEASES_URL: base };
		writeFileSync(join(home, "update-check.json.lock"), "1");
		const old = new Date(Date.now() - 5 * 60_000);
		utimesSync(join(home, "update-check.json.lock"), old, old);
		await refreshUpdateCache(env, Date.now());
		expect(hits).toEqual(["/releases/latest"]);
		expect(cachedUpdate(env, Date.now()).latest).toBe("0.6.1");
	});

	it("keeps the last answer when the server is down, and does not ask again that day", async () => {
		const home = scratch();
		const now = Date.parse("2026-10-15T12:00:00Z");
		writeFileSync(join(home, "update-check.json"), JSON.stringify({ checkedAt: now - 2 * 86_400_000, latest: "0.6.1" }));
		const { base, server } = await releasesServer("0.6.2", {});
		server.closeAllConnections();
		await new Promise<void>((done) => server.close(() => done()));
		const env = { ORRERY_HOME: home, ORRERY_RELEASES_URL: base };
		await refreshUpdateCache(env, now);
		expect(cachedUpdate(env, now + 1000)).toEqual({ latest: "0.6.1", stale: false });
	});
});

describe("updateCheck", () => {
	it("checks once a day, caches, and says nothing when already current", async () => {
		const home = scratch();
		const { base, hits } = await releasesServer("0.6.1", {});
		const env = { ORRERY_HOME: home, ORRERY_RELEASES_URL: base };
		const now = Date.parse("2026-10-13T12:00:00Z");
		const on = { enabled: true, running: "0.6.0" };
		expect(await updateCheck(env, now, on)).toBe("0.6.1 available · run orrery update");
		expect(hits).toEqual(["/releases/latest"]);
		expect(statSync(join(home, "update-check.json")).mode & 0o777).toBe(0o600);
		expect(await updateCheck(env, now + 3600_000, on)).toBe("0.6.1 available · run orrery update");
		expect(hits).toHaveLength(1);
		expect(await updateCheck(env, now + 3600_000, { enabled: true, running: "0.6.1" })).toBeUndefined();
		expect(hits).toHaveLength(1);
		// a day later it asks again
		await updateCheck(env, now + 25 * 3600_000, on);
		expect(hits).toHaveLength(2);
	});

	it("compares the latest release with the installed version, not the running one", async () => {
		const { base } = await releasesServer("0.6.1", {});
		const updated = scratch();
		installAt(updated, "0.6.1");
		// a TUI left running on 0.6.0 after an update to 0.6.1 has nothing to install
		expect(await updateCheck({ ORRERY_HOME: updated, ORRERY_RELEASES_URL: base }, Date.now(), { enabled: true, running: "0.6.0" })).toBeUndefined();
		const behind = scratch();
		installAt(behind, "0.6.0-219a227");
		expect(await updateCheck({ ORRERY_HOME: behind, ORRERY_RELEASES_URL: base }, Date.now(), { enabled: true, running: "0.6.1" })).toBe("0.6.1 available · run orrery update");
	});

	it("makes no request when turned off", async () => {
		const home = scratch();
		const { base, hits } = await releasesServer("0.6.1", {});
		expect(await updateCheck({ ORRERY_HOME: home, ORRERY_RELEASES_URL: base }, Date.now(), { enabled: false, running: "0.6.0" })).toBeUndefined();
		expect(hits).toEqual([]);
		expect(existsSync(join(home, "update-check.json"))).toBe(false);
	});

	it("returns nothing when the server is down, and does not try again within a day", async () => {
		const home = scratch();
		const { base, server } = await releasesServer("0.6.1", {});
		server.closeAllConnections();
		await new Promise<void>((done) => server.close(() => done()));
		const env = { ORRERY_HOME: home, ORRERY_RELEASES_URL: base };
		const now = Date.now();
		expect(await updateCheck(env, now, { enabled: true, running: "0.6.0" })).toBeUndefined();
		const written = readFileSync(join(home, "update-check.json"), "utf8");
		expect(await updateCheck(env, now + 1000, { enabled: true, running: "0.6.0" })).toBeUndefined();
		expect(readFileSync(join(home, "update-check.json"), "utf8")).toBe(written);
	});
});

describe("orrery update", () => {
	const SCRIPT = `#!/bin/sh\necho "$@" > "$HOME/installed"\nexit 0\n`;
	/** A release newer than the Orrery under test: the patch after package.json's version (the test binary is it plus a commit). */
	const NEXT = (() => {
		const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
		const [major, minor, patch] = version.split(".").map(Number);
		return `${major}.${minor}.${patch + 1}`;
	})();
	const NEXT_RE = NEXT.replaceAll(".", "\\.");

	/** Async, because the release server lives in this process. */
	function run(args: string[], base: string, home: string, tmp: string) {
		const c = cliCommand(["update", ...args]);
		return runRaw(c.cmd, c.args, base, home, tmp);
	}

	function runRaw(cmd: string, args: string[], base: string, home: string, tmp: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
		const child = spawn(cmd, args, {
			timeout: 60_000,
			env: { PATH: process.env.PATH, HOME: home, ORRERY_HOME: join(home, "orrery-home"), ORRERY_RELEASES_URL: base, TMPDIR: tmp },
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		return new Promise((done) => child.on("close", (status) => done({ status, stdout, stderr })));
	}

	it("downloads the latest release and hands over to its installer", async () => {
		const { base } = await releasesServer(NEXT, release(NEXT, SCRIPT));
		const home = scratch();
		const tmp = scratch("orrery-tmp-");
		const r = await run(["--yes"], base, home, tmp);
		expect(r.status, r.stderr).toBe(0);
		const installed = readFileSync(join(home, "installed"), "utf8").trim();
		expect(installed).toMatch(new RegExp(`^install --from .*/orrery-${NEXT_RE}-${PLATFORM} --yes$`));
		expect(r.stdout).toMatch(new RegExp(`Updated \\S+ → ${NEXT_RE}`));
		expect(readdirSync(tmp).filter((n) => n.startsWith("orrery-update-"))).toEqual([]);
	});

	it("--check says whether a release is out and downloads nothing", async () => {
		const { base, hits } = await releasesServer(NEXT, release(NEXT, SCRIPT));
		const r = await run(["--check"], base, scratch(), scratch("orrery-tmp-"));
		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toContain("is available");
		expect(hits).toEqual(["/releases/latest"]);
	});

	it("--version 0.5.0 is refused", async () => {
		const { base } = await releasesServer("0.6.1", {});
		const r = await run(["--version", "0.5.0"], base, scratch(), scratch("orrery-tmp-"));
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("no release before 0.6.0 exists");
	});

	it("a release without bin/orrery says so", async () => {
		const { base } = await releasesServer(NEXT, release(NEXT, ""));
		const tmp = scratch("orrery-tmp-");
		const r = await run(["--yes"], base, scratch(), tmp);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(`could not run the installer of ${NEXT}`);
		expect(readdirSync(tmp).filter((n) => n.startsWith("orrery-update-"))).toEqual([]);
	});

	it("a failing installer says Orrery stays on the running version", async () => {
		const { base } = await releasesServer(NEXT, release(NEXT, "#!/bin/sh\nexit 3\n"));
		const r = await run(["--yes"], base, scratch(), scratch("orrery-tmp-"));
		expect(r.status).toBe(3);
		expect(r.stderr).toContain(`The install of ${NEXT} failed; Orrery stays on `);
		expect(r.stdout).not.toContain("Updated");
	});

	it("an install that switched but whose setup left something says Updated, and how to finish", async () => {
		// The installer installs and switches app/current, then exits 1 as setup does when a question was declined.
		const SWITCH_THEN_FAIL = `#!/bin/sh\napp="$ORRERY_HOME/app"\nmkdir -p "$app/${NEXT}"\necho ${NEXT} > "$app/${NEXT}/VERSION"\nrm -f "$app/current"\nln -s ${NEXT} "$app/current"\nexit 1\n`;
		const { base } = await releasesServer(NEXT, release(NEXT, SWITCH_THEN_FAIL));
		const r = await run(["--yes"], base, scratch(), scratch("orrery-tmp-"));
		expect(r.status).toBe(1);
		expect(r.stdout).toMatch(new RegExp(`^Updated \\S+ → ${NEXT_RE}\\. Release notes: `, "m"));
		expect(r.stdout).toContain("Setup left something unfinished; run `orrery setup` to finish it.");
		expect(r.stderr).not.toContain("stays on");
	});

	it("a downloaded binary that cannot be run says TMPDIR may be mounted noexec", async () => {
		const { base } = await releasesServer(NEXT, release(NEXT, SCRIPT, undefined, PLATFORM, 0o644));
		const tmp = scratch("orrery-tmp-");
		const r = await run(["--yes"], base, scratch(), tmp);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(`could not run the downloaded Orrery: ${tmp} may be mounted noexec; set TMPDIR to a folder that allows running programs and try again`);
		expect(readdirSync(tmp).filter((n) => n.startsWith("orrery-update-"))).toEqual([]);
	});

	it("refuses -v, --check with --version, and finds update after a leading option", async () => {
		const { base } = await releasesServer("0.6.1", {});
		const home = scratch();
		const dash = await run(["-v", "0.6.1"], base, home, scratch("orrery-tmp-"));
		expect(dash.status).toBe(1);
		expect(dash.stderr).toContain("use --version <release>");
		const both = await run(["--check", "--version", "0.6.1"], base, home, scratch("orrery-tmp-"));
		expect(both.status).toBe(1);
		expect(both.stderr).toContain("--check looks for the latest release");
		const c = cliCommand(["--yes", "update", "--version", "0.5.0"]);
		const lead = await runRaw(c.cmd, c.args, base, home, scratch("orrery-tmp-"));
		expect(lead.status).toBe(1);
		expect(lead.stderr).toContain("no release before 0.6.0 exists");
	});

	it("a version that does not exist says so", async () => {
		const { base } = await releasesServer("0.6.1", {});
		const r = await run(["--version", "0.9.9"], base, scratch(), scratch("orrery-tmp-"));
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(/no Orrery release 0\.9\.9 \(http/);
	});

	it("Ctrl-C during the download stops it and leaves no work folder", async () => {
		const { base } = await releasesServer(NEXT, release(NEXT, "#!/bin/sh\nexit 0\n"), { stall: true });
		const tmp = scratch("orrery-tmp-");
		const c = cliCommand(["update", "--yes"]);
		const child = spawn(c.cmd, c.args, { env: { PATH: process.env.PATH, HOME: scratch(), ORRERY_HOME: join(scratch(), "orrery-home"), ORRERY_RELEASES_URL: base, TMPDIR: tmp } });
		let out = "";
		child.stdout.on("data", (d) => {
			out += d;
			if (out.includes("Downloading")) child.kill("SIGINT");
		});
		const code = await new Promise<number | null>((done) => child.on("close", (status) => done(status)));
		expect(code).toBe(130);
		expect(readdirSync(tmp).filter((n) => n.startsWith("orrery-update-"))).toEqual([]);
	});

	it("a bad checksum installs nothing and leaves no download", async () => {
		const files = release(NEXT, SCRIPT);
		files[`${NEXT}/SHA256SUMS`] = Buffer.from(`${"0".repeat(64)}  ${platformAsset()}\n`);
		const { base } = await releasesServer(NEXT, files);
		const home = scratch();
		const tmp = scratch("orrery-tmp-");
		const r = await run(["--yes"], base, home, tmp);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("does not match SHA256SUMS");
		expect(existsSync(join(home, "installed"))).toBe(false);
		expect(readdirSync(tmp).filter((n) => n.startsWith("orrery-update-"))).toEqual([]);
	});
});
