/** Run the real server script through a local shell, preserving SSH's remote-command re-parsing. */

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RemoteConfig } from "../../src/agent/config.ts";

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

export function fakeSsh(home: string, fail?: "connect" | "auth", env: Record<string, string> = {}): { path: string } {
	mkdirSync(home, { recursive: true });
	const path = join(home, `fake-ssh-${randomUUID()}`);
	const exports = Object.entries(env).map(([name, value]) => {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("invalid test environment name");
		return `export ${name}=${quote(value)}`;
	}).join("\n");
	writeFileSync(path, `#!/bin/sh
set -eu
cd ${quote(home)}
${exports}
export ORRERY_FAKE_SSH_FAIL=${quote(fail ?? env.ORRERY_FAKE_SSH_FAIL ?? "")}
case "$ORRERY_FAKE_SSH_FAIL" in
 connect) printf '%s\\n' 'ssh: connect to host fake port 22: Connection refused' >&2; exit 255 ;;
 auth) printf '%s\\n' 'fake: Permission denied (publickey).' >&2; exit 255 ;;
esac
printf '%s\\n' "$@" > ${quote(`${path}.args`)}
if [ "\${1:-}" = -O ]; then
 [ "$2" = exit ] || exit 2
 printf exit > ${quote(`${path}.exit`)}
 [ "\${ORRERY_FAKE_EXIT_FAIL:-}" != yes ] || exit 255
 if [ -n "\${ORRERY_FAKE_CONTROL_SOCKET:-}" ]; then rm -f -- "$ORRERY_FAKE_CONTROL_SOCKET"; fi
 if [ -n "\${ORRERY_FAKE_HANG:-}" ]; then touch "$ORRERY_FAKE_HANG.released"; fi
 exit 0
fi
control_master=
control_path=
for arg do
 case "$arg" in
  ControlMaster=*) if [ -z "$control_master" ]; then control_master=\${arg#ControlMaster=}; fi ;;
  ControlPath=*) if [ -z "$control_path" ]; then control_path=\${arg#ControlPath=}; fi ;;
 esac
done
if [ -n "\${ORRERY_FAKE_HANG:-}" ] && [ ! -f "$ORRERY_FAKE_HANG.released" ] && [ "$control_path" != none ]; then
 printf ready > "$ORRERY_FAKE_HANG"
 while :; do sleep 1; done
fi
# Optional native parsing/proxy probes never connect to a host.
if [ "\${ORRERY_FAKE_CHECK_CONTROL:-}" = yes ]; then
 ssh -G "$@" > ${quote(`${path}.config`)}
fi
if [ "\${ORRERY_FAKE_PROBE_CONNECT:-}" = yes ]; then
 ssh -o ${quote(`ProxyCommand=printf fresh > ${quote(`${path}.connected`)}; exit 1`)} "$@" > /dev/null 2> ${quote(`${path}.probe-error`)} || :
fi
# Model OpenSSH's opportunistic fallback before it sends the remote command.
if [ "$control_master" = auto ] && [ -n "\${ORRERY_FAKE_STALE_SOCKET:-}" ] && [ -S "$ORRERY_FAKE_STALE_SOCKET" ]; then
 [ "$control_path" = "$ORRERY_FAKE_CONTROL_PATH" ] || exit 2
 printf '%s\\n' 'Stale control socket: Connection refused; opening a fresh connection' >&2
 rm -f -- "$ORRERY_FAKE_STALE_SOCKET"
 printf '%s\\n' fresh > "$ORRERY_FAKE_STALE_SOCKET.fallback"
fi
while [ "$#" -gt 0 ]; do
 case "$1" in
  --) shift; break ;;
  -F|-i|-o|-p) shift; shift ;;
  -*) printf '%s\\n' 'unexpected ssh option' >&2; exit 2 ;;
  *) shift ;;
 esac
done
[ "$#" -gt 0 ] || exit 2
exec sh -c "$*"
`, { mode: 0o700 });
	return { path };
}

export function serverRemote(folder: string): Extract<RemoteConfig, { kind: "server" }> {
	return {
		name: "home", kind: "server", folder,
		host: { name: "home", kind: "ssh", host: "fake.invalid", user: "alex", port: 2222,
			identityFile: "/test/id with spaces", knownHostsFile: "/test/known hosts",
			hostKeyAlias: "orrery-home", connectTimeout: 7 },
	};
}
