import { afterEach, describe, expect, it } from "vitest";
import { hasWorkerTools, startLocalWorker } from "./cloudflare-worker-support.ts";

const holder = { machine: "pc", device: "device-a", pid: 12 };
const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const workers: Awaited<ReturnType<typeof startLocalWorker>>[] = [];
afterEach(async () => { await Promise.all(workers.splice(0).map((worker) => worker.stop())); });
async function setup() { const worker = await startLocalWorker(); workers.push(worker); return worker; }
async function take(worker: Awaited<ReturnType<typeof setup>>) {
	const reply = await worker.request("/v1/lanes/Atlas/take", json({ holder }));
	expect(reply.status).toBe(200);
	return ((await reply.json()) as { lock: number }).lock;
}

describe.skipIf(!hasWorkerTools)("Cloudflare Worker (requires worker/node_modules; npm install --ignore-scripts in worker)", () => {
	it("authenticates every route, including unknown paths, before accessing storage", async () => {
		const worker = await setup();
		for (const path of ["/v1/lanes", "/v1/check", "/v1/lanes/Atlas/take", "/missing"]) {
			expect((await worker.request(path, { headers: { Authorization: "Bearer wrong-token-of-a-different-length" } })).status).toBe(401);
		}
		expect(await (await worker.request("/v1/lanes")).json()).toEqual([]);
	});

	it("publishes a multipart snapshot only when complete, and survives a retry of its last part", async () => {
		const worker = await setup(); const lock = await take(worker);
		const put = (part: number, body: string) => worker.request(`/v1/lanes/Atlas/snapshots/0?lock=${lock}&part=${part}&parts=2`, { method: "PUT", body });
		expect((await put(0, "first")).status).toBe(204);
		expect(await (await worker.request("/v1/lanes/Atlas/fetch?after=-1")).json()).not.toHaveProperty("snapshot");
		expect((await put(1, "last")).status).toBe(204);
		expect((await put(1, "last")).status).toBe(204);
		expect(await (await worker.request("/v1/lanes/Atlas/fetch?after=-1")).json()).toMatchObject({ snapshot: { n: 0, parts: 2 } });
		expect(await (await worker.request("/v1/lanes/Atlas/files/snapshot/0?part=0")).text()).toBe("first");
		expect(await (await worker.request("/v1/lanes/Atlas/files/snapshot/0?part=1")).text()).toBe("last");
	});

	it("replaces a snapshot at the same save number without exposing partial replacement bytes", async () => {
		const worker = await setup(); const lock = await take(worker);
		const put = (part: number, parts: number, body: string) => worker.request(`/v1/lanes/Atlas/snapshots/0?lock=${lock}&part=${part}&parts=${parts}`, { method: "PUT", body });
		expect((await put(0, 1, "original")).status).toBe(204);
		expect((await put(0, 2, "new-first")).status).toBe(204);
		expect(await (await worker.request("/v1/lanes/Atlas/files/snapshot/0?part=0")).text()).toBe("original");
		expect((await put(1, 2, "new-last")).status).toBe(204);
		expect(await (await worker.request("/v1/lanes/Atlas/files/snapshot/0?part=0")).text()).toBe("new-first");
	});

	it("does not combine an old holder's snapshot parts with a takeover's parts", async () => {
		const worker = await setup(); const lock = await take(worker);
		expect((await worker.request(`/v1/lanes/Atlas/snapshots/0?lock=${lock}&part=0&parts=2`, { method: "PUT", body: "old" })).status).toBe(204);
		const next = await (await worker.request("/v1/lanes/Atlas/take", json({ holder, force: true }))).json() as { ok: boolean; lock: number };
		expect(next.ok).toBe(true);
		expect((await worker.request(`/v1/lanes/Atlas/snapshots/0?lock=${next.lock}&part=1&parts=2`, { method: "PUT", body: "new" })).status).toBe(409);
		expect((await worker.request(`/v1/lanes/Atlas/snapshots/0?lock=${lock}&part=1&parts=2`, { method: "PUT", body: "old-last" })).status).toBe(409);
		expect(await (await worker.request("/v1/lanes/Atlas/fetch?after=-1")).json()).not.toHaveProperty("snapshot");
	});

	it("serializes competing saves and accepts identical retries including log bytes", async () => {
		const worker = await setup(); const lock = await take(worker);
		const put = (body: string, log = "audit") => worker.request(`/v1/lanes/Atlas/saves/1?lock=${lock}`, { method: "PUT", body, headers: { "x-orrery-log": Buffer.from(log).toString("base64") } });
		const replies = await Promise.all([put("a"), put("b")]);
		expect(replies.map((reply) => reply.status).sort()).toEqual([204, 409]);
		const saved = await (await worker.request("/v1/lanes/Atlas/files/save/1?part=0")).text();
		expect((await put(saved)).status).toBe(204);
		expect((await put(saved, "changed")).status).toBe(409);
	});

	it("keeps the fencing counter after a drop and recreation", async () => {
		const worker = await setup(); const lock = await take(worker);
		expect((await worker.request(`/v1/lanes/Atlas?lock=${lock}`, { method: "DELETE" })).status).toBe(204);
		expect(await (await worker.request("/v1/lanes")).json()).toEqual([]);
		const next = await take(worker);
		expect(next).toBeGreaterThan(lock);
		expect((await worker.request("/v1/lanes/Atlas/renew", json({ lock }))).status).toBe(409);
	});

	it("validates paths, holders, sequence numbers and part counts before writing", async () => {
		const worker = await setup();
		for (const lane of ["bad%20name", "1bad", "a".repeat(33)]) expect((await worker.request(`/v1/lanes/${lane}/take`, json({ holder }))).status).toBe(400);
		expect((await worker.request("/v1/lanes/Atlas/take", json({ holder: { ...holder, pid: -1 } }))).status).toBe(400);
		const lock = await take(worker);
		for (const query of ["part=1&parts=1", "part=0&parts=0", "part=0&parts=1.5"]) {
			expect((await worker.request(`/v1/lanes/Atlas/snapshots/0?lock=${lock}&${query}`, { method: "PUT", body: "x" })).status).toBe(400);
		}
		expect((await worker.request(`/v1/lanes/Atlas/snapshots/2?lock=${lock}&part=0&parts=1`, { method: "PUT", body: "future" })).status).toBe(409);
	});

	it("writes the key check once, permitting only an identical retry", async () => {
		const worker = await setup();
		expect((await worker.request("/v1/check")).status).toBe(404);
		expect((await worker.request("/v1/check", { method: "PUT", body: "check" })).status).toBe(204);
		expect((await worker.request("/v1/check", { method: "PUT", body: "check" })).status).toBe(204);
		expect((await worker.request("/v1/check", { method: "PUT", body: "other" })).status).toBe(409);
		expect(await (await worker.request("/v1/check")).text()).toBe("check");
	});
});
