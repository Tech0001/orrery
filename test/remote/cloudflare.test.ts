import { createHash, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudflareStorage } from "../../src/remote/cloudflare.ts";
import { storageContract } from "./contract.ts";
import { hasWorkerTools, startLocalWorker } from "./cloudflare-worker-support.ts";

const remote = { name: "cloud", kind: "cloudflare", url: "http://127.0.0.1:8787" } as const;
const holder = { machine: "pc", device: "device-a", pid: 12 };
const bytes = (text: string) => new TextEncoder().encode(text);
const workers: Awaited<ReturnType<typeof startLocalWorker>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(workers.splice(0).map((worker) => worker.stop())); });
async function setup(staleMs?: number) {
	const worker = await startLocalWorker(staleMs); workers.push(worker);
	return { ...worker, storage: new CloudflareStorage(remote, "test-token", { fetch: worker.fetch }) };
}

describe.skipIf(!hasWorkerTools)("Cloudflare storage (requires worker/node_modules; npm install --ignore-scripts in worker)", () => {
	storageContract("cloudflare (local Worker and SQLite Durable Objects)", async () => {
		const worker = await startLocalWorker();
		return { storage: new CloudflareStorage(remote, "test-token", { fetch: worker.fetch }), cleanup: worker.stop };
	}, { realClock: true });

	it("refuses a wrong token as auth", async () => {
		const worker = await setup();
		await expect(new CloudflareStorage(remote, "wrong", { fetch: worker.fetch }).list()).rejects.toMatchObject({ kind: "auth" });
	});

	it("chunks a 3 MiB snapshot into 1 MiB parts", async () => {
		const worker = await setup(); const sizes: number[] = [];
		const storage = new CloudflareStorage(remote, "test-token", { fetch: (input, init) => {
			if (String(input).includes("/snapshots/")) sizes.push((init!.body as Uint8Array).byteLength);
			return worker.fetch(input, init);
		} });
		const taken = await storage.take("Atlas", holder); if (!taken.ok) throw new Error("take failed");
		const file = new Uint8Array(randomBytes(3 * 1024 * 1024));
		await storage.snapshot("Atlas", taken.lock, 0, file);
		expect(sizes).toEqual([1048576, 1048576, 1048576]);
		expect((await storage.fetch("Atlas", -1)).snapshot?.file).toEqual(file);
	});

	it("round-trips a 53 MiB first push without a per-value or fixed 15 second deadline", async () => {
		const { storage } = await setup();
		await storage.take("Atlas", holder);
		const file = new Uint8Array(53 * 1024 * 1024).fill(117);
		await storage.snapshot("Atlas", 1, 0, file);
		const got = (await storage.fetch("Atlas", -1)).snapshot!.file;
		expect(got.byteLength).toBe(file.byteLength);
		expect(createHash("sha256").update(got).digest("hex")).toBe(createHash("sha256").update(file).digest("hex"));
	});

	it("round-trips saves bigger than the SQLite row limit", async () => {
		const { storage } = await setup();
		const taken = await storage.take("Atlas", holder); if (!taken.ok) throw new Error("take failed");
		const file = new Uint8Array(randomBytes(3 * 1024 * 1024 + 17));
		await storage.save("Atlas", taken.lock, 1, file, bytes("log"));
		expect((await storage.fetch("Atlas", 0)).saves[0].file).toEqual(file);
	});

	it("uses the object's clock for staleness and refuses the old holder after takeover", async () => {
		const { storage } = await setup(150);
		await storage.take("Atlas", holder);
		const other = { ...holder, machine: "mac", device: "device-b" };
		vi.spyOn(Date, "now").mockReturnValue(0); // The client clock disagrees by decades.
		expect((await storage.take("Atlas", other, { force: true })).ok).toBe(false);
		await new Promise((done) => setTimeout(done, 180));
		expect((await storage.list())[0].lock?.stale).toBe(true);
		expect((await storage.take("Atlas", other)).ok).toBe(false);
		expect(await storage.take("Atlas", other, { force: true })).toMatchObject({ ok: true, lock: 2 });
		await expect(storage.renew("Atlas", 1)).rejects.toMatchObject({ kind: "lock-lost" });
		await expect(storage.save("Atlas", 1, 1, bytes("late"), bytes("log"))).rejects.toMatchObject({ kind: "lock-lost" });
		await storage.release("Atlas", 1);
		expect((await storage.list())[0].lock?.holder.machine).toBe("mac");
	});

	it("renews a live lock before the stale interval", async () => {
		const { storage } = await setup(300);
		await storage.take("Atlas", holder);
		await new Promise((done) => setTimeout(done, 180));
		await storage.renew("Atlas", 1);
		await new Promise((done) => setTimeout(done, 180));
		expect((await storage.take("Atlas", { ...holder, device: "b" }, { force: true })).ok).toBe(false);
	});

	it("keeps a dropped lane deleted if the index deletion's successful reply is lost", async () => {
		const worker = await startLocalWorker(180_000, { failIndexDelete: true }); workers.push(worker);
		const storage = new CloudflareStorage(remote, "test-token", { fetch: worker.fetch });
		await storage.take("Atlas", holder);
		await expect(storage.drop("Atlas", 1)).rejects.toMatchObject({ kind: "unreachable" });
		await expect(storage.fetch("Atlas", -1)).rejects.toMatchObject({ kind: "not-found" });
		expect(await storage.take("Atlas", holder)).toMatchObject({ ok: true, lock: 2 });
		expect((await storage.list()).map((lane) => lane.lane)).toEqual(["Atlas"]);
	});

	it("refetches a coherent snapshot when the same save number changes during download", async () => {
		const worker = await setup();
		await worker.storage.take("Atlas", holder);
		const original = new Uint8Array(2 * 1024 * 1024).fill(1);
		const replacement = new Uint8Array(2 * 1024 * 1024).fill(2);
		await worker.storage.snapshot("Atlas", 1, 0, original);
		let replaced = false;
		const reader = new CloudflareStorage(remote, "test-token", { fetch: async (input, init) => {
			const response = await worker.fetch(input, init);
			if (!replaced && String(input).includes("/files/snapshot/0?part=0")) {
				const body = await response.arrayBuffer(); // Ensure the old part is received first.
				replaced = true;
				await worker.storage.snapshot("Atlas", 1, 0, replacement);
				return new Response(body, { status: response.status, headers: response.headers });
			}
			return response;
		} });
		const fetched = (await reader.fetch("Atlas", -1)).snapshot!.file;
		expect(createHash("sha256").update(fetched).digest("hex")).toBe(createHash("sha256").update(replacement).digest("hex"));
	});

	it("retries a save after its successful reply was lost", async () => {
		const worker = await setup(); let loseReply = true;
		const storage = new CloudflareStorage(remote, "test-token", { fetch: async (input, init) => {
			const response = await worker.fetch(input, init);
			if (String(input).includes("/saves/") && loseReply) { loseReply = false; throw new TypeError("connection lost"); }
			return response;
		} });
		await storage.take("Atlas", holder);
		await expect(storage.save("Atlas", 1, 1, bytes("saved"), bytes("audit"))).rejects.toMatchObject({ kind: "unreachable" });
		await storage.save("Atlas", 1, 1, bytes("saved"), bytes("audit"));
		expect((await storage.fetch("Atlas", 0)).saves).toEqual([{ n: 1, file: bytes("saved") }]);
		expect(await storage.log("Atlas")).toEqual([{ n: 1, file: bytes("audit") }]);
	});
});

describe("Cloudflare HTTP errors and deadlines (no Worker tools needed)", () => {
	it("lets 250 slow save GETs each use their own request budget", async () => {
		let elapsed = 0;
		const expires = new WeakMap<AbortSignal, number>();
		vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
			const signal = new AbortController().signal;
			expires.set(signal, elapsed + ms);
			return signal;
		});
		const storage = new CloudflareStorage(remote, "token", { fetch: async (input, init) => {
			elapsed += 1000;
			if (elapsed >= expires.get(init!.signal!)!) throw new DOMException("slow request deadline", "TimeoutError");
			if (String(input).includes("/fetch?")) return Response.json({ saves: Array.from({ length: 250 }, (_, i) => i + 1), newestSave: 250, bytes: 250 });
			return new Response(new Uint8Array([1]));
		} });
		const fetched = await storage.fetch("Atlas", 0);
		expect(fetched.saves).toHaveLength(250);
		expect(fetched.newestSave).toBe(250);
		expect(elapsed).toBe(251_000);
	});
	it.each(["request id: 1027", "upstream 1027 unavailable", "error code: 10270"])("does not classify unrelated text as a Cloudflare quota page: %s", async (body) => {
		const storage = new CloudflareStorage(remote, "token", { fetch: async () => new Response(body, { status: 502 }) });
		await expect(storage.list()).rejects.toMatchObject({ kind: "unreachable" });
	});
	it("recognizes status 429 without a Cloudflare error page", async () => {
		const storage = new CloudflareStorage(remote, "token", { fetch: async () => new Response("too many requests", { status: 429 }) });
		await expect(storage.list()).rejects.toMatchObject({ kind: "quota" });
	});
	it.each([403, 429, 500])("maps a daily-limit response (%s) to quota with the reset time", async (status) => {
		const storage = new CloudflareStorage(remote, "token", { fetch: async () => new Response("error code: 1027", { status }) });
		await expect(storage.list()).rejects.toMatchObject({ kind: "quota", message: "remote cloud is over Cloudflare's daily free limit until 00:00 UTC" });
	});
	it.each([[401, "auth"], [403, "auth"], [404, "not-found"], [502, "unreachable"], [400, "refused"]])("maps HTTP %s to %s", async (status, kind) => {
		const storage = new CloudflareStorage(remote, "token", { fetch: async () => new Response("refused", { status: status as number }) });
		await expect(storage.fetch("Atlas", 0)).rejects.toMatchObject({ kind });
	});
	it.each(["lock-lost", "out-of-order"])("preserves %s from a conflict", async (error) => {
		const storage = new CloudflareStorage(remote, "token", { fetch: async () => Response.json({ error }, { status: 409 }) });
		await expect(storage.renew("Atlas", 1)).rejects.toMatchObject({ kind: error });
	});
	it.each([new TypeError("offline"), new DOMException("deadline", "TimeoutError")])("maps network and timeout failures to unreachable", async (error) => {
		const storage = new CloudflareStorage(remote, "token", { fetch: async () => { throw error; } });
		await expect(storage.list()).rejects.toMatchObject({ kind: "unreachable" });
	});
	it("includes body read failures in unreachable errors", async () => {
		const storage = new CloudflareStorage(remote, "token", { fetch: async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("disconnected")); } })) });
		await expect(storage.list()).rejects.toMatchObject({ kind: "unreachable" });
	});
	it.each([
		["fetch", { snapshot: null, saves: [], newestSave: 0 }],
		["log", [null]],
		["take", null],
		["list", {}],
	] as const)("maps malformed %s replies to corrupt", async (operation, body) => {
		const storage = new CloudflareStorage(remote, "token", { fetch: async () => Response.json(body) });
		const result = operation === "fetch" ? storage.fetch("Atlas", -1) : operation === "log" ? storage.log("Atlas") : operation === "take" ? storage.take("Atlas", holder) : storage.list();
		await expect(result).rejects.toMatchObject({ kind: "corrupt" });
	});
	it("limits retries when snapshot generations keep changing", async () => {
		let manifests = 0;
		const storage = new CloudflareStorage(remote, "token", { fetch: async (input) => {
			if (String(input).includes("/fetch?")) { manifests++; return Response.json({ snapshot: { n: 0, parts: 1, generation: "generation" }, saves: [], newestSave: 0 }); }
			return Response.json({ error: "out-of-order" }, { status: 409 });
		} });
		await expect(storage.fetch("Atlas", -1)).rejects.toMatchObject({ kind: "unreachable" });
		expect(manifests).toBe(3);
	});

	it("rejects unsafe lane names before sending a request", async () => {
		let calls = 0;
		const storage = new CloudflareStorage(remote, "token", { fetch: async () => { calls++; return Response.json([]); } });
		await expect(storage.fetch("../check", 0)).rejects.toMatchObject({ kind: "refused" });
		expect(calls).toBe(0);
	});
	it("scales snapshot and fetch deadlines with their sizes, and never follows redirects", async () => {
		const deadlines: number[] = []; const redirects: RequestInit["redirect"][] = [];
		vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => { deadlines.push(ms); return new AbortController().signal; });
		const storage = new CloudflareStorage(remote, "token", { fetch: async (input, init) => {
			redirects.push(init?.redirect);
			if (String(input).includes("/fetch?")) return Response.json({ snapshot: { n: 0, parts: 3 }, saves: [], newestSave: 0, bytes: 3 * 1024 * 1024 });
			return new Response(init?.method === "PUT" ? null : new Uint8Array(1024 * 1024), { status: init?.method === "PUT" ? 204 : 200 });
		} });
		await storage.snapshot("Atlas", 1, 0, new Uint8Array(3 * 1024 * 1024));
		await storage.fetch("Atlas", -1);
		expect(deadlines).toEqual([16000, 16000, 16000, 15000, 16000, 16000, 16000]);
		expect(redirects.every((value) => value === "manual")).toBe(true);
	});
});
