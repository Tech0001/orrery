import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "../../src/agent/config.ts";
import { createKey, seal } from "../../src/remote/crypto.ts";
import { FakeStorage } from "../../src/remote/fake.ts";
import { decodeSnapshot, encodeSnapshot, agentSettings, remoteAgentSettings, type SnapshotHeader } from "../../src/remote/save-format.ts";

const header: SnapshotHeader = {
	v: 1, n: 0, lock: 1, machine: "pc", at: "2026-10-12T14:02:00Z",
	settings: { compactorModel: "openai/gpt-5.1-mini", compactorThinking: "low", reads: ["Birch"] },
};

describe("snapshot framing", () => {
	it("round-trips a UTF-8 header and opaque snapshot bytes using a big-endian length", () => {
		const db = new Uint8Array([0, 255, 128, 4]);
		const source = { ...header, machine: "büro 🌳" };
		const encoded = encodeSnapshot(source, db);
		expect(Buffer.from(encoded).readUInt32BE(0)).toBe(Buffer.byteLength(JSON.stringify(source)));
		const padded = new Uint8Array(encoded.length + 8);
		padded.set(encoded, 3);
		const result = decodeSnapshot(padded.subarray(3, 3 + encoded.length));
		expect(result.header).toEqual(source);
		expect([...result.db]).toEqual([...db]);
	});

	it("refuses cut-short length and header fields as corrupt", () => {
		const encoded = encodeSnapshot(header, new Uint8Array([1]));
		for (const n of [0, 1, 3, 4, encoded.length - 2]) {
			expect(() => decodeSnapshot(encoded.subarray(0, n))).toThrow(expect.objectContaining({ kind: "corrupt" }));
		}
	});

	it.each([null, {}, { ...header, v: 2 }, { ...header, n: -1 }, { ...header, at: "bad" }, { ...header, settings: {} }, { ...header, settings: { ...header.settings, reads: [3] } }])("refuses a malformed header (%#)", (value) => {
		const json = Buffer.from(JSON.stringify(value));
		const encoded = Buffer.alloc(4 + json.length + 1);
		encoded.writeUInt32BE(json.length);
		json.copy(encoded, 4);
		expect(() => decodeSnapshot(encoded)).toThrow(expect.objectContaining({ kind: "corrupt" }));
	});

	it("takes portable settings from the configured agent", () => {
		const agent = parseConfig(`[agents.Atlas]
folder = "/tmp/atlas"
tool = "omp"
compactor_model = "openai/gpt-5.1-mini"
compactor_thinking = "low"
view_bytes = 64000
node_bytes = 700
compactor_context_bytes = 24000
compactor_jobs = 3
compact_at = 180000
reads = ["*"]
`, "/tmp/config").agents.get("Atlas")!;
		expect(agentSettings(agent)).toEqual({ tool: "omp", compactorModel: "openai/gpt-5.1-mini", compactorThinking: "low", viewBytes: 64000, nodeBytes: 700, contextBytes: 24000, compactorJobs: 3, compactAt: 180000, reads: ["*"] });
	});

	it("reads settings from the newest authenticated FakeStorage snapshot", async () => {
		const storage = new FakeStorage();
		const key = createKey();
		const taken = await storage.take("Atlas", { machine: "pc", device: "a", pid: 1 });
		if (!taken.ok) throw new Error("held");
		await storage.snapshot("Atlas", taken.lock, 0, seal(key, "Atlas", "snapshot", 0, encodeSnapshot(header, new Uint8Array([1]))));
		const fetch = vi.spyOn(storage, "fetch");
		expect(await remoteAgentSettings(storage, key, "Atlas")).toEqual(header);
		expect(fetch).toHaveBeenCalledWith("Atlas", -1);
		await expect(remoteAgentSettings(storage, createKey(), "Atlas")).rejects.toMatchObject({ kind: "corrupt" });
	});
});
