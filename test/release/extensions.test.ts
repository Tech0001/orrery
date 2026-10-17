import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { OMP_SUPPLIED, OPENCODE_SUPPLIED } from "../../scripts/build-release.ts";
import { builtRelease, bunReady, REPO, removeBuiltRelease } from "./support.ts";

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

/** src/agent/models.ts's OMP-only fallback to this repo's own pi-ai, as the source writes it. */
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

	it("OpenCode's plugin folder holds server.js for Bun, importing nothing but builtins and what OpenCode supplies, with its map", async () => {
		const folder = join(await builtRelease(), "extensions", "opencode");
		// OpenCode loads a plugin folder's server.*, index.*, tui.* and rpc.*: only server.js is there to load.
		expect(readdirSync(folder).sort()).toEqual(["server.js", "server.js.map"]);
		const server = join(folder, "server.js");
		const left = bareImports(server);
		expect(left.every((s) => OPENCODE_SUPPLIED.some((host) => s === host || s.startsWith(`${host}/`))), left.join(", ")).toBe(true);
		const text = readFileSync(server, "utf8");
		expect(text.startsWith("// @bun\n")).toBe(true);
		expect(text).toMatch(/\/\/# sourceMappingURL=server\.js\.map\s*$/);
	});

	it("a packed pi-ai OAuth loader comes with its flows registered (it imports them by paths only node_modules has)", async () => {
		const extensions = join(await builtRelease(), "extensions");
		const registered = (file: string) => {
			const text = readFileSync(join(extensions, file), "utf8");
			return !text.includes("importOAuthModule") || /registerBunOAuthFlows\(\)/.test(text);
		};
		// omp.js packs the loader and registers the flows; OpenCode's plugin must do the same once it packs one.
		expect(readFileSync(join(extensions, "omp.js"), "utf8")).toContain("importOAuthModule");
		expect(registered("omp.js")).toBe(true);
		expect(registered(join("opencode", "server.js"))).toBe(true);
	});

	it("omp.js carries the OAuth flows it signs in with: a summary call on the ChatGPT sign-in reaches OpenAI", async () => {
		// pi-ai imports its OAuth flows by a file path that exists only in node_modules, not beside a packed omp.js.
		// omp.js runs from a scratch folder outside the repository, with an empty stand-in for the one import OMP serves
		// from its own pi-ai (pi-ai/compat, which has no model registry), as OMP has it.
		const base = mkdtempSync(join(tmpdir(), "orrery-omp-oauth-"));
		try {
			const extension = join(base, "extensions", "omp.js");
			const compat = join(base, "node_modules", "@earendil-works", "pi-ai");
			const agent = join(base, "agent");
			for (const dir of [join(base, "extensions"), compat, agent, join(base, "home")]) mkdirSync(dir, { recursive: true });
			copyFileSync(join(await builtRelease(), "extensions", "omp.js"), extension);
			writeFileSync(join(compat, "package.json"), JSON.stringify({ name: "@earendil-works/pi-ai", type: "module", exports: { "./compat": "./compat.js" } }));
			writeFileSync(join(compat, "compat.js"), "export {};\n");
			writeFileSync(join(base, "logins.json"), JSON.stringify({ openai: { type: "oauth", access: "test-access-token", refresh: "r", expires: Date.now() + 3_600_000 } }), { mode: 0o600 });
			writeFileSync(
				join(base, "config.toml"),
				[`data_dir = ${JSON.stringify(join(base, "data"))}`, `credentials = ${JSON.stringify(join(base, "logins.json"))}`, "[updates]", "check = false", "[agents.Probe]", `folder = ${JSON.stringify(agent)}`, 'tool = "omp"', 'compactor_model = "openai/gpt-5.4-mini"', 'compactor_thinking = "off"', ""].join("\n"),
			);
			// `/compactor reset` makes one test call on the agent's configured model.
			const r = spawnSync("bun", [join(REPO, "test", "release", "omp-host.ts"), extension, "reset"], { cwd: agent, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: join(base, "home"), ORRERY_CONFIG: join(base, "config.toml") } });
			expect(r.status, r.stderr).toBe(0);
			const { notices, requests } = JSON.parse(r.stdout.trim().split("\n").at(-1) as string) as { notices: { message: string; type?: string }[]; requests: { url: string; authorization: string | null }[] };
			expect(notices.map((notice) => notice.message).join("\n")).not.toContain("OAuth");
			expect(requests).toEqual([{ url: "https://api.openai.com/v1/responses", authorization: "Bearer test-access-token" }]);
			// The host answers 401, so the switch is refused for the sign-in, not for a missing module.
			expect(notices.at(-1)).toEqual({ message: "Not switched: the ChatGPT sign-in expired or was refused (orrery login openai). Still on openai/gpt-5.4-mini.", type: "error" });
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	}, 60_000);
});
