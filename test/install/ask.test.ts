import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { installFrom } from "../../src/install/install.ts";
import { piExtensionFile } from "../../src/lane/tools.ts";
import { cliCommand } from "../claude/support.ts";
import { bunReady } from "../release/support.ts";
import { cleanupScratch, fixtureRelease, scratchPath, systemCommand, tempDir, writePiExtension } from "./support.ts";

afterEach(cleanupScratch);

const SCRIPT = systemCommand("script");
const SETSID = systemCommand("setsid");
const hasScript = process.platform === "linux" && SCRIPT !== undefined && SETSID !== undefined && spawnSync(SCRIPT, ["--version"]).status === 0;
const ASK = fileURLToPath(new URL("../../src/install/ask.ts", import.meta.url));

const quote = (part: string) => `'${part.replace(/'/g, `'\\''`)}'`;

/** The CLI under test (ORRERY_TEST_BIN or node main.ts) as one shell command line. */
const shellCommand = (...args: string[]) => {
	const c = cliCommand(args);
	return [c.cmd, ...c.args].map(quote).join(" ");
};

/** Runs a shell command line in a new pseudo-terminal; `typed` is what the person types there. */
const inTerminal = (command: string, typed: string, env: NodeJS.ProcessEnv) => spawnSync(SCRIPT as string, ["-qec", command, "/dev/null"], { encoding: "utf8", input: typed, env, timeout: 20_000 });

/** Runs the CLI with no controlling terminal at all (setsid): /dev/tty cannot be opened. */
const withoutTerminal = (args: string[], env: NodeJS.ProcessEnv) => {
	const c = cliCommand(args);
	return spawnSync(SETSID as string, ["-w", c.cmd, ...c.args], { encoding: "utf8", input: "", env, timeout: 20_000 });
};

/**
 * A scratch home with an installed fixture release, and a plain file at ~/.local/bin/orrery that is not Orrery's: a
 * thing setup must ask about. PATH finds no pi, OMP or Claude Code, except a fake pi when asked for (with no extension
 * file yet, so setup also asks before connecting it).
 */
function scratchWithForeignCommand(options: { pi?: boolean } = {}): { env: NodeJS.ProcessEnv; home: string; link: string } {
	const home = tempDir("orrery-ask-");
	const fakes = join(home, "fakes");
	mkdirSync(fakes);
	if (options.pi === true) writeFileSync(join(fakes, "pi"), '#!/bin/sh\necho "pi 1.2.0"\n', { mode: 0o755 });
	const env: NodeJS.ProcessEnv = { HOME: home, ORRERY_HOME: join(home, ".orrery"), PATH: `${fakes}:${scratchPath()}`, LANG: "C" };
	installFrom({ from: fixtureRelease("0.6.0"), env });
	const link = join(home, ".local", "bin", "orrery");
	mkdirSync(join(home, ".local", "bin"), { recursive: true });
	writeFileSync(link, "#!/bin/sh\necho someone else\n", { mode: 0o755 });
	return { env, home, link };
}

const commandTarget = (env: NodeJS.ProcessEnv) => join(env.ORRERY_HOME as string, "app", "current", "bin", "orrery");

describe.skipIf(!hasScript)("questions under curl | sh", () => {
	it("are asked on the terminal even when stdin is a pipe", () => {
		const { env, link } = scratchWithForeignCommand();
		const r = inTerminal(`printf 'not an answer\\n' | ${shellCommand("setup")}`, "n\n", env);
		expect(r.stdout).toMatch(/replace .*\.local\/bin\/orrery\? \(y\/N\)/);
		expect(r.stdout).toMatch(/left .* as it is/);
		expect(r.status).toBe(1);
		expect(readFileSync(link, "utf8")).toMatch(/someone else/);
	});

	it("a yes on the terminal replaces it", () => {
		const { env, link } = scratchWithForeignCommand();
		const r = inTerminal(`printf 'n\\n' | ${shellCommand("setup")}`, "y\n", env);
		expect(r.stdout).toMatch(/replace .*\.local\/bin\/orrery\? \(y\/N\)/);
		expect(r.stdout).toMatch(/orrery command: .* links to /);
		expect(r.status).toBe(0);
		expect(readlinkSync(link)).toBe(commandTarget(env));
	});

	it("a tool with no Orrery wiring yet is connected only after a yes on the terminal", () => {
		const { env, link } = scratchWithForeignCommand({ pi: true });
		const r = inTerminal(`printf 'n\\n' | ${shellCommand("setup")}`, "y\ny\n", env);
		expect(r.stdout).toMatch(/Connect Orrery to pi\? \(writes .*\.pi\/agent\/extensions\/orrery\.ts\) \(y\/N\)/);
		expect(r.status, r.stdout).toBe(0);
		expect(readlinkSync(link)).toBe(commandTarget(env));
		expect(readFileSync(piExtensionFile(env), "utf8")).toContain(join(env.ORRERY_HOME as string, "app", "current", "extensions", "pi.js"));
	});

	it("Ctrl-D at a question is no: that one is left, and the rest is wired and reported", () => {
		const { env, link } = scratchWithForeignCommand({ pi: true });
		// pi is wired to the other install shape already: moving Orrery's own wiring asks nothing.
		writePiExtension(env, join(env.ORRERY_HOME as string, "app", "current", "src", "pi", "index.ts"));
		const r = inTerminal(`${shellCommand("setup")} < /dev/null`, "\x04", env);
		expect(r.status, r.stdout).toBe(1);
		expect(r.stdout).toMatch(/replace .*\.local\/bin\/orrery\? \(y\/N\)/);
		expect(r.stdout).toMatch(/^orrery command: left .* as it is/m);
		expect(r.stdout).toMatch(/^pi: wrote /m); // a file written after the question
		expect(r.stdout).toMatch(/^Claude Code: /m);
		expect(r.stdout).toContain("Not everything points at this install:");
		expect(readFileSync(link, "utf8")).toMatch(/someone else/);
		expect(readFileSync(piExtensionFile(env), "utf8")).toContain(join(env.ORRERY_HOME as string, "app", "current", "extensions", "pi.js"));
	});

	it("Ctrl-C at a question stops setup, and what it did before is already printed", async () => {
		const { env, link } = scratchWithForeignCommand();
		rmSync(link); // no question about the command: setup links it first
		writePiExtension(env, "/elsewhere/orrery/src/pi/index.ts");
		// Ctrl-C is typed only once the question is on the terminal.
		const r = await new Promise<{ status: number | null; stdout: string }>((done) => {
			const child = spawn(SCRIPT as string, ["-qec", `${shellCommand("setup")} < /dev/null`, "/dev/null"], { env });
			let stdout = "";
			const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
			child.stdout.on("data", (chunk: Buffer) => {
				stdout += chunk.toString("utf8");
				if (/\(y\/N\) $/.test(stdout)) child.stdin.write("\x03");
			});
			child.on("close", (status) => {
				clearTimeout(timer);
				done({ status, stdout });
			});
		});
		expect(r.status).not.toBe(0);
		expect(r.stdout).toMatch(/^orrery command: .* links to /m);
		expect(readlinkSync(link)).toBe(commandTarget(env));
		expect(r.stdout).toMatch(/^no backup service/m);
		expect(r.stdout).toMatch(/pi: replace .*\? \(y\/N\)/);
		expect(r.stdout).not.toMatch(/^Claude Code: /m);
		expect(readFileSync(piExtensionFile(env), "utf8")).toContain("/elsewhere/orrery/src/pi/index.ts");
	});

	it("with no terminal, changes nothing that needs asking, lists it, and exits 1", () => {
		const { env, link } = scratchWithForeignCommand({ pi: true });
		const r = withoutTerminal(["setup"], env);
		expect(r.status).toBe(1);
		expect(r.stdout).toMatch(/Skipped \(no terminal to ask; rerun with --yes\): replace /);
		expect(r.stdout).toMatch(/Skipped \(no terminal to ask; rerun with --yes\): Connect Orrery to pi\? /);
		expect(r.stdout).toContain("Not everything points at this install:");
		expect(r.stdout).toContain("  - pi (not connected)");
		expect(readFileSync(link, "utf8")).toMatch(/someone else/);
		expect(existsSync(piExtensionFile(env))).toBe(false);
	});

	it("uninstall --purge deletes the home only when delete is typed on the terminal, and otherwise changes nothing", () => {
		for (const typed of ["yes\n", "\x04"]) {
			const declined = scratchWithForeignCommand();
			const no = inTerminal(`${shellCommand("uninstall", "--purge")} < /dev/null`, typed, declined.env);
			expect(no.stdout).toMatch(/This deletes every lane's memory, logins and backups in .*\. Type delete to go ahead:/);
			expect(no.stdout).toContain("Not uninstalled: you did not type delete; nothing changed.");
			expect(no.status).toBe(1);
			expect(existsSync(join(declined.env.ORRERY_HOME as string, "app", "current"))).toBe(true);
		}
		const confirmed = scratchWithForeignCommand();
		const yes = inTerminal(`${shellCommand("uninstall", "--purge")} < /dev/null`, "delete\n", confirmed.env);
		expect(yes.stdout).toContain(`Deleted ${confirmed.env.ORRERY_HOME}.`);
		expect(yes.status, yes.stdout).toBe(0);
		expect(existsSync(confirmed.env.ORRERY_HOME as string)).toBe(false);
		expect(existsSync(confirmed.link)).toBe(true); // not Orrery's link: left
	});

	it("uninstall --purge with no terminal says so and changes nothing", () => {
		const { env } = scratchWithForeignCommand();
		const r = withoutTerminal(["uninstall", "--purge"], env);
		expect(r.status).toBe(1);
		expect(r.stdout).toContain("Not uninstalled: there is no terminal to ask before deleting");
		expect(existsSync(join(env.ORRERY_HOME as string, "app", "current"))).toBe(true);
	});

	it("--yes answers yes without a terminal", () => {
		const { env, link } = scratchWithForeignCommand({ pi: true });
		const r = withoutTerminal(["setup", "--yes"], env);
		expect(r.status, r.stdout + r.stderr).toBe(0);
		expect(readlinkSync(link)).toBe(commandTarget(env));
		expect(readFileSync(piExtensionFile(env), "utf8")).toContain(join(env.ORRERY_HOME as string, "app", "current", "extensions", "pi.js"));
	});

	/**
	 * Asks one question, then opens files at once, waits, and writes to them; prints what it wrote and any descriptor
	 * the question left open. Stream wrappers on the /dev/tty descriptor closed it again on their own schedule (Bun),
	 * which could close a file opened after the question, or left terminal descriptors open (Node).
	 */
	const ASK_THEN_WRITE = [
		'import { closeSync, openSync, readdirSync, readlinkSync, writeSync } from "node:fs";',
		"const open = () => new Set(readdirSync('/proc/self/fd').map((fd) => { try { return `${fd}=${readlinkSync(`/proc/self/fd/${fd}`)}`; } catch { return fd; } }));",
		"const before = open();",
		"const { terminalConfirm } = await import(process.argv[2]);",
		'const yes = await terminalConfirm({ yes: false, say: (line) => console.log(line) })("go on?");',
		'const fds = [0, 1, 2].map((i) => openSync(`${process.argv[3]}.${i}`, "w"));',
		"await new Promise((done) => setTimeout(done, 50));",
		"for (const fd of fds) writeSync(fd, `answer ${yes}\\n`);",
		"for (const fd of fds) closeSync(fd);",
		"await new Promise((done) => setTimeout(done, 50));",
		"const left = [...open()].filter((fd) => !before.has(fd) && /tty|pts/.test(fd));",
		"console.log(`wrote ${fds.length} answer ${yes}; left open: ${left.join(' ') || 'none'}`);",
	].join("\n");

	const runtimes: [string, string[]][] = [["node", [process.execPath, "--disable-warning=ExperimentalWarning"]], ...(bunReady ? [["bun", ["bun"]] as [string, string[]]] : [])];
	for (const [name, runtime] of runtimes) {
		it.skipIf(!existsSync("/proc/self/fd"))(`a file opened right after a question stays usable, and the question leaves no descriptor open (${name})`, () => {
			const dir = tempDir("orrery-ask-fd-");
			const script = join(dir, "ask-then-write.ts");
			writeFileSync(script, ASK_THEN_WRITE);
			const bun = name === "bun" ? (process.env.PATH ?? "").split(":").map((d) => join(d, "bun")).find((file) => existsSync(file)) : undefined;
			const command = [...(bun === undefined ? runtime : [bun]), script, ASK, join(dir, "out")].map(quote).join(" ");
			// The double close was a race (about 1 run in 30 under Bun here); several runs make a miss less likely.
			for (let run = 0; run < 5; run++) {
				const r = inTerminal(`${command} < /dev/null`, "y\n", { HOME: dir, PATH: scratchPath() });
				expect(r.stdout, r.stdout + r.stderr).toContain("wrote 3 answer true; left open: none");
				expect(r.status, r.stdout).toBe(0);
			}
		});
	}
});
