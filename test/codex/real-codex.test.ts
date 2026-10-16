import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
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

/**
 * A fake model on the Responses API: the first request is answered with one shell call (`echo ran > marker.txt`), every
 * later one with a short message. It keeps each request's body.
 */
async function fakeModel(): Promise<{ readonly port: number; readonly requests: { input?: { type?: string; output?: unknown }[] }[]; close(): void }> {
	const requests: { input?: { type?: string; output?: unknown }[] }[] = [];
	const server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => (body += chunk));
		request.on("end", () => {
			if (!request.url?.endsWith("/responses")) {
				response.writeHead(404).end();
				return;
			}
			requests.push(JSON.parse(body) as (typeof requests)[number]);
			const id = `resp_${requests.length}`;
			const item =
				requests.length === 1
					? { type: "function_call", id: "fc_1", call_id: "call_1", name: "exec_command", arguments: JSON.stringify({ cmd: "echo ran > marker.txt" }) }
					: { type: "message", id: `msg_${requests.length}`, role: "assistant", content: [{ type: "output_text", text: "done" }] };
			const usage = { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 };
			response.writeHead(200, { "content-type": "text/event-stream" });
			for (const event of [{ type: "response.created", response: { id } }, { type: "response.output_item.done", item }, { type: "response.completed", response: { id, usage } }]) {
				response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
			}
			response.end();
		});
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	return { port: (server.address() as AddressInfo).port, requests, close: () => server.close() };
}

/** Runs codex to its end without blocking this process (the fake model answers from it). */
function runCodex(args: readonly string[], env: NodeJS.ProcessEnv): Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }> {
	return new Promise((done) => {
		const child = spawn(codex as string, [...args], { env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
		child.on("close", (status) => {
			clearTimeout(timer);
			done({ status, stdout, stderr });
		});
	});
}

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

	it("keeps Orrery's hooks on when the person's config turned them off in Codex's /hooks screen", async () => {
		const env = isolated("toggled");
		const home = env.CODEX_HOME as string;
		// What a toggle in /hooks leaves in the person's config.toml, for each of Orrery's hooks.
		writeFileSync(join(home, "config.toml"), CODEX_HOOKS.map((hook) => `[hooks.state.${tomlString(trustKey(hook.event))}]\nenabled = false\n`).join("\n"));
		const launch = codexLaunch({ name: "Atlas", dir: mkdtempSync(join(scratch, "agent-")) }, ["/opt/orrery/bin/orrery"]);
		const listing = await listHooks(codex as string, launch.config, { env, home });
		const hooks = ((listing as { result: { data: { hooks: Record<string, unknown>[] }[] } }).result.data[0]?.hooks ?? []).filter((hook) => hook.source === "sessionFlags");
		expect(hooks.map((hook) => [hook.key, hook.trustStatus, hook.enabled]).sort()).toEqual(CODEX_HOOKS.map((hook) => [trustKey(hook.event), "trusted", true]).sort());
		// The same config without Orrery's enabled=true: Codex leaves the hooks off (the case this guards against).
		const at = launch.config.findIndex((word) => word.startsWith("hooks.state="));
		const old = [...launch.config];
		old[at] = (old[at] as string).replaceAll("enabled=true,", "");
		const off = await listHooks(codex as string, old, { env, home });
		expect(((off as { result: { data: { hooks: Record<string, unknown>[] }[] } }).result.data[0]?.hooks ?? []).filter((hook) => hook.source === "sessionFlags").map((hook) => hook.enabled)).toEqual(CODEX_HOOKS.map(() => false));
	}, 60_000);

	it("runs Orrery's hooks in a real session, and a refusal holds even when the hook's shell prints at startup", async () => {
		// Codex runs a hook as `<the account's shell> -c <command>`: bash then reads $BASH_ENV, zsh .zshenv, fish
		// config.fish. Each of these prints here, as a chatty shell setup does, and notes that it was read.
		const orrery = [cliCommand([]).cmd, ...cliCommand([]).args];
		const shell = basename(userInfo().shell ?? "");
		for (const chatty of [false, true]) {
			const env = isolated(chatty ? "chatty" : "quiet");
			const dir = env.HOME as string;
			const cwd = join(dir, "work");
			mkdirSync(cwd);
			const read = join(dir, "startup-read");
			const startup = `echo "Welcome back!"; touch ${shellWords([read])}\n`;
			writeFileSync(join(dir, "bash-env"), startup);
			mkdirSync(join(dir, "zdot"));
			writeFileSync(join(dir, "zdot", ".zshenv"), startup);
			mkdirSync(join(dir, "xdg", "fish"), { recursive: true });
			writeFileSync(join(dir, "xdg", "fish", "config.fish"), startup);
			const model = await fakeModel();
			try {
				const launch = codexLaunch({ name: "Atlas", dir: mkdtempSync(join(scratch, "agent-")) }, orrery);
				const run = await runCodex(
					[
						"exec",
						...launch.config,
						"--skip-git-repo-check",
						"--dangerously-bypass-approvals-and-sandbox",
						"-C",
						cwd,
						"-c",
						`model_providers.fake={name="fake",base_url="http://127.0.0.1:${model.port}/v1",wire_api="responses"}`,
						"-c",
						'model_provider="fake"',
						"-c",
						'model="fake-model"',
						"-c",
						"analytics.enabled=false",
						"run it",
					],
					{ ...env, ...(chatty ? { BASH_ENV: join(dir, "bash-env"), ZDOTDIR: join(dir, "zdot"), XDG_CONFIG_HOME: join(dir, "xdg") } : {}) },
				);
				expect(run.status, run.stderr).toBe(0);
				if (chatty && ["bash", "zsh", "fish"].includes(shell)) expect(existsSync(read)).toBe(true);
				// The guard's refusal reached the model, and the command never ran.
				expect(existsSync(join(cwd, "marker.txt"))).toBe(false);
				const outputs = model.requests.flatMap((request) => request.input ?? []).filter((item) => item.type === "function_call_output").map((item) => String(item.output));
				expect(outputs).toEqual(["Command blocked by PreToolUse hook: Orrery's Codex guard is not built yet. Command: echo ran > marker.txt"]);
			} finally {
				model.close();
			}
		}
	}, 120_000);

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
