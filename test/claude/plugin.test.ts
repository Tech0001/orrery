import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HOOK_EVENTS } from "../../src/claude/hooks.ts";
import { cleanEnv, cleanupDirs, MAIN, testLane } from "./support.ts";

afterEach(cleanupDirs);

const ROOT = new URL("../../", import.meta.url).pathname;
const read = (path: string) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));
const RUN = 'sh "${CLAUDE_PLUGIN_ROOT}/bin/orrery-run"';

describe("the Claude Code plugin", () => {
	it("is a marketplace of one plugin, orrery, from ./claude-plugin", () => {
		expect(read(".claude-plugin/marketplace.json")).toMatchObject({ name: "orrery", owner: { name: expect.any(String) }, plugins: [{ name: "orrery", source: "./claude-plugin" }] });
		expect(read("claude-plugin/.claude-plugin/plugin.json")).toMatchObject({ name: "orrery", version: expect.any(String) });
	});

	it("hooks every event orrery handles through the launcher wrapper, and gives SessionEnd no timeout it cannot have", () => {
		const hooks = read("claude-plugin/hooks/hooks.json").hooks;
		const events: Record<string, string> = { SessionStart: "session-start", UserPromptSubmit: "user-prompt-submit", Stop: "stop", SessionEnd: "session-end", PreToolUse: "pre-tool-use" };
		expect(Object.keys(hooks).sort()).toEqual(Object.keys(events).sort());
		for (const [event, arg] of Object.entries(events)) {
			expect(hooks[event]).toEqual([{ hooks: [expect.objectContaining({ type: "command", command: `${RUN} claude-hook ${arg}` })] }]);
			expect(HOOK_EVENTS).toContain(arg);
		}
		expect(hooks.SessionEnd[0].hooks[0].timeout).toBeUndefined();
	});

	it("loads the Orrery mod beside the classic hooks", () => {
		expect(read("claude-plugin/hooks/hooks.json").modules).toEqual(["./mod.ts"]);
		expect(read("claude-plugin/.claude-plugin/plugin.json").version).toBe("0.5.0");
		const mod = readFileSync(join(ROOT, "claude-plugin/hooks/mod.ts"), "utf8");
		const imports = [...mod.matchAll(/^\s*import\b[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
		expect(imports.sort()).toEqual(["./logo.ts", "./mod-logic.ts", "claude-code"]);
		expect(mod).not.toMatch(/\bimport\(|\brequire\(/);
		expect(mod).toMatch(/import type \{[^}]*\} from "claude-code"/);
	});

	it("serves the MCP server through the wrapper", () => {
		expect(read("claude-plugin/.mcp.json")).toEqual({ mcpServers: { orrery: { command: "sh", args: ["${CLAUDE_PLUGIN_ROOT}/bin/orrery-run", "mcp"] } } });
	});

	it("has the three commands, each a user-only skill that runs an orrery command for this lane", () => {
		const skills: Array<[string, string]> = [["memory", "status ."], ["memory", "usage ."], ["browse", "browse . --open"], ["compactor", "compactor ."]];
		for (const [skill, command] of skills) {
			const text = readFileSync(join(ROOT, "claude-plugin", "skills", skill, "SKILL.md"), "utf8");
			expect(text).toMatch(/^---\ndescription: .+\n/);
			expect(text).toContain("disable-model-invocation: true");
			if (skill === "compactor") expect(text).toContain(`${RUN} ${command}`);
			else expect(text).toContain(`!\`${RUN} ${command}\``);
		}
	});

	it("grants each skill's commands exactly, never a broad Bash grant", () => {
		const grants: Record<string, string[]> = {
			memory: [`Bash(${RUN} status .)`, `Bash(${RUN} usage .)`],
			browse: [`Bash(${RUN} browse . --open)`],
			compactor: [`Bash(${RUN} compactor:*)`],
		};
		for (const [skill, expected] of Object.entries(grants)) {
			const text = readFileSync(join(ROOT, "claude-plugin", "skills", skill, "SKILL.md"), "utf8");
			const line = text.split("\n").find((l) => l.startsWith("allowed-tools: "));
			expect(line?.slice("allowed-tools: ".length).split(", ")).toEqual(expected);
			for (const grant of expected) expect(grant).not.toMatch(/^Bash(\(\*?\))?$|^Bash\(sh:\*\)$/);
		}
		const compactor = readFileSync(join(ROOT, "claude-plugin", "skills", "compactor", "SKILL.md"), "utf8");
		expect(compactor).toContain(`!\`${RUN} compactor . --prefix /orrery:compactor $ARGUMENTS\``);
	});

	it("applies PreToolUse to every tool", () => {
		const pre = read("claude-plugin/hooks/hooks.json").hooks.PreToolUse;
		expect(pre).toHaveLength(1);
		expect(pre[0].matcher === undefined || pre[0].matcher === "" || pre[0].matcher === "*").toBe(true);
		expect(pre[0].hooks[0].timeout).toBe(10);
	});

	it("passes arguments through the wrapper untouched, even ones a shell would act on", () => {
		const t = testLane();
		const wrapper = join(ROOT, "claude-plugin", "bin", "orrery-run");
		const out = spawnSync("sh", [wrapper, "status", "$(touch pwned)"], { env: cleanEnv({ ORRERY_BIN: MAIN, ORRERY_CONFIG: t.configPath, HOME: t.dir }), encoding: "utf8", cwd: t.dir });
		expect(out.stderr).toContain("No lane named");
		expect(existsSync(join(t.dir, "pwned"))).toBe(false);
	});

	it("runs ORRERY_BIN through the wrapper, and does nothing when Orrery is not installed", () => {
		const t = testLane();
		const wrapper = join(ROOT, "claude-plugin", "bin", "orrery-run");
		expect(statSync(wrapper).mode & 0o111).not.toBe(0);
		expect(spawnSync("sh", [wrapper, "help"], { env: cleanEnv({ ORRERY_BIN: MAIN }), encoding: "utf8" }).stdout).toContain("Usage: orrery");
		const none = spawnSync("sh", [wrapper, "claude-hook", "stop"], { env: cleanEnv({ HOME: t.dir }), encoding: "utf8", input: "{}" });
		expect([none.status, none.stdout, none.stderr]).toEqual([0, "", ""]);
	});
});
