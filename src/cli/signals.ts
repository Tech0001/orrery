/**
 * SIGTERM (systemctl stop) and SIGHUP (tmux kill-server, a closed terminal) stop a lane the same way a fatal error
 * does: through `stop`, so `lane.close()` still runs. A second signal while closing exits at once.
 */

const SIGNALS = { SIGHUP: 1, SIGTERM: 15 } as const;

export class SignalStop extends Error {
	readonly signal: keyof typeof SIGNALS;

	constructor(signal: keyof typeof SIGNALS) {
		super(`stopped by ${signal}`);
		this.name = "SignalStop";
		this.signal = signal;
	}
}

/** Returns a function that removes the handlers. */
export function stopOnSignals(stop: AbortController, exit: (code: number) => void = (code) => process.exit(code)): () => void {
	const handlers = (Object.keys(SIGNALS) as (keyof typeof SIGNALS)[]).map((signal) => {
		const handler = () => {
			if (stop.signal.aborted) exit(128 + SIGNALS[signal]);
			else stop.abort(new SignalStop(signal));
		};
		process.on(signal, handler);
		return [signal, handler] as const;
	});
	return () => {
		for (const [signal, handler] of handlers) process.off(signal, handler);
	};
}
