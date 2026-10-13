import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Holder, RemoteError, STALE_MS, type Storage } from "../../src/remote/types.ts";

export interface Clock {
	now(): number;
	advance(ms: number): void;
}

const pc: Holder = { machine: "pc", device: "device-pc", pid: 100 };
const mac: Holder = { machine: "macbook", device: "device-mac", pid: 200 };
const bytes = (text: string) => new TextEncoder().encode(text);

async function rejects(promise: Promise<unknown>, kind: string): Promise<void> {
	await expect(promise).rejects.toBeInstanceOf(RemoteError);
	await expect(promise).rejects.toMatchObject({ kind });
}

export function storageContract(
	label: string,
	make: (clock: Clock) => Promise<{ storage: Storage; cleanup(): Promise<void> }>,
	options: { realClock?: boolean } = {},
): void {
	describe(`storage contract: ${label}`, () => {
		let storage: Storage;
		let cleanup: () => Promise<void>;
		let time = 1_000_000;
		const clock: Clock = { now: () => time, advance: (ms) => (time += ms) };
		beforeEach(async () => {
			time = 1_000_000;
			({ storage, cleanup } = await make(clock));
		});
		afterEach(async () => cleanup());

		it("creates a lane on first take, with lock 1 and no saves", async () => {
			expect(await storage.take("Atlas", pc)).toEqual({ ok: true, lock: 1, newestSave: 0 });
			expect((await storage.list()).map((l) => [l.lane, l.newestSave, l.lock?.holder.machine, l.lock?.held])).toEqual([["Atlas", 0, "pc", true]]);
		});

		it("refuses a second holder while the lock is fresh, and says who holds it", async () => {
			await storage.take("Atlas", pc);
			const second = await storage.take("Atlas", mac);
			expect(second.ok).toBe(false);
			if (!second.ok) {
				expect(second.held.holder).toEqual(pc);
				expect(second.held.stale).toBe(false);
				expect(second.held.lock).toBe(1);
			}
			const forced = await storage.take("Atlas", mac, { force: true });
			expect(forced.ok).toBe(false);
		});

		it("saves in order, fetches them, and lists the newest save", async () => {
			const taken = await storage.take("Atlas", pc);
			if (!taken.ok) throw new Error("take failed");
			await storage.save("Atlas", taken.lock, 1, bytes("one"), bytes("log-one"));
			await storage.save("Atlas", taken.lock, 2, bytes("two"), bytes("log-two"));
			const all = await storage.fetch("Atlas", 0);
			expect(all.snapshot).toBeUndefined();
			expect(all.saves.map((s) => [s.n, new TextDecoder().decode(s.file)])).toEqual([[1, "one"], [2, "two"]]);
			expect(all.newestSave).toBe(2);
			expect((await storage.fetch("Atlas", 1)).saves.map((s) => s.n)).toEqual([2]);
			expect((await storage.log("Atlas")).map((s) => s.n)).toEqual([1, 2]);
		});

		it("accepts an identical retry of the newest save and refuses a different one or a gap", async () => {
			const taken = await storage.take("Atlas", pc);
			if (!taken.ok) throw new Error("take failed");
			await storage.save("Atlas", taken.lock, 1, bytes("one"), bytes("log-one"));
			await storage.save("Atlas", taken.lock, 1, bytes("one"), bytes("log-one"));
			await rejects(storage.save("Atlas", taken.lock, 1, bytes("other"), bytes("log-other")), "out-of-order");
			await rejects(storage.save("Atlas", taken.lock, 3, bytes("three"), bytes("log-three")), "out-of-order");
			expect((await storage.fetch("Atlas", 0)).newestSave).toBe(1);
		});

		it.skipIf(options.realClock === true)("lets another machine take a stale lock only with force, and refuses the old holder after", async () => {
			const first = await storage.take("Atlas", pc);
			if (!first.ok) throw new Error("take failed");
			clock.advance(STALE_MS + 1);
			const plain = await storage.take("Atlas", mac);
			expect(plain.ok).toBe(false);
			if (!plain.ok) expect(plain.held.stale).toBe(true);
			const taken = await storage.take("Atlas", mac, { force: true });
			expect(taken).toEqual({ ok: true, lock: 2, newestSave: 0 });
			await rejects(storage.renew("Atlas", first.lock), "lock-lost");
			await rejects(storage.save("Atlas", first.lock, 1, bytes("late"), bytes("log-late")), "lock-lost");
			await storage.release("Atlas", first.lock); // no-op
			expect((await storage.list())[0].lock?.holder.machine).toBe("macbook");
		});

		it.skipIf(options.realClock === true)("keeps a renewed lock fresh past the stale time", async () => {
			const first = await storage.take("Atlas", pc);
			if (!first.ok) throw new Error("take failed");
			clock.advance(STALE_MS - 1000);
			await storage.renew("Atlas", first.lock);
			clock.advance(STALE_MS - 1000);
			const second = await storage.take("Atlas", mac, { force: true });
			expect(second.ok).toBe(false);
		});

		it("lets the same device retake its own lock with force (a crashed process on this machine)", async () => {
			const first = await storage.take("Atlas", pc);
			if (!first.ok) throw new Error("take failed");
			const again = await storage.take("Atlas", { ...pc, pid: 101 }, { force: true });
			expect(again).toEqual({ ok: true, lock: 2, newestSave: 0 });
		});

		it("raises the lock number after a release instead of reusing it", async () => {
			const first = await storage.take("Atlas", pc);
			if (!first.ok) throw new Error("take failed");
			await storage.release("Atlas", first.lock);
			expect((await storage.list())[0].lock?.held).toBe(false);
			expect(await storage.take("Atlas", mac)).toEqual({ ok: true, lock: 2, newestSave: 0 });
		});

		it("serves the newest snapshot plus later saves, prunes to three snapshots, keeps the log", async () => {
			const taken = await storage.take("Atlas", pc);
			if (!taken.ok) throw new Error("take failed");
			await storage.snapshot("Atlas", taken.lock, 0, bytes("snap-0"));
			for (let n = 1; n <= 8; n++) {
				await storage.save("Atlas", taken.lock, n, bytes(`save-${n}`), bytes(`log-${n}`));
				if (n % 2 === 0) await storage.snapshot("Atlas", taken.lock, n, bytes(`snap-${n}`));
			}
			const fresh = await storage.fetch("Atlas", 0);
			expect(fresh.snapshot?.n).toBe(8);
			expect(new TextDecoder().decode(fresh.snapshot?.file)).toBe("snap-8");
			expect(fresh.saves).toEqual([]);
			const behind = await storage.fetch("Atlas", 7);
			expect(behind.snapshot?.n).toBe(8);
			const current = await storage.fetch("Atlas", 8);
			expect(current.snapshot).toBeUndefined();
			expect(current.saves).toEqual([]);
			expect((await storage.log("Atlas")).map((e) => e.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
			// Oldest kept snapshot is 4 (keeps 4, 6, 8): saves 5..8 must still be there, so a reader at 4 can catch up.
			const atFour = await storage.fetch("Atlas", 4);
			expect(atFour.snapshot?.n).toBe(8);
		});

		it("round-trips a snapshot bigger than one chunk", async () => {
			const taken = await storage.take("Atlas", pc);
			if (!taken.ok) throw new Error("take failed");
			const big = new Uint8Array(randomBytes(3 * 1024 * 1024 + 17));
			await storage.snapshot("Atlas", taken.lock, 0, big);
			const got = await storage.fetch("Atlas", -1);
			expect(got.snapshot?.file).toEqual(big);
		});

		it("refuses snapshot and drop with an old lock", async () => {
			const first = await storage.take("Atlas", pc);
			if (!first.ok) throw new Error("take failed");
			await storage.release("Atlas", first.lock);
			await rejects(storage.snapshot("Atlas", first.lock, 0, bytes("x")), "lock-lost");
			await rejects(storage.drop("Atlas", first.lock), "lock-lost");
		});

		it("drops a lane with the current lock", async () => {
			const taken = await storage.take("Atlas", pc);
			if (!taken.ok) throw new Error("take failed");
			await storage.drop("Atlas", taken.lock);
			expect(await storage.list()).toEqual([]);
			await rejects(storage.fetch("Atlas", 0), "not-found");
		});

		it("stores the key check once: the same bytes again are fine, different bytes are refused", async () => {
			expect(await storage.getCheck()).toBeUndefined();
			await storage.putCheck(bytes("check"));
			await storage.putCheck(bytes("check"));
			await rejects(storage.putCheck(bytes("other")), "refused");
			expect(new TextDecoder().decode(await storage.getCheck())).toBe("check");
		});

		it("never reuses a lock number, even after the lane is dropped and created again", async () => {
			const first = await storage.take("Atlas", pc);
			if (!first.ok) throw new Error("take failed");
			await storage.drop("Atlas", first.lock);
			const again = await storage.take("Atlas", mac);
			expect(again.ok && again.lock).toBe(2);
			expect(again.ok && again.newestSave).toBe(0);
			await rejects(storage.renew("Atlas", first.lock), "lock-lost");
		});

		it("treats a retry as identical only when its log entry matches too", async () => {
			const taken = await storage.take("Atlas", pc);
			if (!taken.ok) throw new Error("take failed");
			await storage.save("Atlas", taken.lock, 1, bytes("one"), bytes("log-one"));
			await rejects(storage.save("Atlas", taken.lock, 1, bytes("one"), bytes("log-other")), "out-of-order");
		});

		it("keeps lanes apart", async () => {
			await storage.take("Atlas", pc);
			expect((await storage.take("Birch", mac)).ok).toBe(true);
			expect((await storage.list()).map((l) => l.lane).sort()).toEqual(["Atlas", "Birch"]);
		});
	});
}
