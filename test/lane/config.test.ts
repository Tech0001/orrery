import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, findLane, laneForCwd, parseConfig, parseModelChoice } from "../../src/lane/config.ts";

const FULL = `
data_dir = "/var/lib/orrery"

[[providers]]
id = "omlx"
base_url = "http://models.example.internal:8000/v1"
api_key_env = "OMLX_API_KEY"
models = [ { id = "Bonsai-27B-mlx-1bit", context_window = 262144, max_tokens = 8192, reasoning = true } ]

[hosts.workstation]
host = "workstation.example.internal"
user = "alex"
identity_file = "ssh/id_ed25519"

[lanes.Atlas]
host = "workstation"
workspace = "/home/alex/Documents/GitHub/agent-Atlas"
model = "openai/gpt-6.1-sol"
thinking = "xhigh"
compactor_model = "omlx/Bonsai-27B-mlx-1bit"
compactor_thinking = "off"
compactor_jobs = 2
view_bytes = 64000

[lanes.Birch]
workspace = "/home/alex/Documents/GitHub/agent-Birch"
model = "openrouter/anthropic/claude-sonnet-5.5"
`;

describe("parseConfig", () => {
	it("reads compact_at: default 200,000, at least 100,000", () => {
		const base = (extra: string) => `[lanes.A]\nworkspace = "/w"\ncompactor_model = "openai/gpt-6.1-sol"\n${extra}`;
		expect(parseConfig(base(""), "/c").lanes.get("A")?.compactAt).toBe(200_000);
		expect(parseConfig(base("compact_at = 120000"), "/c").lanes.get("A")?.compactAt).toBe(120_000);
		expect(parseConfig(base("compact_at = 100000"), "/c").lanes.get("A")?.compactAt).toBe(100_000);
		expect(() => parseConfig(base("compact_at = 99999"), "/c")).toThrow(/lanes\.A\.compact_at must be at least 100000/);
		expect(() => parseConfig(base("compact_at = 50000"), "/c")).toThrow(/lanes\.A\.compact_at must be at least 100000/);
		expect(() => parseConfig(base('compact_at = "lots"'), "/c")).toThrow(/compact_at/);
	});

	it("parses a full configuration with defaults and resolved paths", () => {
		const config = parseConfig(FULL, "/etc/orrery");
		expect(config.dataDir).toBe("/var/lib/orrery");
		expect(config.credentialsPath).toBe("/var/lib/orrery/credentials.json");
		expect(config.deviceIdPath).toBe("/var/lib/orrery/device-id");
		expect(config.providers).toEqual([
			{
				id: "omlx",
				baseUrl: "http://models.example.internal:8000/v1",
				apiKeyEnv: "OMLX_API_KEY",
				models: [{ id: "Bonsai-27B-mlx-1bit", name: "Bonsai-27B-mlx-1bit", contextWindow: 262144, maxTokens: 8192, reasoning: true }],
			},
		]);
		expect(config.hosts.get("workstation")).toEqual({
			name: "workstation",
			kind: "ssh",
			host: "workstation.example.internal",
			user: "alex",
			identityFile: "/var/lib/orrery/ssh/id_ed25519",
			knownHostsFile: "/var/lib/orrery/ssh/known_hosts",
			hostKeyAlias: "orrery-workstation",
			connectTimeout: 5,
		});
		const atlas = config.lanes.get("Atlas");
		expect(atlas?.dir).toBe("/var/lib/orrery/lanes/Atlas");
		expect(atlas?.host.kind).toBe("ssh");
		expect(atlas?.allowedRoots).toEqual(["/home/alex/Documents/GitHub"]);
		expect(atlas?.model).toEqual({ provider: "openai", modelId: "gpt-6.1-sol", thinking: "xhigh" });
		expect(atlas?.compactor).toEqual({ model: { provider: "omlx", modelId: "Bonsai-27B-mlx-1bit", thinking: "off" }, jobs: 2 });
		expect(atlas?.memory.viewBytes).toBe(64000);
		expect(atlas?.memory.nodeBytes).toBe(512);
		const birch = config.lanes.get("Birch");
		expect(birch?.host).toEqual({ name: "local", kind: "local" });
		expect(birch?.model).toEqual({ provider: "openrouter", modelId: "anthropic/claude-sonnet-5.5", thinking: "medium" });
		expect(birch?.compactor.model).toEqual({ provider: "openrouter", modelId: "anthropic/claude-sonnet-5.5", thinking: "low" });
		expect(birch?.compactor.jobs).toBe(8);
	});

	it("defaults data_dir to the config directory", () => {
		const config = parseConfig(`[lanes.A]\nworkspace = "/w/a"\nmodel = "openai/gpt-6.1-sol"\n`, "/etc/sample");
		expect(config.dataDir).toBe("/etc/sample");
	});

	it("expands a leading ~ in data_dir to the home directory", () => {
		const config = parseConfig(`data_dir = "~/x"\n[lanes.A]\nworkspace = "/w/a"\nmodel = "openai/gpt-6.1-sol"\n`, "/etc/sample");
		expect(config.dataDir).toBe(join(homedir(), "x"));
		expect(parseConfig(`data_dir = "~"\n`, "/etc/sample").dataDir).toBe(homedir());
	});

	it("parses compactor_context_bytes, unset by default, and rejects values under 2000", () => {
		const lane = (extra: string) => `[lanes.A]\nworkspace = "/w/a"\nmodel = "openai/gpt-6.1-sol"\n${extra}`;
		expect(parseConfig(lane(""), "/x").lanes.get("A")?.compactor.contextBytes).toBeUndefined();
		expect(parseConfig(lane("compactor_context_bytes = 24000\n"), "/x").lanes.get("A")?.compactor.contextBytes).toBe(24000);
		expect(() => parseConfig(lane("compactor_context_bytes = 1999\n"), "/x")).toThrow(/compactor_context_bytes/);
		expect(() => parseConfig(lane("compactor_context_bytes = 0\n"), "/x")).toThrow(/compactor_context_bytes/);
	});

	it("rejects invalid configurations with a clear path", () => {
		expect(() => parseConfig(`[lanes.A]\nworkspace = "/w"\nmodel = "nope"\n`, "/x")).toThrow(/lanes.A.model/);
		expect(() => parseConfig(`[lanes.A]\nworkspace = "/w"\nmodel = "a/b"\nthinking = "huge"\n`, "/x")).toThrow(/lanes.A.thinking/);
		expect(() => parseConfig(`[lanes.A]\nworkspace = "w"\nmodel = "a/b"\n`, "/x")).toThrow(/lanes.A.workspace must be absolute/);
		expect(() => parseConfig(`[lanes.A]\nworkspace = "/w"\nmodel = "a/b"\nhost = "ghost"\n`, "/x")).toThrow(/unknown host "ghost"/);
		expect(() => parseConfig(`[lanes."bad name"]\nworkspace = "/w"\nmodel = "a/b"\n`, "/x")).toThrow(ConfigError);
		expect(() => parseConfig(`[hosts.local]\nhost = "h"\nidentity_file = "k"\n`, "/x")).toThrow(/reserved/);
		expect(() => parseConfig(`[lanes.A]\nworkspace = "/w"\nmodel = "a/b"\nnode_bytes = 10\n`, "/x")).toThrow(/nodeBytes/);
	});

	it("takes a lane without a workspace: no allowed roots unless set, and laneForCwd never picks it", () => {
		const config = parseConfig(`[lanes.Nomad]\ncompactor_model = "openai/gpt-6.1-sol"\n[lanes.Rooted]\ncompactor_model = "openai/gpt-6.1-sol"\nallowed_roots = ["/srv"]\n`, "/d");
		const nomad = config.lanes.get("Nomad")!;
		expect(nomad.workspace).toBeUndefined();
		expect(nomad.allowedRoots).toEqual([]);
		expect(config.lanes.get("Rooted")?.allowedRoots).toEqual(["/srv"]);
		expect(laneForCwd(config, "/")).toBeUndefined();
		expect(laneForCwd(config, "/srv")).toBeUndefined();
	});

	it("refuses the old instructions key: an agent's instructions live in instructions.md", () => {
		expect(() => parseConfig(`[lanes.Atlas]\nworkspace = "/w/a"\ncompactor_model = "openai/gpt-6.1-sol"\ninstructions = "GUIDE.md"\n`, "/d")).toThrow(
			"lanes.Atlas.instructions is no longer read: Atlas's instructions live in /d/lanes/Atlas/instructions.md; move them there and remove this key",
		);
	});

	it("needs a workspace for a lane on an SSH host", () => {
		const text = `[hosts.box]\nhost = "box.invalid"\nidentity_file = "ssh/id"\n[lanes.Far]\nhost = "box"\ncompactor_model = "openai/gpt-6.1-sol"\n`;
		expect(() => parseConfig(text, "/d")).toThrow("lanes.Far: a lane on an SSH host needs a workspace");
	});
});

describe("[updates]", () => {
	const lane = `[lanes.A]\nworkspace = "/w/a"\ncompactor_model = "openai/gpt-6.1-sol"\n`;
	it("reads check, true when absent, and refuses a non-boolean", () => {
		expect(parseConfig(`[updates]\ncheck = false\n${lane}`, "/x").updates.check).toBe(false);
		expect(parseConfig(lane, "/x").updates.check).toBe(true);
		expect(() => parseConfig(`[updates]\ncheck = "no"\n${lane}`, "/x")).toThrow(ConfigError);
		expect(() => parseConfig(`[updates]\ncheck = "no"\n${lane}`, "/x")).toThrow(/updates\.check/);
	});
});

describe("parseModelChoice", () => {
	it("splits at the first slash", () => {
		expect(parseModelChoice("openrouter/anthropic/x", "low")).toEqual({ provider: "openrouter", modelId: "anthropic/x", thinking: "low" });
		expect(() => parseModelChoice("/x", "low")).toThrow(ConfigError);
	});
});

describe("findLane", () => {
	it("matches lane names regardless of case and lists lanes when none matches", () => {
		const config = parseConfig(FULL, "/etc/orrery");
		expect(findLane(config, "Atlas").name).toBe("Atlas");
		expect(findLane(config, "atlas").name).toBe("Atlas");
		expect(findLane(config, "BIRCH").name).toBe("Birch");
		expect(() => findLane(config, "cedar")).toThrow(/No lane named cedar\. Configured lanes: Atlas, Birch/);
	});
});

describe("readers and lanes by folder", () => {
	const toml = (extra = "") => `data_dir = "/d"
[lanes.Atlas]
workspace = "/w/agent-Atlas"
model = "openai/gpt-6.1-sol"
[lanes.AtlasX]
workspace = "/w/agent-AtlasX"
model = "openai/gpt-6.1-sol"
[lanes.Birch]
workspace = "/w/agent-Birch"
model = "openai/gpt-6.1-sol"
reads = ["*"]
${extra}`;

	it("parses reads and matches a lane by its folder or a subfolder, never by a name prefix", () => {
		const config = parseConfig(toml(), "/etc");
		expect(config.lanes.get("Birch")?.reads).toEqual(["*"]);
		expect(config.lanes.get("Atlas")?.reads).toEqual([]);
		expect(laneForCwd(config, "/w/agent-Atlas")?.name).toBe("Atlas");
		expect(laneForCwd(config, "/w/agent-Atlas/sub/dir")?.name).toBe("Atlas");
		expect(laneForCwd(config, "/w/agent-AtlasX")?.name).toBe("AtlasX");
		expect(laneForCwd(config, "/w/elsewhere")).toBeUndefined();
	});

	it("matches a workspace configured through a symlink: pi and Claude Code report the folder the link points to", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "orrery-lane-link-")));
		try {
			mkdirSync(join(root, "real", "Atlas", "inner"), { recursive: true });
			symlinkSync(join(root, "real"), join(root, "link"));
			const config = parseConfig(`data_dir = "/d"
[lanes.Atlas]
workspace = ${JSON.stringify(join(root, "link", "Atlas"))}
model = "openai/gpt-6.1-sol"
[lanes.Inner]
workspace = ${JSON.stringify(join(root, "link", "Atlas", "inner"))}
model = "openai/gpt-6.1-sol"
`, "/etc");
			expect(laneForCwd(config, join(root, "real", "Atlas"))?.name).toBe("Atlas");
			expect(laneForCwd(config, join(root, "real", "Atlas", "sub"))?.name).toBe("Atlas");
			expect(laneForCwd(config, join(root, "real", "Atlas", "inner", "sub"))?.name).toBe("Inner");
			expect(laneForCwd(config, join(root, "real"))).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("takes the deepest workspace by real path, though a shallower one matches as written", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "orrery-lane-nested-")));
		try {
			mkdirSync(join(root, "projects", "b", "sub"), { recursive: true });
			mkdirSync(join(root, "projects", "other"));
			symlinkSync(join(root, "projects", "b"), join(root, "linkB"));
			const config = parseConfig(`data_dir = "/d"
[lanes.A]
workspace = ${JSON.stringify(join(root, "projects"))}
model = "openai/gpt-6.1-sol"
[lanes.B]
workspace = ${JSON.stringify(join(root, "linkB"))}
model = "openai/gpt-6.1-sol"
`, "/etc");
			// pi in B's folder reports the physical path, which lies inside A as written: B's memory, not A's.
			expect(laneForCwd(config, join(root, "projects", "b"))?.name).toBe("B");
			expect(laneForCwd(config, join(root, "projects", "b", "sub"))?.name).toBe("B");
			expect(laneForCwd(config, join(root, "linkB", "sub"))?.name).toBe("B");
			expect(laneForCwd(config, join(root, "projects", "other"))?.name).toBe("A");
			expect(laneForCwd(config, join(root, "projects"))?.name).toBe("A");
			// A folder not made yet still matches as written.
			expect(laneForCwd(config, join(root, "linkB", "not-yet"))?.name).toBe("B");
			expect(laneForCwd(config, join(root, "projects", "not-yet"))?.name).toBe("A");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects reads naming a lane that does not exist", () => {
		expect(() => parseConfig(toml(`[lanes.Cedar]\nworkspace = "/w/v"\nmodel = "openai/gpt-6.1-sol"\nreads = ["Nobody"]\n`), "/etc")).toThrow(
			/reads.*Nobody/,
		);
	});

	it("takes omp as a lane's tool", () => {
		const config = parseConfig(`[lanes.A]\nworkspace = "/w/a"\ntool = "omp"\ncompactor_model = "openai/gpt-6.1-sol"\n`, "/x");
		expect(config.lanes.get("A")?.tool).toBe("omp");
	});

	it("reads a lane's tool, and needs no agent model when compactor_model is set", () => {
		const config = parseConfig(`[lanes.A]\nworkspace = "/w/a"\ntool = "claude-code"\ncompactor_model = "openai/gpt-6.1-sol"\n`, "/x");
		const lane = config.lanes.get("A");
		expect(lane?.tool).toBe("claude-code");
		expect(lane?.model).toBeUndefined();
		expect(lane?.compactor.model).toEqual({ provider: "openai", modelId: "gpt-6.1-sol", thinking: "low" });
		expect(parseConfig(`[lanes.A]\nworkspace = "/w/a"\nmodel = "a/b"\n`, "/x").lanes.get("A")?.tool).toBeUndefined();
	});

	it("refuses an unknown tool, and a lane with neither model nor compactor_model", () => {
		expect(() => parseConfig(`[lanes.A]\nworkspace = "/w"\nmodel = "a/b"\ntool = "vim"\n`, "/x")).toThrow("lanes.A.tool must be one of pi, claude-code, codex");
		expect(() => parseConfig(`[lanes.A]\nworkspace = "/w"\n`, "/x")).toThrow("lanes.A.compactor_model must be a non-empty string");
	});
});
