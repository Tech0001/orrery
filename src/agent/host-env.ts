/**
 * The host pid a tool session leaves its shell (HOST_ENV, src/agent/sessions.ts): a session opened by its folder, or
 * `orrery run`, gives its shell no other marker, so a tool started from it and detached from its ancestry
 * (`setsid -f pi -p …`) would otherwise find no session. Set in this process's environment, which every shell the
 * session starts inherits, while the session is recorded; taken back when its record goes.
 * Node built-ins and relative imports only: pi and OMP load this file.
 */

import { HOST_ENV } from "./sessions.ts";

/**
 * Sets HOST_ENV to `pid` in `env` (default this process's). Returns the undo, which puts back what was there before,
 * unless the variable has changed since (another session in this process set its own): then it is left as it is. The
 * undo runs once.
 */
export function leaveHostEnv(pid: number, env: NodeJS.ProcessEnv = process.env): () => void {
	const value = String(pid);
	const previous = env[HOST_ENV];
	env[HOST_ENV] = value;
	let undone = false;
	return () => {
		if (undone) return;
		undone = true;
		if (env[HOST_ENV] !== value) return;
		if (previous === undefined) delete env[HOST_ENV];
		else env[HOST_ENV] = previous;
	};
}
