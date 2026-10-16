import { rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";
import { cutNotice, instructionsSection, writeInstructions } from "../../src/agent/instructions.ts";
import { CODEX_ARG_MAX, CODEX_HOOKS, codexArgs, codexCutNotice, codexLaunch, type CodexEvent, misplacedSubcommand, shellWords, tomlString, trustHash, trustKey } from "../../src/codex/launch.ts";
import { tempDir } from "../agent/support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function agentDir(): string {
	const dir = tempDir("orrery-codex-launch-");
	dirs.push(dir);
	return dir;
}

/** The value of one `-c key=value`, read as Codex reads it: TOML. */
function value(flag: string): unknown {
	const at = flag.indexOf("=");
	return (parse(`v = ${flag.slice(at + 1)}`) as { v: unknown }).v;
}

/** Each `-c` flag's key and its value as TOML reads it. */
function flags(args: readonly string[]): Map<string, unknown> {
	const out = new Map<string, unknown>();
	for (let i = 0; i < args.length; i++) {
		if (args[i] !== "-c") continue;
		const flag = args[++i] as string;
		out.set(flag.slice(0, flag.indexOf("=")), value(flag));
	}
	return out;
}

const ORRERY = ["/opt/orrery/bin/orrery"];

describe("Codex's hook trust values", () => {
	/**
	 * What Codex 0.162.1 itself computed for these hooks (app-server hooks/list, currentHash), given by -c in a scratch
	 * CODEX_HOME. test/codex/real-codex.test.ts asks the installed Codex again, for these and for Orrery's own hooks.
	 */
	const CODEX_0_162_1: readonly { event: CodexEvent; matcher?: string; hook: Parameters<typeof trustHash>[1]; key: string; hash: string }[] = [
		{ event: "SessionStart", hook: { command: "/opt/orrery/bin/orrery codex-hook session-start", timeout: 30, additionalContextLimit: 0 }, key: "session_start:0:0", hash: "dc05d5f052e7f3cdd48b5fae85ca11e3f3de5f379e550fb8c102431de8aedb20" },
		// UserPromptSubmit and Stop take no matcher; Stop emits no context, so its limit is not part of it.
		{ event: "UserPromptSubmit", matcher: "ignored", hook: { command: "/opt/orrery/bin/orrery codex-hook user-prompt-submit", timeout: 10 }, key: "user_prompt_submit:0:0", hash: "012a104c8a71ca0f2916b74a30713b41f6b13ea45598bd8b739b19f574785286" },
		{ event: "Stop", hook: { command: "/opt/orrery/bin/orrery codex-hook stop", timeout: 10, additionalContextLimit: 0 }, key: "stop:0:0", hash: "4cc30e8297ea2e11b0addbc56c4818c4d308c0179db997f807c14c6be1b934a7" },
		// SessionEnd's timeout: 1 s when unset, at most 3 s.
		{ event: "SessionEnd", hook: { command: "/opt/orrery/bin/orrery codex-hook session-end", timeout: 3 }, key: "session_end:0:0", hash: "034697a60b6241cc05e26c31dc04d9297e46c25e8e4ff3be8983efeafe230b29" },
		{ event: "SessionEnd", hook: { command: "x", timeout: 10 }, key: "session_end:0:1", hash: "b1aa6329f3a5daf36ae487200db1136f90a884bb805ddb24a6326c98dd6f29f6" },
		{ event: "SessionEnd", hook: { command: "y" }, key: "session_end:0:2", hash: "c2ebd3a779ded21546fd35e02080a82bcbe6009d64c71dc9d994099853801417" },
		{ event: "PreToolUse", hook: { command: "/opt/orrery/bin/orrery codex-hook pre-tool-use", timeout: 10 }, key: "pre_tool_use:0:0", hash: "1537a6e3855540b2acf5be1855241037348201a6bac83599a2f8a7ab0cbd3144" },
		// A matcher, a status message, no timeout (600 s), and a command with quotes and a non-ASCII letter.
		{ event: "PreToolUse", matcher: "Bash", hook: { command: `'/home/u/my "odd" ü/orrery' codex-hook pre-tool-use`, statusMessage: "Checking" }, key: "pre_tool_use:1:0", hash: "18c02378278e7030adbe1df57904d254b83dc15c1f52e7493eaa2ef0f7fa8c72" },
		{ event: "PostToolUse", matcher: "apply_patch", hook: { command: "z", timeout: 5, additionalContextLimit: 100 }, key: "post_tool_use:0:0", hash: "c8ca0f83da2d67aa59499c5171e85554c1c235b802a515e35e3e2728d1cbc5c1" },
		// A timeout of 0 counts as 1 s.
		{ event: "PreCompact", hook: { command: "w", timeout: 0 }, key: "pre_compact:0:0", hash: "0682d41e291f1dceb777eea8a31f433f3c625bc2bc942a68fec8169d182cc2a7" },
		// 2,500 tokens is the default limit: it is left out.
		{ event: "SubagentStart", hook: { command: "v", additionalContextLimit: 2500 }, key: "subagent_start:0:0", hash: "1c7789bc1ad4ac696620c30c09aa012d2eff1ac450cfa79597f538cfa9de8193" },
	];

	it.each(CODEX_0_162_1)("matches Codex 0.162.1's own value for $event ($key)", ({ event, matcher, hook, key, hash }) => {
		expect(trustHash(event, hook, matcher)).toBe(`sha256:${hash}`);
		const [group, handler] = key.split(":").slice(1).map(Number);
		expect(trustKey(event, group, handler)).toBe(`/<session-flags>/config.toml:${key}`);
	});
});

describe("codexLaunch", () => {
	it("hooks, their trust values, the memory server, instructions and features, all by -c, after --no-daemon", () => {
		const dir = agentDir();
		writeInstructions(dir, "Keep answers short.\n");
		const launch = codexLaunch({ name: "Atlas", dir }, ["/opt/my orrery/bin/orrery"]);
		expect(launch.args[0]).toBe("--no-daemon");
		expect(launch.args.slice(1)).toEqual(launch.config);
		expect(launch.notices).toEqual([]);
		// Every -c has its value in the next argument.
		expect(launch.config.filter((_, i) => i % 2 === 0).every((word) => word === "-c")).toBe(true);
		const c = flags(launch.config);
		const command = (event: string) => `'/opt/my orrery/bin/orrery' codex-hook ${event}`;
		expect(c.get("hooks.SessionStart")).toEqual([{ hooks: [{ type: "command", command: command("session-start"), timeout: 30, additionalContextLimit: 0 }] }]);
		expect(c.get("hooks.UserPromptSubmit")).toEqual([{ hooks: [{ type: "command", command: command("user-prompt-submit"), timeout: 10 }] }]);
		expect(c.get("hooks.Stop")).toEqual([{ hooks: [{ type: "command", command: command("stop"), timeout: 10 }] }]);
		expect(c.get("hooks.SessionEnd")).toEqual([{ hooks: [{ type: "command", command: command("session-end"), timeout: 3 }] }]);
		expect(c.get("hooks.PreToolUse")).toEqual([{ hooks: [{ type: "command", command: command("pre-tool-use"), timeout: 10 }] }]);
		// One inline table: -c splits keys on ".", and each trust key holds "config.toml". enabled=true outweighs a hook
		// turned off in Codex's /hooks screen, which the person's config keeps under the same key.
		expect(c.get("hooks.state")).toEqual(
			Object.fromEntries(CODEX_HOOKS.map((hook) => [trustKey(hook.event), { enabled: true, trusted_hash: trustHash(hook.event, { command: command(hook.arg), timeout: hook.timeout, ...(hook.additionalContextLimit === undefined ? {} : { additionalContextLimit: hook.additionalContextLimit }) }) }])),
		);
		expect(Object.keys(c.get("hooks.state") as object)).toHaveLength(5);
		// MCP servers inherit no environment: the agent, its token and where Orrery's config is are passed by name. The
		// server is Codex's: ORRERY_AGENT's agent only.
		expect(c.get("mcp_servers.orrery")).toEqual({
			command: "/opt/my orrery/bin/orrery",
			args: ["mcp", "--tool", "codex"],
			env_vars: ["ORRERY_AGENT", "ORRERY_AGENT_TOKEN", "ORRERY_CONFIG", "ORRERY_HOME"],
			default_tools_approval_mode: "approve",
		});
		expect(c.get("developer_instructions")).toBe(instructionsSection("Atlas", { text: "Keep answers short.\n", cut: false, at: 0 }));
		expect(c.get("features.memories")).toBe(false);
		expect(c.get("features.unified_exec_tty")).toBe(false);
		expect(c.get("features.hooks")).toBe(true);
		expect([...c.keys()]).toEqual([
			"hooks.SessionStart",
			"hooks.UserPromptSubmit",
			"hooks.Stop",
			"hooks.SessionEnd",
			"hooks.PreToolUse",
			"hooks.state",
			"mcp_servers.orrery",
			"developer_instructions",
			"features.memories",
			"features.unified_exec_tty",
			"features.hooks",
		]);
	});

	it("puts Orrery's flags after a session subcommand, where Codex applies them to the session, else before", () => {
		const launch = codexLaunch({ name: "Atlas", dir: agentDir() }, ORRERY);
		for (const sub of ["exec", "e", "review"]) {
			expect(codexArgs(launch, [sub, "--last", "go"])).toEqual(["--no-daemon", sub, ...launch.config, "--last", "go"]);
		}
		// resume and fork take --no-daemon of their own: a resumed session never joins Codex's shared server.
		for (const sub of ["resume", "fork"]) {
			expect(codexArgs(launch, [sub, "--last", "go"])).toEqual(["--no-daemon", sub, "--no-daemon", ...launch.config, "--last", "go"]);
		}
		expect(codexArgs(launch, ["exec", "resume", "--last"])).toEqual(["--no-daemon", "exec", ...launch.config, "resume", "--last"]);
		// The TUI, with a prompt or not, and every other subcommand: before the person's arguments.
		for (const args of [[], ["fix the tests"], ["debug", "prompt-input"], ["mcp", "list"]]) {
			expect(codexArgs(launch, args)).toEqual([...launch.args, ...args]);
		}
	});

	it("finds a session subcommand that comes after Codex's options, where Orrery's flags can't follow it", () => {
		expect(misplacedSubcommand(["-m", "gpt-x", "exec", "go"])).toBe("exec");
		expect(misplacedSubcommand(["-c", "k=v", "resume", "--last"])).toBe("resume");
		expect(misplacedSubcommand(["-p", "work", "e", "go"])).toBe("e");
		expect(misplacedSubcommand(["-s", "read-only", "review"])).toBe("review");
		expect(misplacedSubcommand(["--no-alt-screen", "fork", "--last"])).toBe("fork");
		expect(misplacedSubcommand(["--model=gpt-x", "--search", "exec"])).toBe("exec");
		expect(misplacedSubcommand(["-mgpt-x", "exec"])).toBe("exec");
		expect(misplacedSubcommand(["-i", "a.png", "-C", "/work", "--add-dir", "/data", "--enable", "x", "exec"])).toBe("exec");
		// An option's value is not a subcommand: a folder, profile or model may be named so.
		for (const args of [["-C", "review"], ["-p", "exec"], ["-m", "exec", "go"], ["--add-dir", "resume"], ["--cd", "fork"], ["-a", "review", "go"], ["--remote", "e"], ["--local-provider", "exec"], ["--remote-auth-token-env", "exec"], ["--disable", "fork"], ["--image", "exec"], ["--sandbox", "review"], ["--profile", "exec"], ["--config", "exec"]]) {
			expect(misplacedSubcommand(args), JSON.stringify(args)).toBeUndefined();
		}
		// Only the first word that is no option decides: a prompt, or anything after "--", is no subcommand.
		for (const args of [[], ["fix the tests"], ["fix", "exec"], ["--", "exec"], ["-m", "M", "--", "resume"], ["exec", "resume", "--last"], ["resume", "--last"], ["debug", "prompt-input"], ["review my exec code"]]) {
			expect(misplacedSubcommand(args), JSON.stringify(args)).toBeUndefined();
		}
	});

	it("runs a checkout's CLI through its runtime: hooks as one shell command, the server as a command and arguments", () => {
		const launch = codexLaunch({ name: "Atlas", dir: agentDir() }, ["/usr/bin/node", "--disable-warning=ExperimentalWarning", "/src/orrery/src/cli/main.ts"]);
		const c = flags(launch.config);
		expect((c.get("hooks.Stop") as { hooks: { command: string }[] }[])[0]?.hooks[0]?.command).toBe("/usr/bin/node --disable-warning=ExperimentalWarning /src/orrery/src/cli/main.ts codex-hook stop");
		expect(c.get("mcp_servers.orrery")).toMatchObject({ command: "/usr/bin/node", args: ["--disable-warning=ExperimentalWarning", "/src/orrery/src/cli/main.ts", "mcp", "--tool", "codex"] });
		// No instructions file: no developer_instructions (the person's own Codex setting stays).
		expect(c.has("developer_instructions")).toBe(false);
	});

	it("cuts a file over 32 KB with the cut notice, and never fails the launch", () => {
		const dir = agentDir();
		writeInstructions(dir, `${"x".repeat(40 * 1024)}\n`);
		const launch = codexLaunch({ name: "Atlas", dir }, ORRERY);
		expect(launch.notices).toEqual([cutNotice("Atlas")]);
		expect((flags(launch.config).get("developer_instructions") as string).length).toBe("# Agent: Atlas\n\n".length + 32 * 1024);
	});

	it("keeps the instructions argument well under Linux's 128 KiB, cutting text whose escapes would pass it", () => {
		const dir = agentDir();
		// 30,000 control characters: each is six characters once escaped (\u0001), 180 KB in all.
		writeInstructions(dir, `start ${"\u0001".repeat(30_000)} end\n`);
		const launch = codexLaunch({ name: "Atlas", dir }, ORRERY);
		expect(launch.notices).toEqual([codexCutNotice("Atlas")]);
		const arg = launch.config.find((word) => word.startsWith("developer_instructions=")) as string;
		expect(Buffer.byteLength(arg)).toBeLessThanOrEqual(CODEX_ARG_MAX);
		expect(CODEX_ARG_MAX).toBeLessThan(128 * 1024);
		const text = value(arg) as string;
		expect(text.startsWith("# Agent: Atlas\n\nstart \u0001")).toBe(true);
		expect(text.endsWith(" end\n")).toBe(false);
		for (const word of launch.args) expect(Buffer.byteLength(word)).toBeLessThan(128 * 1024);
	});

	it("reads an unreadable or blank instructions file as none", () => {
		const dir = agentDir();
		mkdirSync(join(dir, "instructions.md"));
		expect(flags(codexLaunch({ name: "Atlas", dir }, ORRERY).config).has("developer_instructions")).toBe(false);
		const blank = agentDir();
		writeFileSync(join(blank, "instructions.md"), " \n\n");
		expect(flags(codexLaunch({ name: "Atlas", dir: blank }, ORRERY).config).has("developer_instructions")).toBe(false);
	});
});

describe("quoting", () => {
	it("tomlString writes TOML basic strings that read back exactly", () => {
		const nasty = `quote " backslash \\ tab \t cr \r lf \n nul \u0000 bell \u0007 esc \u001b del \u007f c1 \u0085 é 中 🙂   end`;
		expect(value(`v=${tomlString(nasty)}`)).toBe(nasty);
		expect(tomlString("plain")).toBe('"plain"');
		// DEL must be escaped in TOML (JSON leaves it as it is).
		expect(tomlString("\u007f")).toBe('"\\u007F"');
	});

	it("shellWords quotes only words that need it, the POSIX way", () => {
		expect(shellWords(["/opt/orrery/bin/orrery", "codex-hook", "stop"])).toBe("/opt/orrery/bin/orrery codex-hook stop");
		expect(shellWords(["/home/u/my dir/orrery", "--x=a,b:c@d%e+f"])).toBe("'/home/u/my dir/orrery' --x=a,b:c@d%e+f");
		expect(shellWords(["it's", "$HOME", "a;b", "", "~/x", "*"])).toBe(`'it'\\''s' '$HOME' 'a;b' '' '~/x' '*'`);
	});
});
