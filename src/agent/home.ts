/** Where Orrery lives: one folder holding config, logins, memory, backups and the installed program. */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** Defined here, not in config.ts, so home.ts and config.ts do not import each other; config.ts re-exports it. */
export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

/** $ORRERY_HOME (a leading ~/ expanded), else ~/.orrery. */
export function orreryHome(env: NodeJS.ProcessEnv = process.env): string {
	const home = env.HOME || homedir();
	const set = env.ORRERY_HOME;
	if (set === undefined || set === "") return join(home, ".orrery");
	const expanded = set === "~" ? home : set.startsWith("~/") ? join(home, set.slice(2)) : set;
	if (!isAbsolute(expanded)) throw new ConfigError(`ORRERY_HOME must be an absolute path (got ${set})`);
	return resolve(expanded);
}

/**
 * This user's home folder as the system's password database records it, never $HOME, which anyone may set: undefined
 * when the database has no record of this user. Node's userInfo() reads the database (getpwuid_r); Bun's (1.4) gives
 * $HOME, so under Bun, as the release binary runs, it is read from the system (systemPasswordHome).
 */
export function passwordHome(): string | undefined {
	if (process.versions.bun !== undefined) return systemPasswordHome();
	try {
		const home = userInfo().homedir;
		return isAbsolute(home) ? home : undefined;
	} catch {
		// no record of this user
		return undefined;
	}
}

/** How systemPasswordHome reads the system; each defaults to the real one (tests give fakes). */
export interface PasswordDeps {
	/** Whose record (default this process's real uid). */
	readonly uid?: number;
	readonly platform?: NodeJS.Platform;
	/** A file's text; throws when it can't be read. */
	readonly read?: (file: string) => string;
	/** A program's output, run with no shell; undefined when it fails. */
	readonly run?: (program: string, args: readonly string[]) => string | undefined;
	/** Whether a file is there (default existsSync). */
	readonly exists?: (file: string) => boolean;
}

/** Where getent may be, in this order: the first there is asked. Programs are named by their full paths: PATH is anyone's to set. */
const GETENT = ["/usr/bin/getent", "/bin/getent"];

/** The most a lookup may take: NSS may ask a directory server. */
const LOOKUP_MS = 5000;

/**
 * The home folder in user `uid`'s record in the system's password database, read without Node's userInfo: on Linux its
 * line in /etc/passwd (the first, as getpwuid finds it), else `getent passwd <uid>` (NSS: a directory server,
 * systemd-homed and the like); on macOS `id -P` (Directory Services). Undefined elsewhere, or when no record of `uid`
 * holds an absolute home.
 */
export function systemPasswordHome(deps: PasswordDeps = {}): string | undefined {
	const uid = deps.uid ?? process.getuid?.();
	if (uid === undefined) return undefined;
	const platform = deps.platform ?? process.platform;
	const run = deps.run ?? runQuietly;
	/** The home in a record, name:password:uid:gid:…:home:shell (7 fields; macOS's id -P gives 10), when it is uid's. */
	const homeIn = (line: string): string | undefined => {
		const fields = line.split(":");
		const home = fields.at(-2);
		return fields.length >= 7 && fields[2] === String(uid) && home !== undefined && isAbsolute(home) ? home : undefined;
	};
	const first = (text: string | undefined) => text?.split("\n").map(homeIn).find((home) => home !== undefined);
	if (platform === "linux") {
		let passwd: string | undefined;
		try {
			passwd = (deps.read ?? ((file: string) => readFileSync(file, "utf8")))("/etc/passwd");
		} catch {
			// none to read: NSS may still know the user
		}
		const found = first(passwd);
		if (found !== undefined) return found;
		const getent = GETENT.find(deps.exists ?? existsSync);
		return getent === undefined ? undefined : first(run(getent, ["passwd", String(uid)]));
	}
	if (platform === "darwin") return first(run("/usr/bin/id", ["-P"]));
	return undefined;
}

/** `program`'s output, run with no shell and no inherited environment; undefined when it fails or can't be run. */
function runQuietly(program: string, args: readonly string[]): string | undefined {
	const result = spawnSync(program, args, { encoding: "utf8", env: { LC_ALL: "C" }, stdio: ["ignore", "pipe", "ignore"], timeout: LOOKUP_MS });
	return result.error === undefined && result.status === 0 ? result.stdout : undefined;
}
