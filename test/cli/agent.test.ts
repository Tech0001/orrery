import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { instructionsTemplate } from "../../src/agent/instructions.ts";
import { openAgentCommand } from "../../src/cli/agent.ts";
import { WITHOUT_ORRERY_QUESTION } from "../../src/codex/check.ts";
import { CODEX_HOOKS, trustKey } from "../../src/codex/launch.ts";
import { cleanEnv, cliCommand } from "../claude/support.ts";
import { systemCommand } from "../install/support.ts";
import { tempDir } from "../agent/support.ts";

const SCRIPT = systemCommand("script");
const hasScript = process.platform === "linux" && SCRIPT !== undefined && spawnSync(SCRIPT, ["--version"]).status === 0;
const quote = (part: string) => `'${part.replace(/'/g, `'\\''`)}'`;

const dirs: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Atlas (tool pi, with a folder) in a scratch home; a fake pi that claims its token as pi's extension does and writes
 * what it was started with; a fake editor.
 */
function scene() {
	const dir = tempDir("orrery-agent-cli-");
	dirs.push(dir);
	const bin = join(dir, "bin");
	const out = join(dir, "out.txt");
	const agentDir = join(dir, "data", "agents", "Atlas");
	const claims = join(agentDir, "claims");
	for (const folder of [bin, join(dir, "agent-Atlas"), join(dir, "elsewhere")]) mkdirSync(folder);
	writeFileSync(
		join(bin, "pi"),
		`#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.0; exit 0; fi\nmkdir -p ${JSON.stringify(claims)} && echo $$ > ${JSON.stringify(claims)}/"$ORRERY_AGENT_TOKEN"\nls ${JSON.stringify(claims)} > ${JSON.stringify(`${out}.claims`)}\nprintf '%s|%s|%s|%s\\n' "$ORRERY_AGENT" "$ORRERY_AGENT_TOKEN" "$(pwd)" "$*" > ${JSON.stringify(out)}\nexit 0\n`,
		{ mode: 0o755 },
	);
	writeFileSync(join(bin, "fake-editor"), `#!/bin/sh\n[ "$1" = --wait ] || exit 9\nprintf 'Edited.\\n' >> "$2"\n`, { mode: 0o755 });
	const config = join(dir, "config.toml");
	writeFileSync(config, `data_dir = ${JSON.stringify(join(dir, "data"))}\n[agents.Atlas]\nfolder = ${JSON.stringify(join(dir, "agent-Atlas"))}\ntool = "pi"\ncompactor_model = "openai/gpt-6.1-sol"\n`);
	const env = cleanEnv({ PATH: `${bin}:/usr/bin:/bin`, HOME: dir, ORRERY_HOME: join(dir, ".orrery"), ORRERY_CONFIG: config, PI_CODING_AGENT_DIR: join(dir, "pi-agent"), EDITOR: "fake-editor --wait" });
	return { dir, out, env, config, elsewhere: join(dir, "elsewhere"), agentDir };
}

function orrery(env: NodeJS.ProcessEnv, cwd: string, ...args: string[]) {
	const c = cliCommand(args);
	return spawnSync(c.cmd, c.args, { env, cwd, encoding: "utf8", timeout: 20_000 });
}

/** The CLI in a new pseudo-terminal (util-linux script): stdin and stdout are a terminal, as in a person's shell. */
function inTerminal(env: NodeJS.ProcessEnv, cwd: string, ...args: string[]) {
	return typedInTerminal("", env, cwd, ...args);
}

/** inTerminal, with `input` typed into the terminal. */
function typedInTerminal(input: string, env: NodeJS.ProcessEnv, cwd: string, ...args: string[]) {
	const c = cliCommand(args);
	return spawnSync(SCRIPT as string, ["-qec", [c.cmd, ...c.args].map(quote).join(" "), "/dev/null"], { env, cwd, encoding: "utf8", input, timeout: 20_000 });
}

/**
 * A fake Codex 0.162.1 in the scene's bin: its app server lists Orrery's hooks as `trust` says (as the real one does
 * for the flags it was given); run as the session, it writes what it was started with, as the fake pi does.
 */
function fakeCodex(s: ReturnType<typeof scene>, trust: "trusted" | "untrusted") {
	const hooks = CODEX_HOOKS.map((hook) => ({ key: trustKey(hook.event), source: "sessionFlags", trustStatus: trust, enabled: true }));
	const list = JSON.stringify({ id: 2, result: { data: [{ cwd: "/x", hooks, warnings: [], errors: [] }] } });
	writeFileSync(
		join(s.dir, "bin", "codex"),
		[
			"#!/bin/sh",
			'if [ "$1" = "--version" ]; then echo "codex-cli 0.162.1"; exit 0; fi',
			`if [ "$1" = "app-server" ]; then echo x >> ${JSON.stringify(`${s.out}.checks`)}; while IFS= read -r line; do case "$line" in *'"id":1'*) echo '{"id":1,"result":{}}' ;; *'"id":2'*) echo ${quote(list)}; exit 0 ;; esac; done; exit 0; fi`,
			`printf '%s|%s|%s|%s\n' "$ORRERY_AGENT" "$ORRERY_AGENT_TOKEN" "$(pwd)" "$*" > ${JSON.stringify(s.out)}`,
		].join("\n"),
		{ mode: 0o755 },
	);
	/** How many times the app server was asked. */
	return { checks: () => (existsSync(`${s.out}.checks`) ? readFileSync(`${s.out}.checks`, "utf8").trim().split("\n").length : 0) };
}

/** What the fake pi was started with: ORRERY_AGENT, the token, its folder (physical) and its arguments. */
function started(out: string): { agent?: string; token?: string; cwd: string; args?: string } {
	const [agent, token, cwd, args] = readFileSync(out, "utf8").trim().split("|");
	return { agent, token, cwd: realpathSync(cwd as string), args };
}

describe("orrery agent", () => {
	it("opens the agent here: its tool starts in this folder with ORRERY_AGENT, a token, and what follows --", () => {
		const s = scene();
		const r = orrery(s.env, s.elsewhere, "agent", "atlas", "--yes", "--", "--model", "m", "--yes");
		expect(r.status, r.stderr).toBe(0);
		const seen = started(s.out);
		expect([seen.agent, seen.cwd, seen.args]).toEqual(["Atlas", realpathSync(s.elsewhere), "--model m --yes"]);
		expect(seen.token).toMatch(/^[0-9a-f]{32}$/);
		// The tool held its claim while it ran; it is gone once the tool exited.
		expect(readFileSync(`${s.out}.claims`, "utf8").trim()).toBe(seen.token);
		expect(readdirSync(join(s.agentDir, "claims"))).toEqual([]);
	});

	it("keeps the tool's arguments when options with values come before the command", () => {
		const s = scene();
		const { ORRERY_CONFIG: _, ...env } = s.env;
		const r = orrery(env, s.elsewhere, "--config", s.config, "agent", "Atlas", "--yes", "--", "--model", "m");
		expect(r.status, r.stderr).toBe(0);
		expect(started(s.out).args).toBe("--model m");
		rmSync(s.out);
		const tool = orrery(s.env, s.elsewhere, "--tool", "pi", "agent", "Atlas", "--yes", "--", "--model", "n");
		expect(tool.status, tool.stderr).toBe(0);
		expect([started(s.out).agent, started(s.out).args]).toEqual(["Atlas", "--model n"]);
	});

	it("refuses words after the agent's name rather than dropping them, and starts nothing", () => {
		const s = scene();
		const r = orrery(s.env, s.elsewhere, "agent", "Atlas", "--yes", "--model", "m");
		expect(r.status).toBe(1);
		const extra = orrery(s.env, s.elsewhere, "agent", "Atlas", "resume", "last");
		expect(extra.status).toBe(1);
		expect(extra.stderr).toContain("orrery agent takes one agent name; resume last would be dropped. The tool's arguments go after --: orrery agent Atlas -- resume last");
		expect(orrery(s.env, s.dir, "agent", "edit", "Atlas", "now").stderr).toContain("orrery agent edit takes one agent name (got Atlas now).");
		expect(existsSync(s.out)).toBe(false);
		expect(existsSync(s.agentDir)).toBe(false);
	});

	it("says how to pick another tool on the command line when the agent's is not on PATH", () => {
		const s = scene();
		rmSync(join(s.dir, "bin", "pi"));
		const r = orrery(s.env, s.elsewhere, "agent", "Atlas");
		expect(r.status).toBe(1);
		expect(r.stderr).toContain('pi is not on PATH (looked for "pi"). Get it at https://pi.dev, or open Atlas in another tool: --tool for this session, orrery agent set Atlas --tool T for good.');
	});

	it("takes --tool for this session, asks before what the launch needs, and opens nothing on no", () => {
		const s = scene();
		writeFileSync(join(s.dir, "bin", "omp"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.0; exit 0; fi\nprintf 'omp|%s\\n' "$ORRERY_AGENT" > ${JSON.stringify(s.out)}\n`, { mode: 0o755 });
		// No terminal to answer on: the extension install is a no, and nothing opens.
		const no = orrery(s.env, s.elsewhere, "agent", "Atlas", "--tool", "omp");
		expect(no.status).toBe(1);
		expect(no.stdout).toContain("Not opened.");
		expect(existsSync(s.out)).toBe(false);
		const yes = orrery(s.env, s.elsewhere, "agent", "Atlas", "--tool", "omp", "--yes");
		expect(yes.status, yes.stderr).toBe(0);
		expect(readFileSync(s.out, "utf8")).toBe("omp|Atlas\n");
	});

	it("names the tools --tool takes, and the configured agents for an unknown name", () => {
		const s = scene();
		expect(orrery(s.env, s.elsewhere, "agent", "Atlas", "--tool", "claude").stderr).toContain("--tool takes pi, omp, claude-code or codex (not claude).");
		expect(orrery(s.env, s.elsewhere, "agent", "Nobody").stderr).toContain("No agent named Nobody. Configured agents: Atlas");
	});

	it("opens Codex with Orrery's flags and the person's arguments after the hook check, which runs once per Codex version", () => {
		const s = scene();
		const codex = fakeCodex(s, "trusted");
		const r = orrery(s.env, s.elsewhere, "agent", "Atlas", "--tool", "codex", "--", "resume", "--last");
		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toContain("Checking that Orrery's hooks load in Codex 0.162.1…");
		const seen = started(s.out);
		expect([seen.agent, seen.cwd]).toEqual(["Atlas", realpathSync(s.elsewhere)]);
		expect(seen.token).toMatch(/^[0-9a-f]{32}$/);
		expect(seen.args?.startsWith("--no-daemon -c hooks.SessionStart=")).toBe(true);
		expect(seen.args).toContain(" codex-hook session-start");
		expect(seen.args?.endsWith(" resume --last")).toBe(true);
		expect(codex.checks()).toBe(1);
		expect(JSON.parse(readFileSync(join(s.env.ORRERY_HOME as string, "codex-check.json"), "utf8"))).toMatchObject({ codex: "0.162.1", ok: true });
		// Verified: the next launch does not ask again. An agent whose tool is codex opens it without --tool.
		writeFileSync(s.config, readFileSync(s.config, "utf8").replace('tool = "pi"', 'tool = "codex"'));
		rmSync(s.out);
		const again = orrery(s.env, s.elsewhere, "agent", "Atlas");
		expect(again.status, again.stderr).toBe(0);
		expect(again.stdout).not.toContain("Checking");
		expect(started(s.out).args?.startsWith("--no-daemon ")).toBe(true);
		expect(codex.checks()).toBe(1);
	});

	it("refuses without a terminal when Orrery's hooks don't load in Codex, --yes or not, and starts nothing", () => {
		const s = scene();
		fakeCodex(s, "untrusted");
		for (const yes of [[], ["--yes"]]) {
			const r = orrery(s.env, s.elsewhere, "agent", "Atlas", "--tool", "codex", ...yes);
			expect(r.status).toBe(1);
			expect(r.stderr).toContain(
				"Orrery's hooks don't load in Codex 0.162.1: Codex does not trust Orrery's SessionStart hook (untrusted). Without them a session has no memory and no guard. Atlas was not opened: only a person at a terminal can choose to start Codex without them (run orrery agent Atlas there).",
			);
			expect(existsSync(s.out)).toBe(false);
		}
		expect(JSON.parse(readFileSync(join(s.env.ORRERY_HOME as string, "codex-check.json"), "utf8"))).toMatchObject({ codex: "0.162.1", ok: false });
	});

	it("asks about Codex's hooks before any launch step, so a no changes nothing", async () => {
		const s = scene();
		fakeCodex(s, "trusted");
		for (const [key, value] of Object.entries(s.env)) if (value !== undefined) vi.stubEnv(key, value);
		const missing = join(s.dir, "not-yet");
		const said: string[] = [];
		const io = {
			say: (line: string) => said.push(`say: ${line}`),
			confirm: async (question: string) => (said.push(`confirm: ${question}`), true),
			askPerson: async (question: string) => (said.push(`ask: ${question}`), false),
		};
		const deps = {
			takeover: async () => { throw new Error("must not take over"); },
			codexGate: async () => ({ ok: false as const, text: "Orrery's hooks don't load in Codex 0.162.1: x." }),
			run: async () => { throw new Error("must not run"); },
		};
		expect(await openAgentCommand(s.config, "Atlas", { tool: "codex", args: [], cwd: missing }, io, deps)).toBe(1);
		expect(said).toEqual(["say: Orrery's hooks don't load in Codex 0.162.1: x.", `ask: ${WITHOUT_ORRERY_QUESTION}`, "say: Not opened."]);
		// The folder it would open in was not made: that step comes after the check.
		expect(existsSync(missing)).toBe(false);
	});

	it.skipIf(!hasScript)("in a terminal, when the hooks don't load: asks, default no; yes starts plain Codex and says it is not recorded", () => {
		const s = scene();
		fakeCodex(s, "untrusted");
		for (const answer of ["\n", "n\n"]) {
			const no = typedInTerminal(answer, s.env, s.elsewhere, "agent", "Atlas", "--tool", "codex", "--yes", "--", "-x");
			expect(no.status).toBe(1);
			expect(no.stdout).toContain("Orrery's hooks don't load in Codex 0.162.1");
			expect(no.stdout).toContain("Start Codex without Orrery anyway? The session won't be recorded and the guard will be off. (y/N)");
			expect(no.stdout).toContain("Not opened.");
			expect(existsSync(s.out)).toBe(false);
		}
		// Run from a shell that has another agent's variables: plain Codex must not inherit them either.
		const inherited = { ...s.env, ORRERY_AGENT: "Other", ORRERY_AGENT_TOKEN: "e".repeat(32) };
		const yes = typedInTerminal("y\n", inherited, s.elsewhere, "agent", "Atlas", "--tool", "codex", "--", "-x");
		expect(yes.status, yes.stdout).toBe(0);
		expect(yes.stdout).toContain("Starting Codex without Orrery: this session isn't recorded and the guard is off.");
		// Plain Codex: the person's arguments only, and not as any agent.
		expect(started(s.out)).toMatchObject({ agent: "", token: "", args: "-x" });
	});

	it("refuses Claude Code outside the agent's folder without the mod, and starts nothing", () => {
		const s = scene();
		writeFileSync(join(s.dir, "bin", "claude"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 2.1.300; exit 0; fi\nif [ "$1" = "plugin" ]; then echo '[]'; exit 0; fi\ntouch ${JSON.stringify(s.out)}\n`, { mode: 0o755 });
		const r = orrery(s.env, s.elsewhere, "agent", "Atlas", "--tool", "claude-code", "--yes");
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("Claude Code opens Atlas outside its folder only through the Orrery mod: run orrery claude-setup Atlas --mod");
		expect(existsSync(s.out)).toBe(false);
	});

	it("edit refuses without a terminal (an agent's shell, a script), and writes nothing", () => {
		const s = scene();
		const r = orrery({ ...s.env, EDITOR: `cp ${join(s.dir, "elsewhere")}` }, s.dir, "agent", "edit", "Atlas");
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("orrery agent edit needs a terminal: an agent's instructions are edited by a person, in a terminal (run orrery agent edit Atlas in yours).");
		expect(existsSync(s.agentDir)).toBe(false);
	});

	it.skipIf(!hasScript)("edit, in a terminal, writes the template, opens $EDITOR (with its arguments) on instructions.md, and says it saved", () => {
		const s = scene();
		const r = inTerminal(s.env, s.dir, "agent", "edit", "Atlas");
		expect(r.status, r.stdout).toBe(0);
		expect(readFileSync(join(s.agentDir, "instructions.md"), "utf8")).toBe(`${instructionsTemplate("Atlas")}Edited.\n`);
		expect(r.stdout).toContain(`Saved ${join(s.agentDir, "instructions.md")}.`);
	});

	it.skipIf(!hasScript)("edit, in a terminal, says how the editor failed, and leaves the file as it left it", () => {
		const s = scene();
		const r = inTerminal({ ...s.env, EDITOR: "fake-editor --no-wait" }, s.dir, "agent", "edit", "atlas");
		expect(r.status).toBe(9);
		expect(r.stdout).toContain(`The editor exited with code 9; ${join(s.agentDir, "instructions.md")} is as it left it.`);
		expect(readFileSync(join(s.agentDir, "instructions.md"), "utf8")).toBe(instructionsTemplate("Atlas"));
	});
});
