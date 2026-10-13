/** Process liveness, checked once for the whole lane code (status files, the CLI, Claude Code's holder). */

/**
 * True when `pid` is a live process (one we may not signal still counts as live). A pid that is no positive integer
 * (read from a file) is not: kill(0) and kill(-1) would signal a whole process group.
 */
export function processAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid < 1) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
