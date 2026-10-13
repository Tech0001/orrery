import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Compactor, DemoSummarizer, MemoryStore, MemoryView, ruler, VIEW_KEY } from "../../src/memory/index.ts";
import { type FixtureMessage, makeFixture } from "./fixture.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const hasUv = spawnSync("uv", ["--version"]).status === 0;
const MORE = 40;

interface Golden {
	nodes: Array<[number, number, string]>;
	fresh: Array<[number, number]>;
	freshRender: string;
	steps: Array<Array<[number, number]>>;
	render: string;
	scale: string;
}

function runPython(fixtureFile: string, nodeBytes: number, viewBytes: number): Golden {
	const output = execFileSync(
		"uv",
		["run", "--quiet", "--project", "reference/optchat-py", "python", "test/golden/optchat_golden.py", fixtureFile, String(nodeBytes), String(viewBytes), String(MORE)],
		{ cwd: repoRoot, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" }, maxBuffer: 64 * 1024 * 1024 },
	);
	return JSON.parse(output) as Golden;
}

const lines = (view: MemoryView) => view.parts.map((part): [number, number] => [part.l, part.i]);

async function runPort(fixture: FixtureMessage[], dir: string, nodeBytes: number, viewBytes: number): Promise<Golden> {
	const file = join(dir, "memory.sqlite");
	const config = { nodeBytes, jobs: 4, retrySeconds: 0.01 };
	let store = MemoryStore.open(file);
	try {
		const view = new MemoryView(store, viewBytes);
		for (const message of fixture.slice(0, -MORE)) view.append(message.kind, message.text, message.date);
		const compactor = new Compactor(view, new DemoSummarizer(nodeBytes), config, () => {});
		compactor.start();
		await compactor.drain();
		await compactor.close();
	} finally {
		store.close();
	}
	// The Python reference builds its view at every open (it keeps no saved view); drop ours so this open builds too.
	const raw = new DatabaseSync(file);
	raw.prepare("DELETE FROM meta WHERE key = ?").run(VIEW_KEY);
	raw.close();
	store = MemoryStore.open(file);
	try {
		const view = new MemoryView(store, viewBytes);
		const fresh = lines(view);
		const freshRender = view.render();
		const compactor = new Compactor(view, new DemoSummarizer(nodeBytes), config, () => {});
		compactor.start();
		const steps: Array<Array<[number, number]>> = [];
		for (const message of fixture.slice(-MORE)) {
			view.append(message.kind, message.text, message.date);
			await compactor.drain();
			steps.push(lines(view));
		}
		await compactor.close();
		const nodes = [...store.nodes()]
			.map((node): [number, number, string] => [node.l, node.i, node.text])
			.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
		return { nodes, fresh, freshRender, steps, render: view.render(), scale: ruler(nodeBytes) };
	} finally {
		store.close();
	}
}

describe.skipIf(!hasUv)("golden cross-check against the Python reference", () => {
	for (const [count, nodeBytes, viewBytes] of [
		[240, 128, 4000],
		[130, 64, 1500],
	] as const) {
		it(`builds the identical tree, fresh view and live sawtooth (${count}+${MORE} messages, node ${nodeBytes}, view ${viewBytes})`, async () => {
			const dir = mkdtempSync(join(tmpdir(), "orrery-golden-"));
			try {
				const fixture = makeFixture(count + MORE);
				const fixtureFile = join(dir, "fixture.jsonl");
				writeFileSync(fixtureFile, `${fixture.map((m) => JSON.stringify(m)).join("\n")}\n`);
				const expected = runPython(fixtureFile, nodeBytes, viewBytes);
				const actual = await runPort(fixture, dir, nodeBytes, viewBytes);
				expect(actual.nodes).toEqual(expected.nodes);
				expect(actual.fresh).toEqual(expected.fresh);
				expect(actual.freshRender).toBe(expected.freshRender);
				expect(actual.steps).toEqual(expected.steps);
				expect(actual.render).toBe(expected.render);
				expect(actual.scale).toBe(expected.scale);
				expect(actual.fresh.length).toBeGreaterThan(1);
				expect(actual.nodes.some(([l]) => l >= 3)).toBe(true);
				// At least one batch ran during the live messages: a step with fewer lines than the one before.
				expect(actual.steps.some((step, k) => k > 0 && step.length < actual.steps[k - 1].length)).toBe(true);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}, 180_000);
	}
});
