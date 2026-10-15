import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/memory/store.ts";
import { Part, StoreError } from "../../src/memory/types.ts";

let dir: string;
let path: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "orrery-store-"));
	path = join(dir, "agent", "memory.sqlite");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const STORE_URL = new URL("../../src/memory/store.ts", import.meta.url).href;
const HOLDER = `
import { MemoryStore } from ${JSON.stringify(STORE_URL)};
console.log("ready");
process.stdin.once("data", () => {
	try { MemoryStore.open(process.argv[1]); console.log("acquired"); } catch (error) { console.log("error: " + error.message); }
});
setInterval(() => {}, 1000);
`;

interface Holder {
	ready: Promise<void>;
	go: () => void;
	result: Promise<string>;
	kill: () => Promise<void>;
}

/** A separate process that loads the store, waits for "go", opens it, reports, and holds it until SIGKILL. */
function spawnHolder(storePath: string): Holder {
	const child = spawn(process.execPath, ["--input-type=module", "-e", HOLDER, storePath], {
		stdio: ["pipe", "pipe", "ignore"],
	});
	const lines: string[] = [];
	const waiters: Array<(line: string) => void> = [];
	let buffer = "";
	const push = (line: string) => {
		const waiter = waiters.shift();
		if (waiter) waiter(line);
		else lines.push(line);
	};
	child.stdout.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
			push(buffer.slice(0, newline));
			buffer = buffer.slice(newline + 1);
		}
	});
	child.on("exit", (code) => push(`exited ${code}`));
	const nextLine = () => new Promise<string>((resolve) => (lines.length > 0 ? resolve(lines.shift() as string) : waiters.push(resolve)));
	const ready = nextLine().then((line) => {
		if (line !== "ready") throw new Error(`holder did not start: ${line}`);
	});
	const result = ready.then(nextLine);
	return {
		ready,
		go: () => child.stdin.write("go\n"),
		result,
		kill: () =>
			new Promise<void>((resolve) => {
				if (child.exitCode !== null || child.signalCode !== null) return resolve();
				child.once("exit", () => resolve());
				child.kill("SIGKILL");
			}),
	};
}

describe("MemoryStore", () => {
	it("keeps verbatim unicode text and global ids across restart", () => {
		const text = "第一行 🌳\nsecond line\x00";
		const store = MemoryStore.open(path);
		const message = store.append("user", text, "2026-01-01T12:00:00-07:00");
		expect(message.size).toBe(Buffer.byteLength(`user: ${text}`));
		store.saveNode(new Part(0, 0), `user: ${text}`);
		store.close();

		const again = MemoryStore.open(path);
		expect(again.root[0].text).toBe(text);
		expect(again.node(new Part(0, 0))?.text).toBe(`user: ${text}`);
		expect(again.append("talk", "okay").i).toBe(1);
		again.close();
	});

	it("allows one writer and releases the lock on close", () => {
		const store = MemoryStore.open(path);
		expect(() => MemoryStore.open(path)).toThrow(StoreError);
		expect(() => MemoryStore.open(path)).toThrow(/already open/);
		store.close();
		const next = MemoryStore.open(path);
		next.append("user", "after release");
		next.close();
	});

	it("admits exactly one of many processes racing for a lock left by a killed process", async () => {
		for (let round = 0; round < 3; round++) {
			const agentPath = join(dir, `agent-${round}`, "memory.sqlite");
			const crashed = spawnHolder(agentPath);
			await crashed.ready;
			crashed.go();
			expect(await crashed.result).toBe("acquired");
			await crashed.kill();
			const racers = Array.from({ length: 8 }, () => spawnHolder(agentPath));
			await Promise.all(racers.map((racer) => racer.ready));
			for (const racer of racers) racer.go();
			const results = await Promise.all(racers.map((racer) => racer.result));
			await Promise.all(racers.map((racer) => racer.kill()));
			expect(results.filter((result) => result === "acquired")).toHaveLength(1);
			for (const result of results.filter((r) => r !== "acquired")) expect(result).toMatch(/already open/);
		}
	}, 60_000);

	it("refuses a log with a missing id instead of renumbering", () => {
		const store = MemoryStore.open(path);
		for (const text of ["a", "b", "c"]) store.append("user", text);
		store.close();
		const raw = new DatabaseSync(path);
		raw.exec("DELETE FROM main WHERE i = 1");
		raw.close();
		expect(() => MemoryStore.open(path)).toThrow(/Missing message 1/);
	});

	it("requires children before parents and keeps nodes immutable", () => {
		const store = MemoryStore.open(path);
		store.append("user", "a");
		store.append("user", "b");
		expect(() => store.saveNode(new Part(1, 0), "summary")).toThrow(/Both children/);
		store.saveNode(new Part(0, 0), "a");
		expect(() => store.saveNode(new Part(0, 0), "changed")).toThrow(/immutable/);
		expect(() => store.saveNode(new Part(0, 5), "beyond")).toThrow(/out-of-range/);
		store.close();
	});

	it("rejects unsupported kinds such as reasoning, and dates without a timezone", () => {
		const store = MemoryStore.open(path);
		expect(() => store.append("thought" as never, "private")).toThrow(RangeError);
		expect(() => store.append("user", "x", "2026-01-01T00:00:00")).toThrow(RangeError);
		expect(store.root.length).toBe(0);
		store.close();
	});

	it("refuses further writes after a failed write until restart", () => {
		const store = MemoryStore.open(path);
		store.append("user", "saved");
		const raw = new DatabaseSync(path);
		raw.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON main BEGIN SELECT RAISE(ABORT, 'disk failure'); END");
		expect(() => store.append("user", "written but failed")).toThrow(/disk failure/);
		raw.exec("DROP TRIGGER fail_insert");
		raw.close();
		expect(() => store.append("user", "do not reuse this id")).toThrow(/restart/);
		expect(() => MemoryStore.open(path)).toThrow(/already open/);
		store.close();

		const again = MemoryStore.open(path);
		expect(again.root.length).toBe(1);
		expect(again.append("user", "after restart").i).toBe(1);
		again.close();
	});

	it("appends a batch and its metadata atomically", () => {
		const store = MemoryStore.open(path);
		const messages = store.appendBatch(
			[
				{ kind: "user", text: "a" },
				{ kind: "talk", text: "b", date: "2026-02-01T00:00:00Z" },
			],
			{ "projector.cursor": "entry-9" },
		);
		expect(messages.map((m) => m.i)).toEqual([0, 1]);
		expect(store.getMeta("projector.cursor")).toBe("entry-9");

		expect(() =>
			store.appendBatch(
				[
					{ kind: "user", text: "c" },
					{ kind: "thought" as never, text: "d" },
				],
				{ "projector.cursor": "entry-10" },
			),
		).toThrow(RangeError);
		expect(store.root.length).toBe(2);
		expect(store.getMeta("projector.cursor")).toBe("entry-9");
		store.close();

		const again = MemoryStore.open(path);
		expect(again.root.map((m) => m.text)).toEqual(["a", "b"]);
		expect(again.root[1].date).toBe("2026-02-01T00:00:00Z");
		expect(again.getMeta("projector.cursor")).toBe("entry-9");
		again.close();
	});

	it("normalizes lone surrogates so text and size survive restart", () => {
		const store = MemoryStore.open(path);
		const message = store.append("echo", "bad \uD800 bytes");
		expect(message.text).toBe("bad � bytes");
		store.close();
		const again = MemoryStore.open(path);
		expect(again.root[0].text).toBe(message.text);
		expect(again.root[0].size).toBe(message.size);
		again.close();
	});

	it("records usage rows", () => {
		const store = MemoryStore.open(path);
		const row = {
			at: "2026-10-05T12:00:00.000-05:00",
			role: "compactor" as const,
			model: "bonsai",
			input: 10,
			cacheRead: 5,
			cacheWrite: 1,
			output: 3,
			ok: true,
		};
		store.recordUsage(row);
		expect(store.usageRows()).toEqual([row]);
		store.close();
	});

	it("writes usage rows atomically with a batch", () => {
		const store = MemoryStore.open(path);
		const row = {
			at: "2026-10-05T12:00:00.000-05:00",
			role: "agent" as const,
			model: "openai/gpt-6.1-sol",
			input: 1,
			cacheRead: 2,
			cacheWrite: 3,
			output: 4,
			ok: true,
		};
		store.appendBatch([{ kind: "user", text: "a" }], { "projector.cursor": "5" }, [row]);
		expect(store.usageRows()).toEqual([row]);
		expect(() =>
			store.appendBatch([{ kind: "thought" as never, text: "x" }], { "projector.cursor": "6" }, [row]),
		).toThrow(RangeError);
		expect(store.usageRows()).toHaveLength(1);
		store.close();
	});

	it("opens read-only alongside the writer and refuses writes", () => {
		const writer = MemoryStore.open(path);
		writer.append("user", "first");
		const reader = MemoryStore.openReadOnly(path);
		expect(reader.root.map((m) => m.text)).toEqual(["first"]);
		expect(reader.writable).toBe(false);
		expect(() => reader.append("user", "nope")).toThrow(/read-only/);
		expect(writer.writable).toBe(true);
		writer.append("user", "second");
		reader.close();
		const again = MemoryStore.openReadOnly(path);
		expect(again.root.map((m) => m.text)).toEqual(["first", "second"]);
		again.close();
		writer.close();
		expect(() => MemoryStore.openReadOnly(join(dir, "missing.sqlite"))).toThrow(/No memory store/);
	});
});
