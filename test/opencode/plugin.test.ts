import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { type AgentConfig, type HarnessConfig, parseConfig } from "../../src/agent/config.ts";
import { FileCredentialStore } from "../../src/agent/credentials.ts";
import { MemoryAgent } from "../../src/agent/memory-agent.ts";
import { agentModelSource } from "../../src/agent/model-source.ts";
import { claimedBy, newToken } from "../../src/agent/pick.ts";
import { writeRequest } from "../../src/agent/settings-request.ts";
import { readStatus } from "../../src/agent/status-file.ts";
import type { SummarySources } from "../../src/agent/summary-sources.ts";
import { memorySection, OPENCODE_READ_ONLY } from "../../src/agent/view-text.ts";
import { MemoryStore, MemoryView } from "../../src/memory/index.ts";
import { type Feed, readFeed } from "../../src/opencode/feed.ts";
import { COMPACTION_SUMMARY, openCodePlugin, type OpenCodePluginOptions, sessionTitle } from "../../src/opencode/plugin.ts";
import { feedFileOf } from "../../src/opencode/token-file.ts";
import { fauxModels, tempDir } from "../agent/support.ts";
import { messages, seed, waitUntil } from "../claude/support.ts";
import { BASE, FakeHost } from "./fake-host.ts";

const dirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The TUI's pid as the plugin is told it. */
const TUI = 4242;

/** Agent Atlas (folder ws, OpenCode), Birch (a reader), a plain folder, and a launch token for Atlas in Orrery's home. */
function scene() {
	const dir = tempDir("orrery-opencode-plugin-");
	dirs.push(dir);
	for (const folder of ["ws", "birch", "plain"]) mkdirSync(join(dir, folder));
	const toml = [
		`data_dir = ${JSON.stringify(join(dir, "data"))}`,
		"[updates]",
		"check = false",
		"[agents.Atlas]",
		`folder = ${JSON.stringify(join(dir, "ws"))}`,
		'tool = "opencode"',
		'compactor_model = "faux-compactor/faux-1"',
		'compactor_thinking = "off"',
		"[agents.Birch]",
		`folder = ${JSON.stringify(join(dir, "birch"))}`,
		'tool = "opencode"',
		'compactor_model = "faux-compactor/faux-1"',
		'compactor_thinking = "off"',
		'reads = ["*"]',
		"",
	].join("\n");
	const config = parseConfig(toml, dir);
	const atlas = config.agents.get("Atlas") as AgentConfig;
	mkdirSync(join(dir, "home", "tokens"), { recursive: true, mode: 0o700 });
	const token = newToken();
	const tokenFile = join(dir, "home", "tokens", "opencode-1-aaaaaaaaaaaa");
	writeFileSync(tokenFile, token, { mode: 0o600 });
	return { dir, config, atlas, token, tokenFile, env: { ORRERY_HOME: join(dir, "home") }, ws: join(dir, "ws"), plain: join(dir, "plain") };
}

/** orrery's summary sources with the faux compactor (it answers forever): no login, no network. */
const fauxSources = (config: HarnessConfig) => async (): Promise<SummarySources> => ({ config, credentials: new FileCredentialStore(join(config.dataDir, "logins.json")), models: fauxModels().models });

/** The plugin set up in `host` (cleaned up after the test); the cleanup is returned too. */
async function start(s: ReturnType<typeof scene>, host: FakeHost, options: OpenCodePluginOptions = {}): Promise<() => Promise<void>> {
	const plugin = openCodePlugin({ config: s.config, env: s.env, owner: process.pid, tui: TUI, summarySources: fauxSources(s.config), tickMs: 30, memoryWaitMs: 2000, log: () => {}, ...options });
	const cleanup = await plugin.setup(host);
	let done = false;
	const once = async () => {
		if (done) return;
		done = true;
		await cleanup();
	};
	cleanups.push(once);
	return once;
}

const hostFor = (s: ReturnType<typeof scene>, directory = s.ws, agent = "Atlas") => new FakeHost({ agent, tokenFile: s.tokenFile }, directory);
const feedOf = (s: ReturnType<typeof scene>): Feed | undefined => readFeed(feedFileOf(s.tokenFile));
const noticesOf = (s: ReturnType<typeof scene>): string[] => feedOf(s)?.notices.map((notice) => notice.text) ?? [];

/** Waits until the plugin's memory has opened (its feed says so). */
const opened = (s: ReturnType<typeof scene>) => waitUntil(() => !(feedOf(s)?.line ?? "opening memory").includes("opening memory"));

describe("Orrery's OpenCode plugin: the agent and its recording", () => {
	it("opens the launch's agent with its token claimed for this OpenCode, records each prompt and final reply, and says so in status.json and the TUI's feed", async () => {
		const s = scene();
		const host = hostFor(s);
		await start(s, host);
		expect(claimedBy(s.atlas.dir, s.token)).toBe(process.pid);
		await opened(s);
		host.open("ses_main");
		await host.prompt("ses_main", "Remember the codeword Saffron-42.");
		host.reply("ses_main", "Noted: Saffron-42.", { steps: 2 });
		await waitUntil(() => messages(s.atlas).length === 2);
		expect(messages(s.atlas)).toEqual(["user: Remember the codeword Saffron-42.", "talk: Noted: Saffron-42."]);
		// Each step's token use (reasoning counted as output); the tool call and the reasoning are not memory.
		const store = MemoryStore.openReadOnly(join(s.atlas.dir, "memory.sqlite"));
		try {
			expect(store.usageRows().map((row) => [row.role, row.model, row.input, row.cacheRead, row.output, row.ok])).toEqual([
				["agent", "fake/fake-model", 900, 100, 25, true],
				["agent", "fake/fake-model", 900, 100, 25, true],
			]);
		} finally {
			store.close();
		}
		await waitUntil(() => feedOf(s)?.line === "Orrery · Atlas · 2 msgs · recording");
		expect(feedOf(s)?.tui).toBe(TUI);
		expect(readStatus(s.atlas.dir)).toMatchObject({ agent: "Atlas", pid: process.pid, open: true, model: "opencode" });
	});

	it("records nothing of a subagent's session; a run that ends without a reply (a compaction) records nothing; a reply goes in once", async () => {
		const s = scene();
		const host = hostFor(s);
		await start(s, host);
		await opened(s);
		host.open("ses_main");
		host.open("ses_sub", "ses_main");
		await host.prompt("ses_sub", "You are a subagent spawned by another session. Say ok.");
		host.reply("ses_sub", "ok");
		await host.prompt("ses_main", "Hello.");
		const id = host.reply("ses_main", "Hi.");
		await waitUntil(() => messages(s.atlas).length === 2);
		// The same run's end seen again, then a compaction's run (no assistant message after it).
		host.emit({ type: "session.execution.succeeded", data: { sessionID: "ses_main" } });
		host.sessions.get("ses_main")?.messages.push({ id: "msg_c", type: "compaction" }, { id: "msg_i", type: "idle", outcome: "succeeded" });
		host.emit({ type: "session.execution.succeeded", data: { sessionID: "ses_main" } });
		await host.prompt("ses_main", "Again.");
		host.reply("ses_main", "Again, hi.");
		await waitUntil(() => messages(s.atlas).length === 4);
		expect(messages(s.atlas)).toEqual(["user: Hello.", "talk: Hi.", "user: Again.", "talk: Again, hi."]);
		expect(id).toMatch(/^msg_/);
		// A prompt OpenCode's hook gave twice (one admission) is one message.
		await host.prompt("ses_main", "Twice?", "msg_twice");
		await host.prompt("ses_main", "Twice?", "msg_twice");
		await waitUntil(() => messages(s.atlas).length === 5);
		expect(messages(s.atlas).at(-1)).toBe("user: Twice?");
		expect(noticesOf(s)).toEqual([]);
	});

	it("records only this location's sessions: a run of a session its hooks never saw is not its reply to record", async () => {
		const s = scene();
		const host = hostFor(s);
		await start(s, host);
		await opened(s);
		host.open("ses_elsewhere");
		host.sessions.get("ses_elsewhere")?.messages.push({ id: "msg_u", type: "user", text: "theirs" });
		host.reply("ses_elsewhere", "Their reply.");
		host.open("ses_main");
		await host.prompt("ses_main", "Mine.");
		host.reply("ses_main", "My reply.");
		await waitUntil(() => messages(s.atlas).length === 2);
		expect(messages(s.atlas)).toEqual(["user: Mine.", "talk: My reply."]);
	});
});

describe("Orrery's OpenCode plugin: the system prompt", () => {
	it("ends it with the instructions, then the memory section: the same bytes on every request of a session and its subagents, made new for a new session and after a compaction", async () => {
		const s = scene();
		mkdirSync(s.atlas.dir, { recursive: true });
		writeFileSync(join(s.atlas.dir, "instructions.md"), "Atlas keeps the map.\n");
		seed(s.atlas, ["An earlier question.", "An earlier answer."]);
		const host = hostFor(s);
		await start(s, host);
		host.open("ses_a");
		await host.prompt("ses_a", "Remember Saffron-42.");
		const first = await host.request("ses_a");
		expect(first[0]).toBe(BASE.text);
		expect(first.slice(1, 2)).toEqual(["# Agent: Atlas\n\nAtlas keeps the map."]);
		expect(first).toHaveLength(3);
		const memory = first[2] as string;
		expect(memory.startsWith("# Memory\n\nEarlier conversation reaches you only through the view below.")).toBe(true);
		expect(memory).toContain("An earlier answer.");
		// The prompt the request answers is in its conversation, not in its memory section too.
		expect(memory).not.toContain("Saffron-42");
		expect(messages(s.atlas)).toContain("user: Remember Saffron-42.");
		expect(memory.endsWith("</chat>")).toBe(true);
		host.reply("ses_a", "Noted: Saffron-42.");
		await waitUntil(() => messages(s.atlas).length === 4);
		// The same session, a tool step later and a turn later; its subagent too: the same bytes.
		expect(await host.request("ses_a")).toEqual(first);
		host.open("ses_a_sub", "ses_a");
		host.open("ses_a_sub_sub", "ses_a_sub");
		expect(await host.request("ses_a_sub")).toEqual(first);
		expect(await host.request("ses_a_sub_sub")).toEqual(first);
		// A second session sees the first's turn.
		host.open("ses_b");
		const second = await host.request("ses_b");
		expect(second[2]).not.toBe(memory);
		expect(second[2]).toContain("Noted: Saffron-42.");
		// A compaction of the first session is answered from memory, with no model request; its parts are made again.
		expect(await host.compaction("ses_a")).toEqual({ summary: COMPACTION_SUMMARY });
		const after = await host.request("ses_a");
		expect(after[2]).toContain("Noted: Saffron-42.");
		expect(await host.request("ses_a")).toEqual(after);
		// A subagent's compaction is OpenCode's own: its turns are not in memory.
		expect(await host.compaction("ses_a_sub")).toBeUndefined();
		expect(noticesOf(s)).toEqual([]);
	});

	it("answers compaction from memory only for its own sessions: one made while it records, or whose first recorded prompt had nothing before it; a resumed one is OpenCode's to compact", async () => {
		const s = scene();
		const host = hostFor(s);
		await start(s, host);
		await opened(s);
		// Made while it records (OpenCode says so on its event stream), whatever came before its first prompt.
		host.open("ses_new");
		host.sessions.get("ses_new")?.messages.push({ id: "msg_n0", type: "synthetic", text: "OpenCode's own note." });
		await host.prompt("ses_new", "New words.");
		// Made before it listened (no event seen), but nothing came before its first prompt.
		host.sessions.set("ses_quiet", { messages: [] });
		await host.prompt("ses_quiet", "Quiet words.");
		// Resumed (`opencode -c`, `-s <id>`): a plain OpenCode session, or one made while another session had the agent.
		host.sessions.set("ses_old", { messages: [{ id: "msg_o1", type: "user", text: "Words memory never had." }, { id: "msg_o2", type: "assistant", content: [{ type: "text", text: "Nor this." }] }] });
		await host.prompt("ses_old", "Resumed words.");
		await waitUntil(() => messages(s.atlas).length === 3);
		expect(await host.compaction("ses_new")).toEqual({ summary: COMPACTION_SUMMARY });
		expect(await host.compaction("ses_quiet")).toEqual({ summary: COMPACTION_SUMMARY });
		expect(await host.compaction("ses_old")).toBeUndefined();
		// Its sessions stay its own after a reload; the resumed one stays OpenCode's.
		await cleanups.splice(0).at(-1)?.();
		const again = hostFor(s);
		await start(s, again);
		await opened(s);
		for (const id of ["ses_new", "ses_quiet", "ses_old"]) again.sessions.set(id, host.sessions.get(id) as { messages: unknown[] });
		expect(await again.compaction("ses_new")).toEqual({ summary: COMPACTION_SUMMARY });
		expect(await again.compaction("ses_quiet")).toEqual({ summary: COMPACTION_SUMMARY });
		expect(await again.compaction("ses_old")).toBeUndefined();
		await again.prompt("ses_old", "More resumed words.");
		expect(await again.compaction("ses_old")).toBeUndefined();
	});

	it("gives the instructions alone when the memory could not be opened, and leaves compaction to OpenCode", async () => {
		const s = scene();
		mkdirSync(s.atlas.dir, { recursive: true });
		writeFileSync(join(s.atlas.dir, "instructions.md"), "Atlas keeps the map.\n");
		const host = hostFor(s);
		const broken = async (): Promise<SummarySources> => {
			throw new Error("no logins here");
		};
		await start(s, host, { summarySources: broken });
		host.open("ses_a");
		expect(await host.request("ses_a")).toEqual([BASE.text, "# Agent: Atlas\n\nAtlas keeps the map."]);
		expect(await host.compaction("ses_a")).toBeUndefined();
		expect(noticesOf(s)).toEqual(["Orrery: Atlas: no logins here; this session runs without memory."]);
		expect(feedOf(s)?.line).toBe("Orrery · Atlas · no memory");
	});

	it("names each session itself, so no title request goes to a model", async () => {
		const s = scene();
		const host = hostFor(s);
		await start(s, host);
		expect(await host.title("ses_a")).toMatch(/^Atlas · \d{4}-\d\d-\d\d \d\d:\d\d$/);
		expect(sessionTitle("Atlas", new Date(2026, 9, 17, 9, 5))).toBe("Atlas · 2026-10-17 09:05");
	});

	it("waits a little for pending summaries before a session's first request, and says when they don't come", async () => {
		const s = scene();
		const host = hostFor(s);
		// A summary model that answers slowly: each summary takes 1.5 s.
		const silent = async (): Promise<SummarySources> => {
			const models = fauxModels();
			models.compactor.setResponses(Array.from({ length: 10 }, () => async () => {
				await new Promise((wait) => setTimeout(wait, 1500));
				return fauxAssistantMessage("user: summarized");
			}));
			return { config: s.config, credentials: new FileCredentialStore(join(s.config.dataDir, "logins.json")), models: models.models };
		};
		seed(s.atlas, ["x".repeat(20_000), "short"]);
		await start(s, host, { summarySources: silent, memoryWaitMs: 300 });
		host.open("ses_a");
		const started = Date.now();
		const parts = await host.request("ses_a");
		expect(Date.now() - started).toBeGreaterThanOrEqual(250);
		expect(parts[1]).toContain("(not summarized yet: zoom it)");
		await waitUntil(() => noticesOf(s).some((text) => text.includes("this session's memory view has unsummarized lines (the model can zoom them)")));
	});
});

describe("Orrery's OpenCode plugin: the memory tools", () => {
	it("adds zoom, date and search, which the model sees directly (not behind Code Mode), over the live memory", async () => {
		const s = scene();
		const host = hostFor(s);
		await start(s, host);
		await opened(s);
		expect(host.tools.map((tool) => tool.name)).toEqual(["zoom", "date", "search"]);
		for (const tool of host.tools) {
			expect(tool.options).toEqual({ codemode: false });
			expect(tool.input).toMatchObject({ type: "object" });
			expect(Object.getOwnPropertySymbols(tool.input)).toEqual([]);
		}
		host.open("ses_a");
		await host.prompt("ses_a", "The codeword is Saffron-42.");
		const tool = (name: string) => host.tools.find((each) => each.name === name) as (typeof host.tools)[number];
		expect((await tool("search").execute({ query: "Saffron" }, {})).content).toContain("Saffron-42");
		expect((await tool("zoom").execute({ id: 0, n: 1 }, {})).content).toBe("0+0|user: The codeword is Saffron-42.");
	});

	it("gives a reader agent the readers' tools too", async () => {
		const s = scene();
		const host = new FakeHost({ agent: "Birch", tokenFile: s.tokenFile }, join(s.dir, "birch"));
		await start(s, host);
		expect(host.tools.map((tool) => tool.name)).toEqual(["zoom", "date", "search", "agents", "agent_memory"]);
	});
});

describe("Orrery's OpenCode plugin: when it can't record", () => {
	it("reads memory but records nothing while another session has the agent, says where, and leaves compaction to OpenCode", async () => {
		const s = scene();
		seed(s.atlas, ["Held question.", "Held answer."]);
		const holder = MemoryAgent.open({ agent: s.atlas, models: agentModelSource(fauxModels().models), report: () => {}, host: "pi" });
		try {
			holder.writeStatus(false);
			const host = hostFor(s);
			await start(s, host);
			await opened(s);
			expect(noticesOf(s)).toEqual(["Orrery: Atlas is open in pi; this session reads memory but is not recorded."]);
			expect(feedOf(s)?.line).toBe("Orrery · Atlas · read-only: open in pi");
			host.open("ses_a");
			await host.prompt("ses_a", "Not recorded.");
			const parts = await host.request("ses_a");
			expect(parts[1]).toContain("Held answer.");
			// The section says so: nothing here goes to memory, and a compaction is OpenCode's own.
			expect(parts[1]).toContain(OPENCODE_READ_ONLY);
			expect(parts[1]).toBe(memorySection(new MemoryView(holder.store, s.atlas.memory.viewBytes), "opencode", { readOnly: true }));
			host.reply("ses_a", "Not recorded either.");
			expect(await host.compaction("ses_a")).toBeUndefined();
			expect((await host.tools.find((tool) => tool.name === "search")?.execute({ query: "Held" }, {}))?.content).toContain("Held answer.");
			await new Promise((wait) => setTimeout(wait, 100));
			expect(holder.store.root.map((m) => m.text)).toEqual(["Held question.", "Held answer."]);
			expect(readStatus(s.atlas.dir)?.model).toBe("pi");
		} finally {
			await holder.close();
		}
	});

	it("refuses a launch token another live process claimed (an OpenCode started from the model's shell inherits the launch's config): it is not the agent by that token", async () => {
		const s = scene();
		await start(s, hostFor(s));
		await opened(s);
		const before = readFileSync(feedFileOf(s.tokenFile), "utf8");
		// Its own process (another pid, alive) in a plain folder: plain OpenCode, no hooks, the launch's feed untouched.
		const nested = hostFor(s, s.plain);
		await start(s, nested, { owner: process.ppid, tui: 999 });
		expect(nested.registered).toBe(false);
		expect(claimedBy(s.atlas.dir, s.token)).toBe(process.pid);
		// In an agent's folder too: only the launch's token makes a session the agent's, never the folder it runs in (a
		// nested OpenCode in another agent's folder would otherwise become that agent's writer).
		const inFolder = hostFor(s, s.ws);
		await start(s, inFolder, { owner: process.ppid, tui: 999 });
		expect(inFolder.registered).toBe(false);
		const birch = hostFor(s, join(s.dir, "birch"));
		await start(s, birch, { owner: process.ppid, tui: 999 });
		expect(birch.registered).toBe(false);
		expect(existsSync(join(s.config.agents.get("Birch")?.dir as string, "memory.sqlite"))).toBe(false);
		expect(messages(s.atlas)).toEqual([]);
		expect(readFileSync(feedFileOf(s.tokenFile), "utf8")).toBe(before);
	});

	it("runs without memory, saying why, for a token file it can't read, a malformed token, or an agent the config doesn't have", async () => {
		for (const [what, prepare, expected] of [
			["unreadable", (s: ReturnType<typeof scene>) => rmSync(s.tokenFile), /^Orrery: the launch token for Atlas could not be read \(.*\); this session runs without memory\.$/],
			["malformed", (s: ReturnType<typeof scene>) => writeFileSync(s.tokenFile, "not-a-token"), /^Orrery: the launch token for Atlas is not one Orrery made; this session runs without memory\.$/],
		] as const) {
			const s = scene();
			prepare(s);
			const host = hostFor(s);
			await start(s, host);
			expect(host.registered, what).toBe(false);
			expect(noticesOf(s), what).toEqual([expect.stringMatching(expected)]);
			expect(feedOf(s)?.line).toBe("Orrery · no memory");
		}
		const s = scene();
		const host = hostFor(s, s.plain, "Nobody");
		await start(s, host);
		expect(host.registered).toBe(false);
		expect(noticesOf(s)).toEqual(["Orrery: Nobody is not an agent in Orrery's config; this session runs without memory."]);
	});

	it("reads a token file only in Orrery's tokens folder, named as the launcher names one: a config naming another (a project's opencode.json can) gets plain OpenCode, and nothing is written beside it", async () => {
		const s = scene();
		const theirs = join(s.dir, "repo");
		mkdirSync(theirs);
		const elsewhere = [
			join(theirs, "opencode-1-aaaaaaaaaaaa"),
			join(s.dir, "home", "opencode-1-aaaaaaaaaaaa"),
			join(s.dir, "home", "tokens", "token"),
			join(s.dir, "home", "tokens", "opencode-1-aaaaaaaaaaaa.feed.json"),
			join(s.dir, "home", "tokens", "..", "tokens-x", "opencode-1-aaaaaaaaaaaa"),
		];
		for (const tokenFile of elsewhere) {
			mkdirSync(join(tokenFile, ".."), { recursive: true });
			writeFileSync(tokenFile, newToken(), { mode: 0o600 });
			const lines: string[] = [];
			const host = new FakeHost({ agent: "Atlas", tokenFile }, s.ws);
			await start(s, host, { log: (line) => lines.push(line) });
			expect(host.registered, tokenFile).toBe(false);
			expect(lines.at(-1), tokenFile).toBe("Orrery: the plugin's token file is not one Orrery's launch wrote; this session runs without memory.");
			expect(readdirSync(join(tokenFile, "..")).filter((name) => name.endsWith(".feed.json") && !name.startsWith("opencode-1-aaaaaaaaaaaa.feed.json.")), tokenFile).toEqual(tokenFile.endsWith(".feed.json") ? ["opencode-1-aaaaaaaaaaaa.feed.json"] : []);
		}
		// Nor through a link put in place of the tokens folder.
		const linked = join(s.dir, "linked");
		mkdirSync(join(linked, "real"), { recursive: true });
		symlinkSync(join(linked, "real"), join(linked, "tokens"));
		writeFileSync(join(linked, "real", "opencode-1-aaaaaaaaaaaa"), newToken(), { mode: 0o600 });
		const host = new FakeHost({ agent: "Atlas", tokenFile: join(linked, "tokens", "opencode-1-aaaaaaaaaaaa") }, s.ws);
		await start(s, host, { env: { ORRERY_HOME: linked } });
		expect(host.registered).toBe(false);
		expect(readdirSync(join(linked, "real"))).toEqual(["opencode-1-aaaaaaaaaaaa"]);
		// No memory was opened, so none was made.
		expect(existsSync(join(s.atlas.dir, "memory.sqlite"))).toBe(false);
	});

	it("does nothing without its options (a plugin entry Orrery didn't write)", async () => {
		const s = scene();
		const lines: string[] = [];
		const host = new FakeHost({}, s.ws);
		await start(s, host, { log: (line) => lines.push(line) });
		expect(host.registered).toBe(false);
		expect(lines).toEqual(["Orrery: loaded without an agent (no agent named in the plugin's options)."]);
	});

	it("never fails a turn: a hook whose work fails says so once, and the request, prompt, compaction and reply go on", async () => {
		const s = scene();
		const host = hostFor(s);
		await start(s, host);
		await opened(s);
		host.failing = { get: true, context: true };
		expect(await host.request("ses_x")).toEqual([BASE.text]);
		expect(await host.request("ses_x")).toEqual([BASE.text]);
		await host.prompt("ses_x", "Lost words.");
		expect(await host.compaction("ses_x")).toBeUndefined();
		host.failing = { context: true };
		host.open("ses_y");
		await host.prompt("ses_y", "Kept words.");
		host.reply("ses_y", "Lost reply.");
		await waitUntil(() => noticesOf(s).length === 4);
		expect(noticesOf(s)).toEqual([
			"Orrery: the memory for this request failed (session service unavailable); the session goes on without it.",
			"Orrery: recording a prompt failed (session service unavailable); the session goes on without it.",
			"Orrery: answering the compaction from memory failed (session service unavailable); the session goes on without it.",
			"Orrery: recording a reply failed (context unavailable); the session goes on without it.",
		]);
		expect(messages(s.atlas)).toEqual(["user: Kept words."]);
	});
});

describe("Orrery's OpenCode plugin: its life in OpenCode's server", () => {
	it("releases the writer lock at cleanup, so a reload (cleanup, then setup in the same process) opens the agent again", async () => {
		const s = scene();
		const first = hostFor(s);
		const cleanup = await start(s, first);
		await opened(s);
		await cleanup();
		expect(readStatus(s.atlas.dir)).toMatchObject({ open: false, model: "opencode" });
		const second = hostFor(s);
		await start(s, second);
		await waitUntil(() => feedOf(s)?.line.endsWith("· recording") === true);
		second.open("ses_a");
		await second.prompt("ses_a", "After the reload.");
		await waitUntil(() => messages(s.atlas).length === 1);
		expect(claimedBy(s.atlas.dir, s.token)).toBe(process.pid);
	});

	it("records a prompt that comes while it is still registering its hooks: the memory is opening by then", async () => {
		const s = scene();
		const host = hostFor(s);
		host.open("ses_early");
		// The last registration step lets a prompt run to its end first, as OpenCode may while setup goes on.
		const transform = host.tool.transform;
		host.tool.transform = async (callback) => {
			await host.prompt("ses_early", "Early words.");
			return transform(callback);
		};
		await start(s, host);
		await waitUntil(() => messages(s.atlas).length === 1);
		expect(messages(s.atlas)).toEqual(["user: Early words."]);
	});

	it("takes a summary-model change made from outside (Orrery's TUI) on its next tick, and says so", async () => {
		const s = scene();
		const host = hostFor(s);
		await start(s, host);
		await opened(s);
		writeRequest(s.atlas.dir, { agent: "Atlas", kind: "compactor", args: "faux-compactor/faux-1 low", at: Date.now() });
		await waitUntil(() => noticesOf(s).some((text) => text.endsWith("(changed from outside OpenCode)")));
		expect(noticesOf(s)).toEqual(["Orrery: summaries: faux-compactor/faux-1 (low) · set in chat (changed from outside OpenCode)"]);
	});

	it("says an Orrery update under the session once, in the TUI's feed", async () => {
		const s = scene();
		const home = join(s.dir, "orrery-home");
		mkdirSync(join(home, "app", "0.9.0"), { recursive: true });
		writeFileSync(join(home, "app", "0.9.0", "VERSION"), "0.9.0\n");
		const { symlinkSync } = await import("node:fs");
		symlinkSync(join(home, "app", "0.9.0"), join(home, "app", "current"));
		const host = hostFor(s);
		await start(s, host, { updates: { env: { ORRERY_HOME: home }, running: () => "0.8.0" } });
		await waitUntil(() => noticesOf(s).length > 0);
		await new Promise((wait) => setTimeout(wait, 100));
		expect(noticesOf(s)).toEqual(["Orrery was updated to 0.9.0; restart this session to use it."]);
	});
});

describe("Orrery's OpenCode plugin: the guard", () => {
	const SENSITIVE = /^Orrery guard: .*sensitive/;
	const OUTSIDE = /^Orrery guard: .*outside this agent's folder and allowed roots/;

	it("judges every tool call by the launch's agent's rules, its folder and allowed roots, and every permission a tool asks for", async () => {
		const s = scene();
		const host = hostFor(s);
		await start(s, host);
		expect(host.guarded).toBe(true);
		expect(await host.call("read", { path: "~/.ssh/id_ed25519" })).toMatch(SENSITIVE);
		expect(await host.call("shell", { command: "cat .env" })).toMatch(SENSITIVE);
		expect(await host.call("write", { path: "notes.md", content: "x" })).toBeUndefined();
		// Outside its folder and allowed roots (by default the folder's parent).
		expect(await host.call("write", { path: join(s.plain, "x.md"), content: "x" })).toBeUndefined();
		expect(await host.call("write", { path: "/opt/elsewhere/x.md", content: "x" })).toMatch(OUTSIDE);
		expect(await host.call("patch", { patchText: "*** Begin Patch\n*** Add File: /opt/elsewhere/x.md\n+x\n*** End Patch" })).toMatch(OUTSIDE);
		expect(await host.call("shell", { command: "ls", workdir: s.ws })).toBeUndefined();
		// Its own memory tools are judged like any tool, and let through.
		expect(await host.call("search", { query: "Saffron" })).toBeUndefined();
		// The second layer: what a tool asks leave for, as OpenCode placed it.
		expect(await host.ask("edit", ["notes.md"])).toEqual({ effect: "allow" });
		expect(await host.ask("edit", ["/opt/elsewhere/x.md"])).toEqual({ effect: "deny", message: expect.stringMatching(OUTSIDE) });
		expect(await host.ask("read", [join(s.dir, "data", "agents", "Atlas", "memory.sqlite")], "ask")).toEqual({ effect: "deny", message: expect.stringMatching(SENSITIVE) });
	});

	it("keeps the guard, with no agent's rules (writes only where it runs), in a session that is no agent's", async () => {
		const cases: [string, (s: ReturnType<typeof scene>) => { host: FakeHost; options?: OpenCodePluginOptions }][] = [
			["no options", (s) => ({ host: new FakeHost({}, s.plain) })],
			["a token file not the launch's", (s) => ({ host: new FakeHost({ agent: "Atlas", tokenFile: join(s.dir, "elsewhere-token") }, s.plain) })],
			[
				"a token it can't read",
				(s) => {
					rmSync(s.tokenFile);
					return { host: hostFor(s, s.plain) };
				},
			],
			["an agent the config doesn't have", (s) => ({ host: hostFor(s, s.plain, "Nobody") })],
			["a token another live process holds", (s) => ({ host: hostFor(s, s.plain), options: { owner: process.ppid, tui: 999 } })],
		];
		for (const [what, make] of cases) {
			const s = scene();
			if (what === "a token another live process holds") await start(s, hostFor(s));
			const { host, options } = make(s);
			await start(s, host, options);
			expect(host.guarded, what).toBe(true);
			expect(host.registered, what).toBe(false);
			expect(await host.call("read", { path: "~/.ssh/id_ed25519" }), what).toMatch(SENSITIVE);
			expect(await host.call("write", { path: "x.md", content: "x" }), what).toBeUndefined();
			expect(await host.call("write", { path: join(s.ws, "x.md"), content: "x" }), what).toMatch(OUTSIDE);
			// Every agent's view is another's.
			expect(await host.call("read", { path: join(s.ws, ".orrery", "view.md") }), what).toMatch(SENSITIVE);
		}
	});

	it("refuses every call when Orrery's config can't be read, and says so", async () => {
		const s = scene();
		const broken = join(s.dir, "broken.toml");
		writeFileSync(broken, "[agents.Atlas\n");
		const host = hostFor(s);
		await start(s, host, { config: undefined, env: { ...s.env, ORRERY_CONFIG: broken } });
		expect(await host.call("websearch", { query: "x" })).toMatch(/^Orrery guard: Orrery's config could not be read \(.*\), so no call can be checked; nothing was run\. Fix the config file\.$/);
		expect(await host.ask("read", ["a.ts"])).toMatchObject({ effect: "deny" });
		expect(noticesOf(s)).toEqual([expect.stringMatching(/^Orrery: Orrery's config could not be read \(.*\); this session runs without memory, and its guard refuses every tool call\.$/)]);
		// Without its options too.
		const plain = new FakeHost({}, s.plain);
		await start(s, plain, { config: undefined, env: { ...s.env, ORRERY_CONFIG: broken } });
		expect(await plain.call("read", { path: "a.ts" })).toMatch(/Orrery's config could not be read/);
	});

	it("refuses every call when it fails before its rules are set, saying why", async () => {
		const s = scene();
		const config = Object.create(s.config, {
			agents: {
				get() {
					throw new Error("a broken config");
				},
			},
		}) as HarnessConfig;
		const lines: string[] = [];
		const host = hostFor(s);
		await start(s, host, { config, log: (line) => lines.push(line) });
		expect(lines.at(-1)).toBe("Orrery: the plugin could not start: a broken config");
		expect(await host.call("read", { path: "a.ts" })).toBe("Orrery guard: Orrery's plugin could not start (a broken config), so no call can be checked; nothing was run.");
	});

	it("fails to load when OpenCode won't take its guard's hook, so no session runs with Orrery and without it", async () => {
		const s = scene();
		const host = hostFor(s);
		host.missing = { toolHook: true };
		const plugin = openCodePlugin({ config: s.config, env: s.env, owner: process.pid, tui: TUI, summarySources: fauxSources(s.config), log: () => {} });
		await expect(plugin.setup(host)).rejects.toThrow("no tool hook execute.before");
		expect(host.registered).toBe(false);
		expect(existsSync(join(s.atlas.dir, "memory.sqlite"))).toBe(false);
	});

	it("says so when the second layer (OpenCode's permission check) can't be added, and judges every call all the same", async () => {
		const s = scene();
		const host = hostFor(s);
		host.permission = undefined;
		const lines: string[] = [];
		await start(s, host, { log: (line) => lines.push(line) });
		expect(lines).toContain("Orrery: the guard's second layer (OpenCode's permission check) could not be added (this OpenCode has no permission hooks); every tool call is still judged.");
		expect(await host.call("read", { path: "~/.ssh/id_ed25519" })).toMatch(SENSITIVE);
	});

	it("answers a call it can't judge in its time with a refusal (OpenCode would wait on the hook forever)", async () => {
		const s = scene();
		const host = hostFor(s);
		// A guard with no time at all: whatever the call, it is late.
		await start(s, host, { guardMs: 0 });
		expect(await host.call("read", { path: "a.ts" })).toBe("Orrery guard: this call could not be checked in time; nothing was run.");
	});
});
