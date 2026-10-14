import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkTools, probeOri, shortHome, toolVersionNumber, installSteps, ompAgentDir, ompExtensionFile, ompExtensionText, orreryRoot, piExtensionFile, piExtensionText, pluginVersion, runInstall, runningRoot, wiringRoot, type Runner, type ToolCheck } from "../../src/lane/tools.ts";
import { tempDir } from "./support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fake bin folder: each script prints its text; `claude plugin list --json` prints $FAKE_PLUGINS. */
function fakeBin(scripts: Record<string, string>) {
	const dir = tempDir("orrery-bin-");
	dirs.push(dir);
	for (const [name, body] of Object.entries(scripts)) {
		writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
		chmodSync(join(dir, name), 0o755);
	}
	const home = tempDir("orrery-home-");
	dirs.push(home);
	return { env: { PATH: dir, HOME: home }, home };
}

const CLAUDE = `if [ "$1" = "--version" ]; then echo "2.1.294 (Claude Code)"; else printf '%s' "$FAKE_PLUGINS"; fi`;
const root = orreryRoot();

describe("checkTools", () => {
	it("finds tools on PATH with their versions; Codex has no memory yet", () => {
		const { env } = fakeBin({ pi: "echo 1.1.0", codex: "echo codex-cli 0.161.0" });
		const [pi, claude, codex] = checkTools({ root, env });
		expect(pi).toMatchObject({ id: "pi", label: "pi", version: "1.1.0", wiring: "missing" });
		expect(claude).toMatchObject({ id: "claude-code", label: "Claude Code", wiring: "missing" });
		expect(claude.path).toBeUndefined();
		expect(codex).toMatchObject({ id: "codex", version: "codex-cli 0.161.0", wiring: "none", detail: "no memory yet" });
	});

	it("installs the pi extension, then sees it installed; one pointing elsewhere is 'other'", () => {
		const { env } = fakeBin({ pi: "echo 1.1.0" });
		const check = checkTools({ root, env })[0];
		const steps = installSteps(check, root, env);
		const entry = join(root, "src", "pi", "index.ts");
		expect(steps).toEqual([{ kind: "write", path: piExtensionFile(env), text: piExtensionText(root), describe: `write ${piExtensionFile(env)} (a re-export of ${entry})` }]);
		expect(runInstall(steps).ok).toBe(true);
		expect(readFileSync(piExtensionFile(env), "utf8")).toBe(`export { default } from ${JSON.stringify(entry)};\n`);
		expect(checkTools({ root, env })[0].wiring).toBe("installed");
		writeFileSync(piExtensionFile(env), 'export { default } from "/elsewhere/src/pi/index.ts";\n');
		expect(checkTools({ root, env })[0]).toMatchObject({ wiring: "other", detail: "points at another Orrery: /elsewhere/src/pi/index.ts" });
	});

	it("says what an install would replace and where it pointed; an installed or unreadable extension has no steps", () => {
		const { env } = fakeBin({ pi: "echo 1.1.0" });
		const file = piExtensionFile(env);
		const entry = join(root, "src", "pi", "index.ts");
		mkdirSync(join(file, ".."), { recursive: true });
		writeFileSync(file, 'export { default } from "/main/orrery/src/pi/index.ts";\n');
		const other = checkTools({ root, env })[0];
		expect(installSteps(other, root, env).map((s) => s.describe)).toEqual([`replace ${file} (now points at /main/orrery/src/pi/index.ts) with a re-export of ${entry}`]);
		writeFileSync(file, "console.log('mine');\n");
		expect(installSteps(checkTools({ root, env })[0], root, env).map((s) => s.describe)).toEqual([`replace ${file} (now not Orrery's one-line extension) with a re-export of ${entry}`]);
		writeFileSync(file, piExtensionText(root));
		const installed = checkTools({ root, env })[0];
		expect(installed.wiring).toBe("installed");
		expect(installSteps(installed, root, env)).toEqual([]);
		rmSync(file);
		mkdirSync(file);
		expect(installSteps(checkTools({ root, env })[0], root, env)).toEqual([]);
	});

	it("reads Claude Code's plugin list: missing, installed, update available, unreadable", () => {
		const { env } = fakeBin({ claude: CLAUDE });
		const plugin = (fields: object) => JSON.stringify([{ id: "orrery@orrery", enabled: true, readFromFolder: join(root, "claude-plugin"), version: pluginVersion(root), ...fields }]);
		expect(checkTools({ root, env: { ...env, FAKE_PLUGINS: "[]" } })[1].wiring).toBe("missing");
		expect(checkTools({ root, env: { ...env, FAKE_PLUGINS: plugin({}) } })[1].wiring).toBe("installed");
		expect(checkTools({ root, env: { ...env, FAKE_PLUGINS: plugin({ version: "0.0.1" }) } })[1].wiring).toBe("update available");
		expect(checkTools({ root, env: { ...env, FAKE_PLUGINS: plugin({ readFromFolder: "/elsewhere/claude-plugin" }) } })[1].wiring).toBe("other");
		expect(checkTools({ root, env: { ...env, FAKE_PLUGINS: "not json" } })[1].wiring).toBe("unknown");
		// A list in a shape orrery doesn't know (no entry has a string id) is unknown, not missing: nothing to install.
		const strange = checkTools({ root, env: { ...env, FAKE_PLUGINS: JSON.stringify([{ name: "orrery", marketplace: "orrery" }]) } })[1];
		expect(strange.wiring).toBe("unknown");
		expect(installSteps(strange, root, env)).toEqual([]);
		expect(checkTools({ root, env: { ...env, FAKE_PLUGINS: JSON.stringify([{ id: "other@x" }]) } })[1].wiring).toBe("missing");
	});

	it("plans the plugin commands, and stops at the first failing one with its output", () => {
		const { env } = fakeBin({ claude: CLAUDE });
		const missing = checkTools({ root, env: { ...env, FAKE_PLUGINS: "[]" } })[1];
		const steps = installSteps(missing, root, env);
		expect(steps.map((s) => (s.kind === "run" ? s.args.join(" ") : ""))).toEqual([`plugin marketplace add ${root}`, "plugin install orrery@orrery"]);
		const result = runInstall(steps, () => ({ status: 2, stdout: "", stderr: "boom" }));
		expect(result).toEqual({ ok: false, output: `$ claude plugin marketplace add ${root}\nboom\nexit 2\n` });
	});

	it("installs and recognises a root path with quotes and a backslash", () => {
		const { env } = fakeBin({ pi: "echo 1.1.0" });
		const odd = "/home/u/Bob's \"code\"\\x/orrery";
		const steps = installSteps(checkTools({ root: odd, env })[0], odd, env);
		expect(runInstall(steps).ok).toBe(true);
		expect(checkTools({ root: odd, env })[0].wiring).toBe("installed");
	});

	it("shows a clean version line without unrelated output", () => {
		const { env } = fakeBin({ pi: "printf '1.2.3\\033[31m red\\nsecond line\\n'" });
		const version = checkTools({ root, env })[0].version ?? "";
		expect(version).not.toContain("\u001b");
		expect(version).not.toContain("\n");
		expect(version).not.toContain("second");
	});

	it("never writes through a symlinked extension file: it replaces the link", () => {
		const { env, home } = fakeBin({ pi: "echo 1.1.0" });
		const target = join(home, "target.ts");
		writeFileSync(target, "keep me\n");
		const file = piExtensionFile(env);
		mkdirSync(join(file, ".."), { recursive: true });
		symlinkSync(target, file);
		const check = checkTools({ root, env })[0];
		expect(check.wiring).not.toBe("installed");
		expect(check.detail).toContain(target);
		expect(runInstall(installSteps(check, root, env)).ok).toBe(true);
		expect(readFileSync(target, "utf8")).toBe("keep me\n");
		expect(lstatSync(file).isSymbolicLink()).toBe(false);
		expect(readFileSync(file, "utf8")).toBe(piExtensionText(root));
	});

	it("never writes through a symlinked extension file, even when the link cannot be removed", () => {
		const { env, home } = fakeBin({ pi: "echo 1.1.0" });
		const target = join(home, "target.ts");
		writeFileSync(target, "keep me\n");
		const file = piExtensionFile(env);
		const folder = join(file, "..");
		mkdirSync(folder, { recursive: true });
		symlinkSync(target, file);
		const steps = installSteps(checkTools({ root, env })[0], root, env);
		chmodSync(folder, 0o555); // the link stays: neither removing it nor a new file in its folder is allowed
		try {
			const result = runInstall(steps);
			expect(result.ok).toBe(false);
			expect(result.output).toContain(`could not write ${file}`);
		} finally {
			chmodSync(folder, 0o755);
		}
		expect(readFileSync(target, "utf8")).toBe("keep me\n");
		expect(lstatSync(file).isSymbolicLink()).toBe(true);
	});

	it("does not crash when the extension path is a folder", () => {
		const { env } = fakeBin({ pi: "echo 1.1.0" });
		mkdirSync(piExtensionFile(env), { recursive: true });
		expect(checkTools({ root, env })[0]).toMatchObject({ wiring: "unknown", detail: `cannot read ${piExtensionFile(env)}` });
	});

	it("says when an install command did not finish", () => {
		const { env } = fakeBin({ claude: CLAUDE });
		const missing = checkTools({ root, env: { ...env, FAKE_PLUGINS: "[]" } })[1];
		const result = runInstall(installSteps(missing, root, env), () => ({ status: null, stdout: "", stderr: "timed out after 300 s" }));
		expect(result.ok).toBe(false);
		expect(result.output).toContain("timed out after 300 s\ndid not finish");
	});
});

describe("OMP", () => {
	it("is the fourth tool; installs a relative re-export in ~/.omp/agent/extensions, then sees it installed", () => {
		const { env, home } = fakeBin({ omp: "echo omp/18.8.7" });
		const check = checkTools({ root, env })[3];
		expect(check).toMatchObject({ id: "omp", label: "OMP", version: "omp/18.8.7", wiring: "missing" });
		const file = join(home, ".omp", "agent", "extensions", "orrery.ts");
		expect(ompExtensionFile(env)).toBe(file);
		const steps = installSteps(check, root, env);
		expect(steps).toEqual([{ kind: "write", path: file, text: ompExtensionText(root, file), describe: `write ${file} (a relative re-export of ${join(root, "src", "omp", "index.ts")})` }]);
		expect(runInstall(steps).ok).toBe(true);
		const spec = JSON.parse(/from (".*");/.exec(readFileSync(file, "utf8"))?.[1] ?? '""') as string;
		expect(spec.startsWith("../")).toBe(true);
		expect(resolve(realpathSync(dirname(file)), spec)).toBe(realpathSync(join(root, "src", "omp", "index.ts")));
		expect(checkTools({ root, env })[3]).toMatchObject({ wiring: "installed", detail: file });
	});

	it("finds OMP's agent dir in $PI_CODING_AGENT_DIR, else ~/$PI_CONFIG_DIR/agent", () => {
		expect(ompAgentDir({ HOME: "/h" })).toBe("/h/.omp/agent");
		expect(ompAgentDir({ HOME: "/h", PI_CONFIG_DIR: ".omp-test" })).toBe("/h/.omp-test/agent");
		expect(ompAgentDir({ HOME: "/h", PI_CODING_AGENT_DIR: "/srv/agent" })).toBe("/srv/agent");
	});

	it("calls an absolute re-export 'other' (OMP cannot load it) and replaces it with a relative one", () => {
		const { env } = fakeBin({ omp: "echo omp/18.8.7" });
		const file = ompExtensionFile(env);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `export { default } from ${JSON.stringify(join(root, "src", "omp", "index.ts"))};\n`);
		const check = checkTools({ root, env })[3];
		expect(check).toMatchObject({ wiring: "other", now: "an absolute re-export" });
		expect(runInstall(installSteps(check, root, env)).ok).toBe(true);
		expect(checkTools({ root, env })[3].wiring).toBe("installed");
	});

	it("never puts a second entry in a folder pi and OMP share (PI_CODING_AGENT_DIR), either way round", () => {
		const { env: base, home } = fakeBin({ pi: "echo 1.0.4", omp: "echo omp/18.8.7" });
		const env = { ...base, PI_CODING_AGENT_DIR: join(home, "agent") };
		expect(piExtensionFile(env)).toBe(ompExtensionFile(env));
		expect(checkTools({ root, env })[3].detail).toContain("pi and OMP share this folder");
		expect(runInstall(installSteps(checkTools({ root, env })[0], root, env)).ok).toBe(true);
		const omp = checkTools({ root, env })[3];
		expect(omp).toMatchObject({ wiring: "other", blocked: expect.any(String) });
		expect(omp.detail).toContain("is pi's Orrery extension");
		expect(installSteps(omp, root, env)).toEqual([]);
		writeFileSync(ompExtensionFile(env), ompExtensionText(root, ompExtensionFile(env)));
		const pi = checkTools({ root, env })[0];
		expect(pi).toMatchObject({ wiring: "other", blocked: expect.any(String) });
		expect(pi.detail).toContain("is OMP's Orrery extension");
		expect(installSteps(pi, root, env)).toEqual([]);
		expect(checkTools({ root, env })[3].wiring).toBe("installed");
	});
});


describe("the offline Ori probe", () => {
	it("finds Ori without running it synchronously, then reads only its offline version with privacy flags", async () => {
		const { env } = fakeBin({ ori: `test "$1 $2" = "version --semver" || exit 7
 test "$ORI_TELEMETRY:$ORI_NO_UPDATE_CHECK:$ORI_DISABLE_UPDATES:$ORI_CLAUDE_CLOUD_SESSION_SYNC" = "0:1:1:0" || exit 8
 echo 0.15.7` });
		const row = checkTools({ root: env.HOME, env, run: () => { throw new Error("no synchronous Ori probe"); } }).find((tool) => tool.id === "ori");
		expect(row).toMatchObject({ id: "ori", path: join(env.PATH, "ori"), signin: "unknown", wiring: "none" });
		expect(installSteps(row!, root, env)).toEqual([]);
		expect(await probeOri({ env })).toMatchObject({ id: "ori", version: "0.15.7", signin: "unknown" });
	});

	it.each(["echo garbage", "printf '\\033[31m0.15.7'", "echo 0.15.7; exit 1", "exec /bin/sleep 10"])("returns unknown for an unsafe, failed or timed-out version: %s", async (body) => {
		const { env } = fakeBin({ ori: body });
		expect(await probeOri({ env, timeout: 30 })).toMatchObject({ version: "unknown", signin: "unknown" });
	});

	it("does not run a missing Ori", async () => {
		const { env } = fakeBin({});
		expect(await probeOri({ env })).toMatchObject({ id: "ori", signin: "unknown" });
		expect((await probeOri({ env })).path).toBeUndefined();
	});
});


describe("tool wrapper output", () => {
	const wrapper = 'echo "mise ~/.config/mise/config.toml tools: pi@1.1.0"\necho "mise preparing tool"\n';
	it("takes the last version-looking line from fake PATH wrappers", () => {
		const { env } = fakeBin({
			pi: wrapper + 'echo 0.9.0\necho 1.1.0\necho "mise done"',
			claude: wrapper + CLAUDE,
			codex: wrapper + 'echo "codex-cli 0.161.0"',
			omp: wrapper + 'echo "omp/18.10.2"',
		});
		expect(checkTools({ root, env: { ...env, FAKE_PLUGINS: "[]" } }).slice(0, 4).map((t) => t.version)).toEqual(["1.1.0", "2.1.294 (Claude Code)", "codex-cli 0.161.0", "omp/18.10.2"]);
	});

	it("does not mistake a mise tool declaration for the version", () => {
		const { env } = fakeBin({ pi: wrapper });
		expect(checkTools({ root, env })[0].version).toBeUndefined();
	});

	it("reads a multiline Claude plugin JSON list after wrapper chatter", () => {
		const { env } = fakeBin({ claude: wrapper + CLAUDE });
		const plugins = JSON.stringify([{ id: "orrery@orrery", enabled: true, readFromFolder: join(root, "claude-plugin"), version: pluginVersion(root) }], null, 2);
		expect(checkTools({ root, env: { ...env, FAKE_PLUGINS: plugins } })[1].wiring).toBe("installed");
		expect(checkTools({ root, env: { ...env, FAKE_PLUGINS: "[]" } })[1].wiring).toBe("missing");
		// An object is valid JSON but not the plugin-list shape; never guess that the plugin is missing.
		expect(checkTools({ root, env: { ...env, FAKE_PLUGINS: '{"plugins":[]}' } })[1].wiring).toBe("unknown");
	});

	it("also reads Ori's last semver line behind a wrapper", async () => {
		const { env } = fakeBin({ ori: wrapper + 'echo 0.15.6\necho 0.15.7\necho "mise done"' });
		expect((await probeOri({ env })).version).toBe("0.15.7");
	});
});


it("shortens home paths only at path boundaries, without changing other homes", () => {
	expect(shortHome('/home/alex/.local/bin/pi; points at "/home/alex/code/orrery"', "/home/alex")).toBe('~/.local/bin/pi; points at "~/code/orrery"');
	expect(shortHome("/home/alexander/bin /srv/home/alex/bin", "/home/alex")).toBe("/home/alexander/bin /srv/home/alex/bin");
	expect(shortHome("at /home/a.b (work)/.pi/agent", "/home/a.b (work)")).toBe("at ~/.pi/agent");
	expect(shortHome("/home/alex", "/home/alex")).toBe("~");
});

it("extracts only the display version, retaining semver suffixes and unknown states", () => {
	for (const [raw, expected] of [["1.1.0", "1.1.0"], ["2.1.296 (Claude Code)", "2.1.296"], ["codex-cli 0.162.1", "0.162.1"], ["omp/18.10.2", "18.10.2"], ["v1.2.3-rc.1+build", "1.2.3-rc.1+build"], ["unknown", "unknown"]]) expect(toolVersionNumber(raw)).toBe(expected);
	expect(toolVersionNumber(undefined)).toBe("—");
});


describe("Wrangler detection", () => {
	it("finds Wrangler on PATH without an install action", () => {
		const { env, home } = fakeBin({ wrangler: "echo 4.45.0" });
		const row = checkTools({ root: home, env, probeWrangler: true }).find((tool) => tool.id === "wrangler");
		expect(row).toMatchObject({ label: "wrangler", path: join(env.PATH, "wrangler"), version: "4.45.0", wiring: "none" });
		expect(installSteps(row!, home, env)).toEqual([]);
	});

	it("finds the Worker's local Wrangler when PATH has none", () => {
		const { env, home } = fakeBin({});
		const bin = join(home, "worker", "node_modules", ".bin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "wrangler"), "#!/bin/sh\necho 4.45.0\n", { mode: 0o755 });
		expect(checkTools({ root: home, env, probeWrangler: true }).find((tool) => tool.id === "wrangler")).toMatchObject({ path: join(bin, "wrangler"), version: "4.45.0" });
	});

	it("lists no Wrangler row when Wrangler isn't installed (local-only users never see it)", () => {
		const { env, home } = fakeBin({});
		expect(checkTools({ root: home, env, probeWrangler: true }).find((tool) => tool.id === "wrangler")).toBeUndefined();
	});
});


it("launch and new-lane tool checks never run Wrangler, even when it is installed", () => {
	const { env, home } = fakeBin({ wrangler: "echo 4.45.0" });
	const calls: string[] = [];
	const checks = checkTools({ root: home, env, run: (cmd) => { calls.push(cmd); return { status: 0, stdout: "4.45.0", stderr: "" }; } });
	expect(calls).toEqual([]);
	expect(checks.find((tool) => tool.id === "wrangler")).toMatchObject({ path: join(env.PATH, "wrangler") });
	expect(checks.find((tool) => tool.id === "wrangler")?.version).toBeUndefined();
});

const VERSION = "0.6.0-abc1234";

/** A scratch Orrery home with app/<version>/src/{pi,omp}/index.ts and app/current linked to it, plus scratch agent folders. */
function installedHome() {
	const home = tempDir("orrery-installed-");
	dirs.push(home);
	const app = join(home, ".orrery", "app");
	for (const entry of ["pi", "omp"]) {
		mkdirSync(join(app, VERSION, "src", entry), { recursive: true });
		writeFileSync(join(app, VERSION, "src", entry, "index.ts"), "export default () => {};\n");
	}
	mkdirSync(join(app, VERSION, "claude-plugin"), { recursive: true });
	symlinkSync(VERSION, join(app, "current"));
	return { home, env: { PATH: "", HOME: home, ORRERY_HOME: join(home, ".orrery") } as NodeJS.ProcessEnv };
}

/** A release's shape at `dir`: bin/orrery and the packed extensions. */
function releaseShape(dir: string) {
	mkdirSync(join(dir, "bin"), { recursive: true });
	mkdirSync(join(dir, "extensions"), { recursive: true });
	writeFileSync(join(dir, "bin", "orrery"), "", { mode: 0o755 });
	writeFileSync(join(dir, "extensions", "pi.js"), "export default () => {};\n");
	writeFileSync(join(dir, "extensions", "omp.js"), "export default () => {};\n");
}

/** Points app/current at `version`. */
function relink(app: string, version: string) {
	rmSync(join(app, "current"));
	symlinkSync(version, join(app, "current"));
}

function scratchAgentEnv() {
	const home = tempDir("orrery-agent-");
	dirs.push(home);
	return { PATH: "", HOME: home } as NodeJS.ProcessEnv;
}

function writePiExtension(env: NodeJS.ProcessEnv, target: string) {
	const file = piExtensionFile(env);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `export { default } from ${JSON.stringify(target)};\n`);
}

/** Every --version exits non-zero, so no tool is found as a version; plugin lists are empty. */
const noTools: Runner = () => ({ status: 1, stdout: "", stderr: "" });

const missingPiCheck: ToolCheck = { id: "pi", label: "pi", wiring: "missing", detail: "no extension" };

describe("wiring names app/current", () => {
	it("writes pi's extension against app/current, not the version folder", () => {
		const { home, env } = installedHome();
		const root = join(home, ".orrery", "app", "current");
		const [step] = installSteps(missingPiCheck, root, env);
		expect(step).toMatchObject({ kind: "write" });
		expect((step as { text: string }).text).toBe(`export { default } from ${JSON.stringify(join(root, "src", "pi", "index.ts"))};\n`);
	});

	it("writes OMP's relative re-export through app/current", () => {
		const { home, env } = installedHome();
		const root = join(home, ".orrery", "app", "current");
		const text = ompExtensionText(root, ompExtensionFile(env));
		expect(text).toMatch(/app\/current\/src\/omp\/index\.ts"/);
		expect(text).not.toMatch(/0\.6\.0-abc1234/);
	});

	it("calls an extension that names a version folder 'other', so an install rewires it to current", () => {
		const { home, env } = installedHome();
		const root = join(home, ".orrery", "app", "current");
		writePiExtension(env, join(home, ".orrery", "app", VERSION, "src", "pi", "index.ts"));
		const [pi] = checkTools({ root, env, run: noTools });
		expect(pi.wiring).toBe("other");
	});

	it("calls a Claude Code plugin read from a version folder 'other'", () => {
		const { home, env } = installedHome();
		const app = join(home, ".orrery", "app");
		const { env: withClaude } = fakeBin({ claude: CLAUDE });
		const plugins = (from: string) => JSON.stringify([{ id: "orrery@orrery", version: "0.1.0", enabled: true, readFromFolder: from }]);
		const run = (from: string): Runner => (cmd, args) => (args[0] === "--version" ? { status: 0, stdout: "2.1.294 (Claude Code)\n", stderr: "" } : { status: 0, stdout: plugins(from), stderr: "" });
		const options = { root: join(app, "current"), env: { ...env, PATH: withClaude.PATH } };
		expect(checkTools({ ...options, run: run(join(app, VERSION, "claude-plugin")) })[1].wiring).toBe("other");
		expect(checkTools({ ...options, run: run(join(app, "current", "claude-plugin")) })[1].wiring).not.toBe("other");
	});

	it("moves a Claude Code plugin that reads from another Orrery with one marketplace add, without removing it", () => {
		const { home, env } = installedHome();
		const root = join(home, ".orrery", "app", "current");
		const withClaude = fakeBin({ claude: CLAUDE }).env;
		const plugins = JSON.stringify([{ id: "orrery@orrery", version: "0.1.0", enabled: true, readFromFolder: "/elsewhere/orrery/claude-plugin" }]);
		const run: Runner = (cmd, args) => (args[0] === "--version" ? { status: 0, stdout: "2.1.294 (Claude Code)\n", stderr: "" } : { status: 0, stdout: plugins, stderr: "" });
		const claude = checkTools({ root, env: { ...env, PATH: withClaude.PATH }, run })[1];
		expect(claude.wiring).toBe("other");
		const steps = installSteps(claude, root, env);
		expect(steps.map((s) => (s.kind === "run" ? s.args.join(" ") : ""))).toEqual([`plugin marketplace add ${root}`]);
		expect(steps[0].describe).toContain(`moves the Orrery plugin from the other Orrery to ${root}`);
	});

	it("still accepts a checkout's own path in development mode", () => {
		const checkout = tempDir("orrery-checkout-");
		dirs.push(checkout);
		const env = scratchAgentEnv();
		writePiExtension(env, join(checkout, "src", "pi", "index.ts"));
		const [pi] = checkTools({ root: checkout, env, run: noTools });
		expect(pi.wiring).toBe("installed");
	});

	it("a release in app/current is wired through its packed extensions", () => {
		const { home, env } = installedHome();
		const app = join(home, ".orrery", "app");
		releaseShape(join(app, "0.6.0"));
		relink(app, "0.6.0");
		const root = join(app, "current");
		expect(piExtensionText(root)).toBe(`export { default } from ${JSON.stringify(join(root, "extensions", "pi.js"))};\n`);
		const ompText = ompExtensionText(root, ompExtensionFile(env));
		expect(ompText).toMatch(/^export \{ default \} from "\.\.?\/.*app\/current\/extensions\/omp\.js";\n$/);
		expect(ompText).not.toMatch(/0\.6\.0\//);
		const [step] = installSteps(missingPiCheck, root, env);
		expect(step).toMatchObject({ kind: "write", describe: `write ${piExtensionFile(env)} (a re-export of ${join(root, "extensions", "pi.js")})` });
	});

	it("calls Orrery's entry of the other shape under the same root 'update available', and rewrites it without a question", () => {
		const { home, env } = installedHome();
		const app = join(home, ".orrery", "app");
		const root = join(app, "current");
		writePiExtension(env, join(root, "src", "pi", "index.ts"));
		const ompFile = ompExtensionFile(env);
		mkdirSync(dirname(ompFile), { recursive: true });
		writeFileSync(ompFile, ompExtensionText(root, ompFile));
		releaseShape(join(app, "0.6.0"));
		relink(app, "0.6.0");
		const checks = checkTools({ root, env, run: noTools });
		const pi = checks[0];
		const omp = checks[3];
		expect(pi).toMatchObject({ wiring: "update available", detail: "Orrery's source entry; setup moves it to this version's", now: `points at ${join(root, "src", "pi", "index.ts")}` });
		expect(omp).toMatchObject({ wiring: "update available", detail: "Orrery's source entry; setup moves it to this version's" });
		const piSteps = installSteps(pi, root, env);
		expect(piSteps).toEqual([{ kind: "write", path: piExtensionFile(env), text: piExtensionText(root), describe: `rewrite ${piExtensionFile(env)} (now points at ${join(root, "src", "pi", "index.ts")}) as a re-export of ${join(root, "extensions", "pi.js")}` }]);
		expect(runInstall(piSteps).ok).toBe(true);
		expect(runInstall(installSteps(omp, root, env)).ok).toBe(true);
		const after = checkTools({ root, env, run: noTools });
		expect(after[0].wiring).toBe("installed");
		expect(after[3].wiring).toBe("installed");
		relink(app, VERSION);
		const back = checkTools({ root, env, run: noTools });
		expect(back[0]).toMatchObject({ wiring: "update available", detail: "Orrery's binary entry; setup moves it to this version's" });
		expect(back[3]).toMatchObject({ wiring: "update available", detail: "Orrery's binary entry; setup moves it to this version's" });
	});

	it("knows either shape's entry as Orrery's in a folder pi and OMP share", () => {
		const { home, env: base } = installedHome();
		const env = { ...base, PI_CODING_AGENT_DIR: join(home, "agent") };
		const app = join(home, ".orrery", "app");
		releaseShape(join(app, "0.6.0"));
		relink(app, "0.6.0");
		const root = join(app, "current");
		const file = ompExtensionFile(env);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, ompExtensionText(root, file));
		expect(checkTools({ root, env, run: noTools })[0]).toMatchObject({ wiring: "other", blocked: expect.any(String) });
		writeFileSync(file, piExtensionText(root));
		expect(checkTools({ root, env, run: noTools })[3]).toMatchObject({ wiring: "other", blocked: expect.any(String) });
	});

	it("names this checkout, not installed, when it is not inside the home's app folder", () => {
		const { env } = installedHome();
		expect(wiringRoot(env)).toEqual({ root: runningRoot(), installed: false });
	});
});
