/**
 * The CLI's gate (spec 2026-10-18-agent-permissions-design §2, §3). Before a command runs, `orrery` asks whether it runs
 * inside an agent's session (src/agent/sessions.ts). Inside one it runs only ALLOWED_INSIDE
 * (src/agent/inside-commands.ts), within the session agent's `reads`. Everything that writes memory, changes settings,
 * touches logins or remotes, or starts a session is refused there, with where to run it instead. Outside every session
 * nothing changes.
 *
 * Which records judge: the loaded config's data folder, and the default home ($ORRERY_HOME, and ~/.orrery under $HOME
 * when that differs). So a command run with a scratch ORRERY_HOME or ORRERY_CONFIG still finds the real sessions. A
 * config that can't be read leaves the default home and the markers to decide.
 *
 * Which config rules inside a session: the one that holds the session's memory (trustedConfig: the file the session's
 * record names, which its host loaded; with none, the config in the home that is its data folder, or the server path's),
 * never the one the caller names, which is anyone's to write. Its `reads` is what the commands run there honour. A
 * command whose --config, ORRERY_CONFIG or ORRERY_HOME leads to another config is refused; so is every command but help
 * and the version when that config can't be found or read.
 *
 * Identity inside a session comes only from the session's record, or a token that proves it: never from ORRERY_AGENT,
 * --cwd, CLAUDE_PID or the arguments. "." is that agent. A session whose agent nothing proves runs only help and the
 * version.
 *
 * The plugins' commands:
 * - claude-hook and codex-hook never come here. They run on every tool call, and their own per-process decision governs
 *   them (src/claude/pick.ts, src/codex/pick.ts).
 * - mcp, claude-mod and holder are started by a tool for its own session, maybe before that tool recorded itself (the
 *   MCP server is its process's first decider). Markers that are that tool's own launch's (an ORRERY_AGENT whose token
 *   nobody claimed yet, a CLAUDE_PID naming the tool) are no session around it. So a session found only by markers is
 *   asked again with the tool as `self`: the parent (orrery-run execs), Codex's pid, or the holder's --claude-pid or
 *   --host-pid. When the markers all point at that tool and it is a recorded session's host, its record is the identity.
 * - Inside a session they serve only its agent: mcp under another ORRERY_AGENT, and a holder for another agent, are
 *   refused; claude-mod gives that agent's view or none (src/claude/mod-view.ts).
 *
 * A session found only by markers (no recorded ancestor) names them, and points the person to the docs ("Leftover
 * markers"): a tmux server first started from an agent's shell hands its markers to every pane opened later. It gives
 * no recipe for clearing them, since a detached or sandboxed agent process sees the same message. Codex's sandboxed
 * shell, in a pid namespace of its own, is always such a session, and its agent can't be told.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type AgentConfig, DEFAULT_CONFIG_PATH, defaultConfigPath, type HarnessConfig, loadConfig, mayRead } from "../agent/config.ts";
import { orreryHome } from "../agent/home.ts";
import { ALLOWED_INSIDE } from "../agent/inside-commands.ts";
import { AGENT_ENV, agentNamed, TOKEN_ENV } from "../agent/pick.ts";
import { HOST_ENV, type Inside, insideSession, liveSession, type SessionDeps, TOOL_NAMES } from "../agent/sessions.ts";
import { safeText } from "../agent/source-labels.ts";
import { codexPid } from "../codex/host.ts";

/** A command refused inside an agent's session: its message goes to stderr, and the exit status is 1. */
export class GateRefusal extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GateRefusal";
	}
}

/** The command line's options, as parseArgs reads them. */
export type GateValues = Readonly<Record<string, string | boolean | readonly string[] | undefined>>;

/** What the gate asks of the system; each defaults to the real one (tests give fakes). */
export interface GateDeps {
	readonly insideSession?: typeof insideSession;
	readonly liveSession?: typeof liveSession;
	/** This process's parent (default process.ppid): the tool that started an MCP server or the mod's view. */
	readonly parent?: number;
	/** Codex's process, for its MCP server (default codexPid from the parent). */
	readonly codexPid?: () => number;
	/** How processes are read (src/agent/sessions.ts). */
	readonly sessions?: SessionDeps;
}

/** The markers, in the order a refusal names them (src/agent/sessions.ts reads them). */
const MARKERS = [AGENT_ENV, TOKEN_ENV, HOST_ENV, "CLAUDE_PID", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "OPENCODE_CONFIG_CONTENT"] as const;
const CODEX_IDS: readonly string[] = ["CODEX_THREAD_ID", "CODEX_SESSION_ID"];

const UNKNOWN = "orrery can't tell which agent's session this is, so inside it only help and the version run.";
const NO_CONFIG = "orrery can't read the config that holds this session's memory, so inside it only help and the version run.";
const CONFIG_CHANGED = "--config and ORRERY_CONFIG can't be changed inside an agent session.";
const HOME_CHANGED = "ORRERY_HOME can't be changed inside an agent session.";

/** What the gate lets run: outside every session nothing; inside one, the session and its config (module doc). */
export interface Gated {
	readonly inside?: Inside;
	/** Inside a session: the config that holds the session's memory, which every command run there must use. */
	readonly config?: HarnessConfig;
}

/**
 * Runs before every command but the hooks (src/cli/main.ts): `{}` outside every session; inside one, the session and the
 * config that holds its memory, when `command` may run there with these arguments. Throws GateRefusal otherwise.
 * `positionals` holds the command first.
 */
export function gateCommand(command: string | undefined, positionals: readonly string[], values: GateValues, env: NodeJS.ProcessEnv, deps: GateDeps = {}): Gated {
	if (command === "claude-hook" || command === "codex-hook") return {};
	if (command === "help" || command === "version") return {};
	// The caller's config only says where else to look for sessions, and which data folder its markers belong to: a config
	// is anyone's to write, so inside a session it decides nothing (trustedConfig).
	const given = readConfig(values, env);
	const look = deps.insideSession ?? insideSession;
	const dirs = dataDirs(given, env);
	let asked = deps.sessions ?? {};
	let inside = look(dirs, env, given, asked);
	const host = hostOf(command, values, deps);
	if (inside?.via === "marker" && host !== undefined) {
		asked = { ...asked, self: host };
		inside = look(dirs, env, given, asked) ?? hostRecord(dirs, host, deps);
	}
	if (inside === undefined) return {};
	const note = inside.via === "marker" ? markerNote(markersFound(look, env, given, asked)) : "";
	const refused = (message: string) => new GateRefusal(`${message}${note}`);
	if (inside.agent === undefined) throw refused(UNKNOWN);
	const trusted = trustedConfig(inside);
	const config = trusted?.config;
	const agent = (config === undefined ? undefined : agentNamed(config, inside.agent)?.name) ?? safeText(inside.agent);
	const session = inside.tool === undefined ? agent : `${agent}, ${TOOL_NAMES[inside.tool]}`;
	const changes = (label: string) => refused(`${label} can't run inside an agent session (${session}): agents can't change memory or settings. Run it in your own terminal or the TUI.`);
	if (command === undefined) throw changes("orrery's TUI");
	if (!ALLOWED_INSIDE.has(command)) throw changes(`orrery ${command}`);
	if (trusted === undefined || config === undefined) throw refused(NO_CONFIG);
	// The config the command would load must be that file: --config, else ORRERY_CONFIG, else ORRERY_HOME's or the default.
	const chosen = typeof values.config === "string" ? values.config : env.ORRERY_CONFIG || undefined;
	if (real(chosen ?? defaultConfigPath(env)) !== real(trusted.path)) throw refused(chosen === undefined && env.ORRERY_HOME ? HOME_CHANGED : CONFIG_CHANGED);
	// And an ORRERY_HOME beside it may hold no other config.
	if (env.ORRERY_HOME) {
		let home: string;
		try {
			home = orreryHome(env);
		} catch {
			throw refused(HOME_CHANGED);
		}
		const own = real(join(home, "config.toml"));
		if (own !== undefined && own !== real(trusted.path)) throw refused(HOME_CHANGED);
	}
	/** The agent a name given on the command line stands for, as the config spells it; "." is the session's. */
	const named = (name: string) => (name === "." ? agent : (agentNamed(config, name)?.name ?? name));
	const only = (label: string, other: string) => refused(`${label} serves only this session's agent, ${agent}, not ${other}.`);
	const target = positionals[1];
	switch (command) {
		case "browse":
		case "status":
		case "usage": {
			// --out writes over any file the user may write, the config and memory among them; the page's own place stays.
			if (command === "browse" && values.out !== undefined) throw changes("orrery browse --out");
			const other = target === undefined || target === "." ? undefined : agentNamed(config, target);
			// A name the config lacks is the command's own error to give.
			if (other !== undefined && !readableBy(config, agent)(other)) throw refused(readsFix(config, agent, other.name));
			break;
		}
		case "compactor":
			if (target !== undefined && named(target) !== agent) throw changes(`orrery compactor ${target}`);
			break;
		case "mcp": {
			const given = env[AGENT_ENV]?.trim();
			if (given && named(given) !== agent) throw only("orrery mcp", named(given));
			break;
		}
		case "holder":
			if (target !== undefined && named(target) !== agent) throw only("orrery holder", named(target));
			break;
	}
	return { inside, config };
}

/** A path with its links resolved, or undefined when it can't be (it isn't there). */
function real(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

/**
 * The config that holds a session's memory. Never one the caller names (--config, ORRERY_CONFIG, ORRERY_HOME, HOME): a
 * config is anyone's to write, and one naming the real data folder with `reads = ["*"]` would otherwise read every
 * agent.
 * - The one the session's record names (SessionRecord.config): the file its host loaded. Records live in the data
 *   folder, out of the agent's reach.
 * - With no record naming one (a session only a token proves, or a host that loaded no file): the one in the Orrery home
 *   that is the data folder (<home>/config.toml, whose data folder is <home> unless data_dir moves it; src/agent/home.ts,
 *   defaultConfigPath), else the server path's.
 * Each counts only when it loads and names that data folder; else none, and only help and the version run.
 */
function trustedConfig(inside: Inside): { readonly path: string; readonly config: HarnessConfig } | undefined {
	const folder = real(inside.dataDir);
	if (folder === undefined) return undefined;
	const candidates = inside.config !== undefined ? [inside.config] : [join(folder, "config.toml"), DEFAULT_CONFIG_PATH];
	for (const path of candidates) {
		try {
			const config = loadConfig(path);
			if (real(config.dataDir) === folder) return { path, config };
		} catch {
			// none there, or none that loads
		}
	}
	return undefined;
}

/** Whether `reader` (an agent's name) may read an agent: itself always, the others as its `reads` says (none when the config lacks it). */
export function readableBy(config: HarnessConfig, reader: string): (agent: AgentConfig) => boolean {
	const self = agentNamed(config, reader);
	return (agent) => agent.name === (self?.name ?? reader) || (self !== undefined && mayRead(self, agent));
}

/** The refusal of a read `reader` may not make, with the fix: its reads so far, and `other`. */
function readsFix(config: HarnessConfig, reader: string, other: string): string {
	const reads = (agentNamed(config, reader)?.reads ?? []).filter((name) => name !== "*" && name !== other);
	return `${reader} may not read ${other}. Allow it in the TUI (C, Reads) or with: orrery agent set ${reader} --reads ${[...reads, other].join(",")}`;
}

/** The config the command would load (--config, else ORRERY_CONFIG, else the default), or undefined when it can't be read. */
function readConfig(values: GateValues, env: NodeJS.ProcessEnv): HarnessConfig | undefined {
	try {
		return loadConfig(typeof values.config === "string" ? values.config : defaultConfigPath(env));
	} catch {
		return undefined;
	}
}

/** The data folders whose records judge a command: the config's, $ORRERY_HOME, and ~/.orrery under $HOME. */
function dataDirs(config: HarnessConfig | undefined, env: NodeJS.ProcessEnv): string[] {
	const dirs = config === undefined ? [] : [config.dataDir];
	try {
		dirs.push(orreryHome(env));
	} catch {
		// an ORRERY_HOME that is no absolute path: the home under $HOME still counts
	}
	dirs.push(join(env.HOME || homedir(), ".orrery"));
	return dirs;
}

/** The tool that started one of the plugins' commands for its own session (module doc), or undefined for any other. */
function hostOf(command: string | undefined, values: GateValues, deps: GateDeps): number | undefined {
	const parent = deps.parent ?? process.ppid;
	if (command === "mcp") return values.tool === "codex" ? (deps.codexPid ?? (() => codexPid(parent)))() : parent;
	if (command === "claude-mod") return parent;
	if (command === "holder") {
		const pid = Number(values["host-pid"] ?? values["claude-pid"]);
		return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
	}
	return undefined;
}

/** The session `host` itself hosts, from its live record in one of `dirs`. */
function hostRecord(dirs: readonly string[], host: number, deps: GateDeps): Inside | undefined {
	for (const dataDir of dirs) {
		const record = (deps.liveSession ?? liveSession)(dataDir, host, deps.sessions);
		if (record !== undefined) return { agent: record.agent, tool: record.tool, via: "ancestry", dataDir, ...(record.config === undefined ? {} : { config: record.config }) };
	}
	return undefined;
}

/** The markers in `env` that each say, alone, that there is a session; all those set when none does alone. */
function markersFound(look: typeof insideSession, env: NodeJS.ProcessEnv, config: HarnessConfig | undefined, deps: SessionDeps): string[] {
	const set = MARKERS.filter((key) => (env[key]?.trim() ?? "") !== "");
	const found = set.filter((key) => look([], { [key]: env[key] }, config, deps) !== undefined);
	return found.length > 0 ? found : set;
}

/** "A", "A and B", "A, B and C". */
const listed = (names: readonly string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** What a refusal adds for a session found only by markers: which, and how to clear them; for Codex's, why. */
function markerNote(names: readonly string[]): string {
	if (names.length === 0) return "";
	const codex = names.filter((name) => CODEX_IDS.includes(name));
	if (codex.length > 0) return ` This shell carries ${listed(codex)} from Codex, whose sandbox hides which agent's session it is.`;
	// No recipe here: a detached or sandboxed agent process gets this too. The docs say how to clear them.
	return ` The session is known only by ${listed(names)}. If this is your own terminal (a tmux server first started from an agent session keeps its markers), see "Leftover markers" in the docs.`;
}
