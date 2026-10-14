import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../../src/memory/index.ts";
import { cleanup, close, isolatedHome, lastLane, pi, plainPi, world } from "./world.ts";

afterEach(cleanup);
isolatedHome();

type Ctx = { systemPrompt?: string; messages: { role: string; content: unknown }[] };
const textOf = (m: { content: unknown }) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));
const memoryOf = (root: string) => {
	const store = MemoryStore.openReadOnly(join(root, "data", "lanes", "Atlas", "memory.sqlite"));
	const rows = store.root.map((m) => `${m.kind}: ${m.text}`);
	store.close();
	return rows;
};

describe("each run", () => {
	it("sends system + memory view + this run only, and logs every message into memory", async () => {
		const { root, config } = world();
		const run = await pi(root, join(root, "agent-Atlas"), config);
		const seen: { system: string; lines: string[] }[] = [];
		const capture = (answer: string) => (context: Ctx) => {
			const system = [context.systemPrompt ?? "", ...context.messages.filter((m) => m.role === "system").map(textOf)].join("\n");
			seen.push({ system, lines: context.messages.filter((m) => m.role !== "system").map((m) => `${m.role}:${textOf(m)}`) });
			return fauxAssistantMessage(answer);
		};
		run.setResponses([capture("Noted: Cedar."), capture("Cedar.")]);
		await run.session.prompt("The codename is Cedar.");
		await run.session.prompt("What is the codename?");
		expect(seen[1].system).toContain("# Memory");
		expect(seen[1].system).toContain("The codename is Cedar.");
		expect(seen[1].system).toContain("Noted: Cedar.");
		expect(seen[1].lines).toHaveLength(1);
		expect(seen[1].lines[0]).toContain("What is the codename?");
		await close(run);
		expect(memoryOf(root)).toEqual(["user: The codename is Cedar.", "talk: Noted: Cedar.", "user: What is the codename?", "talk: Cedar."]);
	});

	it("sends the user's !cmd output with the next message but does not log it; a !!cmd reaches neither", async () => {
		const { root, config } = world();
		const run = await pi(root, join(root, "agent-Atlas"), config);
		const requests: string[] = [];
		const capture = (answer: string) => (context: Ctx) => {
			requests.push(context.messages.filter((m) => m.role !== "system").map(textOf).join("\n"));
			return fauxAssistantMessage(answer);
		};
		run.setResponses([capture("One."), capture("Two.")]);
		await run.session.executeBash("echo orrery-first-output");
		await run.session.prompt("What did it print?");
		await run.session.executeBash("echo orrery-visible-output");
		await run.session.executeBash("echo orrery-hidden-output", undefined, { excludeFromContext: true });
		await run.session.prompt("And now?");
		expect(requests[0]).toContain("orrery-first-output");
		expect(requests[1]).toContain("orrery-visible-output");
		expect(requests[1]).not.toContain("orrery-first-output"); // an older run's: memory has it
		expect(requests[1]).not.toContain("What did it print?");
		expect(requests.join("\n")).not.toContain("orrery-hidden-output");
		await close(run);
		const rows = memoryOf(root);
		expect(rows.filter((r) => r.startsWith("tool: ") || r.startsWith("echo: "))).toEqual([]);
		expect(rows.join("\n")).not.toContain("orrery-first-output");
		expect(rows).toEqual(["user: What did it print?", "talk: One.", "user: And now?", "talk: Two."]);
		expect(rows.join("\n")).not.toContain("hidden");
	});

	it("never sends !cmd output from before the session started or from during the previous run (memory keeps neither)", async () => {
		const { root, config } = world();
		const cwd = join(root, "agent-Atlas");
		const before = await pi(root, cwd, config, "s-bash");
		before.setResponses([fauxAssistantMessage("Zero.")]);
		await before.session.prompt("Zero?"); // pi saves a session file once it has a reply
		await before.session.executeBash("echo orrery-old-output");
		await close(before);
		const run = await pi(root, cwd, config, "s-bash");
		const requests: string[] = [];
		const seen = (context: Ctx) => requests.push(context.messages.filter((m) => m.role !== "system").map(textOf).join("\n"));
		run.setResponses([
			async (context: Ctx) => {
				seen(context);
				// The user runs a command while the agent works: pi queues it and adds it after the run.
				await run.session.executeBash("echo orrery-during-output");
				return fauxAssistantMessage("One.");
			},
			(context: Ctx) => {
				seen(context);
				return fauxAssistantMessage("Two.");
			},
		]);
		await run.session.prompt("First?");
		await run.session.prompt("Second?");
		expect(requests[0]).not.toContain("orrery-old-output");
		expect(requests[1]).toContain("Second?");
		expect(requests[1]).not.toContain("orrery-during-output");
		await close(run);
		expect(memoryOf(root).filter((r) => r.startsWith("tool: ") || r.startsWith("echo: "))).toEqual([]);
	});

	it("catches up messages a pi without orrery left in the session, exactly once", async () => {
		const { root, config } = world();
		const plain = await plainPi(root, join(root, "agent-Atlas"), "s-1");
		plain.setResponses([fauxAssistantMessage("ok")]);
		await plain.session.prompt("Said without orrery.");
		await close(plain);
		const first = await pi(root, join(root, "agent-Atlas"), config, "s-1");
		await close(first);
		const second = await pi(root, join(root, "agent-Atlas"), config, "s-1");
		await close(second);
		expect(memoryOf(root)).toEqual(["user: Said without orrery.", "talk: ok"]);
	});

	it("does not hang when summaries are stuck: the wait is bounded, the prompt sees placeholders, and a warning is shown", async () => {
		const { root, config } = world();
		const run = await pi(root, join(root, "agent-Atlas"), config, undefined, { memoryWaitMs: 200 });
		let system = "";
		run.setSummaryResponses([() => new Promise(() => {})]);
		run.setResponses([
			fauxAssistantMessage("Read."),
			(context: Ctx) => {
				system = [context.systemPrompt ?? "", ...context.messages.filter((m) => m.role === "system").map(textOf)].join("\n");
				return fauxAssistantMessage("Still here.");
			},
		]);
		await run.session.prompt(`A long first message ${"detail ".repeat(200)}`);
		await run.session.prompt("Are you there?");
		expect(system).toContain("(not summarized yet: zoom it)");
		expect(run.notices.some((n) => n.type === "warning" && n.message.includes("summaries still pending"))).toBe(true);
		await close(run);
	}, 15000);

	it("does not wait for failing summaries: after a failure a message goes at once, with placeholders, the footer and a warning say why", async () => {
		const { root, config } = world();
		const run = await pi(root, join(root, "agent-Atlas"), config, undefined, { memoryWaitMs: 10_000 });
		run.setSummaryResponses(Array.from({ length: 5 }, () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "quota exceeded" })));
		let system = "";
		run.setResponses([
			fauxAssistantMessage("Read."),
			(context: Ctx) => {
				system = [context.systemPrompt ?? "", ...context.messages.filter((m) => m.role === "system").map(textOf)].join("\n");
				return fauxAssistantMessage("Still here.");
			},
		]);
		await run.session.prompt(`A long first message ${"detail ".repeat(200)}`);
		await vi.waitFor(() => expect(lastLane().compactor.failed.size).toBeGreaterThan(0));
		const started = Date.now();
		await run.session.prompt("Are you there?");
		expect(Date.now() - started).toBeLessThan(2000);
		expect(system).toContain("(not summarized yet: zoom it)");
		expect(run.notices).toContainEqual({ type: "warning", message: expect.stringMatching(/^Orrery: summaries are failing \(.+ rate or usage limit reached; retrying\);/) });
		expect(run.status("orrery")).toMatch(/^Orrery · Atlas · 4 msgs · SUMMARIES FAILING: .+ · \/compactor$/);
		// No raw per-part compactor warning: the provider's own words never reach the user.
		expect(run.notices.filter((n) => /^Compactor |retrying every|quota exceeded/.test(n.message))).toEqual([]);
	}, 20_000);

	it("tells the user once when summaries start failing, through the status tick", async () => {
		// Only the 5 s status tick is faked; pi and the compactor keep real timeouts.
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		try {
			const { root, config } = world();
			const run = await pi(root, join(root, "agent-Atlas"), config);
			run.setSummaryResponses(Array.from({ length: 5 }, () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "quota exceeded" })));
			run.setResponses([fauxAssistantMessage("Read.")]);
			await run.session.prompt(`A long first message ${"detail ".repeat(200)}`);
			await vi.waitFor(() => expect(lastLane().compactor.failed.size).toBeGreaterThan(0));
			const failing = () => run.notices.filter((n) => n.message.startsWith("Orrery: Atlas's summaries"));
			expect(failing()).toEqual([]);
			vi.advanceTimersByTime(5000);
			vi.advanceTimersByTime(5000);
			expect(failing()).toEqual([
				{ type: "warning", message: expect.stringMatching(/^Orrery: Atlas's summaries are failing: .+\. They keep retrying; nothing is lost\. Switch with \/compactor\.$/) },
			]);
			// A failed retry replaces the error, often with a new request id: the reason changes, the state does not.
			const before = lastLane().summaryTrouble()?.plain;
			lastLane().compactor.lastError = "upstream error, request_id req_0002";
			expect(lastLane().summaryTrouble()?.state).toBe("failing");
			expect(lastLane().summaryTrouble()?.plain).not.toBe(before);
			vi.advanceTimersByTime(5000);
			expect(failing()).toHaveLength(1);
			// The once-per-change notice is all the user hears: no raw per-part compactor warnings.
			expect(run.notices.filter((n) => /^Compactor |retrying every|quota exceeded/.test(n.message))).toEqual([]);
			await close(run);
		} finally {
			vi.useRealTimers();
		}
	}, 20_000);

	it("does not repeat at the tick what the lane said when it opened, and says once when summaries work again", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		try {
			const { root, config } = world({ compactorModel: "nobody/nothing" });
			const run = await pi(root, join(root, "agent-Atlas"), config);
			const said = () => run.notices.filter((n) => n.message.startsWith("Orrery: Atlas's summaries"));
			expect(run.notices.some((n) => n.message.includes("summaries are off: unknown model nobody/nothing"))).toBe(true);
			vi.advanceTimersByTime(5000);
			expect(said()).toEqual([]);
			run.setSummaryResponses([fauxAssistantMessage("OK")]);
			await run.session.prompt("/compactor orrery-faux-summary/faux-1");
			vi.advanceTimersByTime(5000);
			vi.advanceTimersByTime(5000);
			expect(said()).toEqual([{ type: "info", message: "Orrery: Atlas's summaries are working again." }]);
			await close(run);
		} finally {
			vi.useRealTimers();
		}
	}, 20_000);

	it("ends a wait early when the pending summary fails during it", async () => {
		const { root, config } = world();
		const run = await pi(root, join(root, "agent-Atlas"), config, undefined, { memoryWaitMs: 10_000 });
		const failLater = () => new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => setTimeout(() => resolve(fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" })), 300));
		run.setSummaryResponses([failLater, failLater]);
		run.setResponses([fauxAssistantMessage("Read."), fauxAssistantMessage("Still here.")]);
		await run.session.prompt(`A long first message ${"detail ".repeat(200)}`);
		expect(lastLane().compactor.failed.size).toBe(0); // the summary call is still out
		const started = Date.now();
		await run.session.prompt("Are you there?");
		expect(Date.now() - started).toBeLessThan(3000);
		expect(run.notices).toContainEqual({ type: "warning", message: expect.stringMatching(/^Orrery: summaries are failing \(overloaded\);/) });
	}, 20_000);

	it("trims the first model call of a resumed session even when it does not start with a prompt (sendMessage with triggerTurn)", async () => {
		const { root, config } = world();
		const first = await pi(root, join(root, "agent-Atlas"), config, "s-3");
		first.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await first.session.prompt("First exchange alpha.");
		await first.session.prompt("Second exchange beta.");
		await close(first);
		const run = await pi(root, join(root, "agent-Atlas"), config, "s-3");
		let lines: string[] = [];
		run.setResponses([
			(context: Ctx) => {
				lines = context.messages.filter((m) => m.role !== "system").map((m) => textOf(m));
				return fauxAssistantMessage("three");
			},
		]);
		await run.session.sendCustomMessage({ customType: "note", content: "A nudge.", display: false }, { triggerTurn: true });
		const all = lines.join("\n"); 
		expect(all).toContain("A nudge.");
		expect(all).not.toContain("First exchange alpha.");
		await close(run);
	}, 15000);
});
