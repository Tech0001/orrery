/**
 * Every test file starts without ORRERY_AGENT and ORRERY_AGENT_TOKEN: a run started inside an agent (`orrery agent`)
 * inherits them, and code that reads process.env by default (src/agent/pick.ts through the pi and OMP extension, and the
 * processes tests start) would then take that agent for its own.
 */
delete process.env.ORRERY_AGENT;
delete process.env.ORRERY_AGENT_TOKEN;

/**
 * The daily update check (src/install/update.ts) never reaches github.com from a test: code that reads process.env by
 * default, and processes that inherit it, ask a closed local port. Tests of the check name their own server.
 */
process.env.ORRERY_RELEASES_URL = "http://127.0.0.1:9/releases";
