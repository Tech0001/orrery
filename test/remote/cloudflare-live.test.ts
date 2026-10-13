/**
 * Optional live check against a real Cloudflare Worker (the counterpart of server.test.ts's real-SSH case). Skipped
 * unless ORRERY_TEST_CF_URL and ORRERY_TEST_CF_TOKEN_FILE name a deployed Worker and a file holding its token. Each run
 * uses its own lane names and drops them afterwards; the key check is left alone (a real remote has one already).
 */

import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/memory/store.ts";
import { CloudflareStorage } from "../../src/remote/cloudflare.ts";
import { createKey, unseal } from "../../src/remote/crypto.ts";
import type { LaneSettings } from "../../src/remote/save-format.ts";
import { RemoteSession, type RemoteSessionOptions } from "../../src/remote/session.ts";
import type { Holder, Storage } from "../../src/remote/types.ts";

const url = process.env.ORRERY_TEST_CF_URL;
const tokenFile = process.env.ORRERY_TEST_CF_TOKEN_FILE;
const settings: LaneSettings = { compactorModel: "openai/gpt-5.1-mini", compactorThinking: "low", tool: "pi" };
const pc: Holder = { machine: "pc", device: "device-pc-live", pid: process.pid };
const mac: Holder = { machine: "macbook", device: "device-mac-live", pid: process.pid };

describe.skipIf(url === undefined || tokenFile === undefined)("cloudflare kind against a real Worker", () => {
	const root = mkdtempSync(join(tmpdir(), "orrery-cf-live-"));
	const run = `L${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
	const lane = `${run}a`;
	// Built only when the live settings are there: a skipped describe still runs its body.
	const storage = (url === undefined || tokenFile === undefined ? undefined : new CloudflareStorage({ name: "live", kind: "cloudflare", url }, readFileSync(tokenFile, "utf8").trim())) as Storage;
	const key = createKey();
	const machine = (name: string, holder: Holder): RemoteSessionOptions => ({ lane, laneDir: join(root, name, lane), storage, key, holder, report: () => {}, renewMs: 0, settings });
	const texts = (o: RemoteSessionOptions) => {
		const store = MemoryStore.openReadOnly(join(o.laneDir, "memory.sqlite"));
		try {
			return store.root.map((m) => m.text);
		} finally {
			store.close();
		}
	};

	afterAll(async () => {
		if (storage === undefined) return;
		for (const name of [lane, `${run}big`]) {
			const taken = await storage.take(name, pc, { force: true }).catch(() => undefined);
			if (taken?.ok) await storage.drop(name, taken.lock).catch(() => {});
		}
		rmSync(root, { recursive: true, force: true });
	});

	it("moves a lane between two machines through the real Worker, refusing a second holder", async () => {
		const a = machine("pc", pc);
		const seed = MemoryStore.open(join(a.laneDir, "memory.sqlite"));
		seed.append("user", "written on the pc");
		seed.close();
		await RemoteSession.push(a);

		const b = machine("mac", mac);
		const onMac = await RemoteSession.checkOut(b);
		const macStore = MemoryStore.open(join(b.laneDir, "memory.sqlite"));
		onMac.attach(macStore);
		expect(macStore.root.map((m) => m.text)).toEqual(["written on the pc"]);
		macStore.append("talk", "written on the macbook");
		await onMac.save();
		expect(onMac.status().state).toBe("saved");

		await expect(RemoteSession.checkOut(a)).rejects.toMatchObject({ kind: "held", message: expect.stringContaining("open on macbook") });

		await onMac.close();
		macStore.close();

		const back = await RemoteSession.checkOut(a);
		await back.close();
		expect(texts(a)).toEqual(["written on the pc", "written on the macbook"]);

		const log = await storage.log(lane);
		const machines = log.map((entry) => JSON.parse(Buffer.from(unseal(key, lane, "log", entry.n, entry.file)).toString("utf8")).machine);
		expect(machines).toEqual(["macbook"]);
	}, 120_000);

	it("round-trips a 3 MiB snapshot in 1 MiB parts", async () => {
		const name = `${run}big`;
		const taken = await storage.take(name, pc);
		if (!taken.ok) throw new Error("take failed");
		const big = new Uint8Array(randomBytes(3 * 1024 * 1024 + 17));
		await storage.snapshot(name, taken.lock, 0, big);
		const fetched = await storage.fetch(name, -1);
		expect(fetched.snapshot?.file).toEqual(big);
		await storage.drop(name, taken.lock);
	}, 120_000);

	it("refuses a wrong token as auth", async () => {
		const wrong = new CloudflareStorage({ name: "live", kind: "cloudflare", url: url ?? "" }, "not-the-token");
		await expect(wrong.list()).rejects.toMatchObject({ kind: "auth" });
	});
});
