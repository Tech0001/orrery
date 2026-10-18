import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, findAgent, agentForCwd, agentNameProblem, parseConfig, parseModelChoice, RESERVED_NAMES } from "../../src/agent/config.ts";

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

[agents.Atlas]
host = "workstation"
folder = "/home/alex/Documents/GitHub/agent-Atlas"
model = "openai/gpt-6.1-sol"
thinking = "xhigh"
compactor_model = "omlx/Bonsai-27B-mlx-1bit"
compactor_thinking = "off"
compactor_jobs = 2
view_bytes = 64000

[agents.Birch]
folder = "/home/alex/Documents/GitHub/agent-Birch"
model = "openrouter/anthropic/claude-sonnet-5.5"
`;

describe("parseConfig", () => {
	it("reads compact_at: default 200,000, at least 100,000", () => {
		const base = (extra: string) => `[agents.A]\nfolder = "/w"\ncompactor_model = "openai/gpt-6.1-sol"\n${extra}`;
		expect(parseConfig(base(""), "/c").agents.get("A")?.compactAt).toBe(200_000);
		expect(parseConfig(base("compact_at = 120000"), "/c").agents.get("A")?.compactAt).toBe(120_000);
		expect(parseConfig(base("compact_at = 100000"), "/c").agents.get("A")?.compactAt).toBe(100_000);
		expect(() => parseConfig(base("compact_at = 99999"), "/c")).toThrow(/agents\.A\.compact_at must be at least 100000/);
		expect(() => parseConfig(base("compact_at = 50000"), "/c")).toThrow(/agents\.A\.compact_at must be at least 100000/);
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
		const atlas = config.agents.get("Atlas");
		expect(atlas?.dir).toBe("/var/lib/orrery/agents/Atlas");
		expect(atlas?.host.kind).toBe("ssh");
		expect(atlas?.allowedRoots).toEqual(["/home/alex/Documents/GitHub"]);
		expect(atlas?.model).toEqual({ provider: "openai", modelId: "gpt-6.1-sol", thinking: "xhigh" });
		expect(atlas?.compactor).toEqual({ model: { provider: "omlx", modelId: "Bonsai-27B-mlx-1bit", thinking: "off" }, jobs: 2 });
		expect(atlas?.memory.viewBytes).toBe(64000);
		expect(atlas?.memory.nodeBytes).toBe(512);
		const birch = config.agents.get("Birch");
		expect(birch?.host).toEqual({ name: "local", kind: "local" });
		expect(birch?.model).toEqual({ provider: "openrouter", modelId: "anthropic/claude-sonnet-5.5", thinking: "medium" });
		expect(birch?.compactor.model).toEqual({ provider: "openrouter", modelId: "anthropic/claude-sonnet-5.5", thinking: "low" });
		expect(birch?.compactor.jobs).toBe(8);
	});

	it("defaults data_dir to the config directory", () => {
		const config = parseConfig(`[agents.A]\nfolder = "/w/a"\nmodel = "openai/gpt-6.1-sol"\n`, "/etc/sample");
		expect(config.dataDir).toBe("/etc/sample");
	});

	it("expands a leading ~ in data_dir to the home directory", () => {
		const config = parseConfig(`data_dir = "~/x"\n[agents.A]\nfolder = "/w/a"\nmodel = "openai/gpt-6.1-sol"\n`, "/etc/sample");
		expect(config.dataDir).toBe(join(homedir(), "x"));
		expect(parseConfig(`data_dir = "~"\n`, "/etc/sample").dataDir).toBe(homedir());
	});

	it("parses compactor_context_bytes, unset by default, and rejects values under 2000", () => {
		const agent = (extra: string) => `[agents.A]\nfolder = "/w/a"\nmodel = "openai/gpt-6.1-sol"\n${extra}`;
		expect(parseConfig(agent(""), "/x").agents.get("A")?.compactor.contextBytes).toBeUndefined();
		expect(parseConfig(agent("compactor_context_bytes = 24000\n"), "/x").agents.get("A")?.compactor.contextBytes).toBe(24000);
		expect(() => parseConfig(agent("compactor_context_bytes = 1999\n"), "/x")).toThrow(/compactor_context_bytes/);
		expect(() => parseConfig(agent("compactor_context_bytes = 0\n"), "/x")).toThrow(/compactor_context_bytes/);
	});

	it("rejects invalid configurations with a clear path", () => {
		expect(() => parseConfig(`[agents.A]\nfolder = "/w"\nmodel = "nope"\n`, "/x")).toThrow(/agents.A.model/);
		expect(() => parseConfig(`[agents.A]\nfolder = "/w"\nmodel = "a/b"\nthinking = "huge"\n`, "/x")).toThrow(/agents.A.thinking/);
		expect(() => parseConfig(`[agents.A]\nfolder = "w"\nmodel = "a/b"\n`, "/x")).toThrow(/agents.A.folder must be absolute/);
		expect(() => parseConfig(`[agents.A]\nfolder = "/w"\nmodel = "a/b"\nhost = "ghost"\n`, "/x")).toThrow(/unknown host "ghost"/);
		expect(() => parseConfig(`[agents."bad name"]\nfolder = "/w"\nmodel = "a/b"\n`, "/x")).toThrow(ConfigError);
		expect(() => parseConfig(`[hosts.local]\nhost = "h"\nidentity_file = "k"\n`, "/x")).toThrow(/reserved/);
		// "opencode" names OpenCode's models in summary refs (opencode/<provider>/<model>): no server of the config's may take it.
		expect(() => parseConfig(`[[providers]]\nid = "opencode"\nbase_url = "http://x/v1"\nmodels = [ { id = "m", context_window = 1000, max_tokens = 100 } ]\n`, "/x")).toThrow('providers[0].id: "opencode" is reserved for OpenCode\'s models (opencode/<provider>/<model>)');
		expect(() => parseConfig(`[agents.A]\nfolder = "/w"\nmodel = "a/b"\nnode_bytes = 10\n`, "/x")).toThrow(/nodeBytes/);
	});

	it("takes an agent without a folder: no allowed roots unless set, and agentForCwd never picks it", () => {
		const config = parseConfig(`[agents.Nomad]\ncompactor_model = "openai/gpt-6.1-sol"\n[agents.Rooted]\ncompactor_model = "openai/gpt-6.1-sol"\nallowed_roots = ["/srv"]\n`, "/d");
		const nomad = config.agents.get("Nomad")!;
		expect(nomad.folder).toBeUndefined();
		expect(nomad.allowedRoots).toEqual([]);
		expect(config.agents.get("Rooted")?.allowedRoots).toEqual(["/srv"]);
		expect(agentForCwd(config, "/")).toBeUndefined();
		expect(agentForCwd(config, "/srv")).toBeUndefined();
	});

	it("refuses an agent named like an orrery agent subcommand, ignoring case", () => {
		expect(() => parseConfig(`[agents.Local]\nfolder = "/w/l"\ncompactor_model = "openai/gpt-6.1-sol"\n`, "/d")).toThrow(
			"agents.Local: Local is a word orrery agent uses (add, set, edit, archive, push, pull, takeover, local); rename the agent, and its data folder /d/agents/Local to the same name, or it starts without its memory",
		);
		for (const word of RESERVED_NAMES) expect(() => parseConfig(`[agents.${word.toUpperCase()}]\ncompactor_model = "a/b"\n`, "/d")).toThrow(ConfigError);
		expect(agentNameProblem("Edit")).toBe("Edit is a word orrery agent uses (add, set, edit, archive, push, pull, takeover, local); pick another name.");
		expect(agentNameProblem("Editor")).toBeUndefined();
		expect(agentNameProblem("Atlas")).toBeUndefined();
		expect(agentNameProblem("9lives")).toBe("Agent names use letters, digits, - and _ (at most 32), starting with a letter.");
		expect(agentNameProblem("a".repeat(33))).toBe("Agent names use letters, digits, - and _ (at most 32), starting with a letter.");
	});

	it("refuses the old instructions key: an agent's instructions live in instructions.md", () => {
		expect(() => parseConfig(`[agents.Atlas]\nfolder = "/w/a"\ncompactor_model = "openai/gpt-6.1-sol"\ninstructions = "GUIDE.md"\n`, "/d")).toThrow(
			"agents.Atlas.instructions is no longer read: Atlas's instructions live in /d/agents/Atlas/instructions.md; move them there and remove this key",
		);
	});

	it("needs a folder for an agent on an SSH host", () => {
		const text = `[hosts.box]\nhost = "box.invalid"\nidentity_file = "ssh/id"\n[agents.Far]\nhost = "box"\ncompactor_model = "openai/gpt-6.1-sol"\n`;
		expect(() => parseConfig(text, "/d")).toThrow("agents.Far: an agent on an SSH host needs a folder");
	});

	it("refuses a config from before 0.6.0, saying what to rename: [lanes.<Name>] sections and the workspace key", () => {
		expect(() => parseConfig(`[lanes.Atlas]\nworkspace = "/w"\ncompactor_model = "openai/gpt-6.1-sol"\n`, "/d")).toThrow(
			"This config has [lanes.<Name>] sections, from before Orrery 0.6.0: rename each to [agents.<Name>], and its workspace key to folder.",
		);
		expect(() => parseConfig(`[agents.Atlas]\nworkspace = "/w"\ncompactor_model = "openai/gpt-6.1-sol"\n`, "/d")).toThrow("agents.Atlas.workspace is now folder: rename the key");
	});
});

describe("[updates]", () => {
	const agent = `[agents.A]\nfolder = "/w/a"\ncompactor_model = "openai/gpt-6.1-sol"\n`;
	it("reads check, true when absent, and refuses a non-boolean", () => {
		expect(parseConfig(`[updates]\ncheck = false\n${agent}`, "/x").updates.check).toBe(false);
		expect(parseConfig(agent, "/x").updates.check).toBe(true);
		expect(() => parseConfig(`[updates]\ncheck = "no"\n${agent}`, "/x")).toThrow(ConfigError);
		expect(() => parseConfig(`[updates]\ncheck = "no"\n${agent}`, "/x")).toThrow(/updates\.check/);
	});
});

describe("parseModelChoice", () => {
	it("splits at the first slash", () => {
		expect(parseModelChoice("openrouter/anthropic/x", "low")).toEqual({ provider: "openrouter", modelId: "anthropic/x", thinking: "low" });
		expect(() => parseModelChoice("/x", "low")).toThrow(ConfigError);
	});
});

describe("findAgent", () => {
	it("matches agent names regardless of case and lists agents when none matches", () => {
		const config = parseConfig(FULL, "/etc/orrery");
		expect(findAgent(config, "Atlas").name).toBe("Atlas");
		expect(findAgent(config, "atlas").name).toBe("Atlas");
		expect(findAgent(config, "BIRCH").name).toBe("Birch");
		expect(() => findAgent(config, "cedar")).toThrow(/No agent named cedar\. Configured agents: Atlas, Birch/);
	});
});

describe("readers and agents by folder", () => {
	const toml = (extra = "") => `data_dir = "/d"
[agents.Atlas]
folder = "/w/agent-Atlas"
model = "openai/gpt-6.1-sol"
[agents.AtlasX]
folder = "/w/agent-AtlasX"
model = "openai/gpt-6.1-sol"
[agents.Birch]
folder = "/w/agent-Birch"
model = "openai/gpt-6.1-sol"
reads = ["*"]
${extra}`;

	it("parses reads and matches an agent by its folder or a subfolder, never by a name prefix", () => {
		const config = parseConfig(toml(), "/etc");
		expect(config.agents.get("Birch")?.reads).toEqual(["*"]);
		expect(config.agents.get("Atlas")?.reads).toEqual([]);
		expect(agentForCwd(config, "/w/agent-Atlas")?.name).toBe("Atlas");
		expect(agentForCwd(config, "/w/agent-Atlas/sub/dir")?.name).toBe("Atlas");
		expect(agentForCwd(config, "/w/agent-AtlasX")?.name).toBe("AtlasX");
		expect(agentForCwd(config, "/w/elsewhere")).toBeUndefined();
	});

	it("matches a folder configured through a symlink: pi and Claude Code report the folder the link points to", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "orrery-agent-link-")));
		try {
			mkdirSync(join(root, "real", "Atlas", "inner"), { recursive: true });
			symlinkSync(join(root, "real"), join(root, "link"));
			const config = parseConfig(`data_dir = "/d"
[agents.Atlas]
folder = ${JSON.stringify(join(root, "link", "Atlas"))}
model = "openai/gpt-6.1-sol"
[agents.Inner]
folder = ${JSON.stringify(join(root, "link", "Atlas", "inner"))}
model = "openai/gpt-6.1-sol"
`, "/etc");
			expect(agentForCwd(config, join(root, "real", "Atlas"))?.name).toBe("Atlas");
			expect(agentForCwd(config, join(root, "real", "Atlas", "sub"))?.name).toBe("Atlas");
			expect(agentForCwd(config, join(root, "real", "Atlas", "inner", "sub"))?.name).toBe("Inner");
			expect(agentForCwd(config, join(root, "real"))).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("takes the deepest folder by real path, though a shallower one matches as written", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "orrery-agent-nested-")));
		try {
			mkdirSync(join(root, "projects", "b", "sub"), { recursive: true });
			mkdirSync(join(root, "projects", "other"));
			symlinkSync(join(root, "projects", "b"), join(root, "linkB"));
			const config = parseConfig(`data_dir = "/d"
[agents.A]
folder = ${JSON.stringify(join(root, "projects"))}
model = "openai/gpt-6.1-sol"
[agents.B]
folder = ${JSON.stringify(join(root, "linkB"))}
model = "openai/gpt-6.1-sol"
`, "/etc");
			// pi in B's folder reports the physical path, which lies inside A as written: B's memory, not A's.
			expect(agentForCwd(config, join(root, "projects", "b"))?.name).toBe("B");
			expect(agentForCwd(config, join(root, "projects", "b", "sub"))?.name).toBe("B");
			expect(agentForCwd(config, join(root, "linkB", "sub"))?.name).toBe("B");
			expect(agentForCwd(config, join(root, "projects", "other"))?.name).toBe("A");
			expect(agentForCwd(config, join(root, "projects"))?.name).toBe("A");
			// A folder not made yet still matches as written.
			expect(agentForCwd(config, join(root, "linkB", "not-yet"))?.name).toBe("B");
			expect(agentForCwd(config, join(root, "projects", "not-yet"))?.name).toBe("A");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects reads naming an agent that does not exist", () => {
		expect(() => parseConfig(toml(`[agents.Cedar]\nfolder = "/w/v"\nmodel = "openai/gpt-6.1-sol"\nreads = ["Nobody"]\n`), "/etc")).toThrow(
			/reads.*Nobody/,
		);
	});

	it("takes omp as an agent's tool", () => {
		const config = parseConfig(`[agents.A]\nfolder = "/w/a"\ntool = "omp"\ncompactor_model = "openai/gpt-6.1-sol"\n`, "/x");
		expect(config.agents.get("A")?.tool).toBe("omp");
	});

	it("reads an agent's tool, and needs no agent model when compactor_model is set", () => {
		const config = parseConfig(`[agents.A]\nfolder = "/w/a"\ntool = "claude-code"\ncompactor_model = "openai/gpt-6.1-sol"\n`, "/x");
		const agent = config.agents.get("A");
		expect(agent?.tool).toBe("claude-code");
		expect(agent?.model).toBeUndefined();
		expect(agent?.compactor.model).toEqual({ provider: "openai", modelId: "gpt-6.1-sol", thinking: "low" });
		expect(parseConfig(`[agents.A]\nfolder = "/w/a"\nmodel = "a/b"\n`, "/x").agents.get("A")?.tool).toBeUndefined();
	});

	it("refuses an unknown tool, and an agent with neither model nor compactor_model", () => {
		expect(() => parseConfig(`[agents.A]\nfolder = "/w"\nmodel = "a/b"\ntool = "vim"\n`, "/x")).toThrow("agents.A.tool must be one of pi, claude-code, codex");
		expect(() => parseConfig(`[agents.A]\nfolder = "/w"\n`, "/x")).toThrow("agents.A.compactor_model must be a non-empty string");
	});
});
