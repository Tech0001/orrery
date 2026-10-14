import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { OMP_SUPPLIED } from "../../scripts/build-release.ts";
import { builtRelease, bunReady, removeBuiltRelease } from "./support.ts";

/**
 * Bare specifiers a packed file still imports (node: builtins and Node's bare builtin names left out): the static imports
 * and re-exports Bun writes at the start of a line, and import() and require() calls. Words in a packed package's strings
 * are not imports: openai's error text says "from 'undici'" and "from 'apiKey' function".
 */
function bareImports(file: string): string[] {
	const text = readFileSync(file, "utf8");
	const found = new Set<string>();
	const spec = `["']([^"'./\\n][^"'\\n]*)["']`;
	const imports = new RegExp(`^[ \\t]*(?:import|export)\\b[^"'\`;]*?\\bfrom\\s*${spec}|^[ \\t]*import\\s*${spec}|(?:\\bimport|require)\\s*\\(\\s*${spec}\\s*\\)`, "gm");
	for (const m of text.matchAll(imports)) found.add((m[1] ?? m[2] ?? m[3]) as string);
	const builtin = (s: string) => s.startsWith("node:") || s.startsWith("bun:") || /^(assert|buffer|child_process|constants|crypto|events|fs|fs\/promises|http|https|module|net|os|path|process|querystring|stream|stream\/web|string_decoder|timers|tls|tty|url|util|worker_threads|zlib)$/.test(s);
	return [...found].filter((s) => !builtin(s)).sort();
}

/** src/lane/models.ts's OMP-only fallback to this repo's own pi-ai, as the source writes it. */
const FALLBACK = 'import("../../node_modules/@earendil-works/pi-ai/dist/compat.js")';

describe.skipIf(!bunReady)("packed extensions", () => {
	afterAll(removeBuiltRelease);

	it("pi.js imports only what pi supplies, and has a source map", async () => {
		const folder = await builtRelease();
		expect(bareImports(join(folder, "extensions", "pi.js"))).toEqual(["@earendil-works/pi-ai/compat", "@earendil-works/pi-ai/providers/all", "typebox"].sort());
		expect(readFileSync(join(folder, "extensions", "pi.js"), "utf8")).toMatch(/\/\/# sourceMappingURL=pi\.js\.map\s*$/);
	});

	it("pi.js leaves OMP's fallback pi-ai out, unpacked behind the import pi never takes; omp.js packs it", async () => {
		const folder = await builtRelease();
		expect(readFileSync(join(folder, "extensions", "pi.js"), "utf8")).toContain(FALLBACK);
		expect(readFileSync(join(folder, "extensions", "omp.js"), "utf8")).not.toContain(FALLBACK);
	});

	it("omp.js leaves out only what OMP rewrites onto its own copies", async () => {
		const folder = await builtRelease();
		const left = bareImports(join(folder, "extensions", "omp.js"));
		expect(left.every((s) => OMP_SUPPLIED.includes(s)), left.join(", ")).toBe(true);
		expect(left).not.toContain("@earendil-works/pi-ai/providers/all");
		expect(left).not.toContain("typebox");
		expect(readFileSync(join(folder, "extensions", "omp.js"), "utf8")).toMatch(/\/\/# sourceMappingURL=omp\.js\.map\s*$/);
	});
});
