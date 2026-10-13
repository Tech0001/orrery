import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { leftWarning, wire, wireReport } from "../../src/install/wire.ts";
import { ompExtensionFile, piExtensionFile, piExtensionText, type Runner } from "../../src/lane/tools.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

const VERSION = "0.6.0-abc1234";

/** Runs only the scratch bins' fake commands: anything else (a real systemctl or claude) is refused, never run. */
const fakeRun: Runner = (cmd, args) => {
	if (!isAbsolute(cmd) || !cmd.startsWith(join(tmpdir(), "orrery-wire-"))) return { status: 127, stdout: "", stderr: `not a scratch command: ${cmd}` };
	const r = spawnSync(cmd, [...args], { encoding: "utf8", env: { PATH: dirname(cmd) } });
	return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

/**
 * A scratch home with an installed version and app/current; env.PATH holds only a scratch bin of fake commands that log
 * their arguments (claude lists no plugins; `tools` adds more, such as a fake pi). calls() reads the log.
 */
function installedScratch(options: { tools?: Record<string, string>; orreryHome?: string } = {}) {
	const home = tempDir("orrery-wire-");
	const bin = join(home, "bin");
	const log = join(home, "calls.log");
	mkdirSync(bin);
	const logLine = `{ printf '%s' "\${0##*/}"; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\n'; } >> ${JSON.stringify(log)}`;
	const scripts: Record<string, string> = {
		claude: `if [ "$1" = "--version" ]; then echo "2.1.294 (Claude Code)"; elif [ "$1 $2" = "plugin list" ]; then printf '%s' "\${FAKE_PLUGINS:-[]}"; fi`,
		systemctl: "",
		...options.tools,
	};
	for (const [name, body] of Object.entries(scripts)) {
		writeFileSync(join(bin, name), `#!/bin/sh\n${logLine}\n${body}\n`);
		chmodSync(join(bin, name), 0o755);
	}
	const orreryHome = options.orreryHome ?? join(home, ".orrery");
	const app = join(orreryHome, "app");
	for (const entry of ["src/cli/main.ts", "src/pi/index.ts", "src/omp/index.ts", "deploy/workstation/backup.sh"]) {
		mkdirSync(dirname(join(app, VERSION, entry)), { recursive: true });
		writeFileSync(join(app, VERSION, entry), "\n");
	}
	symlinkSync(VERSION, join(app, "current"));
	const env: NodeJS.ProcessEnv = { HOME: home, ORRERY_HOME: orreryHome, PATH: bin };
	const calls = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l !== "").map((line) => line.split("\t")) : []);
	return { env, home, bin, calls, current: join(app, "current") };
}

function writePiExtension(env: NodeJS.ProcessEnv, target: string): void {
	const file = piExtensionFile(env);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `export { default } from ${JSON.stringify(target)};\n`);
}

const piExtension = (env: NodeJS.ProcessEnv) => readFileSync(piExtensionFile(env), "utf8");
const neverAsked = async (what: string): Promise<boolean> => {
	throw new Error(`asked: ${what}`);
};

describe("the orrery command", () => {
	it("links ~/.local/bin/orrery to app/current's CLI, replacing an older Orrery link", async () => {
		const { env, home } = installedScratch();
		mkdirSync(join(home, ".local", "bin"), { recursive: true });
		symlinkSync("/old/checkout/src/cli/main.ts", join(home, ".local", "bin", "orrery"));
		const lines = await wire(env, { run: fakeRun, confirm: async () => true });
		expect(readlinkSync(join(home, ".local", "bin", "orrery"))).toBe(join(home, ".orrery", "app", "current", "src", "cli", "main.ts"));
		expect(lines.join("\n")).toMatch(/orrery command/);
	});

	it("creates ~/.local/bin when it is missing, and says when the link is already right", async () => {
		const { env, home } = installedScratch();
		await wire(env, { run: fakeRun, confirm: neverAsked });
		const link = join(home, ".local", "bin", "orrery");
		expect(readlinkSync(link)).toBe(join(home, ".orrery", "app", "current", "src", "cli", "main.ts"));
		expect((await wire(env, { run: fakeRun, confirm: neverAsked })).join("\n")).toMatch(/orrery command: .*already links/);
	});

	it("leaves a foreign ~/.local/bin/orrery alone unless confirmed", async () => {
		const { env, home } = installedScratch();
		mkdirSync(join(home, ".local", "bin"), { recursive: true });
		writeFileSync(join(home, ".local", "bin", "orrery"), "#!/bin/sh\necho someone else\n", { mode: 0o755 });
		const asked: string[] = [];
		const lines = await wire(env, { run: fakeRun, confirm: async (what) => (asked.push(what), false) });
		expect(readFileSync(join(home, ".local", "bin", "orrery"), "utf8")).toMatch(/someone else/);
		expect(lines.join("\n")).toMatch(/left .*orrery.* as it is/);
		expect(asked).toEqual([`replace ${join(home, ".local", "bin", "orrery")}?`]);
		await wire(env, { run: fakeRun, confirm: async () => true });
		expect(readlinkSync(join(home, ".local", "bin", "orrery"))).toBe(join(home, ".orrery", "app", "current", "src", "cli", "main.ts"));
	});
});

describe("the backup service", () => {
	it("points the backup service at app/current and reloads systemd", async () => {
		const { env, home, calls } = installedScratch();
		const unit = join(home, ".config", "systemd", "user", "orrery-backup.service");
		mkdirSync(dirname(unit), { recursive: true });
		writeFileSync(unit, "[Service]\nType=oneshot\nExecStart=%h/old/checkout/deploy/workstation/backup.sh\n", { mode: 0o640 });
		chmodSync(unit, 0o640);
		await wire(env, { run: fakeRun, confirm: async () => true });
		expect(readFileSync(unit, "utf8")).toMatch(/^ExecStart=%h\/\.orrery\/app\/current\/deploy\/workstation\/backup\.sh$/m);
		expect(readFileSync(unit, "utf8")).toMatch(/^Type=oneshot$/m);
		expect(statSync(unit).mode & 0o777).toBe(0o640);
		expect(calls()).toContainEqual(["systemctl", "--user", "daemon-reload"]);
	});

	it("writes the absolute app/current path when ORRERY_HOME is not ~/.orrery", async () => {
		const elsewhere = tempDir("orrery-wire-elsewhere-");
		const { env, home, calls } = installedScratch({ orreryHome: join(elsewhere, "orrery home") });
		const unit = join(home, ".config", "systemd", "user", "orrery-backup.service");
		mkdirSync(dirname(unit), { recursive: true });
		writeFileSync(unit, "[Service]\nExecStart=%h/code/orrery/deploy/workstation/backup.sh\n");
		await wire(env, { run: fakeRun, confirm: async () => true });
		const script = join(elsewhere, "orrery home", "app", "current", "deploy", "workstation", "backup.sh");
		expect(readFileSync(unit, "utf8")).toContain(`\nExecStart=${JSON.stringify(script)}\n`);
		expect(calls()).toContainEqual(["systemctl", "--user", "daemon-reload"]);
	});

	it("says there is none when no unit is installed, and leaves one already pointing at app/current alone", async () => {
		const { env, home, calls } = installedScratch();
		expect((await wire(env, { run: fakeRun, confirm: neverAsked })).join("\n")).toContain("no backup service; see docs/deploy.md");
		const unit = join(home, ".config", "systemd", "user", "orrery-backup.service");
		mkdirSync(dirname(unit), { recursive: true });
		writeFileSync(unit, "[Service]\nExecStart=%h/.orrery/app/current/deploy/workstation/backup.sh\n");
		await wire(env, { run: fakeRun, confirm: neverAsked });
		expect(calls().filter((c) => c[0] === "systemctl")).toEqual([]);
	});
});

describe("pi, OMP and Claude Code", () => {
	it("rewires pi from another Orrery to app/current, after asking", async () => {
		const { env, home } = installedScratch();
		writePiExtension(env, "/old/checkout/src/pi/index.ts");
		const asked: string[] = [];
		await wire(env, {
			run: fakeRun,
			confirm: async (what) => {
				asked.push(what);
				return true;
			},
		});
		expect(asked.join("\n")).toMatch(/pi/);
		expect(readFileSync(piExtensionFile(env), "utf8")).toContain(join(home, ".orrery", "app", "current", "src", "pi", "index.ts"));
	});

	it("leaves pi's extension as it is when the rewiring is declined", async () => {
		const { env } = installedScratch();
		writePiExtension(env, "/old/checkout/src/pi/index.ts");
		const lines = await wire(env, { run: fakeRun, confirm: async () => false });
		expect(piExtension(env)).toContain("/old/checkout/src/pi/index.ts");
		expect(lines.join("\n")).toMatch(/^pi: left as it is/m);
	});

	it("wires a pi found on PATH without asking, and never writes an extension for a pi that is not there", async () => {
		const bare = installedScratch();
		await wire(bare.env, { run: fakeRun, confirm: neverAsked });
		expect(existsSync(piExtensionFile(bare.env))).toBe(false);
		expect(existsSync(ompExtensionFile(bare.env))).toBe(false);
		const { env, current } = installedScratch({ tools: { pi: 'echo "1.1.0"' } });
		const lines = await wire(env, { run: fakeRun, confirm: neverAsked });
		expect(piExtension(env)).toBe(piExtensionText(current));
		expect(lines.join("\n")).toMatch(/^pi: wrote /m);
	});

	it("installs the Claude Code plugin from app/current without asking when it is missing", async () => {
		const { env, calls, current } = installedScratch();
		await wire(env, { run: fakeRun, confirm: neverAsked });
		expect(calls()).toContainEqual(["claude", "plugin", "marketplace", "add", current]);
		expect(calls()).toContainEqual(["claude", "plugin", "install", "orrery@orrery"]);
		expect(calls().filter((c) => c[0] === "claude" && c[1] === "plugin" && c[2] === "marketplace" && c[3] === "remove")).toEqual([]);
	});

	it("asks before moving a Claude Code plugin that reads from another Orrery, and leaves it when declined", async () => {
		const plugins = JSON.stringify([{ id: "orrery@orrery", version: "0.1.0", enabled: true, readFromFolder: "/old/checkout/claude-plugin" }]);
		const { env, calls } = installedScratch({ tools: { claude: `if [ "$1" = "--version" ]; then echo "2.1.294 (Claude Code)"; elif [ "$1 $2" = "plugin list" ]; then printf '%s' ${JSON.stringify(plugins)}; fi` } });
		const asked: string[] = [];
		const lines = await wire(env, { run: fakeRun, confirm: async (what) => (asked.push(what), false) });
		expect(asked.join("\n")).toMatch(/^Claude Code: claude plugin marketplace add .*app\/current/m);
		expect(calls().filter((c) => c[0] === "claude" && c[2] === "marketplace")).toEqual([]);
		expect(lines.join("\n")).toMatch(/^Claude Code: left as it is/m);
	});
});

describe("what wiring leaves behind", () => {
	it("lists the tools left wired to another Orrery when no one can confirm, and the warning names the fix", async () => {
		const { env, home } = installedScratch({ tools: { pi: 'echo "1.1.0"' } });
		writePiExtension(env, "/old/checkout/src/pi/index.ts");
		mkdirSync(join(home, ".local", "bin"), { recursive: true });
		symlinkSync("/usr/bin/true", join(home, ".local", "bin", "orrery"));
		const { left } = await wireReport(env, { run: fakeRun, confirm: async () => false });
		expect(left.join("\n")).toMatch(/pi \(still wired to/);
		expect(left.join("\n")).toMatch(/orrery command/);
		const warning = leftWarning(left).join("\n");
		expect(warning).toContain("Still wired elsewhere");
		expect(warning).toContain("pi (still wired to");
		expect(warning).toContain("npm run install-local -- --yes");
		expect(warning).toContain("Tools");
		expect(piExtension(env)).toContain("/old/checkout/src/pi/index.ts");
	});

	it("lists a tool whose install failed, and nothing when everything is wired", async () => {
		const { env } = installedScratch({ tools: { pi: 'echo "1.1.0"' } });
		expect((await wireReport(env, { run: fakeRun, confirm: neverAsked })).left).toEqual([]);
		expect(leftWarning([])).toEqual([]);
		const failing = installedScratch({ tools: { claude: `if [ "$1" = "--version" ]; then echo "2.1.294 (Claude Code)"; elif [ "$1 $2" = "plugin list" ]; then printf '[]'; else echo nope >&2; exit 1; fi` } });
		const { left } = await wireReport(failing.env, { run: fakeRun, confirm: neverAsked });
		expect(left.join("\n")).toMatch(/Claude Code \(the install failed\)/);
	});

	it("lists a tool it could not check, with the reason, and leaves an OMP blocked by a shared folder as an info line", async () => {
		const unreadable = installedScratch({ tools: { pi: 'echo "1.1.0"' } });
		mkdirSync(piExtensionFile(unreadable.env), { recursive: true }); // a folder where the file belongs: cannot be read
		const bad = await wireReport(unreadable.env, { run: fakeRun, confirm: neverAsked });
		expect(bad.left).toEqual([]);
		expect(bad.unchecked.join("\n")).toMatch(/pi: cannot read/);
		const warning = leftWarning(bad.left, bad.unchecked).join("\n");
		expect(warning).toMatch(/check pi by hand: cannot read/);
		expect(warning).not.toMatch(/Still wired elsewhere|--yes/);
		const claude = installedScratch({ tools: { claude: `if [ "$1" = "--version" ]; then echo "2.1.294 (Claude Code)"; else echo timed out >&2; exit 1; fi` } });
		const failed = await wireReport(claude.env, { run: fakeRun, confirm: neverAsked });
		expect(failed.unchecked.join("\n")).toMatch(/Claude Code: claude plugin list/);
		const shared = installedScratch({ tools: { pi: 'echo "1.1.0"', omp: 'echo "18.10.2"' } });
		const env = { ...shared.env, PI_CODING_AGENT_DIR: join(shared.home, "agent") };
		const both = await wireReport(env, { run: fakeRun, confirm: neverAsked });
		expect(both.left).toEqual([]);
		expect(both.unchecked).toEqual([]);
		expect(both.lines.join("\n")).toMatch(/OMP/);
	});
});
