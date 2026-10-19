/**
 * The `orrery` commands that run inside an agent session (spec 2026-10-18-agent-permissions-design §3); every other one
 * is refused there. A module of its own with no imports, so the guard, which pi, OMP and every tool's gate load, takes
 * the list without the session lookup's imports; src/agent/sessions.ts re-exports it.
 */
export const ALLOWED_INSIDE: ReadonlySet<string> = new Set(["help", "status", "usage", "browse", "compactor", "claude-hook", "codex-hook", "holder", "mcp", "claude-mod"]);
