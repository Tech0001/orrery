import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../../src/memory/index.ts";
import { FAUX_SUMMARY } from "./harness.ts";
import { cleanup, close, lastLane, pi, world } from "./world.ts";

afterEach(cleanup);

const memoryOf = (root: string) => {
	const store = MemoryStore.openReadOnly(join(root, "data", "lanes", "Atlas", "memory.sqlite"));
	const rows = store.root.map((m) => `${m.kind}: ${m.text}`);
	store.close();
	return rows;
};
const lastReply = (messages: readonly { role: string; content?: unknown }[]) =>
	JSON.stringify(messages.filter((m) => m.role === "assistant").at(-1)?.content);

describe("orrery inside pi", () => {
	it("opens the lane's memory in a lane folder, writes status, and registers the memory tools", async () => {
		const { root, config } = world();
		const run = await pi(root, join(root, "agent-Atlas"), config);
		expect(existsSync(join(root, "data", "lanes", "Atlas", "memory.sqlite"))).toBe(true);
		const status = JSON.parse(readFileSync(join(root, "data", "lanes", "Atlas", "status.json"), "utf8"));
		expect(status).toMatchObject({ lane: "Atlas", busy: false, compactor: { stopped: false } });
		expect(run.status("orrery")).toBe("Orrery · Atlas · 0 msgs");
		expect(run.tool("zoom")).toBeDefined();
	});

	it("does nothing outside a lane folder", async () => {
		const { root, config } = world();
		const run = await pi(root, join(root, "plain"), config);
		expect(existsSync(join(root, "data", "lanes"))).toBe(false);
		expect(run.tool("zoom")).toBeUndefined();
		expect(run.notices).toEqual([]);
	});

	it("gives a second pi on the same lane no memory and no tools", async () => {
		const { root, config } = world();
		await pi(root, join(root, "agent-Atlas"), config);
		const second = await pi(root, join(root, "agent-Atlas"), config);
		expect(second.tool("zoom")).toBeUndefined();
		expect(second.notices).toContainEqual({ message: "Atlas is already open in another pi; this one runs without memory.", type: "warning" });
	});

	it("keeps the guard for a pi that runs without memory (lane held, or its memory unreadable)", async () => {
		const { root, config } = world();
		const escape = `${root}-escape.txt`; // outside the lane's allowed roots (the workspace's parent folder)
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
			expect(await tryWrite(second)).toMatch(/outside this lane's workspace/);
			expect(existsSync(escape)).toBe(false);
			await close(second);
			await close(first);
			writeFileSync(join(root, "data", "lanes", "Atlas", "memory.sqlite"), "not a database, and long enough to be read as one");
			const broken = await pi(root, join(root, "agent-Atlas"), config);
			expect(broken.tool("zoom")).toBeUndefined();
			expect(broken.notices).toContainEqual({ message: expect.stringMatching(/^Orrery: Atlas: .*; this pi runs without memory\.$/), type: "warning" });
			expect(await tryWrite(broken)).toMatch(/outside this lane's workspace/);
			expect(existsSync(escape)).toBe(false);
		} finally {
			rmSync(escape, { force: true });
		}
	});

	it("opens a lane whose summary model is unknown with memory and logging, says why summaries are off, and /compactor starts them", async () => {
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
		expect(lastLane().store.root.map((m) => m.kind)).toEqual(["user", "talk", "user", "talk"]);
		expect(run.status("orrery")).toBe("Orrery · Atlas · 4 msgs · SUMMARIES STOPPED: unknown model nobody/nothing");
		await run.session.prompt("/memory");
		expect(run.notices.at(-1)?.message).toContain("STOPPED: unknown model nobody/nothing");
		// The first answer is the test call /compactor makes before it switches.
		run.setSummaryResponses([fauxAssistantMessage("OK"), fauxAssistantMessage("A long first message, summarized.")]);
		await run.session.prompt(`/compactor ${FAUX_SUMMARY.provider}/${FAUX_SUMMARY.model}`);
		expect(run.notices.at(-1)).toEqual({ message: `summaries: ${FAUX_SUMMARY.provider}/${FAUX_SUMMARY.model} (off) · set in chat`, type: "info" });
		await vi.waitFor(() => expect(lastLane().view.settled).toBe(true));
		expect(lastLane().view.render()).toContain("A long first message, summarized.");
		expect(lastLane().statusLine()).toBe("Orrery · Atlas · 4 msgs");
	}, 20_000);

	it("warns when the orrery config cannot be read, and runs without memory", async () => {
		const { root } = world();
		const saved = process.env.ORRERY_CONFIG;
		try {
			const broken = join(root, "broken.toml");
			writeFileSync(broken, "lanes = [");
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

	it("keeps running when the status file cannot be written, warns once, and still releases the lane", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		try {
			const { root, config } = world();
			const status = join(root, "data", "lanes", "Atlas", "status.json");
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
		lastLane().view.appendBatch = () => {
			throw new Error("disk full");
		};
		await run.session.executeBash("echo new-entry"); // something for before_agent_start to copy
		await run.session.prompt("What is the codename?");
		expect(system).toContain("# Memory");
		expect(system).toContain("The codename is Cedar.");
		expect(run.notices).toContainEqual({ type: "warning", message: "Orrery: logging this session into memory failed: disk full" });
	});

	it("marks the lane closed in its status even when the copy at shutdown fails", async () => {
		const { root, config } = world();
		const run = await pi(root, join(root, "agent-Atlas"), config);
		lastLane().view.appendBatch = () => {
			throw new Error("disk full");
		};
		await run.session.executeBash("echo new-entry");
		await close(run);
		const status = JSON.parse(readFileSync(join(root, "data", "lanes", "Atlas", "status.json"), "utf8"));
		expect(status.open).toBe(false);
		expect(run.notices.some((n) => n.message.includes("at shutdown failed: disk full"))).toBe(true);
	});

	it("releases the lane even when its compactor fails to close", async () => {
		const { root, config } = world();
		const run = await pi(root, join(root, "agent-Atlas"), config);
		const compactor = lastLane().compactor;
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
		expect(lastLane().store.root.map((m) => `${m.kind}: ${m.text}`)).toEqual(["user: The codename is Cedar.", "talk: Noted."]);
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
		expect(lastLane().store.root.map((m) => `${m.kind}: ${m.text}`)).toEqual(["user: The codename is Cedar.", "talk: Noted."]);
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
		await vi.waitFor(() => expect(lastLane().view.settled).toBe(true));
		expect(lastLane().view.render()).toContain("Codename Cedar, padded.");
		await run.session.prompt("What is the codename?");
		expect(lastReply(run.session.messages)).toContain("Cedar.");
	});
});
