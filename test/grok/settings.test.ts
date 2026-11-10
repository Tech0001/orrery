import { chmodSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addGrokConfig, grokHookFile } from "../../src/grok/install.ts";
import { approveGrokSettings, changeLines, checkGrokSettings, grokSettingsSources, keepInStep, readSettingsRecord, settingsStamp, type SettingsCheck, type SettingsRecord } from "../../src/grok/settings.ts";
import { cleanupScratch, tempDir } from "../install/support.ts";

afterEach(cleanupScratch);

/** Grok's config as setup leaves it (Orrery's status row and memory tools) after `before`. */
const orreryConfig = (orrery: string, before = 'model = "grok-4"\n') => addGrokConfig(before, orrery).next;

/** A hook file running `command` with `args` at `event`. */
const hookFile = (command: string, args: string[], event = "Stop") => JSON.stringify({ hooks: { [event]: [{ hooks: [{ type: "command", command, args }] }] } });

/**
 * A scratch HOME, Grok folder (GROK_HOME), Orrery data folder and session folder, with Orrery's hook file and config
 * tables in Grok's folder (as setup writes them) unless `orrery` is false.
 */
function scratch(options: { orrery?: boolean } = {}) {
	// Its real path (macOS's temp folder is under a link), as project sources are named from the session folder's.
	const dir = realpathSync(tempDir("orrery-grok-settings-"));
	const home = join(dir, "home");
	const grok = join(dir, "grok");
	const data = join(dir, "data");
	const project = join(dir, "work", "project");
	for (const folder of [home, join(grok, "hooks"), data, project]) mkdirSync(folder, { recursive: true });
	const orrery = join(dir, "app", "bin", "orrery");
	const env: NodeJS.ProcessEnv = { HOME: home, GROK_HOME: grok };
	const hooks = join(grok, "hooks", "orrery.json");
	const config = join(grok, "config.toml");
	if (options.orrery !== false) {
		writeFileSync(hooks, grokHookFile(orrery));
		writeFileSync(config, orreryConfig(orrery));
	}
	const write = (path: string, text: string | Buffer) => {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, text);
	};
	const check = (folder: string | undefined = project): SettingsCheck => checkGrokSettings(data, env, folder);
	const approve = (folder: string | undefined = project) => approveGrokSettings(data, env, folder);
	/** The check's lines: the changes, or the first run's list. */
	const lines = (folder: string | undefined = project): string[] => {
		const now = check(folder);
		return now.state === "changed" ? now.changes.map((change) => change.line) : now.state === "first" ? [...now.lines] : [];
	};
	const record = () => readSettingsRecord(data) as SettingsRecord;
	return { dir, home, grok, data, project, orrery, env, hooks, config, write, check, approve, lines, record };
}

describe("Grok settings record and compare", () => {
	it("no record reads as first", () => {
		const t = scratch();
		t.write(join(t.grok, "lsp.json"), JSON.stringify({ ts: { command: "/nowhere/ts-server", args: [] } }));
		mkdirSync(join(t.grok, "agents"));
		const check = t.check();
		expect(check.state).toBe("first");
		// One line per source with content: Orrery's hook file, its config tables, the language servers, and the program
		// the hook file runs. The empty agents folder and the language server's missing program have none.
		expect(check.state === "first" ? check.lines : []).toEqual([
			`hook file ${t.hooks} (SessionStart, UserPromptSubmit, PreToolUse, Stop, StopCancelled, SessionEnd; runs sh)`,
			`MCP server "orrery" (runs orrery), status line (runs orrery) in ${t.config}`,
			`language servers in ${join(t.grok, "lsp.json")}`,
			"program /bin/sh",
		]);
	});

	it("approve then unchanged", () => {
		const t = scratch();
		t.approve();
		expect(t.check()).toEqual({ state: "unchanged" });
		expect(t.check(undefined)).toEqual({ state: "unchanged" });
		const record = t.record();
		expect(record.version).toBe(1);
		const [entry] = Object.values(record.grok);
		expect(new Date(entry?.approvedAt ?? "").getTime()).toBeGreaterThan(0);
	});

	it("new hook file is added", () => {
		const t = scratch();
		t.approve();
		// Grok loads only the hooks folder's own *.json files.
		t.write(join(t.grok, "hooks", "nested", "y.json"), hookFile("/bin/sh", ["-c", "true"]));
		t.write(join(t.grok, "hooks", "y.json.bak"), hookFile("/bin/sh", ["-c", "true"]));
		expect(t.check()).toEqual({ state: "unchanged" });
		t.write(join(t.grok, "hooks", "x.json"), hookFile("/bin/sh", ["-c", "true"]));
		const check = t.check();
		expect(check.state).toBe("changed");
		const changes = check.state === "changed" ? check.changes : [];
		expect(changes).toHaveLength(1);
		expect(changes[0]?.change).toBe("added");
		expect(changes[0]?.line).toContain("hook file");
		expect(changes[0]?.line).toContain("x.json");
		expect(changes[0]?.line).toBe(`added    hook file ${join(t.grok, "hooks", "x.json")} (Stop; runs sh)`);
	});

	it("mcp server added names only", () => {
		const t = scratch();
		t.approve();
		t.write(t.config, `${readFileSync(t.config, "utf8")}\n[mcp_servers.foo]\ncommand = "/usr/bin/node"\n`);
		const check = t.check();
		expect(check.state).toBe("changed");
		expect(t.lines().find((line) => line.includes('"foo"'))).toBe(`added    MCP server "foo" (runs node) in ${t.config}`);
	});

	it("summaries carry names only", () => {
		const t = scratch();
		const secret = "sk-" + "proj-x";
		const leaky = `\n[mcp_servers.leaky]\ncommand = "/bin/sh"\nargs = ["-c", "serve --key ${secret}"]\nenv = { K = "${secret}" }\n\n[mcp_servers.odd]\ncommand = "https://h.example/run?key=${secret}"\n`;
		t.write(t.config, `${orreryConfig(t.orrery)}${leaky}`);
		t.write(join(t.grok, "hooks", "leak.json"), hookFile("/bin/sh", ["-c", `echo ${secret}`]));
		expect(t.lines().join("\n")).not.toContain("proj-x");
		t.approve();
		expect(readFileSync(join(t.data, "grok-settings.json"), "utf8")).not.toContain("proj-x");
		t.write(t.config, `${orreryConfig(t.orrery)}${leaky.replaceAll(secret, `${secret}2`)}`);
		t.write(join(t.grok, "hooks", "leak.json"), hookFile("/bin/sh", ["-c", `echo ${secret}2`]));
		const lines = t.lines();
		// A command that is no program name (here a URL) gives no name at all.
		expect(lines).toEqual([`changed  hook file ${join(t.grok, "hooks", "leak.json")} (Stop; runs sh)`, `changed  MCP server "leaky" (runs sh) in ${t.config}`, `changed  MCP server "odd" in ${t.config}`]);
		expect(lines.join("\n")).not.toContain("proj-x");
	});

	it("unrelated config keys don't count", () => {
		const t = scratch();
		t.approve();
		t.write(t.config, orreryConfig(t.orrery, 'model = "grok-4-fast"\n\n[ui]\ntheme = "dark"\n'));
		expect(t.check()).toEqual({ state: "unchanged" });
	});

	it("orrery's tables count", () => {
		const t = scratch();
		const original = readFileSync(t.config, "utf8");
		t.approve();
		// Orrery's server is the config's last table.
		const withoutServer = original.slice(0, original.indexOf("[mcp_servers.orrery]"));
		expect(withoutServer).toContain("[ui.status_line]");
		expect(withoutServer).not.toContain("mcp_servers");
		t.write(t.config, withoutServer);
		expect(t.lines()).toEqual([`removed  MCP server "orrery" (runs orrery) in ${t.config}`]);
		t.write(t.config, original);
		expect(t.check()).toEqual({ state: "unchanged" });
		t.write(t.config, original.replace('args = ["mcp", "--tool", "grok"]', 'args = ["mcp", "--tool", "grok"]\nenabled = false'));
		expect(t.lines()).toEqual([`changed  MCP server "orrery" (runs orrery) in ${t.config}`]);
		t.write(t.config, `disabled_mcp_servers = ["orrery"]\n${original}`);
		expect(t.lines()).toEqual([`added    disabled_mcp_servers in ${t.config}`]);
	});

	it("disabled-hooks counts", () => {
		const t = scratch();
		const switches = join(t.grok, "disabled-hooks");
		t.write(switches, "global/other:stop[0].hooks[0]\n");
		t.approve();
		t.write(switches, "global/other:stop[0].hooks[0]\nglobal/orrery:pre_tool_use[0].hooks[0]\n");
		expect(t.lines()).toEqual([`changed  hook switches ${switches}`]);
	});

	it("project hooks count", () => {
		const t = scratch();
		const other = join(t.dir, "work", "other");
		mkdirSync(other, { recursive: true });
		t.write(join(other, ".grok", "hooks", "o.json"), hookFile("/bin/sh", ["-c", "true"]));
		t.approve(other);
		t.approve();
		const before = Object.values(t.record().grok)[0]?.projects;
		t.write(join(t.project, ".grok", "hooks", "p.json"), hookFile("/bin/sh", ["-c", "true"]));
		expect(t.lines()).toEqual([`added    hook file ${join(t.project, ".grok", "hooks", "p.json")} (Stop; runs sh)`]);
		expect(t.check(other)).toEqual({ state: "unchanged" });
		t.approve();
		expect(t.check()).toEqual({ state: "unchanged" });
		const after = Object.values(t.record().grok)[0]?.projects ?? {};
		expect(Object.keys(after)).toHaveLength(2);
		const otherKey = Object.keys(after).find((key) => key.endsWith("other")) as string;
		expect(after[otherKey]).toEqual(before?.[otherKey]);
		// A project with no entry yet compares against nothing: its sources show as added.
		const third = join(t.dir, "work", "third");
		t.write(join(third, ".grok", "hooks", "t.json"), hookFile("/bin/sh", ["-c", "true"]));
		expect(t.lines(third)).toEqual([`added    hook file ${join(third, ".grok", "hooks", "t.json")} (Stop; runs sh)`]);
	});

	it("program file counts", () => {
		const t = scratch();
		const script = join(t.dir, "scratch", "x.sh");
		const big = join(t.dir, "scratch", "big.bin");
		t.write(script, "#!/bin/sh\necho one\n");
		t.write(big, Buffer.alloc(2 * 1024 * 1024, 1));
		utimesSync(big, 1_700_000_000, 1_700_000_000);
		t.write(join(t.grok, "hooks", "y.json"), hookFile("/bin/sh", [script, big]));
		t.approve();
		t.write(script, "#!/bin/sh\necho two\n");
		expect(t.lines()).toEqual([`changed  program ${script}`]);
		t.approve();
		// Over 1 MiB: its size and time only. The same size and time with other bytes reads as unchanged.
		t.write(big, Buffer.alloc(2 * 1024 * 1024, 2));
		utimesSync(big, 1_700_000_000, 1_700_000_000);
		expect(t.check()).toEqual({ state: "unchanged" });
		utimesSync(big, 1_700_000_100, 1_700_000_100);
		expect(t.lines()).toEqual([`changed  program ${big}`]);
	});

	it.skipIf(process.getuid?.() === 0)("unreadable source counts", () => {
		const t = scratch();
		t.approve();
		chmodSync(t.hooks, 0o000);
		try {
			const lines = t.lines();
			expect(lines[0]).toContain("can't read");
			// What it names can't be read either, so the program it ran is no longer seen.
			expect(lines).toEqual([`changed  can't read ${t.hooks}`, "removed  program /bin/sh"]);
		} finally {
			chmodSync(t.hooks, 0o600);
		}
	});

	it("bad TOML falls back to whole file", () => {
		const t = scratch();
		t.write(t.config, "[mcp_servers.x\ncommand = 1\n");
		t.approve();
		expect(t.check()).toEqual({ state: "unchanged" });
		t.write(t.config, "[mcp_servers.x\ncommand = 2\n");
		expect(t.lines()).toEqual([`changed  Grok config ${t.config} (not valid TOML)`]);
	});

	it("stamp moves only on change", () => {
		const t = scratch();
		const sources = grokSettingsSources(t.env, t.project);
		const stamp = settingsStamp(sources);
		expect(settingsStamp(sources)).toBe(stamp);
		expect(settingsStamp(grokSettingsSources(t.env, t.project))).toBe(stamp);
		utimesSync(t.hooks, 1_700_000_000, 1_700_000_000);
		const touched = settingsStamp(sources);
		expect(touched).not.toBe(stamp);
		// A file added to a folder Grok lists moves it too.
		t.write(join(t.grok, "hooks", "new.json"), "{}");
		expect(settingsStamp(sources)).not.toBe(touched);
	});

	it("keepInStep moves only matching entries", () => {
		const t = scratch();
		const key = grokSettingsSources(t.env, undefined).find((source) => source.path === t.hooks)?.key as string;
		const other = join(t.dir, "app2", "bin", "orrery");
		// (a) The record matches: Orrery's own write moves it.
		t.approve();
		keepInStep(t.data, t.env, [key], () => writeFileSync(t.hooks, grokHookFile(other)));
		expect(t.check()).toEqual({ state: "unchanged" });
		// (b) An agent changed the file first: Orrery's write leaves the record, so the change still shows.
		writeFileSync(t.hooks, hookFile("/bin/sh", ["-c", "true"]));
		keepInStep(t.data, t.env, [key], () => writeFileSync(t.hooks, grokHookFile(t.orrery)));
		expect(t.lines()).toEqual([`changed  hook file ${t.hooks} (SessionStart, UserPromptSubmit, PreToolUse, Stop, StopCancelled, SessionEnd; runs sh)`]);
		// A write that throws moves nothing.
		t.approve();
		expect(() =>
			keepInStep(t.data, t.env, [key], () => {
				writeFileSync(t.hooks, "{}");
				throw new Error("failed");
			}),
		).toThrow("failed");
		expect(t.lines()).toEqual([`changed  hook file ${t.hooks}`, "removed  program /bin/sh"]);
	});

	it("record file is private", () => {
		const t = scratch();
		t.approve();
		const path = join(t.data, "grok-settings.json");
		expect(statSync(path).mode & 0o777).toBe(0o600);
		// A write that fails leaves no partial file: here a folder stands where the record goes, so the rename fails.
		const blocked = scratch();
		mkdirSync(join(blocked.data, "grok-settings.json"));
		expect(() => blocked.approve()).toThrow();
		expect(readdirSync(blocked.data)).toEqual(["grok-settings.json"]);
		expect(statSync(join(blocked.data, "grok-settings.json")).isDirectory()).toBe(true);
	});

	it("an unreadable record is a change, never a first run", () => {
		const t = scratch();
		t.write(join(t.data, "grok-settings.json"), "{not json");
		expect(readSettingsRecord(t.data)).toEqual({ unreadable: `can't read ${join(t.data, "grok-settings.json")}` });
		const check = t.check();
		expect(check.state).toBe("changed");
		expect(check.state === "changed" ? check.changes[0]?.line : "").toBe(`changed  can't read ${join(t.data, "grok-settings.json")}`);
		t.approve();
		expect(t.check()).toEqual({ state: "unchanged" });
	});

	it("twenty lines then more", () => {
		const t = scratch();
		t.approve();
		for (let n = 0; n < 25; n++) t.write(join(t.grok, "hooks", `h${String(n).padStart(2, "0")}.json`), hookFile("/bin/sh", ["-c", "true"]));
		const check = t.check();
		const changes = check.state === "changed" ? check.changes : [];
		expect(changes).toHaveLength(25);
		const lines = changeLines(changes);
		expect(lines).toHaveLength(21);
		expect(lines[19]).toContain("h19.json");
		expect(lines[20]).toBe("…and 5 more (orrery grok-settings lists them all)");
		expect(changeLines(changes.slice(0, 20))).toHaveLength(20);
		expect(changeLines(changes, 3)).toHaveLength(4);
	});
});

describe("Grok settings sources", () => {
	it("hooks-paths targets count: a file, or a folder's *.json; relative lines don't", () => {
		const t = scratch();
		const listed = join(t.dir, "extra", "hp-file.json");
		const folder = join(t.dir, "extra", "hp-dir");
		t.write(listed, hookFile("/bin/sh", ["-c", "true"]));
		t.write(join(folder, "a.json"), hookFile("/bin/sh", ["-c", "true"]));
		t.write(join(t.grok, "rel.json"), hookFile("/bin/sh", ["-c", "true"]));
		t.write(join(t.grok, "hooks-paths"), `${listed}\n${folder}\nrel.json\n`);
		t.approve();
		t.write(listed, hookFile("/bin/sh", ["-c", "false"]));
		t.write(join(folder, "b.json"), hookFile("/bin/sh", ["-c", "true"]));
		t.write(join(t.grok, "rel.json"), hookFile("/bin/sh", ["-c", "false"]));
		expect(t.lines()).toEqual([`changed  hook file ${listed} (Stop; runs sh)`, `added    hook file ${join(folder, "b.json")} (Stop; runs sh)`]);
		t.approve();
		t.write(join(t.grok, "hooks-paths"), `${listed}\n`);
		expect(t.lines()).toEqual([`changed  hook path list ${join(t.grok, "hooks-paths")}`, `removed  hook file ${join(folder, "a.json")} (Stop; runs sh)`, `removed  hook file ${join(folder, "b.json")} (Stop; runs sh)`]);
	});

	it("an [[experiments]] server counts, and the program it runs", () => {
		const t = scratch();
		t.approve();
		const tool = join(t.dir, "bin", "x-server");
		t.write(tool, "#!/bin/sh\n");
		t.write(t.config, `${readFileSync(t.config, "utf8")}\n[[experiments]]\npercent = 100\n[experiments.mcp_servers.x]\ncommand = ${JSON.stringify(tool)}\n`);
		expect(t.lines()).toEqual([`added    [[experiments]] (MCP server "x") in ${t.config}`, `added    program ${tool}`]);
	});

	it("a Claude Code plugin's hook file counts; one switched off doesn't; its content counts, not where it is installed", () => {
		const t = scratch();
		const plugins = join(t.home, ".claude", "plugins");
		const plugin = (name: string, version: string) => join(plugins, "cache", "mkt", name, version);
		const installed = (paths: Record<string, string>) =>
			t.write(join(plugins, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, [{ scope: "user", installPath: path, version: "1.0.0", installedAt: new Date().toISOString(), lastUpdated: new Date().toISOString() }]])) }));
		for (const name of ["on", "off"]) {
			t.write(join(plugin(name, "1.0.0"), ".claude-plugin", "plugin.json"), JSON.stringify({ name, version: "1.0.0" }));
			t.write(join(plugin(name, "1.0.0"), "hooks", "hooks.json"), hookFile("${CLAUDE_PLUGIN_ROOT}/hooks/run.sh", []));
		}
		installed({ "on@mkt": plugin("on", "1.0.0"), "off@mkt": plugin("off", "1.0.0") });
		t.write(join(t.home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "on@mkt": true, "off@mkt": false }, theme: "dark" }));
		t.approve();
		t.write(join(plugin("off", "1.0.0"), "hooks", "hooks.json"), hookFile("/bin/sh", ["-c", "true"]));
		expect(t.check()).toEqual({ state: "unchanged" });
		t.write(join(plugin("on", "1.0.0"), "hooks", "hooks.json"), hookFile("/bin/sh", ["-c", "true"]));
		expect(t.lines()).toEqual([`changed  Claude Code plugin "on@mkt" ${plugin("on", "1.0.0")}`]);
		t.approve();
		// Reinstalled elsewhere with the same files, and new install dates: no change.
		for (const file of [join(".claude-plugin", "plugin.json"), join("hooks", "hooks.json")]) t.write(join(plugin("on", "again"), file), readFileSync(join(plugin("on", "1.0.0"), file)));
		installed({ "on@mkt": plugin("on", "again"), "off@mkt": plugin("off", "1.0.0") });
		expect(t.check()).toEqual({ state: "unchanged" });
		// A folder plugin counts once Grok's [plugins].enabled names it.
		t.write(join(plugins, "dirplug", "hooks", "hooks.json"), hookFile("/bin/sh", ["-c", "true"]));
		expect(t.check()).toEqual({ state: "unchanged" });
		t.write(t.config, orreryConfig(t.orrery, '[plugins]\nenabled = ["dirplug"]\n'));
		expect(t.lines()).toEqual([`added    [plugins] in ${t.config}`, `added    plugin ${join(plugins, "dirplug")}`]);
	});

	it("the project is every folder from the git root down to the session folder", () => {
		const t = scratch();
		const repo = join(t.dir, "work", "repo");
		const session = join(repo, "a", "b");
		mkdirSync(join(repo, ".git"), { recursive: true });
		mkdirSync(session, { recursive: true });
		t.approve(session);
		const hook = (folder: string) => join(folder, ".grok", "hooks", "h.json");
		for (const folder of [join(t.dir, "work"), repo, join(repo, "a"), session]) t.write(hook(folder), hookFile("/bin/sh", ["-c", "true"]));
		t.write(join(repo, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "$CLAUDE_PROJECT_DIR/hooks/start.sh" }] }] } }));
		t.write(join(repo, "hooks", "start.sh"), "#!/bin/sh\n");
		expect(t.lines(session)).toEqual([
			`added    hook file ${hook(repo)} (Stop; runs sh)`,
			`added    hooks (SessionStart; runs start.sh) in ${join(repo, ".claude", "settings.json")}`,
			`added    hook file ${hook(join(repo, "a"))} (Stop; runs sh)`,
			`added    hook file ${hook(session)} (Stop; runs sh)`,
			`added    program ${join(repo, "hooks", "start.sh")}`,
		]);
		// Outside a repository: the session folder alone.
		const loose = join(t.dir, "work", "loose", "x");
		t.write(hook(join(t.dir, "work", "loose")), hookFile("/bin/sh", ["-c", "true"]));
		t.write(hook(loose), hookFile("/bin/sh", ["-c", "true"]));
		expect(t.lines(loose)).toEqual([`added    hook file ${hook(loose)} (Stop; runs sh)`]);
	});

	it("a global hook's $CLAUDE_PROJECT_DIR script is each project's own", () => {
		const t = scratch();
		t.write(join(t.home, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "$CLAUDE_PROJECT_DIR/check.sh" }] }] } }));
		const other = join(t.dir, "work", "other");
		for (const folder of [t.project, other]) t.write(join(folder, "check.sh"), "#!/bin/sh\n");
		t.approve();
		t.approve(other);
		expect(t.check()).toEqual({ state: "unchanged" });
		t.write(join(other, "check.sh"), "#!/bin/sh\necho changed\n");
		expect(t.check()).toEqual({ state: "unchanged" });
		expect(t.lines(other)).toEqual([`changed  program ${join(other, "check.sh")}`]);
	});

	it("session-folder-only rows read the session folder alone", () => {
		const t = scratch();
		const repo = join(t.dir, "work", "repo");
		const session = join(repo, "sub");
		// A .git file (a worktree's) marks the root as a folder does.
		mkdirSync(session, { recursive: true });
		writeFileSync(join(repo, ".git"), "gitdir: elsewhere\n");
		const servers = (name: string) => JSON.stringify({ mcpServers: { [name]: { command: "/bin/echo" } } });
		t.write(join(t.home, ".claude.json"), JSON.stringify({ numStartups: 3, mcpServers: { user: { command: "/bin/echo" } }, projects: { [repo]: { mcpServers: { root: { command: "/bin/echo" } } }, [session]: { mcpServers: { here: { command: "/bin/echo" } } } } }));
		for (const folder of [repo, session]) {
			t.write(join(folder, ".cursor", "mcp.json"), servers(`cursor-${folder === repo ? "root" : "here"}`));
			t.write(join(folder, ".grok", "lsp.json"), JSON.stringify({ ls: { command: "/bin/echo" } }));
		}
		const check = t.check(session);
		expect(check.state === "first" ? check.lines : []).toEqual([
			`hook file ${t.hooks} (SessionStart, UserPromptSubmit, PreToolUse, Stop, StopCancelled, SessionEnd; runs sh)`,
			`MCP server "orrery" (runs orrery), status line (runs orrery) in ${t.config}`,
			`MCP server "user" (runs echo) in ${join(t.home, ".claude.json")}`,
			`MCP server "cursor-here" (runs echo) in ${join(session, ".cursor", "mcp.json")}`,
			`language servers in ${join(session, ".grok", "lsp.json")}`,
			`MCP server "here" (runs echo) in ${join(t.home, ".claude.json")} (this folder's entry)`,
			"program /bin/sh",
			"program /bin/echo",
		]);
		// Claude Code rewrites the rest of the file all the time: only the servers count.
		t.approve(session);
		t.write(join(t.home, ".claude.json"), JSON.stringify({ numStartups: 4, mcpServers: { user: { command: "/bin/echo" } }, projects: { [repo]: { mcpServers: {} }, [session]: { mcpServers: { here: { command: "/bin/echo" } }, lastCost: 1 } } }));
		expect(t.check(session)).toEqual({ state: "unchanged" });
	});
});
