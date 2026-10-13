import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findOnPath } from "../../src/lane/tools.ts";

const scratch = mkdtempSync(join(tmpdir(), "orrery-real-ori-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const isolated = (home: string): NodeJS.ProcessEnv => ({
	HOME: home, PATH: process.env.PATH ?? "", TERM: "dumb",
	XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"), XDG_CACHE_HOME: join(home, ".cache"),
	ORI_TELEMETRY: "0", ORI_NO_UPDATE_CHECK: "1", ORI_DISABLE_UPDATES: "1", ORI_CLAUDE_CLOUD_SESSION_SYNC: "0", ORI_WRAPPED_CLI_OTEL: "0",
});
const wanted = process.env.ORRERY_TEST_ORI ?? findOnPath("ori");
const versionHome = join(scratch, "version");
mkdirSync(versionHome);
const ori = wanted && spawnSync(wanted, ["version", "--semver"], { env: isolated(versionHome), timeout: 5000 }).status === 0 ? wanted : undefined;
const model = "anthropic/claude-haiku-4.5";

for (const agent of ["pi", "omp"] as const) {
	const binary = process.env[agent === "pi" ? "ORRERY_TEST_PI" : "ORRERY_TEST_OMP"] ?? findOnPath(agent);
	describe.skipIf(ori === undefined || binary === undefined)(`Orrery inside real ori ${agent} (isolated home, fake OpenRouter, no model call)`, () => {
		it("loads both extensions, registers Orrery commands and keeps its summary catalog independent", async (context) => {
			const home = join(scratch, agent);
			const lane = join(home, "lane");
			const bin = join(home, "bin");
			mkdirSync(lane, { recursive: true }); mkdirSync(bin);
			symlinkSync(binary!, join(bin, agent));
			const requests: string[] = [];
			const server = createServer((req, res) => {
				requests.push(`${req.method} ${req.url}`);
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify({ data: [{ id: model, name: "Synthetic catalog", context_length: 200000, top_provider: { max_completion_tokens: 8192 }, pricing: { prompt: "0.000001", completion: "0.000005" }, architecture: { input_modalities: ["text"], output_modalities: ["text"] }, supported_parameters: ["tools"] }] }));
			});
			await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
			const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
			const config = join(home, "config.toml");
			writeFileSync(config, `data_dir = ${JSON.stringify(join(home, "data"))}\n[lanes.Probe]\nworkspace = ${JSON.stringify(lane)}\ntool = "${agent}"\nlauncher = "ori"\ncompactor_model = "anthropic/claude-haiku-4-5"\n`);
			const probe = join(home, "probe.ts");
			const local = (file: string) => JSON.stringify(relative(home, resolve(file)));
			writeFileSync(probe, `import { summarySources } from ${local("src/lane/summary-sources.ts")};
import { parseConfig } from ${local("src/lane/config.ts")};
import { FileCredentialStore } from ${local("src/lane/credentials.ts")};
export default function(api) {
 api.on("session_start", async (_event, ctx) => {
  const own = summarySources(parseConfig('data_dir = ' + JSON.stringify(${JSON.stringify(join(home, "probe-data"))}), ${JSON.stringify(home)}), new FileCredentialStore(${JSON.stringify(join(home, "probe-credentials.json"))})).models;
  ctx.ui.notify("ORI_PROBE " + JSON.stringify({ oriMarker: Boolean(process.env.ORI_OPENROUTER_SESSION_ID), ambientRouter: Boolean(process.env.OPENROUTER_API_KEY), summaryAuth: Boolean(await own.getAuth("openrouter")), selected: ctx.model?.provider, sessionAnthropic: ctx.modelRegistry.getAll().filter(m => m.provider === "anthropic").length, summaryAnthropic: own.getModels("anthropic").length, summaryOpenAI: own.getModels("openai").length, summaryOpenRouter: own.getModels("openrouter").length }), "info");
 });
}`);
			const env = { ...isolated(home), PATH: `${bin}:${process.env.PATH ?? ""}`, ORRERY_CONFIG: config, OPENROUTER_API_KEY: "synthetic-offline-key", ORI_OPENROUTER_BASE_URL: endpoint, PI_OFFLINE: "1" };
			const child = spawn(ori!, [agent, "--model", model, "--mode", "rpc", "--no-session", "-e", resolve(`src/${agent}/index.ts`), "-e", probe, ...(agent === "pi" ? ["--offline"] : [])], { cwd: lane, env });
			const frames: Record<string, any>[] = [];
			let output = "";
			let buffer = "";
			child.stderr.on("data", (chunk) => { output += chunk; });
			child.stdout.on("data", (chunk) => {
				output += chunk; buffer += chunk;
				for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
					const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
					try { frames.push(JSON.parse(line)); } catch {}
				}
			});
			const exited = new Promise<void>((done) => child.on("close", () => done()));
			const wait = async (predicate: (f: Record<string, any>) => boolean) => {
				const deadline = Date.now() + 20_000;
				for (;;) {
					const frame = frames.find(predicate);
					if (frame) return frame;
					if (Date.now() > deadline || child.exitCode !== null) throw new Error(`Ori ${agent} did not reach the expected event: ${output.slice(-6000)}`);
					await new Promise((done) => setTimeout(done, 20));
				}
			};
			try {
				await wait((f) => f.method === "setStatus" && f.statusKey === "orrery" && f.statusText?.includes("Orrery · Probe"));
				if (agent === "pi") await wait((f) => f.method === "setStatus" && f.statusKey === "ori-openrouter");
				const facts = JSON.parse((await wait((f) => f.method === "notify" && f.message?.startsWith("ORI_PROBE "))).message.slice(10));
				expect(facts).toMatchObject({ oriMarker: true, ambientRouter: true, summaryAuth: false });
			expect(facts.selected).toBe(agent === "pi" ? "openrouter" : "ori-openrouter");
				if (agent === "pi") expect(facts.sessionAnthropic).toBe(0);
				for (const key of ["summaryAnthropic", "summaryOpenAI", "summaryOpenRouter"]) expect(facts[key]).toBeGreaterThan(0);
				child.stdin.write(`${JSON.stringify({ id: "commands", type: "get_commands" })}\n`);
				const commands = await wait((f) => f.id === "commands" && f.type === "response");
				expect(commands.data.commands.map((c: { name: string }) => c.name)).toEqual(expect.arrayContaining([agent === "pi" ? "memory" : "orrery", "compactor", "browse"]));
				expect(readFileSync(join(home, ".ori", agent, agent === "pi" ? "openrouter-auth.ts" : "openrouter-endpoint.ts"), "utf8")).toContain("ori-openrouter");
				expect(requests.every((r) => r.startsWith("GET "))).toBe(true);
			} catch (error) {
				// Ori 0.15.7 rebases every bundled OMP model to the chat API, including judge models.
				// Keep other startup failures fatal; this exact upstream incompatibility is not Orrery wiring.
				if (agent === "omp" && /Provider ori-openrouter, model typesafe\/jev-router: kind "judge" does not match api "openrouter"/.test(output) && process.env.ORRERY_TEST_ORI_STRICT !== "1") {
					context.skip("Ori 0.15.7 cannot register OMP judge models as chat models; set ORRERY_TEST_ORI_STRICT=1 to fail on this known upstream error.");
				}
				throw error;
			} finally {
				child.kill("SIGTERM");
				const kill = setTimeout(() => child.kill("SIGKILL"), 1000);
				await exited; clearTimeout(kill);
				server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done()));
			}
		}, 30_000);
	});
}
