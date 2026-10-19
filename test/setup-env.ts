/**
 * Every test file starts without an agent session's markers: a run started inside an agent (`orrery agent`, or a tool's
 * shell) inherits ORRERY_AGENT and ORRERY_AGENT_TOKEN, Claude Code's CLAUDE_PID, Codex's CODEX_THREAD_ID and
 * CODEX_SESSION_ID, or OpenCode's OPENCODE_CONFIG_CONTENT, and code that reads process.env by default (src/agent/pick.ts
 * through the pi and OMP extension, the session lookup in src/agent/sessions.ts, and the processes tests start) would
 * then take that agent, or that session, for its own.
 */
for (const key of ["ORRERY_AGENT", "ORRERY_AGENT_TOKEN", "CLAUDE_PID", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "OPENCODE_CONFIG_CONTENT"]) delete process.env[key];

/**
 * The daily update check (src/install/update.ts) never reaches github.com from a test: code that reads process.env by
 * default, and processes that inherit it, ask a closed local port. Tests of the check name their own server.
 */
process.env.ORRERY_RELEASES_URL = "http://127.0.0.1:9/releases";
