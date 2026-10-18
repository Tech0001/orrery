import { rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../../src/agent/config.ts";
import { FileCredentialStore } from "../../src/agent/credentials.ts";
import { agentModelSource, type ModelSource, sourceCompactorModel } from "../../src/agent/model-source.ts";
import { compactorModel, createAgentModels } from "../../src/agent/models.ts";
import { agentSummarizer } from "../../src/agent/summarizer.ts";
import { type CompactorModel, MemoryStore, sentNoRequest } from "../../src/memory/index.ts";
import { Part } from "../../src/memory/types.ts";
import { OpenCodeSummaries, withOpenCode } from "../../src/opencode/summaries.ts";
import { agentConfigToml, fauxModels, tempDir } from "./support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const signal = AbortSignal.timeout(20_000);
const turns = [{ role: "user" as const, blocks: ["user: hello"] }];
const failure = (model: CompactorModel) => model.complete("S", turns, signal).then(
	() => undefined,
	(error: unknown) => error,
);

/** A server that answers every request with an HTTP 400 (no retry), counting them. */
async function refusingServer() {
	let hits = 0;
	const server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			hits += 1;
			res.writeHead(400, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "bad request", type: "invalid_request_error" } }));
		});
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, hits: () => hits, close: () => server.close() };
}

describe("a summary attempt that sent no request is no usage row", () => {
	it("in every tool's path (pi-ai directly, and through a model source): no login saved sends nothing; a provider's HTTP error was sent", async () => {
		const dir = tempDir("orrery-usage-");
		dirs.push(dir);
		const server = await refusingServer();
		try {
			// Saved logins only, and none saved: no ambient key, so no request can leave for a built-in provider.
			const models = createAgentModels({
				credentials: new FileCredentialStore(join(dir, "credentials.json")),
				providers: [{ id: "local", baseUrl: server.baseUrl, models: [{ id: "m", name: "m", contextWindow: 128_000, maxTokens: 4096, reasoning: false }] }],
				savedLoginsOnly: true,
			});
			const signedOut = { provider: "openrouter", modelId: models.getModels("openrouter")[0]?.id as string, thinking: "off" as const };
			const local = { provider: "local", modelId: "m", thinking: "off" as const };
			const paths: [string, (choice: typeof local) => CompactorModel][] = [
				["orrery run (pi-ai directly)", (choice) => compactorModel(models, choice, "compactor:Test")],
				["pi, OMP, Claude Code, Codex (a model source)", (choice) => sourceCompactorModel(agentModelSource(models), choice, "compactor:Test").model],
			];
			for (const [name, make] of paths) {
				const unsent = await failure(make(signedOut));
				expect([name, unsent instanceof Error, sentNoRequest(unsent)]).toEqual([name, true, true]);
				const before = server.hits();
				const refused = await failure(make(local));
				expect([name, refused instanceof Error, sentNoRequest(refused)]).toEqual([name, true, false]);
				expect(server.hits()).toBe(before + 1);
			}
			// The rows themselves, through the agent's summarizer: none for the attempt that sent nothing, one for the 400.
			const config = parseConfig(agentConfigToml({ dataDir: join(dir, "data"), folder: join(dir, "ws") }), dir).agents.get("Test")!;
			const store = MemoryStore.open(join(dir, "memory.sqlite"));
			try {
				const task = { part: new Part(0, 0), context: { blocks: [], mark: -1 }, source: "user: hello" };
				for (const choice of [signedOut, local]) {
					await expect(agentSummarizer(config, sourceCompactorModel(agentModelSource(models), choice, "s").model, 128_000, store).summarize(task, signal)).rejects.toThrow();
				}
				expect(store.usageRows().map((row) => [row.model, row.ok, row.input])).toEqual([["local/m", false, 0]]);
			} finally {
				store.close();
			}
		} finally {
			server.close();
		}
	}, 60_000);

	it("keeps a row for a failure of a provider that doesn't say when it sends (the faux one here): it may have sent", async () => {
		const { compactor, models } = fauxModels();
		compactor.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "rate limited" }), fauxAssistantMessage("", { stopReason: "error", errorMessage: "rate limited" })]);
		const choice = { provider: "faux-compactor", modelId: "faux-1", thinking: "off" as const };
		expect(sentNoRequest(await failure(compactorModel(models, choice, "s")))).toBe(false);
		expect(sentNoRequest(await failure(sourceCompactorModel(agentModelSource(models), choice, "s").model))).toBe(false);
	});

	it("in OpenCode: a model it can't use, or no folder open, sends nothing; a failure once the request went is sent", async () => {
		const summaries = new OpenCodeSummaries("Atlas");
		const orrery: ModelSource = { find: () => undefined, streamSimple: () => ({ result: async () => Promise.reject(new Error("not Orrery's")) }) };
		const source = withOpenCode(orrery, summaries);
		let generated = 0;
		summaries.addHost({
			directory: "/work/ws",
			listModels: async () => ({ data: [{ id: "fake-model", providerID: "fake", name: "Fake", enabled: true, cost: [], limit: { context: 200_000, output: 4096 }, variants: [] }] }),
			createSession: async () => ({ id: "ses_1" }),
			generate: async () => {
				generated += 1;
				throw new Error("provider said 500");
			},
			removeSession: async () => {},
		});
		await summaries.refresh();
		const model = sourceCompactorModel(source, { provider: "opencode", modelId: "fake/fake-model", thinking: "off" }, "s").model;
		const sent = await failure(model);
		expect([String(sent), sentNoRequest(sent), generated]).toEqual(["Error: provider said 500", false, 1]);
		// Gone from OpenCode's list since (or turned free): refused before any request.
		summaries.disable("the plugin stopped");
		const unsent = await failure(model);
		expect([sentNoRequest(unsent), generated]).toEqual([true, 1]);
	});
});
