/** The server storage contract and transport, concurrency, and binary framing regressions. */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { ServerStorage } from "../../src/remote/server.ts";
import { SERVER_SCRIPT } from "../../src/remote/server-script.ts";
import { sshTarget } from "../../src/lane/env.ts";
import { storageContract } from "./contract.ts";
import { fakeSsh, serverRemote } from "./fake-ssh.ts";

const pc = { machine: "pc", device: "device-pc", pid: 100 };
const mac = { machine: "macbook", device: "device-mac", pid: 200 };
const bytes = (text: string) => new Uint8Array(Buffer.from(text));
const homes: string[] = [];
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function setup(folder = "lanes", env: Record<string, string> = {}) {
	const home = mkdtempSync(join(tmpdir(), "orrery-server-"));
	homes.push(home);
	const ssh = fakeSsh(home, undefined, env);
	return { home, ssh, storage: new ServerStorage(serverRemote(folder), join(home, "ssh"), { ssh: ssh.path }) };
}

storageContract("server (fake ssh)", async () => {
	const { home, storage } = setup("-orrery lanes 'quoted' $dollar $(touch INJECTED); `touch ALSO_INJECTED`");
	return { storage, cleanup: async () => {
		expect(existsSync(join(home, "INJECTED"))).toBe(false);
		expect(existsSync(join(home, "ALSO_INJECTED"))).toBe(false);
	} };
}, { realClock: true });

it("classifies SSH connect and authentication failures", async () => {
	const { home } = setup();
	for (const [failure, kind] of [["connect", "unreachable"], ["auth", "auth"]] as const) {
		const storage = new ServerStorage(serverRemote("lanes"), home, { ssh: fakeSsh(home, failure).path });
		await expect(storage.list()).rejects.toMatchObject({ kind });
	}
});

it("uses the pinned host, identity, isolated config and batch mode", async () => {
	const { storage, ssh, home } = setup();
	await storage.list();
	const args = readFileSync(`${ssh.path}.args`, "utf8").split("\n");
	expect(args.slice(0, 24)).toEqual([
		"-F", join(home, "ssh", "home.config"), "-i", "/test/id with spaces",
		"-o", 'UserKnownHostsFile="/test/known hosts"', "-o", "HostKeyAlias=orrery-home",
		"-o", "StrictHostKeyChecking=yes", "-o", "BatchMode=yes",
		"-o", "ServerAliveInterval=5",
		"-o", "ControlMaster=auto", "-o", `ControlPath="${join(home, "ssh", "cm-%C")}"`, "-o", "ControlPersist=60",
		"-p", "2222", "alex@fake.invalid", "--",
	]);
	expect(readFileSync(join(home, "ssh", "home.config"), "utf8")).toContain("ConnectTimeout 7");
	expect(readFileSync(join(home, "ssh", "home.config"), "utf8")).toContain("ServerAliveCountMax 2");
});

it("takes over a stale lock by the server clock and fences every old writer", async () => {
	const { storage } = setup("lanes", { ORRERY_TEST_STALE_SECONDS: "1" });
	vi.spyOn(Date, "now").mockReturnValue(0); // a laptop clock decades behind the server
	expect(await storage.take("Atlas", pc)).toEqual({ ok: true, lock: 1, newestSave: 0 });
	expect((await storage.take("Atlas", mac, { force: true })).ok).toBe(false);
	await new Promise((resolve) => setTimeout(resolve, 2100));
	const held = await storage.take("Atlas", mac);
	expect(held).toMatchObject({ ok: false, held: { stale: true } });
	expect(await storage.take("Atlas", mac, { force: true })).toEqual({ ok: true, lock: 2, newestSave: 0 });
	for (const op of [() => storage.renew("Atlas", 1), () => storage.save("Atlas", 1, 1, bytes("x"), bytes("y")),
		() => storage.snapshot("Atlas", 1, 0, bytes("x")), () => storage.drop("Atlas", 1)]) {
		await expect(op()).rejects.toMatchObject({ kind: "lock-lost" });
	}
	await storage.release("Atlas", 1);
	expect((await storage.list())[0].lock?.holder).toEqual(mac);
});

it("renews with the server time even when the laptop clock is ahead", async () => {
	const { storage } = setup("lanes", { ORRERY_TEST_STALE_SECONDS: "2" });
	vi.spyOn(Date, "now").mockReturnValue(9_000_000_000_000);
	await storage.take("Atlas", pc);
	const first = (await storage.list())[0].lock!.lastSeen;
	await new Promise((resolve) => setTimeout(resolve, 1100));
	await storage.renew("Atlas", 1);
	expect((await storage.list())[0].lock!.lastSeen).toBeGreaterThan(first);
	expect((await storage.take("Atlas", mac, { force: true })).ok).toBe(false);
});

it("serializes simultaneous takes and saves without mismatching the audit entry", async () => {
	const { storage } = setup();
	const takes = await Promise.all(Array.from({ length: 8 }, (_, pid) => storage.take("Atlas", { ...pc, pid })));
	expect(takes.filter((take) => take.ok)).toHaveLength(1);
	const results = await Promise.allSettled([1, 2, 3, 4].map((n) => storage.save("Atlas", 1, 1, bytes(`save-${n}`), bytes(`log-${n}`))));
	expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
	const save = Buffer.from((await storage.fetch("Atlas", 0)).saves[0].file).toString();
	expect(Buffer.from((await storage.log("Atlas"))[0].file).toString()).toBe(save.replace("save", "log"));
});

it("round-trips binary saves, logs, and snapshots without interpreting payload as shell", async () => {
	const { storage, home } = setup();
	await storage.take("Atlas", pc);
	const file = new Uint8Array(Buffer.concat([randomBytes(256 * 1024), Buffer.from("\n__ORRERY_PAYLOAD__\ntouch INJECTED\n\0\xff")]));
	const log = new Uint8Array(Buffer.from([0, 255, 10, 13, 128]));
	await storage.save("Atlas", 1, 1, file, log);
	expect((await storage.fetch("Atlas", 0)).saves).toEqual([{ n: 1, file }]);
	expect(await storage.log("Atlas")).toEqual([{ n: 1, file: log }]);
	await storage.snapshot("Atlas", 1, 1, file);
	expect((await storage.fetch("Atlas", -1)).snapshot).toEqual({ n: 1, file });
	expect(existsSync(join(home, "INJECTED"))).toBe(false);
});

it("preserves Unicode and shell punctuation in holder names", async () => {
	const { storage } = setup();
	const holder = { machine: "pc\t'\n雪$()`%", device: "dev'\t🙂%", pid: 123 };
	await storage.take("Atlas", holder);
	expect(await storage.take("Atlas", mac)).toMatchObject({ ok: false, held: { holder } });
	expect((await storage.list())[0].lock?.holder).toEqual(holder);
});

it("refuses invalid lane names and numbers before starting SSH", async () => {
	const { storage, ssh } = setup();
	for (const lane of ["../Atlas", "-Atlas", "A/B", "Atlas\n", "", "A".repeat(33)]) {
		for (const op of [() => storage.take(lane, pc), () => storage.renew(lane, 1), () => storage.release(lane, 1),
			() => storage.save(lane, 1, 1, bytes("x"), bytes("y")), () => storage.snapshot(lane, 1, 0, bytes("x")),
			() => storage.fetch(lane, 0), () => storage.log(lane), () => storage.drop(lane, 1)]) {
			await expect(op()).rejects.toMatchObject({ kind: "refused" });
		}
	}
	await expect(storage.fetch("Atlas", Number.NaN)).rejects.toMatchObject({ kind: "refused" });
	await expect(storage.take("Atlas", { ...pc, pid: -1 })).rejects.toMatchObject({ kind: "refused" });
	expect(existsSync(`${ssh.path}.args`)).toBe(false);
});

it("checks both the save and log bytes on an identical retry, even after pruning", async () => {
	const { storage } = setup();
	await storage.take("Atlas", pc);
	await storage.save("Atlas", 1, 1, bytes("save"), bytes("log"));
	await storage.snapshot("Atlas", 1, 1, bytes("snapshot"));
	await storage.save("Atlas", 1, 1, bytes("save"), bytes("log"));
	await expect(storage.save("Atlas", 1, 1, bytes("save"), bytes("different log"))).rejects.toMatchObject({ kind: "out-of-order" });
	await expect(storage.snapshot("Atlas", 1, 2, bytes("future"))).rejects.toMatchObject({ kind: "out-of-order" });
});

it("keeps exactly the newest three snapshots, later saves, and all audit entries", async () => {
	const { storage, home } = setup();
	await storage.take("Atlas", pc);
	await storage.snapshot("Atlas", 1, 0, bytes("start"));
	for (let n = 1; n <= 12; n++) {
		await storage.save("Atlas", 1, n, bytes(`s${n}`), bytes(`l${n}`));
		if (n % 3 === 0) await storage.snapshot("Atlas", 1, n, bytes(`snap${n}`));
	}
	expect(readdirSync(join(home, "lanes", "Atlas", "snapshots")).sort()).toEqual(["12", "6", "9"]);
	expect(readdirSync(join(home, "lanes", "Atlas", "saves")).sort()).toEqual(["10", "11", "12", "7", "8", "9"]);
	expect(await storage.log("Atlas")).toHaveLength(12);
});

it("never replaces a different key check, including racing creators", async () => {
	const { storage } = setup();
	const results = await Promise.allSettled([storage.putCheck(bytes("one")), storage.putCheck(bytes("two"))]);
	expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
	const check = (await storage.getCheck())!;
	await storage.putCheck(check);
	await expect(storage.putCheck(bytes("different"))).rejects.toMatchObject({ kind: "refused" });
	expect(await storage.getCheck()).toEqual(check);
});

it("expands a leading ~/ using the SSH user's HOME, keeping the rest literal", async () => {
	const { home } = setup();
	const remoteHome = join(home, "server 'home' $d");
	const folder = "~/lanes 'q' $d $(touch INJECTED)";
	const ssh = fakeSsh(home, undefined, { HOME: remoteHome });
	const storage = new ServerStorage(serverRemote(folder), join(home, "ssh"), { ssh: ssh.path });
	await storage.take("Atlas", pc);
	expect(existsSync(join(remoteHome, folder.slice(2), "Atlas", "lock"))).toBe(true);
	expect(existsSync(join(home, "~"))).toBe(false);
	expect(existsSync(join(home, "INJECTED"))).toBe(false);
});

it.each([true, false])("a key check coexists with the lane named check (key first: %s)", async (keyFirst) => {
	const { storage } = setup();
	if (keyFirst) await storage.putCheck(bytes("key"));
	await storage.take("check", pc);
	if (!keyFirst) await storage.putCheck(bytes("key"));
	expect(await storage.getCheck()).toEqual(bytes("key"));
	expect((await storage.list()).map((lane) => lane.lane)).toEqual(["check"]);
});

it("migrates the legacy check file once, freeing its old name for a lane", async () => {
	const { storage, home } = setup();
	mkdirSync(join(home, "lanes"));
	writeFileSync(join(home, "lanes", "check"), "legacy");
	expect(await storage.getCheck()).toEqual(bytes("legacy"));
	expect(existsSync(join(home, "lanes", "check"))).toBe(false);
	expect(readFileSync(join(home, "lanes", ".orrery-check"), "utf8")).toBe("legacy");
	await storage.take("check", pc);
	await storage.putCheck(bytes("legacy"));
	await expect(storage.putCheck(bytes("different"))).rejects.toMatchObject({ kind: "refused" });
});

it("streams a pinned big fetch without holding the lane mutex, even through save, replacement and drop", async () => {
	const { home, storage } = setup();
	await storage.take("Atlas", pc);
	const snapshot = new Uint8Array(3 * 1024 * 1024).fill(23);
	await storage.snapshot("Atlas", 1, 0, snapshot);
	const ready = join(home, "streaming");
	const go = join(home, "go");
	const bin = join(home, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "cat"), `#!/bin/sh
case "\${1:-}" in */snapshots/0|*/.request.*/snapshot)
 printf ready > '${ready}'
 while [ ! -f '${go}' ]; do sleep 0.01; done ;;
esac
exec /bin/cat "$@"
`, { mode: 0o700 });
	const ssh = fakeSsh(home, undefined, { PATH: `${bin}:${process.env.PATH}` });
	const slow = new ServerStorage(serverRemote("lanes"), join(home, "ssh"), { ssh: ssh.path });
	const fetching = slow.fetch("Atlas", -1).catch((error: unknown) => error);
	try {
		await waitForFile(ready);
		await storage.save("Atlas", 1, 1, bytes("new turn"), bytes("log"));
		await storage.snapshot("Atlas", 1, 0, bytes("replacement"));
		await storage.drop("Atlas", 1);
	} finally { writeFileSync(go, "go"); }
	expect(await fetching).toEqual({ snapshot: { n: 0, file: snapshot }, saves: [], newestSave: 0 });
	expect(readdirSync(join(home, "lanes")).some((name) => name.startsWith(".request."))).toBe(false);
}, 20_000);

function mutexClaim(mutex: string, name: string, pid: number, ticket?: number): string {
	const path = join(mutex, `claim-${name}`);
	mkdirSync(path, { recursive: true });
	writeFileSync(join(path, "owner"), `${pid} 1\n`);
	if (ticket !== undefined) writeFileSync(join(path, "ticket"), `${ticket}\n`);
	return path;
}

it.each(["choosing", "waiting"])("recovers a dead %s claimant without breaking a live owner", async (state) => {
	const { storage, home } = setup();
	await storage.take("Atlas", pc);
	const mutex = join(home, "lanes", "Atlas", ".mutex");
	mutexClaim(mutex, "abandoned", 2147483647, state === "waiting" ? 1 : undefined);
	await storage.renew("Atlas", 1);
	expect(readdirSync(mutex)).toEqual([]);
	const live = mutexClaim(mutex, "live", process.pid, 1);
	const pending = storage.renew("Atlas", 1);
	await pause(150);
	expect(existsSync(live)).toBe(true);
	rmSync(live, { recursive: true });
	await pending;
});

it("waits for a living contender to finish choosing its ticket", async () => {
	const { storage, home } = setup();
	await storage.take("Atlas", pc);
	const mutex = join(home, "lanes", "Atlas", ".mutex");
	const choosing = mutexClaim(mutex, "choosing", process.pid);
	let settled = false;
	const pending = storage.renew("Atlas", 1).then(() => { settled = true; });
	await pause(100);
	expect(settled).toBe(false);
	writeFileSync(join(choosing, "ticket"), "1\n");
	await pause(100);
	expect(settled).toBe(false);
	rmSync(choosing, { recursive: true });
	await pending;
});

it.each(["ownerless", "abandoned reaper"])("recovers after interruption leaves an %s mutex", async (state) => {
	const { storage, home } = setup();
	await storage.take("Atlas", pc);
	const mutex = join(home, "lanes", "Atlas", ".mutex");
	mkdirSync(mutex, { recursive: true });
	if (state === "abandoned reaper") {
		writeFileSync(join(mutex, "owner"), "2147483647 1\n");
		mkdirSync(join(mutex, "reaper"));
	}
	await expect(storage.renew("Atlas", 1)).resolves.toBeUndefined();
});

it("does not reap a live successor when the old owner releases during recovery", async () => {
	const { storage, home } = setup();
	await storage.take("Atlas", pc);
	const mutex = join(home, "lanes", "Atlas", ".mutex");
	const reached = join(home, "reached");
	const go = join(home, "go");
	const bin = join(home, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "date"), `#!/bin/sh
for ticket in '${mutex}'/claim-orrery-*/ticket; do
	if [ -f "$ticket" ] && [ ! -f '${go}' ]; then
		printf ready > '${reached}'
		while [ ! -f '${go}' ]; do sleep 0.01; done
	fi
done
exec /usr/bin/date "$@"
`, { mode: 0o700 });
	const ssh = fakeSsh(home, undefined, { PATH: `${bin}:${process.env.PATH}` });
	const racing = new ServerStorage(serverRemote("lanes"), join(home, "ssh"), { ssh: ssh.path });
	const old = spawn("sleep", ["60"]);
	const successor = spawn("sleep", ["60"]);
	const oldClaim = mutexClaim(mutex, "aaa-old", old.pid!, 1);
	const successorClaim = mutexClaim(mutex, "zzz-successor", successor.pid!, 1);
	let settled = false;
	const pending = racing.renew("Atlas", 1).then(() => { settled = true; }, (error: unknown) => { settled = true; return error; });
	try {
		await waitForFile(reached); // recovery has read the old owner's identity
		rmSync(oldClaim, { recursive: true });
		const closed = new Promise((resolve) => old.once("close", resolve));
		old.kill();
		await closed;
		writeFileSync(go, "go");
		await pause(150);
		expect(settled).toBe(false);
		expect(existsSync(join(successorClaim, "owner"))).toBe(true);
	} finally {
		writeFileSync(go, "go");
		rmSync(oldClaim, { recursive: true, force: true });
		rmSync(successorClaim, { recursive: true, force: true });
		old.kill(); successor.kill();
		await pending;
	}
});

it("recovers when a process dies immediately before publishing its mutex claim", async () => {
	const { storage, home } = setup();
	await storage.take("Atlas", pc);
	const bin = join(home, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "mv"), `#!/bin/sh
case "$2" in */.mutex/claim-*) kill -9 "$PPID"; exit 0 ;; esac
exec /usr/bin/mv "$@"
`, { mode: 0o700 });
	const ssh = fakeSsh(home, undefined, { PATH: `${bin}:${process.env.PATH}` });
	const crashing = new ServerStorage(serverRemote("lanes"), join(home, "ssh"), { ssh: ssh.path });
	await expect(crashing.renew("Atlas", 1)).rejects.toMatchObject({ kind: "unreachable" });
	await expect(storage.renew("Atlas", 1)).resolves.toBeUndefined();
});

it("rejects a truncated upload without publishing part of a save", async () => {
	const { storage, home } = setup();
	await storage.take("Atlas", pc);
	const result = spawnSync("sh", ["-c", SERVER_SCRIPT, "orrery", "save", join(home, "lanes"), "Atlas", "1", "1", "10", "4"], { input: "log!cut" });
	expect(result.status).not.toBe(0);
	expect((await storage.fetch("Atlas", 0)).newestSave).toBe(0);
	expect(await storage.log("Atlas")).toEqual([]);
	await storage.save("Atlas", 1, 1, bytes("retry"), bytes("log"));
});

it("refreshes last seen after each successful save and snapshot", async () => {
	const { storage, home } = setup();
	await storage.take("Atlas", pc);
	const path = join(home, "lanes", "Atlas", "lock");
	for (const operation of [() => storage.save("Atlas", 1, 1, bytes("one"), bytes("log")), () => storage.snapshot("Atlas", 1, 1, bytes("snapshot"))]) {
		const fields = readFileSync(path, "utf8").trim().split("\t");
		fields[2] = "1";
		writeFileSync(path, `${fields.join("\t")}\n`);
		await operation();
		expect((await storage.take("Atlas", mac, { force: true })).ok).toBe(false);
	}
});

it("keeps old writes fenced after dropping and recreating a lane", async () => {
	const { storage } = setup();
	await storage.take("Atlas", pc);
	await storage.drop("Atlas", 1);
	expect(await storage.take("Atlas", mac)).toEqual({ ok: true, lock: 2, newestSave: 0 });
	await expect(storage.save("Atlas", 1, 1, bytes("late"), bytes("log"))).rejects.toMatchObject({ kind: "lock-lost" });
});

function scriptedSsh(home: string, source: string): string {
	const path = join(home, `reply-ssh-${randomUUID()}`);
	writeFileSync(path, `#!${process.execPath}\n${source}\n`, { mode: 0o700 });
	return path;
}

it.each([
	"ok\t1\t4\nfile\tsave\t1\t4\ncut", // cut file
	"ok\t2\t1\nfile\tsave\t2\t1\nx", // missing save 1
	"ok\t1\t0\n", // truncated whole reply
	"ok\t0\t0\nfile\tsnapshot\t1\t0\n", // future snapshot
	"ok\t0\t0\nfile\tsnapshot\t0\tnope\n", // bad length
	"ok\t0\t0\nfile\tsnapshot\t0\t0\nfile\tsnapshot\t0\t0\n", // duplicate
])("refuses corrupt frame data (%#)", async (reply) => {
	const { home } = setup();
	const ssh = scriptedSsh(home, `process.stdin.resume(); process.stdout.write(${JSON.stringify(reply)});`);
	const storage = new ServerStorage(serverRemote("lanes"), join(home, "ssh"), { ssh });
	await expect(storage.fetch("Atlas", -1)).rejects.toMatchObject({ kind: "corrupt" });
});

it("sanitizes server errors and survives a refusal while uploading a large file", async () => {
	const { home } = setup();
	const ssh = scriptedSsh(home, 'process.stderr.write("denied\\u001b[31m\\nsecond line"); process.exit(1);');
	const storage = new ServerStorage(serverRemote("lanes"), join(home, "ssh"), { ssh });
	await expect(storage.snapshot("Atlas", 1, 0, new Uint8Array(3 * 1024 * 1024))).rejects.toMatchObject({ kind: "refused", message: "denied[31m" });
});

async function waitForFile(path: string): Promise<void> {
	for (let n = 0; n < 200 && !existsSync(path); n++) await pause(5);
	expect(existsSync(path), "fake SSH did not start").toBe(true);
}

it.each(["snapshot", "fetch"] as const)("lets a large %s finish after the ordinary 15-second deadline", async (op) => {
	const { home } = setup();
	const ready = join(home, "ready");
	const go = join(home, "go");
	const size = 3 * 1024 * 1024 + 17;
	const ssh = scriptedSsh(home, `
import { existsSync, writeFileSync } from "node:fs";
process.stdin.resume();
process.stdin.on("end", () => {
	if (${JSON.stringify(op)} === "fetch") process.stdout.write("ok\\t0\\t${size}\\n");
	writeFileSync(${JSON.stringify(ready)}, "ready");
	const timer = setInterval(() => {
		if (!existsSync(${JSON.stringify(go)})) return;
		clearInterval(timer);
		if (${JSON.stringify(op)} === "fetch") {
			process.stdout.write("file\\tsnapshot\\t0\\t${size}\\n");
			process.stdout.write(Buffer.alloc(${size}, 23));
		} else process.stdout.write("ok\\n");
	}, 5);
});`);
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const storage = new ServerStorage(serverRemote("lanes"), join(home, "ssh"), { ssh });
	let settled = false;
	const pending = (op === "snapshot" ? storage.snapshot("Atlas", 1, 0, new Uint8Array(size)) : storage.fetch("Atlas", -1))
		.then((value) => { settled = true; return value; }, (error: unknown) => { settled = true; return error; });
	await waitForFile(ready);
	await pause(25); // let the transfer-size header reach the client
	await vi.advanceTimersByTimeAsync(16_000);
	expect(settled).toBe(false);
	writeFileSync(go, "go");
	const result = await pending;
	if (op === "fetch") expect(result).toMatchObject({ snapshot: { n: 0, file: new Uint8Array(size).fill(23) } });
	else expect(result).toBeUndefined();
});

it("kills a stuck SSH call and reports unreachable", async () => {
	const { home } = setup();
	const ready = join(home, "ready");
	const ssh = scriptedSsh(home, `import { writeFileSync } from "node:fs"; if (process.argv[2] === "-O") process.exit(0); writeFileSync(${JSON.stringify(ready)}, String(process.pid)); process.stdin.resume(); setInterval(() => {}, 1000);`);
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const storage = new ServerStorage(serverRemote("lanes"), join(home, "ssh"), { ssh });
	const pending = storage.renew("Atlas", 1).catch((error: unknown) => error);
	await waitForFile(ready);
	await vi.advanceTimersByTimeAsync(15_100);
	expect(await pending).toMatchObject({ kind: "unreachable" });
	await pause(25);
	expect(() => process.kill(Number(readFileSync(ready, "utf8")), 0)).toThrow();
});

it.skipIf(process.env.ORRERY_TEST_SSH_HOST === undefined)("round-trips through a real SSH host", async () => {
	const home = mkdtempSync(join(tmpdir(), "orrery-server-live-"));
	homes.push(home);
	const folder = `/tmp/orrery-contract-${randomUUID()} 'quoted' $dollar -dash`;
	const remote = serverRemote(folder);
	const host = {
		...remote.host, host: process.env.ORRERY_TEST_SSH_HOST!, user: process.env.ORRERY_TEST_SSH_USER,
		port: process.env.ORRERY_TEST_SSH_PORT ? Number(process.env.ORRERY_TEST_SSH_PORT) : 22,
		identityFile: process.env.ORRERY_TEST_SSH_IDENTITY!, knownHostsFile: process.env.ORRERY_TEST_SSH_KNOWN_HOSTS!,
		hostKeyAlias: process.env.ORRERY_TEST_SSH_ALIAS ?? process.env.ORRERY_TEST_SSH_HOST!,
	};
	if (!host.identityFile || !host.knownHostsFile) throw new Error("Real SSH tests need IDENTITY and KNOWN_HOSTS paths");
	const storage = new ServerStorage({ ...remote, host }, home);
	try {
		expect(await storage.take("Atlas", pc)).toEqual({ ok: true, lock: 1, newestSave: 0 });
		await storage.save("Atlas", 1, 1, bytes("one"), bytes("log"));
		expect((await storage.fetch("Atlas", 0)).saves).toEqual([{ n: 1, file: bytes("one") }]);
		const big = new Uint8Array(randomBytes(3 * 1024 * 1024 + 17));
		await storage.snapshot("Atlas", 1, 1, big);
		expect((await storage.fetch("Atlas", 0)).snapshot?.file).toEqual(big);
		await storage.renew("Atlas", 1);
		await storage.release("Atlas", 1);
		expect(await storage.take("Atlas", mac)).toEqual({ ok: true, lock: 2, newestSave: 1 });
	} finally {
		const target = sshTarget(host, home);
		const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
		const result = spawnSync("ssh", ["-F", target.configFile!, "-i", host.identityFile, "-o", `UserKnownHostsFile="${host.knownHostsFile}"`,
			"-o", `HostKeyAlias=${host.hostKeyAlias}`, "-o", "StrictHostKeyChecking=yes", "-o", "BatchMode=yes", "-p", String(host.port),
			`${host.user ? `${host.user}@` : ""}${host.host}`, "--", `rm -rf ${quote(folder)}`], { timeout: 15_000 });
		expect(result.status, result.stderr?.toString()).toBe(0);
	}
});


it("quotes a shared control path with spaces, quotes and dollars, and keeps the SSH folder private", async () => {
	const { home, ssh } = setup();
	const dir = join(home, "ssh 'q' $d");
	mkdirSync(dir, { mode: 0o777 });
	chmodSync(dir, 0o777);
	const storage = new ServerStorage(serverRemote("lanes"), dir, { ssh: ssh.path });
	await storage.list();
	const args = readFileSync(`${ssh.path}.args`, "utf8").split("\n");
	expect(args).toContain(`ControlPath="${join(dir, "cm-%C")}"`);
	expect(statSync(dir).mode & 0o777).toBe(0o700);
});

it("uses a fresh connection when the control path contains a dead socket", async () => {
	const { home } = setup();
	const socket = join(home, "ssh", "cm-fake");
	// Exit without server.close(), leaving an actual Unix socket with no listener.
	const made = spawnSync(process.execPath, ["--input-type=module", "-e", "import { createServer } from 'node:net'; createServer().listen(process.argv[1], () => process.exit(0));", socket]);
	expect(made.status).toBe(0);
	expect(lstatSync(socket).isSocket()).toBe(true);
	const ssh = fakeSsh(home, undefined, { ORRERY_FAKE_STALE_SOCKET: socket, ORRERY_FAKE_CONTROL_PATH: `"${join(home, "ssh", "cm-%C")}"` });
	const storage = new ServerStorage(serverRemote("lanes"), join(home, "ssh"), { ssh: ssh.path });
	expect(await storage.take("Atlas", pc)).toEqual({ ok: true, lock: 1, newestSave: 0 });
	expect(readFileSync(`${socket}.fallback`, "utf8")).toBe("fresh\n");
	await storage.release("Atlas", 1);
});

it.each(["symlink", "file"])("refuses an SSH folder that is a %s before writing config or starting SSH", (kind) => {
	const { home, ssh } = setup();
	const dir = join(home, "unsafe");
	const outside = join(home, "outside");
	mkdirSync(outside);
	chmodSync(outside, 0o755);
	if (kind === "symlink") symlinkSync(outside, dir);
	else writeFileSync(dir, "not a folder");
	expect(() => new ServerStorage(serverRemote("lanes"), dir, { ssh: ssh.path })).toThrow(/not a real folder of this user's/);
	expect(existsSync(join(outside, "home.config"))).toBe(false);
	expect(statSync(outside).mode & 0o777).toBe(0o755);
	expect(existsSync(`${ssh.path}.args`)).toBe(false);
});

it.skipIf(process.getuid === undefined)("refuses an SSH folder owned by a different user", () => {
	const { home, ssh } = setup();
	const dir = join(home, "ssh");
	vi.spyOn(process, "getuid").mockReturnValue(statSync(dir).uid + 1);
	expect(() => new ServerStorage(serverRemote("lanes"), dir, { ssh: ssh.path })).toThrow(/not a real folder of this user's/);
});

it("checks the control folder again before each SSH call", async () => {
	const { home, storage, ssh } = setup();
	const dir = join(home, "ssh");
	const outside = join(home, "outside");
	mkdirSync(outside);
	rmSync(dir, { recursive: true });
	symlinkSync(outside, dir);
	await expect(storage.list()).rejects.toThrow(/not a real folder of this user's/);
	expect(existsSync(`${ssh.path}.args`)).toBe(false);
});

const nativeSsh = spawnSync("ssh", ["-V"]).status === 0;
it.skipIf(!nativeSsh).each(["%n", "${x}"])("keeps %s literal in the control folder after OpenSSH expansion", async (special) => {
	const { home } = setup();
	const dir = join(home, special);
	const ssh = fakeSsh(home, undefined, { ORRERY_FAKE_CHECK_CONTROL: "yes", x: "WRONG" });
	const storage = new ServerStorage(serverRemote("lanes"), dir, { ssh: ssh.path });
	await storage.list();
	const controlPath = readFileSync(`${ssh.path}.config`, "utf8").split("\n").find((line) => line.startsWith("controlpath "))!;
	expect(controlPath.slice(0, -40)).toBe(`controlpath ${join(dir, "cm-")}`);
	expect(controlPath.slice(-40)).toMatch(/^[a-f0-9]{40}$/);
});

it.skipIf(!nativeSsh)("starts a fresh connection when the control folder exceeds the Unix socket byte limit", async () => {
	const { home } = setup();
	// Short in JS code units but too long as a UTF-8 Unix socket pathname.
	const dir = join(home, "é".repeat(32));
	const ssh = fakeSsh(home, undefined, { ORRERY_FAKE_PROBE_CONNECT: "yes" });
	const storage = new ServerStorage(serverRemote("lanes"), dir, { ssh: ssh.path });
	expect(await storage.take("Atlas", pc)).toEqual({ ok: true, lock: 1, newestSave: 0 });
	expect(existsSync(`${ssh.path}.connected`), readFileSync(`${ssh.path}.probe-error`, "utf8")).toBe(true);
	expect(readFileSync(`${ssh.path}.args`, "utf8").split("\n")).toContain("ControlPath=none");
});

it.each([false, true])("retires a timed-out master before the next call (exit fails: %s)", async (exitFails) => {
	const { home, storage } = setup();
	await storage.take("Atlas", pc);
	const socket = join(home, "ssh", "cm-fake");
	writeFileSync(socket, "fake master socket");
	const ready = join(home, "hung");
	const ssh = fakeSsh(home, undefined, { ORRERY_FAKE_CONTROL_SOCKET: socket, ORRERY_FAKE_HANG: ready, ORRERY_FAKE_EXIT_FAIL: exitFails ? "yes" : "no" });
	const client = new ServerStorage(serverRemote("lanes"), join(home, "ssh"), { ssh: ssh.path });
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const pending = client.renew("Atlas", 1).catch((error: unknown) => error);
	await waitForFile(ready);
	await vi.advanceTimersByTimeAsync(15_100);
	expect(await pending).toMatchObject({ kind: "unreachable" });
	await waitForFile(`${ssh.path}.exit`);
	await client.release("Atlas", 1);
	if (exitFails) expect(readFileSync(`${ssh.path}.args`, "utf8").split("\n")).toContain("ControlPath=none");
	else expect(existsSync(socket)).toBe(false);
	expect((await storage.list())[0].lock?.held).toBe(false);
});
