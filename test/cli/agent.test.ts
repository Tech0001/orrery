import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { instructionsTemplate } from "../../src/agent/instructions.ts";
import { openAgentCommand } from "../../src/cli/agent.ts";
import type { AgentConfig } from "../../src/agent/config.ts";
import { loadConfig } from "../../src/agent/config.ts";
import type { LaunchPlan } from "../../src/agent/launch.ts";
import { claimToken } from "../../src/agent/pick.ts";
import { writeMode } from "../../src/claude/spool.ts";
import { type CodexGate, WITHOUT_ORRERY_QUESTION, WITHOUT_ORRERY_SAID } from "../../src/codex/check.ts";
import { runCodexHook } from "../../src/codex/hooks.ts";
import { CODEX_HOOKS, trustKey } from "../../src/codex/launch.ts";
import { hookShell } from "../../src/codex/shell.ts";
import { cleanEnv, cliCommand, statusOf } from "../claude/support.ts";
import { systemCommand } from "../install/support.ts";
import { tempDir } from "../agent/support.ts";
import { fakeOpenCode } from "../opencode/fake-opencode.ts";
import { codexHomeIn } from "../codex/rollout-lines.ts";

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
		expect(orrery(s.env, s.elsewhere, "agent", "Atlas", "--tool", "claude").stderr).toContain("--tool takes pi, omp, claude-code, codex or opencode (not claude).");
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
		// resume is a session subcommand: Orrery's flags come right after it, then the person's other arguments.
		expect(seen.args?.startsWith("--no-daemon resume --no-daemon -c hooks.SessionStart=")).toBe(true);
		expect(seen.args).toContain(" codex-hook session-start");
		expect(seen.args?.endsWith(" -c features.hooks=true --last")).toBe(true);
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

	// Codex runs hooks in the account's shell when it is bash, zsh or sh, else bash on Linux: $BASH_ENV is bash's.
	it.skipIf(hookShell({ PATH: "/usr/bin:/bin" }).kind !== "bash")("refuses without a terminal when the shell Codex runs the hooks in prints at startup, naming the likely file", () => {
		const s = scene();
		fakeCodex(s, "trusted");
		const chatty = join(s.dir, "bash-env");
		writeFileSync(chatty, 'echo "Welcome back!"\n');
		const r = orrery({ ...s.env, BASH_ENV: chatty }, s.elsewhere, "agent", "Atlas", "--tool", "codex", "--yes");
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(`which prints when it starts (most likely from $BASH_ENV (${chatty})). Codex then can't read the hooks' answers, so Atlas's memory won't load`);
		expect(r.stderr).toContain("Atlas was not opened: only a person at a terminal can choose to start Codex anyway (run orrery agent Atlas there).");
		expect(existsSync(s.out)).toBe(false);
	});

	it("asks about a printing hook shell after the hook check; yes opens Codex as the agent all the same, no opens nothing", async () => {
		const s = scene();
		fakeCodex(s, "trusted");
		for (const [key, value] of Object.entries(s.env)) if (value !== undefined) vi.stubEnv(key, value);
		for (const answer of [true, false]) {
			const said: string[] = [];
			const ran: { codex?: unknown; args: readonly string[]; withoutOrrery?: true }[] = [];
			const io = {
				say: (line: string) => said.push(`say: ${line}`),
				confirm: async (question: string) => (said.push(`confirm: ${question}`), true),
				askPerson: async (question: string) => (said.push(`ask: ${question}`), answer),
			};
			const deps = {
				takeover: async () => { throw new Error("must not take over"); },
				codexGate: async () => ({ ok: false as const, text: "Codex runs Orrery's hooks through /bin/bash -c, which prints when it starts.", noisyShell: true as const, question: "Start Codex anyway?" }),
				run: async (plan: { codex?: unknown; args: readonly string[]; withoutOrrery?: true }) => (ran.push(plan), { code: 0, signal: null }),
			};
			expect(await openAgentCommand(s.config, "Atlas", { tool: "codex", args: ["-x"], cwd: s.elsewhere }, io, deps)).toBe(answer ? 0 : 1);
			expect(said.slice(0, 2)).toEqual(["say: Codex runs Orrery's hooks through /bin/bash -c, which prints when it starts.", "ask: Start Codex anyway?"]);
			if (answer) {
				// As the agent: Orrery's flags, then the person's arguments.
				expect(ran).toHaveLength(1);
				expect(ran[0]?.withoutOrrery).toBeUndefined();
				expect(ran[0]?.args[0]).toBe("--no-daemon");
				expect(ran[0]?.args.at(-1)).toBe("-x");
			} else {
				expect(ran).toEqual([]);
				expect(said.at(-1)).toBe("say: Not opened.");
			}
		}
	});

	it("starts plain Codex on an agent open elsewhere without asking about a second session: it opens no agent", async () => {
		const s = scene();
		fakeCodex(s, "trusted");
		for (const [key, value] of Object.entries(s.env)) if (value !== undefined) vi.stubEnv(key, value);
		// Atlas is open in pi: a live process wrote its status just now.
		mkdirSync(s.agentDir, { recursive: true });
		writeFileSync(join(s.agentDir, "status.json"), JSON.stringify(statusOf("pi")));
		const second = "Atlas is already open in pi. A second session won't record. Launch anyway?";
		for (const hooksLoad of [false, true]) {
			const said: string[] = [];
			const ran: { args: readonly string[]; withoutOrrery?: true }[] = [];
			const io = {
				say: (line: string) => said.push(`say: ${line}`),
				confirm: async (question: string) => (said.push(`confirm: ${question}`), false),
				askPerson: async (question: string) => (said.push(`ask: ${question}`), true),
			};
			const deps = {
				takeover: async () => { throw new Error("must not take over"); },
				codexGate: async () => (hooksLoad ? { ok: true as const } : { ok: false as const, text: "Orrery's hooks don't load in Codex 0.162.1: x." }),
				run: async (plan: { args: readonly string[]; withoutOrrery?: true }) => (ran.push(plan), { code: 0, signal: null }),
			};
			const code = await openAgentCommand(s.config, "Atlas", { tool: "codex", args: ["-x"], cwd: s.elsewhere }, io, deps);
			if (!hooksLoad) {
				// Plain Codex: the hooks question, then Codex, with nothing asked about pi's session.
				expect(code).toBe(0);
				expect(said).toEqual(["say: Orrery's hooks don't load in Codex 0.162.1: x.", `ask: ${WITHOUT_ORRERY_QUESTION}`, `say: ${WITHOUT_ORRERY_SAID}`]);
				expect(ran).toHaveLength(1);
				expect(ran[0]).toMatchObject({ args: ["-x"], withoutOrrery: true });
			} else {
				// As the agent, a second session is asked about first (here: no).
				expect(code).toBe(1);
				expect(said).toEqual([`confirm: ${second}`, "say: Not opened."]);
				expect(ran).toEqual([]);
			}
		}
	});

	it("after Codex ends, says how to resume the session as the agent (Codex's own line reopens it as plain Codex)", async () => {
		const s = scene();
		fakeCodex(s, "trusted");
		for (const [key, value] of Object.entries(s.env)) if (value !== undefined) vi.stubEnv(key, value);
		const session = "01a146c5-9608-7e51-9376-7ac91c238b48";
		// Codex's folder, with the session's rollout, which this process (the Codex) holds open.
		const codexHome = codexHomeIn(s.dir);
		codexHome.begin(session);
		const said: string[] = [];
		const io = { say: (line: string) => said.push(line), confirm: async () => true, askPerson: async () => true };
		/**
		 * A Codex run, this process standing in for a Codex of pid `pid`: its memory server claims the token, and (`prompted`)
		 * its first prompt starts a session.
		 */
		const codexRun = (prompted: boolean, pid = process.pid) => async (plan: LaunchPlan) => {
			claimToken(s.agentDir, plan.env.ORRERY_AGENT_TOKEN as string, pid);
			if (prompted) {
				const hookCtx = {
					config: loadConfig(s.config),
					env: { ...plan.env, CODEX_HOME: codexHome.home },
					home: s.dir,
					codexPid: pid,
					modeWaitMs: 100,
					startHolder: (agent: AgentConfig, sid: string, nonce: string, since: number) => writeMode(agent.dir, sid, { mode: "recording", pid: 1, claudePid: pid, nonce, since }),
				};
				await runCodexHook("session-start", JSON.stringify({ session_id: session, source: "startup" }), hookCtx);
			}
			return { code: 0, signal: null };
		};
		const gate = async () => ({ ok: true as const });
		const open = (run: (plan: LaunchPlan) => Promise<{ code: number; signal: null }>, codexGate: (plan: LaunchPlan) => Promise<CodexGate> = gate, args: string[] = []) =>
			openAgentCommand(s.config, "Atlas", { tool: "codex", args, cwd: s.elsewhere }, io, { takeover: async () => "", run, codexGate });
		expect(await open(codexRun(true))).toBe(0);
		expect(said.at(-1)).toBe(`To continue it as Atlas, with its memory and the guard: orrery agent Atlas --tool codex -- resume ${session}`);
		// Another Codex that ended before it noted a session (quit before a first prompt, or a subcommand that starts none):
		// no line, never a guess such as resume --last, which could reopen another agent's chat as this one.
		for (const args of [[], ["debug", "prompt-input"]]) {
			said.length = 0;
			expect(await open(codexRun(false, 2 ** 22 + 7), gate, args)).toBe(0);
			expect(said.filter((line) => line.startsWith("To continue")), JSON.stringify(args)).toEqual([]);
		}
		// Codex never became the agent, or started as plain Codex: no such line.
		said.length = 0;
		expect(await open(async () => ({ code: 0, signal: null }))).toBe(0);
		expect(said.filter((line) => line.startsWith("To continue"))).toEqual([]);
		expect(await open(codexRun(true), async () => ({ ok: false as const, text: "Orrery's hooks don't load in Codex 0.162.1: x." }))).toBe(0);
		expect(said.filter((line) => line.startsWith("To continue"))).toEqual([]);
		codexHome.close();
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

	it("opens OpenCode with --standalone, the folder, Orrery's plugin and a token file, after the plugin check, once per version", () => {
		const s = scene();
		const fake = fakeOpenCode(join(s.dir, "bin"));
		const home = s.env.ORRERY_HOME as string;
		const inherited = { ...s.env, ORRERY_AGENT: "Other", ORRERY_AGENT_TOKEN: "e".repeat(32) };
		const r = orrery(inherited, s.elsewhere, "agent", "Atlas", "--tool", "opencode", "--", "--continue");
		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toContain("Checking that Orrery's plugin loads in OpenCode 2.0.30…");
		const serve = fake.runs().filter((run) => run.args[0] === "serve");
		const session = fake.runs().filter((run) => run.args[0] === "--standalone");
		expect(serve).toHaveLength(1);
		expect(session).toHaveLength(1);
		const run = session[0]!;
		expect([run.args.length, realpathSync(run.args[1] as string), run.args[2]]).toEqual([3, realpathSync(s.elsewhere), "--continue"]);
		const content = JSON.parse(run.env.OPENCODE_CONFIG_CONTENT as string) as { plugins: { package: string; options: { agent: string; tokenFile: string } }[] };
		const [plugin] = content.plugins;
		// The plugin folder of the Orrery that runs: a release's extensions/opencode, a checkout's src/opencode/plugin.
		expect(plugin?.package).toMatch(/[/](extensions[/]opencode|src[/]opencode[/]plugin)$/);
		expect(plugin?.options.agent).toBe("Atlas");
		expect(plugin?.options.tokenFile.startsWith(join(home, "tokens", "opencode-"))).toBe(true);
		// The check was given the same config content.
		expect(serve[0]?.env.OPENCODE_CONFIG_CONTENT).toBe(run.env.OPENCODE_CONFIG_CONTENT);
		// The token is only in the file (0600, in a 0700 folder), never in OpenCode's environment; no agent variables either.
		const file = run.tokenFile as { mode: number; folderMode: number; text: string };
		expect([file.mode, file.folderMode]).toEqual([0o600, 0o700]);
		expect(file.text).toMatch(/^[0-9a-f]{32}$/);
		expect([run.env.ORRERY_AGENT, run.env.ORRERY_AGENT_TOKEN]).toEqual([undefined, undefined]);
		expect(Object.values(run.env).some((value) => value.includes(file.text))).toBe(false);
		// Once OpenCode exited, the file is gone.
		expect(readdirSync(join(home, "tokens"))).toEqual([]);
		expect(JSON.parse(readFileSync(join(home, "opencode-check.json"), "utf8"))).toMatchObject({ opencode: "2.0.30", ok: true });
		// Verified: the next launch does not ask again. An agent whose tool is opencode opens it without --tool.
		writeFileSync(s.config, readFileSync(s.config, "utf8").replace('tool = "pi"', 'tool = "opencode"'));
		const again = orrery(s.env, s.elsewhere, "agent", "Atlas");
		expect(again.status, again.stderr).toBe(0);
		expect(again.stdout).not.toContain("Checking");
		expect(fake.runs().filter((run) => run.args[0] === "serve")).toHaveLength(1);
		expect(fake.runs().filter((run) => run.args[0] === "--standalone")).toHaveLength(2);
	});

	it("removes OpenCode's token file when orrery is stopped by SIGTERM while OpenCode runs, and dies by the signal", async () => {
		const s = scene();
		const fake = fakeOpenCode(join(s.dir, "bin"), { sessionMs: 30_000 });
		const c = cliCommand(["agent", "Atlas", "--tool", "opencode"]);
		const child = spawn(c.cmd, c.args, { env: s.env, cwd: s.elsewhere, stdio: "ignore" });
		const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => child.on("exit", (code, signal) => done({ code, signal })));
		let session: ReturnType<typeof fake.runs>[number] | undefined;
		for (let i = 0; i < 200 && session === undefined; i++) {
			session = fake.runs().find((run) => run.args[0] === "--standalone");
			if (session === undefined) await new Promise((wait) => setTimeout(wait, 50));
		}
		try {
			expect(session).toBeDefined();
			const tokenFile = (JSON.parse(session?.env.OPENCODE_CONFIG_CONTENT as string) as { plugins: { options: { tokenFile: string } }[] }).plugins[0]?.options.tokenFile as string;
			expect(existsSync(tokenFile)).toBe(true);
			child.kill("SIGTERM");
			expect(await exited).toEqual({ code: null, signal: "SIGTERM" });
			expect(existsSync(tokenFile)).toBe(false);
		} finally {
			child.kill("SIGKILL");
			try {
				if (session !== undefined) process.kill(session.pid, "SIGKILL");
			} catch {
				// gone already
			}
		}
	});

	it("refuses without a terminal when Orrery's plugin doesn't load in OpenCode, --yes or not, and starts nothing", () => {
		const s = scene();
		const fake = fakeOpenCode(join(s.dir, "bin"), { mode: "failed" });
		for (const yes of [[], ["--yes"]]) {
			const r = orrery(s.env, s.elsewhere, "agent", "Atlas", "--tool", "opencode", ...yes);
			expect(r.status).toBe(1);
			expect(r.stderr).toContain(
				"Orrery's plugin doesn't load in OpenCode 2.0.30: OpenCode could not load Orrery's plugin (Error: boom in setup). Without it a session has no memory and no guard. Atlas was not opened: only a person at a terminal can choose to start OpenCode without it (run orrery agent Atlas there).",
			);
		}
		expect(fake.runs().filter((run) => run.args[0] !== "serve" && run.args[0] !== "--version")).toEqual([]);
		expect(JSON.parse(readFileSync(join(s.env.ORRERY_HOME as string, "opencode-check.json"), "utf8"))).toMatchObject({ opencode: "2.0.30", ok: false });
	});

	it("asks about OpenCode's plugin before any launch step; a yes starts plain OpenCode with the person's arguments, not as the agent", async () => {
		const s = scene();
		fakeOpenCode(join(s.dir, "bin"));
		for (const [key, value] of Object.entries(s.env)) if (value !== undefined) vi.stubEnv(key, value);
		const missing = join(s.dir, "not-yet");
		const question = "Start OpenCode without Orrery anyway? The session won't be recorded and the guard will be off.";
		for (const answer of [false, true]) {
			const said: string[] = [];
			const ran: LaunchPlan[] = [];
			const io = {
				say: (line: string) => said.push(`say: ${line}`),
				confirm: async (q: string) => (said.push(`confirm: ${q}`), false),
				askPerson: async (q: string) => (said.push(`ask: ${q}`), answer),
			};
			const deps = {
				takeover: async () => { throw new Error("must not take over"); },
				opencodeGate: async () => ({ ok: false as const, text: "Orrery's plugin doesn't load in OpenCode 2.0.31: x." }),
				codexGate: async () => { throw new Error("must not ask Codex"); },
				run: async (plan: LaunchPlan) => (ran.push(plan), { code: 0, signal: null }),
			};
			expect(await openAgentCommand(s.config, "Atlas", { tool: "opencode", args: ["--continue"], cwd: missing }, io, deps)).toBe(1);
			expect(ran).toEqual([]);
			// The folder it would open in was not made: that step comes after the check.
			expect(existsSync(missing)).toBe(false);
			const first = ["say: Orrery's plugin doesn't load in OpenCode 2.0.31: x.", `ask: ${question}`];
			if (!answer) expect(said).toEqual([...first, "say: Not opened."]);
			// Plain OpenCode: then the folder question (here: no), and nothing about the agent.
			else expect(said).toEqual([...first, "say: Starting OpenCode without Orrery: this session isn't recorded and the guard is off.", `confirm: The folder ${missing} does not exist. Create it?`, "say: Not opened."]);
		}
		const ran: LaunchPlan[] = [];
		const io = { say: () => {}, confirm: async () => true, askPerson: async () => true };
		const deps = { takeover: async () => "", opencodeGate: async () => ({ ok: false as const, text: "x." }), run: async (plan: LaunchPlan) => (ran.push(plan), { code: 0, signal: null }) };
		expect(await openAgentCommand(s.config, "Atlas", { tool: "opencode", args: ["--continue"], cwd: s.elsewhere }, io, deps)).toBe(0);
		expect(ran).toHaveLength(1);
		expect(ran[0]).toMatchObject({ args: ["--continue"], env: {}, unsetEnv: ["ORRERY_AGENT", "ORRERY_AGENT_TOKEN"], withoutOrrery: true });
		expect(ran[0]?.opencode).toBeUndefined();
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
