import { chmodSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../../src/lane/config.ts";
import { addLane, addRemote, removeRemote, archiveLane, editConfigFile, newConfigText, saveConfigText, setLaneKey } from "../../src/lane/config-edit.ts";
import { tempDir } from "./support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const BASE = `# my lanes
data_dir = "~/memory"   # where it lives

[lanes.Alpha]
workspace = "/w/alpha"
compactor_model = "openai/gpt-6.1-sol"   # sign-in
compactor_jobs = 4

# the second lane
[lanes.Beta]
compactor_model = "openai/gpt-6.1-sol"
workspace = "/w/beta"
`;

it("adds a remote lane with all portable settings, preserving comments and an unspecified tool", () => {
	const next = addLane(BASE, "/c", { name: "Gamma", workspace: "/w/gamma", compactorModel: "openai/gpt-6.1-sol", compactorThinking: "high", viewBytes: 64000, compactorJobs: 3, compactAt: 140000, instructions: 'notes/"guide".md', reads: ["Alpha"] });
	expect(next.startsWith(BASE)).toBe(true);
	expect(parseConfig(next, "/c").lanes.get("Gamma")).toMatchObject({ memory: { viewBytes: 64000 }, compactor: { jobs: 3, model: { thinking: "high" } }, compactAt: 140000, instructions: 'notes/"guide".md', reads: ["Alpha"] });
	expect(parseConfig(next, "/c").lanes.get("Gamma")?.tool).toBeUndefined();
});

describe("setLaneKey", () => {
	it("sets compact_at and refuses a value under 100,000", () => {
		const text = `[lanes.A]\nworkspace = "/w"\ncompactor_model = "openai/gpt-6.1-sol"\n`;
		expect(setLaneKey(text, "/c", "A", "compact_at", 150_000)).toContain("compact_at = 150000");
		expect(() => setLaneKey(text, "/c", "A", "compact_at", 1000)).toThrow();
		expect(() => setLaneKey(text, "/c", "A", "compact_at", 50_000)).toThrow(/at least 100000/);
	});

	it("replaces a value and keeps its comment; every other line is byte-identical", () => {
		const next = setLaneKey(BASE, "/x", "Alpha", "compactor_jobs", 8);
		const before = BASE.split("\n");
		const after = next.split("\n");
		expect(after).toHaveLength(before.length);
		expect(after.filter((line, i) => line !== before[i])).toEqual(["compactor_jobs = 8"]);
		const kept = setLaneKey(BASE, "/x", "Alpha", "compactor_model", "anthropic/claude-haiku-4-5");
		expect(kept).toContain('compactor_model = "anthropic/claude-haiku-4-5"   # sign-in');
	});

	it("adds a missing key after the block's last key line, not after the next block's comment", () => {
		const next = setLaneKey(BASE, "/x", "Alpha", "tool", "pi");
		expect(next).toContain('compactor_jobs = 4\ntool = "pi"\n\n# the second lane\n[lanes.Beta]');
		expect(parseConfig(next, "/x").lanes.get("Alpha")?.tool).toBe("pi");
	});

	it("keeps Windows line endings and a missing final newline", () => {
		const crlf = BASE.replaceAll("\n", "\r\n").replace(/\r\n$/, "");
		const next = setLaneKey(crlf, "/x", "Beta", "tool", "codex");
		expect(next.endsWith('tool = "codex"')).toBe(true);
		expect(next.replaceAll("\r\n", "").includes("\n")).toBe(false);
		const set = setLaneKey(crlf, "/x", "Alpha", "compactor_jobs", 2);
		expect(set).toContain("compactor_jobs = 2\r\n");
		expect(set.endsWith('workspace = "/w/beta"')).toBe(true);
	});

	it("writes folders with spaces, quotes, backslashes and non-ASCII letters as TOML strings that read back the same", () => {
		const folder = `/w/my "odd" folder\\ünï`;
		const next = setLaneKey(BASE, "/x", "Beta", "workspace", folder);
		expect(parseConfig(next, "/x").lanes.get("Beta")?.workspace).toBe(folder);
	});

	it("refuses an unknown lane, a bad value, and a multi-line value, leaving the text as it was", () => {
		expect(() => setLaneKey(BASE, "/x", "Gamma", "tool", "pi")).toThrow("No lane named Gamma in the config.");
		expect(() => setLaneKey(BASE, "/x", "Alpha", "tool", "vim")).toThrow(ConfigError);
		expect(() => setLaneKey(BASE, "/x", "Alpha", "compactor_jobs", 0)).toThrow("a number setting must be a positive whole number");
		const multi = BASE.replace('workspace = "/w/alpha"', 'workspace = """/w/alpha"""');
		expect(() => setLaneKey(multi, "/x", "Alpha", "workspace", "/w/a")).toThrow("lanes.Alpha.workspace spans several lines or is not a single value; change it by hand.");
	});

	it("says the config is unchanged, not that it is broken, when a new key would land inside a multi-line value", () => {
		const roots = BASE.replace("compactor_jobs = 4\n", 'compactor_jobs = 4\nallowed_roots = [\n  "/w",\n]\n');
		expect(() => setLaneKey(roots, "/x", "Alpha", "tool", "pi")).toThrow("Orrery couldn't place this change safely; the config is unchanged — edit it by hand.");
		const notes = BASE.replace("compactor_jobs = 4\n", 'compactor_jobs = 4\ninstructions = """\nAGENTS.md"""\n');
		expect(() => setLaneKey(notes, "/x", "Alpha", "tool", "pi")).toThrow("That edit would change more than intended; the config is left as it was.");
		// A bad value still names the key, and a config that is already broken still says so.
		expect(() => setLaneKey(roots, "/x", "Beta", "tool", "vim")).toThrow("lanes.Beta.tool must be one of pi, claude-code, codex");
		expect(() => setLaneKey(`${BASE}oops = [\n`, "/x", "Beta", "tool", "pi")).toThrow("config is not valid TOML");
	});
});

describe("addLane", () => {
	const lane = { name: "Gamma", workspace: "/w/gamma", tool: "pi" as const, compactorModel: "openai/gpt-6.1-sol", compactorThinking: "low" as const };

	it("appends a block after a blank line and keeps the rest", () => {
		const next = addLane(BASE, "/x", lane);
		expect(next.startsWith(BASE)).toBe(true);
		expect(next.slice(BASE.length)).toBe('\n[lanes.Gamma]\nworkspace = "/w/gamma"\ntool = "pi"\nmodel = "openai/gpt-6.1-sol"\ncompactor_model = "openai/gpt-6.1-sol"\ncompactor_thinking = "low"\n');
	});

	it("also writes model (the summary model), so a checkout that still requires model reads the config", () => {
		const next = addLane(BASE, "/x", { ...lane, compactorModel: "anthropic/claude-haiku-4-5" });
		const gamma = (parse(next) as { lanes: Record<string, Record<string, unknown>> }).lanes.Gamma;
		expect(gamma.model).toBe("anthropic/claude-haiku-4-5");
		expect(gamma.compactor_model).toBe("anthropic/claude-haiku-4-5");
		expect(parseConfig(next, "/x").lanes.get("Gamma")?.compactor.model).toEqual({ provider: "anthropic", modelId: "claude-haiku-4-5", thinking: "low" });
	});

	it("refuses a name that exists in another case, a bad name, and a relative folder", () => {
		expect(() => addLane(BASE, "/x", { ...lane, name: "alpha" })).toThrow("A lane named alpha already exists.");
		expect(() => addLane(BASE, "/x", { ...lane, name: "9lives" })).toThrow("Lane names use letters, digits, - and _ (at most 32), starting with a letter.");
		expect(() => addLane(BASE, "/x", { ...lane, workspace: "rel/dir" })).toThrow("The folder must be an absolute path.");
	});

	it("adds a lane with no workspace, and clears a workspace with an empty value", () => {
		const added = addLane("", "/d", { name: "Nomad", compactorModel: "openai/gpt-6.1-sol", compactorThinking: "low" });
		expect(added).not.toContain("workspace");
		const set = setLaneKey(added, "/d", "Nomad", "workspace", "/w/nomad");
		expect(parseConfig(set, "/d").lanes.get("Nomad")?.workspace).toBe("/w/nomad");
		expect(parseConfig(setLaneKey(set, "/d", "Nomad", "workspace", ""), "/d").lanes.get("Nomad")?.workspace).toBeUndefined();
	});

	it("starts a new config with a header and a data folder", () => {
		const next = addLane(newConfigText("~/.local/share/orrery"), "/x", lane);
		const config = parseConfig(next, "/x");
		expect(config.lanes.get("Gamma")?.compactor.model.modelId).toBe("gpt-6.1-sol");
		expect(next).toMatch(/^# Orrery's config/);
	});
});

describe("archiveLane", () => {
	const THREE = `# my lanes
data_dir = "/m"   # where it lives

[lanes.Alpha]
workspace = "/w/alpha"
compactor_model = "openai/gpt-6.1-sol"   # sign-in
compactor_jobs = 4

# the second lane
[lanes.Beta]
# Beta's own note
compactor_model = "openai/gpt-6.1-sol"
allowed_roots = [
  "/w",
]
workspace = "/w/beta"

[lanes.Gamma]
workspace = "/w/gamma"
compactor_model = "openai/gpt-6.1-sol"
`;
	const note = (name: string) => `# Archived 2026-10-08 (orrery lane archive ${name}). Its memory is still in /m/lanes/${name}. Uncomment to bring it back:`;

	it("takes a block out of the middle, keeps the comments between blocks with the next one, and keeps it as comments at the end", () => {
		const next = archiveLane(THREE, "/x", "Beta", "2026-10-08");
		expect(next).toBe(`# my lanes
data_dir = "/m"   # where it lives

[lanes.Alpha]
workspace = "/w/alpha"
compactor_model = "openai/gpt-6.1-sol"   # sign-in
compactor_jobs = 4

# the second lane

[lanes.Gamma]
workspace = "/w/gamma"
compactor_model = "openai/gpt-6.1-sol"

${note("Beta")}
# [lanes.Beta]
# # Beta's own note
# compactor_model = "openai/gpt-6.1-sol"
# allowed_roots = [
#   "/w",
# ]
# workspace = "/w/beta"
`);
		expect([...parseConfig(next, "/x").lanes.keys()]).toEqual(["Alpha", "Gamma"]);
	});

	it("takes the first and the last block out without leaving two blank lines", () => {
		const first = archiveLane(THREE, "/x", "Alpha", "2026-10-08");
		expect(first.startsWith('# my lanes\ndata_dir = "/m"   # where it lives\n\n# the second lane\n[lanes.Beta]\n')).toBe(true);
		expect(first.endsWith(`\n\n${note("Alpha")}\n# [lanes.Alpha]\n# workspace = "/w/alpha"\n# compactor_model = "openai/gpt-6.1-sol"   # sign-in\n# compactor_jobs = 4\n`)).toBe(true);
		const last = archiveLane(THREE, "/x", "Gamma", "2026-10-08");
		expect(last.endsWith('workspace = "/w/beta"\n\n' + `${note("Gamma")}\n# [lanes.Gamma]\n# workspace = "/w/gamma"\n# compactor_model = "openai/gpt-6.1-sol"\n`)).toBe(true);
		// A second archive goes after the first.
		const both = archiveLane(last, "/x", "Alpha", "2026-10-08");
		expect(both.indexOf(note("Gamma"))).toBeLessThan(both.indexOf(note("Alpha")));
		expect([...parseConfig(both, "/x").lanes.keys()]).toEqual(["Beta"]);
		// The last lane: no lanes are left.
		expect(parseConfig(archiveLane(both, "/x", "Beta", "2026-10-08"), "/x").lanes.size).toBe(0);
	});

	it("keeps Windows line endings and a missing final newline", () => {
		const crlf = THREE.replaceAll("\n", "\r\n").replace(/\r\n$/, "");
		const next = archiveLane(crlf, "/x", "Alpha", "2026-10-08");
		expect(next.replaceAll("\r\n", "").includes("\n")).toBe(false);
		expect(next.endsWith("# compactor_jobs = 4")).toBe(true);
		expect(next).toContain(`${note("Alpha")}\r\n# [lanes.Alpha]\r\n`);
		expect([...parseConfig(next, "/x").lanes.keys()]).toEqual(["Beta", "Gamma"]);
	});

	it("refuses an unknown lane, and a lane another lane reads", () => {
		expect(() => archiveLane(THREE, "/x", "Delta", "2026-10-08")).toThrow("No lane named Delta in the config.");
		const read = THREE.replace('[lanes.Gamma]\nworkspace = "/w/gamma"', '[lanes.Gamma]\nreads = ["Alpha"]\nworkspace = "/w/gamma"');
		expect(() => archiveLane(read, "/x", "Alpha", "2026-10-08")).toThrow("Gamma reads it; take it out of Gamma's reads first.");
		// Reading every lane names none.
		const all = THREE.replace('[lanes.Gamma]\nworkspace = "/w/gamma"', '[lanes.Gamma]\nreads = ["*"]\nworkspace = "/w/gamma"');
		expect([...parseConfig(archiveLane(all, "/x", "Alpha", "2026-10-08"), "/x").lanes.keys()]).toEqual(["Beta", "Gamma"]);
	});

	it("refuses a block whose commented copy would not read back the same (a multi-line string ending on a # line)", () => {
		const odd = THREE.replace('compactor_jobs = 4\n', 'compactor_jobs = 4\ninstructions = """\nAGENTS.md\n# end"""\n');
		expect(parseConfig(odd, "/x").lanes.get("Alpha")?.instructions).toBe("AGENTS.md\n# end");
		expect(() => archiveLane(odd, "/x", "Alpha", "2026-10-08")).toThrow("Alpha's block can't be archived safely; edit the config by hand.");
	});

	it("refuses an edit that would leave part of the lane behind (a sub-table of it)", () => {
		const sub = THREE.replace("\n# the second lane", "\n[lanes.Alpha.extra]\nnote = 1\n\n# the second lane");
		expect(() => archiveLane(sub, "/x", "Alpha", "2026-10-08")).toThrow("Alpha's block can't be archived safely; edit the config by hand.");
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
		const config = editConfigFile(path, (text, configDir) => setLaneKey(text, configDir, "Beta", "tool", "pi"));
		expect(config.lanes.get("Alpha")?.compactor.jobs).toBe(6);
		expect(config.lanes.get("Beta")?.tool).toBe("pi");
	});

	it("creates a missing config (folder 0700, file 0600)", () => {
		const dir = tempDir("orrery-edit-");
		dirs.push(dir);
		const path = join(dir, "sub", "config.toml");
		editConfigFile(path, (text, configDir) => addLane(text, configDir, { name: "A", workspace: "/w/a", tool: "pi", compactorModel: "openai/gpt-6.1-sol", compactorThinking: "low" }));
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
		const next = setLaneKey(base, "/x", "Alpha", "remote", "home").replace('remote = "home"', 'remote = "home" # travels');
		const cleared = setLaneKey(next, "/x", "Alpha", "remote", "");
		expect((parse(cleared).lanes as Record<string, Record<string, unknown>>).Alpha.remote).toBeUndefined();
		expect(cleared).toContain("# travels");
		expect(() => removeRemote(next, "/x", "home")).toThrow(/Alpha/);
		const removed = removeRemote(cleared, "/x", "home");
		expect(parse(removed).remotes).toBeUndefined();
		expect(removed).toContain('# my lanes');
	});

	it("adds a new lane with its memory home", () => {
		const text = addLane(addRemote(BASE, "/x", cloud), "/x", {
			name: "Gamma", workspace: "/w/gamma", tool: "omp", remote: "home",
			compactorModel: "openai/gpt-6.1-sol", compactorThinking: "high",
		});
		expect(parseConfig(text, "/x").lanes.get("Gamma")).toMatchObject({ remote: "home", tool: "omp" });
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
