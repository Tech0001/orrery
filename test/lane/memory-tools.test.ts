import { PassThrough } from "node:stream";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LaneTool, memoryTools, readerTools, withLaneView } from "../../src/lane/memory-tools.ts";
import { laneTools, runMcp } from "../../src/claude/mcp.ts";
import { readerTools as piReaderTools } from "../../src/pi/tools.ts";
import type { OrreryState } from "../../src/pi/index.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import * as remoteIndex from "../../src/remote/index.ts";
import { removeRemoteSecret } from "../../src/remote/secrets.ts";
import { RemoteError } from "../../src/remote/types.ts";
import { readCopyFixture } from "../remote/read-copy-fixture.ts";
import { cleanup, world } from "../pi/world.ts";
import { seedAtlas } from "./support.ts";

afterEach(cleanup);

const run = (tools: LaneTool[], name: string, params: object = {}) => {
	const tool = tools.find((t) => t.name === name);
	if (tool === undefined) throw new Error(`no tool ${name}`);
	return tool.run(params as Record<string, unknown>);
};

describe("memory tools for any agent", () => {
	it("zoom, date and search read a read-only snapshot of the lane's memory", () => {
		const { root, config } = world();
		seedAtlas(root);
		const tools = memoryTools((use) => withLaneView(config.lanes.get("Atlas")!, use));
		expect(tools.map((tool) => [tool.name, tool.long])).toEqual([["zoom", true], ["date", false], ["search", false]]);
		expect(run(tools, "zoom", { id: 0, n: 1 })).toContain("garden-plants");
		expect(run(tools, "date", { id: 0 })).toContain("2026-02-10");
		expect(run(tools, "search", { query: "garden-plants" })).toContain("#0 2026-02-10 user");
		const empty = memoryTools((use) => withLaneView(config.lanes.get("Birch")!, use));
		expect(() => run(empty, "date", { id: 0 })).toThrow(/Birch has no memory yet/);
	});

	it("lets a reader list lanes and read the lanes it may read, read-only, and no others", () => {
		const { root, config } = world();
		seedAtlas(root);
		const birch = readerTools(() => config.lanes.get("Birch")!, config);
		expect(run(birch, "lanes")).toMatch(/Atlas: 2 messages, last 2026-02-10, closed/);
		expect(run(birch, "lane_memory", { lane: "atlas", action: "view" })).toContain("<chat>");
		expect(run(birch, "lane_memory", { lane: "Atlas", action: "search", query: "plant group" })).toContain("#0");
		expect(birch.find((tool) => tool.name === "lane_memory")?.long).toBe(true);
		const atlas = readerTools(() => config.lanes.get("Atlas")!, config);
		expect(() => run(atlas, "lane_memory", { lane: "Birch", action: "view" })).toThrow(/Atlas may not read Birch/);
	});
});

describe("remote memory tools", () => {
	let f: Awaited<ReturnType<typeof readCopyFixture>>;
	beforeEach(async () => {
		f = await readCopyFixture();
		vi.spyOn(remoteIndex, "openStorage").mockReturnValue(f.storage);
		vi.spyOn(Date, "now").mockImplementation(f.now);
	});
	afterEach(() => { vi.restoreAllMocks(); f.close(); });
	const tools = () => readerTools(() => f.config.lanes.get("Birch")!, f.config);

	it.each(["unreachable", "quota"] as const)("marks a remote %s answer with its refresh time", async (kind) => {
		expect(await run(tools(), "lane_memory", { lane: "Atlas", action: "zoom", id: 0, n: 1 })).toContain("from the snapshot");
		f.clock.value += 60_000;
		vi.spyOn(f.storage, "fetch").mockRejectedValue(new RemoteError(kind, "temporarily unavailable"));
		expect(await run(tools(), "lane_memory", { lane: "Atlas", action: "view" })).toMatch(/^\(as of 14:02\)\n/);
	});

	it("refuses a non-reader before any remote fetch", () => {
		const fetch = vi.spyOn(f.storage, "fetch");
		const cedar = readerTools(() => f.config.lanes.get("Cedar")!, f.config);
		expect(() => run(cedar, "lane_memory", { lane: "Atlas", action: "view" })).toThrow(/Cedar may not read Atlas/);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("lists the fresh remote holder by machine name", async () => {
		expect(await run(tools(), "lanes")).toMatch(/Atlas: 1 messages, last .*open on macbook/);
	});

	it("lists only cached remote facts for lanes the caller may not read, without creating a copy", async () => {
		await f.save();
		const fetch = vi.spyOn(f.storage, "fetch");
		const list = vi.spyOn(f.storage, "list");
		const cedar = () => readerTools(() => f.config.lanes.get("Cedar")!, f.config);
		expect(await run(cedar(), "lanes")).toMatch(/^Atlas: 1 save, open on macbook$/m);
		await f.save("another save");
		f.clock.value += 29_999;
		expect(await run(cedar(), "lanes")).toMatch(/^Atlas: 1 save, open on macbook$/m);
		expect(list).toHaveBeenCalledTimes(1);
		f.clock.value += 1;
		expect(await run(cedar(), "lanes")).toMatch(/^Atlas: 2 saves, open on macbook$/m);
		expect(list).toHaveBeenCalledTimes(2);
		expect(fetch).not.toHaveBeenCalled();
		expect(existsSync(join(f.config.dataDir, "read-copies", "Atlas"))).toBe(false);
	});

	it("does not open an existing read copy or live working copy for a non-reader's listing", async () => {
		await run(tools(), "lane_memory", { lane: "Atlas", action: "view" });
		const working = MemoryStore.open(join(f.lane.dir, "memory.sqlite"));
		try {
			working.append("user", "private unsaved message");
			writeFileSync(join(f.lane.dir, "status.json"), JSON.stringify({ open: true, pid: process.pid }));
			const open = vi.spyOn(MemoryStore, "openReadOnly");
			const fetch = vi.spyOn(f.storage, "fetch");
			const cedar = readerTools(() => f.config.lanes.get("Cedar")!, f.config);
			expect(await run(cedar, "lanes")).toMatch(/^Atlas: 0 saves, open on macbook$/m);
			expect(open).not.toHaveBeenCalled();
			expect(fetch).not.toHaveBeenCalled();
		} finally { working.close(); }
	});

	it.each(["self", "wildcard"])("still fetches message counts for %s permission", async (kind) => {
		const reader = kind === "self" ? f.lane : { ...f.config.lanes.get("Cedar")!, reads: ["*"] };
		const fetch = vi.spyOn(f.storage, "fetch");
		expect(await run(readerTools(() => reader, f.config), "lanes")).toMatch(/^Atlas: 1 messages, last .*open on macbook$/m);
		expect(fetch).toHaveBeenCalledWith("Atlas", -1);
	});

	it("does not label an unreachable remote lane as closed", async () => {
		await run(tools(), "lanes");
		f.clock.value += 60_000;
		vi.spyOn(f.storage, "fetch").mockRejectedValue(new RemoteError("unreachable", "offline"));
		vi.spyOn(f.storage, "list").mockRejectedValue(new RemoteError("unreachable", "offline"));
		expect(await run(tools(), "lanes")).toMatch(/^\(as of 14:02\) Atlas: .*remote status unavailable/m);
	});

	it("explains the missing remote key in the tool's error", async () => {
		removeRemoteSecret(f.config, "home");
		await expect(Promise.resolve().then(() => run(tools(), "lane_memory", { lane: "Atlas", action: "view" }))).rejects.toThrow(/key for remote home isn't on this machine/);
	});

	it("pi waits for a remote memory tool before returning its text", async () => {
		const state = { lane: { config: f.config.lanes.get("Birch")! } } as OrreryState;
		const tool = piReaderTools(state, f.config).find((tool) => tool.name === "lane_memory")!;
		const result = await tool.execute("read", { lane: "Atlas", action: "zoom", id: 0, n: 1 }, undefined, undefined, {} as Parameters<typeof tool.execute>[4]);
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("from the snapshot") });
	});

	it("MCP waits for remote reads through EOF and reports rejected reads as tool errors", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		let text = "";
		output.setEncoding("utf8").on("data", (chunk: string) => { text += chunk; });
		const done = runMcp(input, output, laneTools(f.config, f.config.lanes.get("Birch")!));
		input.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lane_memory", arguments: { lane: "Atlas", action: "zoom", id: 0, n: 1 } } })}\n`);
		await done;
		expect(JSON.parse(text).result.content[0].text).toContain("from the snapshot");
		removeRemoteSecret(f.config, "home");
		const own = laneTools(f.config, f.lane);
		const failingInput = new PassThrough();
		const failingOutput = new PassThrough();
		let errorText = "";
		failingOutput.setEncoding("utf8").on("data", (chunk: string) => { errorText += chunk; });
		const failed = runMcp(failingInput, failingOutput, own);
		failingInput.end(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "zoom", arguments: { id: 0, n: 1 } } })}\n`);
		await failed;
		expect(JSON.parse(errorText).result).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining("isn't on this machine") }] });
	});
});
