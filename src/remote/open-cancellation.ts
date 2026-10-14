/** Cancels checkout waits, including a take whose successful reply arrives after the caller has left. */
import type { Storage } from "./types.ts";

export function abortable<T>(signal: AbortSignal | undefined, start: () => Promise<T>, late?: (value: T) => void): Promise<T> {
	if (signal === undefined) return start();
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		Promise.resolve().then(() => { signal.throwIfAborted(); return start(); }).then((value) => {
			signal.removeEventListener("abort", abort);
			if (signal.aborted) late?.(value);
			else resolve(value);
		}, (error: unknown) => {
			signal.removeEventListener("abort", abort);
			reject(error);
		}).catch(reject); // A late cleanup may throw after cancellation; never leave an unhandled rejection in the host.
	});
}

/** After finish(), the attached session uses the original transport with no checkout deadline. */
export function cancellableCheckout(storage: Storage, signal?: AbortSignal): { storage: Storage; finish(): void } {
	let pending = signal;
	const release = (agent: string, lock: number) => {
		const sending = storage.release(agent, lock);
		// Release is fenced and safe even if a newer session took over. An offline release must not hold up cancellation.
		if (pending?.aborted) { void sending.catch(() => {}); return Promise.resolve(); }
		return abortable(pending, () => sending).catch((error: unknown) => { if (!pending?.aborted) throw error; });
	};
	return {
		finish() { pending = undefined; },
		storage: {
			name: storage.name,
			take: (agent, holder, options) => abortable(pending, () => storage.take(agent, holder, options), (result) => {
				if (result.ok) void storage.release(agent, result.lock).catch(() => {});
			}),
			fetch: (agent, after) => abortable(pending, () => storage.fetch(agent, after)),
			save: (...args) => abortable(pending, () => storage.save(...args)),
			snapshot: (...args) => abortable(pending, () => storage.snapshot(...args)),
			renew: (...args) => abortable(pending, () => storage.renew(...args)),
			list: () => abortable(pending, () => storage.list()),
			log: (agent) => abortable(pending, () => storage.log(agent)),
			getCheck: () => abortable(pending, () => storage.getCheck()),
			putCheck: (file) => abortable(pending, () => storage.putCheck(file)),
			drop: (...args) => abortable(pending, () => storage.drop(...args)),
			release,
		},
	};
}
