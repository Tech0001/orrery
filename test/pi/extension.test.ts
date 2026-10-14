import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INSTRUCTIONS_MAX_BYTES, writeInstructions } from "../../src/agent/instructions.ts";
import { newToken } from "../../src/agent/pick.ts";
import { MemoryStore } from "../../src/memory/index.ts";
import { FAUX_SUMMARY } from "./harness.ts";
import { ageVisitMarks, cleanup, close, isolatedHome, lastAgent, pi, plainPi, summarySourcesFor, world } from "./world.ts";

afterEach(cleanup);
isolatedHome();

const memoryOf = (root: string, agent = "Atlas") => {
	const store = MemoryStore.openReadOnly(join(root, "data", "agents", agent, "memory.sqlite"));
	const rows = store.root.map((m) => `${m.kind}: ${m.text}`);
	store.close();
	return rows;
};
/** A session's owner record (src/agent/session-owner.ts): named by the id's sha256. */
const ownerRecord = (root: string, id: string) => join(root, "data", "session-owners", createHash("sha256").update(id).digest("hex"));
const lastReply = (messages: readonly { role: string; content?: unknown }[]) =>
	JSON.stringify(messages.filter((m) => m.role === "assistant").at(-1)?.content);

describe("orrery inside pi", () => {
	it("opens the agent's memory in an agent folder, writes status, and registers the memory tools", async () => {
		const { root, config } = world();
		const run = await pi(root, join(root, "agent-Atlas"), config);
		expect(existsSync(join(root, "data", "agents", "Atlas", "memory.sqlite"))).toBe(true);
		const status = JSON.parse(readFileSync(join(root, "data", "agents", "Atlas", "status.json"), "utf8"));
		expect(status).toMatchObject({ agent: "Atlas", busy: false, compactor: { stopped: false } });
		expect(run.status("orrery")).toBe("Orrery · Atlas · 0 msgs");
		expect(run.tool("zoom")).toBeDefined();
	});

	it("does nothing outside an agent folder", async () => {
		const { root, config } = world();
		const run = await pi(root, join(root, "plain"), config);
		expect(existsSync(join(root, "data", "agents"))).toBe(false);
		expect(run.tool("zoom")).toBeUndefined();
		expect(run.notices).toEqual([]);
	});

	it("gives a second pi on the same agent no memory and no tools", async () => {
		const { root, config } = world();
		await pi(root, join(root, "agent-Atlas"), config);
		const second = await pi(root, join(root, "agent-Atlas"), config);
		expect(second.tool("zoom")).toBeUndefined();
		expect(second.notices).toContainEqual({ message: "Atlas is already open in another pi; this one runs without memory.", type: "warning" });
	});

	it("keeps the guard for a pi that runs without memory (agent held, or its memory unreadable)", async () => {
		const { root, config } = world();
		const escape = `${root}-escape.txt`; // outside the agent's allowed roots (the folder's parent folder)
		const tryWrite = async (run: Awaited<ReturnType<typeof pi>>) => {
			run.setResponses([fauxAssistantMessage([fauxToolCall("write", { path: escape, content: "x" })]), fauxAssistantMessage("done")]);
			await run.session.prompt("write it");
			const results = run.session.messages.filter((m: { role: string }) => m.role === "toolResult") as { content: { text?: string }[] }[];
			return results.at(-1)?.content.map((c) => c.text ?? "").join("");
		};
		try {
			const first = await pi(root, join(root, "agent-Atlas"), config);
			const second = await pi(root, join(root, "agent-Atlas"), config);
			expect(second.notices).toContainEqual({ message: "Atlas is already open in another pi; this one runs without memory.", type: "warning" });
			expect(await tryWrite(second)).toMatch(/outside this agent's folder/);
			expect(existsSync(escape)).toBe(false);
			await close(second);
			await close(first);
			writeFileSync(join(root, "data", "agents", "Atlas", "memory.sqlite"), "not a database, and long enough to be read as one");
			const broken = await pi(root, join(root, "agent-Atlas"), config);
			expect(broken.tool("zoom")).toBeUndefined();
			expect(broken.notices).toContainEqual({ message: expect.stringMatching(/^Orrery: Atlas: .*; this pi runs without memory\.$/), type: "warning" });
			expect(await tryWrite(broken)).toMatch(/outside this agent's folder/);
			expect(existsSync(escape)).toBe(false);
		} finally {
			rmSync(escape, { force: true });
		}
	});

	it("opens an agent whose summary model is unknown with memory and logging, says why summaries are off, and /compactor starts them", async () => {
		const { root, config } = world({ compactorModel: "nobody/nothing" });
		const run = await pi(root, join(root, "agent-Atlas"), config, undefined, { memoryWaitMs: 10_000 });
		expect(run.tool("zoom")).toBeDefined();
		expect(run.status("orrery")).toBe("Orrery · Atlas · 0 msgs · SUMMARIES STOPPED: unknown model nobody/nothing");
		expect(run.notices.filter((n) => n.type === "warning" && n.message.includes("unknown model nobody/nothing"))).toHaveLength(1);
		run.setResponses([fauxAssistantMessage("Read."), fauxAssistantMessage("Here.")]);
		await run.session.prompt(`A long first message ${"detail ".repeat(200)}`);
		const started = Date.now();
		await run.session.prompt("Are you there?");
		expect(Date.now() - started).toBeLessThan(2000);
		expect(lastAgent().store.root.map((m) => m.kind)).toEqual(["user", "talk", "user", "talk"]);
		expect(run.status("orrery")).toBe("Orrery · Atlas · 4 msgs · SUMMARIES STOPPED: unknown model nobody/nothing");
		await run.session.prompt("/memory");
		expect(run.notices.at(-1)?.message).toContain("STOPPED: unknown model nobody/nothing");
		// The first answer is the test call /compactor makes before it switches.
		run.setSummaryResponses([fauxAssistantMessage("OK"), fauxAssistantMessage("A long first message, summarized.")]);
		await run.session.prompt(`/compactor ${FAUX_SUMMARY.provider}/${FAUX_SUMMARY.model}`);
		expect(run.notices.at(-1)).toEqual({ message: `summaries: ${FAUX_SUMMARY.provider}/${FAUX_SUMMARY.model} (off) · set in chat`, type: "info" });
		await vi.waitFor(() => expect(lastAgent().view.settled).toBe(true));
		expect(lastAgent().view.render()).toContain("A long first message, summarized.");
		expect(lastAgent().statusLine()).toBe("Orrery · Atlas · 4 msgs");
	}, 20_000);

	it("warns when the orrery config cannot be read, and runs without memory", async () => {
		const { root } = world();
		const saved = process.env.ORRERY_CONFIG;
		try {
			const broken = join(root, "broken.toml");
			writeFileSync(broken, "agents = [");
			process.env.ORRERY_CONFIG = broken;
			const run = await pi(root, join(root, "agent-Atlas"), undefined);
			expect(run.tool("zoom")).toBeUndefined();
			expect(run.notices).toHaveLength(1);
			expect(run.notices[0].type).toBe("warning");
			expect(run.notices[0].message).toMatch(new RegExp(`^Orrery: ${broken}: config is not valid TOML.*; running without memory$`, "s"));
			process.env.ORRERY_CONFIG = join(root, "missing.toml");
			const missing = await pi(root, join(root, "agent-Atlas"), undefined);
			expect(missing.notices.map((n) => n.message)).toEqual([expect.stringMatching(/^Orrery: .*missing\.toml: ENOENT.*; running without memory$/)]);
		} finally {
			if (saved === undefined) delete process.env.ORRERY_CONFIG;
			else process.env.ORRERY_CONFIG = saved;
		}
	});

	it("keeps running when the status file cannot be written, warns once, and still releases the agent", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		try {
			const { root, config } = world();
			const status = join(root, "data", "agents", "Atlas", "status.json");
			const run = await pi(root, join(root, "agent-Atlas"), config);
			rmSync(status);
			mkdirSync(status); // Renaming the new status over a directory fails.
			vi.advanceTimersByTime(20_000);
			expect(run.notices.filter((n) => n.message.startsWith("Orrery: status"))).toHaveLength(1);
			await close(run);
			const next = await pi(root, join(root, "agent-Atlas"), config);
			expect(next.tool("zoom")).toBeDefined();
			expect(next.notices.some((n) => n.message.includes("already open"))).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("still gives a message its memory view when copying the session into memory fails", async () => {
		const { root, config } = world();
		const run = await pi(root, join(root, "agent-Atlas"), config);
		let system = "";
		run.setResponses([
			fauxAssistantMessage("Noted."),
			(context: { systemPrompt?: string; messages: { role: string; content: unknown }[] }) => {
				system = [context.systemPrompt ?? "", ...context.messages.filter((m) => m.role === "system").map((m) => JSON.stringify(m.content))].join("\n");
				return fauxAssistantMessage("Here.");
			},
		]);
		await run.session.prompt("The codename is Cedar.");
		lastAgent().view.appendBatch = () => {
			throw new Error("disk full");
		};
		await run.session.executeBash("echo new-entry"); // something for before_agent_start to copy
		await run.session.prompt("What is the codename?");
		expect(system).toContain("# Memory");
		expect(system).toContain("The codename is Cedar.");
		expect(run.notices).toContainEqual({ type: "warning", message: "Orrery: logging this session into memory failed: disk full" });
	});

	it("marks the agent closed in its status even when the copy at shutdown fails", async () => {
		const { root, config } = world();
		const run = await pi(root, join(root, "agent-Atlas"), config);
		lastAgent().view.appendBatch = () => {
			throw new Error("disk full");
		};
		await run.session.executeBash("echo new-entry");
		await close(run);
		const status = JSON.parse(readFileSync(join(root, "data", "agents", "Atlas", "status.json"), "utf8"));
		expect(status.open).toBe(false);
		expect(run.notices.some((n) => n.message.includes("at shutdown failed: disk full"))).toBe(true);
	});

	it("releases the agent even when its compactor fails to close", async () => {
		const { root, config } = world();
		const run = await pi(root, join(root, "agent-Atlas"), config);
		const compactor = lastAgent().compactor;
		const closeCompactor = compactor.close.bind(compactor);
		compactor.close = async () => {
			await closeCompactor();
			throw new Error("compactor close failed");
		};
		await close(run);
		const next = await pi(root, join(root, "agent-Atlas"), config);
		expect(next.tool("zoom")).toBeDefined();
	});

	it("copies a fork's inherited history once and what is said after the fork once", async () => {
		const { root, config } = world();
		const run = await pi(root, join(root, "agent-Atlas"), config);
		run.setResponses([fauxAssistantMessage("Noted."), fauxAssistantMessage("Teal.")]);
		await run.session.prompt("The codename is Cedar.");
		const parent = run.session.sessionId;
		await run.runtime.fork(run.session.sessionManager.getLeafId() as string, { position: "at" });
		expect(run.session.sessionId).not.toBe(parent);
		expect(lastAgent().store.root.map((m) => `${m.kind}: ${m.text}`)).toEqual(["user: The codename is Cedar.", "talk: Noted."]);
		await run.session.prompt("And the color?");
		await close(run);
		expect(memoryOf(root)).toEqual(["user: The codename is Cedar.", "talk: Noted.", "user: And the color?", "talk: Teal."]);
	});

	it("treats a session started as a fork of another (pi --fork) like a fork", async () => {
		const { root, config } = world();
		const run = await pi(root, join(root, "agent-Atlas"), config);
		run.setResponses([fauxAssistantMessage("Noted.")]);
		await run.session.prompt("The codename is Cedar.");
		const source = run.session.sessionFile as string;
		await close(run);
		const forked = await pi(root, join(root, "agent-Atlas"), config, { forkFrom: source });
		expect(forked.session.sessionManager.getHeader()?.parentSession).toBe(source);
		expect(lastAgent().store.root.map((m) => `${m.kind}: ${m.text}`)).toEqual(["user: The codename is Cedar.", "talk: Noted."]);
	});

	it("summarizes with its own faux model, so summaries never take the agent's replies", async () => {
		const { root, config } = world();
		const run = await pi(root, join(root, "agent-Atlas"), config);
		const summary = () => fauxAssistantMessage("Codename Cedar, padded.");
		run.setSummaryResponses([summary(), summary(), summary()]);
		run.setResponses([fauxAssistantMessage("Noted."), fauxAssistantMessage("Cedar.")]);
		await run.session.prompt(`The codename is Cedar. ${"Padding. ".repeat(100)}`);
		// The fork copies the long message into memory, and the compactor summarizes it.
		await run.runtime.fork(run.session.sessionManager.getLeafId() as string, { position: "at" });
		await vi.waitFor(() => expect(lastAgent().view.settled).toBe(true));
		expect(lastAgent().view.render()).toContain("Codename Cedar, padded.");
		await run.session.prompt("What is the codename?");
		expect(lastReply(run.session.messages)).toContain("Cedar.");
	});
});

describe("an agent named by ORRERY_AGENT", () => {
	const writeTo = async (run: Awaited<ReturnType<typeof pi>>, path: string) => {
		run.setResponses([fauxAssistantMessage([fauxToolCall("write", { path, content: "x" })]), fauxAssistantMessage("done")]);
		await run.session.prompt(`write ${path}`);
	};

	it("opens in a folder outside its folder, writes there, and nowhere outside it and its allowed roots", async () => {
		const { root, config } = world();
		const outside = mkdtempSync(join(tmpdir(), "orrery-outside-"));
		try {
			const run = await pi(root, outside, config, undefined, { env: { ORRERY_AGENT: "Atlas" } });
			expect(run.status("orrery")).toBe("Orrery · Atlas · 0 msgs");
			await writeTo(run, join(outside, "notes.md"));
			expect(readFileSync(join(outside, "notes.md"), "utf8")).toBe("x");
			await writeTo(run, `${outside}-escape.txt`);
			expect(existsSync(`${outside}-escape.txt`)).toBe(false);
			expect(memoryOf(root)[0]).toBe(`user: write ${join(outside, "notes.md")}`);
		} finally {
			rmSync(outside, { recursive: true, force: true });
			rmSync(`${outside}-escape.txt`, { force: true });
		}
	});

	it("in another agent's folder: that agent is neither opened nor held, and a session there by folder still gets it", async () => {
		const { root, config } = world();
		const atlas = await pi(root, join(root, "agent-Birch"), config, undefined, { env: { ORRERY_AGENT: "Atlas" } });
		expect(atlas.status("orrery")).toBe("Orrery · Atlas · 0 msgs");
		expect(existsSync(join(root, "data", "agents", "Birch"))).toBe(false);
		const birch = await pi(root, join(root, "agent-Birch"), config);
		expect(birch.status("orrery")).toBe("Orrery · Birch · 0 msgs");
	});

	it("an ORRERY_AGENT that names no agent: one notice, no memory, and no fallback to the folder", async () => {
		const { root, config } = world();
		const run = await pi(root, join(root, "agent-Atlas"), config, undefined, { env: { ORRERY_AGENT: "Nobody" } });
		expect(run.tool("zoom")).toBeUndefined();
		expect(run.notices).toEqual([{ type: "warning", message: "Orrery: ORRERY_AGENT names Nobody, which is not a configured agent; this session runs without memory." }]);
	});

	it("an ORRERY_AGENT_TOKEN that is malformed: one notice, no memory, and no fallback to the folder", async () => {
		const { root, config } = world();
		const run = await pi(root, join(root, "agent-Atlas"), config, undefined, { env: { ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: "not-a-token" } });
		expect(run.tool("zoom")).toBeUndefined();
		expect(run.notices).toEqual([{ type: "warning", message: "Orrery: ORRERY_AGENT_TOKEN is not 32 lowercase hex digits, so this session is not Atlas; it runs without memory." }]);
		expect(existsSync(join(root, "data", "agents", "Atlas"))).toBe(false);
	});

	it("a pi the agent started (same variables, another process) gets its folder's agent, or none", async () => {
		const { root, config } = world();
		const env = { ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: newToken() };
		const parent = await pi(root, join(root, "plain"), config, undefined, { env, owner: process.pid });
		expect(parent.status("orrery")).toBe("Orrery · Atlas · 0 msgs");
		const inBirch = await pi(root, join(root, "agent-Birch"), config, undefined, { env, owner: process.ppid });
		expect(inBirch.status("orrery")).toBe("Orrery · Birch · 0 msgs");
		const inPlain = await pi(root, join(root, "plain"), config, undefined, { env, owner: process.ppid });
		expect(inPlain.tool("zoom")).toBeUndefined();
		expect(inPlain.notices).toEqual([]);
	});

	it("resuming a session recorded in another agent's folder copies none of its turns, only what comes after", async () => {
		const { root, config } = world();
		const birch = await pi(root, join(root, "agent-Birch"), config, "s-birch");
		birch.setResponses([fauxAssistantMessage("Birch's answer.")]);
		await birch.session.prompt("Birch's question.");
		await close(birch);
		const atlas = await pi(root, join(root, "agent-Birch"), config, "s-birch", { env: { ORRERY_AGENT: "Atlas" } });
		expect(atlas.status("orrery")).toBe("Orrery · Atlas · 0 msgs");
		atlas.setResponses([fauxAssistantMessage("Atlas's answer.")]);
		await atlas.session.prompt("Atlas's question.");
		await close(atlas);
		expect(memoryOf(root)).toEqual(["user: Atlas's question.", "talk: Atlas's answer."]);
		expect(memoryOf(root, "Birch")).toEqual(["user: Birch's question.", "talk: Birch's answer."]);
	});

	it("resuming its own session in a plain folder goes on recording it, each turn once", async () => {
		const { root, config } = world();
		const env = { ORRERY_AGENT: "Atlas" };
		const first = await pi(root, join(root, "plain"), config, "s-own", { env });
		first.setResponses([fauxAssistantMessage("One.")]);
		await first.session.prompt("First.");
		await close(first);
		const again = await pi(root, join(root, "plain"), config, "s-own", { env });
		again.setResponses([fauxAssistantMessage("Two.")]);
		await again.session.prompt("Second.");
		await close(again);
		expect(memoryOf(root)).toEqual(["user: First.", "talk: One.", "user: Second.", "talk: Two."]);
	});
});

describe("who a session belongs to: an agent never copies turns another agent said in it", () => {
	const say = async (run: Awaited<ReturnType<typeof pi>>, question: string, answer: string) => {
		run.setResponses([fauxAssistantMessage(answer)]);
		await run.session.prompt(question);
	};

	it("a session ORRERY_AGENT recorded in an agent's folder: that agent, resuming it by folder, records only what comes after", async () => {
		const { root, config } = world();
		const atlas = await pi(root, join(root, "agent-Birch"), config, "s-x", { env: { ORRERY_AGENT: "Atlas" } });
		expect(atlas.status("orrery")).toBe("Orrery · Atlas · 0 msgs");
		await say(atlas, "Atlas secret question.", "Atlas secret answer.");
		await close(atlas);
		const birch = await pi(root, join(root, "agent-Birch"), config, "s-x");
		expect(birch.status("orrery")).toBe("Orrery · Birch · 0 msgs");
		await say(birch, "Birch question.", "Birch answer.");
		await close(birch);
		expect(memoryOf(root, "Birch")).toEqual(["user: Birch question.", "talk: Birch answer."]);
		expect(memoryOf(root)).toEqual(["user: Atlas secret question.", "talk: Atlas secret answer."]);
		expect(readFileSync(ownerRecord(root, "s-x"), "utf8")).toBe("Atlas\n");
	});

	for (const [what, id] of [["with a dot in its id", "s.x"], ["with an id longer than 128 characters", `s-${"x".repeat(150)}`]] as const) {
		it(`a session ${what} (pi takes it): another agent's turns stay out of the folder's agent`, async () => {
			const { root, config } = world();
			const atlas = await pi(root, join(root, "agent-Birch"), config, id, { env: { ORRERY_AGENT: "Atlas" } });
			await say(atlas, "Atlas secret question.", "Atlas secret answer.");
			await close(atlas);
			const birch = await pi(root, join(root, "agent-Birch"), config, id);
			await say(birch, "Birch question.", "Birch answer.");
			await close(birch);
			expect(memoryOf(root, "Birch")).toEqual(["user: Birch question.", "talk: Birch answer."]);
			expect(readFileSync(ownerRecord(root, id), "utf8")).toBe("Atlas\n");
		});
	}

	it("a visitor still running when the owner opens: the turns it says after that stay out of the owner too", async () => {
		const { root, config } = world();
		const first = await pi(root, join(root, "agent-Birch"), config, "s-b");
		await say(first, "One.", "First.");
		await close(first);
		const atlas = await pi(root, join(root, "agent-Birch"), config, "s-b", { env: { ORRERY_AGENT: "Atlas" } });
		ageVisitMarks(config.dataDir);
		// The owner opens while the visitor runs: it starts at the tail and settles the visit.
		const meanwhile = await pi(root, join(root, "agent-Birch"), config, "s-b");
		await say(atlas, "Atlas secret question.", "Atlas secret answer.");
		await close(meanwhile);
		await close(atlas);
		const again = await pi(root, join(root, "agent-Birch"), config, "s-b");
		await say(again, "Two.", "Second.");
		await close(again);
		expect(memoryOf(root, "Birch")).toEqual(["user: One.", "talk: First.", "user: Two.", "talk: Second."]);
		expect(memoryOf(root)).toEqual(["user: Atlas secret question.", "talk: Atlas secret answer."]);
	});

	it("a visitor's run that ends while the owner is opening (after it loaded the session) stays out of the owner too", async () => {
		const { root, config } = world();
		const first = await pi(root, join(root, "agent-Birch"), config, "s-b");
		await say(first, "One.", "First.");
		await close(first);
		const atlas = await pi(root, join(root, "agent-Birch"), config, "s-b", { env: { ORRERY_AGENT: "Atlas" } });
		ageVisitMarks(config.dataDir);
		// A hook, not timing: the owner's memory opens (summary sources) only once the visitor has run and shut down, so
		// every note of the visit falls after the owner loaded the session and before it settles the visit.
		const opening = await pi(root, join(root, "agent-Birch"), config, "s-b", {
			summarySources: async (cfg) => {
				await say(atlas, "Atlas secret question.", "Atlas secret answer.");
				await close(atlas);
				return summarySourcesFor(cfg);
			},
		});
		await close(opening);
		const again = await pi(root, join(root, "agent-Birch"), config, "s-b");
		await say(again, "Two.", "Second.");
		await close(again);
		expect(memoryOf(root, "Birch")).toEqual(["user: One.", "talk: First.", "user: Two.", "talk: Second."]);
		expect(memoryOf(root)).toEqual(["user: Atlas secret question.", "talk: Atlas secret answer."]);
	});

	it("a session first run under an ORRERY_AGENT that names no agent: the folder's agent records only what comes after", async () => {
		const { root, config } = world();
		const nobody = await pi(root, join(root, "agent-Birch"), config, "s-u", { env: { ORRERY_AGENT: "Nobody" } });
		await say(nobody, "Unknown question.", "Unknown answer.");
		await close(nobody);
		const birch = await pi(root, join(root, "agent-Birch"), config, "s-u");
		await say(birch, "Birch question.", "Birch answer.");
		await close(birch);
		expect(memoryOf(root, "Birch")).toEqual(["user: Birch question.", "talk: Birch answer."]);
	});

	it("the owner resuming its own session copies what it has not seen yet, each turn once: no tail", async () => {
		const { root, config } = world();
		const first = await pi(root, join(root, "agent-Birch"), config, "s-b");
		await say(first, "One.", "First.");
		await close(first);
		const plain = await plainPi(root, join(root, "agent-Birch"), "s-b");
		await say(plain, "Said without Orrery.", "Plain.");
		await close(plain);
		const again = await pi(root, join(root, "agent-Birch"), config, "s-b");
		await say(again, "Two.", "Second.");
		await close(again);
		expect(memoryOf(root, "Birch")).toEqual(["user: One.", "talk: First.", "user: Said without Orrery.", "talk: Plain.", "user: Two.", "talk: Second."]);
	});

	it("a session from before owner records (no record) is copied as before, and gets its record", async () => {
		const { root, config } = world();
		const first = await pi(root, join(root, "agent-Birch"), config, "s-old");
		await say(first, "One.", "First.");
		await close(first);
		rmSync(ownerRecord(root, "s-old"));
		const plain = await plainPi(root, join(root, "agent-Birch"), "s-old");
		await say(plain, "Said without Orrery.", "Plain.");
		await close(plain);
		const again = await pi(root, join(root, "agent-Birch"), config, "s-old");
		await close(again);
		expect(memoryOf(root, "Birch")).toEqual(["user: One.", "talk: First.", "user: Said without Orrery.", "talk: Plain."]);
		expect(readFileSync(ownerRecord(root, "s-old"), "utf8")).toBe("Birch\n");
	});

	it("the owner resuming its session after another agent ran in it records only what comes after the visit", async () => {
		const { root, config } = world();
		const birch = await pi(root, join(root, "agent-Birch"), config, "s-b");
		await say(birch, "One.", "First.");
		await close(birch);
		const atlas = await pi(root, join(root, "agent-Birch"), config, "s-b", { env: { ORRERY_AGENT: "Atlas" } });
		await say(atlas, "Atlas secret question.", "Atlas secret answer.");
		await close(atlas);
		const again = await pi(root, join(root, "agent-Birch"), config, "s-b");
		await say(again, "Two.", "Second.");
		await close(again);
		expect(memoryOf(root, "Birch")).toEqual(["user: One.", "talk: First.", "user: Two.", "talk: Second."]);
		expect(memoryOf(root)).toEqual(["user: Atlas secret question.", "talk: Atlas secret answer."]);
	});
});

describe("an agent's instructions", () => {
	type Ctx = { systemPrompt?: string; messages: { role: string; content: unknown }[] };
	const systemText = (context: Ctx) => [context.systemPrompt ?? "", ...context.messages.filter((m) => m.role === "system").map((m) => JSON.stringify(m.content))].join("\n");

	it("go into the system prompt under the agent's name, before the memory section", async () => {
		const { root, config } = world();
		writeInstructions(join(root, "data", "agents", "Atlas"), "You are Atlas. Keep replies short.\n");
		const run = await pi(root, join(root, "agent-Atlas"), config);
		let system = "";
		run.setResponses([fauxAssistantMessage("Noted."), (context: Ctx) => ((system = systemText(context)), fauxAssistantMessage("Cedar."))]);
		await run.session.prompt("The codename is Cedar.");
		await run.session.prompt("What is the codename?");
		expect(system).toContain("# Agent: Atlas");
		expect(system).toContain("You are Atlas. Keep replies short.");
		expect(system.indexOf("# Agent: Atlas")).toBeLessThan(system.indexOf("# Memory"));
	});

	it("reach the prompt when the agent's memory is held elsewhere, without a memory section", async () => {
		const { root, config } = world();
		writeInstructions(join(root, "data", "agents", "Atlas"), "You are Atlas.\n");
		await pi(root, join(root, "agent-Atlas"), config);
		const second = await pi(root, join(root, "agent-Atlas"), config);
		let system = "";
		second.setResponses([(context: Ctx) => ((system = systemText(context)), fauxAssistantMessage("Hi."))]);
		await second.session.prompt("Hello.");
		expect(system).toContain("# Agent: Atlas");
		expect(system).not.toContain("# Memory");
	});

	it("over 32 KB: the first 32 KB, and one notice", async () => {
		const { root, config } = world();
		writeInstructions(join(root, "data", "agents", "Atlas"), `${"a".repeat(INSTRUCTIONS_MAX_BYTES)}TAIL`);
		const run = await pi(root, join(root, "agent-Atlas"), config);
		let system = "";
		run.setResponses([(context: Ctx) => ((system = systemText(context)), fauxAssistantMessage("Hi."))]);
		await run.session.prompt("Hello.");
		expect(system).toContain("# Agent: Atlas");
		expect(system).toContain("a".repeat(INSTRUCTIONS_MAX_BYTES));
		expect(system).not.toContain("TAIL");
		expect(run.notices.filter((n) => n.message.includes("over 32 KB"))).toEqual([{ type: "warning", message: "Orrery: Atlas's instructions are over 32 KB; only the first 32 KB reach the model. Shorten instructions.md." }]);
	});

	// A guard: it passes before instructions exist too (D5); it keeps an agent without them as it was.
	it("none: the prompt has no agent section", async () => {
		const { root, config } = world();
		const run = await pi(root, join(root, "agent-Atlas"), config);
		let system = "";
		run.setResponses([(context: Ctx) => ((system = systemText(context)), fauxAssistantMessage("Hi."))]);
		await run.session.prompt("Hello.");
		expect(system).not.toContain("# Agent: Atlas");
		expect(system).toContain("# Memory");
	});

	it("are read at the session's start: an edit reaches the next session, not this one", async () => {
		const { root, config } = world();
		const dir = join(root, "data", "agents", "Atlas");
		writeInstructions(dir, "You are Atlas, first.\n");
		const run = await pi(root, join(root, "agent-Atlas"), config);
		const systems: string[] = [];
		run.setResponses([(context: Ctx) => (systems.push(systemText(context)), fauxAssistantMessage("One.")), (context: Ctx) => (systems.push(systemText(context)), fauxAssistantMessage("Two."))]);
		await run.session.prompt("First.");
		writeInstructions(dir, "You are Atlas, second.\n");
		await run.session.prompt("Second.");
		expect(systems.map((text) => text.includes("You are Atlas, first.") && !text.includes("second."))).toEqual([true, true]);
		await close(run);
		const next = await pi(root, join(root, "agent-Atlas"), config);
		let system = "";
		next.setResponses([(context: Ctx) => ((system = systemText(context)), fauxAssistantMessage("Three."))]);
		await next.session.prompt("Third.");
		expect(system).toContain("You are Atlas, second.");
	});

	it("come with the agent ORRERY_AGENT opens in a folder outside its folder; a refused name gets none", async () => {
		const { root, config } = world();
		writeInstructions(join(root, "data", "agents", "Atlas"), "You are Atlas, opened by name.\n");
		const run = await pi(root, join(root, "plain"), config, undefined, { env: { ORRERY_AGENT: "Atlas" } });
		let system = "";
		run.setResponses([(context: Ctx) => ((system = systemText(context)), fauxAssistantMessage("Hi."))]);
		await run.session.prompt("Hello.");
		expect(system).toContain("# Agent: Atlas");
		expect(system).toContain("You are Atlas, opened by name.");
		await close(run);
		const refused = await pi(root, join(root, "plain"), config, undefined, { env: { ORRERY_AGENT: "Nobody" } });
		refused.setResponses([(context: Ctx) => ((system = systemText(context)), fauxAssistantMessage("Hi."))]);
		await refused.session.prompt("Hello.");
		expect(system).not.toContain("# Agent:");
	});
});
