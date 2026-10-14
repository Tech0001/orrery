import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installFrom, makeReadOnly } from "../../src/install/install.ts";
import { uninstall } from "../../src/install/uninstall.ts";
import { wire } from "../../src/install/wire.ts";
import { ompExtensionFile, piExtensionFile } from "../../src/lane/tools.ts";
import { cliCommand } from "../claude/support.ts";
import { bareSystemPath, cleanupScratch, fakeRun, fixtureRelease, installedScratch, type Scratch, type Style, tempDir, VERSION, writePiExtension } from "./support.ts";

afterEach(cleanupScratch);

const never = async (): Promise<boolean> => {
	throw new Error("asked");
};

/** A fake claude whose plugin list is the file plugins.json beside it (none: an empty list). */
const CLAUDE = `if [ "$1" = "--version" ]; then echo "2.1.294 (Claude Code)"; elif [ "$1 $2" = "plugin list" ]; then if [ -f "\${0%/*}/plugins.json" ]; then IFS= read -r line < "\${0%/*}/plugins.json"; printf '%s' "$line"; else printf '[]'; fi; fi`;

function pluginList(t: Scratch, readFromFolder: string | undefined): void {
	writeFileSync(join(t.bin, "plugins.json"), JSON.stringify([{ id: "orrery@orrery", version: "0.6.0", enabled: true, ...(readFromFolder === undefined ? {} : { readFromFolder }) }]));
}

const unitDir = (t: Scratch) => join(t.home, ".config", "systemd", "user");

/**
 * An install in `style`, read-only as a real one, wired by setup's own code: the command link, pi, OMP (separate
 * folders), the Claude Code plugin from app/current, and a backup service with its timer. Lanes' files beside it.
 */
async function wiredInstall(style: Style = "binary"): Promise<Scratch> {
	const t = installedScratch({ style, tools: { pi: 'echo "pi 1.2.0"', omp: 'echo "omp/18.8.9"', claude: CLAUDE } });
	mkdirSync(unitDir(t), { recursive: true });
	writeFileSync(join(unitDir(t), "orrery-backup.service"), "[Service]\nType=oneshot\nExecStart=%h/.orrery/app/current/deploy/workstation/backup.sh\n");
	writeFileSync(join(unitDir(t), "orrery-backup.timer"), "[Timer]\nOnCalendar=*-*-* 01:15:00\n\n[Install]\nWantedBy=timers.target\n");
	await wire(t.env, { run: fakeRun, confirm: never });
	pluginList(t, join(t.current, "claude-plugin"));
	writeFileSync(join(t.orreryHome, "config.toml"), `data_dir = ${JSON.stringify(t.orreryHome)}\n`);
	writeFileSync(join(t.orreryHome, "credentials.json"), "{}\n", { mode: 0o600 });
	mkdirSync(join(t.orreryHome, "lanes", "Atlas"), { recursive: true });
	writeFileSync(join(t.orreryHome, "lanes", "Atlas", "memory.jsonl"), "{}\n");
	makeReadOnly(join(t.orreryHome, "app", VERSION));
	return t;
}

/** The calls that change something (not --version or plugin list). */
const changes = (t: Scratch, from: number) => t.calls().slice(from).filter((c) => c[1] !== "--version" && !(c[1] === "plugin" && c[2] === "list"));

const gone = (path: string) => {
	try {
		lstatSync(path);
		return false;
	} catch {
		return true;
	}
};

describe("uninstall", () => {
	it("removes app/, the command link, pi's and OMP's files, the Claude Code plugin and the backup service; keeps config, logins and lanes", async () => {
		const t = await wiredInstall();
		const link = join(t.home, ".local", "bin", "orrery");
		expect(readlinkSync(link)).toBe(join(t.current, "bin", "orrery"));
		expect(existsSync(piExtensionFile(t.env))).toBe(true);
		expect(existsSync(ompExtensionFile(t.env))).toBe(true);
		const before = t.calls().length;
		const { lines, ok } = await uninstall({ env: t.env, purge: false, confirmPurge: never, run: fakeRun });
		expect(ok, lines.join("\n")).toBe(true);
		expect(gone(join(t.orreryHome, "app"))).toBe(true);
		expect(gone(link)).toBe(true);
		expect(gone(piExtensionFile(t.env))).toBe(true);
		expect(gone(ompExtensionFile(t.env))).toBe(true);
		expect(existsSync(dirname(piExtensionFile(t.env)))).toBe(true); // only Orrery's file goes, not pi's folder
		expect(gone(join(unitDir(t), "orrery-backup.service"))).toBe(true);
		expect(gone(join(unitDir(t), "orrery-backup.timer"))).toBe(true);
		expect(changes(t, before)).toEqual([
			["claude", "plugin", "uninstall", "orrery@orrery"],
			["claude", "plugin", "marketplace", "remove", "orrery"],
			["systemctl", "--user", "disable", "--now", "orrery-backup.timer"],
			["systemctl", "--user", "daemon-reload"],
		]);
		expect(readFileSync(join(t.orreryHome, "config.toml"), "utf8")).toContain("data_dir");
		expect(existsSync(join(t.orreryHome, "credentials.json"))).toBe(true);
		expect(existsSync(join(t.orreryHome, "lanes", "Atlas", "memory.jsonl"))).toBe(true);
		const text = lines.join("\n");
		expect(text).toContain(`pi: removed ${piExtensionFile(t.env)}`);
		expect(text).toContain(`OMP: removed ${ompExtensionFile(t.env)}`);
		expect(text).toContain(`orrery command: removed ${link}`);
		expect(text).toMatch(/Kept .*config, logins and lanes/);
	});

	it("unwires a source-style (0.5.0) install too, and a file that names a version folder", async () => {
		const t = await wiredInstall("source");
		expect(readlinkSync(join(t.home, ".local", "bin", "orrery"))).toBe(join(t.current, "src", "cli", "main.ts"));
		writePiExtension(t.env, join(t.orreryHome, "app", VERSION, "src", "pi", "index.ts"));
		const { ok } = await uninstall({ env: t.env, purge: false, confirmPurge: never, run: fakeRun });
		expect(ok).toBe(true);
		expect(gone(join(t.home, ".local", "bin", "orrery"))).toBe(true);
		expect(gone(piExtensionFile(t.env))).toBe(true);
		expect(gone(ompExtensionFile(t.env))).toBe(true);
		expect(gone(join(t.orreryHome, "app"))).toBe(true);
	});

	it("leaves what is not Orrery's own, and says so", async () => {
		const t = await wiredInstall();
		const elsewhere = tempDir("orrery-elsewhere-");
		writePiExtension(t.env, "/somewhere/else/my-extension.ts");
		writeFileSync(ompExtensionFile(t.env), `export { default } from ${JSON.stringify(join(elsewhere, "app", "current", "extensions", "omp.js"))};\n`);
		const link = join(t.home, ".local", "bin", "orrery");
		rmSync(link);
		symlinkSync("/usr/bin/true", link);
		writeFileSync(join(unitDir(t), "orrery-backup.service"), "[Service]\nExecStart=/opt/other/backup.sh\n");
		pluginList(t, "/other/checkout/claude-plugin");
		const before = t.calls().length;
		const { lines, ok } = await uninstall({ env: t.env, purge: false, confirmPurge: never, run: fakeRun });
		expect(ok).toBe(true);
		const text = lines.join("\n");
		expect(readFileSync(piExtensionFile(t.env), "utf8")).toContain("/somewhere/else/my-extension.ts");
		expect(text).toMatch(/^pi: left .* as it is/m);
		expect(readFileSync(ompExtensionFile(t.env), "utf8")).toContain(elsewhere);
		expect(text).toMatch(/^OMP: left .* as it is/m);
		expect(readlinkSync(link)).toBe("/usr/bin/true");
		expect(text).toMatch(/^orrery command: left .* as it is/m);
		expect(existsSync(join(unitDir(t), "orrery-backup.service"))).toBe(true);
		expect(existsSync(join(unitDir(t), "orrery-backup.timer"))).toBe(true);
		expect(text).toMatch(/^backup service: .* left as it is/m);
		expect(text).toMatch(/^Claude Code: .*\/other\/checkout\/claude-plugin.* left as it is/m);
		expect(changes(t, before)).toEqual([]);
		expect(gone(join(t.orreryHome, "app"))).toBe(true);
	});

	it("leaves a file that adds anything to Orrery's one line, and a plugin whose folder Claude Code does not name", async () => {
		const t = await wiredInstall();
		writeFileSync(piExtensionFile(t.env), `export { default } from ${JSON.stringify(join(t.current, "extensions", "pi.js"))};\nexport const mine = 1;\n`);
		pluginList(t, undefined);
		const before = t.calls().length;
		const { lines } = await uninstall({ env: t.env, purge: false, confirmPurge: never, run: fakeRun });
		expect(readFileSync(piExtensionFile(t.env), "utf8")).toContain("export const mine = 1;");
		expect(lines.join("\n")).toMatch(/^pi: left .* as it is \(not Orrery's one-line extension\)/m);
		expect(lines.join("\n")).toMatch(/^Claude Code: .*left as it is/m);
		expect(changes(t, before).filter((c) => c[0] === "claude")).toEqual([]);
	});

	it("refuses while a lane is open, names it, and changes nothing", async () => {
		const t = await wiredInstall();
		writeFileSync(join(t.orreryHome, "config.toml"), `data_dir = ${JSON.stringify(t.orreryHome)}\n[lanes.Atlas]\nworkspace = ${JSON.stringify(join(t.home, "ws"))}\ncompactor_model = "local/m"\n`);
		writeFileSync(join(t.orreryHome, "lanes", "Atlas", "status.json"), JSON.stringify({ lane: "Atlas", pid: process.pid, open: true, version: VERSION }));
		const before = t.calls().length;
		const { lines, ok } = await uninstall({ env: t.env, purge: true, confirmPurge: never, run: fakeRun });
		expect(ok).toBe(false);
		expect(lines).toEqual(["Close these lanes first: Atlas"]);
		expect(existsSync(join(t.orreryHome, "app", "current"))).toBe(true);
		expect(existsSync(piExtensionFile(t.env))).toBe(true);
		expect(existsSync(join(t.home, ".local", "bin", "orrery"))).toBe(true);
		expect(existsSync(join(unitDir(t), "orrery-backup.service"))).toBe(true);
		expect(changes(t, before)).toEqual([]);
	});

	it("refuses when it cannot tell whether a lane is open", async () => {
		const t = await wiredInstall();
		writeFileSync(join(t.orreryHome, "config.toml"), `data_dir = ${JSON.stringify(t.orreryHome)}\n[lanes.Atlas]\nworkspace = ${JSON.stringify(join(t.home, "ws"))}\ncompactor_model = "local/m"\n`);
		writeFileSync(join(t.orreryHome, "lanes", "Atlas", "status.json"), "{ not json");
		const { lines, ok } = await uninstall({ env: t.env, purge: false, confirmPurge: never, run: fakeRun });
		expect(ok).toBe(false);
		expect(lines.join("\n")).toMatch(/^Cannot tell whether lanes are open: lane Atlas's status\.json cannot be parsed/);
		expect(existsSync(join(t.orreryHome, "app", "current"))).toBe(true);
	});

	it("--purge removes the whole home only when confirmed; declined, it keeps it and fails", async () => {
		const kept = await wiredInstall();
		const declined = await uninstall({ env: kept.env, purge: true, confirmPurge: async () => false, run: fakeRun });
		expect(declined.ok).toBe(false);
		expect(declined.lines.at(-1)).toBe(`Kept ${kept.orreryHome} (you did not type delete).`);
		expect(existsSync(join(kept.orreryHome, "config.toml"))).toBe(true);
		expect(gone(join(kept.orreryHome, "app"))).toBe(true);
		const purged = await wiredInstall();
		const confirmed = await uninstall({ env: purged.env, purge: true, confirmPurge: async () => true, run: fakeRun });
		expect(confirmed.ok, confirmed.lines.join("\n")).toBe(true);
		expect(gone(purged.orreryHome)).toBe(true);
		expect(existsSync(purged.home)).toBe(true);
		expect(confirmed.lines.at(-1)).toBe(`Deleted ${purged.orreryHome}.`);
	});

	it("--purge never deletes the home folder itself or a folder that holds it, and then changes nothing", async () => {
		const t = await wiredInstall();
		for (const orreryHome of [t.home, dirname(t.home)]) {
			const { lines, ok } = await uninstall({ env: { ...t.env, ORRERY_HOME: orreryHome }, purge: true, confirmPurge: never, run: fakeRun });
			expect(ok).toBe(false);
			expect(lines).toEqual([`Not uninstalled: --purge deletes only a folder of Orrery's own, and ${orreryHome} is your home folder or holds it.`]);
		}
		expect(existsSync(piExtensionFile(t.env))).toBe(true);
		expect(existsSync(join(t.orreryHome, "app", "current"))).toBe(true);
	});

	it("removes only what Orrery put in app/, and says what it left", async () => {
		const t = await wiredInstall();
		const app = join(t.orreryHome, "app");
		mkdirSync(join(app, "notes"));
		writeFileSync(join(app, "notes", "mine.txt"), "mine\n");
		mkdirSync(join(app, "0.7.0"));
		writeFileSync(join(app, "0.7.0", "mine.txt"), "a folder named like a version, without one inside\n");
		const { lines, ok } = await uninstall({ env: t.env, purge: false, confirmPurge: never, run: fakeRun });
		expect(ok).toBe(false);
		expect(existsSync(join(app, "notes", "mine.txt"))).toBe(true);
		expect(existsSync(join(app, "0.7.0", "mine.txt"))).toBe(true);
		expect(gone(join(app, VERSION))).toBe(true);
		expect(gone(join(app, "current"))).toBe(true);
		expect(gone(join(app, "history"))).toBe(true);
		expect(lines.join("\n")).toContain(`left ${app}: it holds files Orrery did not put there (0.7.0, notes)`);
	});

	it.skipIf(spawnSync("setsid", ["--version"]).status !== 0)("runs from the command line, and --purge without a terminal keeps the home", () => {
		const home = tempDir("orrery-uninstall-cli-");
		const env: NodeJS.ProcessEnv = { HOME: home, ORRERY_HOME: join(home, ".orrery"), PATH: bareSystemPath() };
		installFrom({ from: fixtureRelease("0.6.0"), env });
		writeFileSync(join(home, ".orrery", "credentials.json"), "{}\n", { mode: 0o600 });
		const cli = (...args: string[]) => {
			const c = cliCommand(args);
			return spawnSync("setsid", ["-w", c.cmd, ...c.args], { env, encoding: "utf8", input: "", timeout: 20_000 });
		};
		const purge = cli("uninstall", "--purge");
		expect(purge.status).toBe(1);
		expect(purge.stdout).toContain(`Kept ${join(home, ".orrery")} (you did not type delete).`);
		expect(gone(join(home, ".orrery", "app"))).toBe(true);
		expect(existsSync(join(home, ".orrery", "credentials.json"))).toBe(true);
		const again = cli("uninstall");
		expect(again.status, again.stdout + again.stderr).toBe(0);
	});
});
