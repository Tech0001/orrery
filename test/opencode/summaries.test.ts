import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chatTurnsToMessages } from "../../src/agent/chat-turns.ts";
import { type ModelSource, sourceCompactorModel } from "../../src/agent/model-source.ts";
import { FREE_REASON } from "../../src/agent/opencode-source.ts";
import type { ChatTurn } from "../../src/memory/index.ts";
import type { GenerateEvent } from "../../src/opencode/host.ts";
import { type OpenCodeAccess, OpenCodeSummaries, readModelList, SUMMARY_MARK, withOpenCode } from "../../src/opencode/summaries.ts";

/** OpenCode's model list as its plugin API gives it: an own-key model, a Zen paid one, two of the free tier, a disabled one. */
const LIST = {
	data: [
		{ id: "fake-model", modelID: "fake-model", providerID: "fake", name: "Fake", enabled: true, cost: [], limit: { context: 200_000, output: 4096 }, variants: [{ id: "low" }, { id: "high" }] },
		{ id: "claude-sonnet-4-5", providerID: "opencode", name: "Claude Sonnet 4.5", enabled: true, cost: [{ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }], limit: { context: 1_000_000, output: 64_000 }, variants: [] },
		{ id: "big-pickle", providerID: "opencode", name: "Big Pickle", enabled: true, cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }], limit: { context: 200_000, output: 32_000 }, variants: [] },
		{ id: "deepseek-v4.1-flash-free", providerID: "opencode", name: "DeepSeek V4.1 Flash Free", enabled: true, cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }], limit: { context: 128_000, output: 8000 }, variants: [] },
		{ id: "off-model", providerID: "fake", name: "Off", enabled: false, cost: [], limit: { context: 1000, output: 100 }, variants: [] },
	],
};

/** A stand-in for one folder's OpenCode: its model list, and session.generate running the generate hook `shape`. */
function host(summaries: OpenCodeSummaries, answer = "the summary") {
	const made: Record<string, unknown>[] = [];
	const removed: string[] = [];
	const requests: GenerateEvent[] = [];
	const access: OpenCodeAccess = {
		directory: "/work/ws",
		listModels: async () => LIST,
		createSession: async (input) => {
			made.push(input as Record<string, unknown>);
			return { id: `ses_${made.length}` };
		},
		generate: async ({ sessionID, prompt }) => {
			const event: GenerateEvent = { sessionID, system: [{ type: "text", text: "You are OpenCode." }, { type: "text", text: "# Your Model" }], messages: [{ role: "user", content: [{ type: "text", text: prompt }] }], tools: { shell: {} }, options: { textVerbosity: "low" } };
			summaries.shape(event);
			requests.push(event);
			return { text: answer };
		},
		removeSession: async ({ sessionID }) => {
			removed.push(sessionID);
		},
	};
	summaries.addHost(access);
	return { access, made, removed, requests };
}

describe("OpenCode's models as a summary source", () => {
	it("reads OpenCode's model list: refs, context, price, variants, the free tier marked, a disabled model left out", () => {
		const models = readModelList(LIST);
		expect(models.map((m) => [m.ref, m.free])).toEqual([
			["opencode/fake/fake-model", false],
			["opencode/opencode/big-pickle", true],
			["opencode/opencode/claude-sonnet-4-5", false],
			["opencode/opencode/deepseek-v4.1-flash-free", true],
		]);
		expect(models.find((m) => m.id === "claude-sonnet-4-5")).toMatchObject({ contextWindow: 1_000_000, price: { input: 3, output: 15 }, variants: [] });
		expect(models.find((m) => m.id === "fake-model")).toMatchObject({ name: "Fake", variants: ["low", "high"] });
		expect(readModelList({ nope: 1 })).toEqual([]);
		expect(readModelList(undefined)).toEqual([]);
	});

	it("offers paid and own-key models, never the free tier (with the reason), and nothing it doesn't list", async () => {
		const summaries = new OpenCodeSummaries("Atlas");
		host(summaries);
		await summaries.refresh();
		expect(summaries.find("fake/fake-model")).toEqual({ api: "opencode-session", provider: "opencode", id: "fake/fake-model", contextWindow: 200_000 });
		expect(summaries.find("opencode/claude-sonnet-4-5")).toBeDefined();
		expect(summaries.find("opencode/big-pickle")).toBeUndefined();
		expect(summaries.unavailable("opencode/big-pickle")).toBe(FREE_REASON);
		expect(summaries.unavailable("opencode/deepseek-v4.1-flash-free")).toBe(FREE_REASON);
		expect(summaries.unavailable("fake/fake-model")).toBeUndefined();
		expect(summaries.find("fake/off-model")).toBeUndefined();
		expect(summaries.unavailable("fake/nope")).toBe("OpenCode lists no model opencode/fake/nope");
		summaries.disable("this OpenCode has no generate hook");
		expect(summaries.find("fake/fake-model")).toBeUndefined();
		expect(summaries.unavailable("fake/fake-model")).toMatch(/no generate hook/);
	});

	it("sends a summary as Orrery's own path would, byte for byte: its system prompt and every turn's blocks; no tools, no options of OpenCode's; in a session of its own, removed after", async () => {
		const summaries = new OpenCodeSummaries("Atlas");
		const oc = host(summaries, "  a line  ");
		await summaries.refresh();
		const orrery: ModelSource = { find: () => undefined, streamSimple: () => ({ result: async () => Promise.reject(new Error("not Orrery's")) }) };
		const source = withOpenCode(orrery, summaries);
		const choice = { provider: "opencode", modelId: "fake/fake-model", thinking: "high" as const };
		const { model, contextWindow } = sourceCompactorModel(source, choice, "compactor:Atlas");
		expect(contextWindow).toBe(200_000);
		const turns: ChatTurn[] = [
			{ role: "user", blocks: ["<chat>\n0|user: hi\n</chat>", "Compaction: write line 0+1 in at most 300 bytes."], mark: 0 },
			{ role: "assistant", text: "a line far too long" },
			{ role: "user", blocks: ["That line is 900 bytes; the limit is 300."] },
		];
		const reply = await model.complete("THE SYSTEM PROMPT\nas it is.", turns, AbortSignal.timeout(5000));
		expect(reply.text).toBe("  a line  ");
		const [request] = oc.requests;
		expect(request?.system).toEqual([{ type: "text", text: "THE SYSTEM PROMPT\nas it is." }]);
		// The turns as Orrery's pi-ai path builds them (chat-turns.ts), each text block as it is.
		const expected = chatTurnsToMessages(turns, { api: "x", provider: "x", id: "x" }).map((message) => ({ role: message.role, content: (message.content as { text: string }[]).map((block) => ({ type: "text", text: block.text })) }));
		expect(request?.messages).toEqual(expected);
		expect(request?.tools).toEqual({});
		expect(request?.options).toEqual({});
		// The session: the chosen model with the thinking level's variant, in the plugin's folder, marked as Orrery's.
		expect(oc.made).toEqual([{ location: { directory: "/work/ws" }, title: "Orrery summary · Atlas", model: { providerID: "fake", id: "fake-model", variant: "high" }, metadata: SUMMARY_MARK }]);
		await new Promise((wait) => setTimeout(wait, 0));
		expect(oc.removed).toEqual(["ses_1"]);
	});

	it("leaves other generate requests alone, refuses a free model, and gives up on an abort (the session is removed all the same)", async () => {
		const summaries = new OpenCodeSummaries("Atlas");
		const oc = host(summaries);
		await summaries.refresh();
		const event: GenerateEvent = { sessionID: "ses_theirs", system: [{ type: "text", text: "x" }], messages: [], tools: { a: {} }, options: { b: 1 } };
		summaries.shape(event);
		expect(event).toEqual({ sessionID: "ses_theirs", system: [{ type: "text", text: "x" }], messages: [], tools: { a: {} }, options: { b: 1 } });
		await expect(summaries.complete("opencode/big-pickle", "s", [], {})).rejects.toThrow(FREE_REASON);
		expect(oc.made).toEqual([]);
		let release: () => void = () => {};
		oc.access.generate = () => new Promise((done) => (release = () => done({ text: "late" })));
		const abort = new AbortController();
		const pending = summaries.complete("fake/fake-model", "s", [], { signal: abort.signal });
		await new Promise((wait) => setTimeout(wait, 10));
		abort.abort(new Error("closing"));
		await expect(pending).rejects.toThrow("closing");
		release();
		await new Promise((wait) => setTimeout(wait, 0));
		expect(oc.removed).toEqual(["ses_1"]);
	});

	it("waits for OpenCode to list a model it lists only once its plugins are set up, and gives up after its time", async () => {
		const summaries = new OpenCodeSummaries("Atlas");
		const oc = host(summaries);
		let asked = 0;
		oc.access.listModels = async () => (++asked < 3 ? { data: [] } : LIST);
		await summaries.waitFor("fake/fake-model", 5000);
		expect([asked, summaries.find("fake/fake-model") !== undefined]).toEqual([3, true]);
		const started = Date.now();
		await summaries.waitFor("fake/never", 300);
		expect(Date.now() - started).toBeLessThan(2000);
		expect(summaries.find("fake/never")).toBeUndefined();
	});

	it("never returns a reply whose request Orrery's generate hook didn't shape (OpenCode's own prompt and tools would have gone): nothing is saved", async () => {
		const summaries = new OpenCodeSummaries("Atlas");
		const oc = host(summaries);
		await summaries.refresh();
		oc.access.generate = async () => ({ text: "OpenCode's own reply" });
		await expect(summaries.complete("fake/fake-model", "s", [], {})).rejects.toThrow(/generate hook did not shape/);
		await new Promise((wait) => setTimeout(wait, 0));
		expect(oc.removed).toEqual(["ses_1"]);
	});

	it("reads a model's status again before a summary when its list is old: a model gone free since is refused", async () => {
		let now = 0;
		const summaries = new OpenCodeSummaries("Atlas", { now: () => now, maxAgeMs: 60_000 });
		const oc = host(summaries);
		let list: unknown = LIST;
		oc.access.listModels = async () => list;
		await summaries.refresh();
		expect(await summaries.complete("fake/fake-model", "s", [], {})).toBe("the summary");
		list = { data: [{ ...LIST.data[0], providerID: "fake", cost: [], settings: { baseURL: "https://opencode.ai/zen/v1" } }] };
		now = 30_000;
		expect(await summaries.complete("fake/fake-model", "s", [], {})).toBe("the summary");
		now = 61_000;
		await expect(summaries.complete("fake/fake-model", "s", [], {})).rejects.toThrow(FREE_REASON);
	});

	it("keeps a list of the summary sessions it makes until they are removed, and removes what a crash left", async () => {
		const ledger = join(mkdtempSync(join(tmpdir(), "orrery-summary-ledger-")), "opencode-summaries.json");
		writeFileSync(ledger, JSON.stringify(["ses_left_1", "ses_left_2"]));
		const summaries = new OpenCodeSummaries("Atlas", { ledger });
		const oc = host(summaries);
		await summaries.cleanLeftovers();
		expect(oc.removed).toEqual(["ses_left_1", "ses_left_2"]);
		expect(JSON.parse(readFileSync(ledger, "utf8"))).toEqual([]);
		await summaries.refresh();
		let during: unknown;
		const generate = oc.access.generate;
		oc.access.generate = async (input, options) => {
			during = JSON.parse(readFileSync(ledger, "utf8"));
			return generate(input, options);
		};
		await summaries.complete("fake/fake-model", "s", [], {});
		await new Promise((wait) => setTimeout(wait, 0));
		expect(during).toEqual(["ses_1"]);
		expect(JSON.parse(readFileSync(ledger, "utf8"))).toEqual([]);
		expect(statSync(ledger).mode & 0o777).toBe(0o600);
	});

	it("goes through the latest folder still open, and says so when none is", async () => {
		const summaries = new OpenCodeSummaries("Atlas");
		await expect(summaries.complete("fake/fake-model", "s", [], {})).rejects.toThrow(/no folder open/);
		const first = host(summaries);
		const second = host(summaries);
		await summaries.refresh();
		await summaries.complete("fake/fake-model", "s", [], {});
		expect([first.made.length, second.made.length]).toEqual([0, 1]);
		summaries.removeHost(second.access);
		await summaries.complete("fake/fake-model", "s", [], {});
		expect([first.made.length, second.made.length]).toEqual([1, 1]);
	});
});
