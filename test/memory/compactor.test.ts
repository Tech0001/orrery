import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Compactor, DemoSummarizer, type Summarizer, type SummaryTask } from "../../src/memory/compactor.ts";
import { DEFAULT_MEMORY_CONFIG, type MemoryConfig, memoryConfig } from "../../src/memory/config.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import { Part } from "../../src/memory/types.ts";
import { MemoryView, PLACEHOLDER } from "../../src/memory/view.ts";

let dir: string;
let store: MemoryStore;
let view: MemoryView;
const compactors: Compactor[] = [];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "orrery-compactor-"));
	store = MemoryStore.open(join(dir, "memory.sqlite"));
	view = new MemoryView(store);
});
afterEach(async () => {
	for (const compactor of compactors.splice(0)) await compactor.close();
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

function start(summarizer?: Summarizer, overrides: Partial<MemoryConfig> = {}, report: (m: string) => void = () => {}, contextBytes?: number) {
	const config = memoryConfig(overrides);
	const compactor = new Compactor(view, summarizer ?? new DemoSummarizer(config.nodeBytes), { ...config, contextBytes }, report);
	compactors.push(compactor);
	compactor.start();
	return compactor;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("memoryConfig", () => {
	it("defaults to the spec constants", () => {
		expect(memoryConfig()).toEqual({
			nodeBytes: 512,
			viewBytes: 128_000,
			jobs: 8,
			tries: 5,
			retrySeconds: 10,
			toolCap: 30_000,
		});
		expect(memoryConfig()).toEqual(DEFAULT_MEMORY_CONFIG);
	});

	it("rejects invalid values", () => {
		expect(() => memoryConfig({ nodeBytes: 32 })).toThrow(RangeError);
		expect(() => memoryConfig({ toolCap: 100 })).toThrow(RangeError);
		expect(() => memoryConfig({ jobs: 1.5 })).toThrow(RangeError);
		expect(() => memoryConfig({ retrySeconds: 0 })).toThrow(RangeError);
	});
});

describe("Compactor", () => {
	it("keeps each summary call's context within the compaction view's ceiling (contextBytes)", async () => {
		const contexts: string[] = [];
		const recorder: Summarizer = {
			async summarize(task) {
				contexts.push(task.context.blocks.join(""));
				return task.source.slice(0, 60);
			},
		};
		for (let i = 0; i < 64; i++) view.append("user", `message-${i}: ${"a".repeat(600)}`);
		const compactor = start(recorder, { jobs: 1, nodeBytes: 100 }, () => {}, 400);
		await compactor.drain();
		expect(contexts.length).toBeGreaterThan(64);
		for (const context of contexts) {
			const text = context.split("\n").slice(1, -1).map((line) => line.slice(line.indexOf("|") + 1)).join("");
			expect(Buffer.byteLength(text)).toBeLessThanOrEqual(400 + 100);
		}
	});

	it("counts a message saved verbatim once in the compaction view, so live turns batch it rarely", async () => {
		const compactor = start(undefined, { nodeBytes: 100 }, () => {}, 2_000); // floor 1,000
		const recount = () => compactor.context.parts.reduce((sum, part) => sum + (store.node(part)?.size ?? 0), 0);
		for (let turn = 0; turn < 160; turn++) {
			// pi's pattern: the user's message (short: saved verbatim, no summary call) and the reply (long: summarized),
			// appended together, so the user's leaf is built before the compaction view first sees it.
			view.appendBatch([
				{ kind: "user", text: `question ${turn}` },
				{ kind: "talk", text: `answer ${turn}: ${"a".repeat(300)}` },
			]);
			await compactor.drain();
			expect(compactor.context.size).toBe(recount());
			expect(compactor.context.size).toBeLessThanOrEqual(2_000);
			if (turn >= 20) expect(compactor.context.size).toBeGreaterThan(1_000 - 2 * 100);
		}
		// About one batch per floor's worth of new lines, not one per node.
		const bytes = Array.from({ length: store.root.length }, (_, i) => store.node(new Part(0, i))?.size ?? 0).reduce((a, b) => a + b, 0);
		expect(compactor.context.epoch).toBeLessThanOrEqual(Math.ceil(bytes / 1_000) + 2);
	});

	it("gives each call the compaction view up to its node: id+n heads, built lines only", async () => {
		const calls: SummaryTask[] = [];
		const recorder: Summarizer = {
			async summarize(task) {
				calls.push(task);
				await sleep(1);
				return task.source.slice(0, 80);
			},
		};
		for (let i = 0; i < 8; i++) view.append("user", `message-${i}: ${"a".repeat(600)}`);
		const compactor = start(recorder, { jobs: 3, nodeBytes: 100 });
		await compactor.drain();
		expect(store.nodeCount).toBe(15);
		expect(calls[0].context.blocks.join("")).toBe("<chat>\n</chat>");
		for (const call of calls) {
			const context = call.context.blocks.join("");
			expect(context.startsWith("<chat>\n") && context.endsWith("</chat>")).toBe(true);
			expect(context).not.toContain(PLACEHOLDER);
			const cut = call.part.l === 0 ? call.part.i : call.part.end;
			for (const line of context.split("\n").slice(1, -1)) {
				const [first, n] = line.slice(0, line.indexOf("|")).split("+").map(Number);
				expect(first + n).toBeLessThanOrEqual(cut);
			}
		}
	});

	it("stores short messages and merges verbatim without model calls", async () => {
		const never: Summarizer = {
			async summarize() {
				throw new Error("No model calls expected");
			},
		};
		for (const text of ["keep this", "你好", "three", "four"]) view.append("user", text);
		const compactor = start(never);
		await compactor.drain();
		expect(view.text(new Part(0, 1))).toBe("user: 你好");
		expect(view.text(new Part(1, 0))).toBe("user: keep this\nuser: 你好");
		expect(store.nodeCount).toBe(7);
		// Verbatim builds have no await; they must still unregister from `busy`, or the pump starves at `jobs`.
		expect(compactor.busy.size).toBe(0);
	});

	it("never leaks a large raw message into the view", async () => {
		const raw = "secret exact long text ".repeat(3000);
		view.append("user", raw);
		expect(view.render()).toContain(PLACEHOLDER);
		expect(view.render()).not.toContain("secret");
		const compactor = start();
		await view.settle();
		expect(view.render()).not.toContain(PLACEHOLDER);
		expect(view.size).toBeLessThan(600);
		expect(view.zoom(0, 1)).toBe(`0+0|user: ${raw}`);
		await compactor.drain();
	});

	it("keeps the view contiguous and under the ceiling, and reopens it identically", async () => {
		view = new MemoryView(store, 1000);
		const compactor = start(undefined, { nodeBytes: 100 });
		for (let i = 0; i < 160; i++) {
			view.append("user", `decision ${i}: ${"abc".repeat(20)}`);
			await compactor.drain();
			let cursor = 0;
			for (const part of view.parts) {
				expect(part.start).toBe(cursor);
				cursor = part.end;
			}
			expect(cursor).toBe(i + 1);
			expect(view.size).toBeLessThanOrEqual(1000);
		}
		await compactor.close();
		const reopened = new MemoryView(store, 1000);
		expect(reopened.parts).toEqual(view.parts);
		expect(reopened.render()).toBe(view.render());
	});

	it("retries failures at a fixed delay, reports once, and recovers", async () => {
		const attempts: number[] = [];
		const notices: string[] = [];
		const flaky: Summarizer = {
			async summarize() {
				attempts.push(performance.now());
				if (attempts.length <= 2) throw new Error("temporary outage");
				return "user: recovered";
			},
		};
		view.append("user", "a".repeat(600));
		const compactor = start(flaky, { retrySeconds: 0.015 }, (m) => notices.push(m));
		await compactor.drain();
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatch(/^Compactor 0\+1: temporary outage; retrying every 0.015s$/);
		expect(attempts).toHaveLength(3);
		expect(attempts[1] - attempts[0]).toBeGreaterThanOrEqual(14);
		expect(compactor.failed.size).toBe(0);
	});

	it("signals a failure at once (not after the retry delay) and keeps its reason until summaries recover", async () => {
		let fail = true;
		const summarizer: Summarizer = {
			async summarize() {
				if (fail) throw new Error("quota exceeded");
				return "user: recovered";
			},
		};
		view.append("user", "a".repeat(600));
		const compactor = start(summarizer, { retrySeconds: 60 });
		const failedAt = await Promise.race([
			(async () => {
				while (compactor.failed.size === 0) await view.changes.next();
				return "signalled";
			})(),
			sleep(1000).then(() => "silent"),
		]);
		expect(failedAt).toBe("signalled");
		expect(compactor.lastError).toBe("quota exceeded");
		fail = false;
		await compactor.close();
		const next = start(summarizer, { retrySeconds: 60 });
		await next.drain();
		expect(next.lastError).toBeUndefined();
	});

	it("never starts a build that was scheduled just before close", async () => {
		let calls = 0;
		const counting: Summarizer = {
			async summarize() {
				calls++;
				return "user: summary";
			},
		};
		view.append("user", "a".repeat(600));
		const compactor = start(counting);
		await compactor.close();
		expect(calls).toBe(0);
		expect(store.hasNode(new Part(0, 0))).toBe(false);
	});

	it("closes cleanly during an in-flight call without saving or reporting", async () => {
		const notices: string[] = [];
		let markStarted: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const slow: Summarizer = {
			summarize(_task, signal) {
				markStarted();
				return new Promise((resolve) => signal.addEventListener("abort", () => resolve("late summary")));
			},
		};
		view.append("user", "a".repeat(600));
		const compactor = start(slow, {}, (m) => notices.push(m));
		await started;
		await compactor.close();
		expect(store.hasNode(new Part(0, 0))).toBe(false);
		expect(notices).toEqual([]);
		expect(compactor.busy.size).toBe(0);
	});

	it("closes promptly even when the model ignores the abort signal", async () => {
		let markStarted: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const deaf: Summarizer = {
			summarize() {
				markStarted();
				return new Promise(() => {});
			},
		};
		view.append("user", "a".repeat(600));
		const compactor = start(deaf);
		await started;
		const outcome = await Promise.race([compactor.close().then(() => "closed"), sleep(1000).then(() => "hung")]);
		expect(outcome).toBe("closed");
		expect(store.hasNode(new Part(0, 0))).toBe(false);
	});
	it("survives a report callback that throws", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const failing: Summarizer = {
				async summarize() {
					throw new Error("outage");
				},
			};
			view.append("user", "a".repeat(600));
			start(failing, { retrySeconds: 0.01 }, () => {
				throw new Error("logger broke");
			});
			await sleep(50);
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("stops calling the model once the store refuses writes", async () => {
		let calls = 0;
		const notices: string[] = [];
		const counting: Summarizer = {
			async summarize() {
				calls++;
				return "user: summary";
			},
		};
		view.append("user", "a".repeat(600));
		const raw = new DatabaseSync(join(dir, "memory.sqlite"));
		raw.exec("CREATE TRIGGER fail_node BEFORE INSERT ON tree BEGIN SELECT RAISE(ABORT, 'disk failure'); END");
		raw.close();
		const compactor = start(counting, { retrySeconds: 0.01 }, (m) => notices.push(m));
		await sleep(150);
		expect(calls).toBe(1);
		expect(store.writable).toBe(false);
		expect(compactor.stopped).toBe(true);
		expect(notices.at(-1)).toMatch(/^Compactor stopped: .*restart the agent/);
		await expect(compactor.drain()).rejects.toThrow(/stopped/);
	});

	it("stops, not retrying, when saving the view fails after the node was saved", async () => {
		view = new MemoryView(store, 1_000); // floor 500
		for (let i = 0; i < 12; i++) view.append("user", `m${i} ${"q".repeat(600)}`);
		// Leaves 0-10 and the parents they complete, 90 bytes each: 990 bytes of built lines, just under the ceiling.
		for (let i = 0; i <= 10; i++) {
			for (let part = new Part(0, i); ; part = new Part(part.l + 1, part.i >> 1)) {
				store.saveNode(part, "z".repeat(90));
				view.built(part);
				if (part.i % 2 === 0) break;
			}
		}
		const raw = new DatabaseSync(join(dir, "memory.sqlite"));
		raw.exec("CREATE TRIGGER fail_meta BEFORE UPDATE ON meta BEGIN SELECT RAISE(ABORT, 'disk full'); END");
		raw.close();
		const notices: string[] = [];
		// Leaf 11's summary passes the ceiling; its batch saves the view, and that write fails.
		const compactor = start(undefined, { nodeBytes: 100, retrySeconds: 0.05 }, (m) => notices.push(m));
		const outcome = await Promise.race([
			compactor.drain().then(
				() => "drained",
				(error: Error) => error.message,
			),
			sleep(1_000).then(() => "hung"),
		]);
		expect(outcome).toMatch(/stopped/);
		expect(store.hasNode(new Part(0, 11))).toBe(true);
		expect(compactor.stopped).toBe(true);
		expect(notices.at(-1)).toMatch(/^Compactor stopped: .*disk full; restart the agent/);
		expect(notices.filter((m) => m.includes("retrying"))).toEqual([]);
	});

	it("runs up to 8 leaves at once: a leaf starts once fewer than 8 lines before it are unbuilt", async () => {
		const started: number[] = [];
		const finish = new Map<number, () => void>();
		const gated: Summarizer = {
			summarize(task) {
				task.onStart?.();
				started.push(task.part.i);
				return new Promise((resolve) => finish.set(task.part.i, () => resolve(`user: m${task.part.i}`)));
			},
		};
		for (let i = 0; i < 12; i++) view.append("user", `m${i} ${"a".repeat(600)}`);
		start(gated, { jobs: 16 });
		await sleep(20);
		expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
		finish.get(3)?.();
		await sleep(20);
		expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
	});

	it("lets one call write a new prefix: the rest start once its response begins", async () => {
		const started: number[] = [];
		const begin = new Map<number, () => void>();
		const gated: Summarizer = {
			summarize(task) {
				started.push(task.part.i);
				begin.set(task.part.i, () => task.onStart?.());
				return new Promise(() => {});
			},
		};
		for (let i = 0; i < 4; i++) view.append("user", `m${i} ${"a".repeat(600)}`);
		start(gated, { jobs: 8 });
		await sleep(20);
		expect(started).toEqual([0]);
		begin.get(0)?.();
		await sleep(20);
		expect(started).toEqual([0, 1, 2, 3]);
	});

	it("a call that never reports its start only holds the others until it ends", async () => {
		const started: number[] = [];
		let finishFirst: () => void = () => {};
		const silent: Summarizer = {
			summarize(task) {
				started.push(task.part.i);
				if (task.part.i === 0) return new Promise((resolve) => (finishFirst = () => resolve("user: m0")));
				return Promise.resolve(`user: m${task.part.i}`);
			},
		};
		for (let i = 0; i < 3; i++) view.append("user", `m${i} ${"a".repeat(600)}`);
		const compactor = start(silent, { jobs: 8 });
		await sleep(20);
		expect(started).toEqual([0]);
		finishFirst();
		await compactor.drain();
		expect(started.slice(0, 3).sort()).toEqual([0, 1, 2]);
	});

	it("releases the others when the writer fails before its response begins", async () => {
		let calls = 0;
		const failingFirst: Summarizer = {
			async summarize(task) {
				calls++;
				if (calls === 1) {
					await sleep(5);
					throw new Error("outage");
				}
				task.onStart?.();
				return `user: m${task.part.i}`;
			},
		};
		for (let i = 0; i < 3; i++) view.append("user", `m${i} ${"a".repeat(600)}`);
		const compactor = start(failingFirst, { jobs: 8, retrySeconds: 0.01 });
		await compactor.drain();
		expect(store.nodeCount).toBe(4);
	});

	it("closes promptly while calls wait on the writer", async () => {
		const deaf: Summarizer = { summarize: () => new Promise(() => {}) };
		for (let i = 0; i < 3; i++) view.append("user", `m${i} ${"a".repeat(600)}`);
		const compactor = start(deaf, { jobs: 8 });
		await sleep(10);
		const outcome = await Promise.race([compactor.close().then(() => "closed"), sleep(1000).then(() => "hung")]);
		expect(outcome).toBe("closed");
	});

	it("starts a ready merge before a ready leaf", async () => {
		const order: string[] = [];
		const recorder: Summarizer = {
			async summarize(task) {
				order.push(task.part.address);
				return "x".repeat(80);
			},
		};
		for (let i = 0; i < 4; i++) view.append("user", `m${i} ${"a".repeat(600)}`);
		const compactor = start(recorder, { jobs: 1, nodeBytes: 100 });
		await compactor.drain();
		expect(order).toEqual(["0+1", "1+1", "0+2", "2+1", "3+1", "2+2", "0+4"]);
	});

	it("puts a failed merge back in its queue and builds it on the retry", async () => {
		let failures = 0;
		const flaky: Summarizer = {
			async summarize(task) {
				if (task.part.l === 1 && failures++ === 0) throw new Error("outage");
				return "x".repeat(80);
			},
		};
		for (let i = 0; i < 2; i++) view.append("user", `m${i} ${"a".repeat(600)}`);
		const compactor = start(flaky, { nodeBytes: 100, retrySeconds: 0.01 });
		await compactor.drain();
		expect(failures).toBe(2);
		expect(store.hasNode(new Part(1, 0))).toBe(true);
	});

	it("finds at open the merges a restart left ready: both halves built, their parent not", async () => {
		view.append("user", "a".repeat(600));
		view.append("user", "b".repeat(600));
		store.saveNode(new Part(0, 0), "x".repeat(300));
		store.saveNode(new Part(0, 1), "y".repeat(300));
		const compactor = start();
		const outcome = await Promise.race([compactor.drain().then(() => "drained"), sleep(1_000).then(() => "hung")]);
		expect(outcome).toBe("drained");
		expect(store.hasNode(new Part(1, 0))).toBe(true);
	});

	it("never scans the tree: store lookups per built node stay flat from 500 to 2,000 messages", async () => {
		const perNode: number[] = [];
		for (const count of [500, 2000]) {
			const big = MemoryStore.open(join(dir, `scale-${count}.sqlite`));
			try {
				big.appendBatch(Array.from({ length: count }, (_, i) => ({ kind: "user" as const, text: `m${i} ${"a".repeat(600)}` })));
				const bigView = new MemoryView(big, 8_000);
				let lookups = 0;
				const hasNode = big.hasNode.bind(big);
				(big as unknown as { hasNode: (part: Part) => boolean }).hasNode = (part) => {
					lookups++;
					return hasNode(part);
				};
				const compactor = new Compactor(bigView, new DemoSummarizer(100), { nodeBytes: 100, jobs: 8, retrySeconds: 0.01 }, () => {});
				compactor.start();
				await compactor.drain();
				await compactor.close();
				perNode.push(lookups / big.nodeCount);
				// A bulk build ends with a view between its floor (less one merge) and its ceiling, not merged to the top.
				expect(bigView.size).toBeLessThanOrEqual(8_000);
				expect(bigView.size).toBeGreaterThan(4_000 - 200);
			} finally {
				big.close();
			}
		}
		expect(Math.max(...perNode)).toBeLessThan(200);
		expect(perNode[1]).toBeLessThan(perNode[0] * 1.5);
	}, 120_000);
});
