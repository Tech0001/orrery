/**
 * Process-wide HTTP setup for long model streams. Adapted from pi coding-agent's configureHttpDispatcher
 * (MIT, earendil-works/pi): one undici dispatcher for fetch, generous idle timeouts, IPv4/IPv6 fallback, and an error
 * listener so an undici teardown error cannot crash the process.
 */

import { EventEmitter } from "node:events";
import * as undici from "undici";

const IDLE_TIMEOUT_MS = 300_000;
const ignore = (_error: unknown): void => {};

function quiet<T extends undici.Dispatcher>(dispatcher: T): T {
	if (dispatcher instanceof EventEmitter) EventEmitter.prototype.on.call(dispatcher, "error", ignore);
	return dispatcher;
}

function client(origin: string | URL, options: object): undici.Dispatcher {
	return quiet(new undici.Client(origin, options as undici.Client.Options));
}

function originDispatcher(origin: string | URL, options: object): undici.Dispatcher {
	const poolOptions = options as undici.Pool.Options;
	if (poolOptions.connections === 1) return client(origin, poolOptions);
	return quiet(new undici.Pool(origin, { ...poolOptions, factory: client }));
}

let configured = false;

export function configureHttp(): void {
	if (configured) return;
	configured = true;
	undici.setGlobalDispatcher(
		quiet(
			new undici.EnvHttpProxyAgent({
				allowH2: false,
				proxyTunnel: true,
				bodyTimeout: IDLE_TIMEOUT_MS,
				headersTimeout: IDLE_TIMEOUT_MS,
				connect: { autoSelectFamilyAttemptTimeout: 2_000 },
				clientFactory: client,
				factory: originDispatcher,
			}),
		),
	);
	undici.install?.();
}
