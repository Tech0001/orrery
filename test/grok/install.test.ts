import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parse } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";
import { GROK_HOOK_EVENTS } from "../../src/grok/hooks.ts";
import { checkTools, rowDetail, type ToolCheck } from "../../src/agent/tools.ts";
import { addGrokConfig, grokConfigLacks, grokGuardSwitchedOff, grokHookFile, grokHooksInstalled, grokRecordingSwitchedOff, grokStatusCommand, grokSwitchesUnreadable, isOrreryHookFile, removeGrokConfig } from "../../src/grok/install.ts";
import { approveGrokSettings, checkGrokSettings } from "../../src/grok/settings.ts";
import { wireReport } from "../../src/install/wire.ts";
import { cleanupScratch, fakeRun, grokScratch, tempDir } from "../install/support.ts";
import { cliCommand } from "../claude/support.ts";

afterEach(cleanupScratch);

const ORRERY = "/home/u/.orrery/app/current/bin/orrery";
const EVENTS = { SessionStart: "session-start", UserPromptSubmit: "user-prompt-submit", PreToolUse: "pre-tool-use", Stop: "stop", StopCancelled: "stop-cancelled", SessionEnd: "session-end" };

interface Handler {
	readonly type: string;
	readonly command: string;
	readonly args: string[];
	readonly timeout: number;
}
const handlers = (text: string) => Object.entries((JSON.parse(text) as { hooks: Record<string, { hooks: Handler[] }[]> }).hooks);

/** What setup set aside or copied beside `path` (<name>.before-orrery-<date>[-n]). */
const asides = (path: string) =>
	readdirSync(dirname(path))
		.filter((name) => name.startsWith(`${basename(path)}.before-orrery-`))
		.sort((a, b) => a.length - b.length || a.localeCompare(b))
		.map((name) => join(dirname(path), name));

/** Orrery's two entries in Grok's config, as parsed, for the Orrery at `orrery`. */
const entries = (orrery: string) => ({
	status_line: { type: "command", command: grokStatusCommand(orrery) },
	orrery: { command: orrery, args: ["mcp", "--tool", "grok"], env: { ORRERY_AGENT: "${ORRERY_AGENT:-}", ORRERY_AGENT_TOKEN: "${ORRERY_AGENT_TOKEN:-}" } },
});

describe("Grok's hook file", () => {
	it("the hook file runs grok-hook for six events with no shell parsing of user text", () => {
		const text = grokHookFile(ORRERY);
		expect(text.endsWith("\n")).toBe(true);
		const events = handlers(text);
		expect(events.map(([event]) => event)).toEqual(Object.keys(EVENTS));
		expect(Object.values(EVENTS)).toEqual([...GROK_HOOK_EVENTS]);
		const scripts = new Set<string>();
		for (const [event, groups] of events) {
			// One group, no matcher: every start source, tool and end reason.
			expect(groups).toEqual([{ hooks: [{ type: "command", command: "/bin/sh", args: ["-c", expect.any(String), "orrery-grok", EVENTS[event as keyof typeof EVENTS]], timeout: event === "SessionStart" ? 15 : 10 }] }]);
			scripts.add(groups[0]?.hooks[0]?.args[1] as string);
		}
		// One fixed script: the event is its argument, and nothing of the hook's input is in it.
		expect(scripts.size).toBe(1);

		// Run as Grok runs it (args given: no shell parses the command), with an Orrery whose path needs quoting.
		const dir = tempDir("orrery-grok-hook-");
		const bin = join(dir, "it's my $HOME", "bin", "orrery");
		mkdirSync(dirname(bin), { recursive: true });
		const log = join(dir, "log");
		writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$PPID" "$@" > ${JSON.stringify(log)}\ncat >> ${JSON.stringify(log)}\n`, { mode: 0o755 });
		const input = JSON.stringify({ prompt: "$(touch pwned) `touch pwned` '\"; exit 2", hook_event_name: "UserPromptSubmit" });
		for (const [event, groups] of handlers(grokHookFile(bin))) {
			const hook = groups[0]?.hooks[0] as Handler;
			const run = spawnSync(hook.command, hook.args, { input, encoding: "utf8", cwd: dir });
			expect([event, run.status, run.stdout, run.stderr]).toEqual([event, 0, "", ""]);
			// exec: the hook's parent is the process that started it (Grok), and it gets the input untouched on stdin.
			expect(readFileSync(log, "utf8")).toBe(`${process.pid}\ngrok-hook\n${EVENTS[event as keyof typeof EVENTS]}\n${input}`);
		}
		expect(existsSync(join(dir, "pwned"))).toBe(false);

		// Orrery removed: every event reads its input to the end, prints nothing and exits 0 (no hook error in Grok).
		rmSync(bin);
		for (const [event, groups] of handlers(grokHookFile(bin))) {
			const hook = groups[0]?.hooks[0] as Handler;
			const run = spawnSync(hook.command, hook.args, { input: "x".repeat(1 << 20), encoding: "utf8" });
			expect([event, run.status, run.stdout, run.stderr]).toEqual([event, 0, "", ""]);
		}
	});

	it("is Orrery's only when it is exactly what Orrery writes, for any Orrery", () => {
		expect(isOrreryHookFile(grokHookFile(ORRERY))).toBe(true);
		expect(isOrreryHookFile(grokHookFile("/opt/it's here/bin/orrery"))).toBe(true);
		const own = JSON.parse(grokHookFile(ORRERY)) as { hooks: Record<string, unknown[]> };
		const changed = (change: (file: { hooks: Record<string, unknown[]> }) => void) => {
			const copy = structuredClone(own);
			change(copy);
			return JSON.stringify(copy);
		};
		expect(isOrreryHookFile(JSON.stringify(own, null, 4))).toBe(true);
		expect(isOrreryHookFile(changed((f) => (f.hooks.PostToolUse = f.hooks.Stop as unknown[])))).toBe(false);
		expect(isOrreryHookFile(changed((f) => delete f.hooks.Stop))).toBe(false);
		expect(isOrreryHookFile(changed((f) => (f.hooks.Stop = [...(f.hooks.Stop as unknown[]), { hooks: [{ type: "command", command: "mine" }] }])))).toBe(false);
		expect(isOrreryHookFile(changed((f) => ((f.hooks.Stop?.[0] as { matcher?: string }).matcher = "end_turn")))).toBe(false);
		expect(isOrreryHookFile(grokHookFile(ORRERY).replace('exec \\"$o\\"', 'exec \\"$o\\" --flag'))).toBe(false);
		for (const text of ["", "{}", "not json", '{"hooks":{}}', "null"]) expect(isOrreryHookFile(text)).toBe(false);
	});

	it("a foreign orrery.json is set aside, Orrery's own is replaced", async () => {
		const t = grokScratch();
		const hooks = join(t.grok, "hooks", "orrery.json");
		const config = join(t.grok, "config.toml");
		const orrery = join(t.current, "bin", "orrery");
		mkdirSync(dirname(hooks), { recursive: true });
		const foreign = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"my-notifier"}]}]}}\n';
		writeFileSync(hooks, foreign);
		const replaceForeign = `Grok: replace ${hooks} (now not Orrery's hook file) with Orrery's hooks for every Grok session, then add Orrery's status row and memory tools to ${config} unless it has its own (a copy of it first)?`;
		// Declined: left as it is, nothing set aside, and listed.
		const asked: string[] = [];
		const declined = await wireReport(t.env, { run: fakeRun, confirm: async (what) => (asked.push(what), !what.startsWith("Grok: ")) });
		expect(asked.filter((what) => what.startsWith("Grok"))).toEqual([replaceForeign]);
		expect([readFileSync(hooks, "utf8"), asides(hooks), existsSync(config)]).toEqual([foreign, [], false]);
		expect(declined.left).toEqual([`Grok (still wired to ${hooks} is not Orrery's hook file; tested with Grok 1.0.70)`]);
		// Confirmed: set aside under setAside's name, then Orrery's written.
		asked.length = 0;
		const first = await wireReport(t.env, { run: fakeRun, confirm: async (what) => (asked.push(what), true) });
		expect(asked.filter((what) => what.startsWith("Grok"))).toEqual([replaceForeign]);
		const [aside, ...more] = asides(hooks);
		expect(more).toEqual([]);
		expect(aside).toMatch(/\/orrery\.json\.before-orrery-\d{4}-\d{2}-\d{2}$/);
		expect(readFileSync(aside as string, "utf8")).toBe(foreign);
		expect(readFileSync(hooks, "utf8")).toBe(grokHookFile(orrery));
		expect(first.lines).toContain(`Grok: set ${hooks} aside as ${aside}`);
		expect(first.lines).toContain(`Grok: wrote ${hooks}`);
		expect(first.left).toEqual([]);
		// Another Orrery's hook file: asked, then replaced without a copy (Orrery's own text, which the other Orrery rewrites).
		writeFileSync(hooks, grokHookFile("/opt/other/app/current/bin/orrery"));
		asked.length = 0;
		const second = await wireReport(t.env, { run: fakeRun, confirm: async (what) => (asked.push(what), true) });
		expect(asked.filter((what) => what.startsWith("Grok"))).toEqual([`Grok: replace ${hooks} (now runs /opt/other/app/current/bin/orrery) with Orrery's hooks for every Grok session?`]);
		expect(readFileSync(hooks, "utf8")).toBe(grokHookFile(orrery));
		expect(asides(hooks)).toEqual([aside]);
		expect(second.lines.filter((line) => line.startsWith("Grok: "))).toEqual([`Grok: wrote ${hooks}`]);
	});

	it("knows whether Grok runs Orrery's own hooks for an install: exactly its file, running that install's command", () => {
		const t = grokScratch();
		const hooks = join(t.grok, "hooks", "orrery.json");
		expect(grokHooksInstalled(t.current, t.env)).toBe(false);
		mkdirSync(dirname(hooks), { recursive: true });
		writeFileSync(hooks, grokHookFile(join(t.current, "bin", "orrery")));
		expect(grokHooksInstalled(t.current, t.env)).toBe(true);
		// Another Orrery's, or not Orrery's: no.
		writeFileSync(hooks, grokHookFile("/opt/other/app/current/bin/orrery"));
		expect(grokHooksInstalled(t.current, t.env)).toBe(false);
		writeFileSync(hooks, '{"hooks":{}}\n');
		expect(grokHooksInstalled(t.current, t.env)).toBe(false);
		// One that can't be read: can't be told.
		if (process.getuid?.() !== 0) {
			writeFileSync(hooks, grokHookFile(join(t.current, "bin", "orrery")));
			chmodSync(hooks, 0o000);
			try {
				expect(grokHooksInstalled(t.current, t.env)).toBeUndefined();
			} finally {
				chmodSync(hooks, 0o600);
			}
		}
	});

	it("knows whether the guard of Orrery's hook file is switched off in Grok's /hooks tab: its disabled-hooks file, as Grok 1.0.70 writes it", () => {
		const t = grokScratch();
		const disabled = join(t.grok, "disabled-hooks");
		// No file: nothing is switched off.
		expect(grokGuardSwitchedOff(t.env)).toBe(false);
		// Other hooks switched off, Orrery's other events among them (seen live: one name per line).
		writeFileSync(disabled, "global/orrery:user_prompt_submit[0].hooks[0]\nproject/log:pre_tool_use[0].hooks[0]\nglobal/other:pre_tool_use[0].hooks[0]\n");
		expect(grokGuardSwitchedOff(t.env)).toBe(false);
		// Orrery's guard switched off (Space on its PreToolUse hook).
		writeFileSync(disabled, "global/orrery:user_prompt_submit[0].hooks[0]\nglobal/orrery:pre_tool_use[0].hooks[0]\n");
		expect(grokGuardSwitchedOff(t.env)).toBe(true);
		writeFileSync(disabled, "global/orrery:pre_tool_use[0].hooks[0]\r\n");
		expect(grokGuardSwitchedOff(t.env)).toBe(true);
		// A file that can't be read: it can't be told, so taken as switched off.
		if (process.getuid?.() !== 0) {
			chmodSync(disabled, 0o000);
			try {
				expect(grokGuardSwitchedOff(t.env)).toBe(true);
			} finally {
				chmodSync(disabled, 0o600);
			}
		}
		rmSync(disabled);
		mkdirSync(disabled);
		expect(grokGuardSwitchedOff(t.env)).toBe(true);
	});

	it("names Grok's disabled-hooks file when it is there but can't be read, apart from what it switches off", () => {
		const t = grokScratch();
		const disabled = join(t.grok, "disabled-hooks");
		// No file, or one that reads: nothing to say about reading it.
		expect(grokSwitchesUnreadable(t.env)).toBeUndefined();
		writeFileSync(disabled, "global/orrery:pre_tool_use[0].hooks[0]\n");
		expect(grokSwitchesUnreadable(t.env)).toBeUndefined();
		if (process.getuid?.() !== 0) {
			chmodSync(disabled, 0o000);
			try {
				expect(grokSwitchesUnreadable(t.env)).toBe(disabled);
				// The guard's own reading is unchanged: can't be told, so switched off; recording: nothing told.
				expect(grokGuardSwitchedOff(t.env)).toBe(true);
				expect(grokRecordingSwitchedOff(t.env)).toBe(false);
			} finally {
				chmodSync(disabled, 0o600);
			}
		}
		rmSync(disabled);
		mkdirSync(disabled);
		expect(grokSwitchesUnreadable(t.env)).toBe(disabled);
	});

	it("Grok's row says whether Grok's settings are the ones approved, when asked: not yet, changed since, or nothing when they are", async () => {
		const t = grokScratch();
		await wireReport(t.env, { run: fakeRun, confirm: async () => true });
		// The record is in the data folder given: here Orrery's home, as with no config.
		const grok = (grokSettings: string | null = t.orreryHome) => checkTools({ root: t.current, env: t.env, run: fakeRun, ...(grokSettings === null ? {} : { grokSettings }) }).find((check) => check.id === "grok") as ToolCheck;
		const hooks = join(t.grok, "hooks", "orrery.json");
		const detail = `${hooks}; tested with Grok 1.0.70`;
		expect(grok()).toMatchObject({ wiring: "installed", detail, settings: "Grok settings not approved yet" });
		approveGrokSettings(t.orreryHome, checkGrokSettings(t.orreryHome, t.env, undefined).shown);
		expect(grok()).toEqual(expect.objectContaining({ wiring: "installed", detail }));
		expect(grok().settings).toBeUndefined();
		writeFileSync(join(t.grok, "hooks", "other.json"), '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"/nowhere/x"}]}]}}\n');
		expect(grok()).toMatchObject({ wiring: "installed", detail, settings: "Grok settings changed since you approved them" });
		expect(rowDetail(grok())).toBe(`${detail}; Grok settings changed since you approved them`);
		// Another data folder's record is that folder's; with none given, Grok's settings aren't looked at.
		expect(grok(join(t.home, "elsewhere")).settings).toBe("Grok settings not approved yet");
		expect(grok(null).settings).toBeUndefined();
	});

	it("Grok's settings words stay out of setup's lines; orrery tools shows them after the row's detail", async () => {
		const t = grokScratch();
		await wireReport(t.env, { run: fakeRun, confirm: async () => true });
		const hooks = join(t.grok, "hooks", "orrery.json");
		// No config: the record is in Orrery's home. Approved, then a hook file of someone else's: changed.
		approveGrokSettings(t.orreryHome, checkGrokSettings(t.orreryHome, t.env, undefined).shown);
		writeFileSync(join(t.grok, "hooks", "other.json"), '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"/nowhere/x"}]}]}}\n');
		const { lines, left } = await wireReport(t.env, { run: fakeRun, confirm: async () => true });
		expect(left).toEqual([]);
		expect(lines.filter((line) => line.startsWith("Grok: "))).toEqual([`Grok: already wired (${hooks}; tested with Grok 1.0.70)`]);
		const c = cliCommand(["tools"]);
		const tools = spawnSync(c.cmd, c.args, { env: t.env, encoding: "utf8", timeout: 20_000 });
		expect(tools.status, tools.stderr).toBe(0);
		// (The spawned CLI is this checkout, so it calls the wiring another Orrery's: the words follow whatever detail.)
		expect(tools.stdout.split("\n").find((line) => line.startsWith("Grok "))).toMatch(/; tested with Grok 1\.0\.70; Grok settings changed since you approved them$/);
	});

	it("names the config tables of Orrery's that Grok's config lacks, none when it can't be read", () => {
		const t = grokScratch();
		const config = join(t.grok, "config.toml");
		const full = addGrokConfig("", join(t.current, "bin", "orrery")).next;
		// No config yet: both.
		expect(grokConfigLacks(t.current, t.env)).toEqual(["ui.status_line", "mcp_servers.orrery"]);
		writeFileSync(config, full.slice(0, full.indexOf("[mcp_servers.orrery]")));
		expect(grokConfigLacks(t.current, t.env)).toEqual(["mcp_servers.orrery"]);
		writeFileSync(config, full.slice(full.indexOf("[mcp_servers.orrery]")));
		expect(grokConfigLacks(t.current, t.env)).toEqual(["ui.status_line"]);
		writeFileSync(config, full);
		expect(grokConfigLacks(t.current, t.env)).toEqual([]);
		// A status line of the person's own counts as one.
		writeFileSync(config, `[ui.status_line]\ntype = "command"\ncommand = "mine"\n`);
		expect(grokConfigLacks(t.current, t.env)).toEqual(["mcp_servers.orrery"]);
		// Not TOML: none (the tools check says "unknown").
		writeFileSync(config, "[ui\n");
		expect(grokConfigLacks(t.current, t.env)).toEqual([]);
	});
});

describe("Grok's config entries", () => {
	it("config: both entries added to a file with [ui] permission_mode, and the copy is made first", async () => {
		const t = grokScratch();
		const config = join(t.grok, "config.toml");
		const before = '[cli]\ninstaller = "npm"\n\n[ui]\nyolo = false\npermission_mode = "auto"\n\n[privacy]\nprivacy_banner_acked = true\n';
		writeFileSync(config, before, { mode: 0o600 });
		const { lines, left } = await wireReport(t.env, { run: fakeRun, confirm: async () => true });
		expect(left).toEqual([]);
		const orrery = join(t.current, "bin", "orrery");
		const after = readFileSync(config, "utf8");
		// Every line of the file stays as it was; the entries come after it.
		expect(after.startsWith(before)).toBe(true);
		const { status_line, orrery: server } = entries(orrery);
		expect(parse(after)).toEqual({ ...parse(before), ui: { yolo: false, permission_mode: "auto", status_line }, mcp_servers: { orrery: server } });
		expect(statSync(config).mode & 0o777).toBe(0o600);
		const [copy] = asides(config);
		expect(copy).toMatch(/\/config\.toml\.before-orrery-\d{4}-\d{2}-\d{2}$/);
		expect(readFileSync(copy as string, "utf8")).toBe(before);
		const said = lines.filter((line) => line.startsWith("Grok: "));
		const copied = said.indexOf(`Grok: kept a copy of ${config} as ${copy}`);
		expect(copied).toBeGreaterThanOrEqual(0);
		expect(said.indexOf(`Grok: added [ui.status_line] and [mcp_servers.orrery] to ${config}`)).toBeGreaterThan(copied);
		// A config that isn't there yet is made with the entries alone.
		const fresh = grokScratch();
		await wireReport(fresh.env, { run: fakeRun, confirm: async () => true });
		const made = join(fresh.grok, "config.toml");
		expect(parse(readFileSync(made, "utf8"))).toEqual({ ui: { status_line: entries(join(fresh.current, "bin", "orrery")).status_line }, mcp_servers: { orrery: entries(join(fresh.current, "bin", "orrery")).orrery } });
		expect(asides(made)).toEqual([]);
	});

	it("a user's own status line is kept and reported", async () => {
		const own = '[ui.status_line]\ntype = "builtin"\nitems = ["cwd", "model"]\n';
		expect(addGrokConfig(own, ORRERY)).toMatchObject({ added: ["mcp_servers.orrery"], kept: ["ui.status_line"] });
		const t = grokScratch();
		const config = join(t.grok, "config.toml");
		writeFileSync(config, own);
		const { lines } = await wireReport(t.env, { run: fakeRun, confirm: async () => true });
		const after = parse(readFileSync(config, "utf8")) as { ui: unknown; mcp_servers: unknown };
		expect(after.ui).toEqual({ status_line: { type: "builtin", items: ["cwd", "model"] } });
		expect(after.mcp_servers).toEqual({ orrery: entries(join(t.current, "bin", "orrery")).orrery });
		expect(lines).toContain(`Grok: added [mcp_servers.orrery] to ${config}`);
		expect(lines).toContain(`Grok: kept your own status line in ${config}; for Orrery's row, run orrery grok-status from it (it reads Grok's status JSON on stdin)`);
	});

	it("a second install changes nothing", async () => {
		const t = grokScratch();
		const config = join(t.grok, "config.toml");
		writeFileSync(config, '[ui]\npermission_mode = "auto"\n');
		await wireReport(t.env, { run: fakeRun, confirm: async () => true });
		const hooks = join(t.grok, "hooks", "orrery.json");
		const was = { hooks: readFileSync(hooks, "utf8"), config: readFileSync(config, "utf8"), asides: asides(config), changed: statSync(config).mtimeMs, written: statSync(hooks).mtimeMs };
		const { lines, left } = await wireReport(t.env, { run: fakeRun, confirm: async (what) => !what.startsWith("Connect Orrery to Grok") });
		expect(left).toEqual([]);
		expect(lines.filter((line) => line.startsWith("Grok: "))).toEqual([`Grok: already wired (${hooks}; tested with Grok 1.0.70)`]);
		expect({ hooks: readFileSync(hooks, "utf8"), config: readFileSync(config, "utf8"), asides: asides(config), changed: statSync(config).mtimeMs, written: statSync(hooks).mtimeMs }).toEqual(was);
		expect(addGrokConfig(was.config, join(t.current, "bin", "orrery"))).toEqual({ next: was.config, added: [], kept: [] });
	});

	it("a table of Orrery's the person removed is asked about again, never re-added on its own; no copy unless something is written", async () => {
		const t = grokScratch();
		const config = join(t.grok, "config.toml");
		const hooks = join(t.grok, "hooks", "orrery.json");
		writeFileSync(config, '[ui]\npermission_mode = "auto"\n');
		await wireReport(t.env, { run: fakeRun, confirm: async () => true });
		// The person removes Orrery's status row.
		const wired = readFileSync(config, "utf8");
		const removed = wired.replace(/\n\[ui\.status_line\]\n(?:[^[\n].*\n)*/, "");
		expect(removed).not.toBe(wired);
		expect((parse(removed) as { ui: object }).ui).toEqual({ permission_mode: "auto" });
		writeFileSync(config, removed);
		const copies = asides(config);
		const grok = () => checkTools({ root: t.current, env: t.env }).find((check) => check.id === "grok") as ToolCheck;
		expect(grok()).toMatchObject({ wiring: "missing", detail: `${config} has no [ui.status_line]; tested with Grok 1.0.70` });
		// Setup (and an update's) asks, as it asks to connect; declined, nothing is written and no copy made.
		const asked: string[] = [];
		const declined = await wireReport(t.env, { run: fakeRun, confirm: async (what) => (asked.push(what), !what.startsWith("Connect Orrery to Grok? (")) });
		expect(asked.filter((what) => what.includes("Grok"))).toEqual([`Connect Orrery to Grok? (adds Orrery's status row and memory tools to ${config})`]);
		expect(declined.lines).toContain("Grok: not connected");
		expect(declined.left).toEqual(["Grok (not connected)"]);
		expect([readFileSync(config, "utf8"), asides(config)]).toEqual([removed, copies]);
		// Confirmed: the row comes back, after one more copy, and the hook file is left as it was.
		const hookFile = readFileSync(hooks, "utf8");
		const accepted = await wireReport(t.env, { run: fakeRun, confirm: async () => true });
		expect(accepted.left).toEqual([]);
		expect(parse(readFileSync(config, "utf8"))).toEqual(parse(wired));
		const [copy, ...none] = asides(config).filter((path) => !copies.includes(path));
		expect(none).toEqual([]);
		expect(readFileSync(copy as string, "utf8")).toBe(removed);
		expect(accepted.lines).toContain(`Grok: added [ui.status_line] to ${config}`);
		expect(readFileSync(hooks, "utf8")).toBe(hookFile);
		expect(grok()).toMatchObject({ wiring: "installed" });
	});

	it("moves Orrery's hook file of the other install shape without asking, and touches no config that has Orrery's tables", async () => {
		const t = grokScratch();
		const config = join(t.grok, "config.toml");
		const hooks = join(t.grok, "hooks", "orrery.json");
		await wireReport(t.env, { run: fakeRun, confirm: async () => true });
		const configText = readFileSync(config, "utf8");
		const copies = asides(config);
		const changed = statSync(config).mtimeMs;
		// The hook file as a source-shape install of this home wrote it.
		writeFileSync(hooks, grokHookFile(join(t.current, "src", "cli", "main.ts")));
		const { lines, left } = await wireReport(t.env, { run: fakeRun, confirm: async (what) => !what.includes("Grok") });
		expect(left).toEqual([]);
		expect(readFileSync(hooks, "utf8")).toBe(grokHookFile(join(t.current, "bin", "orrery")));
		expect(lines.filter((line) => line.startsWith("Grok: "))).toEqual([`Grok: wrote ${hooks}`]);
		expect([readFileSync(config, "utf8"), asides(config), statSync(config).mtimeMs]).toEqual([configText, copies, changed]);
	});

	it("the status row's command runs grok-status by exec (its parent stays Grok), and with Orrery removed prints nothing and exits 0", () => {
		// What Orrery writes: the hook file's fallback, then the command.
		expect(grokStatusCommand(ORRERY)).toBe(`[ -x '${ORRERY}' ] || exit 0; exec '${ORRERY}' grok-status`);
		const { next } = addGrokConfig("", ORRERY);
		expect((parse(next) as { ui: { status_line: unknown } }).ui.status_line).toEqual({ type: "command", command: grokStatusCommand(ORRERY) });
		// Run as Grok runs a status line (through sh), with an Orrery whose path needs quoting.
		const dir = tempDir("orrery-grok-status-line-");
		const bin = join(dir, "it's my $HOME", "bin", "orrery");
		mkdirSync(dirname(bin), { recursive: true });
		writeFileSync(bin, `#!/bin/sh\nprintf '%s ' "$PPID" "$@"\ncat\n`, { mode: 0o755 });
		const status = JSON.stringify({ schema_version: 1, session_id: "s1", trigger: "state" });
		const run = spawnSync("/bin/sh", ["-c", grokStatusCommand(bin)], { input: status, encoding: "utf8" });
		expect([run.status, run.stdout, run.stderr]).toEqual([0, `${process.pid} grok-status ${status}`, ""]);
		// Orrery removed, or its command no program: no row, no error code for Grok to paint, stdin left unread.
		chmodSync(bin, 0o644);
		expect(spawnSync("/bin/sh", ["-c", grokStatusCommand(bin)], { input: status, encoding: "utf8" })).toMatchObject({ status: 0, stdout: "", stderr: "" });
		rmSync(bin);
		expect(spawnSync("/bin/sh", ["-c", grokStatusCommand(bin)], { input: status, encoding: "utf8" })).toMatchObject({ status: 0, stdout: "", stderr: "" });
		// Orrery's own table, with its new text, is recognised to keep and to remove; another Orrery's is not.
		expect(addGrokConfig(next, ORRERY)).toEqual({ next, added: [], kept: [] });
		expect(removeGrokConfig(next, ORRERY)).toEqual({ next: "", removed: ["ui.status_line", "mcp_servers.orrery"], kept: [] });
		expect(removeGrokConfig(next, "/other/app/current/bin/orrery").kept).toEqual(["ui.status_line", "mcp_servers.orrery"]);
	});

	it("removeGrokConfig removes only entries that still read as Orrery wrote them", () => {
		const base = '# mine\n[ui]\npermission_mode = "auto"\n';
		const { next: added } = addGrokConfig(base, ORRERY);
		expect(removeGrokConfig(added, ORRERY)).toEqual({ next: base, removed: ["ui.status_line", "mcp_servers.orrery"], kept: [] });
		// Changed after Orrery wrote it: kept, the other one goes.
		const changed = added.replace('args = ["mcp", "--tool", "grok"]', 'args = ["mcp", "--tool", "grok", "--mine"]');
		expect(changed).not.toBe(added);
		const one = removeGrokConfig(changed, ORRERY);
		expect(one).toMatchObject({ removed: ["ui.status_line"], kept: ["mcp_servers.orrery"] });
		expect((parse(one.next) as { mcp_servers: { orrery: { args: string[] } } }).mcp_servers.orrery.args).toEqual(["mcp", "--tool", "grok", "--mine"]);
		// Another Orrery's entries are that Orrery's.
		expect(removeGrokConfig(added, "/other/app/current/bin/orrery")).toEqual({ next: added, removed: [], kept: ["ui.status_line", "mcp_servers.orrery"] });
		// Grok's own on/off switch (grok mcp disable) in Orrery's server entry leaves it Orrery's.
		const toggled = added.replace("[mcp_servers.orrery]\n", "[mcp_servers.orrery]\nenabled = false\n");
		expect(removeGrokConfig(toggled, ORRERY)).toEqual({ next: base, removed: ["ui.status_line", "mcp_servers.orrery"], kept: [] });
		// A user's own table after Orrery's keeps its comment; one before keeps its place.
		const later = `${added}\n# my server\n[mcp_servers.mine]\ncommand = "x"\n`;
		expect(removeGrokConfig(later, ORRERY).next).toBe(`${base}\n# my server\n[mcp_servers.mine]\ncommand = "x"\n`);
		// Nothing of Orrery's: nothing changes.
		expect(removeGrokConfig(base, ORRERY)).toEqual({ next: base, removed: [], kept: [] });
		expect(removeGrokConfig("", ORRERY)).toEqual({ next: "", removed: [], kept: [] });
	});

	it("adds nothing it can't place safely, and says why; a file that isn't TOML is left as it is", () => {
		expect(() => addGrokConfig('ui = { theme = "dark" }\n', ORRERY)).toThrow(/couldn't place/);
		expect(() => addGrokConfig("[ui\n", ORRERY)).toThrow();
		const crlf = '[ui]\r\npermission_mode = "auto"\r\n';
		const { next } = addGrokConfig(crlf, ORRERY);
		expect(next.startsWith(crlf)).toBe(true);
		expect(next.replace(/\r\n/g, "")).not.toContain("\n");
		expect(removeGrokConfig(next, ORRERY).next).toBe(crlf);
	});
});
