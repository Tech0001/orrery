import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileCredentialStore } from "../../src/agent/credentials.ts";

let dir: string;
let file: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "orrery-cred-"));
	file = join(dir, "nested", "credentials.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const MODULE = new URL("../../src/agent/credentials.ts", import.meta.url).href;
const WORKER = `
import { FileCredentialStore } from ${JSON.stringify(MODULE)};
const store = new FileCredentialStore(process.argv[1]);
for (let i = 0; i < 10; i++) {
	await store.modify("counter", async (current) => ({ type: "api_key", key: String(Number(current?.key ?? "0") + 1) }));
}
`;

function runWorker(path: string): Promise<number> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", WORKER, path], { stdio: "ignore" });
		child.on("exit", (code) => resolve(code ?? 1));
	});
}

describe("FileCredentialStore", () => {
	it("round-trips credentials in a 0600 file", async () => {
		const store = new FileCredentialStore(file);
		expect(await store.read("openai")).toBeUndefined();
		await store.modify("openai", async () => ({ type: "oauth", access: "a", refresh: "r", expires: 1 }));
		await store.modify("omlx", async () => ({ type: "api_key", key: "k" }));
		expect(await store.read("openai")).toEqual({ type: "oauth", access: "a", refresh: "r", expires: 1 });
		expect(await store.list()).toEqual([
			{ providerId: "openai", type: "oauth" },
			{ providerId: "omlx", type: "api_key" },
		]);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		await store.delete("omlx");
		expect(await new FileCredentialStore(file).read("omlx")).toBeUndefined();
	});

	it("passes the current value under the lock and leaves it unchanged for undefined", async () => {
		const store = new FileCredentialStore(file);
		await store.modify("p", async () => ({ type: "api_key", key: "1" }));
		const seen: unknown[] = [];
		const kept = await store.modify("p", async (current) => {
			seen.push(current);
			return undefined;
		});
		expect(seen).toEqual([{ type: "api_key", key: "1" }]);
		expect(kept).toEqual({ type: "api_key", key: "1" });
	});

	it("serializes modify across processes", async () => {
		const codes = await Promise.all([runWorker(file), runWorker(file), runWorker(file)]);
		expect(codes).toEqual([0, 0, 0]);
		expect(await new FileCredentialStore(file).read("counter")).toEqual({ type: "api_key", key: "30" });
	}, 60_000);

	it("never echoes file contents (tokens) in errors about a corrupt file", async () => {
		const secret = "SECRET-1";
		mkdirSync(join(dir, "nested"), { recursive: true });
		// V8 quotes the start of the input for "Unexpected token" errors; a short file is quoted whole.
		writeFileSync(file, `x"${secret}"`);
		const store = new FileCredentialStore(file);
		const error = await store.read("anthropic").then(
			() => undefined,
			(e: unknown) => e as Error,
		);
		expect(error?.message).toMatch(/not valid JSON/);
		expect(error?.message).not.toContain("SECRET");
		expect(String(error?.stack)).not.toContain("SECRET");
	});
});
