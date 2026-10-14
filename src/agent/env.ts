/** Where an agent's tools run: this machine (pi-durable NodeExecutionEnv) or an SSH host (pi-env, lazily connected). */

import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { RemoteExecutionEnv, sshConnection } from "@earendil-works/pi-env";
import type { HostConfig } from "./config.ts";
import { sshTarget } from "./ssh-target.ts";

export interface AgentEnv {
	env(cwd?: string): ExecutionEnv;
	readText(path: string): Promise<string | undefined>;
	close(): Promise<void>;
}

export { sshTarget };

async function readVia(env: ExecutionEnv, path: string, context: Context): Promise<string | undefined> {
	try {
		const result = await env.readTextFile(path, context);
		return result.ok ? result.value : undefined;
	} catch {
		return undefined;
	}
}

export function createAgentEnv(host: HostConfig, folder: string, sshDir: string, context: Context): AgentEnv {
	if (host.kind === "local") {
		const envs = new Map<string, NodeExecutionEnv>();
		const env = (cwd: string = folder): ExecutionEnv => {
			let found = envs.get(cwd);
			if (found === undefined) {
				found = new NodeExecutionEnv({ cwd });
				envs.set(cwd, found);
			}
			return found;
		};
		return {
			env,
			readText: (path) => readVia(env(), path, context),
			close: async () => {
				for (const found of envs.values()) await found.cleanup(context);
			},
		};
	}
	const { connection } = sshConnection({ ...sshTarget(host, sshDir), loginShell: true });
	const envs = new Map<string, RemoteExecutionEnv>();
	const env = (cwd: string = folder): ExecutionEnv => {
		let found = envs.get(cwd);
		if (found === undefined) {
			found = new RemoteExecutionEnv({ connection, id: `pi-env:${host.name}`, cwd });
			envs.set(cwd, found);
		}
		return found;
	};
	return {
		env,
		readText: (path) => readVia(env(), path, context),
		close: async () => {
			await connection.close();
		},
	};
}
