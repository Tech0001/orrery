/** orrery configuration: one TOML file describing data paths, custom model servers, SSH hosts and lanes. */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, isAbsolute, join, posix, resolve } from "node:path";
import { parse } from "smol-toml";
import { type MemoryConfig, memoryConfig } from "../memory/index.ts";
import { ConfigError, orreryHome } from "./home.ts";

export { ConfigError };

export const DEFAULT_CONFIG_PATH = "/etc/orrery/config.toml";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** The tools a lane is launched in (the `tool` key). */
export const LANE_TOOLS = ["pi", "claude-code", "codex", "omp"] as const;
export type LaneLauncher = "direct" | "ori";
export type LaneTool = (typeof LANE_TOOLS)[number];

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

/** Where a lane's memory lives when it is not on this machine only (spec 2026-10-12-remote-lanes-design §4). */
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

export interface LaneConfig {
	readonly name: string;
	readonly dir: string;
	readonly host: HostConfig;
	/**
	 * The lane's default folder: where the TUI opens it, and how a session started in it finds it (src/lane/pick.ts).
	 * Absent: the lane opens only by name (ORRERY_AGENT), in whatever folder it is opened.
	 */
	readonly workspace?: string;
	readonly allowedRoots: readonly string[];
	/** The tool the lane is launched in; undefined when the config does not say (the TUI then guesses). */
	readonly tool?: LaneTool;
	/** Absent in older callers means direct. Parsed configs always supply the default. */
	readonly launcher?: LaneLauncher;
	readonly oriModel?: string;
	/** The agent model only `orrery run` uses; pi and Claude Code pick their own. */
	readonly model?: ModelChoice;
	/** contextBytes: the top of each summary call's view (compactor_context_bytes; default 32,000, floor half). */
	readonly compactor: { readonly model: ModelChoice; readonly jobs: number; readonly contextBytes?: number };
	/** The Orrery mod compacts the Claude Code conversation past this many tokens (compact_at; default 200,000). */
	readonly compactAt: number;
	readonly memory: MemoryConfig;
	readonly reads: readonly string[];
	/** The remote holding this lane's memory; absent = this machine only. */
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
	readonly lanes: ReadonlyMap<string, LaneConfig>;
	readonly updates: { readonly check: boolean };
}

type Table = Record<string, unknown>;
const LOCAL_HOST: HostConfig = { name: "local", kind: "local" };
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

/** Words `orrery agent` takes as subcommands: no lane may be named one of them (compared without case). */
export const RESERVED_NAMES: readonly string[] = ["add", "set", "edit", "archive", "push", "pull", "takeover", "local"];

const reserved = (name: string) => `${name} is a word orrery agent uses (${RESERVED_NAMES.join(", ")})`;

/** Why `name` cannot name a lane, or undefined when it can. */
export function laneNameProblem(name: string): string | undefined {
	if (!NAME.test(name)) return "Lane names use letters, digits, - and _ (at most 32), starting with a letter.";
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

/** Where the Orrery mod compacts a Claude Code conversation, in tokens (lane key compact_at; spec 2026-10-08-claude-code-mod §4.5). */
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
		return {
			id: str(t, "id", where),
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

export function parseConfig(text: string, configDir: string): HarnessConfig {
	let root: Table;
	try {
		root = parse(text) as Table;
	} catch (error) {
		throw new ConfigError(`config is not valid TOML: ${(error as Error).message}`);
	}
	const dataDir = path(typeof root.data_dir === "string" ? root.data_dir : configDir, configDir);
	const providers = parseProviders(root.providers);
	const hosts = parseHosts(root.hosts, dataDir);
	const remotes = parseRemotes(root.remotes, hosts);
	const updates = table(root.updates, "updates");
	if (updates.check !== undefined && typeof updates.check !== "boolean") throw new ConfigError("updates.check must be true or false");
	const lanes = new Map<string, LaneConfig>();
	for (const [name, value] of Object.entries(table(root.lanes, "lanes"))) {
		const where = `lanes.${name}`;
		if (!NAME.test(name)) throw new ConfigError(`${where}: lane names use letters, digits, - and _ (max 32)`);
		if (RESERVED_NAMES.includes(name.toLowerCase())) {
			throw new ConfigError(`${where}: ${reserved(name)}; rename the lane, and its folder ${join(dataDir, "lanes", name)} to the same name, or it starts without its memory`);
		}
		const t = table(value, where);
		const hostName = str(t, "host", where, "local");
		const host = hosts.get(hostName);
		if (host === undefined) throw new ConfigError(`${where}: unknown host "${hostName}"`);
		const workspace = optStr(t, "workspace", where);
		if (workspace !== undefined && !posix.isAbsolute(workspace)) throw new ConfigError(`${where}.workspace must be absolute`);
		if (workspace === undefined && host.kind !== "local") throw new ConfigError(`${where}: a lane on an SSH host needs a workspace`);
		// Before agents, this named a file in the workspace; now the lane's own folder holds them (src/lane/instructions.ts).
		if (t.instructions !== undefined) {
			throw new ConfigError(`${where}.instructions is no longer read: ${name}'s instructions live in ${join(dataDir, "lanes", name, "instructions.md")}; move them there and remove this key`);
		}
		const modelRef = optStr(t, "model", where);
		const model = modelRef === undefined ? undefined : parseModelChoice(modelRef, str(t, "thinking", where, "medium"), `${where}.model`);
		const compactorRef = t.compactor_model === undefined && model !== undefined ? `${model.provider}/${model.modelId}` : str(t, "compactor_model", where);
		const tool = optStr(t, "tool", where);
		if (tool !== undefined && !(LANE_TOOLS as readonly string[]).includes(tool)) throw new ConfigError(`${where}.tool must be one of ${LANE_TOOLS.join(", ")}`);
		const launcher = str(t, "launcher", where, "direct");
		if (launcher !== "direct" && launcher !== "ori") throw new ConfigError(`${where}.launcher must be one of direct, ori`);
		const oriModel = optStr(t, "ori_model", where);
		if (oriModel !== undefined && /[\s\p{Cc}]/u.test(oriModel)) throw new ConfigError(`${where}.ori_model must have no whitespace or control characters`);
		const roots = t.allowed_roots;
		if (roots !== undefined && (!Array.isArray(roots) || roots.some((r) => typeof r !== "string" || !posix.isAbsolute(r)))) {
			throw new ConfigError(`${where}.allowed_roots must be an array of absolute paths`);
		}
		const reads = t.reads ?? [];
		if (!Array.isArray(reads) || reads.some((r) => typeof r !== "string")) throw new ConfigError(`${where}.reads must be an array of lane names or ["*"]`);
		const contextBytes = t.compactor_context_bytes === undefined ? undefined : int(t, "compactor_context_bytes", where);
		if (contextBytes !== undefined && contextBytes < 2000) throw new ConfigError(`${where}.compactor_context_bytes must be at least 2000`);
		const remote = optStr(t, "remote", where);
		if (remote !== undefined && !remotes.has(remote)) throw new ConfigError(`${where}: unknown remote "${remote}"`);
		const compactAt = int(t, "compact_at", where, COMPACT_AT_DEFAULT);
		if (compactAt < COMPACT_AT_MIN) throw new ConfigError(`${where}.compact_at must be at least ${COMPACT_AT_MIN}`);
		lanes.set(name, {
			name,
			dir: join(dataDir, "lanes", name),
			host,
			...(workspace === undefined ? {} : { workspace }),
			allowedRoots: (roots as string[] | undefined) ?? (workspace === undefined ? [] : [posix.dirname(workspace)]),
			launcher,
			...(oriModel === undefined ? {} : { oriModel }),
			...(tool === undefined ? {} : { tool: tool as LaneTool }),
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
	for (const lane of lanes.values()) {
		for (const name of lane.reads) {
			if (name !== "*" && !lanes.has(name)) throw new ConfigError(`lanes.${lane.name}.reads names unknown lane ${name}`);
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
		lanes,
		updates: { check: updates.check !== false },
	};
}

/** A lane with a default folder: the only kind a folder can find. */
type Rooted = { readonly workspace: string };
const rooted = <T extends { readonly workspace?: string }>(lane: T): lane is T & Rooted => lane.workspace !== undefined;

/**
 * The lane whose workspace is cwd or contains it; the deepest workspace wins. Paths are compared with symlinks followed:
 * pi and Claude Code report the physical folder, and a workspace may be configured through a symlink (on macOS, /tmp and
 * /var are links into /private), even one that points inside another lane's workspace. Only when that finds no lane are
 * the paths compared as written (a folder not made yet). A lane without a workspace is never found by folder.
 */
export function laneForCwd(config: HarnessConfig, cwd: string): LaneConfig | undefined {
	const lanes = [...config.lanes.values()].filter(rooted);
	const roots = lanes.map(realRoot);
	const here = resolve(cwd);
	// A cwd that is a workspace's real path is physical already: no realpath call for it.
	const physical = roots.includes(here) ? here : realOrResolved(here);
	return deepest(lanes, roots, physical) ?? deepest(lanes, lanes.map((lane) => resolve(lane.workspace)), here);
}

/**
 * Whether `dir` is the lane's workspace or inside it, compared as laneForCwd compares: symlinks followed, else as
 * written. False for a lane without a workspace.
 */
export function inWorkspace(lane: { readonly workspace?: string }, dir: string): boolean {
	if (!rooted(lane)) return false;
	const here = resolve(dir);
	return holds(realRoot(lane), realOrResolved(here)) || holds(resolve(lane.workspace), here);
}

/** Whether `here` is `root` or inside it. */
const holds = (root: string, here: string) => here === root || here.startsWith(`${root}/`);

function deepest(lanes: LaneConfig[], roots: string[], here: string): LaneConfig | undefined {
	let best: number | undefined;
	for (let i = 0; i < lanes.length; i++) {
		const root = roots[i];
		if (holds(root, here) && (best === undefined || root.length > roots[best].length)) best = i;
	}
	return best === undefined ? undefined : lanes[best];
}

/**
 * Each lane's workspace with symlinks followed, kept once found (a link changed later counts once the config is loaded
 * again). A workspace not made yet is tried again on the next call.
 */
const realRoots = new WeakMap<Rooted, string>();

function realRoot(lane: Rooted): string {
	const known = realRoots.get(lane);
	if (known !== undefined) return known;
	try {
		const real = realpathSync(lane.workspace);
		realRoots.set(lane, real);
		return real;
	} catch {
		return resolve(lane.workspace);
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
		// Neither <home>/config.toml nor the server path exists: say where Orrery looks, not the server path alone.
		if (file === DEFAULT_CONFIG_PATH && (error as { code?: unknown }).code === "ENOENT" && !process.env.ORRERY_CONFIG) {
			throw Object.assign(new Error(`no Orrery config at ${join(orreryHome(), "config.toml")}; run orrery to set one up`), { code: "ENOENT" });
		}
		throw error;
	}
	return parseConfig(text, dirname(resolve(file)));
}

/** Finds a lane by name, ignoring case; an exact match wins. Throws ConfigError listing the lanes otherwise. */
export function findLane(config: HarnessConfig, name: string): LaneConfig {
	const exact = config.lanes.get(name);
	if (exact !== undefined) return exact;
	const matches = [...config.lanes.values()].filter((lane) => lane.name.toLowerCase() === name.toLowerCase());
	if (matches.length === 1) return matches[0];
	const names = [...config.lanes.keys()].join(", ") || "none";
	if (matches.length > 1) throw new ConfigError(`Lane name ${name} is ambiguous. Configured lanes: ${names}`);
	throw new ConfigError(`No lane named ${name}. Configured lanes: ${names}`);
}
