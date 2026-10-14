import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pathAdvice, terminalConfirm } from "../../src/install/ask.ts";
import { leftWarning, wire, wireReport } from "../../src/install/wire.ts";
import { ompExtensionFile, ompExtensionText, piExtensionFile, piExtensionText } from "../../src/agent/tools.ts";
import { addVersion, cleanupScratch, fakeRun, installedScratch, pointCurrent, tempDir, VERSION, writePiExtension } from "./support.ts";

afterEach(cleanupScratch);

const piExtension = (env: NodeJS.ProcessEnv) => readFileSync(piExtensionFile(env), "utf8");
const neverAsked = async (what: string): Promise<boolean> => {
	throw new Error(`asked: ${what}`);
};
/** Answers yes to "Connect Orrery to <label>?" for the tools named, and fails the test on any other question. */
const connectOnly =
	(...labels: string[]) =>
	async (what: string): Promise<boolean> => {
		if (labels.some((label) => what.startsWith(`Connect Orrery to ${label}? (`))) return true;
		throw new Error(`asked: ${what}`);
	};
/** The questions that are not about connecting Claude Code (every scratch has a fake claude with no plugin). */
const notClaude = (asked: string[]) => asked.filter((what) => !what.startsWith("Connect Orrery to Claude Code? ("));
/** What setup set aside beside `path` (<name>.before-orrery-<date>), oldest first. */
const setAside = (path: string) =>
	readdirSync(dirname(path))
		.filter((name) => name.startsWith(`${basename(path)}.before-orrery-`))
		.sort((a, b) => a.length - b.length || a.localeCompare(b))
		.map((name) => join(dirname(path), name));

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
			const lines = await wire(env, { run: fakeRun, confirm: connectOnly("Claude Code") });
			expect(readlinkSync(join(home, ".local", "bin", "orrery"))).toBe(join(home, ".orrery", "app", "current", "src", "cli", "main.ts"));
			expect(lines.join("\n")).toContain(`(was ${old})`);
			expect(setAside(join(home, ".local", "bin", "orrery"))).toEqual([]);
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
			expect(notClaude(asked), target).toEqual([`replace ${link}?`]);
			expect(readlinkSync(link)).toBe(target);
			expect(lines.join("\n")).toMatch(/orrery command: left .* as it is/);
		}
	});

	it("creates ~/.local/bin when it is missing, and says when the link is already right", async () => {
		const { env, home } = installedScratch();
		await wire(env, { run: fakeRun, confirm: connectOnly("Claude Code") });
		const link = join(home, ".local", "bin", "orrery");
		expect(readlinkSync(link)).toBe(join(home, ".orrery", "app", "current", "src", "cli", "main.ts"));
		expect((await wire(env, { run: fakeRun, confirm: connectOnly("Claude Code") })).join("\n")).toMatch(/orrery command: .*already links/);
	});

	it("leaves a foreign ~/.local/bin/orrery alone unless confirmed, and sets it aside before replacing it", async () => {
		const { env, home } = installedScratch();
		const link = join(home, ".local", "bin", "orrery");
		mkdirSync(dirname(link), { recursive: true });
		writeFileSync(link, "#!/bin/sh\necho someone else\n", { mode: 0o755 });
		const asked: string[] = [];
		const lines = await wire(env, { run: fakeRun, confirm: async (what) => (asked.push(what), false) });
		expect(readFileSync(link, "utf8")).toMatch(/someone else/);
		expect(lines.join("\n")).toMatch(/left .*orrery.* as it is/);
		expect(notClaude(asked)).toEqual([`replace ${link}?`]);
		expect(setAside(link)).toEqual([]);
		const replaced = await wire(env, { run: fakeRun, confirm: async () => true });
		expect(readlinkSync(link)).toBe(join(home, ".orrery", "app", "current", "src", "cli", "main.ts"));
		const [aside] = setAside(link);
		expect(aside).toMatch(/\/orrery\.before-orrery-\d{4}-\d{2}-\d{2}$/);
		expect(readFileSync(aside as string, "utf8")).toMatch(/someone else/);
		expect(replaced.join("\n")).toContain(`(the one there before is now ${aside})`);
	});

	it("sets a foreign link aside too, beside one set aside earlier the same day", async () => {
		const { env, home } = installedScratch();
		const link = join(home, ".local", "bin", "orrery");
		mkdirSync(dirname(link), { recursive: true });
		symlinkSync("/opt/someone/else", link);
		await wire(env, { run: fakeRun, confirm: async () => true });
		symlinkSync("/opt/another", `${link}.next`);
		renameSync(`${link}.next`, link);
		await wire(env, { run: fakeRun, confirm: async () => true });
		const asides = setAside(link);
		expect(asides.map((aside) => readlinkSync(aside))).toEqual(["/opt/someone/else", "/opt/another"]);
		expect(asides[1]).toMatch(/\.before-orrery-\d{4}-\d{2}-\d{2}-2$/);
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
		expect((await wire(env, { run: fakeRun, confirm: connectOnly("Claude Code"), platform: "linux" })).join("\n")).toContain("no backup service; see docs/deploy.md");
		const unit = join(home, ".config", "systemd", "user", "orrery-backup.service");
		mkdirSync(dirname(unit), { recursive: true });
		writeFileSync(unit, "[Service]\nExecStart=%h/.orrery/app/current/deploy/workstation/backup.sh\n");
		await wire(env, { run: fakeRun, confirm: connectOnly("Claude Code") });
		expect(calls().filter((c) => c[0] === "systemctl")).toEqual([]);
	});

	it("on macOS says there is no scheduled backup yet and how to make one", async () => {
		const { env } = installedScratch();
		const text = (await wire(env, { run: fakeRun, confirm: connectOnly("Claude Code"), platform: "darwin" })).join("\n");
		expect(text).toContain("no scheduled backup on macOS yet; run `orrery backup` when you want one");
		expect(text).not.toContain("docs/deploy.md");
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

	it("connects a pi found on PATH once asked, and never writes an extension for a pi that is not there", async () => {
		const bare = installedScratch();
		await wire(bare.env, { run: fakeRun, confirm: connectOnly("Claude Code") });
		expect(existsSync(piExtensionFile(bare.env))).toBe(false);
		expect(existsSync(ompExtensionFile(bare.env))).toBe(false);
		const { env, current } = installedScratch({ tools: { pi: 'echo "1.1.0"' } });
		const lines = await wire(env, { run: fakeRun, confirm: connectOnly("pi", "Claude Code") });
		expect(piExtension(env)).toBe(piExtensionText(current));
		expect(lines.join("\n")).toMatch(/^pi: wrote /m);
	});

	it("asks before connecting each tool that has no Orrery wiring yet, saying what it writes or runs", async () => {
		const { env, calls, current } = installedScratch({ tools: { pi: 'echo "pi 1.2.0"', omp: 'echo "omp/18.8.9"' } });
		const asked: string[] = [];
		await wire(env, { run: fakeRun, confirm: async (what) => (asked.push(what), true) });
		expect(asked).toEqual([
			`Connect Orrery to pi? (writes ${piExtensionFile(env)})`,
			`Connect Orrery to Claude Code? (claude plugin marketplace add ${current}, claude plugin install orrery@orrery)`,
			`Connect Orrery to OMP? (writes ${ompExtensionFile(env)})`,
		]);
		expect(piExtension(env)).toBe(piExtensionText(current));
		expect(readFileSync(ompExtensionFile(env), "utf8")).toBe(ompExtensionText(current, ompExtensionFile(env)));
		expect(calls()).toContainEqual(["claude", "plugin", "marketplace", "add", current]);
		expect(calls()).toContainEqual(["claude", "plugin", "install", "orrery@orrery"]);
		expect(calls().filter((c) => c[0] === "claude" && c[1] === "plugin" && c[2] === "marketplace" && c[3] === "remove")).toEqual([]);
	});

	it("leaves a tool unconnected when the connection is declined, and lists it", async () => {
		const { env, calls } = installedScratch({ tools: { pi: 'echo "pi 1.2.0"' } });
		const { lines, left } = await wireReport(env, { run: fakeRun, confirm: async (what) => !what.startsWith("Connect Orrery to ") });
		expect(existsSync(piExtensionFile(env))).toBe(false);
		expect(calls().filter((c) => c[0] === "claude" && c[1] === "plugin" && c[2] !== "list")).toEqual([]);
		expect(lines.join("\n")).toMatch(/^pi: not connected/m);
		expect(lines.join("\n")).toMatch(/^Claude Code: not connected/m);
		expect(left).toEqual(["pi (not connected)", "Claude Code (not connected)"]);
		expect(leftWarning(left).join("\n")).toContain("orrery setup --yes");
	});

	it("--yes connects without asking anyone", async () => {
		const { env, calls, current } = installedScratch({ tools: { pi: 'echo "pi 1.2.0"' } });
		const said: string[] = [];
		const { left } = await wireReport(env, { run: fakeRun, confirm: terminalConfirm({ yes: true, say: (line) => said.push(line) }) });
		expect(left).toEqual([]);
		expect(said).toEqual([]);
		expect(piExtension(env)).toBe(piExtensionText(current));
		expect(calls()).toContainEqual(["claude", "plugin", "install", "orrery@orrery"]);
	});

	it("sets a foreign pi extension aside before replacing it, and replaces another Orrery's one line without a copy", async () => {
		const { env, current } = installedScratch({ tools: { pi: 'echo "pi 1.2.0"' } });
		const file = piExtensionFile(env);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, "// someone's own extension\nexport default () => {};\n");
		const lines = (await wire(env, { run: fakeRun, confirm: async () => true })).join("\n");
		expect(piExtension(env)).toBe(piExtensionText(current));
		const [aside] = setAside(file);
		expect(aside).toMatch(/\/orrery\.ts\.before-orrery-\d{4}-\d{2}-\d{2}$/);
		expect(readFileSync(aside as string, "utf8")).toContain("someone's own extension");
		expect(lines).toContain(`pi: set ${file} aside as ${aside}`);
		const other = installedScratch({ tools: { pi: 'echo "pi 1.2.0"' } });
		writePiExtension(other.env, "/old/checkout/src/pi/index.ts");
		await wire(other.env, { run: fakeRun, confirm: async () => true });
		expect(setAside(piExtensionFile(other.env))).toEqual([]);
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
	it("binary style: the command links to bin/orrery and pi's file re-exports extensions/pi.js", async () => {
		const t = installedScratch({ style: "binary", tools: { pi: 'echo "pi 1.2.0"' } });
		await wire(t.env, { run: fakeRun, confirm: connectOnly("pi", "Claude Code") });
		expect(readlinkSync(join(t.home, ".local", "bin", "orrery"))).toBe(join(t.current, "bin", "orrery"));
		expect(readFileSync(piExtensionFile(t.env), "utf8")).toBe(`export { default } from ${JSON.stringify(join(t.current, "extensions", "pi.js"))};\n`);
	});

	it("a switch between styles rewires the command, pi and OMP without asking, both ways", async () => {
		const t = installedScratch({ tools: { pi: 'echo "pi 1.2.0"', omp: 'echo "omp/18.8.9"' } });
		const omp = () => readFileSync(ompExtensionFile(t.env), "utf8");
		await wire(t.env, { run: fakeRun, confirm: connectOnly("pi", "OMP", "Claude Code") });
		expect(readFileSync(piExtensionFile(t.env), "utf8")).toBe(`export { default } from ${JSON.stringify(join(t.current, "src", "pi", "index.ts"))};\n`);
		expect(omp()).toMatch(/^export \{ default \} from "\.\.?\/.*app\/current\/src\/omp\/index\.ts";\n$/);
		addVersion(t, "0.6.0", "binary");
		pointCurrent(t, "0.6.0");
		// The fake claude never lists the plugin, so it is the only tool asked about again.
		const lines = await wire(t.env, { run: fakeRun, confirm: connectOnly("Claude Code") });
		expect(readlinkSync(join(t.home, ".local", "bin", "orrery"))).toBe(join(t.current, "bin", "orrery"));
		expect(readFileSync(piExtensionFile(t.env), "utf8")).toBe(`export { default } from ${JSON.stringify(join(t.current, "extensions", "pi.js"))};\n`);
		expect(omp()).toMatch(/^export \{ default \} from "\.\.?\/.*app\/current\/extensions\/omp\.js";\n$/);
		expect(lines.join("\n")).toContain(`(was ${join(t.current, "src", "cli", "main.ts")})`);
		pointCurrent(t, VERSION);
		await wire(t.env, { run: fakeRun, confirm: connectOnly("Claude Code") });
		expect(readlinkSync(join(t.home, ".local", "bin", "orrery"))).toBe(join(t.current, "src", "cli", "main.ts"));
		expect(readFileSync(piExtensionFile(t.env), "utf8")).toBe(`export { default } from ${JSON.stringify(join(t.current, "src", "pi", "index.ts"))};\n`);
		expect(omp()).toMatch(/^export \{ default \} from "\.\.?\/.*app\/current\/src\/omp\/index\.ts";\n$/);
		expect(setAside(piExtensionFile(t.env))).toEqual([]);
	});

	it("OMP's relative re-export follows the style too", async () => {
		const t = installedScratch({ style: "binary", tools: { omp: 'echo "omp/18.8.9"' } });
		await wire(t.env, { run: fakeRun, confirm: connectOnly("OMP", "Claude Code") });
		const text = readFileSync(ompExtensionFile(t.env), "utf8");
		expect(text).toMatch(/^export \{ default \} from "\.\.?\/.*app\/current\/extensions\/omp\.js";\n$/);
	});

	it("asks before replacing a dangling link to a release that is gone", async () => {
		const t = installedScratch();
		mkdirSync(join(t.home, ".local", "bin"), { recursive: true });
		symlinkSync("/old/release/bin/orrery", join(t.home, ".local", "bin", "orrery"));
		const asked: string[] = [];
		await wire(t.env, { run: fakeRun, confirm: async (what) => (asked.push(what), true) });
		expect(notClaude(asked)).toEqual([`replace ${join(t.home, ".local", "bin", "orrery")}?`]);
		expect(readlinkSync(join(t.home, ".local", "bin", "orrery"))).toBe(join(t.current, "src", "cli", "main.ts"));
	});

	it("moves a link to a version folder of this home without asking, even after cleanup removed that version", async () => {
		const t = installedScratch({ style: "binary" });
		mkdirSync(join(t.home, ".local", "bin"), { recursive: true });
		symlinkSync(join(t.orreryHome, "app", "0.5.0-gone", "src", "cli", "main.ts"), join(t.home, ".local", "bin", "orrery"));
		await wire(t.env, { run: fakeRun, confirm: connectOnly("Claude Code") });
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
		const lines = await wire({ ...t.env, SHELL: "/bin/zsh" }, { run: fakeRun, confirm: connectOnly("Claude Code") });
		expect(lines[0]).toMatch(/^orrery command: /);
		expect(lines[1]).toBe(`~/.local/bin is not on your PATH. Add it: echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc, then open a new terminal.`);
		const onPath = await wireReport({ ...t.env, PATH: `${t.bin}:${join(t.home, ".local", "bin")}` }, { run: fakeRun, confirm: connectOnly("Claude Code") });
		expect(onPath.lines.join("\n")).not.toMatch(/not on your PATH/);
		expect(onPath.left).toEqual([]);
	});
});

describe("what wiring leaves behind", () => {
	it("lists the tools left wired to another Orrery or not connected when no one can confirm, and the warning names the fix", async () => {
		const { env, home } = installedScratch({ tools: { pi: 'echo "1.1.0"' } });
		writePiExtension(env, "/old/checkout/src/pi/index.ts");
		mkdirSync(join(home, ".local", "bin"), { recursive: true });
		symlinkSync("/usr/bin/true", join(home, ".local", "bin", "orrery"));
		const { left } = await wireReport(env, { run: fakeRun, confirm: async () => false });
		expect(left.join("\n")).toMatch(/pi \(still wired to/);
		expect(left.join("\n")).toMatch(/orrery command/);
		expect(left).toContain("Claude Code (not connected)");
		const warning = leftWarning(left).join("\n");
		expect(warning).toContain("Not everything points at this install:");
		expect(warning).toContain("pi (still wired to");
		expect(warning).toContain("orrery setup --yes");
		expect(warning).toContain("Tools");
		expect(piExtension(env)).toContain("/old/checkout/src/pi/index.ts");
	});

	it("lists a tool whose install failed, and nothing when everything is wired", async () => {
		const { env } = installedScratch({ tools: { pi: 'echo "1.1.0"' } });
		expect((await wireReport(env, { run: fakeRun, confirm: connectOnly("pi", "Claude Code") })).left).toEqual([]);
		expect(leftWarning([])).toEqual([]);
		const failing = installedScratch({ tools: { claude: `if [ "$1" = "--version" ]; then echo "2.1.294 (Claude Code)"; elif [ "$1 $2" = "plugin list" ]; then printf '[]'; else echo nope >&2; exit 1; fi` } });
		const { left } = await wireReport(failing.env, { run: fakeRun, confirm: connectOnly("Claude Code") });
		expect(left.join("\n")).toMatch(/Claude Code \(the install failed\)/);
	});

	it("lists a tool it could not check, with the reason, and leaves an OMP blocked by a shared folder as an info line", async () => {
		const unreadable = installedScratch({ tools: { pi: 'echo "1.1.0"' } });
		mkdirSync(piExtensionFile(unreadable.env), { recursive: true }); // a folder where the file belongs: cannot be read
		const bad = await wireReport(unreadable.env, { run: fakeRun, confirm: connectOnly("Claude Code") });
		expect(bad.left).toEqual([]);
		expect(bad.unchecked.join("\n")).toMatch(/pi: cannot read/);
		const warning = leftWarning(bad.left, bad.unchecked).join("\n");
		expect(warning).toMatch(/check pi by hand: cannot read/);
		expect(warning).not.toMatch(/Not everything points|--yes/);
		const claude = installedScratch({ tools: { claude: `if [ "$1" = "--version" ]; then echo "2.1.294 (Claude Code)"; else echo timed out >&2; exit 1; fi` } });
		const failed = await wireReport(claude.env, { run: fakeRun, confirm: neverAsked });
		expect(failed.unchecked.join("\n")).toMatch(/Claude Code: claude plugin list/);
		const shared = installedScratch({ tools: { pi: 'echo "1.1.0"', omp: 'echo "18.10.2"' } });
		const env = { ...shared.env, PI_CODING_AGENT_DIR: join(shared.home, "agent") };
		const both = await wireReport(env, { run: fakeRun, confirm: connectOnly("pi", "Claude Code") });
		expect(both.left).toEqual([]);
		expect(both.unchecked).toEqual([]);
		expect(both.lines.join("\n")).toMatch(/OMP/);
	});
});
