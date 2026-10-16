import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { instructionsSection, readInstructions, writeInstructions } from "../../src/agent/instructions.ts";
import { listHooks, probeHooks, readCodexCheck } from "../../src/codex/check.ts";
import { CODEX_HOOKS, type CodexEvent, type CodexHook, codexLaunch, shellWords, tomlString, trustHash, trustKey } from "../../src/codex/launch.ts";
import { cliCommand } from "../claude/support.ts";

/**
 * The installed Codex itself, asked without a model and without its user's state: every run here has a scratch HOME
 * and CODEX_HOME, and nothing inherited but PATH. Nothing is ever written to the person's ~/.codex.
 */
const scratch = mkdtempSync(join(tmpdir(), "orrery-real-codex-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function isolated(name: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	const home = mkdtempSync(join(scratch, `${name}-`));
	mkdirSync(join(home, "codex-home"));
	return { PATH: process.env.PATH ?? "", HOME: home, CODEX_HOME: join(home, "codex-home"), TERM: "dumb", ORRERY_RELEASES_URL: "http://127.0.0.1:9/releases", ...extra };
}

/** The codex binary: ORRERY_TEST_CODEX, or "codex" on PATH; null when there is none. */
function findCodex(): string | null {
	const works = (path: string) => spawnSync(path, ["--version"], { env: isolated("version"), timeout: 30_000 }).status === 0;
	const wanted = process.env.ORRERY_TEST_CODEX ?? "codex";
	if (wanted.includes("/")) return works(wanted) ? wanted : null;
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (dir !== "" && works(join(dir, wanted))) return join(dir, wanted);
	}
	return null;
}

const codex = findCodex();
const version = codex === null ? "" : (spawnSync(codex, ["--version"], { env: isolated("version"), encoding: "utf8" }).stdout.match(/\d+\.\d+\.\d+\S*/)?.[0] ?? "");

/** `-c hooks.<Event>=…` for each event's groups of hooks, as a person's config would give them. */
function hookFlags(groups: Partial<Record<CodexEvent, { matcher?: string; hooks: CodexHook[] }[]>>): string[] {
	const field = (key: string, value: unknown) => `${key}=${typeof value === "string" ? tomlString(value) : String(value)}`;
	return Object.entries(groups).flatMap(([event, list]) => [
		"-c",
		`hooks.${event}=[${(list ?? []).map((group) => `{${group.matcher === undefined ? "" : `${field("matcher", group.matcher)},`}hooks=[${group.hooks.map((hook) => `{type="command",${Object.entries(hook).map(([key, value]) => field(key, value)).join(",")}}`).join(",")}]}`).join(",")}]`,
	]);
}

describe.skipIf(codex === null)("Orrery's Codex launch against the installed Codex (scratch homes, no model)", () => {
	it("computes every hook's trust value exactly as Codex does (app-server hooks/list, currentHash)", async () => {
		const odd = `'/home/u/my "odd" ü/orrery' codex-hook`;
		const groups: Partial<Record<CodexEvent, { matcher?: string; hooks: CodexHook[] }[]>> = {
			SessionStart: [{ hooks: [{ command: `${odd} session-start`, timeout: 30, additionalContextLimit: 0 }] }, { matcher: "startup|resume", hooks: [{ command: "a", additionalContextLimit: 2500 }] }],
			UserPromptSubmit: [{ matcher: "ignored", hooks: [{ command: `${odd} user-prompt-submit`, timeout: 10, statusMessage: "Recording…" }] }],
			Stop: [{ hooks: [{ command: "b", timeout: 10, additionalContextLimit: 0 }] }],
			SessionEnd: [{ hooks: [{ command: "c", timeout: 3 }, { command: "d", timeout: 30 }, { command: "e" }] }],
			PreToolUse: [{ hooks: [{ command: "f", timeout: 10 }] }, { matcher: "Bash", hooks: [{ command: "g", statusMessage: "Checking" }] }],
			PostToolUse: [{ matcher: "apply_patch", hooks: [{ command: "h", timeout: 5, additionalContextLimit: 100 }] }],
			PreCompact: [{ hooks: [{ command: "i", timeout: 0 }] }],
			PostCompact: [{ hooks: [{ command: "j", additionalContextLimit: 7 }] }],
			SubagentStart: [{ hooks: [{ command: "k", additionalContextLimit: 2500 }] }],
		};
		const listing = await listHooks(codex as string, hookFlags(groups), { env: isolated("hashes") });
		expect(listing.ok, listing.ok ? "" : listing.why).toBe(true);
		const listed = ((listing as { result: { data: { hooks: { key: string; currentHash: string }[] }[] } }).result.data[0]?.hooks ?? []);
		const expected = Object.entries(groups).flatMap(([event, list]) =>
			(list ?? []).flatMap((group, g) => group.hooks.map((hook, h) => ({ key: trustKey(event as CodexEvent, g, h), hash: trustHash(event as CodexEvent, hook, group.matcher) }))),
		);
		expect(listed.map((hook) => ({ key: hook.key, hash: hook.currentHash })).sort((a, b) => a.key.localeCompare(b.key))).toEqual(expected.sort((a, b) => a.key.localeCompare(b.key)));
	}, 60_000);

	it("loads Orrery's own hooks as trusted with the launch's flags, and the check notices when they are not", async () => {
		const dir = mkdtempSync(join(scratch, "agent-"));
		const orrery = [join(scratch, "my orrery", "bin", "orrery")];
		const launch = codexLaunch({ name: "Atlas", dir }, orrery);
		expect(await probeHooks(codex as string, launch.config, { env: isolated("probe") })).toEqual({ ok: true });
		const listing = await listHooks(codex as string, launch.config, { env: isolated("probe-list") });
		const hooks = ((listing as { result: { data: { hooks: Record<string, unknown>[] }[] } }).result.data[0]?.hooks ?? []).filter((hook) => hook.source === "sessionFlags");
		expect(hooks.map((hook) => [hook.eventName, hook.trustStatus, hook.command, hook.timeoutSec]).sort()).toEqual(
			CODEX_HOOKS.map((hook) => [hook.event.replace(/^./, (c) => c.toLowerCase()), "trusted", shellWords([...orrery, "codex-hook", hook.arg]), hook.timeout]).sort(),
		);
		expect(hooks.find((hook) => hook.key === trustKey("SessionStart"))?.additionalContextLimit).toBe(0);
		// Without the trust values Codex would skip every hook: the check says so.
		const at = launch.config.findIndex((word) => word.startsWith("hooks.state="));
		const untrusted = [...launch.config.slice(0, at - 1), ...launch.config.slice(at + 1)];
		expect(await probeHooks(codex as string, untrusted, { env: isolated("probe-untrusted") })).toEqual({ ok: false, why: "Codex does not trust Orrery's SessionStart hook (untrusted)" });
	}, 60_000);

	it("orrery agent --tool codex: the real Codex takes every flag, and the instructions reach the model's input whole", () => {
		const env = isolated("agent");
		const home = env.HOME as string;
		const folder = join(home, "work");
		mkdirSync(folder);
		const config = join(home, "config.toml");
		writeFileSync(config, `data_dir = ${JSON.stringify(join(home, "data"))}\n[agents.Atlas]\nfolder = ${JSON.stringify(folder)}\ntool = "pi"\ncompactor_model = "openai/gpt-6.1-sol"\n`);
		const agentDir = join(home, "data", "agents", "Atlas");
		writeInstructions(agentDir, `Atlas keeps "quotes", back\\slashes, tabs\tand é 中 🙂.\nLine two \u007f ends here.\n`);
		const pathDir = dirname(codex as string);
		const c = cliCommand(["agent", "Atlas", "--tool", "codex", "--", "debug", "prompt-input"]);
		const run = spawnSync(c.cmd, c.args, {
			cwd: folder,
			env: { ...env, PATH: `${pathDir}${delimiter}/usr/bin${delimiter}/bin`, ORRERY_HOME: join(home, ".orrery"), ORRERY_CONFIG: config },
			encoding: "utf8",
			timeout: 60_000,
		});
		expect(run.status, run.stderr).toBe(0);
		const input = JSON.parse(run.stdout.slice(run.stdout.indexOf("["))) as { role?: string; content?: { text?: string }[] }[];
		const developer = input.find((item) => item.role === "developer");
		expect(developer?.content?.[0]?.text).toBe(instructionsSection("Atlas", readInstructions(agentDir) as NonNullable<ReturnType<typeof readInstructions>>));
		// The check ran (this Codex was new to this Orrery home) and is remembered.
		expect(readCodexCheck({ ...env, ORRERY_HOME: join(home, ".orrery") })).toMatchObject({ codex: version, ok: true });
		expect(JSON.parse(readFileSync(join(home, ".orrery", "codex-check.json"), "utf8"))).toMatchObject({ codex: version, ok: true });
		// The memory server as Codex read it: this Orrery's own command (the binary itself, under test:binary), with its variables.
		const mcp = spawnSync(cliCommand([]).cmd, cliCommand(["agent", "Atlas", "--tool", "codex", "--", "mcp", "get", "orrery", "--json"]).args, {
			cwd: folder,
			env: { ...env, PATH: `${pathDir}${delimiter}/usr/bin${delimiter}/bin`, ORRERY_HOME: join(home, ".orrery"), ORRERY_CONFIG: config },
			encoding: "utf8",
			timeout: 60_000,
		});
		expect(mcp.status, mcp.stderr).toBe(0);
		const server = (JSON.parse(mcp.stdout.slice(mcp.stdout.indexOf("{"))) as { transport: { command: string; args: string[]; env_vars: string[] } }).transport;
		expect(server.env_vars).toEqual(["ORRERY_AGENT", "ORRERY_AGENT_TOKEN", "ORRERY_CONFIG", "ORRERY_HOME"]);
		expect(server.args.at(-1)).toBe("mcp");
		if (process.env.ORRERY_TEST_BIN) expect(realpathSync(server.command)).toBe(realpathSync(process.env.ORRERY_TEST_BIN));
		const self = spawnSync(server.command, [...server.args.slice(0, -1), "--version"], { env, encoding: "utf8", timeout: 30_000 });
		expect(self.stdout).toMatch(/^orrery \d+\.\d+\.\d+/);
	}, 90_000);
});
