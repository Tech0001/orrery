/**
 * The CLI's gate (spec 2026-10-18-agent-permissions-design §2, §3). Before a command runs, `orrery` asks whether it runs
 * inside an agent's session (src/agent/sessions.ts). Inside one it runs only ALLOWED_INSIDE
 * (src/agent/inside-commands.ts), within the session agent's `reads`. Everything that writes memory, changes settings,
 * touches logins or remotes, or starts a session is refused there, with where to run it instead. Outside every session
 * nothing changes.
 *
 * Which records judge: the loaded config's data folder, the default home ($ORRERY_HOME, and ~/.orrery under $HOME when
 * that differs), and every file the command would touch (touchedPaths: each path option, the config file, and each path
 * the config names), each with every folder above it that holds session records (judgedFolders, src/agent/sessions.ts:
 * all of them, so a records folder planted nearer judges nothing away). So a command run with
 * a scratch HOME, ORRERY_HOME or ORRERY_CONFIG still finds the sessions of the real files it would read or write: a
 * crafted config's `credentials` naming the real logins, or a --out naming the real config. A config that can't be read
 * leaves the rest, the data folder each of those homes' own config names (one kept apart, data_dir), and the markers to
 * decide.
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
 *   asked again with the tool as `self`: the parent (orrery-run execs), or Codex's pid. When the markers all point at
 *   that tool and it is a recorded session's host, its record is the identity. A holder names its tool on its command
 *   line (--claude-pid, --host-pid), which is anyone's to write: it is taken only when that process is an ancestor of
 *   the holder (the hook that started it still runs, and SessionStart waits for the holder), or holds the claim of the
 *   holder's ORRERY_AGENT_TOKEN for the agent its record names.
 * - Inside a session they serve only its agent: mcp under another ORRERY_AGENT, and a holder for another agent, are
 *   refused; claude-mod gives that agent's view or none (src/claude/mod-view.ts). A holder whose session only markers
 *   found is refused under a coding tool that is not that session's host (toolAbove).
 *
 * A session found only by markers (no recorded ancestor) names them, and points the person to the docs ("Leftover
 * markers"): a tmux server first started from an agent's shell hands its markers to every pane opened later. It gives
 * no recipe for clearing them, since a detached or sandboxed agent process sees the same message. Codex's sandboxed
 * shell, in a pid namespace of its own, is always such a session, and its agent can't be told.
 *
 * Sessions that are no agent's (spec 2026-10-19-no-agent-sessions-design). A command no agent's session holds may still
 * run in a coding tool's session that is no agent's: a Claude Code or a Codex opened in another project (toolSession,
 * src/agent/sessions.ts: a coding tool above it, or a variable such a tool gives its shell). When any folder judged
 * (dataDirs) is in or under the user's real Orrery data (realOrreryData: the Orrery home under the home the password
 * database records for this user, never $HOME, the data folder its config keeps apart, and the server path's), such a
 * session runs only help, the version, status and usage, which show no agent and say why (noAgentText); every other
 * command, and the TUI, is refused. The refusal names the tool and its process, or the variable that found it: a
 * nested tool keeps its parents' variables, so no nearer tool is guessed, and a tmux server first started from a
 * tool's shell hands them to every pane (the docs' "Leftover markers"). A command touching only scratch homes is not
 * judged, so tests that run Orrery against scratch homes keep working in any session. No option or variable changes
 * which home is real: that would be the way around it.
 * - A session found by a record kept outside the real data folders (a scratch folder, where anyone may write a record
 *   naming their own tool) is judged the same way, as a session that is no agent's.
 * - The plugins' commands run for their own session, maybe before it is recorded. There, mcp and claude-mod serve only
 *   the agent their host's own launch names, its ORRERY_AGENT or its folder (hostAgent), and a holder runs only for a
 *   session shown to be its agent's and its own (holderVouched): never what anyone may give such a command by hand.
 * - Outside every session the command runs with the config the gate read and judged (Gated.config), never read again.
 *   In a coding tool's session one that writes the config writes the file the gate read, and only while it is unchanged
 *   since (Gated.configFile, checked); in the user's own terminal it writes as 0.9.0 did.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type AgentConfig, agentForCwd, type ConfigFile, DEFAULT_CONFIG_PATH, defaultConfigPath, type HarnessConfig, loadConfig, mayRead, parseConfig, readConfigFile } from "../agent/config.ts";
import { orreryHome, passwordHome } from "../agent/home.ts";
import { ALLOWED_INSIDE } from "../agent/inside-commands.ts";
import { AGENT_ENV, agentNamed, claimHeld, TOKEN_ENV } from "../agent/pick.ts";
import { pidNamespace, processCwd, processEnv } from "../agent/process.ts";
import { configPaths, ownConfig, realData, sameFolder, touchesReal } from "../agent/real-data.ts";
import {
	ancestors,
	HOST_ENV,
	type Inside,
	insideSession,
	judgedFolders,
	liveSession,
	processStart,
	realOrNone,
	recordedCodexIds,
	type SessionDeps,
	TOOL_NAMES,
	TOOL_SESSION_NAMES,
	type ToolSession,
	toolSession,
	toolSessionName,
} from "../agent/sessions.ts";
import { safeText } from "../agent/source-labels.ts";
import { codexPid } from "../codex/host.ts";

/** The user's real Orrery data, and whether a path is in a folder as the file system names them (src/agent/real-data.ts). */
export { realOrreryData, within } from "../agent/real-data.ts";

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
	/** The folder the command runs in (default process.cwd()): browse without --out and import --dry-run write there. */
	readonly cwd?: string;
	/** The coding tool's session lookup (src/agent/sessions.ts). */
	readonly toolSession?: typeof toolSession;
	/**
	 * The home whose Orrery data is the user's real data (realOrreryData). Default: the one the password database records
	 * for this user, never $HOME. Only a caller in this program gives it (tests): no option or variable reaches it.
	 */
	readonly realHome?: string;
	/** A process's working folder (default processCwd): an MCP server's or the mod view's host's (hostAgent). */
	readonly hostCwd?: (pid: number) => string | undefined;
	/** Named variables of the environment a process was started with (default processEnv): the host's (hostAgent). */
	readonly hostEnv?: (pid: number, names: readonly string[]) => Readonly<Record<string, string>> | undefined;
}

/** The markers, in the order a refusal names them (src/agent/sessions.ts reads them). */
const MARKERS = [AGENT_ENV, TOKEN_ENV, HOST_ENV, "CLAUDE_PID", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "OPENCODE_CONFIG_CONTENT"] as const;
const CODEX_IDS: readonly string[] = ["CODEX_THREAD_ID", "CODEX_SESSION_ID"];

const UNKNOWN = "orrery can't tell which agent's session this is, so inside it only help and the version run.";
const NO_CONFIG = "orrery can't read the config that holds this session's memory, so inside it only help and the version run.";
const CONFIG_CHANGED = "--config and ORRERY_CONFIG can't be changed inside an agent session.";
const HOME_CHANGED = "ORRERY_HOME can't be changed inside an agent session.";

/**
 * What the gate lets run, with the config the command runs with: outside every session the one it judged; inside one,
 * the session and its config; for status and usage in a coding tool's session that is no agent's, that session; for
 * mcp and claude-mod there, the one agent they may serve (module doc).
 */
export interface Gated {
	readonly inside?: Inside;
	/**
	 * The config every command that needs one runs with, never read again (a file read twice may change between): inside a
	 * session, the one that holds its memory; elsewhere, the one the gate read and judged.
	 */
	readonly config?: HarnessConfig;
	/** Elsewhere, when that config could not be read: why. A command that needs a config fails with it. */
	readonly configError?: unknown;
	/**
	 * Elsewhere, the file that config was read from, as it was read (src/agent/config.ts ConfigFile). In a coding tool's
	 * session (`checked`) a command that writes the config writes that file, and only while it is unchanged since
	 * (editConfigOnce, src/agent/config-edit.ts).
	 */
	readonly configFile?: ConfigFile;
	/** status and usage in a coding tool's session that is no agent's: they print noAgentText and nothing else. */
	readonly tool?: ToolSession;
	/** mcp and claude-mod in a coding tool's session that is no agent's: the only agent they may serve (hostAgent); null, none. */
	readonly hostAgent?: string | null;
	/**
	 * mcp serving no agent there for a reason (hostAgent's `why`): one line for stderr, `orrery: mcp serves no agent here:
	 * …`. Its client logs it, and the protocol on stdout stays clean, so a server that lists no tools says why.
	 */
	readonly notice?: string;
}

/**
 * Runs before every command but the hooks (src/cli/main.ts): outside every session, the config it read (or why it
 * couldn't); inside one, the session and the config that holds its memory, when `command` may run there with these
 * arguments; in a coding tool's session that is no agent's, what noAgentGate lets run. Throws GateRefusal otherwise.
 * `positionals` holds the command first.
 */
export function gateCommand(command: string | undefined, positionals: readonly string[], values: GateValues, env: NodeJS.ProcessEnv, deps: GateDeps = {}): Gated {
	if (command === "claude-hook" || command === "codex-hook") return {};
	if (command === "help" || command === "version") return {};
	// The caller's config only says where else to look for sessions, and which data folder its markers belong to: a config
	// is anyone's to write, so inside a session it decides nothing (trustedConfig). Elsewhere the command runs with it as
	// read here (Gated.config).
	const loaded = readConfig(values, env);
	const given = loaded.config;
	const look = deps.insideSession ?? insideSession;
	const dirs = dataDirs(command, given, values, env, deps.cwd ?? process.cwd());
	let asked = deps.sessions ?? {};
	let inside = look(dirs, env, given, asked);
	const host = hostOf(command, values, deps);
	const byMarkers = inside?.via === "marker";
	if (byMarkers && host !== undefined) {
		const record = hostRecord(dirs, host, deps);
		// A holder's host comes from its command line: taken only when vouched for (module doc); else the first look stands.
		if (command !== "holder" || vouched(host, record, env, deps)) {
			asked = { ...asked, self: host };
			inside = look(dirs, env, given, asked) ?? record;
		}
	}
	// A coding tool's session that is no agent's (module doc). With no session found the tool is asked for first: in the
	// user's own terminal there is none, and the real data is never looked up. A session whose record is kept outside the
	// real data folders (a scratch folder, where anyone may write a record) is judged the same way when a tool is found.
	const home = once(() => deps.realHome ?? passwordHome());
	const real = once(() => realData(home()));
	const found = inside;
	if (found === undefined || !real().some((root) => sameFolder(root, found.dataDir))) {
		const tool = noAgentTool(dirs, env, asked, deps);
		if (tool !== undefined && touchesReal(dirs, real())) return noAgentGate(command, values, env, tool, { loaded, dirs, host, home: home(), real: real(), target: positionals[1] }, deps);
		// A config read in a coding tool's session is written back only as it was read (ConfigFile.checked): it may be swapped
		// between the read and the write. The user's terminal writes as 0.9.0 did.
		if (found === undefined) return asLoaded(loaded, tool !== undefined);
	}
	if (inside === undefined) return asLoaded(loaded, true);
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
	let would: string;
	try {
		would = chosen ?? defaultConfigPath(env);
	} catch {
		// an ORRERY_HOME that is no absolute path
		throw refused(HOME_CHANGED);
	}
	if (realOrNone(would) !== trusted.real) throw refused(chosen === undefined && env.ORRERY_HOME ? HOME_CHANGED : CONFIG_CHANGED);
	// And an ORRERY_HOME beside it may hold no other config.
	if (env.ORRERY_HOME) {
		let home: string;
		try {
			home = orreryHome(env);
		} catch {
			throw refused(HOME_CHANGED);
		}
		const own = realOrNone(join(home, "config.toml"));
		if (own !== undefined && own !== trusted.real) throw refused(HOME_CHANGED);
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
		case "holder": {
			if (target !== undefined && named(target) !== agent) throw only("orrery holder", named(target));
			// No host to take (none named, or one hostOf drops: pid 1, a pid past the safe integers) is no host that vouches.
			const other = byMarkers ? toolAbove(host, inside, deps) : undefined;
			if (other !== undefined) throw new GateRefusal(noAgentRefusal("orrery holder", other));
			break;
		}
	}
	return { inside, config };
}

/**
 * For a holder whose session only its markers found: a coding tool above it that is not its session's own (module doc).
 * Its markers (a token, CLAUDE_PID) are in the environment of every process of that session, which any process of the
 * user's may read, and its host's pid is public; and a holder that finds its agent held marks the session read-only and
 * drops its pending events. So under a coding tool it runs only when that tool is its host (--claude-pid, --host-pid) and
 * its markers are all that host's own (the second look, with the host as itself, found no other session). With no host
 * (none named, or one hostOf drops) no tool is its host, so any coding tool above refuses. A holder its hook started
 * under its host is found by the host's record, never here; one the kernel reparented after its hook exited has no
 * coding tool above it, and runs; so does one whose tool is pid 1 (a container's), which no walk reaches.
 */
function toolAbove(host: number | undefined, inside: Inside, deps: GateDeps): ToolSession | undefined {
	const tool = (deps.toolSession ?? toolSession)({}, deps.sessions ?? {});
	if (tool === undefined || tool.via !== "ancestry") return undefined;
	return tool.pid !== host || inside.via === "marker" ? tool : undefined;
}

/**
 * The config that holds a session's memory. Never one the caller names (--config, ORRERY_CONFIG, ORRERY_HOME, HOME): a
 * config is anyone's to write, and one naming the real data folder with `reads = ["*"]` would otherwise read every
 * agent.
 * - The one the session's record names (SessionRecord.config): the file its host loaded, while its path still leads to
 *   the file it led to then (configReal), so a link re-pointed since swaps nothing in. Its text is read from that real
 *   file and read as the host read it, relative paths from the folder of the path it loaded. Records live in the data
 *   folder, out of the agent's reach.
 * - With no record naming one (a session only a token proves, or a host that loaded no file): the one in the Orrery home
 *   that is the data folder (<home>/config.toml, whose data folder is <home> unless data_dir moves it; src/agent/home.ts,
 *   defaultConfigPath), else the server path's.
 * Each counts only when it loads and names that data folder; else none, and only help and the version run. `real` is the
 * file a caller's config must resolve to.
 */
function trustedConfig(inside: Inside): { readonly real: string; readonly config: HarnessConfig } | undefined {
	const folder = realOrNone(inside.dataDir);
	if (folder === undefined) return undefined;
	const owns = (config: HarnessConfig) => realOrNone(config.dataDir) === folder;
	if (inside.config !== undefined) {
		if (inside.configReal === undefined || realOrNone(inside.config) !== inside.configReal) return undefined;
		try {
			const config = { ...parseConfig(readFileSync(inside.configReal, "utf8"), dirname(resolve(inside.config))), file: resolve(inside.config) };
			return owns(config) ? { real: inside.configReal, config } : undefined;
		} catch {
			return undefined;
		}
	}
	for (const path of [join(folder, "config.toml"), DEFAULT_CONFIG_PATH]) {
		try {
			const config = loadConfig(path);
			const file = realOrNone(path);
			if (owns(config) && file !== undefined) return { real: file, config };
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

/** `make`'s value, made the first time it is asked for. */
function once<T>(make: () => T): () => T {
	let made: { readonly value: T } | undefined;
	return () => (made ??= { value: make() }).value;
}

/**
 * The coding tool's session a command runs in (toolSession), which no agent's session holds. A Codex id that a record in
 * the folders judged (`dirs`) names is an agent's Codex session, no marker (recordedCodexIds, read only when one is set).
 */
function noAgentTool(dirs: readonly string[], env: NodeJS.ProcessEnv, sessions: SessionDeps, deps: GateDeps): ToolSession | undefined {
	const codex = CODEX_IDS.some((key) => (env[key] ?? "") !== "") ? { recordedCodexIds: recordedCodexIds(dirs, sessions) } : {};
	return (deps.toolSession ?? toolSession)(env, { ...sessions, ...codex });
}

/** What the gate knows of a command, for noAgentGate. */
interface Judged {
	readonly loaded: Loaded;
	readonly dirs: readonly string[];
	/** The plugin command's host (hostOf). */
	readonly host: number | undefined;
	/** The real home (passwordHome, or GateDeps.realHome). */
	readonly home: string | undefined;
	/** The real data (realOrreryData). */
	readonly real: readonly string[];
	/** The command's first argument: a holder's agent. */
	readonly target: string | undefined;
}

/**
 * The gate in a coding tool's session that is no agent's (module doc): status and usage get the session, to show no
 * agent; mcp and claude-mod the one agent their host's own launch names (hostAgent); a holder runs only for a session
 * shown to be its agent's and its own (holderVouched); every other command, and the TUI, is refused.
 */
function noAgentGate(command: string | undefined, values: GateValues, env: NodeJS.ProcessEnv, tool: ToolSession, judged: Judged, deps: GateDeps): Gated {
	if (command === "status" || command === "usage") return { ...asLoaded(judged.loaded, true), tool };
	if (command === "mcp" || command === "claude-mod") {
		const serves = hostAgent(command, values, env, tool, judged, deps);
		// The mod reads one JSON line: a refusal becomes its error, which says why (src/cli/main.ts). The MCP server lists
		// no tools, and says why on stderr (Gated.notice).
		if (command === "claude-mod" && serves.why !== undefined) throw new GateRefusal(serves.why);
		const notice = serves.why === undefined ? {} : { notice: `orrery: ${serves.why.replace(/^orrery /, "")}` };
		return { ...asLoaded(judged.loaded, true), hostAgent: serves.agent, ...notice };
	}
	if (command === "holder" && holderVouched(judged.target, env, judged, deps)) return asLoaded(judged.loaded, true);
	throw new GateRefusal(noAgentRefusal(command === undefined ? "orrery's TUI" : `orrery ${command}`, tool));
}

/**
 * The one agent mcp or claude-mod may serve in a coding tool's session that is no agent's: the one its host's own launch
 * names, never what the command itself was given (its folder, --cwd, ORRERY_AGENT and the mod's --agent are anyone's to
 * set). Its host (hostOf) must be the tool's own process, found by ancestry: a tool starts these for its own session, so
 * one run by hand from the tool's shell has the shell for its parent. Its config must be the user's own (ownConfigs):
 * a config names the agents' folders, and their data. Then:
 * - Under ORRERY_AGENT (the mod's --agent), that agent, when the host was started with the same ORRERY_AGENT and token,
 *   as `orrery agent` starts a tool, in its folder or elsewhere.
 * - Else by folder, as everywhere (agentForCwd): the agent of the host's working folder, when the command's own folder
 *   (an MCP server's CLAUDE_PROJECT_DIR or its folder, the mod's --cwd) names the same. A Claude Code started in an
 *   agent's folder starts its MCP server before its session is recorded: that server serves the agent.
 * null: none. `why` says why, when what the command was given differs from its host's, or its host or config is not
 * the session's own, or the host's launch can't be read; a folder of its own that names no agent is none, quietly (a
 * plain session's own MCP server and mod view), without asking the host's folder.
 */
function hostAgent(command: "mcp" | "claude-mod", values: GateValues, env: NodeJS.ProcessEnv, tool: ToolSession, judged: Judged, deps: GateDeps): { readonly agent: string | null; readonly why?: string } {
	const none = (why: string) => ({ agent: null, why: `orrery ${command} serves no agent here: ${why}` });
	const name = TOOL_SESSION_NAMES[tool.tool] ?? tool.tool;
	const host = judged.host;
	if (host === undefined || tool.via !== "ancestry" || host !== tool.pid) return none(`it was not started by this ${name} session's own process.`);
	const config = judged.loaded.config;
	if (config === undefined) return { agent: null };
	if (!ownConfig(config, judged.home)) return none("its config is not your Orrery home's.");
	const mod = command === "claude-mod";
	const agent = (mod && typeof values.agent === "string" ? values.agent : env[AGENT_ENV])?.trim();
	if (agent) {
		const token = mod && typeof values["agent-token"] === "string" ? values["agent-token"] : env[TOKEN_ENV];
		const launched = (deps.hostEnv ?? processEnv)(host, [AGENT_ENV, TOKEN_ENV]);
		if (launched === undefined) return none(`the environment this ${name} (process ${host}) was started with can't be read.`);
		if (launched[AGENT_ENV]?.trim() !== agent || launched[TOKEN_ENV] !== token) return none(`ORRERY_AGENT is not the one this ${name} (process ${host}) was started with.`);
		return { agent: agentNamed(config, agent)?.name ?? null };
	}
	const cwd = deps.cwd ?? process.cwd();
	const own = mod ? (typeof values.cwd === "string" ? values.cwd : cwd) : env.CLAUDE_PROJECT_DIR || cwd;
	const ownPick = agentForCwd(config, own)?.name;
	// Its own folder no agent's: none either way, so the host's folder is not asked.
	if (ownPick === undefined) return { agent: null };
	const hostDir = (deps.hostCwd ?? processCwd)(host);
	const hostPick = hostDir === undefined ? undefined : agentForCwd(config, hostDir)?.name;
	if (ownPick === hostPick) return { agent: hostPick };
	const whose = (pick: string | undefined) => (pick === undefined ? "no agent's" : `${pick}'s`);
	return none(`its folder is ${whose(ownPick)}, and the folder of this ${name} (process ${host}) is ${whose(hostPick)}.`);
}

/** "a Claude Code session that is no agent's (process 4242)", "an OpenCode session that is no agent's (found OPENCODE)". */
function noAgentSession(tool: ToolSession): string {
	const how = tool.via === "ancestry" ? `process ${tool.pid}` : `found ${tool.variable}`;
	return `${toolSessionName(tool.tool)} session that is no agent's (${how})`;
}

/** What a refusal found by a tool's variable adds: where the person reads more, as for an agent's markers (markerNote). */
const TOOL_MARKER_NOTE = ` If this is your own terminal (a tmux server first started from a coding tool's shell keeps its markers), see "Leftover markers" in the docs.`;

/** The refusal of `label` ("orrery browse", "orrery's TUI") in a coding tool's session that is no agent's. */
function noAgentRefusal(label: string, tool: ToolSession): string {
	const note = tool.via === "marker" ? TOOL_MARKER_NOTE : "";
	return `${label} can't run here: this is ${noAgentSession(tool)}, and those can't read or change Orrery's memory or settings. Run it in your own terminal or the TUI.${note}`;
}

/**
 * What `orrery status` and `orrery usage` print in a coding tool's session that is no agent's (Gated.tool), and nothing
 * else: one line saying so, or with --json no agents and the session's tool.
 */
export function noAgentText(command: "status" | "usage", tool: ToolSession, json: boolean): string {
	if (json) return `${JSON.stringify({ agents: [], session: { tool: tool.tool, noAgent: true } }, null, 2)}\n`;
	return `This is ${noAgentSession(tool)}, so it shows no agent. Run orrery ${command} in your own terminal or the TUI.\n`;
}

/** A config as read once (readConfigFile): the config, or why it couldn't be, and the file it came from. */
type Loaded = ConfigFile;

/** The config the command would load (--config, else ORRERY_CONFIG, else the default), read once, or why it can't be. */
const readConfig = (values: GateValues, env: NodeJS.ProcessEnv): Loaded => readConfigFile(typeof values.config === "string" ? values.config : undefined, env);

/**
 * What the gate hands a command that runs outside every session: the config it read, or why it couldn't, and its file;
 * `checked` when the gate found a coding tool's session (ConfigFile.checked): the file is then written back only as it
 * was read, so one swapped after the gate judged it is never written. In the user's own terminal it is written as 0.9.0 wrote it. A config with no place
 * (ConfigFile.unplaced: an ORRERY_HOME that is no absolute path) gives no file: a command that reads or writes it by
 * path fails with its error, as one that needs the config does.
 */
const asLoaded = (loaded: Loaded, checked: boolean): Gated => ({
	...(loaded.config !== undefined ? { config: loaded.config } : { configError: loaded.error }),
	...(loaded.unplaced === true ? {} : { configFile: { ...loaded, checked } }),
});

/**
 * What judges a command: the config's data folder, $ORRERY_HOME, ~/.orrery under $HOME, and each file the command would
 * touch (touchedPaths), since every one of those is the caller's to name. With no config to load (a --config naming
 * nothing), each of those homes' own config names the data folder too: one kept apart from its home (data_dir) holds the
 * session records. insideSession judges each with every folder above it that holds session records (judgedFolders,
 * src/agent/sessions.ts).
 */
function dataDirs(command: string | undefined, config: HarnessConfig | undefined, values: GateValues, env: NodeJS.ProcessEnv, cwd: string): string[] {
	const dirs = config === undefined ? [] : [config.dataDir];
	const homes: string[] = [];
	try {
		homes.push(orreryHome(env));
	} catch {
		// an ORRERY_HOME that is no absolute path: the home under $HOME still counts
	}
	homes.push(join(env.HOME || homedir(), ".orrery"));
	dirs.push(...homes);
	if (config === undefined) {
		for (const home of homes) {
			try {
				dirs.push(loadConfig(join(home, "config.toml")).dataDir);
			} catch {
				// none there, or none that loads
			}
		}
	}
	dirs.push(...touchedPaths(command, config, values, env, cwd));
	return [...new Set(dirs)];
}

/**
 * The options whose value names a file or folder (src/cli/main.ts OPTIONS): --config, restore's and install's --from
 * (agent pull's names a remote, judged all the same), browse's and import's --out, import's --commit, --claude,
 * --claude-file, --codex, --codex-file and --notes, compact's --progress, claude-mod's --cwd, agent's --folder, and
 * remote's --token-file and --code-file.
 */
const PATH_OPTIONS = ["config", "from", "out", "commit", "progress", "claude", "claude-file", "codex", "codex-file", "notes", "cwd", "folder", "token-file", "code-file"] as const;

/**
 * Every file or folder a command may read or write by what the caller gave it: each path option, the config file it
 * would load, and each path that config names (configPaths, src/agent/real-data.ts: its data folder, credentials,
 * device id and ssh folder, each SSH host's identity_file and known_hosts, each agent's data folder and the links in it,
 * folder, view file and allowed_roots); and the folder it runs in for the two commands that write there (browse without
 * --out, import --dry-run).
 */
function touchedPaths(command: string | undefined, config: HarnessConfig | undefined, values: GateValues, env: NodeJS.ProcessEnv, cwd: string): string[] {
	const paths: string[] = [];
	for (const key of PATH_OPTIONS) {
		const value = values[key];
		if (typeof value === "string") paths.push(value);
		else if (Array.isArray(value)) paths.push(...value);
	}
	try {
		paths.push(defaultConfigPath(env));
	} catch {
		// an ORRERY_HOME that is no absolute path: no default config (readConfigFile's `unplaced`)
	}
	if ((command === "browse" && values.out === undefined) || (command === "import" && values["dry-run"] === true)) paths.push(cwd);
	if (config !== undefined) paths.push(...configPaths(config));
	return paths;
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

/** The session `host` itself hosts, from its live record in one of `dirs` or a folder above one (judgedFolders). */
function hostRecord(dirs: readonly string[], host: number, deps: GateDeps): Inside | undefined {
	for (const dataDir of judgedFolders(dirs)) {
		const record = (deps.liveSession ?? liveSession)(dataDir, host, deps.sessions);
		if (record === undefined) continue;
		const config = record.config === undefined || record.configReal === undefined ? {} : { config: record.config, configReal: record.configReal };
		return { agent: record.agent, tool: record.tool, via: "ancestry", dataDir, ...config };
	}
	return undefined;
}

/**
 * Whether a holder's --claude-pid or --host-pid is its own tool's (module doc): an ancestor of this process, or the
 * claimant of this process's ORRERY_AGENT_TOKEN in the data folder of the agent `record` (the host's own) names. The
 * claim must hold the start that process has now, and on Linux be numbered in this process's pid namespace.
 */
export function vouched(host: number, record: Inside | undefined, env: NodeJS.ProcessEnv, deps: GateDeps = {}): boolean {
	const sessions = deps.sessions ?? {};
	if (ancestors(sessions.from ?? process.pid, sessions).includes(host)) return true;
	const token = env[TOKEN_ENV]?.trim();
	if (record?.agent === undefined || token === undefined || token === "") return false;
	return claimedBy(host, join(record.dataDir, "agents", record.agent), token, sessions);
}

/**
 * Whether `host` holds the claim of `token` in the agent folder `dir`: as the process it is now (the claim holds its
 * start), and on Linux numbered in this process's pid namespace.
 */
function claimedBy(host: number, dir: string, token: string, sessions: SessionDeps): boolean {
	const claim = claimHeld(dir, token);
	if (claim === undefined || claim === "unreadable" || claim.pid !== host) return false;
	const start = processStart(host, sessions);
	if (claim.start === undefined || start === undefined || claim.start !== start) return false;
	if ((sessions.platform ?? process.platform) !== "linux") return true;
	const here = (sessions.ns ?? pidNamespace)("self");
	return here !== undefined && claim.ns === here;
}

/**
 * Whether a holder for the agent `name` may run in a coding tool's session that is no agent's: its config is the
 * user's own (ownConfig), its host (--claude-pid or --host-pid, anyone's to write) is an ancestor of this holder (the
 * hook that started it still runs), and that host is shown to host the agent's session:
 * - a live record of the host in a real data folder names the agent; or
 * - the host was started with ORRERY_AGENT naming the agent and a token whose claim it holds (its own launch, as
 *   hostAgent reads one), and this holder carries that token.
 * Ancestry alone never vouches: from a plain tool's own shell the tool is an ancestor of anything. Nor does the host
 * alone: any session's host pid is public, its token is in its environment, which any process of the user's may read,
 * and a holder that finds its agent held drops the session's pending events.
 */
function holderVouched(name: string | undefined, env: NodeJS.ProcessEnv, judged: Judged, deps: GateDeps): boolean {
	const { host, loaded } = judged;
	const config = loaded.config;
	if (host === undefined || name === undefined || config === undefined || !ownConfig(config, judged.home)) return false;
	const agent = agentNamed(config, name);
	if (agent === undefined) return false;
	const sessions = deps.sessions ?? {};
	if (!ancestors(sessions.from ?? process.pid, sessions).includes(host)) return false;
	if (judged.real.some((dir) => (deps.liveSession ?? liveSession)(dir, host, sessions)?.agent === agent.name)) return true;
	const launched = (deps.hostEnv ?? processEnv)(host, [AGENT_ENV, TOKEN_ENV]);
	const launchedAs = launched?.[AGENT_ENV]?.trim();
	const token = launched?.[TOKEN_ENV];
	if (launchedAs === undefined || agentNamed(config, launchedAs)?.name !== agent.name || token === undefined || token === "" || env[TOKEN_ENV] !== token) return false;
	return claimedBy(host, agent.dir, token, sessions);
}

/** The markers in `env` that each say, alone, that there is a session; all those set when none does alone. */
function markersFound(look: typeof insideSession, env: NodeJS.ProcessEnv, config: HarnessConfig | undefined, deps: SessionDeps): string[] {
	const set = MARKERS.filter((key) => (env[key]?.trim() ?? "") !== "");
	const found = set.filter((key) => look([], { [key]: env[key] }, config, deps) !== undefined);
	return found.length > 0 ? found : set;
}

/** "A", "A and B", "A, B and C". */
const listed = (names: readonly string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** What a refusal adds for a session found only by markers: which, and where the person reads more; for Codex's, why. */
function markerNote(names: readonly string[]): string {
	if (names.length === 0) return "";
	const codex = names.filter((name) => CODEX_IDS.includes(name));
	if (codex.length > 0) return ` This shell carries ${listed(codex)} from Codex, whose sandbox hides which agent's session it is.`;
	// No recipe here: a detached or sandboxed agent process gets this too. The remedy is the docs' to give.
	return ` The session is known only by ${listed(names)}. If this is your own terminal (a tmux server first started from an agent session keeps its markers), see "Leftover markers" in the docs.`;
}
