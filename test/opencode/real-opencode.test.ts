import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { opencodeVersionOutput } from "../../src/agent/tools.ts";
import { opencodePluginGate, probePlugin, readOpenCodeCheck } from "../../src/opencode/check.ts";
import { configContent } from "../../src/opencode/options.ts";
import { builtRelease, bunReady, removeBuiltRelease } from "../release/support.ts";

/**
 * The installed OpenCode itself, with Orrery's packed plugin, asked without a model and without its user's setup:
 * every run here has a scratch HOME, XDG folders and TMPDIR, and nothing inherited but PATH. Nothing is ever written to
 * the person's ~/.config/opencode, ~/.local/share/opencode, ~/.local/state/opencode or ~/.cache/opencode, and their
 * background service is never asked (each server here is a private `serve` on a port of its own).
 */
const scratch = mkdtempSync(join(tmpdir(), "orrery-real-opencode-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function isolated(name: string): NodeJS.ProcessEnv {
	const dir = mkdtempSync(join(scratch, `${name}-`));
	for (const sub of ["home", "config", "data", "state", "cache", "tmp"]) mkdirSync(join(dir, sub));
	return {
		PATH: process.env.PATH ?? "",
		HOME: join(dir, "home"),
		XDG_CONFIG_HOME: join(dir, "config"),
		XDG_DATA_HOME: join(dir, "data"),
		XDG_STATE_HOME: join(dir, "state"),
		XDG_CACHE_HOME: join(dir, "cache"),
		TMPDIR: join(dir, "tmp"),
		OPENCODE_DISABLE_AUTOUPDATE: "1",
		OPENCODE_DISABLE_MODELS_FETCH: "1",
		ORRERY_RELEASES_URL: "http://127.0.0.1:9/releases",
	};
}

/** The opencode binary: ORRERY_TEST_OPENCODE, or "opencode" on PATH; null when there is none. */
function findOpenCode(): string | null {
	const works = (path: string) => spawnSync(path, ["--version"], { env: isolated("version"), timeout: 30_000 }).status === 0;
	const wanted = process.env.ORRERY_TEST_OPENCODE ?? "opencode";
	if (wanted.includes("/")) return works(wanted) ? wanted : null;
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (dir !== "" && existsSync(join(dir, wanted)) && works(join(dir, wanted))) return join(dir, wanted);
	}
	return null;
}

const opencode = findOpenCode();
const version = opencode === null ? "" : (spawnSync(opencode, ["--version"], { env: isolated("version"), encoding: "utf8" }).stdout.match(/\d+\.\d+\.\d+\S*/)?.[0] ?? "");

/** The release whose plugin is tested: the binary's under test:binary, ORRERY_TEST_RELEASE's, or one built here (Bun). */
const releaseAt = process.env.ORRERY_TEST_BIN ? dirname(dirname(process.env.ORRERY_TEST_BIN)) : process.env.ORRERY_TEST_RELEASE || undefined;
const release = (): Promise<string> => (releaseAt !== undefined ? Promise.resolve(releaseAt) : builtRelease());

/** The packed plugin folder, copied into a folder outside the repository and the release. */
async function pluginCopy(): Promise<string> {
	const to = join(mkdtempSync(join(scratch, "plugin-")), "opencode");
	cpSync(join(await release(), "extensions", "opencode"), to, { recursive: true });
	return to;
}

/**
 * A private `opencode serve --stdio --port 0` given `content`, read until the plugin from `folder` is listed, then
 * stopped: what it listed for the plugin, and what the server wrote on stderr (the plugin's own line among it).
 */
function serveOnce(content: string, folder: string): Promise<{ readonly state: unknown; readonly stderr: string }> {
	const env = isolated("serve");
	const cwd = mkdtempSync(join(scratch, "cwd-"));
	const password = "test-password-1";
	return new Promise((done, fail) => {
		const child = spawn(opencode as string, ["serve", "--stdio", "--port", "0"], { cwd, env: { ...env, OPENCODE_PASSWORD: password, OPENCODE_CONFIG_CONTENT: content }, stdio: ["pipe", "pipe", "pipe"] });
		let stderr = "";
		let out = "";
		let state: unknown;
		const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("exit", () => {
			clearTimeout(timer);
			if (state === undefined) fail(new Error(`no answer; stderr: ${stderr}`));
			else done({ state, stderr });
		});
		child.stdout.on("data", async (chunk) => {
			if (out.includes("\n")) return;
			out += chunk;
			if (!out.includes("\n")) return;
			const { url } = JSON.parse(out.slice(0, out.indexOf("\n"))) as { url: string };
			for (let i = 0; i < 100 && state === undefined; i++) {
				const response = await fetch(`${url}/api/plugin?location%5Bdirectory%5D=${encodeURIComponent(cwd)}`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } });
				const list = (await response.json()) as { data: { source: { type: string; path?: string }; state: unknown }[] };
				state = list.data.find((plugin) => plugin.source.type === "local" && plugin.source.path?.startsWith(folder))?.state;
				if (state === undefined) await new Promise((wait) => setTimeout(wait, 100));
			}
			child.stdin.end();
		});
	});
}

describe.skipIf(opencode === null || (releaseAt === undefined && !bunReady))("Orrery's plugin in the installed OpenCode (scratch homes, no model)", () => {
	afterAll(removeBuiltRelease);

	it("loads the packed plugin from a folder outside the repository: active, with its options", async () => {
		const folder = await pluginCopy();
		const content = configContent(folder, { agent: "Probe", tokenFile: join(scratch, "no-token-yet") });
		const served = await serveOnce(content, folder);
		expect(served.state).toEqual({ status: "active" });
		expect(served.stderr).toContain("Orrery: loaded for Probe.");
		// Orrery's own check says the same.
		expect(await probePlugin(opencode as string, content, folder, { env: isolated("probe") })).toEqual({ ok: true });
	}, 60_000);

	it("finds a plugin that fails to load, and one OpenCode leaves out (a file, not a folder), and says why", async () => {
		const broken = join(mkdtempSync(join(scratch, "broken-")), "opencode");
		mkdirSync(broken);
		writeFileSync(join(broken, "server.js"), 'export default { id: "orrery", setup() { const x = ; } };\n');
		const content = configContent(broken, { agent: "Probe", tokenFile: join(scratch, "t") });
		expect(await probePlugin(opencode as string, content, broken, { env: isolated("probe") })).toEqual({ ok: false, why: "OpenCode could not load Orrery's plugin (Plugin failed to load)" });
		const file = join(await pluginCopy(), "server.js");
		const skipped = await probePlugin(opencode as string, configContent(file, { agent: "Probe", tokenFile: join(scratch, "t") }), file, { env: isolated("probe") });
		expect(skipped).toEqual({ ok: false, why: "OpenCode loaded its plugins without Orrery's (a policy or a config may leave it out)" });
	}, 60_000);

	it("keeps a passing check for this OpenCode version in Orrery's home", async () => {
		const folder = await pluginCopy();
		const env = { ...isolated("gate"), ORRERY_HOME: join(scratch, "gate-orrery") };
		const content = configContent(folder, { agent: "Probe", tokenFile: join(scratch, "t") });
		expect(await opencodePluginGate({ path: opencode as string, version, content, folder }, { env, orrery: "0.0.0-test" })).toEqual({ ok: true });
		expect(readOpenCodeCheck(env)).toMatchObject({ version, orrery: "0.0.0-test", ok: true });
		expect(JSON.parse(readFileSync(join(env.ORRERY_HOME, "opencode-check.json"), "utf8"))).toMatchObject({ opencode: version, ok: true });
	}, 60_000);

	it("asks OpenCode's version in a scratch home: the folders the environment names get nothing", () => {
		const env = isolated("version-probe");
		const asked = opencodeVersionOutput(opencode as string, env);
		expect(asked.status).toBe(0);
		expect(asked.stdout).toContain(version);
		// OpenCode writes a log line even for --version; it went to Orrery's scratch home, not to these.
		for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "HOME"] as const) expect(readdirSync(env[key] as string), key).toEqual([]);
	});
});
