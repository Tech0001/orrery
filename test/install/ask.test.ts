import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installFrom } from "../../src/install/install.ts";
import { cliCommand } from "../claude/support.ts";
import { bareSystemPath, cleanupScratch, fixtureRelease, tempDir } from "./support.ts";

afterEach(cleanupScratch);

const hasScript = process.platform === "linux" && spawnSync("script", ["--version"]).status === 0 && spawnSync("setsid", ["--version"]).status === 0;

/** The CLI under test (ORRERY_TEST_BIN or node main.ts) as one shell command line. */
const shellCommand = (...args: string[]) => {
	const c = cliCommand(args);
	return [c.cmd, ...c.args].map((part) => `'${part.replace(/'/g, `'\\''`)}'`).join(" ");
};

/**
 * A scratch home with an installed fixture release, and a plain file at ~/.local/bin/orrery that is not Orrery's: the
 * one thing setup must ask about. PATH finds no pi, OMP or Claude Code.
 */
function scratchWithForeignCommand(): { env: NodeJS.ProcessEnv; home: string; link: string } {
	const home = tempDir("orrery-ask-");
	const env: NodeJS.ProcessEnv = { HOME: home, ORRERY_HOME: join(home, ".orrery"), PATH: bareSystemPath(), LANG: "C" };
	installFrom({ from: fixtureRelease("0.6.0"), env });
	const link = join(home, ".local", "bin", "orrery");
	mkdirSync(join(home, ".local", "bin"), { recursive: true });
	writeFileSync(link, "#!/bin/sh\necho someone else\n", { mode: 0o755 });
	return { env, home, link };
}

describe.skipIf(!hasScript)("questions under curl | sh", () => {
	it("are asked on the terminal even when stdin is a pipe", () => {
		const { env, link } = scratchWithForeignCommand();
		const r = spawnSync("script", ["-qec", `printf 'not an answer\\n' | ${shellCommand("setup")}`, "/dev/null"], { encoding: "utf8", input: "n\n", env, timeout: 20_000 });
		expect(r.stdout).toMatch(/replace .*\.local\/bin\/orrery\? \(y\/N\)/);
		expect(r.stdout).toMatch(/left .* as it is/);
		expect(r.status).toBe(1);
		expect(readFileSync(link, "utf8")).toMatch(/someone else/);
	});

	it("a yes on the terminal replaces it", () => {
		const { env, link } = scratchWithForeignCommand();
		const r = spawnSync("script", ["-qec", `printf 'n\\n' | ${shellCommand("setup")}`, "/dev/null"], { encoding: "utf8", input: "y\n", env, timeout: 20_000 });
		expect(r.stdout).toMatch(/replace .*\.local\/bin\/orrery\? \(y\/N\)/);
		expect(r.stdout).toMatch(/orrery command: .* links to /);
		expect(r.status).toBe(0);
		expect(spawnSync("readlink", [link], { encoding: "utf8" }).stdout.trim()).toBe(join(env.ORRERY_HOME as string, "app", "current", "bin", "orrery"));
	});

	it("with no terminal, changes nothing that needs asking, lists it, and exits 1", () => {
		const { env, link } = scratchWithForeignCommand();
		const c = cliCommand(["setup"]);
		const r = spawnSync("setsid", ["-w", c.cmd, ...c.args], { encoding: "utf8", input: "", env, timeout: 20_000 });
		expect(r.status).toBe(1);
		expect(r.stdout).toMatch(/Skipped \(no terminal to ask; rerun with --yes\)/);
		expect(r.stdout).toContain("Still wired elsewhere");
		expect(readFileSync(link, "utf8")).toMatch(/someone else/);
	});

	it("uninstall --purge deletes the home only when delete is typed on the terminal", () => {
		const declined = scratchWithForeignCommand();
		const no = spawnSync("script", ["-qec", `${shellCommand("uninstall", "--purge")} < /dev/null`, "/dev/null"], { encoding: "utf8", input: "yes\n", env: declined.env, timeout: 20_000 });
		expect(no.stdout).toMatch(/This deletes every lane's memory, logins and backups in .*\. Type delete to go ahead:/);
		expect(no.stdout).toContain("(you did not type delete)");
		expect(no.status).toBe(1);
		expect(existsSync(declined.env.ORRERY_HOME as string)).toBe(true);
		const confirmed = scratchWithForeignCommand();
		const yes = spawnSync("script", ["-qec", `${shellCommand("uninstall", "--purge")} < /dev/null`, "/dev/null"], { encoding: "utf8", input: "delete\n", env: confirmed.env, timeout: 20_000 });
		expect(yes.stdout).toContain(`Deleted ${confirmed.env.ORRERY_HOME}.`);
		expect(yes.status, yes.stdout).toBe(0);
		expect(existsSync(confirmed.env.ORRERY_HOME as string)).toBe(false);
		expect(existsSync(confirmed.link)).toBe(true); // not Orrery's link: left
	});

	it("--yes answers yes without a terminal", () => {
		const { env, link } = scratchWithForeignCommand();
		const c = cliCommand(["setup", "--yes"]);
		const r = spawnSync("setsid", ["-w", c.cmd, ...c.args], { encoding: "utf8", input: "", env, timeout: 20_000 });
		expect(r.status, r.stdout + r.stderr).toBe(0);
		expect(spawnSync("readlink", [link], { encoding: "utf8" }).stdout.trim()).toBe(join(env.ORRERY_HOME as string, "app", "current", "bin", "orrery"));
	});
});
