/**
 * Who called a Claude Code hook (spec 2026-10-18-agent-permissions §3c). Claude Code hands a hook its input over a Unix
 * socket pair it made itself, so the process on the other end of the hook's stdin is Claude Code; an agent's shell that
 * runs the hook command hands it a pipe or a file, or a socket pair of its own, whose other end is the shell's process.
 * A writing hook (SessionStart, UserPromptSubmit, Stop, SessionEnd) changes nothing unless that process is the recorded
 * Claude Code.
 *
 * The peer is asked with getsockopt through bun:ffi: Linux's SO_PEERCRED (struct ucred, recorded when the pair was made),
 * macOS's LOCAL_PEERPID (the connected peer's pid). Claude Code closes its end of the hook's stdin before the hook runs.
 * Linux still names it then, so Linux asks stdin alone. macOS names no one once that end is closed (ENOTCONN), so there,
 * when stdin is a socket whose other end the system won't name, stdout is asked instead: Claude Code holds the hook's
 * stdout open until it has the answer. Stdin must still be a socket: a pipe or a file is refused, never passed over.
 * Stdout must be what Claude Code hands its hooks, an unnamed Unix stream socket pair (its other end has no address): a
 * connection to a socket Claude Code listens on names Claude Code as well, and is refused. Only processes Claude Code
 * itself starts hold such a stdout: an agent's commands don't (theirs is a file on macOS), but another hook does, so on
 * macOS one of the user's own hooks or plugins could pose as Orrery's (an accepted limit). Node has no getsockopt, so
 * under Node (tests, a dev run from source) nothing is known and every writing hook is refused. Asked first, before stdin
 * is read and before anything is written to stdout (src/cli/main.ts).
 */

import { fstatSync } from "node:fs";
import { createRequire } from "node:module";
import type { HarnessConfig } from "../agent/config.ts";
import { liveSession, processStart } from "../agent/sessions.ts";
import { decidedFor } from "./pick.ts";

/**
 * The pid on the other end of stdin (on macOS, of stdout when stdin's can't be named); "not-socket" when stdin is no
 * socket (or no Unix one); "unsupported" when it can't be asked (unsupportedCause says why).
 */
export type StdinPeer = number | "not-socket" | "unsupported";

/**
 * What one descriptor says of its other end: the pid there; "not-socket" when it is no socket (or one that names no
 * process); "unnamed" when it is a socket whose other end the system won't name.
 */
export type Answer = number | "not-socket" | "unnamed";

/**
 * What stdout says on macOS: an Answer, or "not-pair" for a socket that is not an unnamed Unix stream socket pair (a
 * connection to a listening socket, whose other end has an address, or another kind of socket).
 */
export type StdoutAnswer = Answer | "not-pair";

/** macOS: SOL_SOCKET, SO_TYPE, SOCK_STREAM, AF_UNIX, and a sockaddr_un's size (sun_len, sun_family, 104 bytes of path). */
const DARWIN = { solSocket: 0xffff, soType: 0x1008, sockStream: 1, afUnix: 1, sockaddrUn: 106 } as const;

/** The getsockopt arguments for the peer's pid on a system. */
interface Ask {
	readonly lib: string;
	readonly level: number;
	readonly name: number;
	readonly size: number;
}

/** The getsockopt arguments for the peer's pid on this system, or undefined where Orrery doesn't know them. */
const ASK: Partial<Record<NodeJS.Platform, Ask>> = {
	// SOL_SOCKET, SO_PEERCRED (x64 and arm64): struct ucred { pid_t pid; uid_t uid; gid_t gid; }, the pid first.
	linux: { lib: "libc.so.6", level: 1, name: 17, size: 12 },
	// SOL_LOCAL, LOCAL_PEERPID: a pid_t.
	darwin: { lib: "/usr/lib/libSystem.B.dylib", level: 0, name: 2, size: 4 },
};

/** bun:ffi's getsockopt and getpeername, bound once per process (only the Bun binary runs this). */
interface Libc {
	readonly getsockopt: (fd: number, level: number, name: number, value: Int32Array, length: Uint32Array) => number;
	readonly getpeername: (fd: number, address: Uint8Array, length: Uint32Array) => number;
}
let bound: Libc | undefined;
/** Why this process's last ask could not be made, past being Bun on a known system (unsupportedCause). */
let failed: string | undefined;

function libc(lib: string): Libc {
	if (bound !== undefined) return bound;
	const ffi = createRequire(import.meta.url)("bun:ffi") as {
		dlopen(path: string, symbols: Record<string, { args: string[]; returns: string }>): { symbols: Libc };
	};
	try {
		bound = ffi.dlopen(lib, {
			getsockopt: { args: ["i32", "i32", "i32", "ptr", "ptr"], returns: "i32" },
			getpeername: { args: ["i32", "ptr", "ptr"], returns: "i32" },
		}).symbols;
	} catch (error) {
		// No glibc (musl, say) has no libc.so.6.
		failed = `its C library ${lib} can't be loaded`;
		throw error;
	}
	return bound;
}

/** Whether descriptor `fd` is a socket; one that can't be looked at is none. */
const isSocket = (fd: number): boolean => {
	try {
		return fstatSync(fd).isSocket();
	} catch {
		return false;
	}
};

/** What descriptor `fd` of this process says of its other end (Answer). Throws where bun:ffi can't ask. */
function answer(fd: number, ask: Ask): Answer {
	if (!isSocket(fd)) return "not-socket";
	const value = new Int32Array(Math.ceil(ask.size / 4));
	const length = new Uint32Array([ask.size]);
	if (libc(ask.lib).getsockopt(fd, ask.level, ask.name, value, length) !== 0 || length[0] < 4) return "unnamed";
	// A socket that is no Unix one names no process (pid 0): not the socket pair Claude Code hands its hooks.
	return value[0] > 0 ? value[0] : "not-socket";
}

/**
 * Whether a macOS peer address (`length` bytes of a sockaddr_un: sun_len, sun_family, then the path) is a Unix socket's
 * with no path, as a socket pair's other end is. A connection to a listening socket gets the listener's path.
 */
export function unnamedUnixPeer(address: Uint8Array, length: number): boolean {
	return length >= 2 && address[1] === DARWIN.afUnix && (length === 2 || address[2] === 0);
}

/**
 * What descriptor `fd` says on macOS when it must be the socket pair Claude Code hands its hooks (StdoutAnswer): a Unix
 * stream socket whose other end has no address, else "not-pair". Throws where bun:ffi can't ask.
 */
function pairAnswer(fd: number, ask: Ask): StdoutAnswer {
	if (!isSocket(fd)) return "not-socket";
	const { getsockopt, getpeername } = libc(ask.lib);
	const type = new Int32Array(1);
	if (getsockopt(fd, DARWIN.solSocket, DARWIN.soType, type, new Uint32Array([4])) !== 0 || type[0] !== DARWIN.sockStream) return "not-pair";
	const address = new Uint8Array(DARWIN.sockaddrUn);
	const length = new Uint32Array([DARWIN.sockaddrUn]);
	// It fails when stdout is connected to no one.
	if (getpeername(fd, address, length) !== 0) return "unnamed";
	return unnamedUnixPeer(address, length[0]) ? answer(fd, ask) : "not-pair";
}

/**
 * The hook's caller from what its descriptors say (module doc): stdin's answer, and on macOS, when stdin is a socket the
 * system won't name the other end of, stdout's, where only a pid counts. Linux never asks stdout. `stdin` and `stdout`
 * ask their descriptor (and may throw). An "unsupported" peer comes with why, for unsupportedCause.
 */
export function peerFrom(platform: NodeJS.Platform, stdin: () => Answer, stdout: () => StdoutAnswer): { readonly peer: StdinPeer; readonly cause?: string } {
	const fromStdin = stdin();
	if (fromStdin !== "unnamed") return { peer: fromStdin };
	if (platform !== "darwin") return { peer: "unsupported", cause: "the system would not name the socket's other end" };
	// Claude Code closed its end of stdin before the hook ran; it holds stdout's until it has the answer.
	const fromStdout = stdout();
	if (typeof fromStdout === "number") return { peer: fromStdout };
	const cause = fromStdout === "not-pair" ? "stdout is not the socket pair Claude Code hands its hooks" : "the system would not name the other end of stdin or stdout";
	return { peer: "unsupported", cause };
}

/** The process that called this hook (module doc): the other end of stdin, or on macOS maybe of stdout. Never throws. */
export function stdinPeer(): StdinPeer {
	const ask = ASK[process.platform];
	if (process.versions.bun === undefined || ask === undefined) return "unsupported";
	try {
		const { peer, cause } = peerFrom(
			process.platform,
			() => answer(0, ask),
			() => pairAnswer(1, ask),
		);
		if (cause !== undefined) failed = cause;
		return peer;
	} catch {
		failed ??= "bun:ffi failed";
		return "unsupported";
	}
}

/** Why stdinPeer can't ask here, in a few words, for the hooks' notice (src/claude/hooks.ts). */
export function unsupportedCause(): string {
	if (process.versions.bun === undefined) return "it runs under Node, not its own binary";
	if (ASK[process.platform] === undefined) return `${process.platform} isn't supported`;
	return failed ?? "it can't ask on this system";
}

/** Why a hook's caller is not its Claude Code, or "ok". */
export type CallerCheck = "ok" | "not-socket" | "unsupported" | "other-process" | "unrecorded";

/**
 * Whether a writing hook's caller is Claude Code process `claudePid` (the hook's CLAUDE_PID, as claudeHookPid checked it):
 * its peer (stdinPeer) must be that process. `recorded` (every event but SessionStart): it must also be the Claude Code
 * Orrery recorded, its start time known and equal to the one its decision record holds (src/claude/pick.ts), else its
 * host record (src/agent/sessions.ts), so a pid that a gone Claude Code left to another process is not it. A decision
 * recorded before start times (0.8.0: a session left open across the update) counts for an ORRERY_AGENT launch whose
 * token's digest the hook's `env` holds (decidedFor). SessionStart takes the peer alone: it may come before any record,
 * and the pick it makes reads the start and records it (a start it can't read is "unconfirmed" there). `start`: how a
 * process's start time is read (default processStart).
 */
export function checkCaller(
	config: HarnessConfig,
	claudePid: number,
	peer: StdinPeer,
	options: { readonly recorded: boolean; readonly env: NodeJS.ProcessEnv; readonly start?: (pid: number) => string | undefined },
): CallerCheck {
	if (typeof peer !== "number") return peer;
	if (peer !== claudePid) return "other-process";
	if (!options.recorded) return "ok";
	const start = (options.start ?? processStart)(peer);
	if (start === undefined) return "unrecorded";
	if (decidedFor(config, peer, options.env, start)) return "ok";
	const host = liveSession(config.dataDir, peer);
	return host?.tool === "claude-code" && host.start === start ? "ok" : "unrecorded";
}
