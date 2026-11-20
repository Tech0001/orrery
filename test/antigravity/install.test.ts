import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addAgyEntry, agyFiles, agyHookCommand, agyHookEntry, agyHookTarget, agyInstallSteps, agyServerIsOurs, agySupported, agyWiring, removeAgyEntry } from "../../src/antigravity/install.ts";
import { runInstall } from "../../src/agent/tools.ts";
import { entries } from "../../src/install/layout.ts";
import { unwireAgy } from "../../src/install/uninstall.ts";
import { tempDir } from "../agent/support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A scratch HOME with Antigravity's CLI folder, and an Orrery home whose app/current is a binary install. */
function scratch() {
	const home = tempDir("orrery-agy-install-");
	dirs.push(home);
	const app = join(home, ".orrery", "app");
	const root = join(app, "current");
	mkdirSync(join(root, "bin"), { recursive: true });
	writeFileSync(join(root, "bin", "orrery"), "#!/bin/sh\n");
	chmodSync(join(root, "bin", "orrery"), 0o755);
	mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
	const env: NodeJS.ProcessEnv = { HOME: home };
	return { home, app, root, env, orrery: entries(root).cli, files: agyFiles(env) };
}

const json = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
const noRun = () => ({ status: 0, stdout: "", stderr: "" });

describe("Orrery's hook lines for Antigravity", () => {
	/** Runs `event`'s line with `stdin`, the program at `orrery`, and `env`. */
	const run = (orrery: string, event: "pre-invocation" | "pre-tool-use" | "stop", env: NodeJS.ProcessEnv) =>
		spawnSync("/bin/sh", ["-c", agyHookCommand(orrery, event)], { input: '{"conversationId":"x"}', env: { PATH: "/usr/bin:/bin", ...env }, encoding: "utf8" });

	it("give the idle answer at once in a session no agent's, and when Orrery is gone; the guard nothing (allow)", () => {
		const { orrery } = scratch();
		expect(run(orrery, "pre-invocation", {}).stdout).toBe("{}");
		expect(run(orrery, "stop", {}).stdout).toBe('{"decision":"stop"}');
		const gone = join(dirname(orrery), "missing");
		expect(run(gone, "pre-invocation", { ORRERY_AGENT: "Atlas" }).stdout).toBe("{}");
		expect(run(gone, "pre-tool-use", { ORRERY_AGENT: "Atlas" })).toMatchObject({ status: 0, stdout: "" });
	});

	it("exec Orrery's command with agy-hook and the event, the guard in every session", () => {
		const { orrery } = scratch();
		writeFileSync(orrery, '#!/bin/sh\nprintf "%s %s" "$1" "$2"\n');
		expect(run(orrery, "pre-invocation", { ORRERY_AGENT: "Atlas" }).stdout).toBe("agy-hook pre-invocation");
		expect(run(orrery, "pre-tool-use", {}).stdout).toBe("agy-hook pre-tool-use");
		expect(run(orrery, "stop", { ORRERY_AGENT: "Atlas" }).stdout).toBe("agy-hook stop");
	});

	it("are known again from the entry, for any Orrery's path, and nothing else is", () => {
		const path = "/home/u/it's/.orrery/app/current/bin/orrery";
		expect(agyHookTarget(agyHookEntry(path))).toBe(path);
		expect(agyHookTarget({ ...agyHookEntry(path), Stop: [] })).toBeUndefined();
		expect(agyHookTarget({ PreInvocation: [{ command: "echo hi" }] })).toBeUndefined();
		expect(agyHookTarget(undefined)).toBeUndefined();
	});

	it("come with versions from 0.11.0 on", () => {
		expect(agySupported("0.11.0")).toBe(true);
		expect(agySupported("0.11.3-abc")).toBe(true);
		expect(agySupported("0.10.2")).toBe(false);
		expect(agySupported(undefined)).toBe(false);
	});
});

describe("Orrery's entries in Antigravity's JSON files", () => {
	it("are added where a file has none, keeping everything else; a person's own stays", () => {
		const orrery = "/o/bin/orrery";
		const hooks = addAgyEntry("hooks", JSON.stringify({ mine: { Stop: [] } }), orrery);
		expect(hooks.added).toBe(true);
		expect(JSON.parse(hooks.next)).toEqual({ mine: { Stop: [] }, orrery: agyHookEntry(orrery) });
		const mcp = addAgyEntry("mcp", JSON.stringify({ mcpServers: { other: { command: "x" } } }), orrery);
		expect((JSON.parse(mcp.next) as { mcpServers: Record<string, unknown> }).mcpServers).toMatchObject({ other: { command: "x" }, orrery: { command: orrery, args: ["mcp", "--tool", "antigravity"] } });
		expect(addAgyEntry("status", "", orrery).next).toContain('"stack_with_default": true');
		const own = addAgyEntry("status", JSON.stringify({ statusLine: { type: "command", command: "mine" } }), orrery);
		expect(own).toMatchObject({ added: false, kept: true });
		expect(() => addAgyEntry("hooks", "not json", orrery)).toThrow(/not JSON/);
		expect(() => addAgyEntry("hooks", "[]", orrery)).toThrow(/no JSON object/);
	});

	it("are removed only while they read as Orrery wrote them", () => {
		const orrery = "/o/bin/orrery";
		const ours = addAgyEntry("hooks", "{}", orrery).next;
		expect(JSON.parse(removeAgyEntry("hooks", ours, orrery).next)).toEqual({});
		expect(removeAgyEntry("hooks", ours, "/another/orrery")).toMatchObject({ removed: false, next: ours });
		const changed = JSON.stringify({ orrery: { Stop: [] } });
		expect(removeAgyEntry("hooks", changed, orrery)).toMatchObject({ removed: false });
		// An MCP server switched off in agy is still Orrery's.
		const off = JSON.stringify({ mcpServers: { orrery: { ...(JSON.parse(addAgyEntry("mcp", "{}", orrery).next) as { mcpServers: { orrery: object } }).mcpServers.orrery, disabled: true } } });
		expect(removeAgyEntry("mcp", off, orrery).removed).toBe(true);
	});
});

describe("whether agy's orrery server is this Orrery's own", () => {
	it("is so only for the global entry Orrery wrote for this root, with no workspace's own orrery server", () => {
		const s = scratch();
		const work = join(s.home, "work");
		mkdirSync(join(work, ".agents"), { recursive: true });
		expect(agyServerIsOurs(s.home, s.root, [work])).toBe(false);
		mkdirSync(dirname(s.files.mcp), { recursive: true });
		writeFileSync(s.files.mcp, addAgyEntry("mcp", "", s.orrery).next);
		expect(agyServerIsOurs(s.home, s.root, [work])).toBe(true);
		// A workspace's own orrery server, whatever it runs.
		writeFileSync(join(work, ".agents", "mcp_config.json"), JSON.stringify({ mcpServers: { orrery: { command: "/tmp/evil" } } }));
		expect(agyServerIsOurs(s.home, s.root, [work])).toBe(false);
		writeFileSync(join(work, ".agents", "mcp_config.json"), "{ not json");
		expect(agyServerIsOurs(s.home, s.root, [work])).toBe(false);
		// A global orrery server running something else.
		rmSync(join(work, ".agents", "mcp_config.json"));
		writeFileSync(s.files.mcp, JSON.stringify({ mcpServers: { orrery: { command: "/tmp/evil", args: ["mcp", "--tool", "antigravity"] } } }));
		expect(agyServerIsOurs(s.home, s.root, [work])).toBe(false);
	});
});

describe("connecting Orrery to Antigravity", () => {
	it("adds the three entries, each file copied first, and then reads installed; uninstall takes them out again", () => {
		const s = scratch();
		mkdirSync(dirname(s.files.hooks), { recursive: true });
		writeFileSync(s.files.hooks, JSON.stringify({ mine: { Stop: [{ command: "true" }] } }));
		expect(agyWiring(s.root, s.env)).toMatchObject({ wiring: "missing" });
		const steps = agyInstallSteps(s.root, s.env);
		expect(steps.map((step) => ("path" in step ? step.path : undefined))).toEqual([s.files.hooks, s.files.mcp, s.files.settings]);
		const result = runInstall(steps, noRun);
		expect(result.ok, result.output).toBe(true);
		expect(json(s.files.hooks)).toEqual({ mine: { Stop: [{ command: "true" }] }, orrery: agyHookEntry(s.orrery) });
		expect(json(s.files.mcp)).toMatchObject({ mcpServers: { orrery: { command: s.orrery } } });
		expect(json(s.files.settings)).toMatchObject({ statusLine: { stack_with_default: true } });
		expect(readdirSync(dirname(s.files.hooks)).some((name) => name.startsWith("hooks.json.before-orrery-"))).toBe(true);
		expect(agyWiring(s.root, s.env)).toMatchObject({ wiring: "installed" });
		expect(agyInstallSteps(s.root, s.env)).toEqual([]);
		const unwired = unwireAgy(s.env, s.app);
		expect(unwired).toMatchObject({ ok: true, changed: true });
		expect(json(s.files.hooks)).toEqual({ mine: { Stop: [{ command: "true" }] } });
		expect(json(s.files.mcp)).toEqual({ mcpServers: {} });
		expect(json(s.files.settings)).toEqual({});
	});

	it("says other for an orrery entry of the person's own or another Orrery's, and unknown for a file that isn't JSON", () => {
		const s = scratch();
		mkdirSync(dirname(s.files.hooks), { recursive: true });
		writeFileSync(s.files.hooks, JSON.stringify({ orrery: { Stop: [] } }));
		expect(agyWiring(s.root, s.env)).toMatchObject({ wiring: "other" });
		// The person's own is left: the step says so and changes nothing.
		const steps = agyInstallSteps(s.root, s.env);
		expect(steps.some((step) => "path" in step && step.path === s.files.hooks)).toBe(false);
		writeFileSync(s.files.hooks, JSON.stringify({ orrery: agyHookEntry("/elsewhere/bin/orrery") }));
		expect(agyWiring(s.root, s.env)).toMatchObject({ wiring: "other", now: "runs /elsewhere/bin/orrery" });
		expect(agyInstallSteps(s.root, s.env)[0]?.describe).toMatch(/^replace Orrery's hooks/);
		writeFileSync(s.files.hooks, "{ not json");
		expect(agyWiring(s.root, s.env)).toMatchObject({ wiring: "unknown" });
	});
});
