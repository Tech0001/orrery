/**
 * A tool session started from a coding tool's session that is no agent's (spec 2026-10-19-no-agent-sessions §4c): a
 * plain Claude Code or Codex that starts `claude -p` (or pi, OMP, Codex, OpenCode, `orrery run`) in an agent's folder.
 * As for a tool an agent starts (spec 2026-10-18-agent-permissions §3b), it opens no memory, records nothing, and keeps
 * the guard: else the plain session could record made-up words in the agent's memory as the user's.
 *
 * Each tool asks where 0.9.0 decides "nested", once per process, after insideSession finds no agent's session, and keeps
 * the answer in that decision: Claude Code's and Codex's decision records, pi's and OpenCode's per-process state. The
 * answer is an Inside with `plain`, the tool it was started from:
 * - toolSession (src/agent/sessions.ts) about the tool's host process's ancestors, never the host itself, with the host
 *   as its own tool (`own`): its own launcher right above it, by the shape the tool starts it in, is passed over (npm's
 *   Codex launcher above Codex's binary, OpenCode's --standalone TUI above its `serve --stdio` server, the Claude Code
 *   desktop app's disclaimer); any other process of its tool above it is an outer session. Its own tool's markers count
 *   only where the host was started with them, never under the desktop app's wrapper: in a cut walk any of them, and on
 *   Linux in a whole walk too CLAUDECODE, PI_CODING_AGENT or CODEX_THREAD_ID (a same-tool start detached or in the
 *   background; toolSession). `orrery run` is no coding tool: every tool's markers count for it. A Codex id a live
 *   record names is an agent's Codex session, no marker.
 * - Only where the tool's config touches the user's real Orrery data (src/agent/real-data.ts, configPaths): a scratch
 *   home holds no agent's memory to protect, and tests run tools against scratch homes from inside coding tools.
 * The tool is looked for first, so in the user's own terminal the real data is never looked up.
 *
 * Where no agent would open (a folder that is no agent's, no ORRERY_AGENT: opensHere), such a session is a plain one:
 * Orrery's own guard alone and no notice, as Claude Code and pi give a plain session (src/claude/hooks.ts, src/pi). In
 * an agent's folder it keeps that agent's guard, as a nested one whose outer agent is unknown does.
 * Node built-ins and relative modules only (with smol-toml through real-data.ts), for pi and OMP, which load it.
 */

import { agentForCwd, type HarnessConfig } from "./config.ts";
import { AGENT_ENV } from "./pick.ts";
import { configPaths, realOrreryData, touchesReal } from "./real-data.ts";
import { type Inside, recordedCodexIds, type SessionDeps, type SessionTool, toolSession } from "./sessions.ts";

/** How a tool's integration asks (tests give fakes; production passes none). */
export interface PlainDeps {
	/** How processes are read (toolSession's; its `from` is the host). */
	readonly sessions?: SessionDeps;
	/**
	 * The home whose Orrery data is the user's real data (realOrreryData). Default: the one the password database records
	 * for this user, never $HOME. Only a caller in this program gives it (tests): no option or variable reaches it.
	 */
	readonly realHome?: string;
}

/** Each session tool as toolSession names a coding tool: `orrery run` is none. */
const OWN: Readonly<Record<SessionTool, string | undefined>> = { "claude-code": "claude", codex: "codex", opencode: "opencode", pi: "pi", omp: "omp", run: undefined };

/** The markers that hold a Codex session's id (src/agent/sessions.ts TOOL_MARKERS). */
const CODEX_IDS = ["CODEX_THREAD_ID", "CODEX_SESSION_ID"] as const;

/**
 * The coding tool's session that is no agent's that `host` (a tool session's host process, of `host.tool`, run with
 * `env`) was started from (module doc), as an Inside with `plain`; undefined when there is none, or when `config`
 * touches no real data. Asked only when insideSession finds no agent's session.
 */
export function plainNested(config: HarnessConfig, env: NodeJS.ProcessEnv, host: { readonly pid: number; readonly tool: SessionTool }, deps: PlainDeps = {}): Inside | undefined {
	const sessions = deps.sessions ?? {};
	const own = OWN[host.tool];
	// A Codex host is also asked about the thread id it was started with (toolSession).
	const codex = own === "codex" || CODEX_IDS.some((key) => (env[key] ?? "") !== "") ? { recordedCodexIds: recordedCodexIds([config.dataDir], sessions) } : {};
	const found = toolSession(env, { ...sessions, ...codex, from: host.pid, ...(own === undefined ? {} : { own }) });
	if (found === undefined) return undefined;
	const real = realOrreryData(deps.realHome === undefined ? {} : { home: deps.realHome });
	if (!touchesReal(configPaths(config), real)) return undefined;
	return { agent: undefined, tool: undefined, via: found.via, dataDir: config.dataDir, plain: found.tool, ...(found.variable === undefined ? {} : { variable: found.variable }) };
}

/**
 * Whether a session in `cwd` would open an agent's memory but for being nested: ORRERY_AGENT is set, or the folder is an
 * agent's. Where none would, a session started from a coding tool's session that is no agent's is a plain one (module
 * doc).
 */
export function opensHere(config: HarnessConfig, env: NodeJS.ProcessEnv, cwd: string): boolean {
	return Boolean(env[AGENT_ENV]?.trim()) || agentForCwd(config, cwd) !== undefined;
}
