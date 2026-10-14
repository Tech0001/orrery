import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupFakes, release, releasesServer, scratch } from "./fake-releases.ts";
import { REPO } from "./support.ts";

afterEach(cleanupFakes);

const INSTALL_SH = join(REPO, "install.sh");
const RECORD = `#!/bin/sh\necho "$@" > "$HOME/installed"\n`;

function which(tool: string): string | undefined {
	const r = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" });
	return r.status === 0 ? r.stdout.trim() : undefined;
}

/** A PATH of one scratch folder holding links to only these tools, and a fake uname. */
function toolBin(tools: string[], uname = { s: "Linux", m: "x86_64" }): string {
	const bin = scratch("orrery-bin-");
	for (const tool of tools) {
		const real = which(tool);
		if (real) symlinkSync(real, join(bin, tool));
	}
	writeFileSync(join(bin, "uname"), `#!/bin/sh\ncase "$1" in -s) echo ${uname.s};; -m) echo ${uname.m};; esac\n`, { mode: 0o755 });
	return bin;
}

// Whichever checksum tools this machine has: sha256sum on Linux, shasum on macOS.
const SUMS = ["sha256sum", "shasum"];

// toolBin fakes uname as Linux x86_64, so these releases are the Linux x64 ones on any host.
const linuxRelease = (version: string, script?: string, held?: string) => release(version, script, held, "linux-x64");

const BASE_TOOLS = ["curl", "tar", "gzip", "awk", "mktemp", "rm", "mkdir", "grep", "ldd", "sh", "cat"];

/** Async: the fake release server lives in this process and must keep answering while the script runs. */
function runInstall(env: Record<string, string>, bin: string, args: string[] = []): Promise<{ status: number | null; out: string; home: string; tmp: string }> {
	const home = scratch();
	const tmp = scratch("orrery-tmp-");
	return new Promise((done) => {
		const child = spawn("sh", [INSTALL_SH, ...args], { env: { PATH: bin, HOME: home, TMPDIR: tmp, ...env }, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (out += d));
		child.on("close", (status) => done({ status, out, home, tmp }));
	});
}

describe("install.sh", () => {
	it("installs the latest release and removes its temporary folder", async () => {
		const { base, hits } = await releasesServer("0.6.1", linuxRelease("0.6.1", RECORD));
		const r = await runInstall({ ORRERY_RELEASES_URL: base }, toolBin([...BASE_TOOLS, ...SUMS]));
		expect(r.out).toContain("Downloading orrery-linux-x64.tar.gz");
		expect(r.status).toBe(0);
		expect(hits).toContain("/releases/latest/download/orrery-linux-x64.tar.gz");
		expect(readFileSync(join(r.home, "installed"), "utf8").trim()).toMatch(new RegExp(`^install --from ${r.tmp}/orrery-install\\.[^/]+/unpacked/orrery-0\\.6\\.1-linux-x64$`));
		expect(readdirSync(r.tmp)).toEqual([]);
	});

	it("passes its arguments to orrery install, and none when it has none", async () => {
		const { base } = await releasesServer("0.6.1", linuxRelease("0.6.1", RECORD));
		const bin = toolBin([...BASE_TOOLS, ...SUMS]);
		const folder = /^install --from (\S+)( --yes)?$/;
		const plain = await runInstall({ ORRERY_RELEASES_URL: base }, bin);
		expect(plain.status).toBe(0);
		expect(readFileSync(join(plain.home, "installed"), "utf8").trim()).toMatch(folder);
		expect(readFileSync(join(plain.home, "installed"), "utf8").trim()).not.toContain("--yes");
		const yes = await runInstall({ ORRERY_RELEASES_URL: base }, bin, ["--yes"]);
		expect(yes.status).toBe(0);
		expect(readFileSync(join(yes.home, "installed"), "utf8").trim()).toMatch(/^install --from \S+ --yes$/);
	});

	it.skipIf(!which("shasum"))("installs a macOS release with shasum when sha256sum is absent (skipped: shasum is not on this machine)", async () => {
		const { base } = await releasesServer("0.6.1", release("0.6.1", RECORD, undefined, "darwin-arm64"));
		const r = await runInstall({ ORRERY_RELEASES_URL: base }, toolBin([...BASE_TOOLS, "shasum"], { s: "Darwin", m: "arm64" }));
		expect(r.out).toContain("orrery-darwin-arm64.tar.gz");
		expect(r.status).toBe(0);
		expect(existsSync(join(r.home, "installed"))).toBe(true);
	});

	it("installs ORRERY_VERSION from its own download folder", async () => {
		const { base, hits } = await releasesServer("0.6.1", { ...linuxRelease("0.6.1", RECORD), ...linuxRelease("0.6.0", RECORD) });
		const r = await runInstall({ ORRERY_RELEASES_URL: base, ORRERY_VERSION: "0.6.0" }, toolBin([...BASE_TOOLS, ...SUMS]));
		expect(r.status).toBe(0);
		expect(hits).toEqual(["/releases/download/v0.6.0/orrery-linux-x64.tar.gz", "/releases/download/v0.6.0/SHA256SUMS"]);
		expect(readFileSync(join(r.home, "installed"), "utf8")).toContain("orrery-0.6.0-linux-x64");
	});

	it("refuses a version before 0.6.0 without any request", async () => {
		const { base, hits } = await releasesServer("0.6.1", linuxRelease("0.6.1", RECORD));
		const r = await runInstall({ ORRERY_RELEASES_URL: base, ORRERY_VERSION: "0.5.0" }, toolBin([...BASE_TOOLS, ...SUMS]));
		expect(r.status).toBe(1);
		expect(r.out).toContain("no release before 0.6.0 exists");
		expect(hits).toEqual([]);
	});

	it("refuses an ORRERY_VERSION that is not a version", async () => {
		const r = await runInstall({ ORRERY_VERSION: "../../x" }, toolBin([...BASE_TOOLS, ...SUMS]));
		expect(r.status).toBe(1);
		expect(r.out).toContain("must look like");
	});

	it("stops on a wrong SHA256SUMS line and never runs bin/orrery", async () => {
		const files = linuxRelease("0.6.1", RECORD);
		files["0.6.1/SHA256SUMS"] = Buffer.from(`${"0".repeat(64)}  orrery-linux-x64.tar.gz\n`);
		const { base } = await releasesServer("0.6.1", files);
		const r = await runInstall({ ORRERY_RELEASES_URL: base }, toolBin([...BASE_TOOLS, ...SUMS]));
		expect(r.status).toBe(1);
		expect(r.out).toContain("does not match SHA256SUMS");
		expect(existsSync(join(r.home, "installed"))).toBe(false);
		expect(readdirSync(r.tmp)).toEqual([]);
	});

	it("exits with the exit code of bin/orrery and removes its temporary folder", async () => {
		const { base } = await releasesServer("0.6.1", linuxRelease("0.6.1", "#!/bin/sh\nexit 7\n"));
		const r = await runInstall({ ORRERY_RELEASES_URL: base }, toolBin([...BASE_TOOLS, ...SUMS]));
		expect(r.status).toBe(7);
		expect(readdirSync(r.tmp)).toEqual([]);
	});

	it("reads SHA256SUMS with CRLF line endings and the *name binary-mode form", async () => {
		for (const edit of [(line: string) => line.replace("\n", "\r\n"), (line: string) => line.replace("  orrery-", " *orrery-")]) {
			const files = linuxRelease("0.6.1", RECORD);
			files["0.6.1/SHA256SUMS"] = Buffer.from(edit(files["0.6.1/SHA256SUMS"].toString()));
			const { base } = await releasesServer("0.6.1", files);
			const r = await runInstall({ ORRERY_RELEASES_URL: base }, toolBin([...BASE_TOOLS, ...SUMS]));
			expect(r.out).not.toContain("does not match");
			expect(r.status).toBe(0);
		}
	});

	it("needs gzip", async () => {
		const r = await runInstall({}, toolBin(BASE_TOOLS.filter((t) => t !== "gzip")));
		expect(r.status).toBe(1);
		expect(r.out).toContain("gzip is needed");
	});

	it("needs sha256sum or shasum", async () => {
		const { base } = await releasesServer("0.6.1", linuxRelease("0.6.1", RECORD));
		const r = await runInstall({ ORRERY_RELEASES_URL: base }, toolBin(BASE_TOOLS));
		expect(r.status).toBe(1);
		expect(r.out).toContain("sha256sum or shasum is needed");
	});

	it("names WSL for Windows and x64 and arm64 for other processors", async () => {
		const win = await runInstall({}, toolBin([...BASE_TOOLS, ...SUMS], { s: "MINGW64_NT-10.0", m: "x86_64" }));
		expect(win.status).toBe(1);
		expect(win.out).toContain("WSL");
		const odd = await runInstall({}, toolBin([...BASE_TOOLS, ...SUMS], { s: "Linux", m: "riscv64" }));
		expect(odd.status).toBe(1);
		expect(odd.out).toMatch(/x64 and arm64/);
	});

	it("refuses musl Linux", async () => {
		const bin = toolBin(["grep", "sh", "cat"]);
		writeFileSync(join(bin, "ldd"), `#!/bin/sh\necho "musl libc (x86_64)" >&2\nexit 1\n`, { mode: 0o755 });
		const r = await runInstall({}, bin);
		expect(r.status).toBe(1);
		expect(r.out).toContain("musl");
	});

	it("is POSIX sh", () => {
		expect(spawnSync("sh", ["-n", INSTALL_SH]).status).toBe(0);
		expect(spawnSync("bash", ["--posix", "-n", INSTALL_SH]).status).toBe(0);
		const lint = which("shellcheck");
		if (lint) expect(spawnSync(lint, ["-s", "sh", INSTALL_SH], { encoding: "utf8" }).status).toBe(0);
		const bashisms = which("checkbashisms");
		if (bashisms) expect(spawnSync(bashisms, [INSTALL_SH], { encoding: "utf8" }).status).toBe(0);
	});
});
