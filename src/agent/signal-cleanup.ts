/**
 * Clean-up that must happen even when the launcher is stopped meanwhile: a SIGTERM or SIGHUP (a closed terminal, kill)
 * or an exit while OpenCode runs (its token file, src/opencode/token-file.ts), and those or a Ctrl-C (SIGINT) while it
 * is checked (the check's scratch folder, src/opencode/check.ts). While OpenCode runs, Ctrl-C is OpenCode's own.
 */

export type CleanupSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

const SIGNALS: readonly CleanupSignal[] = ["SIGTERM", "SIGHUP"];

/** What cleanUpOnSignals needs of the process (tests give their own). */
export type SignalTarget = Pick<NodeJS.Process, "prependListener" | "on" | "off" | "listenerCount" | "kill" | "pid">;

/**
 * Runs `cleanup` (which must not throw) if this process is stopped by one of `signals` (default SIGTERM and SIGHUP), or
 * exits, before the undo is called. Its handlers run before any other (the TUI's restores the terminal and exits); one
 * that is alone stops the process by the signal afterwards, as Node would have without it. Returns the undo.
 */
export function cleanUpOnSignals(cleanup: () => void, target: SignalTarget = process, signals: readonly CleanupSignal[] = SIGNALS): () => void {
	const handlers = signals.map((signal) => {
		const handler = () => {
			cleanup();
			if (target.listenerCount(signal) === 1) {
				target.off(signal, handler);
				target.kill(target.pid, signal);
			}
		};
		target.prependListener(signal, handler);
		return [signal, handler] as const;
	});
	target.on("exit", cleanup);
	return () => {
		for (const [signal, handler] of handlers) target.off(signal, handler);
		target.off("exit", cleanup);
	};
}
