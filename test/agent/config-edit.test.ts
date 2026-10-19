import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, parseConfig, readBy } from "../../src/agent/config.ts";
import { addAgent, addRemote, removeRemote, archiveAgent, configWritable, editConfigFile, newConfigText, parseReads, saveConfigText, setAgentKey } from "../../src/agent/config-edit.ts";
import { tempDir } from "./support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const BASE = `# my agents
data_dir = "~/memory"   # where it lives

[agents.Alpha]
folder = "/w/alpha"
compactor_model = "openai/gpt-6.1-sol"   # sign-in
compactor_jobs = 4

# the second agent
[agents.Beta]
compactor_model = "openai/gpt-6.1-sol"
folder = "/w/beta"
`;

it("adds a remote agent with all portable settings, preserving comments and an unspecified tool", () => {
	const next = addAgent(BASE, "/c", { name: "Gamma", folder: "/w/gamma", compactorModel: "openai/gpt-6.1-sol", compactorThinking: "high", viewBytes: 64000, compactorJobs: 3, compactAt: 140000, reads: ["Alpha"] });
	expect(next.startsWith(BASE)).toBe(true);
	expect(parseConfig(next, "/c").agents.get("Gamma")).toMatchObject({ memory: { viewBytes: 64000 }, compactor: { jobs: 3, model: { thinking: "high" } }, compactAt: 140000, reads: ["Alpha"] });
	expect(parseConfig(next, "/c").agents.get("Gamma")?.tool).toBeUndefined();
});

describe("setAgentKey", () => {
	it("sets compact_at and refuses a value under 100,000", () => {
		const text = `[agents.A]\nfolder = "/w"\ncompactor_model = "openai/gpt-6.1-sol"\n`;
		expect(setAgentKey(text, "/c", "A", "compact_at", 150_000)).toContain("compact_at = 150000");
		expect(() => setAgentKey(text, "/c", "A", "compact_at", 1000)).toThrow();
		expect(() => setAgentKey(text, "/c", "A", "compact_at", 50_000)).toThrow(/at least 100000/);
	});

	it("replaces a value and keeps its comment; every other line is byte-identical", () => {
		const next = setAgentKey(BASE, "/x", "Alpha", "compactor_jobs", 8);
		const before = BASE.split("\n");
		const after = next.split("\n");
		expect(after).toHaveLength(before.length);
		expect(after.filter((line, i) => line !== before[i])).toEqual(["compactor_jobs = 8"]);
		const kept = setAgentKey(BASE, "/x", "Alpha", "compactor_model", "anthropic/claude-haiku-4-5");
		expect(kept).toContain('compactor_model = "anthropic/claude-haiku-4-5"   # sign-in');
	});

	it("adds a missing key after the block's last key line, not after the next block's comment", () => {
		const next = setAgentKey(BASE, "/x", "Alpha", "tool", "pi");
		expect(next).toContain('compactor_jobs = 4\ntool = "pi"\n\n# the second agent\n[agents.Beta]');
		expect(parseConfig(next, "/x").agents.get("Alpha")?.tool).toBe("pi");
	});

	it("keeps Windows line endings and a missing final newline", () => {
		const crlf = BASE.replaceAll("\n", "\r\n").replace(/\r\n$/, "");
		const next = setAgentKey(crlf, "/x", "Beta", "tool", "codex");
		expect(next.endsWith('tool = "codex"')).toBe(true);
		expect(next.replaceAll("\r\n", "").includes("\n")).toBe(false);
		const set = setAgentKey(crlf, "/x", "Alpha", "compactor_jobs", 2);
		expect(set).toContain("compactor_jobs = 2\r\n");
		expect(set.endsWith('folder = "/w/beta"')).toBe(true);
	});

	it("writes folders with spaces, quotes, backslashes and non-ASCII letters as TOML strings that read back the same", () => {
		const folder = `/w/my "odd" folder\\ünï`;
		const next = setAgentKey(BASE, "/x", "Beta", "folder", folder);
		expect(parseConfig(next, "/x").agents.get("Beta")?.folder).toBe(folder);
	});

	it("refuses an unknown agent, a bad value, and a multi-line value, leaving the text as it was", () => {
		expect(() => setAgentKey(BASE, "/x", "Gamma", "tool", "pi")).toThrow("No agent named Gamma in the config.");
		expect(() => setAgentKey(BASE, "/x", "Alpha", "tool", "vim")).toThrow(ConfigError);
		expect(() => setAgentKey(BASE, "/x", "Alpha", "compactor_jobs", 0)).toThrow("a number setting must be a positive whole number");
		const multi = BASE.replace('folder = "/w/alpha"', 'folder = """/w/alpha"""');
		expect(() => setAgentKey(multi, "/x", "Alpha", "folder", "/w/a")).toThrow("agents.Alpha.folder spans several lines or is not a single value; change it by hand.");
	});

	it("says the config is unchanged, not that it is broken, when a new key would land inside a multi-line value", () => {
		const roots = BASE.replace("compactor_jobs = 4\n", 'compactor_jobs = 4\nallowed_roots = [\n  "/w",\n]\n');
		expect(() => setAgentKey(roots, "/x", "Alpha", "tool", "pi")).toThrow("Orrery couldn't place this change safely; the config is unchanged — edit it by hand.");
		const notes = BASE.replace("compactor_jobs = 4\n", 'compactor_jobs = 4\nmodel = """\nopenai/gpt-6.1-sol"""\n');
		expect(() => setAgentKey(notes, "/x", "Alpha", "tool", "pi")).toThrow("That edit would change more than intended; the config is left as it was.");
		// A bad value still names the key, and a config that is already broken still says so.
		expect(() => setAgentKey(roots, "/x", "Beta", "tool", "vim")).toThrow("agents.Beta.tool must be one of pi, claude-code, codex");
		expect(() => setAgentKey(`${BASE}oops = [\n`, "/x", "Beta", "tool", "pi")).toThrow("config is not valid TOML");
	});
});

describe("addAgent", () => {
	const agent = { name: "Gamma", folder: "/w/gamma", tool: "pi" as const, compactorModel: "openai/gpt-6.1-sol", compactorThinking: "low" as const };

	it("appends a block after a blank line and keeps the rest", () => {
		const next = addAgent(BASE, "/x", agent);
		expect(next.startsWith(BASE)).toBe(true);
		expect(next.slice(BASE.length)).toBe('\n[agents.Gamma]\nfolder = "/w/gamma"\ntool = "pi"\nmodel = "openai/gpt-6.1-sol"\ncompactor_model = "openai/gpt-6.1-sol"\ncompactor_thinking = "low"\n');
	});

	it("also writes model (the summary model), so a checkout that still requires model reads the config", () => {
		const next = addAgent(BASE, "/x", { ...agent, compactorModel: "anthropic/claude-haiku-4-5" });
		const gamma = (parse(next) as { agents: Record<string, Record<string, unknown>> }).agents.Gamma;
		expect(gamma.model).toBe("anthropic/claude-haiku-4-5");
		expect(gamma.compactor_model).toBe("anthropic/claude-haiku-4-5");
		expect(parseConfig(next, "/x").agents.get("Gamma")?.compactor.model).toEqual({ provider: "anthropic", modelId: "claude-haiku-4-5", thinking: "low" });
	});

	it("refuses a name that exists in another case, a bad or reserved name, and a relative folder", () => {
		expect(() => addAgent(BASE, "/x", { ...agent, name: "alpha" })).toThrow("An agent named alpha already exists.");
		expect(() => addAgent(BASE, "/x", { ...agent, name: "9lives" })).toThrow("Agent names use letters, digits, - and _ (at most 32), starting with a letter.");
		expect(() => addAgent(BASE, "/x", { ...agent, name: "Takeover" })).toThrow("Takeover is a word orrery agent uses (add, set, edit, archive, push, pull, takeover, local); pick another name.");
		expect(() => addAgent(BASE, "/x", { ...agent, folder: "rel/dir" })).toThrow("The folder must be an absolute path.");
	});

	it("adds an agent with no folder, and clears a folder with an empty value", () => {
		const added = addAgent("", "/d", { name: "Nomad", compactorModel: "openai/gpt-6.1-sol", compactorThinking: "low" });
		expect(added).not.toContain("folder");
		const set = setAgentKey(added, "/d", "Nomad", "folder", "/w/nomad");
		expect(parseConfig(set, "/d").agents.get("Nomad")?.folder).toBe("/w/nomad");
		expect(parseConfig(setAgentKey(set, "/d", "Nomad", "folder", ""), "/d").agents.get("Nomad")?.folder).toBeUndefined();
	});

	it("starts a new config with a header and a data folder", () => {
		const next = addAgent(newConfigText("~/.local/share/orrery"), "/x", agent);
		const config = parseConfig(next, "/x");
		expect(config.agents.get("Gamma")?.compactor.model.modelId).toBe("gpt-6.1-sol");
		expect(next).toMatch(/^# Orrery's config/);
	});
});

describe("archiveAgent", () => {
	const THREE = `# my agents
data_dir = "/m"   # where it lives

[agents.Alpha]
folder = "/w/alpha"
compactor_model = "openai/gpt-6.1-sol"   # sign-in
compactor_jobs = 4

# the second agent
[agents.Beta]
# Beta's own note
compactor_model = "openai/gpt-6.1-sol"
allowed_roots = [
  "/w",
]
folder = "/w/beta"

[agents.Gamma]
folder = "/w/gamma"
compactor_model = "openai/gpt-6.1-sol"
`;
	const note = (name: string) => `# Archived 2026-10-08 (orrery agent archive ${name}). Its memory is still in /m/agents/${name}. Uncomment to bring it back:`;

	it("takes a block out of the middle, keeps the comments between blocks with the next one, and keeps it as comments at the end", () => {
		const next = archiveAgent(THREE, "/x", "Beta", "2026-10-08");
		expect(next).toBe(`# my agents
data_dir = "/m"   # where it lives

[agents.Alpha]
folder = "/w/alpha"
compactor_model = "openai/gpt-6.1-sol"   # sign-in
compactor_jobs = 4

# the second agent

[agents.Gamma]
folder = "/w/gamma"
compactor_model = "openai/gpt-6.1-sol"

${note("Beta")}
# [agents.Beta]
# # Beta's own note
# compactor_model = "openai/gpt-6.1-sol"
# allowed_roots = [
#   "/w",
# ]
# folder = "/w/beta"
`);
		expect([...parseConfig(next, "/x").agents.keys()]).toEqual(["Alpha", "Gamma"]);
	});

	it("takes the first and the last block out without leaving two blank lines", () => {
		const first = archiveAgent(THREE, "/x", "Alpha", "2026-10-08");
		expect(first.startsWith('# my agents\ndata_dir = "/m"   # where it lives\n\n# the second agent\n[agents.Beta]\n')).toBe(true);
		expect(first.endsWith(`\n\n${note("Alpha")}\n# [agents.Alpha]\n# folder = "/w/alpha"\n# compactor_model = "openai/gpt-6.1-sol"   # sign-in\n# compactor_jobs = 4\n`)).toBe(true);
		const last = archiveAgent(THREE, "/x", "Gamma", "2026-10-08");
		expect(last.endsWith('folder = "/w/beta"\n\n' + `${note("Gamma")}\n# [agents.Gamma]\n# folder = "/w/gamma"\n# compactor_model = "openai/gpt-6.1-sol"\n`)).toBe(true);
		// A second archive goes after the first.
		const both = archiveAgent(last, "/x", "Alpha", "2026-10-08");
		expect(both.indexOf(note("Gamma"))).toBeLessThan(both.indexOf(note("Alpha")));
		expect([...parseConfig(both, "/x").agents.keys()]).toEqual(["Beta"]);
		// The last agent: no agents are left.
		expect(parseConfig(archiveAgent(both, "/x", "Beta", "2026-10-08"), "/x").agents.size).toBe(0);
	});

	it("keeps Windows line endings and a missing final newline", () => {
		const crlf = THREE.replaceAll("\n", "\r\n").replace(/\r\n$/, "");
		const next = archiveAgent(crlf, "/x", "Alpha", "2026-10-08");
		expect(next.replaceAll("\r\n", "").includes("\n")).toBe(false);
		expect(next.endsWith("# compactor_jobs = 4")).toBe(true);
		expect(next).toContain(`${note("Alpha")}\r\n# [agents.Alpha]\r\n`);
		expect([...parseConfig(next, "/x").agents.keys()]).toEqual(["Beta", "Gamma"]);
	});

	it("refuses an unknown agent, and an agent another agent reads", () => {
		expect(() => archiveAgent(THREE, "/x", "Delta", "2026-10-08")).toThrow("No agent named Delta in the config.");
		const read = THREE.replace('[agents.Gamma]\nfolder = "/w/gamma"', '[agents.Gamma]\nreads = ["Alpha"]\nfolder = "/w/gamma"');
		expect(() => archiveAgent(read, "/x", "Alpha", "2026-10-08")).toThrow("Gamma reads it; take it out of Gamma's reads first.");
		// Reading every agent names none.
		const all = THREE.replace('[agents.Gamma]\nfolder = "/w/gamma"', '[agents.Gamma]\nreads = ["*"]\nfolder = "/w/gamma"');
		expect([...parseConfig(archiveAgent(all, "/x", "Alpha", "2026-10-08"), "/x").agents.keys()]).toEqual(["Beta", "Gamma"]);
	});

	it("refuses a block whose commented copy would not read back the same (a multi-line string ending on a # line)", () => {
		const odd = THREE.replace('compactor_jobs = 4\n', 'compactor_jobs = 4\nmodel = """\nopenai/gpt-6.1-sol\n# end"""\n');
		expect(parseConfig(odd, "/x").agents.get("Alpha")?.model?.modelId).toBe("gpt-6.1-sol\n# end");
		expect(() => archiveAgent(odd, "/x", "Alpha", "2026-10-08")).toThrow("Alpha's block can't be archived safely; edit the config by hand.");
	});

	it("refuses an edit that would leave part of the agent behind (a sub-table of it)", () => {
		const sub = THREE.replace("\n# the second agent", "\n[agents.Alpha.extra]\nnote = 1\n\n# the second agent");
		expect(() => archiveAgent(sub, "/x", "Alpha", "2026-10-08")).toThrow("Alpha's block can't be archived safely; edit the config by hand.");
	});
});

describe("saving", () => {
	it("writes atomically, keeps the mode, keeps the previous version as .bak, and writes through a symlink", () => {
		const dir = tempDir("orrery-edit-");
		dirs.push(dir);
		const path = join(dir, "config.toml");
		writeFileSync(path, BASE);
		chmodSync(path, 0o640); // the umask may have narrowed the creation mode
		saveConfigText(path, `${BASE}# changed\n`);
		expect(readFileSync(`${path}.bak`, "utf8")).toBe(BASE);
		expect(statSync(path).mode & 0o777).toBe(0o640);
		expect(readFileSync(path, "utf8")).toBe(`${BASE}# changed\n`);
	});

	it("re-reads the file before editing, so a hand edit made in between is kept", () => {
		const dir = tempDir("orrery-edit-");
		dirs.push(dir);
		const path = join(dir, "config.toml");
		writeFileSync(path, BASE);
		writeFileSync(path, BASE.replace("compactor_jobs = 4", "compactor_jobs = 6"));
		const config = editConfigFile(path, (text, configDir) => setAgentKey(text, configDir, "Beta", "tool", "pi"));
		expect(config.agents.get("Alpha")?.compactor.jobs).toBe(6);
		expect(config.agents.get("Beta")?.tool).toBe("pi");
	});

	it("replaces a link planted at .bak instead of writing through it, and never follows a file at its temporary name", () => {
		const dir = tempDir("orrery-edit-");
		dirs.push(dir);
		const path = join(dir, "config.toml");
		const victim = join(dir, "victim.txt");
		const other = join(dir, "other.txt");
		writeFileSync(path, BASE);
		writeFileSync(victim, "keep me");
		writeFileSync(other, "keep me too");
		symlinkSync(victim, `${path}.bak`);
		// The name 0.6.4 used for its temporary file, taken by a link before the save.
		symlinkSync(other, `${path}.tmp-${process.pid}`);
		saveConfigText(path, `${BASE}# changed\n`);
		expect(readFileSync(victim, "utf8")).toBe("keep me");
		expect(readFileSync(other, "utf8")).toBe("keep me too");
		expect(lstatSync(`${path}.bak`).isSymbolicLink()).toBe(false);
		expect(readFileSync(`${path}.bak`, "utf8")).toBe(BASE);
		expect(readFileSync(path, "utf8")).toBe(`${BASE}# changed\n`);
		expect(readlinkSync(`${path}.tmp-${process.pid}`)).toBe(other);
		expect(readdirSync(dir).filter((name) => name.includes(".tmp") && name !== `config.toml.tmp-${process.pid}`)).toEqual([]);
	});

	it("is writable only when the config's folder is too, where the config really is", () => {
		const dir = tempDir("orrery-edit-");
		dirs.push(dir);
		const locked = join(dir, "locked");
		mkdirSync(locked);
		const path = join(locked, "config.toml");
		writeFileSync(path, BASE, { mode: 0o600 });
		expect(configWritable(path)).toBe(true);
		chmodSync(locked, 0o555);
		try {
			expect(configWritable(path)).toBe(false);
			// A link to it from a folder that is writable: the folder that counts is the one the file is in.
			const link = join(dir, "linked.toml");
			symlinkSync(path, link);
			expect(configWritable(link)).toBe(false);
		} finally {
			chmodSync(locked, 0o755);
		}
		chmodSync(path, 0o400);
		expect(configWritable(path)).toBe(false);
		// A config not there yet: the nearest folder that is.
		expect(configWritable(join(dir, "new", "config.toml"))).toBe(true);
	});

	it("creates a missing config (folder 0700, file 0600)", () => {
		const dir = tempDir("orrery-edit-");
		dirs.push(dir);
		const path = join(dir, "sub", "config.toml");
		editConfigFile(path, (text, configDir) => addAgent(text, configDir, { name: "A", folder: "/w/a", tool: "pi", compactorModel: "openai/gpt-6.1-sol", compactorThinking: "low" }));
		expect(statSync(join(dir, "sub")).mode & 0o777).toBe(0o700);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});
});


describe("remote config edits", () => {
	const cloud = { name: "home", kind: "cloudflare" as const, url: "https://home.example.com" };

	it("adds a remote without rewriting existing comments or settings", () => {
		const next = addRemote(BASE, "/x", cloud);
		expect(next.startsWith(BASE)).toBe(true);
		expect(parse(next).remotes).toEqual({ home: { kind: "cloudflare", url: "https://home.example.com" } });
		expect(() => addRemote(next, "/x", cloud)).toThrow(/already exists/);
	});

	it("round trips hostile server folders as data and rejects unsafe names", () => {
		const base = `${BASE}\n[hosts.server]\nhost = "192.0.2.1"\nuser = "me"\nidentity_file = "id"\n`;
		const folder = `-my folder/'quoted'/$HOME`;
		const next = addRemote(base, "/x", { name: "home", kind: "server", host: "server", folder });
		expect((parse(next).remotes as Record<string, unknown>).home).toEqual({ kind: "server", host: "server", folder });
		expect(() => addRemote(base, "/x", { ...cloud, name: "bad.name" })).toThrow(/names/i);
	});

	it("sets and clears a memory home, keeping its inline comment", () => {
		const base = addRemote(BASE, "/x", cloud);
		const next = setAgentKey(base, "/x", "Alpha", "remote", "home").replace('remote = "home"', 'remote = "home" # travels');
		const cleared = setAgentKey(next, "/x", "Alpha", "remote", "");
		expect((parse(cleared).agents as Record<string, Record<string, unknown>>).Alpha.remote).toBeUndefined();
		expect(cleared).toContain("# travels");
		expect(() => removeRemote(next, "/x", "home")).toThrow(/Alpha/);
		const removed = removeRemote(cleared, "/x", "home");
		expect(parse(removed).remotes).toBeUndefined();
		expect(removed).toContain('# my agents');
	});

	it("adds a new agent with its memory home", () => {
		const text = addAgent(addRemote(BASE, "/x", cloud), "/x", {
			name: "Gamma", folder: "/w/gamma", tool: "omp", remote: "home",
			compactorModel: "openai/gpt-6.1-sol", compactorThinking: "high",
		});
		expect(parseConfig(text, "/x").agents.get("Gamma")).toMatchObject({ remote: "home", tool: "omp" });
	});

	it("removes only the chosen remote and preserves following comments and CRLF", () => {
		const text = `${BASE}\n[remotes.home] # server\nkind = "cloudflare"\nurl = "https://home.example.com" # endpoint\n\n# keep this\n[remotes.other]\nkind = "cloudflare"\nurl = "https://other.example.com"`.replaceAll("\n", "\r\n");
		const next = removeRemote(text, "/x", "home");
		expect(parse(next).remotes).toEqual({ other: { kind: "cloudflare", url: "https://other.example.com" } });
		expect(next).toContain("# keep this\r\n[remotes.other]");
		expect(next.replaceAll("\r\n", "")).not.toContain("\n");
		expect(next.endsWith('url = "https://other.example.com"')).toBe(true);
	});
});

describe("reads", () => {
	const TEXT = `# agents\n[agents.Atlas]\nfolder = "/w/atlas"   # home\ncompactor_model = "openai/gpt-6.1-sol"\n\n[agents.Birch]\ncompactor_model = "openai/gpt-6.1-sol"\nreads = ["Atlas"]  # who\n\n[agents.Cedar]\ncompactor_model = "openai/gpt-6.1-sol"\n`;
	const config = parseConfig(TEXT, "/c");

	it("setAgentKey writes a list of names, replacing an existing array and keeping comments", () => {
		const added = setAgentKey(TEXT, "/c", "Atlas", "reads", ["Birch"]);
		expect(added).toContain('folder = "/w/atlas"   # home\ncompactor_model = "openai/gpt-6.1-sol"\nreads = ["Birch"]\n');
		expect(added.startsWith("# agents\n")).toBe(true);
		const replaced = setAgentKey(TEXT, "/c", "Birch", "reads", ["Atlas", "Cedar"]);
		expect(replaced).toContain('reads = ["Atlas", "Cedar"]  # who\n');
		expect(parseConfig(replaced, "/c").agents.get("Birch")?.reads).toEqual(["Atlas", "Cedar"]);
		expect(parseConfig(setAgentKey(TEXT, "/c", "Cedar", "reads", ["*"]), "/c").agents.get("Cedar")?.reads).toEqual(["*"]);
	});

	it("an empty list removes the key, keeping its comment", () => {
		const cleared = setAgentKey(TEXT, "/c", "Birch", "reads", []);
		expect(cleared).not.toContain("reads");
		expect(cleared).toContain("# who\n");
		expect(parseConfig(cleared, "/c").agents.get("Birch")?.reads).toEqual([]);
		expect(setAgentKey(TEXT, "/c", "Cedar", "reads", [])).toBe(TEXT);
	});

	it("refuses an array that spans several lines", () => {
		const multi = `[agents.A]\ncompactor_model = "a/b"\nreads = [\n  "B",\n]\n[agents.B]\ncompactor_model = "a/b"\n`;
		expect(() => setAgentKey(multi, "/c", "A", "reads", ["B"])).toThrow(/by hand/);
	});

	it("parseReads reads all, none and a comma list, and refuses unknown names and itself", () => {
		expect(parseReads("all", config, "Atlas")).toEqual(["*"]);
		expect(parseReads("none", config, "Atlas")).toEqual([]);
		expect(parseReads("birch,Birch", config, "Atlas")).toEqual(["Birch"]);
		expect(parseReads(" Birch , cedar ", config, "Atlas")).toEqual(["Birch", "Cedar"]);
		expect(() => parseReads("Nope", config, "Atlas")).toThrow(/Unknown agent: Nope\. Known agents: Atlas, Birch, Cedar/);
		expect(() => parseReads("Atlas", config, "Atlas")).toThrow("an agent always reads itself");
		expect(() => parseReads("Birch,atlas", config, "Atlas")).toThrow("an agent always reads itself");
	});

	it("readBy lists the agents naming one, apart from those reading all", () => {
		const text = `${TEXT}[agents.Dune]\ncompactor_model = "a/b"\nreads = ["*"]\n`;
		expect(readBy(parseConfig(text, "/c"), "Atlas")).toEqual({ names: ["Birch"], everyone: ["Dune"] });
		expect(readBy(parseConfig(text, "/c"), "Cedar")).toEqual({ names: [], everyone: ["Dune"] });
	});
});
