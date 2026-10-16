/**
 * Edits config.toml as text (spec 2026-10-08-orrery-tui-design §4.4): one agent key, one new agent block, or one agent
 * archived (its block moved to comments at the end). Every other line stays byte for byte, comments and blank lines
 * included. Each edit is checked before it is returned: the text must parse, and the parsed config must differ from
 * the old one by exactly the change.
 */

import { randomBytes } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse } from "smol-toml";
import { ConfigError, type HarnessConfig, agentNameProblem, type AgentTool, type AgentLauncher, parseConfig, type ThinkingLevel } from "./config.ts";
import { orreryHome } from "./home.ts";

/** The agent keys the TUI and `orrery agent set` may change. */
export const EDITABLE_KEYS = ["remote", "launcher", "ori_model", "tool", "folder", "view_bytes", "compactor_context_bytes", "compactor_jobs", "compact_at", "compactor_model", "compactor_thinking"] as const;
export type EditableKey = (typeof EDITABLE_KEYS)[number];
export type ConfigValue = string | number;

export interface NewAgent {
	readonly name: string;
	/** The agent's default folder; absent: it opens wherever it is opened. */
	readonly folder?: string;
	readonly tool?: AgentTool;
	readonly remote?: string;
	readonly launcher?: AgentLauncher;
	readonly compactorModel: string;
	readonly compactorThinking: ThinkingLevel;
	readonly viewBytes?: number;
	readonly nodeBytes?: number;
	readonly contextBytes?: number;
	readonly compactorJobs?: number;
	readonly compactAt?: number;
	readonly reads?: readonly string[];
}

const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
type Table = Record<string, unknown>;

function tomlValue(value: ConfigValue | readonly string[]): string {
	if (typeof value === "number") {
		if (!Number.isInteger(value) || value < 1) throw new ConfigError("a number setting must be a positive whole number");
		return String(value);
	}
	// JSON's string escapes (\" \\ \n \t \uXXXX) are all valid in a TOML basic string.
	return JSON.stringify(value);
}

/** The agent an `[agents.Name]` header line names, or undefined. */
function agentHeader(line: string): string | undefined {
	const m = /^\s*\[\s*agents\s*\.\s*(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*\]\s*(?:#.*)?\r?$/.exec(line);
	return m === null ? undefined : (m[1] ?? m[2]);
}

/** Splits what follows `key = ` into the value and the rest of the line (spaces and a comment). */
function splitValue(rest: string): { value: string; tail: string } {
	let end: number;
	if (rest.startsWith('"')) {
		end = 1;
		while (end < rest.length && rest[end] !== '"') end += rest[end] === "\\" ? 2 : 1;
		end = Math.min(end + 1, rest.length);
	} else if (rest.startsWith("'")) {
		const close = rest.indexOf("'", 1);
		end = close === -1 ? rest.length : close + 1;
	} else {
		end = (/^[^\s#]*/.exec(rest)?.[0] ?? "").length;
	}
	return { value: rest.slice(0, end), tail: rest.slice(end) };
}

/** Sorts object keys at every depth, so two parsed configs compare by content. */
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Table)[key])]));
	}
	return value;
}

/** Whether `text` is valid TOML (whatever orrery thinks of its values). */
function tomlParses(text: string): boolean {
	try {
		parse(text);
		return true;
	} catch {
		return false;
	}
}

/** The parsed config without an empty `agents` table, so a config whose last agent was archived compares equal. */
function withoutEmptyAgents(config: Table): Table {
	const out = { ...config };
	for (const key of ["agents", "remotes"]) {
		const value = out[key];
		if (typeof value === "object" && value !== null && Object.keys(value).length === 0) delete out[key];
	}
	return out;
}

/**
 * Returns `next` once it parses and differs from `old` by exactly `agents[agent] = table` (or, when `table` gives
 * undefined, by the agent taken out); throws otherwise. When the old text is valid TOML and the new one is not, orrery
 * put the line in the wrong place (inside a multi-line value): that is said as orrery's failure, never as a fault in the
 * user's file.
 */
function checked(old: string, next: string, configDir: string, agent: string, table: (before: Table | undefined) => Table | undefined, group = "agents"): string {
	if (!tomlParses(old)) parseConfig(old, configDir); // throws: the file itself is not valid TOML
	if (!tomlParses(next)) throw new ConfigError("Orrery couldn't place this change safely; the config is unchanged — edit it by hand.");
	const want = parse(old) as Table;
	const agents = { ...((want[group] as Table | undefined) ?? {}) };
	const after = table(agents[agent] as Table | undefined);
	if (after === undefined) delete agents[agent];
	else agents[agent] = after;
	want[group] = agents;
	if (JSON.stringify(canonical(withoutEmptyAgents(parse(next) as Table))) !== JSON.stringify(canonical(withoutEmptyAgents(want)))) {
		throw new ConfigError("That edit would change more than intended; the config is left as it was.");
	}
	parseConfig(next, configDir); // throws a ConfigError naming a value Orrery refuses
	return next;
}

/** Sets one key of one agent: replaces its value (keeping the comment after it) or adds the line after the block's last key. */
export function setAgentKey(text: string, configDir: string, agent: string, key: EditableKey, value: ConfigValue): string {
	const cr = text.includes("\r\n") ? "\r" : "";
	// Edit as if the file ended with a newline; take it off again at the end when it did not.
	const noFinal = text !== "" && !text.endsWith("\n");
	const lines = (noFinal ? `${text}${cr}\n` : text).split("\n");
	const finish = (next: string) => (noFinal ? next.slice(0, -(cr.length + 1)) : next);
	const start = lines.findIndex((line) => agentHeader(line) === agent);
	if (start === -1) throw new ConfigError(`No agent named ${agent} in the config.`);
	let end = start + 1;
	while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
	const clear = value === "" && (key === "launcher" || key === "ori_model" || key === "remote" || key === "folder");
	const written = tomlValue(value);
	const keyLine = new RegExp(`^(\\s*)${key}(\\s*=\\s*)(.*)$`);
	const change = (before: Table | undefined) => {
		const next = { ...before, [key]: value };
		if (clear) delete next[key];
		return next;
	};
	let lastKey = start;
	for (let i = start + 1; i < end; i++) {
		const bare = lines[i].replace(/\r$/, "");
		if (/^\s*[A-Za-z0-9_"'-]+\s*=/.test(bare)) lastKey = i;
		const m = keyLine.exec(bare);
		if (m === null) continue;
		if (/^("""|'''|\[|\{)/.test(m[3])) throw new ConfigError(`agents.${agent}.${key} spans several lines or is not a single value; change it by hand.`);
		if (clear) {
			const comment = splitValue(m[3]).tail.trimStart();
			if (comment) lines[i] = `${m[1]}${comment}${cr}`;
			else lines.splice(i, 1);
			return checked(text, finish(lines.join("\n")), configDir, agent, change);
		}
		lines[i] = `${m[1]}${key}${m[2]}${written}${splitValue(m[3]).tail}${lines[i].endsWith("\r") ? "\r" : ""}`;
		return checked(text, finish(lines.join("\n")), configDir, agent, change);
	}
	if (clear) return checked(text, text, configDir, agent, change);
	lines.splice(lastKey + 1, 0, `${key} = ${written}${cr}`);
	return checked(text, finish(lines.join("\n")), configDir, agent, change);
}

/**
 * Appends a new agent's block, after one blank line. It also writes `model` (the summary model): only `orrery run` uses
 * it, but orrery versions before the TUI require it in every agent, and one agent without it makes them refuse the config.
 */
export function addAgent(text: string, configDir: string, agent: NewAgent): string {
	const problem = agentNameProblem(agent.name);
	if (problem !== undefined) throw new ConfigError(problem);
	if (agent.folder !== undefined && !isAbsolute(agent.folder)) throw new ConfigError("The folder must be an absolute path.");
	const before = parseConfig(text, configDir);
	if ([...before.agents.keys()].some((name) => name.toLowerCase() === agent.name.toLowerCase())) throw new ConfigError(`An agent named ${agent.name} already exists.`);
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const table = { ...(agent.folder === undefined ? {} : { folder: agent.folder }), ...(agent.tool === undefined ? {} : { tool: agent.tool }), ...(agent.launcher === "ori" ? { launcher: "ori" } : {}), model: agent.compactorModel, compactor_model: agent.compactorModel, compactor_thinking: agent.compactorThinking,
		...(agent.remote === undefined ? {} : { remote: agent.remote }),
		...(agent.viewBytes === undefined ? {} : { view_bytes: agent.viewBytes }),
		...(agent.nodeBytes === undefined ? {} : { node_bytes: agent.nodeBytes }),
		...(agent.contextBytes === undefined ? {} : { compactor_context_bytes: agent.contextBytes }),
		...(agent.compactorJobs === undefined ? {} : { compactor_jobs: agent.compactorJobs }),
		...(agent.compactAt === undefined ? {} : { compact_at: agent.compactAt }),
		...(agent.reads === undefined ? {} : { reads: agent.reads }),
	};
	const block = [`[agents.${agent.name}]`, ...Object.entries(table).map(([key, value]) => `${key} = ${tomlValue(value)}`)].join(eol);
	const sep = text === "" ? "" : text.endsWith("\n") ? eol : eol + eol;
	return checked(text, `${text}${sep}${block}${eol}`, configDir, agent.name, () => table);
}

/**
 * Takes an agent out of the config and keeps its block as comments at the end, so it can come back by uncommenting; its
 * memory folder is not touched. The block runs from its `[agents.Name]` line through its last key line: comment and
 * blank lines after that stay with the next block. Refused when another agent's `reads` names it, and when the
 * commented copy would not read back as the same agent.
 */
export function archiveAgent(text: string, configDir: string, agent: string, day: string): string {
	const before = parseConfig(text, configDir);
	const archived = before.agents.get(agent);
	if (archived === undefined) throw new ConfigError(`No agent named ${agent} in the config.`);
	const reader = [...before.agents.values()].find((other) => other.name !== agent && other.reads.includes(agent));
	if (reader !== undefined) throw new ConfigError(`${reader.name} reads it; take it out of ${reader.name}'s reads first.`);
	const cr = text.includes("\r\n") ? "\r" : "";
	const eol = `${cr}\n`;
	const noFinal = text !== "" && !text.endsWith("\n");
	// Split as if the file ended with a newline: the last piece is then always "" (no line).
	const lines = (noFinal ? `${text}${eol}` : text).split("\n");
	const bare = (i: number) => lines[i].replace(/\r$/, "");
	const start = lines.findIndex((line) => agentHeader(line) === agent);
	if (start === -1) throw new ConfigError(`${agent} is not written as an [agents.${agent}] block; archive it by hand.`);
	let next = start + 1;
	while (next < lines.length && !/^\s*\[/.test(lines[next])) next++;
	let end = start;
	for (let i = start + 1; i < next; i++) if (bare(i).trim() !== "" && !bare(i).trim().startsWith("#")) end = i;
	const block = lines.slice(start, end + 1).map((_, k) => bare(start + k));
	lines.splice(start, end - start + 1);
	// A blank line before and after the block would become two: keep one.
	const blank = (i: number) => i >= 0 && i < lines.length - 1 && bare(i).trim() === "";
	if (blank(start - 1) && blank(start)) lines.splice(start, 1);
	const rest = lines.join("\n").replace(/(\r?\n[ \t]*)+$/, "");
	// The memory folder's path on one comment line, whatever characters it has.
	const memory = archived.dir.replace(/[\x00-\x1f\x7f]/g, "?");
	const commented = block.map((line) => (line === "" ? "#" : `# ${line}`));
	// Uncommented, the copy must read back as exactly this agent (a multi-line value whose last line starts with "#"
	// would otherwise be cut short, and the copy could not be brought back).
	const restored = commented.map((line) => (line === "#" ? "" : line.slice(2))).join("\n");
	const want = { agents: { [agent]: ((parse(text) as Table).agents as Table)[agent] } };
	let back: unknown;
	try {
		back = parse(restored);
	} catch {
		back = undefined;
	}
	if (back === undefined || JSON.stringify(canonical(back)) !== JSON.stringify(canonical(want))) {
		throw new ConfigError(`${agent}'s block can't be archived safely; edit the config by hand.`);
	}
	const note = [`# Archived ${day} (orrery agent archive ${agent}). Its memory is still in ${memory}. Uncomment to bring it back:`, ...commented].join(eol);
	const out = `${rest === "" ? "" : `${rest}${eol}${eol}`}${note}${noFinal ? "" : eol}`;
	return checked(text, out, configDir, agent, () => undefined);
}

/**
 * The [guard] block every new config has, and an older one gets once from setup (spec 2026-10-16-guard-presets,
 * addGuardPreset): an empty protect list, with commented examples of each kind of entry the config takes (config.ts
 * protectProblem). No final newline.
 */
export const GUARD_PRESET = [
	"# The guard: files and folders no agent may read or change, on top of what Orrery always protects (SSH and",
	"# cloud keys, tool logins, .env, .dev.vars and the like). A path, starting with / or ~/, protects that file, or",
	"# that folder and everything in it. A name, with no slash, protects every file or folder with exactly that name,",
	"# in any folder. No wildcards. Uncomment a line or add your own:",
	"[guard]",
	"protect = [",
	'  # ".envrc",',
	'  # "terraform.tfvars",',
	'  # "secrets.yml",',
	'  # "~/finance",',
	"]",
].join("\n");

/**
 * A new config's first lines: what the file is, data_dir only when memory lives somewhere other than beside it, and the
 * [guard] preset.
 */
export function newConfigText(dataDir?: string): string {
	const head = "# Orrery's config: one [agents.<Name>] block per agent. Memory lives beside this file unless you point it elsewhere.\n# The Orrery TUI (run `orrery`) edits this file in place and keeps your comments.\n";
	return `${dataDir === undefined ? head : `${head}data_dir = ${tomlValue(dataDir)}\n`}\n${GUARD_PRESET}\n`;
}

/** A comment line that holds a setting, commented out ("# data_dir = …"): uncommented, it belongs where it stands. */
const COMMENTED_KEY = /^[ \t]*#[ \t]*["']?[A-Za-z0-9_.-]+["']?[ \t]*=/;

/**
 * The config with the [guard] preset added (GUARD_PRESET), or undefined when it has a [guard] table already. Every other
 * line stays byte for byte. The block goes before the first table, above the comment lines right over it, so a table
 * keeps its comment; but right before the table when those comments run up from the file's first line (its title, or
 * settings above every table) or hold a setting commented out, which uncommented must stay where it was, not land in
 * [guard]. Else (no table, or none that the block can go before without changing a value) at the end. Checked as the
 * other edits are: the result must parse, and differ from the old config by the empty [guard] table alone. A config
 * Orrery cannot read throws its ConfigError.
 */
export function addGuardPreset(text: string, configDir: string): string | undefined {
	parseConfig(text, configDir);
	const old = parse(text) as Table;
	if (old.guard !== undefined) return undefined;
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const cr = eol === "\r\n" ? "\r" : "";
	const block = GUARD_PRESET.split("\n").map((line) => `${line}${cr}`);
	const want = JSON.stringify(canonical({ ...old, guard: { protect: [] } }));
	const fits = (next: string) => {
		try {
			return JSON.stringify(canonical(parse(next))) === want && parseConfig(next, configDir).guard.protect.length === 0;
		} catch {
			return false;
		}
	};
	const lines = text.split("\n");
	for (let header = 0; header < lines.length; header++) {
		if (!/^[ \t]*\[/.test(lines[header])) continue;
		let at = header;
		while (at > 0 && /^[ \t]*#/.test(lines[at - 1])) at--;
		if (at === 0 || lines.slice(at, header).some((line) => COMMENTED_KEY.test(line))) at = header;
		const gap = at > 0 && lines[at - 1].trim() !== "" ? [cr] : [];
		const next = [...lines.slice(0, at), ...gap, ...block, cr, ...lines.slice(at)].join("\n");
		if (fits(next)) return next;
	}
	const sep = text === "" ? "" : text.endsWith("\n") ? eol : eol + eol;
	const next = `${text}${sep}${GUARD_PRESET.split("\n").join(eol)}${eol}`;
	if (fits(next)) return next;
	throw new ConfigError("Orrery couldn't place the [guard] block safely; the config is unchanged.");
}

/**
 * Puts `data` at `path` in one rename, from a temporary file of its own beside it: created fresh (wx), under a name no
 * one can take first, so nothing already there (a link planted at that name, or at `path`) is written through. A link
 * at `path` is replaced, never followed.
 */
function replaceFile(path: string, data: string | Uint8Array, mode: number): void {
	const temp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
	writeFileSync(temp, data, { mode, flag: "wx" });
	try {
		chmodSync(temp, mode);
		renameSync(temp, path);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

/**
 * Writes the config atomically (a fresh temporary file, then rename), keeping its mode, and keeps the old text as
 * config.toml.bak, written the same way: setup writes the config on its own (src/install/guard-preset.ts), so neither
 * file follows a link someone left at its name.
 */
export function saveConfigText(path: string, next: string): void {
	const target = existsSync(path) ? realpathSync(path) : path;
	let mode = 0o600;
	if (existsSync(target)) {
		mode = statSync(target).mode & 0o777;
		replaceFile(`${target}.bak`, readFileSync(target), mode);
	} else {
		mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
	}
	replaceFile(target, next, mode);
}

/** Re-reads the config, applies `edit`, checks and saves the result; returns the new config. A missing file starts from newConfigText(). */
export function editConfigFile(path: string, edit: (text: string, configDir: string) => string): HarnessConfig {
	const configDir = dirname(resolve(path));
	const text = existsSync(path) ? readFileSync(path, "utf8") : newConfigText();
	const next = edit(text, configDir);
	saveConfigText(path, next);
	return parseConfig(next, configDir);
}

/** What the TUI and the CLI say when the config can't be written. */
export function readOnlyConfigText(path: string): string {
	return `The config can't be written here (${path}); edit it by hand.`;
}

/**
 * Whether Orrery may write this config: the file and its folder (saveConfigText writes .bak and a temporary file beside
 * it), where the file really is; or, when the file does not exist yet, the nearest folder that does.
 */
export function configWritable(path: string): boolean {
	const writable = (at: string) => {
		try {
			accessSync(at, constants.W_OK);
			return true;
		} catch {
			return false;
		}
	};
	let at = resolve(path);
	if (existsSync(at)) {
		const target = realpathSync(at);
		return writable(target) && writable(dirname(target));
	}
	while (!existsSync(at)) at = dirname(at);
	return writable(at);
}

/** Where a new config goes: $ORRERY_CONFIG, else <home>/config.toml. */
export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
	return env.ORRERY_CONFIG || join(orreryHome(env), "config.toml");
}


/** A remote's public settings; credentials are written separately, never to TOML. */
export type NewRemote =
	| { readonly name: string; readonly kind: "server"; readonly host: string; readonly folder: string }
	| { readonly name: string; readonly kind: "cloudflare"; readonly url: string };

/** Appends a remote without touching any existing config text. */
export function addRemote(text: string, configDir: string, remote: NewRemote): string {
	if (!NAME.test(remote.name)) throw new ConfigError("Remote names use letters, digits, - and _ (at most 32), starting with a letter.");
	parseConfig(text, configDir);
	const remotes = (parse(text).remotes ?? {}) as Table;
	if (Object.keys(remotes).some((name) => name.toLowerCase() === remote.name.toLowerCase())) throw new ConfigError(`A remote named ${remote.name} already exists.`);
	const table = remote.kind === "server" ? { kind: remote.kind, host: remote.host, folder: remote.folder } : { kind: remote.kind, url: remote.url };
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const block = [`[remotes.${remote.name}]`, ...Object.entries(table).map(([key, value]) => `${key} = ${tomlValue(value)}`)].join(eol);
	const sep = text === "" ? "" : text.endsWith("\n") ? eol : eol + eol;
	return checked(text, `${text}${sep}${block}${eol}`, configDir, remote.name, () => table, "remotes");
}

/** Removes one unused remote, preserving every line outside its block. */
export function removeRemote(text: string, configDir: string, name: string): string {
	parseConfig(text, configDir);
	const parsed = parse(text) as Table;
	if ((parsed.remotes as Table | undefined)?.[name] === undefined) throw new ConfigError(`No remote named ${name} in the config.`);
	const users = Object.entries((parsed.agents ?? {}) as Table).filter(([, value]) => (value as Table).remote === name).map(([agent]) => agent);
	if (users.length > 0) throw new ConfigError(`${users.join(", ")} uses remote ${name}; run orrery agent local first.`);
	const lines = text.split("\n");
	const start = lines.findIndex((line) => {
		const m = /^\s*\[\s*remotes\s*\.\s*(?:"([^"\n]+)"|'([^'\n]+)'|([A-Za-z0-9_-]+))\s*\]\s*(?:#.*)?\r?$/.exec(line);
		return m !== null && (m[1] ?? m[2] ?? m[3]) === name;
	});
	if (start === -1) throw new ConfigError(`${name} is not written as a [remotes.${name}] block; remove it by hand.`);
	let end = start + 1;
	while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
	while (end > start + 1 && (lines[end - 1].trim() === "" || lines[end - 1].trim().startsWith("#"))) end--;
	lines.splice(start, end - start);
	return checked(text, lines.join("\n"), configDir, name, () => undefined, "remotes");
}
