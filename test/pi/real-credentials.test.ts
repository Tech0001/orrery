import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const scratch = mkdtempSync(join(tmpdir(), "orrery-real-credentials-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Even version probes get a scratch HOME/XDG and no inherited agent settings or credentials. */
function isolated(home: string): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH ?? "",
		HOME: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_DATA_HOME: join(home, ".local", "share"),
		XDG_STATE_HOME: join(home, ".local", "state"),
		XDG_CACHE_HOME: join(home, ".cache"),
		TERM: "dumb",
	};
}

function findTool(name: string, override: string | undefined): string | null {
	const home = join(scratch, `${name}-version`);
	mkdirSync(home, { recursive: true });
	const wanted = override ?? name;
	const candidates = wanted.includes("/") ? [wanted] : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, wanted));
	return candidates.find((path) => spawnSync(path, ["--version"], { cwd: home, env: isolated(home), timeout: 30_000 }).status === 0) ?? null;
}

for (const [name, binary] of [["pi", findTool("pi", process.env.ORRERY_TEST_PI)], ["OMP", findTool("omp", process.env.ORRERY_TEST_OMP)]] as const) {
	describe.skipIf(binary === null)(`FileCredentialStore inside a real ${name}`, () => {
		it("locks and saves three consecutive OAuth updates in one extension process", () => {
			const home = join(scratch, name);
			mkdirSync(home, { recursive: true });
			if (name === "OMP") {
				// RPC needs a selected model to start; EOF exits without ever making a model call.
				const agent = join(home, ".omp", "agent");
				mkdirSync(agent, { recursive: true });
				writeFileSync(join(agent, "models.yml"), `providers:
  synthetic:
    baseUrl: http://127.0.0.1:1/v1
    apiKey: fake
    api: openai-completions
    models:
      - id: m
        name: m
        reasoning: false
        input: [text]
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        contextWindow: 8000
        maxTokens: 1000
`);
				writeFileSync(join(agent, "config.yml"), "modelRoles:\n  default: synthetic/m\nsetupVersion: 2\n");
			}
			const file = join(home, "credentials.json");
			const fixture = join(home, "fixture.ts");
			const source = relative(home, fileURLToPath(new URL("../../src/lane/credentials.ts", import.meta.url)));
			writeFileSync(fixture, `import { FileCredentialStore } from ${JSON.stringify(source)};

const store = new FileCredentialStore(${JSON.stringify(file)});
try {
	for (let step = 1; step <= 3; step++) {
		await store.modify("synthetic", async (current) => {
			if ((current?.expires ?? 0) !== step - 1) throw new Error("previous update was not saved");
			return { type: "oauth", access: "fake-access", refresh: "fake-refresh", expires: step };
		});
		console.log("locked: " + step);
	}
	${name === "pi" ? "process.exit(0);" : ""}
} catch (error) {
	console.error(error);
	${name === "pi" ? "process.exit(1);" : "throw error;"}
}
export default function () {}
`);
			const args = name === "pi" ? ["-ne", "-e", fixture, "--no-session", "-p", "x"] : ["--mode", "rpc", "-e", fixture, "--no-session"];
			const result = spawnSync(binary as string, args, {
				cwd: home, env: isolated(home), encoding: "utf8", timeout: 30_000,
			});
			const output = `${result.stdout}\n${result.stderr}\n${result.error ?? ""}`;
			expect(result.status, output).toBe(0);
			// pi's print mode sends an extension's console output to stderr; the order of the lines is what counts.
			expect(`${result.stdout}\n${result.stderr}`.match(/^locked: \d+$/gm), output).toEqual(["locked: 1", "locked: 2", "locked: 3"]);
			expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ synthetic: { type: "oauth", access: "fake-access", refresh: "fake-refresh", expires: 3 } });
		}, 45_000);
	});
}
