/** orrery configuration: one TOML file describing data paths, custom model servers, SSH hosts and agents. */

import { type BigIntStats, closeSync, existsSync, fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, isAbsolute, join, posix, resolve } from "node:path";
import { parse } from "smol-toml";
import { type MemoryConfig, memoryConfig } from "../memory/index.ts";
import { ConfigError, orreryHome } from "./home.ts";
import { OPENCODE_SOURCE } from "./opencode-source.ts";

export { ConfigError };

export const DEFAULT_CONFIG_PATH = "/etc/orrery/config.toml";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** The tools an agent is launched in (the `tool` key). */
export const AGENT_TOOLS = ["pi", "claude-code", "codex", "omp", "opencode"] as const;
export type AgentLauncher = "direct" | "ori";
export type AgentTool = (typeof AGENT_TOOLS)[number];

export interface ModelChoice {
	readonly provider: string;
	readonly modelId: string;
	readonly thinking: ThinkingLevel;
}

export type HostConfig =
	| { readonly name: "local"; readonly kind: "local" }
	| {
			readonly name: string;
			readonly kind: "ssh";
			readonly host: string;
			readonly user?: string;
			readonly port?: number;
			readonly identityFile: string;
			readonly knownHostsFile: string;
			readonly hostKeyAlias: string;
			readonly connectTimeout: number;
	  };

/** Where an agent's memory lives when it is not on this machine only (spec 2026-10-12-remote-agents-design §4). */
export type RemoteConfig =
	| { readonly name: string; readonly kind: "server"; readonly host: Extract<HostConfig, { kind: "ssh" }>; readonly folder: string }
	| { readonly name: string; readonly kind: "cloudflare"; readonly url: string };

export interface CustomModelConfig {
	readonly id: string;
	readonly name: string;
	readonly contextWindow: number;
	readonly maxTokens: number;
	readonly reasoning: boolean;
}

export interface CustomProviderConfig {
	readonly id: string;
	readonly baseUrl: string;
	readonly apiKeyEnv?: string;
	readonly models: readonly CustomModelConfig[];
}

export interface AgentConfig {
	readonly name: string;
	readonly dir: string;
	readonly host: HostConfig;
	/**
	 * The agent's default folder: where the TUI opens it, and how a session started in it finds it (src/agent/pick.ts).
	 * Absent: the agent opens only by name (ORRERY_AGENT), in whatever folder it is opened.
	 */
	readonly folder?: string;
	readonly allowedRoots: readonly string[];
	/** The tool the agent is launched in; undefined when the config does not say (the TUI then guesses). */
	readonly tool?: AgentTool;
	/** Absent in older callers means direct. Parsed configs always supply the default. */
	readonly launcher?: AgentLauncher;
	readonly oriModel?: string;
	/** The agent model only `orrery run` uses; pi and Claude Code pick their own. */
	readonly model?: ModelChoice;
	/** contextBytes: the top of each summary call's view (compactor_context_bytes; default 32,000, floor half). */
	readonly compactor: { readonly model: ModelChoice; readonly jobs: number; readonly contextBytes?: number };
	/** The Orrery mod compacts the Claude Code conversation past this many tokens (compact_at; default 200,000). */
	readonly compactAt: number;
	readonly memory: MemoryConfig;
	readonly reads: readonly string[];
	/** The remote holding this agent's memory; absent = this machine only. */
	readonly remote?: string;
}

export interface HarnessConfig {
	readonly dataDir: string;
	readonly credentialsPath: string;
	readonly deviceIdPath: string;
	readonly sshDir: string;
	/** This machine's name in remote locks: machine_name, or the hostname. */
	readonly machineName: string;
	readonly remotes: ReadonlyMap<string, RemoteConfig>;
	readonly providers: readonly CustomProviderConfig[];
	readonly hosts: ReadonlyMap<string, HostConfig>;
	readonly agents: ReadonlyMap<string, AgentConfig>;
	readonly updates: { readonly check: boolean };
	/**
	 * [guard] protect (spec 2026-10-15-guard-protect): files and folders every agent's guard keeps out, as the config
	 * writes them (protectEntries): a path ("/…" or "~/…", "~" read by each guard) or a name (no "/").
	 */
	readonly guard: { readonly protect: readonly string[] };
	/**
	 * The file loadConfig read it from, an absolute path (links kept, so a relative data_dir reads as it did); none for a
	 * config parsed from text. A session's host records it (src/agent/sessions.ts), and the CLI takes that file, and no
	 * other, for a command run inside the session (src/cli/gate.ts).
	 */
	readonly file?: string;
}

type Table = Record<string, unknown>;
const LOCAL_HOST: HostConfig = { name: "local", kind: "local" };
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

/** Words `orrery agent` takes as subcommands: no agent may be named one of them (compared without case). */
export const RESERVED_NAMES: readonly string[] = ["add", "set", "edit", "archive", "push", "pull", "takeover", "local"];

const reserved = (name: string) => `${name} is a word orrery agent uses (${RESERVED_NAMES.join(", ")})`;

/** Why `name` cannot name an agent, or undefined when it can. */
export function agentNameProblem(name: string): string | undefined {
	if (!NAME.test(name)) return "Agent names use letters, digits, - and _ (at most 32), starting with a letter.";
	if (RESERVED_NAMES.includes(name.toLowerCase())) return `${reserved(name)}; pick another name.`;
	return undefined;
}

function table(value: unknown, where: string): Table {
	if (value === undefined) return {};
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ConfigError(`${where} must be a table`);
	return value as Table;
}

function str(t: Table, key: string, where: string, fallback?: string): string {
	const value = t[key] ?? fallback;
	if (typeof value !== "string" || value.length === 0) throw new ConfigError(`${where}.${key} must be a non-empty string`);
	return value;
}

function optStr(t: Table, key: string, where: string): string | undefined {
	return t[key] === undefined ? undefined : str(t, key, where);
}

/** Where the Orrery mod compacts a Claude Code conversation, in tokens (agent key compact_at; spec 2026-10-08-claude-code-mod §4.5). */
export const COMPACT_AT_DEFAULT = 200_000;
export const COMPACT_AT_MIN = 100_000;

function int(t: Table, key: string, where: string, fallback?: number): number {
	const value = t[key] ?? fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new ConfigError(`${where}.${key} must be a positive integer`);
	return value;
}

function thinking(value: string, where: string): ThinkingLevel {
	if (!(THINKING_LEVELS as readonly string[]).includes(value)) {
		throw new ConfigError(`${where} must be one of ${THINKING_LEVELS.join(", ")}`);
	}
	return value as ThinkingLevel;
}

export function parseModelChoice(ref: string, level: string, where = "model"): ModelChoice {
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) throw new ConfigError(`${where} must look like "provider/model-id"`);
	return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1), thinking: thinking(level, `${where.replace(/\.model$/, "")}.thinking`) };
}

function path(value: string, base: string): string {
	if (value === "~" || value.startsWith("~/")) return join(homedir(), value.slice(1));
	return isAbsolute(value) ? value : resolve(base, value);
}

function parseProviders(raw: unknown): CustomProviderConfig[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) throw new ConfigError("providers must be an array of tables");
	return raw.map((entry, index) => {
		const where = `providers[${index}]`;
		const t = table(entry, where);
		const models = t.models;
		if (!Array.isArray(models) || models.length === 0) throw new ConfigError(`${where}.models must be a non-empty array`);
		const apiKeyEnv = optStr(t, "api_key_env", where);
		const id = str(t, "id", where);
		if (id === OPENCODE_SOURCE) throw new ConfigError(`${where}.id: "${OPENCODE_SOURCE}" is reserved for OpenCode's models (opencode/<provider>/<model>)`);
		return {
			id,
			baseUrl: str(t, "base_url", where),
			...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
			models: models.map((m, j) => {
				const mw = `${where}.models[${j}]`;
				const mt = table(m, mw);
				const id = str(mt, "id", mw);
				return {
					id,
					name: str(mt, "name", mw, id),
					contextWindow: int(mt, "context_window", mw),
					maxTokens: int(mt, "max_tokens", mw),
					reasoning: mt.reasoning === true,
				};
			}),
		};
	});
}

function parseHosts(raw: unknown, dataDir: string): Map<string, HostConfig> {
	const hosts = new Map<string, HostConfig>([["local", LOCAL_HOST]]);
	for (const [name, value] of Object.entries(table(raw, "hosts"))) {
		const where = `hosts.${name}`;
		if (name === "local") throw new ConfigError(`${where}: the name "local" is reserved`);
		if (!NAME.test(name)) throw new ConfigError(`${where}: names use letters, digits, - and _`);
		const t = table(value, where);
		const port = t.port === undefined ? undefined : int(t, "port", where);
		const user = optStr(t, "user", where);
		hosts.set(name, {
			name,
			kind: "ssh",
			host: str(t, "host", where),
			...(user === undefined ? {} : { user }),
			...(port === undefined ? {} : { port }),
			identityFile: path(str(t, "identity_file", where), dataDir),
			knownHostsFile: path(str(t, "known_hosts", where, "ssh/known_hosts"), dataDir),
			hostKeyAlias: `orrery-${name}`,
			connectTimeout: int(t, "connect_timeout", where, 5),
		});
	}
	return hosts;
}

function parseRemotes(raw: unknown, hosts: ReadonlyMap<string, HostConfig>): Map<string, RemoteConfig> {
	const remotes = new Map<string, RemoteConfig>();
	for (const [name, value] of Object.entries(table(raw, "remotes"))) {
		const where = `remotes.${name}`;
		if (!NAME.test(name)) throw new ConfigError(`${where}: names use letters, digits, - and _ (max 32)`);
		const t = table(value, where);
		const kind = str(t, "kind", where);
		if (kind === "server") {
			const hostName = str(t, "host", where);
			const host = hosts.get(hostName);
			if (host === undefined) throw new ConfigError(`${where}: unknown host "${hostName}"`);
			if (host.kind !== "ssh") throw new ConfigError(`${where}.host must name an SSH host from [hosts]`);
			const folder = str(t, "folder", where);
			if (folder.trim() === "") throw new ConfigError(`${where}.folder must not be empty`);
			if (/\p{Cc}/u.test(folder)) throw new ConfigError(`${where}.folder must have no control characters`);
			remotes.set(name, { name, kind, host, folder });
		} else if (kind === "cloudflare") {
			const url = str(t, "url", where);
			let parsed: URL;
			try {
				parsed = new URL(url);
			} catch {
				throw new ConfigError(`${where}.url is not a URL`);
			}
			const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
			if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) throw new ConfigError(`${where}.url must be https`);
			remotes.set(name, { name, kind, url: url.replace(/\/+$/, "") });
		} else {
			throw new ConfigError(`${where}.kind must be one of server, cloudflare`);
		}
	}
	return remotes;
}

function memoryOverrides(t: Table, where: string): MemoryConfig {
	const keys = { node_bytes: "nodeBytes", view_bytes: "viewBytes", tries: "tries", retry_seconds: "retrySeconds", tool_cap: "toolCap" } as const;
	const overrides: Record<string, number> = {};
	for (const [toml, name] of Object.entries(keys)) {
		if (t[toml] !== undefined) {
			if (typeof t[toml] !== "number") throw new ConfigError(`${where}.${toml} must be a number`);
			overrides[name] = t[toml] as number;
		}
	}
	try {
		return memoryConfig(overrides);
	} catch (error) {
		throw new ConfigError(`${where}: ${(error as Error).message}`);
	}
}

/**
 * [guard] protect: each entry a path ("/…" or "~/…": that file, or that folder and everything in it) or a name (no "/":
 * every file or folder so named). An entry that would protect less than it says, or everything, is refused: a relative
 * path with a "/", "~" or "/" alone, ".." in a path, "." or ".." as a name, spaces at an end, and globs or braces, which
 * are not read as patterns (taken literally they would mislead).
 */
function protectEntries(raw: unknown): string[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) throw new ConfigError("guard.protect must be an array of strings");
	for (const entry of raw as string[]) {
		const problem = protectProblem(entry);
		if (problem !== undefined) throw new ConfigError(`guard.protect entry ${JSON.stringify(entry)} ${problem}`);
	}
	return raw as string[];
}

/**
 * A [guard] table in a config's text, whatever its case, as a header ([guard], [[guard]], [guard.x]), a dotted key or an
 * inline table, or a protect key on any line: what a config that does not parse may hold for [guard] protect.
 */
const GUARD_TABLE = /^[ \t]*(?:\[{1,2}[ \t]*["']?guard["']?[ \t]*[\].]|["']?guard["']?[ \t]*[.=]|["']?protect["']?[ \t]*=)/im;

/**
 * [guard] protect read from a config's text on its own, for a pi or OMP session whose config does not load (spec
 * 2026-10-15-guard-protect): its entries when the TOML parses and [guard] reads cleanly (guardProtect; another key may be
 * what is wrong); none when the text has no [guard] table, or when its one [guard] table holds no entry (emptyGuard: the
 * preset every config has from 0.6.5, spec 2026-10-16-guard-presets); and undefined, unknown, when the text could not be
 * read (`text` undefined), when it does not parse and may hold [guard] protect (GUARD_TABLE), or when guardProtect
 * refuses it, an entry included, as the config parser and Claude Code refuse it. A guard that cannot know the entries
 * refuses every tool call (src/pi/index.ts unreadableGuard). A byte-order mark before the text is not part of it.
 */
export function protectInText(text: string | undefined): readonly string[] | undefined {
	if (text === undefined) return undefined;
	const body = text.replace(/^\uFEFF/, "");
	let root: Table;
	try {
		root = parse(body) as Table;
	} catch {
		return !GUARD_TABLE.test(body) || emptyGuard(body) ? [] : undefined;
	}
	try {
		return guardProtect(root);
	} catch {
		return undefined;
	}
}

/** A plain [guard] header line, as Orrery writes it (a comment after it allowed). */
const GUARD_HEADER = /^[ \t]*\[[ \t]*guard[ \t]*\][ \t]*(?:#.*)?$/;

/**
 * Whether a config text that does not parse holds [guard] protect only in one plain [guard] table that holds no entry:
 * every line that may hold [guard] protect (GUARD_TABLE) is that header or inside its table (up to the next line that
 * starts with "["), and that table, read on its own, is a [guard] guardProtect reads as empty. A table that does not
 * read on its own (the broken part may be in it) or holds an entry, a second header, a dotted or inline guard, or a
 * protect key anywhere else, and the text stays unknown.
 */
function emptyGuard(body: string): boolean {
	// Each line without its CR, so a CRLF config's table reads on its own as an LF one does.
	const lines = body.split("\n").map((line) => line.replace(/\r$/, ""));
	const headers = lines.flatMap((line, at) => (GUARD_HEADER.test(line) ? [at] : []));
	if (headers.length !== 1) return false;
	const start = headers[0];
	let end = start + 1;
	while (end < lines.length && !/^[ \t]*\[/.test(lines[end])) end++;
	const guardLine = new RegExp(GUARD_TABLE.source, "i");
	if (lines.some((line, at) => (at < start || at >= end) && guardLine.test(line))) return false;
	try {
		return guardProtect({ guard: parse(lines.slice(start + 1, end).join("\n")) }).length === 0;
	} catch {
		return false;
	}
}

/**
 * [guard] protect from a parsed config, or a ConfigError for any form that would leave files open without a word: a
 * [guard] spelt in another case ([Guard]), a protect key anywhere but in [guard] (at the top level, in an agent's table
 * or any other), a key [guard] does not have, or an entry protectEntries refuses. A misspelt table name ([gaurd]) is not
 * caught: an unknown top-level table stays allowed, so an older Orrery can still read a newer config.
 */
function guardProtect(root: Table): string[] {
	for (const key of Object.keys(root)) if (key !== "guard" && key.toLowerCase() === "guard") throw new ConfigError(`[${key}] is not read: the table is spelled [guard]`);
	misplacedProtect(root, "");
	const guard = table(root.guard, "guard");
	// A misspelt key would leave the files it names open with no word said: [guard] takes protect alone.
	for (const key of Object.keys(guard)) if (key !== "protect") throw new ConfigError(`guard.${key} is not a setting; [guard] takes protect`);
	return protectEntries(guard.protect);
}

/** The tables whose keys are names the user chooses ([agents.<Name>], [hosts.<name>], [remotes.<name>]), not settings. */
const NAMED_TABLES = new Set(["agents", "hosts", "remotes"]);

/**
 * A protect key in table `t` (dotted name `where`, "" at the top) or any table below it, but [guard]'s own. A name the
 * user chose (an agent, host or remote called protect) is no key: only the keys inside its table are looked at.
 */
function misplacedProtect(t: Table, where: string): void {
	for (const [key, value] of Object.entries(t)) {
		const at = where === "" ? key : `${where}.${key}`;
		if (at === "guard") continue;
		if (key.toLowerCase() === "protect" && !NAMED_TABLES.has(where)) throw new ConfigError(`${at} is read only under [guard]: write [guard], then protect = [...]`);
		for (const inner of Array.isArray(value) ? value : [value]) {
			if (typeof inner === "object" && inner !== null && !Array.isArray(inner)) misplacedProtect(inner as Table, at);
		}
	}
}

function protectProblem(entry: string): string | undefined {
	if (entry.trim() === "") return "is empty";
	if (entry.trim() !== entry) return "has a space at an end";
	if (/\p{Cc}/u.test(entry)) return "has control characters";
	if (/[*?[\]{}]/.test(entry)) return "has a glob or brace character (* ? [ ] { }): name the file or folder itself";
	if (entry.includes("\\")) return "has a backslash: write a path with /";
	if (/^[A-Za-z]:/.test(entry)) return "starts with a drive letter: write a path from / or ~/";
	if (entry === "~") return "would protect everything in your home folder";
	if (!entry.includes("/")) return entry === "." || entry === ".." ? "is not a name" : entry.startsWith("~") ? "is a name, which cannot start with ~: write ~/… for a path in your home folder" : undefined;
	if (!entry.startsWith("/") && !entry.startsWith("~/")) return "must start with / or ~/ (a path), or have no / (a name)";
	if (entry.split("/").includes("..")) return 'has ".." in it: write the path it leads to';
	if (posix.normalize(`/${entry.slice(entry.startsWith("~/") ? 2 : 1)}`) === "/") return "would protect everything";
	return undefined;
}

export function parseConfig(text: string, configDir: string): HarnessConfig {
	let root: Table;
	try {
		root = parse(text) as Table;
	} catch (error) {
		throw new ConfigError(`config is not valid TOML: ${(error as Error).message}`);
	}
	if (root.lanes !== undefined) throw new ConfigError("This config has [lanes.<Name>] sections, from before Orrery 0.6.0: rename each to [agents.<Name>], and its workspace key to folder.");
	const dataDir = path(typeof root.data_dir === "string" ? root.data_dir : configDir, configDir);
	const providers = parseProviders(root.providers);
	const hosts = parseHosts(root.hosts, dataDir);
	const remotes = parseRemotes(root.remotes, hosts);
	const updates = table(root.updates, "updates");
	if (updates.check !== undefined && typeof updates.check !== "boolean") throw new ConfigError("updates.check must be true or false");
	const protect = guardProtect(root);
	const agents = new Map<string, AgentConfig>();
	for (const [name, value] of Object.entries(table(root.agents, "agents"))) {
		const where = `agents.${name}`;
		if (!NAME.test(name)) throw new ConfigError(`${where}: agent names use letters, digits, - and _ (max 32)`);
		if (RESERVED_NAMES.includes(name.toLowerCase())) {
			throw new ConfigError(`${where}: ${reserved(name)}; rename the agent, and its data folder ${join(dataDir, "agents", name)} to the same name, or it starts without its memory`);
		}
		const t = table(value, where);
		if (t.workspace !== undefined) throw new ConfigError(`${where}.workspace is now folder: rename the key`);
		const hostName = str(t, "host", where, "local");
		const host = hosts.get(hostName);
		if (host === undefined) throw new ConfigError(`${where}: unknown host "${hostName}"`);
		const folder = optStr(t, "folder", where);
		if (folder !== undefined && !posix.isAbsolute(folder)) throw new ConfigError(`${where}.folder must be absolute`);
		if (folder === undefined && host.kind !== "local") throw new ConfigError(`${where}: an agent on an SSH host needs a folder`);
		// Before agents, this named a file in the default folder; now the agent's data folder holds them (src/agent/instructions.ts).
		if (t.instructions !== undefined) {
			throw new ConfigError(`${where}.instructions is no longer read: ${name}'s instructions live in ${join(dataDir, "agents", name, "instructions.md")}; move them there and remove this key`);
		}
		const modelRef = optStr(t, "model", where);
		const model = modelRef === undefined ? undefined : parseModelChoice(modelRef, str(t, "thinking", where, "medium"), `${where}.model`);
		const compactorRef = t.compactor_model === undefined && model !== undefined ? `${model.provider}/${model.modelId}` : str(t, "compactor_model", where);
		const tool = optStr(t, "tool", where);
		if (tool !== undefined && !(AGENT_TOOLS as readonly string[]).includes(tool)) throw new ConfigError(`${where}.tool must be one of ${AGENT_TOOLS.join(", ")}`);
		const launcher = str(t, "launcher", where, "direct");
		if (launcher !== "direct" && launcher !== "ori") throw new ConfigError(`${where}.launcher must be one of direct, ori`);
		const oriModel = optStr(t, "ori_model", where);
		if (oriModel !== undefined && /[\s\p{Cc}]/u.test(oriModel)) throw new ConfigError(`${where}.ori_model must have no whitespace or control characters`);
		const roots = t.allowed_roots;
		if (roots !== undefined && (!Array.isArray(roots) || roots.some((r) => typeof r !== "string" || !posix.isAbsolute(r)))) {
			throw new ConfigError(`${where}.allowed_roots must be an array of absolute paths`);
		}
		const reads = t.reads ?? [];
		if (!Array.isArray(reads) || reads.some((r) => typeof r !== "string")) throw new ConfigError(`${where}.reads must be an array of agent names or ["*"]`);
		const contextBytes = t.compactor_context_bytes === undefined ? undefined : int(t, "compactor_context_bytes", where);
		if (contextBytes !== undefined && contextBytes < 2000) throw new ConfigError(`${where}.compactor_context_bytes must be at least 2000`);
		const remote = optStr(t, "remote", where);
		if (remote !== undefined && !remotes.has(remote)) throw new ConfigError(`${where}: unknown remote "${remote}"`);
		const compactAt = int(t, "compact_at", where, COMPACT_AT_DEFAULT);
		if (compactAt < COMPACT_AT_MIN) throw new ConfigError(`${where}.compact_at must be at least ${COMPACT_AT_MIN}`);
		agents.set(name, {
			name,
			dir: join(dataDir, "agents", name),
			host,
			...(folder === undefined ? {} : { folder }),
			allowedRoots: (roots as string[] | undefined) ?? (folder === undefined ? [] : [posix.dirname(folder)]),
			launcher,
			...(oriModel === undefined ? {} : { oriModel }),
			...(tool === undefined ? {} : { tool: tool as AgentTool }),
			...(model === undefined ? {} : { model }),
			compactor: {
				model: parseModelChoice(compactorRef, str(t, "compactor_thinking", where, "low"), `${where}.compactor_model`),
				jobs: int(t, "compactor_jobs", where, 8),
				...(contextBytes === undefined ? {} : { contextBytes }),
			},
			compactAt,
			memory: memoryOverrides(t, where),
			reads: reads as string[],
			...(remote === undefined ? {} : { remote }),
		});
	}
	for (const agent of agents.values()) {
		for (const name of agent.reads) {
			if (name !== "*" && !agents.has(name)) throw new ConfigError(`agents.${agent.name}.reads names unknown agent ${name}`);
		}
	}
	return {
		dataDir,
		credentialsPath: path(typeof root.credentials === "string" ? root.credentials : "credentials.json", dataDir),
		deviceIdPath: join(dataDir, "device-id"),
		sshDir: join(dataDir, "ssh"),
		machineName: typeof root.machine_name === "string" && root.machine_name.trim() !== "" ? root.machine_name.trim() : hostname(),
		remotes,
		providers,
		hosts,
		agents,
		updates: { check: updates.check !== false },
		guard: { protect },
	};
}

/** An agent with a default folder: the only kind a folder can find. */
type Rooted = { readonly folder: string };
const rooted = <T extends { readonly folder?: string }>(agent: T): agent is T & Rooted => agent.folder !== undefined;

/**
 * The agent whose folder is cwd or contains it; the deepest folder wins. Paths are compared with symlinks followed:
 * pi and Claude Code report the physical folder, and a folder may be configured through a symlink (on macOS, /tmp and
 * /var are links into /private), even one that points inside another agent's folder. Only when that finds no agent are
 * the paths compared as written (a folder not made yet). An agent without a folder is never found by folder.
 */
export function agentForCwd(config: HarnessConfig, cwd: string): AgentConfig | undefined {
	const agents = [...config.agents.values()].filter(rooted);
	const roots = agents.map(realRoot);
	const here = resolve(cwd);
	// A cwd that is a folder's real path is physical already: no realpath call for it.
	const physical = roots.includes(here) ? here : realOrResolved(here);
	return deepest(agents, roots, physical) ?? deepest(agents, agents.map((agent) => resolve(agent.folder)), here);
}

/**
 * Whether `dir` is the agent's folder or inside it, compared as agentForCwd compares: symlinks followed, else as
 * written. False for an agent without a folder.
 */
export function insideFolder(agent: { readonly folder?: string }, dir: string): boolean {
	if (!rooted(agent)) return false;
	const here = resolve(dir);
	return holds(realRoot(agent), realOrResolved(here)) || holds(resolve(agent.folder), here);
}

/** Whether `here` is `root` or inside it. */
const holds = (root: string, here: string) => here === root || here.startsWith(`${root}/`);

function deepest(agents: AgentConfig[], roots: string[], here: string): AgentConfig | undefined {
	let best: number | undefined;
	for (let i = 0; i < agents.length; i++) {
		const root = roots[i];
		if (holds(root, here) && (best === undefined || root.length > roots[best].length)) best = i;
	}
	return best === undefined ? undefined : agents[best];
}

/**
 * Each agent's folder with symlinks followed, kept once found (a link changed later counts once the config is loaded
 * again). A folder not made yet is tried again on the next call.
 */
const realRoots = new WeakMap<Rooted, string>();

function realRoot(agent: Rooted): string {
	const known = realRoots.get(agent);
	if (known !== undefined) return known;
	try {
		const real = realpathSync(agent.folder);
		realRoots.set(agent, real);
		return real;
	} catch {
		return resolve(agent.folder);
	}
}

/** The path with symlinks followed, or as written when it cannot be followed (a folder not made yet). */
function realOrResolved(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

/** ORRERY_CONFIG, then <home>/config.toml, then the server path. */
export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
	if (env.ORRERY_CONFIG) return env.ORRERY_CONFIG;
	const home = join(orreryHome(env), "config.toml");
	if (existsSync(home)) return home;
	return DEFAULT_CONFIG_PATH;
}

export function loadConfig(file: string = defaultConfigPath()): HarnessConfig {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		throw noConfigError(file, error, process.env);
	}
	return { ...parseConfig(text, dirname(resolve(file))), file: resolve(file) };
}

/** A failed read of the config `file`: when neither <home>/config.toml nor the server path exists, where Orrery looks. */
function noConfigError(file: string, error: unknown, env: NodeJS.ProcessEnv): unknown {
	if (file === DEFAULT_CONFIG_PATH && (error as { code?: unknown }).code === "ENOENT" && !env.ORRERY_CONFIG) {
		return Object.assign(new Error(`no Orrery config at ${join(orreryHome(env), "config.toml")}; run orrery to set one up`), { code: "ENOENT" });
	}
	return error;
}

/** Where a new config goes: $ORRERY_CONFIG, else <home>/config.toml. */
export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
	return env.ORRERY_CONFIG || join(orreryHome(env), "config.toml");
}

/**
 * A config file as one read found it (readConfigFile): the config a command runs with, never read again (a file read
 * twice may change between), and the file it may write that config back to (editConfigOnce, src/agent/config-edit.ts).
 */
export interface ConfigFile {
	/** The file read, absolute (links kept, as HarnessConfig.file); when none was there, where a new one goes. */
	readonly path: string;
	/** What it held, and its text; absent when it could not be read or loaded (`error` says why). */
	readonly config?: HarnessConfig;
	readonly text?: string;
	/** The file itself, as it was read; absent when there was none to read. */
	readonly id?: FileId;
	readonly error?: unknown;
	/**
	 * Whether a write must find the file as it was read (src/agent/config-edit.ts writeConfigOnce): set by the gate when
	 * it found a coding tool's session (src/cli/gate.ts), where another process may swap the file in between. Else (the
	 * user's own terminal, or a path read here) a write reads the file's text again and keeps what others wrote, as 0.9.0.
	 */
	readonly checked?: boolean;
	/**
	 * Set when there is no config to read and no place for one: none named (--config, ORRERY_CONFIG), and an ORRERY_HOME
	 * that is no absolute path (`error` says so). `path` (the server path's) is then no file to read or write in its
	 * place: the gate hands such a file to no command (src/cli/gate.ts), and writeConfigOnce refuses it.
	 */
	readonly unplaced?: true;
}

/** A file as it was read: its real path, device and inode, and its size and times (`stamp`), which any write changes. */
export interface FileId {
	readonly real: string;
	readonly dev: bigint;
	readonly ino: bigint;
	readonly stamp: string;
}

/** A file's size and its modification and change times, to the nanosecond: a write changes them, and none can set back the change time. */
export const fileStamp = (stats: BigIntStats): string => `${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;

/**
 * Reads the config a command runs with, once: `file` (--config), else the default (defaultConfigPath); when there is
 * none, where a new one goes instead (`file`, else userConfigPath). The text, and the file's identity, come from one
 * open: the path must still lead to the file read when the read is done, or nothing was read. Never throws: with no
 * default to read (an ORRERY_HOME that is no absolute path) it says why, and that the config has no place (`unplaced`).
 */
export function readConfigFile(file: string | undefined, env: NodeJS.ProcessEnv = process.env): ConfigFile {
	let named: string;
	try {
		named = file ?? defaultConfigPath(env);
	} catch (error) {
		return { path: DEFAULT_CONFIG_PATH, error, unplaced: true };
	}
	const path = resolve(named);
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch (error) {
		if ((error as { code?: unknown }).code !== "ENOENT") return { path, error };
		let fresh = path;
		try {
			fresh = resolve(file ?? userConfigPath(env));
		} catch {
			// an ORRERY_HOME that is no absolute path: the path looked at stands
		}
		return { path: fresh, error: noConfigError(named, error, env) };
	}
	let text: string;
	let id: FileId;
	try {
		text = readFileSync(fd, "utf8");
		// Its size and times once read to the end: a write before then is in the text.
		const read = fstatSync(fd, { bigint: true });
		const real = realpathSync(path);
		const there = statSync(real, { bigint: true });
		if (there.dev !== read.dev || there.ino !== read.ino) return { path, error: new Error(`${path} was replaced while Orrery read it; run the command again.`) };
		id = { real, dev: read.dev, ino: read.ino, stamp: fileStamp(read) };
	} catch (error) {
		return { path, error };
	} finally {
		closeSync(fd);
	}
	try {
		return { path, text, id, config: { ...parseConfig(text, dirname(path)), file: path } };
	} catch (error) {
		return { path, text, id, error };
	}
}

/** A config as a command is given it: the file the gate read (ConfigFile, src/cli/gate.ts), or a path to read once. */
export type ConfigSource = ConfigFile | string | undefined;

/** The config file `source` names, read once (readConfigFile) when it is a path. */
export const configFileOf = (source: ConfigSource, env: NodeJS.ProcessEnv = process.env): ConfigFile => (typeof source === "object" ? source : readConfigFile(source, env));

/** The config `file` holds; when it holds none, why (its read's error). */
export function configOf(file: ConfigFile): HarnessConfig {
	if (file.config === undefined) throw file.error ?? new ConfigError(`${file.path} holds no config`);
	return file.config;
}

/** Whether `file` was not there when read (and nothing else kept it from being read). */
export const configAbsent = (file: ConfigFile): boolean => file.id === undefined && (file.error as { code?: unknown } | undefined)?.code === "ENOENT";

/**
 * Whether `file` is still as it was read: its path leads to the same file (real path, device and inode), written by
 * none since (stamp); when none was there, still none. Only then may a command write it back (editConfigOnce).
 */
export function unchangedConfig(file: ConfigFile): boolean {
	if (file.id === undefined) return configAbsent(file) && !existsSync(file.path);
	try {
		if (realpathSync(file.path) !== file.id.real) return false;
		const now = statSync(file.id.real, { bigint: true });
		return now.dev === file.id.dev && now.ino === file.id.ino && fileStamp(now) === file.id.stamp;
	} catch {
		return false;
	}
}

/**
 * Whether `reader` may read `agent`'s memory: itself always, else what its `reads` names (or "*", every agent). The
 * memory tools (src/agent/memory-tools.ts) and the CLI inside a session (src/cli/gate.ts) both ask here.
 */
export function mayRead(reader: AgentConfig, agent: AgentConfig): boolean {
	return reader.reads.includes("*") || reader.reads.includes(agent.name) || agent.name === reader.name;
}

/** Who reads `name`'s memory: the agents listing it by name, and (apart) the agents that read every agent. */
export function readBy(config: HarnessConfig, name: string): { readonly names: readonly string[]; readonly everyone: readonly string[] } {
	const others = [...config.agents.values()].filter((agent) => agent.name !== name);
	return {
		names: others.filter((agent) => agent.reads.includes(name) && !agent.reads.includes("*")).map((agent) => agent.name),
		everyone: others.filter((agent) => agent.reads.includes("*")).map((agent) => agent.name),
	};
}

/** Finds an agent by name, ignoring case; an exact match wins. Throws ConfigError listing the agents otherwise. */
export function findAgent(config: HarnessConfig, name: string): AgentConfig {
	const exact = config.agents.get(name);
	if (exact !== undefined) return exact;
	const matches = [...config.agents.values()].filter((agent) => agent.name.toLowerCase() === name.toLowerCase());
	if (matches.length === 1) return matches[0];
	const names = [...config.agents.keys()].join(", ") || "none";
	if (matches.length > 1) throw new ConfigError(`Agent name ${name} is ambiguous. Configured agents: ${names}`);
	throw new ConfigError(`No agent named ${name}. Configured agents: ${names}`);
}
