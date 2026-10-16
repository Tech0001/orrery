import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readHolder } from "../../src/agent/handover.ts";
import { instructionsSection, readInstructions, writeInstructions } from "../../src/agent/instructions.ts";
import { newToken } from "../../src/agent/pick.ts";
import { listHooks, probeHooks, readCodexCheck } from "../../src/codex/check.ts";
import { CODEX_HOOKS, type CodexEvent, type CodexHook, codexLaunch, shellWords, tomlString, trustHash, trustKey } from "../../src/codex/launch.ts";
import { checkHookShell, hookShell } from "../../src/codex/shell.ts";
import { MemoryStore } from "../../src/memory/index.ts";
import { cliCommand, waitUntil } from "../claude/support.ts";

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
		expect(server.args.slice(-3)).toEqual(["mcp", "--tool", "codex"]);
		if (process.env.ORRERY_TEST_BIN) expect(realpathSync(server.command)).toBe(realpathSync(process.env.ORRERY_TEST_BIN));
		const self = spawnSync(server.command, [...server.args.slice(0, -3), "--version"], { env, encoding: "utf8", timeout: 30_000 });
		expect(self.stdout).toMatch(/^orrery \d+\.\d+\.\d+/);
	}, 90_000);
});

type Item = { type?: string; role?: string; content?: { text?: string }[]; name?: string };
type Request = { input?: Item[]; tools?: { type?: string; name?: string; tools?: { name?: string }[] }[] };

/**
 * A fake model on the Responses API that answers request `n` with `answer(n)`: a reply message, or a shell call that
 * reports `tokens` used (so a low auto-compaction limit compacts the conversation mid-turn). It keeps each request.
 */
async function scriptedModel(answer: (n: number) => { readonly reply: string } | { readonly shell: string; readonly tokens: number }) {
	const requests: Request[] = [];
	const server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => (body += chunk));
		request.on("end", () => {
			if (!request.url?.endsWith("/responses")) {
				response.writeHead(404).end();
				return;
			}
			requests.push(JSON.parse(body) as Request);
			const n = requests.length;
			const id = `resp_${n}`;
			const said = answer(n);
			const item =
				"reply" in said
					? { type: "message", id: `msg_${n}`, role: "assistant", content: [{ type: "output_text", text: said.reply }] }
					: { type: "function_call", id: `fc_${n}`, call_id: `call_${n}`, name: "exec_command", arguments: JSON.stringify({ cmd: said.shell }) };
			const total = "tokens" in said ? said.tokens : 2;
			const usage = { input_tokens: total - 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: total };
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

/** A request's developer messages, as text. */
const developerTexts = (request: Request | undefined) => (request?.input ?? []).filter((item) => item.role === "developer").map((item) => (item.content ?? []).map((part) => part.text ?? "").join(""));
/** Those that Orrery's SessionStart gave (they begin with its status line). */
const orreryContext = (request: Request | undefined) => developerTexts(request).filter((text) => text.startsWith("Orrery · Atlas · "));

describe.skipIf(codex === null)("an agent's session in the installed Codex (scratch homes, a fake model)", () => {
	/** Atlas in a scratch home: its config, folder and data, and the environment `orrery agent --tool codex` gives Codex. */
	function atlas(name: string) {
		const env = isolated(name);
		const home = env.HOME as string;
		const work = join(home, "work");
		mkdirSync(work);
		const config = join(home, "config.toml");
		// Its summary model has no login here: summaries stop, and nothing calls a real model.
		writeFileSync(config, `data_dir = ${JSON.stringify(join(home, "data"))}\n[agents.Atlas]\nfolder = ${JSON.stringify(work)}\ntool = "codex"\ncompactor_model = "openai/gpt-6.1-sol"\n`);
		const agentDir = join(home, "data", "agents", "Atlas");
		const launch = codexLaunch({ name: "Atlas", dir: agentDir }, [cliCommand([]).cmd, ...cliCommand([]).args]);
		const agentEnv: NodeJS.ProcessEnv = { ...env, ORRERY_CONFIG: config, ORRERY_HOME: join(home, "orrery-home"), ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: newToken() };
		return { env: agentEnv, work, agentDir, launch };
	}

	/** `codex exec` as the agent, against the fake model: Orrery's flags, then the session's. */
	const exec = (a: ReturnType<typeof atlas>, port: number, args: readonly string[], extra: readonly string[] = []) =>
		runCodex(
			[
				"exec",
				...a.launch.config,
				"--skip-git-repo-check",
				"--dangerously-bypass-approvals-and-sandbox",
				"-C",
				a.work,
				"-c",
				`model_providers.fake={name="fake",base_url="http://127.0.0.1:${port}/v1",wire_api="responses"}`,
				"-c",
				'model_provider="fake"',
				"-c",
				'model="fake-model"',
				"-c",
				"analytics.enabled=false",
				...extra,
				...args,
			],
			a.env,
		);

	/** The agent's messages, read-only. */
	const memory = (agentDir: string) => {
		const store = MemoryStore.openReadOnly(join(agentDir, "memory.sqlite"));
		try {
			return store.root.map((m) => `${m.kind}: ${m.text}`);
		} finally {
			store.close();
		}
	};
	/** Waits until no holder records the agent: the last session's has finished and left. */
	const settled = (agentDir: string) => waitUntil(() => readHolder(agentDir) === undefined, 30_000);

	it("records each turn into the agent's memory, gives the view as developer context, and a later session sees the earlier one", async () => {
		const a = atlas("session");
		const model = await scriptedModel((n) => ({ reply: `Reply ${n}.` }));
		try {
			const first = await exec(a, model.port, ["Codename Saffron."]);
			expect(first.status, first.stderr).toBe(0);
			// The view came as developer context, right before the prompt: the status line, then the memory section.
			const [context] = orreryContext(model.requests[0]);
			expect(context).toMatch(/^Orrery · Atlas · 0 msgs · recording\n/);
			expect(context).toContain("\n\n# Memory\n\nEarlier conversation reaches you only through the view below.");
			const input = model.requests[0]?.input ?? [];
			expect(input.at(-1)?.content?.[0]?.text).toBe("Codename Saffron.");
			expect(input.at(-2)?.role).toBe("developer");
			// The memory server Codex started is the agent's: its tools are offered to the model.
			const namespace = (model.requests[0]?.tools ?? []).find((tool) => tool.type === "namespace" && tool.name === "mcp__orrery");
			expect(namespace?.tools?.map((tool) => tool.name).sort()).toEqual(["date", "search", "zoom"]);
			await waitUntil(() => memory(a.agentDir).length === 2, 30_000);
			expect(memory(a.agentDir)).toEqual(["user: Codename Saffron.", "talk: Reply 1."]);
			await settled(a.agentDir);
			const second = await exec(a, model.port, ["What was the codename?"]);
			expect(second.status, second.stderr).toBe(0);
			const [later] = orreryContext(model.requests[1]);
			expect(later).toMatch(/^Orrery · Atlas · 2 msgs · recording\n/);
			expect(later).toMatch(/<chat>\n0\+1\|.*\n1\+1\|.*\n<\/chat>$/);
			await waitUntil(() => memory(a.agentDir).length === 4, 30_000);
			expect(memory(a.agentDir).slice(2)).toEqual(["user: What was the codename?", "talk: Reply 2."]);
			await settled(a.agentDir);
		} finally {
			model.close();
		}
	}, 120_000);

	it("gives the view again after Codex compacts, one copy, and not again at resume, which still records", async () => {
		const a = atlas("compact");
		// The first answer asks for a shell call and reports a full context: Codex compacts mid-turn (locally, with the fake
		// model), then SessionStart(compact) runs before the turn goes on.
		const model = await scriptedModel((n) => (n === 1 ? { shell: "echo hi", tokens: 900_000 } : { reply: `Reply ${n}.` }));
		try {
			const run = await exec(a, model.port, ["Codename Juniper."], ["-c", "model_auto_compact_token_limit=100000"]);
			expect(run.status, run.stderr).toBe(0);
			expect(model.requests).toHaveLength(3);
			// Request 2 is the compaction; request 3 the turn going on, with one view: the old one went with the compaction.
			const after = orreryContext(model.requests[2]);
			expect(after).toHaveLength(1);
			expect(after[0]).toMatch(/^Orrery · Atlas · 1 msgs · recording\n/);
			expect(after[0]).toContain("# Memory");
			await waitUntil(() => memory(a.agentDir).length === 2, 30_000);
			expect(memory(a.agentDir)).toEqual(["user: Codename Juniper.", "talk: Reply 3."]);
			await settled(a.agentDir);
			const session = /session id: ([0-9a-f-]{36})/.exec(run.stderr)?.[1];
			expect(session, run.stderr).toBeDefined();
			const resumed = await exec(a, model.port, ["resume", session as string, "And now?"]);
			expect(resumed.status, resumed.stderr).toBe(0);
			// The resumed history brings the view it had; SessionStart(resume) adds none.
			expect(orreryContext(model.requests[3])).toEqual(after);
			await waitUntil(() => memory(a.agentDir).length === 4, 30_000);
			expect(memory(a.agentDir).slice(2)).toEqual(["user: And now?", "talk: Reply 4."]);
			await settled(a.agentDir);
		} finally {
			model.close();
		}
	}, 120_000);

	// Codex runs hooks in the account's shell when it is bash, zsh or sh, else bash on Linux: $BASH_ENV is bash's.
	it.skipIf(hookShell({ PATH: process.env.PATH ?? "" }).kind !== "bash")("a shell setup that prints garbles the hooks' answers: the launch's check sees it first", async () => {
		const a = atlas("chatty");
		const startup = join(a.env.HOME as string, "bash-env");
		writeFileSync(startup, 'echo "Welcome back!"\n');
		const chatty = { ...a, env: { ...a.env, BASH_ENV: startup } };
		// What orrery agent checks before it starts Codex.
		expect(checkHookShell(chatty.env, a.work)).toMatchObject({ quiet: false, source: `$BASH_ENV (${startup})` });
		const model = await scriptedModel((n) => ({ reply: `Reply ${n}.` }));
		try {
			const run = await exec(chatty, model.port, ["Codename Saffron."]);
			expect(run.status, run.stderr).toBe(0);
			const developer = developerTexts(model.requests[0]);
			// SessionStart's answer arrives as raw text after the shell's words, the view inside it as escaped JSON, and the
			// status line never reaches the person; the prompt's hook adds the shell's words to the model's context again.
			expect(orreryContext(model.requests[0])).toEqual([]);
			expect(developer.some((text) => text.startsWith('Welcome back!\n{"systemMessage":"Orrery · Atlas · 0 msgs · recording'))).toBe(true);
			expect(developer).toContain("Welcome back!");
			// The hooks still record.
			await waitUntil(() => memory(a.agentDir).length === 2, 30_000);
			await settled(a.agentDir);
		} finally {
			model.close();
		}
	}, 120_000);
});
