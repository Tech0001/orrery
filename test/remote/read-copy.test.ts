import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../../src/memory/store.ts";
import { readCopyPath } from "../../src/remote/read-copy.ts";
import { seal } from "../../src/remote/crypto.ts";
import { encodeRows, encodeSnapshot, laneSettings, snapshotBytes } from "../../src/remote/save-format.ts";
import * as saveFormat from "../../src/remote/save-format.ts";
import { removeRemoteSecret } from "../../src/remote/secrets.ts";
import { RemoteError } from "../../src/remote/types.ts";
import { readCopyFixture } from "./read-copy-fixture.ts";

let f: Awaited<ReturnType<typeof readCopyFixture>>;
beforeEach(async () => { f = await readCopyFixture(); });
afterEach(() => { vi.restoreAllMocks(); f.close(); });
const messages = (path: string) => {
	const store = MemoryStore.openReadOnly(path);
	try { return store.root.map((row) => row.text); } finally { store.close(); }
};
const read = () => readCopyPath(f.config, f.lane, { storage: f.storage, now: f.now });

describe("remote read copies", () => {
	it("restores a framed snapshot plus later saves without taking the remote lock", async () => {
		await f.save();
		const take = vi.spyOn(f.storage, "take");
		const fetch = vi.spyOn(f.storage, "fetch");
		const result = await read();
		expect(result).toEqual({ path: join(f.config.dataDir, "read-copies", "Atlas", "memory.sqlite") });
		expect(messages(result.path)).toEqual(["from the snapshot", "from a later save"]);
		expect(fetch).toHaveBeenCalledWith("Atlas", -1);
		expect(take).not.toHaveBeenCalled();
		const statePath = join(f.config.dataDir, "read-copies", "Atlas", "state.json");
		expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ save: 1 });
		expect(statSync(statePath).mode & 0o777).toBe(0o600);
		expect(statSync(result.path).mode & 0o777).toBe(0o600);
	});

	it("uses its saved number to refresh after 60 seconds, not before", async () => {
		const fetch = vi.spyOn(f.storage, "fetch");
		const { path } = await read();
		await f.save();
		f.clock.value += 59_999;
		await read();
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(messages(path)).toHaveLength(1);
		f.clock.value += 1;
		await read();
		expect(fetch).toHaveBeenLastCalledWith("Atlas", 0);
		expect(messages(path)).toHaveLength(2);
	});

	it("applies only new saves in place without restoring, compressing or vacuuming a snapshot", async () => {
		const { path } = await read();
		const inode = statSync(path).ino;
		await f.save("first new save");
		await f.save("second new save");
		const restore = vi.spyOn(saveFormat, "restoreSnapshot");
		const snapshot = vi.spyOn(saveFormat, "snapshotBytes");
		f.clock.value += 60_000;
		await read();
		expect(restore).not.toHaveBeenCalled();
		expect(snapshot).not.toHaveBeenCalled();
		expect(statSync(path).ino).toBe(inode);
		expect(messages(path)).toEqual(["from the snapshot", "first new save", "second new save"]);
	});

	it("replaces an older copy with a newer snapshot and applies its following saves", async () => {
		const { path } = await read();
		await f.save("in snapshot one");
		await f.snapshot();
		await f.save("after snapshot one");
		const restore = vi.spyOn(saveFormat, "restoreSnapshot");
		const snapshot = vi.spyOn(saveFormat, "snapshotBytes");
		f.clock.value += 60_000;
		await read();
		expect(restore).toHaveBeenCalledTimes(1);
		expect(snapshot).not.toHaveBeenCalled();
		expect(messages(path)).toEqual(["from the snapshot", "in snapshot one", "after snapshot one"]);
	});

	it.each(["unreachable", "quota"] as const)("serves a %s remote's old copy with its actual last refresh time", async (kind) => {
		const { path } = await read();
		f.clock.value += 60_000;
		vi.spyOn(f.storage, "fetch").mockRejectedValue(new RemoteError(kind, "temporarily unavailable"));
		expect(await read()).toEqual({ path, asOf: "14:02" });
		f.clock.value += 60_000;
		expect((await read()).asOf).toBe("14:02");
	});

	it("explains an unreachable remote when there is no copy", async () => {
		vi.spyOn(f.storage, "fetch").mockRejectedValue(new RemoteError("unreachable", "offline"));
		await expect(read()).rejects.toThrow("remote home can't be reached");
	});

	it("preserves the quota error when there is no old copy", async () => {
		vi.spyOn(f.storage, "fetch").mockRejectedValue(new RemoteError("quota", "daily quota reached"));
		await expect(read()).rejects.toMatchObject({ kind: "quota", message: "daily quota reached" });
	});

	it("reports a missing key before it fetches, even if a cached copy exists", async () => {
		await read();
		removeRemoteSecret(f.config, "home");
		const fetch = vi.spyOn(f.storage, "fetch");
		await expect(read()).rejects.toThrow(/key for remote home isn't on this machine/);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("reads a live local holder's working copy without fetching or requiring its key", async () => {
		const local = MemoryStore.open(join(f.lane.dir, "memory.sqlite"));
		local.append("user", "unsaved on this machine");
		try {
			writeFileSync(join(f.lane.dir, "status.json"), JSON.stringify({ open: true, pid: process.pid }));
			removeRemoteSecret(f.config, "home");
			const fetch = vi.spyOn(f.storage, "fetch");
			expect(await read()).toEqual({ path: local.path });
			expect(fetch).not.toHaveBeenCalled();
		} finally { local.close(); }
	});

	it.each([{ open: false, pid: process.pid }, { open: true, pid: -1 }, { open: true, pid: 2_147_483_647 }])("ignores closed or dead local status (%#)", async (status) => {
		mkdirSync(f.lane.dir, { recursive: true });
		writeFileSync(join(f.lane.dir, "status.json"), JSON.stringify(status));
		expect((await read()).path).not.toBe(join(f.lane.dir, "memory.sqlite"));
	});

	it("coalesces simultaneous refreshes of the same copy", async () => {
		const fetch = vi.spyOn(f.storage, "fetch");
		const results = await Promise.all([read(), read(), read()]);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(results[0]).toEqual(results[1]);
	});

	it("waits for the copy's MemoryStore writer lock before fetching or replacing it", async () => {
		const { path } = await read();
		await f.save();
		await f.snapshot();
		f.clock.value += 60_000;
		const holder = MemoryStore.open(path);
		const fetch = vi.spyOn(f.storage, "fetch");
		const pending = read();
		try {
			await delay(40);
			expect(fetch).not.toHaveBeenCalled();
			expect(messages(path)).toEqual(["from the snapshot"]);
		} finally { holder.close(); }
		await pending;
		expect(messages(path)).toHaveLength(2);
	});

	it("does not disguise an authentication failure as an offline answer", async () => {
		await read();
		f.clock.value += 60_000;
		vi.spyOn(f.storage, "fetch").mockRejectedValue(new RemoteError("auth", "bad token"));
		await expect(read()).rejects.toMatchObject({ kind: "auth" });
	});

	it("rebuilds when a replacement database survived but its new state did not", async () => {
		const { path } = await read();
		const statePath = join(f.config.dataDir, "read-copies", "Atlas", "state.json");
		const oldState = readFileSync(statePath, "utf8");
		await f.save();
		f.clock.value += 60_000;
		await read();
		// The database rename persisted, but the process stopped before publishing its new state file.
		writeFileSync(statePath, oldState);
		const fetch = vi.spyOn(f.storage, "fetch");
		await read();
		expect(fetch).toHaveBeenCalledWith("Atlas", -1);
		expect(messages(path)).toEqual(["from the snapshot", "from a later save"]);
		expect(JSON.parse(readFileSync(statePath, "utf8")).save).toBe(1);
	});

	it("does not replace a good copy or its state when a later save is corrupt", async () => {
		const { path } = await read();
		const statePath = join(f.config.dataDir, "read-copies", "Atlas", "state.json");
		const state = readFileSync(statePath, "utf8");
		await f.save();
		f.clock.value += 60_000;
		const original = f.storage.fetch.bind(f.storage);
		const fetch = vi.spyOn(f.storage, "fetch").mockImplementation(async (lane, after) => {
			const value = await original(lane, after);
			return { ...value, saves: value.saves.map((save) => ({ ...save, file: new Uint8Array([1, 2]) })) };
		});
		await expect(read()).rejects.toMatchObject({ kind: "corrupt" });
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(messages(path)).toEqual(["from the snapshot"]);
		expect(readFileSync(statePath, "utf8")).toBe(state);
	});

	it("rebuilds once when a dropped and repushed lane's incremental rows no longer fit", async () => {
		await f.save("old lane history");
		const { path } = await read();
		const oldLock = (await f.storage.list())[0].lock!;
		await f.storage.drop("Atlas", oldLock.lock);
		const take = await f.storage.take("Atlas", { machine: "new machine", device: "new device", pid: 2 });
		if (!take.ok) throw new Error("held");
		const replacement = MemoryStore.open(join(f.root, "replacement.sqlite"));
		try {
			for (const text of ["new one", "new two", "new three"]) replacement.append("user", text);
			await f.storage.snapshot("Atlas", take.lock, 0, seal(f.key, "Atlas", "snapshot", 0, encodeSnapshot({ v: 1, n: 0, lock: take.lock, machine: "new machine", at: new Date(f.now()).toISOString(), settings: laneSettings(f.lane) }, snapshotBytes(replacement.path))));
			let marks = replacement.marks();
			for (let n = 1; n <= 2; n++) {
				replacement.append("talk", `new save ${n}`);
				const changed = replacement.rowsAfter(marks, [])!;
				await f.storage.save("Atlas", take.lock, n, seal(f.key, "Atlas", "save", n, encodeRows(changed.rows)), new Uint8Array());
				marks = changed.next;
			}
		} finally { replacement.close(); }
		f.clock.value += 60_000;
		const fetch = vi.spyOn(f.storage, "fetch");
		expect(await read()).toEqual({ path });
		expect(fetch.mock.calls).toEqual([["Atlas", 1], ["Atlas", -1]]);
		expect(messages(path)).toEqual(["new one", "new two", "new three", "new save 1", "new save 2"]);
		expect(JSON.parse(readFileSync(join(f.config.dataDir, "read-copies", "Atlas", "state.json"), "utf8")).save).toBe(2);
	});

	it("stops after one failed full rebuild and preserves the old copy and state", async () => {
		const { path } = await read();
		const dir = join(f.config.dataDir, "read-copies", "Atlas");
		const statePath = join(dir, "state.json");
		const state = readFileSync(statePath, "utf8");
		await f.save();
		f.clock.value += 60_000;
		const badRows = { main: [{ i: 99, kind: "user", text: "gap", size: 9, date: new Date(f.now()).toISOString() }], tree: [], usage: [], meta: {} };
		const original = f.storage.fetch.bind(f.storage);
		const fetch = vi.spyOn(f.storage, "fetch").mockImplementation(async (lane, after) => {
			const result = await original(lane, after);
			return { ...result, saves: result.saves.map((save) => ({ ...save, file: seal(f.key, lane, "save", save.n, encodeRows(badRows)) })) };
		});
		await expect(read()).rejects.toMatchObject({ kind: "corrupt" });
		expect(fetch.mock.calls).toEqual([["Atlas", 0], ["Atlas", -1]]);
		expect(messages(path)).toEqual(["from the snapshot"]);
		expect(readFileSync(statePath, "utf8")).toBe(state);
		expect(readdirSync(dir).filter((name) => name.startsWith(".refresh-"))).toEqual([]);
	});

	it("does not commit an earlier incremental save when a later save fails validation", async () => {
		const { path } = await read();
		const statePath = join(f.config.dataDir, "read-copies", "Atlas", "state.json");
		const state = readFileSync(statePath, "utf8");
		await f.save("good but must roll back");
		await f.save("bad later save");
		f.clock.value += 60_000;
		const original = f.storage.fetch.bind(f.storage);
		vi.spyOn(f.storage, "fetch").mockImplementation(async (lane, after) => {
			const fetched = await original(lane, after);
			const bad = { main: [{ i: 99, kind: "user", text: "gap", size: 9, date: new Date(f.now()).toISOString() }], tree: [], usage: [], meta: {} };
			return { ...fetched, saves: fetched.saves.map((save) => save.n === 2 ? { ...save, file: seal(f.key, lane, "save", save.n, encodeRows(bad)) } : save) };
		});
		await expect(read()).rejects.toMatchObject({ kind: "corrupt" });
		expect(messages(path)).toEqual(["from the snapshot"]);
		expect(readFileSync(statePath, "utf8")).toBe(state);
	});
});
