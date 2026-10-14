import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A compiled pi loads extensions with its own embedded copies of these packages and nothing else from @earendil-works.
 * Any other runtime import of them resolves from orrery's node_modules, where the lazy API loads fail
 * ("Cannot find package 'partial-json'"). Type-only imports are erased and fine.
 */
const VIRTUAL = new Set<string>();
for (const scope of ["@earendil-works", "@mariozechner"]) {
	for (const name of ["pi-agent-core", "pi-tui", "pi-ai", "pi-ai/compat", "pi-ai/oauth", "pi-ai/providers/all", "pi-coding-agent"]) VIRTUAL.add(`${scope}/${name}`);
}
for (const name of ["typebox", "typebox/compile", "typebox/value", "@sinclair/typebox", "@sinclair/typebox/compile", "@sinclair/typebox/value"]) VIRTUAL.add(name);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PI_ENTRY = join(ROOT, "src", "pi", "index.ts");
const OMP_ENTRY = join(ROOT, "src", "omp", "index.ts");
const rel = (file: string) => file.slice(ROOT.length + 1);

const FROM = /(?:^|[\n;])\s*(import|export)\s+(type\s+)?([^"'`;]*?)\s*from\s*["']([^"']+)["']/g;
const SIDE_EFFECT = /(?:^|[\n;])\s*import\s*["']([^"']+)["']/g;
const DYNAMIC = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

interface Specifier {
	readonly spec: string;
	readonly dynamic: boolean;
}

/** Runtime specifiers in a file. `import { type A } from` still loads the module, so only `import type` is skipped. */
function runtimeSpecifiers(source: string): Specifier[] {
	const found: Specifier[] = [];
	for (const m of source.matchAll(FROM)) {
		if (m[2] === undefined && m[4] !== undefined) found.push({ spec: m[4], dynamic: false });
	}
	for (const m of source.matchAll(SIDE_EFFECT)) if (m[1] !== undefined) found.push({ spec: m[1], dynamic: false });
	for (const m of source.matchAll(DYNAMIC)) if (m[1] !== undefined) found.push({ spec: m[1], dynamic: true });
	return found;
}

interface Import {
	/** The importing file, relative to the repo root. */
	readonly file: string;
	readonly spec: string;
	readonly dynamic: boolean;
}

/**
 * Everything `entry` loads: the files it reaches (`seen`, absolute), imports of @earendil-works or @mariozechner
 * packages pi does not embed (`bad`), relative imports that land in a node_modules folder, which are not followed
 * (`into`), and every bare import (`bare`).
 */
function walk(entry: string): { bad: string[]; seen: Set<string>; into: Import[]; bare: Import[] } {
	const seen = new Set<string>();
	const bad: string[] = [];
	const into: Import[] = [];
	const bare: Import[] = [];
	const visit = (file: string): void => {
		if (seen.has(file)) return;
		seen.add(file);
		const name = file.slice(ROOT.length + 1);
		for (const { spec, dynamic } of runtimeSpecifiers(readFileSync(file, "utf8"))) {
			if (spec.startsWith(".")) {
				const target = resolve(dirname(file), spec);
				if (!existsSync(target)) bad.push(`${name} has a relative import "${spec}" that resolves to no file`);
				else if (target.includes(`${sep}node_modules${sep}`)) into.push({ file: name, spec, dynamic });
				else visit(target);
				continue;
			}
			bare.push({ file: name, spec, dynamic });
			if ((spec.startsWith("@earendil-works/") || spec.startsWith("@mariozechner/")) && !VIRTUAL.has(spec)) bad.push(`${name} imports ${spec}`);
		}
	};
	visit(entry);
	return { bad, seen, into, bare };
}

describe("pi extension entry points", () => {
	it("imports only the packages pi embeds, from everything the extension loads", () => {
		const { bad, seen } = walk(PI_ENTRY);
		expect(bad).toEqual([]);
		// The walk must really reach the file that caused the bug, or this test proves nothing.
		expect([...seen].map((file) => file.slice(ROOT.length + 1))).toContain(join("src", "agent", "models.ts"));
	});

	it("never reaches the TUI or the Node-only modules it uses", () => {
		const reached = [...walk(PI_ENTRY).seen].map((file) => file.slice(ROOT.length + 1));
		const nodeOnly = ["compactor-target", "config-edit", "overview", "launch", "tools", "logins"].map((name) => join("src", "agent", `${name}.ts`));
		expect(reached.filter((file) => file.startsWith(join("src", "tui") + sep) || nodeOnly.includes(file))).toEqual([]);
		expect(reached.length).toBeGreaterThan(10);
	});

	it("reaches orrery's own pi-ai only through models.ts's dynamic import, OMP's fallback that pi never takes", () => {
		// The file must exist (walk reports a relative import that resolves to no file), so an npm layout change fails here.
		expect(walk(PI_ENTRY).into).toEqual([{ file: join("src", "agent", "models.ts"), spec: "../../node_modules/@earendil-works/pi-ai/dist/compat.js", dynamic: true }]);
	});

	it("never reaches OMP's entry or anything in src/omp from pi's entry", () => {
		expect([...walk(PI_ENTRY).seen].map(rel).filter((file) => file.startsWith(join("src", "omp") + sep))).toEqual([]);
	});

	it("loads from OMP's entry what pi's loads, plus src/omp, under the same import rule", () => {
		const omp = walk(OMP_ENTRY);
		const pi = walk(PI_ENTRY).seen;
		expect(omp.bad).toEqual([]);
		expect([...omp.seen].filter((file) => !pi.has(file)).map(rel).filter((file) => !file.startsWith(join("src", "omp") + sep))).toEqual([]);
	});

	it("reaches OMP's internals only by dynamic import from src/omp, and never from pi's entry", () => {
		const inOmp = walk(OMP_ENTRY).bare.filter((b) => b.file.startsWith(join("src", "omp") + sep));
		expect(inOmp.filter((b) => b.spec.startsWith("@oh-my-pi/")).map((b) => b.spec)).toEqual(["@oh-my-pi/pi-coding-agent/config/registry"]);
		expect(inOmp.filter((b) => b.spec.startsWith("@oh-my-pi/") || b.spec.startsWith("@earendil-works/")).every((b) => b.dynamic)).toBe(true);
		expect(walk(PI_ENTRY).bare.filter((b) => b.spec.startsWith("@oh-my-pi/"))).toEqual([]);
	});
});
