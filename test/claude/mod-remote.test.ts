import { readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Holder } from "../../src/claude/holder.ts";
import { modView } from "../../src/claude/mod-view.ts";
import { writeSetupMarker } from "../../src/claude/view-file.ts";
import { holderFile, readHolder, writeHolder } from "../../src/lane/handover.ts";
import { laneModelSource } from "../../src/lane/model-source.ts";
import * as remotes from "../../src/remote/index.ts";
import { RemoteError, STALE_MS } from "../../src/remote/types.ts";
import { fauxModels } from "../lane/support.ts";
import { checkoutFixture } from "../remote/checkout-fixture.ts";
import { spool } from "./support.ts";

let f: Awaited<ReturnType<typeof checkoutFixture>>;
let holder: Holder | undefined;
const session = "remote-footer-session";
beforeEach(async () => {
	f = await checkoutFixture();
	writeSetupMarker(f.lane.dir, f.lane.workspace, "mod");
	vi.spyOn(remotes, "openStorage").mockReturnValue(f.storage);
});
afterEach(async () => {
	await holder?.stop("test cleanup");
	holder = undefined;
	vi.restoreAllMocks();
	f.close();
});
async function start() {
	holder = await Holder.start({ config: f.config, lane: f.lane, session, claudePid: process.pid, nonce: "test", models: laneModelSource(fauxModels().models), tickMs: 60_000, log: () => {} });
	expect(holder).toBeDefined();
}
const view = (id = session) => modView(f.config, { cwd: f.lane.workspace, session: id, spoolOnly: true });

it("spool-only JSON includes the running recorder's RemoteSession status", async () => {
	await start();
	expect(await view()).toMatchObject({ remote: holder!.lane.remote!.status(), recording: true });
});

it("a turn publishes save failure and recovery without waiting for the heartbeat timer", async () => {
	await start();
	const save = vi.spyOn(f.storage, "save").mockRejectedValue(new RemoteError("unreachable", "offline"));
	spool(f.lane, session, { kind: "reply", text: "a turn to save" }, process.pid);
	holder!.tick();
	await vi.waitFor(async () => expect(await view()).toMatchObject({ remote: { remote: "home", state: "failing", reason: "offline" } }));
	save.mockRestore();
	spool(f.lane, session, { kind: "reply", text: "back online" }, process.pid);
	holder!.tick();
	await vi.waitFor(async () => expect(await view()).toMatchObject({ remote: { remote: "home", state: "saved", savedAt: expect.stringMatching(/^\d\d:\d\d$/) } }));
});

it("keeps the moved notice for the fenced session after its recorder exits, not a different session", async () => {
	await start();
	f.clock.value += STALE_MS + 1;
	await f.storage.take("Test", { machine: "macbook", device: "other", pid: 1 }, { force: true });
	await holder!.lane.remote!.renew();
	holder!.tick();
	await holder!.done;
	expect(readHolder(f.lane.dir)).toBeUndefined();
	expect(await view()).toMatchObject({ recording: false, sessionMode: "read-only", remote: { remote: "home", state: "lost", movedTo: "macbook" } });
	expect(await view("another-session")).not.toMatchObject({ remote: { state: "lost" } });
});

it("with no recorder uses only the confirmed remote-state file's saved time", async () => {
	await start();
	await holder!.stop("session over");
	const file = join(f.lane.dir, "remote-state.json");
	const time = new Date(2026, 9, 12, 14, 2);
	utimesSync(file, time, time);
	expect(await view()).toMatchObject({ remote: { remote: "home", state: "saved", savedAt: "14:02" } });
	// Stale heartbeats cannot replace the confirmed on-disk time.
	writeHolder(f.lane.dir, { pid: process.pid, session, claudePid: process.pid, state: "recording", startedAt: 0, updatedAt: 0, remote: { remote: "home", state: "failing", reason: "offline" } });
	expect(await view()).toMatchObject({ remote: { state: "saved", savedAt: "14:02" } });
});

it.each(["missing", "malformed", "different remote", "unacknowledged"])("omits remote status when stopped and the state is %s", async (kind) => {
	await start();
	await holder!.stop("session over");
	const file = join(f.lane.dir, "remote-state.json");
	const state = JSON.parse(readFileSync(file, "utf8"));
	if (kind === "missing") rmSync(file);
	else writeFileSync(file, kind === "malformed" ? "{" : JSON.stringify({ ...state, ...(kind === "different remote" ? { remote: "elsewhere" } : { inflight: { n: 1 } }) }));
	expect(await view()).not.toHaveProperty("remote");
});

it("copies only public status fields, and ignores malformed or unrelated heartbeat metadata", async () => {
	await start();
	const file = holderFile(f.lane.dir);
	const beat = JSON.parse(readFileSync(file, "utf8"));
	writeFileSync(file, JSON.stringify({ ...beat, remote: { remote: "home", state: "pending", key: "secret" } }));
	expect(await view()).toMatchObject({ remote: { remote: "home", state: "pending" } });
	expect(JSON.stringify(await view())).not.toContain("secret");
	for (const remote of [null, { remote: "home", state: "surprise" }, { remote: "elsewhere", state: "pending" }]) {
		writeFileSync(file, JSON.stringify({ ...beat, remote }));
		expect(await view()).not.toHaveProperty("remote");
	}
});

it("a slow turn save is pending while the spool-only fetch returns, then publishes its failure", async () => {
	await start();
	const pending = Promise.withResolvers<never>();
	vi.spyOn(f.storage, "save").mockImplementationOnce(() => pending.promise);
	spool(f.lane, session, { kind: "reply", text: "slow remote" }, process.pid);
	holder!.tick();
	try {
		expect(await modView(f.config, { cwd: f.lane.workspace, session, spoolOnly: true, waitMs: 1000 })).toMatchObject({ remote: { state: "pending" } });
	} finally {
		pending.reject(new RemoteError("unreachable", "offline"));
	}
	await vi.waitFor(async () => expect(await view()).toMatchObject({ remote: { state: "failing", reason: "offline" } }));
});

it("retains a takeover first discovered during the final save on stop", async () => {
	await start();
	f.clock.value += STALE_MS + 1;
	await f.storage.take("Test", { machine: "macbook", device: "other", pid: 1 }, { force: true });
	spool(f.lane, session, { kind: "reply", text: "final unsaved turn" }, process.pid);
	await holder!.stop("SIGTERM");
	expect(await view()).toMatchObject({ sessionMode: "read-only", remote: { remote: "home", state: "lost", movedTo: "macbook" } });
});

it("never retains a saved checkmark when shutdown precedes the takeover-owner lookup", async () => {
	await start();
	f.clock.value += STALE_MS + 1;
	await f.storage.take("Test", { machine: "macbook", device: "other", pid: 1 }, { force: true });
	const entries = await f.storage.list();
	const lookup = Promise.withResolvers<typeof entries>();
	vi.spyOn(f.storage, "list").mockImplementationOnce(() => lookup.promise);
	const renewing = holder!.lane.remote!.renew();
	try {
		await vi.waitFor(() => expect(holder!.lane.remote!.lost).toBe(true));
		holder!.tick();
		await holder!.done;
		expect(await view()).toMatchObject({ sessionMode: "read-only", remote: { remote: "home", state: "lost" } });
	} finally {
		lookup.resolve(entries);
		await renewing;
	}
	expect(await view()).toMatchObject({ remote: { state: "lost" } });
});
