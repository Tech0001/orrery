/** Remote lanes (spec 2026-10-12-remote-lanes-design): the Storage for a configured remote, and who this machine is. */

import { ConfigError, type HarnessConfig } from "../lane/config.ts";
import { ensureDeviceId } from "../lane/models.ts";
import { CloudflareStorage } from "./cloudflare.ts";
import { readRemoteSecret } from "./secrets.ts";
import { ServerStorage } from "./server.ts";
import { type Holder, RemoteError, type Storage } from "./types.ts";

export function holderFor(config: HarnessConfig): Holder {
	return { machine: config.machineName, device: ensureDeviceId(config.deviceIdPath), pid: process.pid };
}

export function openStorage(config: HarnessConfig, name: string): Storage {
	const remote = config.remotes.get(name);
	if (remote === undefined) throw new ConfigError(`unknown remote "${name}"`);
	if (remote.kind === "server") return new ServerStorage(remote, config.sshDir);
	const token = readRemoteSecret(config, name)?.token;
	if (token === undefined) throw new RemoteError("key-missing", `No token for remote ${name} on this machine: run orrery remote add ${name}`);
	return new CloudflareStorage(remote, token);
}
