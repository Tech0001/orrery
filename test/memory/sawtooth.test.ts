import { describe, expect, it } from "vitest";
import { due, type LineSizes, Sawtooth } from "../../src/memory/sawtooth.ts";
import { children, Part } from "../../src/memory/types.ts";

/** Taelin's rollback push (rollback_state_list.js, 2022), without `life`, which stays 0 under push alone. */
interface States {
	readonly keep: 0 | 1;
	readonly state: number;
	readonly older: States | null;
}

function push(state: number, states: States | null): States {
	if (states === null) return { keep: 0, state, older: null };
	if (states.keep === 0) return { keep: 1, state: states.state, older: states.older };
	return { keep: 0, state, older: push(states.state, states.older) };
}

/** push's list read as view lines: each state starts a line that runs to the next newer state; the newest runs to now. */
function pushLines(states: States, total: number): string[] {
	const starts: number[] = [];
	for (let s: States | null = states; s !== null; s = s.older) starts.push(s.state);
	starts.reverse();
	return starts.map((start, k) => {
		const n = (k + 1 < starts.length ? starts[k + 1] : total) - start;
		return new Part(Math.log2(n), start / n).key;
	});
}

const everyLine: LineSizes = { built: () => true, size: () => 1 };

/** The first version's order, `(T - first) / 2^(l+2)`, by a plain scan: the bug Taelin's rewrite fixed. */
function oldOrder(parts: readonly Part[], total: number, lines: number): Part[] {
	const out = [...parts];
	while (out.length > lines) {
		let best = -1;
		let bestDue = -1;
		for (let k = 0; k + 1 < out.length; k++) {
			const [a, b] = [out[k], out[k + 1]];
			if (a.l !== b.l || a.i % 2 !== 0 || b.i !== a.i + 1) continue;
			const old = (total - a.start) / 2 ** (a.l + 2);
			if (old > bestDue) {
				best = k;
				bestDue = old;
			}
		}
		if (best < 0) break;
		out.splice(best, 2, new Part(out[best].l + 1, out[best].i / 2));
	}
	return out;
}

/** Marks message t's leaf and every parent it completes as built, telling the sawtooth as the compactor does. */
function buildUp(saw: Sawtooth, built: Set<string>, t: number, total: number): boolean {
	let merged = false;
	for (let part = new Part(0, t); ; part = new Part(part.l + 1, part.i >> 1)) {
		built.add(part.key);
		merged = saw.built(part, total) || merged;
		if (part.i % 2 === 0) return merged;
	}
}

describe("due", () => {
	it("measures a pair from its last message (Taelin rev 3 §3.2: at T=10, 8-9 merges before 0-7)", () => {
		expect(due(10, new Part(0, 8))).toBe(3);
		expect(due(10, new Part(2, 0))).toBe(2.75);
		const saw = new Sawtooth([new Part(2, 0), new Part(2, 1), new Part(0, 8), new Part(0, 9)], 3, 3, everyLine);
		saw.fit(10);
		expect(saw.parts.map((p) => p.key)).toEqual(["2:0", "2:1", "1:4"]);
	});
});

describe("Sawtooth", () => {
	it("picks exactly the merges Taelin's push makes, t = 0..20,000", () => {
		let states: States | null = null;
		let parts: Part[] = [];
		let mismatches = 0;
		for (let t = 0; t <= 20_000; t++) {
			states = push(t, states);
			const want = pushLines(states, t + 1);
			const saw = new Sawtooth([...parts, new Part(0, t)], want.length, want.length, everyLine);
			saw.fit(t + 1);
			parts = [...saw.parts];
			if (parts.map((p) => p.key).join() !== want.join()) mismatches++;
		}
		expect(mismatches).toBe(0);
	});

	it("shows why: the first-message order misses push at most steps", () => {
		let states: States | null = null;
		let parts: Part[] = [];
		let matches = 0;
		for (let t = 0; t <= 20_000; t++) {
			states = push(t, states);
			const want = pushLines(states, t + 1);
			const got = oldOrder([...parts, new Part(0, t)], t + 1, want.length);
			if (got.map((p) => p.key).join() === want.join()) matches++;
			// Judge each step alone: continue from push's list, not from the old order's own drift.
			parts = want.map((key) => {
				const [l, i] = key.split(":").map(Number);
				return new Part(l, i);
			});
		}
		expect(matches).toBeLessThan(10_000);
	});

	it("batches from the ceiling to the floor, finishing a short batch as parents arrive; appends never merge", () => {
		const built = new Set<string>();
		const saw = new Sawtooth([], 100, 50, { built: (p) => built.has(p.key), size: (p) => (built.has(p.key) ? 20 : 0) });
		const keys = () => saw.parts.map((p) => p.key);
		for (let t = 0; t < 5; t++) {
			saw.append([new Part(0, t)]);
			buildUp(saw, built, t, t + 1);
		}
		expect(keys()).toEqual(["0:0", "0:1", "0:2", "0:3", "0:4"]); // 100 bytes: not past the ceiling
		saw.append([new Part(0, 5)]);
		built.add("0:5");
		expect(saw.built(new Part(0, 5), 6)).toBe(true); // 120 bytes: 0-1, then 2-3, then 0-3; 4-5 has no parent yet
		expect(keys()).toEqual(["2:0", "0:4", "0:5"]);
		expect(saw.short).toBe(true);
		saw.append([new Part(0, 6)]);
		expect(keys()).toEqual(["2:0", "0:4", "0:5", "0:6"]);
		built.add("1:2");
		saw.built(new Part(1, 2), 7); // the short batch ends at the floor
		expect(keys()).toEqual(["2:0", "1:2", "0:6"]);
		expect(saw.short).toBe(false);
		buildUp(saw, built, 6, 8);
		saw.append([new Part(0, 7)]);
		buildUp(saw, built, 7, 8);
		expect(keys()).toEqual(["2:0", "1:2", "0:6", "0:7"]); // 80 bytes: built parents wait for the next batch
		expect(saw.size).toBe(80);
	});

	it("grows a line per message and batches 128 KB down to 64 KB: under 3 lines rewritten per message", () => {
		let seed = 7;
		const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
		const sizes = new Map<string, number>();
		const size = (part: Part): number => {
			let bytes = sizes.get(part.key);
			if (bytes === undefined) {
				if (part.l === 0) {
					bytes = 40 + Math.floor(random() * 472);
				} else {
					const [a, b] = children(part);
					bytes = Math.min(512, size(a) + size(b) + 1);
				}
				sizes.set(part.key, bytes);
			}
			return bytes;
		};
		const built = new Set<string>();
		const saw = new Sawtooth([], 128_000, 64_000, { built: (p) => built.has(p.key), size: (p) => (built.has(p.key) ? size(p) : 0) });
		let rewritten = 0;
		let overCeiling = 0;
		let underFloor = 0;
		let notAppended = 0;
		let previous: string[] = [];
		for (let t = 0; t < 30_000; t++) {
			saw.append([new Part(0, t)]);
			const merged = buildUp(saw, built, t, t + 1);
			const lines = saw.parts.map((p) => p.key);
			if (saw.size > 128_000) overCeiling++;
			if (t >= 3_000 && saw.size < 62_000) underFloor++;
			if (!merged && lines.slice(0, previous.length).join() !== previous.join()) notAppended++;
			let same = 0;
			while (same < previous.length && previous[same] === lines[same]) same++;
			rewritten += lines.length - same;
			previous = lines;
		}
		expect({ overCeiling, underFloor, notAppended }).toEqual({ overCeiling: 0, underFloor: 0, notAppended: 0 });
		expect(rewritten / 30_000).toBeLessThanOrEqual(3);
	});

	it("builds a 20,000-message view fast and ends it between floor and ceiling (a bulk build)", () => {
		const total = 20_000;
		const built = new Set<string>();
		const lines: LineSizes = { built: (p) => built.has(p.key), size: (p) => (built.has(p.key) ? 400 : 0) };
		const started = performance.now();
		const saw = new Sawtooth(
			Array.from({ length: total }, (_, i) => new Part(0, i)),
			128_000,
			64_000,
			lines,
			true,
		);
		saw.fit(total);
		for (let t = 0; t < total; t++) buildUp(saw, built, t, total);
		expect(performance.now() - started).toBeLessThan(5_000);
		expect(saw.size).toBeGreaterThan(64_000 - 800);
		expect(saw.size).toBeLessThanOrEqual(128_000);
		expect(saw.parts.at(-1)?.end).toBe(total);
	});

	it("recounts after nodes were built without telling it", () => {
		const built = new Set<string>();
		const saw = new Sawtooth(
			Array.from({ length: 6 }, (_, i) => new Part(0, i)),
			100,
			50,
			{ built: (p) => built.has(p.key), size: (p) => (built.has(p.key) ? 20 : 0) },
		);
		for (const key of ["0:0", "0:1", "0:2", "0:3", "0:4", "0:5", "1:0", "1:1", "1:2", "2:0"]) built.add(key);
		expect(saw.size).toBe(0);
		expect(saw.resync(6)).toBe(true);
		expect(saw.parts.map((p) => p.key)).toEqual(["2:0", "1:2"]);
	});

	it("keeps its size equal to a recount of its built lines, whatever order nodes are built and told in", () => {
		let seed = 11;
		const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
		const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
		const sizes = new Map<string, number>();
		const built = new Set<string>();
		const lines: LineSizes = { built: (p) => built.has(p.key), size: (p) => (built.has(p.key) ? (sizes.get(p.key) ?? 0) : 0) };
		const saw = new Sawtooth([], 600, 300, lines);
		const recount = () => saw.parts.reduce((sum, part) => sum + lines.size(part), 0);
		// Unbuilt nodes that may be built now: appended leaves, and parents whose halves are both built.
		const ready = new Map<string, Part>();
		const done: Part[] = [];
		let total = 0;
		const mark = (part: Part) => {
			sizes.set(part.key, 1 + Math.floor(random() * 60));
			built.add(part.key);
			done.push(part);
			ready.delete(part.key);
			const parent = new Part(part.l + 1, part.i >> 1);
			if (parent.end <= total && children(parent).every((child) => built.has(child.key))) ready.set(parent.key, parent);
		};
		const ops = { unbuiltLeaf: 0, builtLeaf: 0, builtLeafTold: 0, told: 0, toldAgain: 0, resync: 0, fit: 0 };
		let mismatches = 0;
		let firstMismatch = "";
		for (let step = 0; step < 4_000; step++) {
			const r = random();
			const leaf = new Part(0, total);
			if (r < 0.15) {
				total++;
				ready.set(leaf.key, leaf);
				saw.append([leaf]);
				ops.unbuiltLeaf++;
			} else if (r < 0.3) {
				// A leaf built before it joins: what the compaction view sees for a message saved verbatim.
				total++;
				mark(leaf);
				saw.append([leaf]);
				if (random() < 0.5) {
					saw.built(leaf, total);
					ops.builtLeafTold++;
				} else ops.builtLeaf++;
			} else if (r < 0.7 && ready.size > 0) {
				const part = pick([...ready.values()]);
				mark(part);
				saw.built(part, total);
				ops.told++;
			} else if (r < 0.8 && done.length > 0) {
				saw.built(pick(done), total);
				ops.toldAgain++;
			} else if (r < 0.9 && ready.size > 0) {
				// Built without telling it, then recounted: what a reopened view or `fit()` sees.
				mark(pick([...ready.values()]));
				saw.resync(total);
				ops.resync++;
			} else {
				saw.fit(total);
				ops.fit++;
			}
			if (saw.size !== recount() && mismatches++ === 0) firstMismatch = `step ${step}: size ${saw.size}, recount ${recount()}`;
		}
		expect({ mismatches, firstMismatch }).toEqual({ mismatches: 0, firstMismatch: "" });
		for (const count of Object.values(ops)) expect(count).toBeGreaterThan(50);
		expect(saw.parts.length).toBeLessThan(total / 4); // it merged a lot along the way
	});

	it("refuses lines that do not continue the view, and appends of anything but leaves", () => {
		expect(() => new Sawtooth([new Part(0, 1)], 10, 5, everyLine)).toThrow(RangeError);
		expect(() => new Sawtooth([], 10, 11, everyLine)).toThrow(RangeError);
		const saw = new Sawtooth([new Part(0, 0)], 10, 5, everyLine);
		expect(() => saw.append([new Part(1, 1)])).toThrow(RangeError);
		expect(() => saw.append([new Part(0, 2)])).toThrow(RangeError);
	});
});
