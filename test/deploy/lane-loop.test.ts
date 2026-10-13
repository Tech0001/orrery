import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "../lane/support.ts";

const LOOP = new URL("../../deploy/orrery-lane", import.meta.url).pathname;
const STOP = new URL("../../deploy/orrery-stop", import.meta.url).pathname;
const hasTmux = spawnSync("tmux", ["-V"]).status === 0;
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fake `orrery` on PATH that logs each start, then runs `body`. */
function fakeOrrery(body: string): { bin: string; log: string } {
	const dir = tempDir("orrery-loop-");
	dirs.push(dir);
	const bin = join(dir, "bin");
	mkdirSync(bin);
	const log = join(dir, "starts.log");
	writeFileSync(join(bin, "orrery"), `#!/usr/bin/env bash\necho "start $*" >> ${JSON.stringify(log)}\n${body}\n`);
	chmodSync(join(bin, "orrery"), 0o755);
	return { bin, log };
}

function startLoop(bin: string, env: Record<string, string> = {}) {
	const child = spawn("bash", [LOOP, "Atlas"], {
		env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ORRERY_RESTART_DELAY: "0.05", ...env },
	});
	let output = "";
	child.stdout.on("data", (chunk) => (output += chunk));
	child.stderr.on("data", (chunk) => (output += chunk));
	const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
	return { child, exited, output: () => output };
}

const starts = (log: string) => {
	try {
		return readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
	} catch {
		return [];
	}
};

const until = async (check: () => boolean, ms: number) => {
	const end = Date.now() + ms;
	while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
	return check();
};

describe("orrery-lane restart loop", () => {
	it("restarts a lane that exits, says so, and backs off", async () => {
		const { bin, log } = fakeOrrery("exit 3");
		const loop = startLoop(bin);
		expect(await until(() => starts(log).length >= 3, 3000)).toBe(true);
		loop.child.kill("SIGTERM");
		expect(await loop.exited).toBe(0);
		expect(starts(log)[0]).toBe("start run Atlas");
		expect(loop.output()).toMatch(/orrery-lane: Atlas exited \(3\); restarting in 0\.05s/);
		expect(loop.output()).toMatch(/restarting in 0\.1s/);
	});

	it("forwards SIGTERM to the running lane and exits cleanly", async () => {
		const { bin, log } = fakeOrrery(`trap 'echo "stopped" >> ${JSON.stringify(`${"$"}{0%/*}/../stopped.log`)}; exit 0' TERM\nsleep 30 & wait`);
		const loop = startLoop(bin);
		expect(await until(() => starts(log).length === 1, 3000)).toBe(true);
		const sent = Date.now();
		loop.child.kill("SIGTERM");
		expect(await loop.exited).toBe(0);
		expect(Date.now() - sent).toBeLessThan(2000);
		expect(readFileSync(join(bin, "..", "stopped.log"), "utf8")).toContain("stopped");
		expect(starts(log)).toHaveLength(1);
	});

	it.skipIf(!hasTmux)("orrery-stop signals the lane's loop even when another tmux window is current", async () => {
		const events = join(tempDir("orrery-stop-"), "events.log");
		dirs.push(join(events, ".."));
		const { bin } = fakeOrrery(`trap 'echo lane-stopped >> ${JSON.stringify(events)}; exit 0' TERM\necho lane-ready >> ${JSON.stringify(events)}\nsleep 30 & wait`);
		const seen = (word: string) => {
			try {
				return readFileSync(events, "utf8").includes(word);
			} catch {
				return false;
			}
		};
		// A short socket directory: Unix socket paths are limited to about 108 bytes.
		const tmux = tempDir("ot-");
		dirs.push(tmux);
		const env = { ...process.env, TMUX_TMPDIR: tmux, PATH: `${bin}:${process.env.PATH}`, ORRERY_RESTART_DELAY: "0.05" };
		const t = (...args: string[]) => execFileSync("tmux", ["-L", "orrery-Atlas", ...args], { env, encoding: "utf8" });
		t("new-session", "-d", "-s", "Atlas", "-x", "120", "-y", "30", `bash ${LOOP} Atlas`);
		expect(await until(() => seen("lane-ready"), 3000)).toBe(true);
		t("new-window", "-t", "Atlas", `bash -c "trap 'echo other-stopped >> ${events}; exit 0' TERM; echo other-ready >> ${events}; sleep 30 & wait"`);
		expect(await until(() => seen("other-ready"), 3000)).toBe(true);
		execFileSync("bash", [STOP, "Atlas"], { env });
		await until(() => seen("stopped"), 3000);
		const stops = readFileSync(events, "utf8").trim().split("\n").filter((line) => line.endsWith("-stopped"));
		expect(stops[0]).toBe("lane-stopped");
		expect(spawnSync("tmux", ["-L", "orrery-Atlas", "ls"], { env }).status).not.toBe(0);
	});
});
