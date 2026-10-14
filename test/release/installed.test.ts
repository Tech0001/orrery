import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { installFrom, removeVersion } from "../../src/install/install.ts";
import { bunReady, builtRelease, removeBuiltRelease } from "./support.ts";

afterAll(removeBuiltRelease);

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) removeVersion(d); // version folders are read-only
});

/**
 * Fakes on a scratch PATH, each logging its arguments: pi and OMP answer --version; claude keeps a plugin list in a
 * file beside it (marketplace add records the folder, install lists the plugin reading from it, uninstall forgets it).
 */
function fakeTools(bin: string, log: string): void {
	mkdirSync(bin, { recursive: true });
	const logLine = `{ printf '%s' "\${0##*/}"; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\n'; } >> ${JSON.stringify(log)}`;
	const here = '"${0%/*}"';
	const scripts: Record<string, string> = {
		pi: 'echo "pi 1.2.0"',
		omp: 'echo "omp/18.10.4"',
		claude: [
			'case "$1 $2 $3" in',
			'"--version  ") echo "2.1.294 (Claude Code)" ;;',
			`"plugin list --json") if [ -f ${here}/plugin ]; then printf '[{"id":"orrery@orrery","version":"0.6.0","enabled":true,"readFromFolder":"%s/claude-plugin"}]' "$(cat ${here}/plugin)"; else printf '[]'; fi ;;`,
			`"plugin marketplace add") printf '%s' "$4" > ${here}/marketplace ;;`,
			`"plugin install orrery@orrery") cat ${here}/marketplace > ${here}/plugin ;;`,
			`"plugin uninstall orrery@orrery") rm -f ${here}/plugin ;;`,
			`"plugin marketplace remove") rm -f ${here}/marketplace ;;`,
			"esac",
		].join("\n"),
	};
	for (const [name, body] of Object.entries(scripts)) {
		writeFileSync(join(bin, name), `#!/bin/sh\n${logLine}\n${body}\n`);
		chmodSync(join(bin, name), 0o755);
	}
}

describe.skipIf(!bunReady)("the binary, installed", () => {
	it("from app/current, wires app/current (not its version folder or the build folder), and uninstalls itself", async () => {
		const release = await builtRelease();
		const home = mkdtempSync(join(tmpdir(), "orrery-installed-"));
		dirs.push(home);
		const orreryHome = join(home, ".orrery");
		const bin = join(home, "bin");
		const log = join(home, "calls.log");
		fakeTools(bin, log);
		// The fakes use cat and rm; neither system folder holds a pi, OMP or claude, and no backup unit exists here.
		const env: NodeJS.ProcessEnv = { HOME: home, ORRERY_HOME: orreryHome, PATH: `${bin}:/usr/bin:/bin` };
		const { version } = installFrom({ from: release, env });
		const current = join(orreryHome, "app", "current");
		const orrery = (...args: string[]) => spawnSync(join(current, "bin", "orrery"), args, { env, encoding: "utf8", timeout: 60_000 });

		const setup = orrery("setup", "--yes");
		expect(setup.status, setup.stdout + setup.stderr).toBe(0);
		expect(readlinkSync(join(home, ".local", "bin", "orrery"))).toBe(join(current, "bin", "orrery"));
		const pi = readFileSync(join(home, ".pi", "agent", "extensions", "orrery.ts"), "utf8");
		expect(pi).toBe(`export { default } from ${JSON.stringify(join(current, "extensions", "pi.js"))};\n`);
		const omp = readFileSync(join(home, ".omp", "agent", "extensions", "orrery.ts"), "utf8");
		expect(omp).toMatch(/^export \{ default \} from "\.\.\/.*\.orrery\/app\/current\/extensions\/omp\.js";\n$/);
		expect(readFileSync(join(bin, "plugin"), "utf8")).toBe(current);
		const all = [setup.stdout, pi, omp, readFileSync(log, "utf8")].join("\n");
		expect(all).not.toContain(join(orreryHome, "app", version));
		expect(all).not.toContain(release);

		// What it reports as its wiring root: everything it just wired counts as installed, so the root is app/current.
		const tools = orrery("tools", "--json");
		expect(tools.status, tools.stderr).toBe(0);
		const wiring = Object.fromEntries((JSON.parse(tools.stdout).tools as { id: string; wiring: string }[]).map((t) => [t.id, t.wiring]));
		expect(wiring).toMatchObject({ pi: "installed", omp: "installed", "claude-code": "installed" });
		expect(orrery("--version").stdout).toBe(`orrery ${version}\n`);

		const out = orrery("uninstall");
		expect(out.status, out.stdout + out.stderr).toBe(0);
		expect(existsSync(join(orreryHome, "app"))).toBe(false);
		expect(() => lstatSync(join(home, ".local", "bin", "orrery"))).toThrow();
		expect(existsSync(join(home, ".pi", "agent", "extensions", "orrery.ts"))).toBe(false);
		expect(existsSync(join(home, ".omp", "agent", "extensions", "orrery.ts"))).toBe(false);
		expect(existsSync(join(bin, "plugin"))).toBe(false);
		expect(existsSync(join(bin, "marketplace"))).toBe(false);
		expect(existsSync(orreryHome)).toBe(true);
	});
});
