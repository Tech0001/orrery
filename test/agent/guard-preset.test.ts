import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig, protectInText } from "../../src/agent/config.ts";
import { addAgent, addGuardPreset, archiveAgent, GUARD_PRESET, newConfigText, setAgentKey } from "../../src/agent/config-edit.ts";

/** The [guard] preset (spec 2026-10-16-guard-presets): in new configs, and added once to older ones by setup. */

const AGENT = { name: "Gamma", folder: "/w/gamma", compactorModel: "openai/gpt-6.1-sol", compactorThinking: "low" as const };

/** The preset's examples, as its commented lines write them. */
const examples = (text: string) => [...text.matchAll(/^ {2}# (".*"),$/gm)].map((match) => JSON.parse(match[1]) as string);

describe("a new config's [guard] preset", () => {
	it("is valid TOML: an empty protect list with commented examples, read as no entries", () => {
		for (const text of [newConfigText(), newConfigText("/srv/memory")]) {
			expect(text).toMatch(/^# Orrery's config/);
			expect(text).toContain(GUARD_PRESET);
			expect(parse(text)).toMatchObject({ guard: { protect: [] } });
			expect(parseConfig(text, "/x").guard.protect).toEqual([]);
			expect(protectInText(text)).toEqual([]);
		}
		// data_dir stays a top-level key, before the table.
		expect(parseConfig(newConfigText("/srv/memory"), "/x").dataDir).toBe("/srv/memory");
	});

	it("says what the entries are, and each example, uncommented, is an entry the config takes as it is described", () => {
		expect(GUARD_PRESET).toMatch(/^\[guard\]\nprotect = \[$/m);
		expect(GUARD_PRESET).toMatch(/\.env, \.dev\.vars/);
		expect(GUARD_PRESET).toMatch(/starting with \/ or ~\//);
		expect(GUARD_PRESET).toMatch(/exactly that name/);
		const listed = examples(GUARD_PRESET);
		expect(listed).toEqual([".envrc", "terraform.tfvars", "secrets.yml", "~/finance"]);
		const uncommented = newConfigText().replace(/^ {2}# (".*",)$/gm, "  $1");
		expect(parseConfig(uncommented, "/x").guard.protect).toEqual(listed);
		// Every comment line of the block is a comment: nothing else is read.
		for (const line of GUARD_PRESET.split("\n")) expect([line, /^(#|\[guard\]$|protect = \[$|\]$| {2}# ")/.test(line)]).toEqual([line, true]);
	});

	it("is in the workstation config example too, word for word", () => {
		const example = readFileSync(new URL("../../deploy/workstation/config.example.toml", import.meta.url), "utf8");
		expect(example).toContain(`\n${GUARD_PRESET}\n`);
		expect(parseConfig(example, "/x").guard.protect).toEqual([]);
	});

	it("takes agents after it, and the editor keeps it as written", () => {
		const added = addAgent(newConfigText(), "/x", AGENT);
		expect(added.startsWith(newConfigText())).toBe(true);
		expect(parseConfig(added, "/x").agents.has("Gamma")).toBe(true);
		const set = setAgentKey(added, "/x", "Gamma", "tool", "pi");
		expect(set).toContain(GUARD_PRESET);
		const archived = archiveAgent(addAgent(set, "/x", { ...AGENT, name: "Delta", folder: "/w/delta" }), "/x", "Gamma", "2026-10-16");
		expect(archived).toContain(GUARD_PRESET);
		expect(parseConfig(archived, "/x").guard.protect).toEqual([]);
	});
});

describe("adding the preset to an older config (addGuardPreset)", () => {
	const OLD = `# Orrery's config: one [agents.<Name>] block per agent. Memory lives beside this file unless you point it elsewhere.
# The Orrery TUI (run \`orrery\`) edits this file in place and keeps your comments.
data_dir = "~/memory"   # where it lives

# the main agent
[agents.Alpha]
folder = "/w/alpha"
compactor_model = "openai/gpt-6.1-sol"   # sign-in

[agents.Beta]
folder = "/w/beta"
compactor_model = "openai/gpt-6.1-sol"
`;

	it("puts it before the first table, with the comments right above that table kept with it, and every other line as it was", () => {
		const next = addGuardPreset(OLD, "/x") as string;
		const at = OLD.indexOf("# the main agent");
		expect(next).toBe(`${OLD.slice(0, at)}${GUARD_PRESET}\n\n${OLD.slice(at)}`);
		const before = parse(OLD) as Record<string, unknown>;
		expect(parse(next)).toEqual({ ...before, guard: { protect: [] } });
		expect(parseConfig(next, "/x").guard.protect).toEqual([]);
	});

	it("leaves a config that has a [guard] table alone, whatever it holds", () => {
		for (const text of [`${OLD}\n[guard]\n`, `${OLD}\n[guard]\nprotect = []\n`, `[guard]\nprotect = ["secrets.yml"]\n\n${OLD.slice(OLD.indexOf("[agents.Alpha]"))}`]) {
			expect(addGuardPreset(text, "/x")).toBeUndefined();
		}
	});

	it("refuses a config Orrery cannot read, and changes nothing", () => {
		for (const text of [`${OLD}[agents.Gamma\n`, `${OLD}\n[Guard]\nprotect = []\n`, `protect = ["x"]\n${OLD}`]) {
			expect(() => addGuardPreset(text, "/x")).toThrow(ConfigError);
		}
	});

	it("appends it to a config with no table, a config with no final newline, and an empty one", () => {
		expect(addGuardPreset('data_dir = "/m"\n', "/x")).toBe(`data_dir = "/m"\n\n${GUARD_PRESET}\n`);
		expect(addGuardPreset('data_dir = "/m"', "/x")).toBe(`data_dir = "/m"\n\n${GUARD_PRESET}\n`);
		expect(addGuardPreset("", "/x")).toBe(`${GUARD_PRESET}\n`);
		const noFinal = OLD.slice(0, -1);
		const next = addGuardPreset(noFinal, "/x") as string;
		expect(next.endsWith('compactor_model = "openai/gpt-6.1-sol"')).toBe(true);
		expect(parse(next)).toEqual({ ...(parse(OLD) as object), guard: { protect: [] } });
	});

	it("keeps a file's CRLF line ends", () => {
		const crlf = OLD.replace(/\n/g, "\r\n");
		const next = addGuardPreset(crlf, "/x") as string;
		expect(next.replace(/\r\n/g, "")).not.toContain("\n");
		expect(next).toContain(GUARD_PRESET.replace(/\n/g, "\r\n"));
		expect(parse(next)).toEqual({ ...(parse(OLD) as object), guard: { protect: [] } });
	});

	it("puts it right before the table when the comments above it start the file or hold a setting, past a value that only looks like a table, and else at the end", () => {
		const table = `[agents.Alpha]\nfolder = "/w/alpha"\ncompactor_model = "openai/gpt-6.1-sol"\n`;
		// The file's own title, and settings commented out above every table, stay above the block.
		const titled = `# my config\n# data_dir = "/mnt/big"\n${table}`;
		const placed = addGuardPreset(titled, "/x") as string;
		expect(placed).toBe(`# my config\n# data_dir = "/mnt/big"\n\n${GUARD_PRESET}\n\n${table}`);
		expect(parseConfig(placed.replace('# data_dir = "/mnt/big"', 'data_dir = "/mnt/big"'), "/x").dataDir).toBe("/mnt/big");
		const commented = `data_dir = "/m"\n\n# data_dir = "/other"\n# the agents\n${table}`;
		expect(addGuardPreset(commented, "/x")).toBe(`data_dir = "/m"\n\n# data_dir = "/other"\n# the agents\n\n${GUARD_PRESET}\n\n${table}`);
		// A line starting with "[" inside a value is no table: the block goes before the first real one, above its comment.
		const glued = `# my config\n${table}`;
		const nested = `extra = [\n  ["a", "b"],\n]\n${glued}`;
		expect(addGuardPreset(nested, "/x")).toBe(`extra = [\n  ["a", "b"],\n]\n\n${GUARD_PRESET}\n\n${glued}`);
		// No real table at all: at the end, where it cannot split a value.
		const quoted = `notes = """\n[agents.Alpha]\n"""\ndata_dir = "/m"\n`;
		const next = addGuardPreset(quoted, "/x") as string;
		expect(next).toBe(`${quoted}\n${GUARD_PRESET}\n`);
		expect(parse(next)).toEqual({ ...(parse(quoted) as object), guard: { protect: [] } });
	});

	it("keeps an archived agent's comments where they are, at the end", () => {
		const archived = archiveAgent(OLD, "/x", "Beta", "2026-10-16");
		const next = addGuardPreset(archived, "/x") as string;
		expect(next.endsWith(archived.slice(archived.indexOf("# Archived")))).toBe(true);
		expect(parseConfig(next, "/x").guard.protect).toEqual([]);
	});
});

describe("[guard] protect read from a config that does not parse (protectInText)", () => {
	const broken = (text: string) => `${text}\n[agents.Atlas\n`;

	it("reads no entries when its one [guard] table is the preset, or an empty list, and the TOML is broken elsewhere", () => {
		expect(protectInText(broken(newConfigText()))).toEqual([]);
		expect(protectInText(broken(newConfigText("/srv/memory")))).toEqual([]);
		expect(protectInText(broken("[guard]\nprotect = []\n"))).toEqual([]);
		expect(protectInText(broken("[guard]   # mine\nprotect = [   # none yet\n]\n"))).toEqual([]);
		expect(protectInText(broken("[guard]\n"))).toEqual([]);
		// CRLF line ends, as the editor keeps them.
		expect(protectInText(broken(newConfigText()).replace(/\n/g, "\r\n"))).toEqual([]);
		expect(protectInText(broken('[guard]\r\nprotect = ["secrets.yml"]\r\n').replace(/\r?\n/g, "\r\n"))).toBeUndefined();
	});

	it("still knows nothing when that table holds an entry, is broken itself, or another line may hold [guard] protect", () => {
		for (const text of [
			broken(newConfigText().replace('  # "secrets.yml",', '  "secrets.yml",')),
			broken('[guard]\nprotect = ["secrets.yml"]\n'),
			broken("[guard]\nprotect = [\n"),
			broken("[guard]\nprotect = []\nprotects = []\n"),
			broken("[guard]\nprotect = []\n[guard.more]\n"),
			broken('[guard]\nprotect = []\n[agents.A]\nprotect = ["x"]\n'),
			broken('[guard]\nprotect = []\n[[guard]]\nprotect = ["x"]\n'),
			broken('guard.protect = ["x"]\n[guard]\nprotect = []\n'),
			broken("[Guard]\nprotect = []\n"),
			broken('[guard]\nprotect = []\nx = """\n[y]\n"""\n'),
		]) {
			expect([text, protectInText(text)]).toEqual([text, undefined]);
		}
	});
});
