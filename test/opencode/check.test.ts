import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { opencodeCheckDetail, opencodePluginGate, probePlugin, readOpenCodeCheck } from "../../src/opencode/check.ts";
import { configContent } from "../../src/opencode/options.ts";
import { scratchEnv } from "../../src/opencode/scratch.ts";
import { tempDir } from "../agent/support.ts";
import { fakeOpenCode } from "./fake-opencode.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scene(mode: Parameters<typeof fakeOpenCode>[1] = {}) {
	const dir = tempDir("orrery-opencode-check-");
	dirs.push(dir);
	const bin = join(dir, "bin");
	const folder = join(dir, "plugin");
	mkdirSync(bin);
	mkdirSync(folder);
	const fake = fakeOpenCode(bin, mode);
	const content = configContent(folder, { agent: "Atlas", tokenFile: join(dir, "tokens", "opencode-1-aaaaaaaaaaaa") });
	const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: join(dir, "home"), ORRERY_HOME: join(dir, "home", ".orrery"), ORRERY_CONFIG: join(dir, "config.toml"), OPENCODE_CONFIG: join(dir, "theirs.json"), XDG_DATA_HOME: join(dir, "real-data") };
	return { dir, bin, folder, fake, content, env };
}

describe("probePlugin", () => {
	it("starts a private server in a scratch home with the launch's config content, and finds the plugin active", async () => {
		const s = scene();
		const listeners = ["SIGTERM", "SIGHUP", "exit"].map((name) => process.listenerCount(name));
		expect(await probePlugin(s.fake.path, s.content, s.folder, { env: s.env })).toEqual({ ok: true });
		const [run] = s.fake.runs();
		expect(run?.args).toEqual(["serve", "--stdio", "--port", "0"]);
		// The same config content as the launch; a password of its own; nothing of the person's OpenCode or Orrery.
		expect(run?.env.OPENCODE_CONFIG_CONTENT).toBe(s.content);
		expect(run?.env.OPENCODE_PASSWORD).toMatch(/^[A-Za-z0-9_-]{32}$/);
		expect(run?.env.OPENCODE_CONFIG).toBeUndefined();
		expect(Object.keys(run?.env ?? {}).filter((key) => key.startsWith("ORRERY_"))).toEqual([]);
		expect([run?.env.OPENCODE_DISABLE_AUTOUPDATE, run?.env.OPENCODE_DISABLE_MODELS_FETCH]).toEqual(["1", "1"]);
		for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "TMPDIR"]) {
			expect(run?.env[key]?.startsWith(join(tmpdir(), "orrery-opencode-")), key).toBe(true);
		}
		expect(run?.cwd.startsWith(join(tmpdir(), "orrery-opencode-"))).toBe(true);
		// The lease ended through stdin, and the scratch folder is gone, with the handlers that would remove it on a signal.
		expect(s.fake.ended()).toHaveLength(1);
		expect(existsSync(dirname(run?.env.HOME as string))).toBe(false);
		expect(["SIGTERM", "SIGHUP", "exit"].map((name) => process.listenerCount(name))).toEqual(listeners);
	});

	it("waits while OpenCode is still loading its plugins (an empty list)", async () => {
		const s = scene({ mode: "slow-active" });
		expect(await probePlugin(s.fake.path, s.content, s.folder, { env: s.env })).toEqual({ ok: true });
		expect(s.fake.ended()[0]?.polls).toBeGreaterThanOrEqual(4);
	});

	it("says why when the plugin failed, or OpenCode loaded its plugins without it", async () => {
		const failed = scene({ mode: "failed" });
		expect(await probePlugin(failed.fake.path, failed.content, failed.folder, { env: failed.env })).toEqual({ ok: false, why: "OpenCode could not load Orrery's plugin (Error: boom in setup)" });
		const absent = scene({ mode: "absent" });
		expect(await probePlugin(absent.fake.path, absent.content, absent.folder, { env: absent.env })).toEqual({ ok: false, why: "OpenCode loaded its plugins without Orrery's (a policy or a config may leave it out)" });
	});

	it("cannot check when the server dies, says nothing, names an address off this machine, refuses the password, or isn't there", async () => {
		const s = scene({ mode: "die" });
		expect(await probePlugin(s.fake.path, s.content, s.folder, { env: s.env })).toEqual({ ok: false, why: "OpenCode's server stopped before answering (exit 7)" });
		s.fake.setMode("silent");
		const started = Date.now();
		expect(await probePlugin(s.fake.path, s.content, s.folder, { env: s.env, timeoutMs: 300 })).toEqual({ ok: false, why: "OpenCode's server did not answer within 0.3 s" });
		expect(Date.now() - started).toBeLessThan(5_000);
		s.fake.setMode("remote-url");
		expect(await probePlugin(s.fake.path, s.content, s.folder, { env: s.env })).toMatchObject({ ok: false, why: expect.stringMatching(/^OpenCode's server did not say where it listens \(it said \{"url":"http:\/\/example\.com:\d+"\}\)$/) });
		s.fake.setMode("unauthorized");
		expect(await probePlugin(s.fake.path, s.content, s.folder, { env: s.env })).toEqual({ ok: false, why: "OpenCode's plugin list could not be read (HTTP 401)" });
		expect(await probePlugin(join(s.dir, "nowhere"), s.content, s.folder, { env: s.env })).toMatchObject({ ok: false, why: expect.stringMatching(/^OpenCode's server could not start \(.*ENOENT/) });
	});
});

describe("scratchEnv", () => {
	it("keeps mise's own folders where they really are, so a mise shim still finds OpenCode", () => {
		const env = scratchEnv({ HOME: "/home/u", PATH: "/bin", XDG_DATA_HOME: "/home/u/data", OPENCODE_PASSWORD: "theirs", ORRERY_AGENT: "Atlas" }, "/s");
		expect(env).toEqual({
			PATH: "/bin",
			MISE_DATA_DIR: "/home/u/data/mise",
			MISE_CONFIG_DIR: "/home/u/.config/mise",
			HOME: "/s/home",
			XDG_CONFIG_HOME: "/s/config",
			XDG_DATA_HOME: "/s/data",
			XDG_STATE_HOME: "/s/state",
			XDG_CACHE_HOME: "/s/cache",
			TMPDIR: "/s/tmp",
			OPENCODE_DISABLE_AUTOUPDATE: "1",
			OPENCODE_DISABLE_MODELS_FETCH: "1",
		});
		expect(scratchEnv({ HOME: "/home/u", MISE_DATA_DIR: "/m/data", MISE_CONFIG_DIR: "/m/config" }, "/s")).toMatchObject({ MISE_DATA_DIR: "/m/data", MISE_CONFIG_DIR: "/m/config" });
	});
});

describe("opencodePluginGate", () => {
	it("checks an OpenCode it has not verified, keeps the version in Orrery's home, and skips the check after that", async () => {
		const s = scene();
		const probes: string[][] = [];
		const probe = async (path: string, content: string, folder: string) => (probes.push([path, content, folder]), { ok: true as const });
		const target = { path: "/bin/opencode", version: "2.0.30", content: s.content, folder: s.folder };
		expect(await opencodePluginGate(target, { env: s.env, orrery: "0.8.0", probe })).toEqual({ ok: true });
		expect(probes).toEqual([["/bin/opencode", s.content, s.folder]]);
		expect(readOpenCodeCheck(s.env)).toMatchObject({ version: "2.0.30", orrery: "0.8.0", ok: true });
		expect(JSON.parse(readFileSync(join(s.env.ORRERY_HOME, "opencode-check.json"), "utf8"))).toMatchObject({ opencode: "2.0.30", orrery: "0.8.0", ok: true });
		expect(await opencodePluginGate(target, { env: s.env, orrery: "0.8.0", probe })).toEqual({ ok: true });
		expect(probes).toHaveLength(1);
		// Another OpenCode, or another Orrery, is checked again.
		await opencodePluginGate({ ...target, version: "2.0.31" }, { env: s.env, orrery: "0.8.0", probe });
		await opencodePluginGate({ ...target, version: "2.0.31" }, { env: s.env, orrery: "0.8.1", probe });
		expect(probes).toHaveLength(3);
	});

	it("says plainly when the plugin doesn't load, checks again until it does, and every time when the version is unknown", async () => {
		const s = scene();
		let ok = false;
		const probe = async () => (ok ? { ok: true as const } : { ok: false as const, why: "OpenCode could not load Orrery's plugin (Error: boom)" });
		const target = { path: "/bin/opencode", version: "2.0.31", content: s.content, folder: s.folder };
		const said: string[] = [];
		expect(await opencodePluginGate(target, { env: s.env, orrery: "0.8.0", probe, onCheck: () => said.push("asked") })).toEqual({
			ok: false,
			text: "Orrery's plugin doesn't load in OpenCode 2.0.31: OpenCode could not load Orrery's plugin (Error: boom). Without it a session has no memory and no guard.",
		});
		expect(said).toEqual(["asked"]);
		expect(readOpenCodeCheck(s.env)).toMatchObject({ version: "2.0.31", ok: false, why: "OpenCode could not load Orrery's plugin (Error: boom)" });
		ok = true;
		expect(await opencodePluginGate(target, { env: s.env, orrery: "0.8.0", probe })).toEqual({ ok: true });
		let probes = 0;
		const counted = async () => (probes++, { ok: true as const });
		await opencodePluginGate({ ...target, version: undefined }, { env: s.env, orrery: "0.8.0", probe: counted });
		await opencodePluginGate({ ...target, version: undefined }, { env: s.env, orrery: "0.8.0", probe: counted });
		expect(probes).toBe(2);
		const unknown = await opencodePluginGate({ ...target, version: undefined }, { env: s.env, orrery: "0.8.0", probe: async () => ({ ok: false, why: "x" }) });
		expect(unknown).toEqual({ ok: false, text: "Orrery's plugin doesn't load in OpenCode (its version is unknown): x. Without it a session has no memory and no guard." });
	});

	it("goes on when the state cannot be written, and reads a broken state file as none", async () => {
		const s = scene();
		mkdirSync(s.env.ORRERY_HOME, { recursive: true });
		writeFileSync(join(s.env.ORRERY_HOME, "opencode-check.json"), "{not json");
		expect(readOpenCodeCheck(s.env)).toBeUndefined();
		rmSync(join(s.env.ORRERY_HOME, "opencode-check.json"));
		mkdirSync(join(s.env.ORRERY_HOME, "opencode-check.json"));
		expect(await opencodePluginGate({ path: "/bin/opencode", version: "2.0.30", content: s.content, folder: s.folder }, { env: s.env, orrery: "0.8.0", probe: async () => ({ ok: true }) })).toEqual({ ok: true });
		expect(existsSync(join(s.env.ORRERY_HOME, "codex-check.json"))).toBe(false);
	});
});

describe("opencodeCheckDetail (the Tools page)", () => {
	it("says which OpenCode the plugin was checked with, and what happens next", async () => {
		const s = scene();
		expect(opencodeCheckDetail(s.env, "2.0.30", "0.8.0")).toBe("plugin is checked at the first launch");
		expect(opencodeCheckDetail(s.env, undefined, "0.8.0")).toBe("plugin is checked at each launch");
		const target = { path: "/bin/opencode", version: "2.0.30", content: s.content, folder: s.folder };
		await opencodePluginGate(target, { env: s.env, orrery: "0.8.0", probe: async () => ({ ok: true }) });
		expect(opencodeCheckDetail(s.env, "2.0.30", "0.8.0")).toBe("plugin checked with OpenCode 2.0.30");
		expect(opencodeCheckDetail(s.env, "2.0.31", "0.8.0")).toBe("plugin checked with OpenCode 2.0.30; 2.0.31 is checked at its first launch");
		expect(opencodeCheckDetail(s.env, "2.0.30", "0.8.1")).toBe("plugin checked with OpenCode 2.0.30 by Orrery 0.8.0; checked again at the next launch");
		await opencodePluginGate({ ...target, version: "2.0.31" }, { env: s.env, orrery: "0.8.0", probe: async () => ({ ok: false, why: "OpenCode could not load Orrery's plugin (x)" }) });
		expect(opencodeCheckDetail(s.env, "2.0.31", "0.8.0")).toBe("plugin did not load in OpenCode 2.0.31: OpenCode could not load Orrery's plugin (x)");
	});
});
