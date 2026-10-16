import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkHookShell, hookShell, NOISY_SHELL_QUESTION, noisyShellText } from "../../src/codex/shell.ts";

const scratch = mkdtempSync(join(tmpdir(), "orrery-codex-shell-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A folder of fake shells (each an executable file) for PATH. */
function bin(name: string, shells: readonly string[]): string {
	const dir = join(scratch, name);
	mkdirSync(dir, { recursive: true });
	for (const shell of shells) {
		writeFileSync(join(dir, shell), "#!/bin/sh\n");
		chmodSync(join(dir, shell), 0o755);
	}
	return dir;
}

/** A real shell on this machine, or undefined. */
const real = (name: string) => ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"].map((dir) => join(dir, name)).find((path) => spawnSync(path, ["-c", ":"]).status === 0);

describe("the shell Codex runs hooks in, picked as Codex 0.162.1 picks it", () => {
	it("is the account's own when it is bash, zsh or sh and there; else its kind on PATH", () => {
		const path = bin("own", ["bash", "zsh", "sh"]);
		expect(hookShell({ PATH: path }, { account: join(path, "zsh") })).toEqual({ path: join(path, "zsh"), kind: "zsh" });
		expect(hookShell({ PATH: path }, { account: join(path, "sh") })).toEqual({ path: join(path, "sh"), kind: "sh" });
		// The account's zsh is gone: a zsh on PATH.
		expect(hookShell({ PATH: path }, { account: "/nowhere/zsh" })).toEqual({ path: join(path, "zsh"), kind: "zsh" });
	});

	it("passes over a shell Codex doesn't know (fish, dash) for bash on Linux and zsh on macOS, and never asks $SHELL", () => {
		const path = bin("fallback", ["bash", "zsh"]);
		const env = { PATH: path, SHELL: "/usr/bin/fish" };
		expect(hookShell(env, { account: "/usr/bin/fish", platform: "linux" })).toEqual({ path: join(path, "bash"), kind: "bash" });
		expect(hookShell(env, { account: "/usr/bin/fish", platform: "darwin" })).toEqual({ path: join(path, "zsh"), kind: "zsh" });
		expect(hookShell({ PATH: path }, { account: "/bin/dash", platform: "linux" })).toEqual({ path: join(path, "bash"), kind: "bash" });
		// No account entry and nothing found: /bin/sh, as Codex's last resort.
		expect(hookShell({ PATH: bin("empty", []) }, { account: undefined, platform: "freebsd" }).path).toMatch(/\/(bash|zsh|sh)$/);
	});
});

describe("whether that shell prints when it starts", () => {
	const bash = real("bash");
	const zsh = real("zsh");

	it.skipIf(bash === undefined)("bash: quiet with no $BASH_ENV, or one that prints only blank space; else names $BASH_ENV", () => {
		const shell = { path: bash as string, kind: "bash" as const };
		const env = { PATH: process.env.PATH ?? "", HOME: scratch };
		expect(checkHookShell(env, scratch, { shell })).toEqual({ quiet: true });
		const blank = join(scratch, "blank-env");
		writeFileSync(blank, "echo; echo '   '\n");
		expect(checkHookShell({ ...env, BASH_ENV: blank }, scratch, { shell })).toEqual({ quiet: true });
		const chatty = join(scratch, "chatty-env");
		writeFileSync(chatty, 'echo "Welcome back!"\n');
		const noisy = checkHookShell({ ...env, BASH_ENV: chatty }, scratch, { shell });
		expect(noisy).toEqual({ quiet: false, shell, source: `$BASH_ENV (${chatty})` });
		expect(noisyShellText("Atlas", noisy as Extract<typeof noisy, { quiet: false }>)).toBe(
			`Codex runs Orrery's hooks through ${bash} -c, which prints when it starts (most likely from $BASH_ENV (${chatty})). Codex then can't read the hooks' answers, so Atlas's memory won't load and its status won't show until that shell prints nothing when it isn't interactive; its turns are still recorded and the guard still works.`,
		);
		expect(NOISY_SHELL_QUESTION).toBe("Start Codex anyway?");
	});

	it.skipIf(zsh === undefined)("zsh: names the .zshenv it reads", () => {
		const shell = { path: zsh as string, kind: "zsh" as const };
		const zdot = join(scratch, "zdot");
		mkdirSync(zdot, { recursive: true });
		writeFileSync(join(zdot, ".zshenv"), "print hello\n");
		expect(checkHookShell({ PATH: process.env.PATH ?? "", HOME: scratch, ZDOTDIR: zdot }, scratch, { shell })).toEqual({ quiet: false, shell, source: join(zdot, ".zshenv") });
	});

	it("counts a shell that cannot start as quiet: the check never stands in the way of what it cannot see", () => {
		expect(checkHookShell({}, scratch, { shell: { path: join(scratch, "no-such-shell"), kind: "bash" } })).toEqual({ quiet: true });
	});

	it.skipIf(bash === undefined)("counts output over its buffer as printing, even when it is all blank space", () => {
		const shell = { path: bash as string, kind: "bash" as const };
		const env = { PATH: process.env.PATH ?? "", HOME: scratch };
		for (const [name, fill] of [
			["flood-text", "x"],
			["flood-blank", " "],
		] as const) {
			const flood = join(scratch, name);
			writeFileSync(flood, `head -c 3000000 /dev/zero | tr '\\0' '${fill}'\n`);
			expect([name, checkHookShell({ ...env, BASH_ENV: flood }, scratch, { shell })]).toEqual([name, { quiet: false, shell, source: `$BASH_ENV (${flood})` }]);
		}
	});

	it.skipIf(bash === undefined)("kills a shell that runs past its time with SIGKILL, which a shell cannot ignore, and judges what it printed by then", () => {
		const shell = { path: bash as string, kind: "bash" as const };
		const env = { PATH: process.env.PATH ?? "", HOME: scratch };
		// A startup file that ignores SIGTERM and never ends: under SIGTERM the check would wait for it forever.
		const stuck = join(scratch, "stuck-env");
		writeFileSync(stuck, "trap '' TERM\nwhile :; do :; done\n");
		let started = performance.now();
		expect(checkHookShell({ ...env, BASH_ENV: stuck }, scratch, { shell, timeoutMs: 300 })).toEqual({ quiet: true });
		expect(performance.now() - started).toBeLessThan(5000);
		// One that printed first: what came out before the time ran out is printing all the same.
		const chatty = join(scratch, "chatty-stuck-env");
		writeFileSync(chatty, "echo 'Welcome back!'\ntrap '' TERM\nwhile :; do :; done\n");
		started = performance.now();
		expect(checkHookShell({ ...env, BASH_ENV: chatty }, scratch, { shell, timeoutMs: 300 })).toEqual({ quiet: false, shell, source: `$BASH_ENV (${chatty})` });
		expect(performance.now() - started).toBeLessThan(5000);
	});
});
