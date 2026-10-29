import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parse } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";
import { GROK_HOOK_EVENTS } from "../../src/grok/hooks.ts";
import { addGrokConfig, grokHookFile, grokStatusCommand, isOrreryHookFile, removeGrokConfig } from "../../src/grok/install.ts";
import { wireReport } from "../../src/install/wire.ts";
import { cleanupScratch, fakeRun, grokScratch, tempDir } from "../install/support.ts";

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
