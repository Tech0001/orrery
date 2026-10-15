import { existsSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { REQUEST_FRESH_MS, requestFile, takeRequest, writeRequest } from "../../src/agent/settings-request.ts";
import { tempDir } from "./support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("request.json", () => {
	it("is taken once, and removed", () => {
		const dir = tempDir("orrery-req-");
		dirs.push(dir);
		writeRequest(dir, { agent: "A", kind: "compactor", args: "openai/gpt-6.1-sol low", at: 1000 });
		expect(takeRequest(dir, "A", 2000)).toEqual({ request: { agent: "A", kind: "compactor", args: "openai/gpt-6.1-sol low", at: 1000 } });
		expect(existsSync(requestFile(dir))).toBe(false);
		expect(takeRequest(dir, "A", 2000)).toEqual({});
	});

	it("drops stale, foreign, unknown and broken requests, saying so without repeating them", () => {
		const dir = tempDir("orrery-req-");
		dirs.push(dir);
		writeRequest(dir, { agent: "A", kind: "compactor", args: "x/y low", at: 0 });
		expect(takeRequest(dir, "A", REQUEST_FRESH_MS + 1)).toEqual({ ignored: "a settings request older than 15 s" });
		writeRequest(dir, { agent: "B", kind: "compactor", args: "x/y low", at: 0 });
		expect(takeRequest(dir, "A", 1)).toEqual({ ignored: "a settings request for another agent" });
		writeFileSync(requestFile(dir), JSON.stringify({ agent: "A", kind: "delete-everything", args: "", at: 0 }));
		expect(takeRequest(dir, "A", 1)).toEqual({ ignored: "a settings request Orrery does not know" });
		writeFileSync(requestFile(dir), "{oops");
		expect(takeRequest(dir, "A", 1)).toEqual({ ignored: "a settings request that is not JSON" });
		expect(existsSync(requestFile(dir))).toBe(false);
	});
});
