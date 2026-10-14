import { chmodSync, existsSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pathAdvice } from "../../src/install/ask.ts";
import { leftWarning, wire, wireReport } from "../../src/install/wire.ts";
import { ompExtensionFile, piExtensionFile, piExtensionText } from "../../src/lane/tools.ts";
import { addVersion, cleanupScratch, fakeRun, installedScratch, pointCurrent, tempDir, VERSION, writePiExtension } from "./support.ts";

afterEach(cleanupScratch);

const piExtension = (env: NodeJS.ProcessEnv) => readFileSync(piExtensionFile(env), "utf8");
const neverAsked = async (what: string): Promise<boolean> => {
	throw new Error(`asked: ${what}`);
};

/** An Orrery checkout (src/cli/main.ts and a package.json named orrery) or release (bin/orrery and a VERSION) outside the home. */
function orreryElsewhere(shape: "checkout" | "release"): string {
	const root = join(tempDir("orrery-elsewhere-"), shape);
	if (shape === "checkout") {
		mkdirSync(join(root, "src", "cli"), { recursive: true });
		writeFileSync(join(root, "src", "cli", "main.ts"), "\n");
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "orrery", version: "0.5.0" }));
		return join(root, "src", "cli", "main.ts");
	}
	mkdirSync(join(root, "bin"), { recursive: true });
	writeFileSync(join(root, "bin", "orrery"), "\n", { mode: 0o755 });
	writeFileSync(join(root, "VERSION"), "0.5.9\n");
	return join(root, "bin", "orrery");
}

describe("the orrery command", () => {
	it("links ~/.local/bin/orrery to app/current's CLI, replacing an Orrery checkout's or release's link without asking", async () => {
		for (const shape of ["checkout", "release"] as const) {
			const { env, home } = installedScratch();
			mkdirSync(join(home, ".local", "bin"), { recursive: true });
			const old = orreryElsewhere(shape);
			symlinkSync(old, join(home, ".local", "bin", "orrery"));
			const lines = await wire(env, { run: fakeRun, confirm: neverAsked });
			expect(readlinkSync(join(home, ".local", "bin", "orrery"))).toBe(join(home, ".orrery", "app", "current", "src", "cli", "main.ts"));
			expect(lines.join("\n")).toContain(`(was ${old})`);
		}
	});

	it("asks before replacing a link that is not provably Orrery's: another program, a lookalike path, a dangling link", async () => {
		const other = join(tempDir("orrery-other-"), "opt", "other");
		mkdirSync(join(other, "bin"), { recursive: true });
		writeFileSync(join(other, "bin", "orrery"), "#!/bin/sh\n", { mode: 0o755 });
		const notOrrery = join(tempDir("orrery-other-"), "tool");
		mkdirSync(join(notOrrery, "src", "cli"), { recursive: true });
		writeFileSync(join(notOrrery, "src", "cli", "main.ts"), "\n");
		writeFileSync(join(notOrrery, "package.json"), JSON.stringify({ name: "not-orrery" }));
		const lookalike = join(tempDir("orrery-other-"), "x");
		mkdirSync(join(lookalike, "mybin"), { recursive: true });
		writeFileSync(join(lookalike, "mybin", "orrery"), "#!/bin/sh\n", { mode: 0o755 });
		writeFileSync(join(lookalike, "VERSION"), "0.6.0\n");
		for (const target of [join(other, "bin", "orrery"), join(notOrrery, "src", "cli", "main.ts"), join(lookalike, "mybin", "orrery"), "/old/release/bin/orrery", "/x/mybin/orrery"]) {
			const { env, home } = installedScratch();
			const link = join(home, ".local", "bin", "orrery");
			mkdirSync(dirname(link), { recursive: true });
			symlinkSync(target, link);
			const asked: string[] = [];
			const lines = await wire(env, { run: fakeRun, confirm: async (what) => (asked.push(what), false) });
			expect(asked, target).toEqual([`replace ${link}?`]);
			expect(readlinkSync(link)).toBe(target);
			expect(lines.join("\n")).toMatch(/orrery command: left .* as it is/);
		}
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

describe("both install shapes", () => {
	const never = async (): Promise<boolean> => {
		throw new Error("asked");
	};

	it("binary style: the command links to bin/orrery and pi's file re-exports extensions/pi.js, without asking", async () => {
		const t = installedScratch({ style: "binary", tools: { pi: 'echo "pi 1.2.0"' } });
		await wire(t.env, { run: fakeRun, confirm: never });
		expect(readlinkSync(join(t.home, ".local", "bin", "orrery"))).toBe(join(t.current, "bin", "orrery"));
		expect(readFileSync(piExtensionFile(t.env), "utf8")).toBe(`export { default } from ${JSON.stringify(join(t.current, "extensions", "pi.js"))};\n`);
	});

	it("a switch between styles rewires the command, pi and OMP without asking, both ways", async () => {
		const t = installedScratch({ tools: { pi: 'echo "pi 1.2.0"', omp: 'echo "omp/18.8.9"' } });
		const omp = () => readFileSync(ompExtensionFile(t.env), "utf8");
		await wire(t.env, { run: fakeRun, confirm: never });
		expect(readFileSync(piExtensionFile(t.env), "utf8")).toBe(`export { default } from ${JSON.stringify(join(t.current, "src", "pi", "index.ts"))};\n`);
		expect(omp()).toMatch(/^export \{ default \} from "\.\.?\/.*app\/current\/src\/omp\/index\.ts";\n$/);
		addVersion(t, "0.6.0", "binary");
		pointCurrent(t, "0.6.0");
		const lines = await wire(t.env, { run: fakeRun, confirm: never });
		expect(readlinkSync(join(t.home, ".local", "bin", "orrery"))).toBe(join(t.current, "bin", "orrery"));
		expect(readFileSync(piExtensionFile(t.env), "utf8")).toBe(`export { default } from ${JSON.stringify(join(t.current, "extensions", "pi.js"))};\n`);
		expect(omp()).toMatch(/^export \{ default \} from "\.\.?\/.*app\/current\/extensions\/omp\.js";\n$/);
		expect(lines.join("\n")).toContain(`(was ${join(t.current, "src", "cli", "main.ts")})`);
		pointCurrent(t, VERSION);
		await wire(t.env, { run: fakeRun, confirm: never });
		expect(readlinkSync(join(t.home, ".local", "bin", "orrery"))).toBe(join(t.current, "src", "cli", "main.ts"));
		expect(readFileSync(piExtensionFile(t.env), "utf8")).toBe(`export { default } from ${JSON.stringify(join(t.current, "src", "pi", "index.ts"))};\n`);
		expect(omp()).toMatch(/^export \{ default \} from "\.\.?\/.*app\/current\/src\/omp\/index\.ts";\n$/);
	});

	it("OMP's relative re-export follows the style too", async () => {
		const t = installedScratch({ style: "binary", tools: { omp: 'echo "omp/18.8.9"' } });
		await wire(t.env, { run: fakeRun, confirm: never });
		const text = readFileSync(ompExtensionFile(t.env), "utf8");
		expect(text).toMatch(/^export \{ default \} from "\.\.?\/.*app\/current\/extensions\/omp\.js";\n$/);
	});

	it("asks before replacing a dangling link to a release that is gone", async () => {
		const t = installedScratch();
		mkdirSync(join(t.home, ".local", "bin"), { recursive: true });
		symlinkSync("/old/release/bin/orrery", join(t.home, ".local", "bin", "orrery"));
		const asked: string[] = [];
		await wire(t.env, { run: fakeRun, confirm: async (what) => (asked.push(what), true) });
		expect(asked).toEqual([`replace ${join(t.home, ".local", "bin", "orrery")}?`]);
		expect(readlinkSync(join(t.home, ".local", "bin", "orrery"))).toBe(join(t.current, "src", "cli", "main.ts"));
	});

	it("moves a link to a version folder of this home without asking, even after cleanup removed that version", async () => {
		const t = installedScratch({ style: "binary" });
		mkdirSync(join(t.home, ".local", "bin"), { recursive: true });
		symlinkSync(join(t.orreryHome, "app", "0.5.0-gone", "src", "cli", "main.ts"), join(t.home, ".local", "bin", "orrery"));
		await wire(t.env, { run: fakeRun, confirm: never });
		expect(readlinkSync(join(t.home, ".local", "bin", "orrery"))).toBe(join(t.current, "bin", "orrery"));
	});

	it("says how to put ~/.local/bin on PATH, for zsh and for bash, when it is not", () => {
		expect(pathAdvice({ HOME: "/h", SHELL: "/bin/zsh", PATH: "/usr/bin" }, "/h/.local/bin")).toBe(`~/.local/bin is not on your PATH. Add it: echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc, then open a new terminal.`);
		expect(pathAdvice({ HOME: "/h", SHELL: "/bin/bash", PATH: "/usr/bin" }, "/h/.local/bin")).toMatch(/>> ~\/\.bashrc/);
		expect(pathAdvice({ HOME: "/h", SHELL: "/bin/zsh", PATH: "/usr/bin:/h/.local/bin" }, "/h/.local/bin")).toBeUndefined();
		expect(pathAdvice({ HOME: "/h", SHELL: "/bin/zsh", PATH: "/usr/bin:/h/.local/bin/" }, "/h/.local/bin")).toBeUndefined();
		expect(pathAdvice({ HOME: "/h", SHELL: "/usr/bin/fish", PATH: "/usr/bin" }, "/h/.local/bin")).toBe("~/.local/bin is not on your PATH. Add it: fish_add_path ~/.local/bin, then open a new terminal.");
		expect(pathAdvice({ HOME: "/h", PATH: "/usr/bin" }, "/h/.local/bin")).toMatch(/>> ~\/\.profile, then open a new terminal\.$/);
	});

	it("adds the PATH line after the command's line, and leaves it out when ~/.local/bin is on PATH", async () => {
		const t = installedScratch();
		const lines = await wire({ ...t.env, SHELL: "/bin/zsh" }, { run: fakeRun, confirm: never });
		expect(lines[0]).toMatch(/^orrery command: /);
		expect(lines[1]).toBe(`~/.local/bin is not on your PATH. Add it: echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc, then open a new terminal.`);
		const onPath = await wireReport({ ...t.env, PATH: `${t.bin}:${join(t.home, ".local", "bin")}` }, { run: fakeRun, confirm: never });
		expect(onPath.lines.join("\n")).not.toMatch(/not on your PATH/);
		expect(onPath.left).toEqual([]);
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
		expect(warning).toContain("orrery setup --yes");
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
