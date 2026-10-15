/**
 * The SSH target for an Orrery [hosts] entry: its own config file (ConnectTimeout), identity, pinned known-hosts file and
 * host key alias. Kept apart from env.ts so code the pi extension loads (remote agents' server kind) never pulls in
 * pi-env or pi-durable, which pi does not ship.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SshTarget } from "@earendil-works/pi-env";
import type { HostConfig } from "./config.ts";

type SshHost = Extract<HostConfig, { kind: "ssh" }>;

/** pi-env takes no extra ssh options, so ConnectTimeout lives in a generated config file (it replaces ~/.ssh/config). */
export function sshTarget(host: SshHost, sshDir: string): SshTarget {
	mkdirSync(sshDir, { recursive: true, mode: 0o700 });
	const configFile = join(sshDir, `${host.name}.config`);
	writeFileSync(configFile, `Host *\n  ConnectTimeout ${host.connectTimeout}\n  ServerAliveCountMax 2\n`, { mode: 0o600 });
	return {
		host: host.host,
		...(host.user === undefined ? {} : { user: host.user }),
		...(host.port === undefined ? {} : { port: host.port }),
		identityFile: host.identityFile,
		knownHostsFile: host.knownHostsFile,
		hostKeyAlias: host.hostKeyAlias,
		configFile,
	};
}
