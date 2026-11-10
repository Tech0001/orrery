import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type LaunchPlan, grokSettingsSteps } from "../../src/agent/launch.ts";
import { forgetSession, recordSession } from "../../src/agent/sessions.ts";
import { checkTools, installSteps, orreryRoot, runInstall, type Runner, type ToolCheck } from "../../src/agent/tools.ts";
import { openAgentCommand } from "../../src/cli/agent.ts";
import { grokSettingsCommand } from "../../src/cli/grok-settings.ts";
import { addGrokConfig, grokHookFile, grokSettingsWords } from "../../src/grok/install.ts";
import { settingsDataDir } from "../../src/grok/settings-keys.ts";
import { approveGrokSettings, checkGrokSettings, type SettingsCheck } from "../../src/grok/settings.ts";
import { installFrom } from "../../src/install/install.ts";
import { entries } from "../../src/install/layout.ts";
import { uninstall } from "../../src/install/uninstall.ts";
import { wireReport } from "../../src/install/wire.ts";
import { cleanEnv, cliCommand } from "../claude/support.ts";
import { cleanupScratch, fakeRun, fixtureRelease, grokScratch, tempDir } from "../install/support.ts";

/** The data folders whose record of approved Grok settings was read: every check goes through checkGrokSettings. */
const reads = vi.hoisted(() => ({ dataDirs: [] as string[] }));
vi.mock("../../src/grok/settings.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/grok/settings.ts")>();
	return { ...actual, checkGrokSettings: (...args: Parameters<typeof actual.checkGrokSettings>) => (reads.dataDirs.push(args[0]), actual.checkGrokSettings(...args)) };
});

const recorded: [string, number][] = [];
afterEach(() => {
	for (const [dataDir, pid] of recorded.splice(0)) forgetSession(dataDir, pid);
	vi.unstubAllEnvs();
	cleanupScratch();
});

/** A hook file running `program` at Stop. */
const hookFile = (program: string) => JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: program, args: [] }] }] } });

/** Today, local time, as YYYY-MM-DD: the date an approval made now is shown with. */
function today(): string {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** A check's lines: the changes, or the first run's list. */
const linesOf = (check: SettingsCheck): string[] => (check.state === "changed" ? check.changes.map((change) => change.line) : check.state === "first" ? [...check.lines] : []);

/**
 * Atlas, a Grok agent, in a scratch home: its folder (the project), a config whose data folder holds the record, a fake
 * grok on PATH, and a Grok folder of its own (GROK_HOME). Unless `connected` is false, Orrery's hook file and config
 * tables are there, for this checkout, as setup writes them.
 */
function scene(options: { connected?: boolean } = {}) {
	const dir = realpathSync(tempDir("orrery-grok-gate-"));
	const home = join(dir, "home");
	const grok = join(dir, "grok");
	const data = join(dir, "data");
	const project = join(dir, "work", "atlas");
	const bin = join(dir, "bin");
	for (const folder of [home, join(grok, "hooks"), data, project, bin]) mkdirSync(folder, { recursive: true });
	const out = join(dir, "out.txt");
	writeFileSync(join(bin, "grok"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "grok 1.0.70 (abc) [stable]"; exit 0; fi\nprintf 'grok|%s\\n' "$ORRERY_AGENT" > ${JSON.stringify(out)}\n`, { mode: 0o755 });
	const config = join(dir, "config.toml");
	writeFileSync(config, `data_dir = ${JSON.stringify(data)}\n[agents.Atlas]\nfolder = ${JSON.stringify(project)}\ntool = "grok"\ncompactor_model = "openai/gpt-6.1-sol"\n`);
	const env = cleanEnv({ PATH: `${bin}:/usr/bin:/bin`, HOME: home, ORRERY_HOME: join(dir, "orrery-home"), ORRERY_CONFIG: config, GROK_HOME: grok });
	if (options.connected !== false) {
		const own = entries(orreryRoot()).cli;
		writeFileSync(join(grok, "hooks", "orrery.json"), grokHookFile(own));
		writeFileSync(join(grok, "config.toml"), addGrokConfig("", own).next);
	}
	const check = (folder: string | undefined = project) => checkGrokSettings(data, env, folder);
	const approve = (folder: string | undefined = project) => approveGrokSettings(data, check(folder).shown);
	const record = join(data, "grok-settings.json");
	return { dir, home, grok, data, project, config, env, out, record, check, approve };
}

type Scene = ReturnType<typeof scene>;

/** The scene's environment as this process's, for the launch, which reads it (checkTools, launchPlan). */
function stubbed(s: Scene): void {
	for (const [key, value] of Object.entries(s.env)) if (value !== undefined) vi.stubEnv(key, value);
}

/** `orrery agent Atlas` in the scene's project, through the launch runner, with `io`; what it ran. */
async function launch(s: Scene, io: Parameters<typeof openAgentCommand>[3], cwd = s.project): Promise<{ code: number; ran: LaunchPlan[] }> {
	stubbed(s);
	const ran: LaunchPlan[] = [];
	const code = await openAgentCommand(s.config, "Atlas", { args: [], cwd }, io, {
		takeover: async () => {
			throw new Error("must not take over");
		},
		run: async (plan) => (ran.push(plan), { code: 0, signal: null }),
	});
	return { code, ran };
}

describe("the launch's Grok settings gate", () => {
	it("launch asks on change", () => {
		const s = scene();
		s.approve();
		expect(grokSettingsSteps(s.data, s.env, s.project)).toEqual([]);
		const added = join(s.grok, "hooks", "x.json");
		writeFileSync(added, hookFile("/nowhere/x"));
		const steps = grokSettingsSteps(s.data, s.env, s.project);
		expect(steps).toHaveLength(1);
		expect(steps[0]).toMatchObject({ confirm: true, fix: "approve-grok-settings", grokSettings: { defaultYes: false } });
		expect(steps[0]?.text.startsWith("Grok's settings changed since you approved them on")).toBe(true);
		expect(steps[0]?.text.split("\n")).toEqual([`Grok's settings changed since you approved them on ${today()}:`, `  added    hook file ${added} (Stop; runs x)`, "Approve these changes to Grok's settings? [y/N]"]);
		// A record that can't be read, or one with no entry for this Grok folder: everything is listed, and the default is no.
		writeFileSync(s.record, "not a record\n");
		const unread = grokSettingsSteps(s.data, s.env, s.project)[0];
		expect(unread?.text.split("\n")[0]).toBe("Orrery can't read its record of Grok's settings, so it lists them all:");
		expect(unread?.grokSettings?.defaultYes).toBe(false);
		s.approve();
		const moved = join(s.dir, "grok-moved");
		mkdirSync(join(moved, "hooks"), { recursive: true });
		writeFileSync(join(moved, "hooks", "z.json"), hookFile("/nowhere/z"));
		const elsewhere = grokSettingsSteps(s.data, { ...s.env, GROK_HOME: moved }, s.project);
		expect(elsewhere.map((step) => step.text.split("\n")[0])).toEqual(["Orrery has no record of approving this Grok folder's settings, so it lists them all:"]);
	});

	it("yes approves, no opens nothing", async () => {
		const s = scene();
		s.approve();
		writeFileSync(join(s.grok, "hooks", "x.json"), hookFile("/nowhere/x"));
		for (const answer of [false, true]) {
			const said: string[] = [];
			const asked: [string, boolean][] = [];
			const io = { say: (line: string) => said.push(line), confirm: async () => true, askSettings: async (question: string, defaultYes: boolean) => (asked.push([question, defaultYes]), answer) };
			const { code, ran } = await launch(s, io);
			expect(asked.map(([question, defaultYes]) => [question.split("\n")[0], defaultYes])).toEqual([[`Grok's settings changed since you approved them on ${today()}:`, false]]);
			if (!answer) {
				expect([code, said, ran]).toEqual([1, ["Not opened."], []]);
				expect(s.check().state).toBe("changed");
				continue;
			}
			expect(code).toBe(0);
			expect(said[0]).toBe("Approved Grok's settings.");
			expect(ran).toHaveLength(1);
			expect(ran[0]).toMatchObject({ tool: "grok", env: { ORRERY_AGENT: "Atlas" } });
			expect(s.check().state).toBe("unchanged");
		}
	});

	it("a yes approves what the question showed, not what is on disk by then", async () => {
		const s = scene();
		s.approve();
		writeFileSync(join(s.grok, "hooks", "x.json"), hookFile("/nowhere/x"));
		const later = join(s.grok, "hooks", "y.json");
		// Another hook file arrives while the question is up.
		const io = { say: () => {}, confirm: async () => true, askSettings: async () => (writeFileSync(later, hookFile("/nowhere/y")), true) };
		expect((await launch(s, io)).code).toBe(0);
		expect(linesOf(s.check())).toEqual([`added    hook file ${later} (Stop; runs y)`]);
	});

	it("no terminal opens nothing", async () => {
		const s = scene();
		s.approve();
		writeFileSync(join(s.grok, "hooks", "x.json"), hookFile("/nowhere/x"));
		const before = readFileSync(s.record, "utf8");
		const missing = join(s.dir, "not-yet");
		const said: string[] = [];
		// --yes answers the other questions (the folder's here), never this one; with no terminal, nothing is asked.
		const { code, ran } = await launch(s, { say: (line: string) => said.push(line), confirm: async () => true }, missing);
		expect([code, said, ran]).toEqual([1, ["Not opened.", "Run orrery grok-settings in your own terminal to review them."], []]);
		expect(readFileSync(s.record, "utf8")).toBe(before);
		expect(existsSync(missing)).toBe(false);
		// The first launch after updating, with no record yet: the same, and no record is made.
		const fresh = scene();
		const first = await launch(fresh, { say: () => {}, confirm: async () => true });
		expect(first).toEqual({ code: 1, ran: [] });
		expect(existsSync(fresh.record)).toBe(false);
	});

	it("first run lists at most 20 lines", async () => {
		const s = scene({ connected: false });
		for (let i = 0; i < 30; i++) writeFileSync(join(s.grok, "hooks", `h${String(i).padStart(2, "0")}.json`), hookFile(`/nowhere/h${i}`));
		const [step, ...more] = grokSettingsSteps(s.data, s.env, s.project);
		expect(more).toEqual([]);
		expect(step).toMatchObject({ confirm: true, fix: "approve-grok-settings", grokSettings: { defaultYes: true } });
		const lines = step?.text.split("\n") ?? [];
		expect(lines[0]).toBe("Orrery now checks Grok's settings at each launch. Grok loads these now:");
		expect(lines.at(-1)).toBe("Approve Grok's current settings? [Y/n]");
		const listed = lines.slice(1, -1);
		expect(listed).toHaveLength(21);
		expect(listed.slice(0, 20).filter((line) => !/^ {2}hook file \S+\/h\d\d\.json \(Stop; runs h\d+\)$/.test(line))).toEqual([]);
		expect(listed[20]).toMatch(/^ {2}…and \d+ more \(orrery grok-settings lists them all\)$/);
		// A yes in the runner approves the whole list, not only the lines shown.
		const io = { say: () => {}, confirm: async () => true, askSettings: async () => true };
		expect((await launch(s, io)).code).toBe(0);
		expect(s.check().state).toBe("unchanged");
	});

	it("a launch with --config reads that config's record, and only a Grok launch reads one", async () => {
		const s = scene();
		// The config Orrery runs with (ORRERY_CONFIG) has a record of its own.
		s.approve();
		// The one the launch is given (--config): its own data folder and record, and a pi agent beside Atlas.
		const data = join(s.dir, "data-2");
		const birch = join(s.dir, "work", "birch");
		for (const folder of [data, birch]) mkdirSync(folder, { recursive: true });
		const config = join(s.dir, "config-2.toml");
		const agent = (name: string, folder: string, tool: string) => `[agents.${name}]\nfolder = ${JSON.stringify(folder)}\ntool = "${tool}"\ncompactor_model = "openai/gpt-6.1-sol"\n`;
		writeFileSync(config, `data_dir = ${JSON.stringify(data)}\n${agent("Atlas", s.project, "grok")}${agent("Birch", birch, "pi")}`);
		approveGrokSettings(data, checkGrokSettings(data, s.env, s.project).shown);
		writeFileSync(join(s.dir, "bin", "pi"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.0; exit 0; fi\n`, { mode: 0o755 });
		stubbed(s);
		const io = { say: () => {}, confirm: async () => false, askSettings: async () => false };
		const deps = {
			takeover: async () => {
				throw new Error("must not take over");
			},
			run: async () => ({ code: 0, signal: null }),
		};
		reads.dataDirs.length = 0;
		expect(await openAgentCommand(config, "Atlas", { args: [], cwd: s.project }, io, deps)).toBe(0);
		expect([...new Set(reads.dataDirs)]).toEqual([data]);
		// Another tool's launch reads none (its install question's no opens nothing).
		reads.dataDirs.length = 0;
		expect(await openAgentCommand(config, "Birch", { args: [], cwd: birch }, io, deps)).toBe(1);
		expect(reads.dataDirs).toEqual([]);
	});
});

describe("orrery grok-settings", () => {
	/** The command in the scene's project: its status, what it said, and what it asked (absent `answer`: no terminal). */
	async function run(s: Scene, options: { yes?: boolean; answer?: boolean } = {}) {
		const said: string[] = [];
		const asked: [string, boolean][] = [];
		const io = { say: (line: string) => said.push(line), ...(options.answer === undefined ? {} : { ask: async (question: string, defaultYes: boolean) => (asked.push([question, defaultYes]), options.answer as boolean) }) };
		const code = await grokSettingsCommand(s.data, { yes: options.yes === true, cwd: s.project, env: s.env }, io);
		return { code, said, asked };
	}

	it("grok-settings lists and approves", async () => {
		const s = scene();
		s.approve();
		expect(await run(s, { answer: true })).toEqual({ code: 0, said: [`No changes to Grok's settings since you approved them on ${today()}.`], asked: [] });
		const added = join(s.grok, "hooks", "x.json");
		writeFileSync(added, hookFile("/nowhere/x"));
		const header = `Grok's settings changed since you approved them on ${today()}:`;
		const line = `  added    hook file ${added} (Stop; runs x)`;
		// In a terminal: listed and asked, default no; a no approves nothing.
		const no = await run(s, { answer: false });
		expect(no).toEqual({ code: 1, said: ["Not approved."], asked: [[[header, line, "Approve these changes to Grok's settings? [y/N]"].join("\n"), false]] });
		expect(s.check().state).toBe("changed");
		// No terminal and no --yes: listed, not approved, and not zero.
		expect(await run(s)).toEqual({ code: 1, said: [header, line, "Not approved: there is no terminal to ask on. Run orrery grok-settings in your own terminal to review them."], asked: [] });
		expect(s.check().state).toBe("changed");
		// --yes: approves what it just checked, without asking.
		expect(await run(s, { yes: true, answer: false })).toEqual({ code: 0, said: [header, line, "Approved Grok's settings."], asked: [] });
		expect(s.check().state).toBe("unchanged");
		// A yes in a terminal approves too.
		writeFileSync(join(s.grok, "hooks", "y.json"), hookFile("/nowhere/y"));
		expect((await run(s, { answer: true })).code).toBe(0);
		expect(s.check().state).toBe("unchanged");
	});

	it("lists every line, never the launch's 20, and asks the first run's question, default yes", async () => {
		const s = scene({ connected: false });
		for (let i = 0; i < 30; i++) writeFileSync(join(s.grok, "hooks", `h${String(i).padStart(2, "0")}.json`), hookFile(`/nowhere/h${i}`));
		const { code, asked } = await run(s, { answer: true });
		expect(code).toBe(0);
		const lines = asked[0]?.[0].split("\n") ?? [];
		expect([lines[0], lines.at(-1), asked[0]?.[1]]).toEqual(["Orrery now checks Grok's settings at each launch. Grok loads these now:", "Approve Grok's current settings? [Y/n]", true]);
		expect(lines.filter((line) => line.includes(".json (Stop;"))).toHaveLength(30);
		expect(lines.filter((line) => line.includes("more (orrery grok-settings"))).toEqual([]);
		expect(s.check().state).toBe("unchanged");
	});

	it("agent session can't approve", () => {
		const s = scene();
		s.approve();
		writeFileSync(join(s.grok, "hooks", "x.json"), hookFile("/nowhere/x"));
		const before = readFileSync(s.record, "utf8");
		// This test process stands for Atlas's tool: the CLI runs inside Atlas's session.
		expect(recordSession(s.data, { agent: "Atlas", tool: "pi", pid: process.pid })).toBe(true);
		recorded.push([s.data, process.pid]);
		const c = cliCommand(["grok-settings", "--yes"]);
		const direct = spawnSync(c.cmd, c.args, { env: s.env, cwd: s.project, encoding: "utf8", timeout: 20_000 });
		// The command's name built at run time, as an agent's shell may build it: the gate reads the process, not the text.
		const named = spawnSync("/bin/sh", ["-c", 'o="$1"; shift; w=settings; "$o" "$@" "grok-$w" --yes', "sh", c.cmd, ...c.args.slice(0, -2)], { env: s.env, cwd: s.project, encoding: "utf8", timeout: 20_000 });
		const refused = "orrery grok-settings can't run inside an agent session (Atlas, pi): agents can't change memory or settings. Run it in your own terminal or the TUI.\n";
		for (const r of [direct, named]) expect({ status: r.status, stdout: r.stdout, stderr: r.stderr }).toEqual({ status: 1, stdout: "", stderr: refused });
		expect(readFileSync(s.record, "utf8")).toBe(before);
		expect(s.check().state).toBe("changed");
		// Outside the session, the same command approves.
		forgetSession(s.data, process.pid);
		const outside = spawnSync(c.cmd, c.args, { env: s.env, cwd: s.project, encoding: "utf8", timeout: 20_000 });
		expect(outside.status, outside.stderr).toBe(0);
		expect(outside.stdout).toContain("Approved Grok's settings.");
		expect(s.check().state).toBe("unchanged");
	});
});

describe("Grok's row and Orrery's own writes", () => {
	it("tools row says changed", () => {
		const s = scene();
		const root = orreryRoot();
		expect(grokSettingsWords(s.data, s.env)).toBe("Grok settings not approved yet");
		s.approve();
		expect(grokSettingsWords(s.data, s.env)).toBeUndefined();
		writeFileSync(join(s.grok, "hooks", "x.json"), hookFile("/nowhere/x"));
		expect(grokSettingsWords(s.data, s.env)).toBe("Grok settings changed since you approved them");
		// orrery tools finds the record through the config Orrery runs with; the words are the row's own, apart from its detail.
		const grok = checkTools({ root, env: s.env, grokSettings: settingsDataDir(s.env) }).find((check) => check.id === "grok") as ToolCheck;
		expect(grok).toMatchObject({ wiring: "installed", settings: "Grok settings changed since you approved them" });
		expect(grok.detail).not.toContain("Grok settings");
	});

	it("setup keeps record in step", async () => {
		const t = grokScratch();
		// No config: the record is in Orrery's home, as setup finds it.
		const check = () => checkGrokSettings(t.orreryHome, t.env, undefined);
		approveGrokSettings(t.orreryHome, check().shown);
		await wireReport(t.env, { run: fakeRun, confirm: async () => true });
		const config = join(t.grok, "config.toml");
		expect(readFileSync(config, "utf8")).toContain("[mcp_servers.orrery]");
		// Connected on an approved record: Orrery's own hook file, tables and the programs they run are in step.
		expect(linesOf(check())).toEqual([]);
		expect(check().state).toBe("unchanged");
		// An agent's change, then setup again: Orrery's part is in step, the agent's change still shows.
		const full = addGrokConfig("", join(t.current, "bin", "orrery")).next;
		writeFileSync(config, `${full.slice(full.indexOf("[mcp_servers.orrery]"))}\n[mcp_servers.evil]\ncommand = "/nowhere/evil"\n`);
		await wireReport(t.env, { run: fakeRun, confirm: async () => true });
		expect(readFileSync(config, "utf8")).toContain("[ui.status_line]");
		expect(linesOf(check())).toEqual([`added    MCP server "evil" (runs evil) in ${config}`]);
	});

	it("uninstall keeps record in step", async () => {
		const t = grokScratch();
		await wireReport(t.env, { run: fakeRun, confirm: async () => true });
		const check = () => checkGrokSettings(t.orreryHome, t.env, undefined);
		approveGrokSettings(t.orreryHome, check().shown);
		await uninstall({ env: t.env, purge: false, confirmPurge: async () => false, run: fakeRun });
		expect(existsSync(join(t.grok, "hooks", "orrery.json"))).toBe(false);
		expect(linesOf(check())).toEqual([]);
		expect(check().state).toBe("unchanged");
		// An agent's change first: it still shows after the uninstall.
		const u = grokScratch();
		await wireReport(u.env, { run: fakeRun, confirm: async () => true });
		const checkU = () => checkGrokSettings(u.orreryHome, u.env, undefined);
		approveGrokSettings(u.orreryHome, checkU().shown);
		const evil = join(u.grok, "hooks", "evil.json");
		writeFileSync(evil, hookFile("/nowhere/evil"));
		await uninstall({ env: u.env, purge: false, confirmPurge: async () => false, run: fakeRun });
		expect(linesOf(checkU())).toEqual([`added    hook file ${evil} (Stop; runs evil)`]);
	});

	it("an update's swap keeps record in step", async () => {
		const t = grokScratch();
		await wireReport(t.env, { run: fakeRun, confirm: async () => true });
		const check = () => checkGrokSettings(t.orreryHome, t.env, undefined);
		approveGrokSettings(t.orreryHome, check().shown);
		// The new release's program differs from the one Grok's config and status row run now.
		installFrom({ from: fixtureRelease("0.10.1"), env: t.env, run: fakeRun });
		expect(readFileSync(join(t.current, "VERSION"), "utf8").trim()).toBe("0.10.1");
		expect(linesOf(check())).toEqual([]);
		expect(check().state).toBe("unchanged");
	});

	/**
	 * A scratch HOME whose fake claude installs Orrery's plugin as Claude Code does: a copy of the version `use` names in
	 * its cache, listed in installed_plugins.json, switched on in settings.json. Installed (1.0.0, with no record yet), then
	 * approved, unless `installed` is false. `fail()`: an install or update exits 1 after it has written.
	 */
	function pluginScene(options: { installed?: boolean } = {}) {
		const dir = realpathSync(tempDir("orrery-grok-plugin-"));
		const home = join(dir, "home");
		const plugins = join(home, ".claude", "plugins");
		const data = join(dir, "data");
		for (const folder of [plugins, data, join(home, ".grok"), join(dir, "bin")]) mkdirSync(folder, { recursive: true });
		const version = join(dir, "plugin-version");
		const exit = join(dir, "exit-code");
		for (const v of ["1.0.0", "2.0.0"]) {
			const root = join(dir, `plugin-${v}`);
			mkdirSync(join(root, "bin"), { recursive: true });
			mkdirSync(join(root, "hooks"));
			mkdirSync(join(root, ".claude-plugin"));
			writeFileSync(join(root, "bin", "orrery-run"), `#!/bin/sh\necho ${v}\n`, { mode: 0o755 });
			writeFileSync(join(root, "hooks", "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: 'sh "${CLAUDE_PLUGIN_ROOT}/bin/orrery-run" claude-hook stop' }] }] } }));
			writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "orrery", version: v }));
			const installPath = join(plugins, "cache", "orrery", "orrery", v);
			writeFileSync(join(dir, `installed-${v}.json`), JSON.stringify({ version: 2, plugins: { "orrery@orrery": [{ scope: "user", installPath, version: v }] } }));
		}
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ enabledPlugins: { "orrery@orrery": true } }));
		writeFileSync(exit, "0\n");
		const claude = join(dir, "bin", "claude");
		const cache = join(plugins, "cache", "orrery", "orrery");
		const q = JSON.stringify;
		writeFileSync(
			claude,
			[
				"#!/bin/sh",
				'case "$1 $2" in',
				`"plugin install"|"plugin update") v=$(/bin/cat ${q(version)}); /bin/mkdir -p ${q(cache)}/$v; /bin/cp -R ${q(dir)}/plugin-$v/. ${q(cache)}/$v/; /bin/cp ${q(dir)}/installed-$v.json ${q(join(plugins, "installed_plugins.json"))}; /bin/cp ${q(join(dir, "settings.json"))} ${q(join(home, ".claude", "settings.json"))}; exit $(/bin/cat ${q(exit)}) ;;`,
				"esac",
				"",
			].join("\n"),
			{ mode: 0o755 },
		);
		const run: Runner = (cmd, args) => {
			if (cmd !== claude) return { status: 127, stdout: "", stderr: `not the scratch claude: ${cmd}` };
			const r = spawnSync(cmd, [...args], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
			return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
		};
		const env: NodeJS.ProcessEnv = { HOME: home, PATH: join(dir, "bin") };
		const check = () => checkGrokSettings(data, env, undefined);
		const steps = (wiring: ToolCheck["wiring"]) => installSteps({ id: "claude-code", label: "Claude Code", path: claude, wiring, detail: "" }, join(dir, "orrery"), env, data);
		const use = (v: string) => writeFileSync(version, `${v}\n`);
		if (options.installed !== false) {
			use("1.0.0");
			expect(runInstall(steps("missing"), run).ok).toBe(true);
			approveGrokSettings(data, check().shown);
		}
		return { plugins, cache, data, record: join(data, "grok-settings.json"), run, check, steps, use, fail: () => writeFileSync(exit, "1\n") };
	}

	it("the Claude Code plugin's copy keeps record in step, wherever Claude Code puts the new version", () => {
		const p = pluginScene({ installed: false });
		p.use("1.0.0");
		expect(runInstall(p.steps("missing"), p.run).ok).toBe(true);
		expect(linesOf(p.check()).some((line) => line.includes('Claude Code plugin "orrery@orrery"'))).toBe(true);
		approveGrokSettings(p.data, p.check().shown);
		// The update: a new copy at a new place, its program with it.
		p.use("2.0.0");
		expect(runInstall(p.steps("update available"), p.run).ok).toBe(true);
		expect(readFileSync(join(p.plugins, "installed_plugins.json"), "utf8")).toContain("2.0.0");
		expect(linesOf(p.check())).toEqual([]);
	});

	it("a claude command that fails after writing moves nothing, and says it failed as before", () => {
		const p = pluginScene();
		const before = readFileSync(p.record, "utf8");
		p.use("2.0.0");
		p.fail();
		expect(runInstall(p.steps("update available"), p.run)).toEqual({ ok: false, output: "$ claude plugin marketplace update orrery\n$ claude plugin update orrery@orrery\nexit 1\n" });
		expect(readFileSync(join(p.plugins, "installed_plugins.json"), "utf8")).toContain("2.0.0");
		expect(readFileSync(p.record, "utf8")).toBe(before);
		expect(linesOf(p.check()).filter((line) => line.includes('Claude Code plugin "orrery@orrery"'))).toEqual([`changed  Claude Code plugin "orrery@orrery" ${join(p.cache, "2.0.0")}`]);
	});

	it("a plugin copy put in a folder that was there before the update is never approved: the next check lists it", () => {
		const p = pluginScene();
		// Something plants the next version's folder first, with a file of its own in it.
		const next = join(p.cache, "2.0.0");
		mkdirSync(join(next, "agents"), { recursive: true });
		writeFileSync(join(next, "agents", "planted.md"), "---\nname: planted\n---\nPlanted.\n");
		p.use("2.0.0");
		expect(runInstall(p.steps("update available"), p.run).ok).toBe(true);
		expect(linesOf(p.check())).toEqual([`changed  Claude Code plugin "orrery@orrery" ${next}`, `added    program ${join(next, "bin", "orrery-run")}`]);
	});
});
