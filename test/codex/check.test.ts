import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexCheckDetail, codexHookGate, probeHooks, readCodexCheck } from "../../src/codex/check.ts";
import { CODEX_HOOKS, codexLaunch, trustHash, trustKey, shellWords } from "../../src/codex/launch.ts";
import { tempDir } from "../agent/support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ORRERY = ["/opt/orrery/bin/orrery"];

function scene() {
	const dir = tempDir("orrery-codex-check-");
	dirs.push(dir);
	const agentDir = join(dir, "agent");
	mkdirSync(agentDir);
	const launch = codexLaunch({ name: "Atlas", dir: agentDir }, ORRERY);
	const env = { PATH: process.env.PATH ?? "", HOME: dir, ORRERY_HOME: join(dir, ".orrery") };
	return { dir, launch, env };
}

/** What Codex's hooks/list says for Orrery's hooks: every one trusted and on, unless `change` says otherwise. */
function listed(change: (hook: Record<string, unknown>) => Record<string, unknown> | undefined = (hook) => hook) {
	const hooks = CODEX_HOOKS.map((hook) => {
		const command = shellWords([...ORRERY, "codex-hook", hook.arg]);
		return change({
			key: trustKey(hook.event),
			eventName: hook.event,
			source: "sessionFlags",
			trustStatus: "trusted",
			enabled: true,
			currentHash: trustHash(hook.event, { command, timeout: hook.timeout, ...(hook.additionalContextLimit === undefined ? {} : { additionalContextLimit: hook.additionalContextLimit }) }),
			handlerType: "command",
			command,
		});
	}).filter((hook) => hook !== undefined);
	return { data: [{ cwd: "/x", hooks, warnings: [], errors: [] }] };
}

/**
 * A fake `codex app-server`: it notes its arguments and CODEX_HOME, answers initialize, then answers hooks/list with
 * `reply` (a JSON-RPC result or error), unless told to hang or to die first.
 */
function fakeCodex(dir: string, reply: { result?: unknown; error?: unknown } | "hang" | "die"): { path: string; seen: string } {
	const path = join(dir, "codex");
	const seen = join(dir, "seen.txt");
	const answer = reply === "hang" || reply === "die" ? "" : JSON.stringify({ id: 2, ...reply });
	writeFileSync(
		path,
		[
			"#!/bin/sh",
			`printf '%s\\n' "$CODEX_HOME" "$CODEX_SQLITE_HOME" "$PWD" "$@" > ${JSON.stringify(seen)}`,
			reply === "die" ? "exit 7" : "",
			"while IFS= read -r line; do",
			"  case \"$line\" in",
			`    *'"id":1'*) echo '{"id":1,"result":{"userAgent":"fake"}}'; echo '{"method":"remoteControl/status/changed","params":{}}' ;;`,
			reply === "hang" ? "    *'\"id\":2'*) sleep 30 ;;" : `    *'"id":2'*) printf '%s\\n' ${shellWords([answer])} ;;`,
			"  esac",
			"done",
		].join("\n"),
		{ mode: 0o755 },
	);
	return { path, seen };
}

describe("probeHooks", () => {
	it("asks Codex's app server for its hook list, in a scratch CODEX_HOME it removes after, with only the -c flags", async () => {
		const s = scene();
		const codex = fakeCodex(s.dir, { result: listed() });
		const result = await probeHooks(codex.path, s.launch.config, { env: { ...s.env, CODEX_SQLITE_HOME: "/home/someone/.codex-sqlite" } });
		expect(result).toEqual({ ok: true });
		const [home, sqlite, cwd, ...args] = readFileSync(codex.seen, "utf8").trimEnd().split("\n");
		// Never the person's Codex home: a scratch one, and no other CODEX_ variable that would point back at theirs.
		expect(home).toMatch(/orrery-codex-check-/);
		expect(home).not.toBe(join(s.dir, ".codex"));
		expect(sqlite).toBe("");
		expect(cwd).toMatch(/orrery-codex-check-/);
		expect(existsSync(home as string)).toBe(false);
		expect(existsSync(cwd as string)).toBe(false);
		// The app server, then exactly the flags the session gets (no --no-daemon, no arguments of the person's).
		expect(args).toEqual(["app-server", ...s.launch.config.flatMap((word) => word.split("\n"))]);
	});

	it.each([
		["untrusted", (hook: Record<string, unknown>) => (hook.eventName === "PreToolUse" ? { ...hook, trustStatus: "untrusted" } : hook), "Codex does not trust Orrery's PreToolUse hook (untrusted)"],
		["modified", (hook: Record<string, unknown>) => (hook.eventName === "SessionStart" ? { ...hook, trustStatus: "modified" } : hook), "Codex does not trust Orrery's SessionStart hook (modified)"],
		["missing", (hook: Record<string, unknown>) => (hook.eventName === "Stop" ? undefined : hook), "Codex lists no Stop hook from Orrery"],
		["turned off", (hook: Record<string, unknown>) => (hook.eventName === "SessionEnd" ? { ...hook, enabled: false } : hook), "Codex has Orrery's SessionEnd hook turned off"],
		["from elsewhere", (hook: Record<string, unknown>) => (hook.eventName === "UserPromptSubmit" ? { ...hook, source: "user" } : hook), "Codex lists no UserPromptSubmit hook from Orrery"],
	])("says what is wrong when a hook is %s", async (_, change, why) => {
		const s = scene();
		const codex = fakeCodex(s.dir, { result: listed(change) });
		expect(await probeHooks(codex.path, s.launch.config, { env: s.env })).toEqual({ ok: false, why });
	});

	it("names the first error Codex had reading the hooks", async () => {
		const s = scene();
		const result = listed();
		result.data[0] = { ...result.data[0], errors: [{ path: "/<session-flags>/config.toml", message: "invalid \u001b[31mhook" }] } as never;
		const codex = fakeCodex(s.dir, { result });
		expect(await probeHooks(codex.path, s.launch.config, { env: s.env })).toEqual({ ok: false, why: "Codex could not read the hooks: invalid [31mhook" });
	});

	it("cannot check when Codex has no hook list, dies, or does not answer in time", async () => {
		const s = scene();
		const none = fakeCodex(s.dir, { error: { code: -32601, message: "Method not found" } });
		expect(await probeHooks(none.path, s.launch.config, { env: s.env })).toEqual({ ok: false, why: "Codex could not list its hooks (Method not found)" });
		const dies = fakeCodex(s.dir, "die");
		expect(await probeHooks(dies.path, s.launch.config, { env: s.env })).toEqual({ ok: false, why: "Codex's app server stopped before answering (exit 7)" });
		const hangs = fakeCodex(s.dir, "hang");
		const started = Date.now();
		expect(await probeHooks(hangs.path, s.launch.config, { env: s.env, timeoutMs: 300 })).toEqual({ ok: false, why: "Codex's app server did not answer within 0.3 s" });
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(await probeHooks(join(s.dir, "nowhere"), s.launch.config, { env: s.env })).toMatchObject({ ok: false, why: expect.stringMatching(/^Codex's app server could not start \(.*ENOENT/) });
	});
});

describe("codexHookGate", () => {
	it("checks a Codex it has not verified, remembers the version in Orrery's home, and skips the check after that", async () => {
		const s = scene();
		const probes: string[] = [];
		const probe = async (path: string) => (probes.push(path), { ok: true as const });
		const target = { path: "/bin/codex", version: "0.162.1", config: s.launch.config };
		expect(await codexHookGate(target, { env: s.env, orrery: "0.7.0", probe })).toEqual({ ok: true });
		expect(probes).toEqual(["/bin/codex"]);
		expect(readCodexCheck(s.env)).toMatchObject({ codex: "0.162.1", orrery: "0.7.0", ok: true });
		expect(JSON.parse(readFileSync(join(s.env.ORRERY_HOME, "codex-check.json"), "utf8"))).toMatchObject({ codex: "0.162.1", orrery: "0.7.0", ok: true });
		expect(await codexHookGate(target, { env: s.env, orrery: "0.7.0", probe })).toEqual({ ok: true });
		expect(probes).toHaveLength(1);
		// Another Codex, or another Orrery, is checked again.
		expect(await codexHookGate({ ...target, version: "0.163.0" }, { env: s.env, orrery: "0.7.0", probe })).toEqual({ ok: true });
		expect(await codexHookGate({ ...target, version: "0.163.0" }, { env: s.env, orrery: "0.7.1", probe })).toEqual({ ok: true });
		expect(probes).toHaveLength(3);
	});

	it("says plainly when the hooks don't load, keeps checking until they do, and checks every time when the version is unknown", async () => {
		const s = scene();
		let ok = false;
		const probe = async () => (ok ? { ok: true as const } : { ok: false as const, why: "Codex does not trust Orrery's PreToolUse hook (untrusted)" });
		const target = { path: "/bin/codex", version: "0.163.0", config: s.launch.config };
		const gate = await codexHookGate(target, { env: s.env, orrery: "0.7.0", probe });
		expect(gate).toEqual({ ok: false, text: "Orrery's hooks don't load in Codex 0.163.0: Codex does not trust Orrery's PreToolUse hook (untrusted). Without them a session has no memory and no guard." });
		expect(readCodexCheck(s.env)).toMatchObject({ codex: "0.163.0", ok: false, why: "Codex does not trust Orrery's PreToolUse hook (untrusted)" });
		ok = true;
		expect(await codexHookGate(target, { env: s.env, orrery: "0.7.0", probe })).toEqual({ ok: true });
		let probes = 0;
		const counted = async () => (probes++, { ok: true as const });
		await codexHookGate({ ...target, version: undefined }, { env: s.env, orrery: "0.7.0", probe: counted });
		await codexHookGate({ ...target, version: undefined }, { env: s.env, orrery: "0.7.0", probe: counted });
		expect(probes).toBe(2);
		expect(readCodexCheck(s.env)).toMatchObject({ codex: "0.163.0", ok: true });
	});

	it("goes on when the state cannot be written, and reads a broken state file as none", async () => {
		const s = scene();
		mkdirSync(s.env.ORRERY_HOME);
		writeFileSync(join(s.env.ORRERY_HOME, "codex-check.json"), "{not json");
		expect(readCodexCheck(s.env)).toBeUndefined();
		rmSync(join(s.env.ORRERY_HOME, "codex-check.json"));
		mkdirSync(join(s.env.ORRERY_HOME, "codex-check.json"));
		const gate = await codexHookGate({ path: "/bin/codex", version: "0.162.1", config: s.launch.config }, { env: s.env, orrery: "0.7.0", probe: async () => ({ ok: true }) });
		expect(gate).toEqual({ ok: true });
	});
});

describe("codexCheckDetail (the Tools page)", () => {
	it("says which Codex the hooks were checked with, and what happens next", async () => {
		const s = scene();
		expect(codexCheckDetail(s.env, "0.162.1", "0.7.0")).toBe("hooks are checked at the first launch");
		await codexHookGate({ path: "/bin/codex", version: "0.162.1", config: s.launch.config }, { env: s.env, orrery: "0.7.0", probe: async () => ({ ok: true }) });
		expect(codexCheckDetail(s.env, "0.162.1", "0.7.0")).toBe("hooks checked with Codex 0.162.1");
		expect(codexCheckDetail(s.env, "0.163.0", "0.7.0")).toBe("hooks checked with Codex 0.162.1; 0.163.0 is checked at its first launch");
		expect(codexCheckDetail(s.env, "0.162.1", "0.7.1")).toBe("hooks checked with Codex 0.162.1 by Orrery 0.7.0; checked again at the next launch");
		expect(codexCheckDetail(s.env, undefined, "0.7.0")).toBe("hooks checked with Codex 0.162.1; this Codex is checked at each launch");
		await codexHookGate({ path: "/bin/codex", version: "0.163.0", config: s.launch.config }, { env: s.env, orrery: "0.7.0", probe: async () => ({ ok: false, why: "Codex lists no Stop hook from Orrery" }) });
		expect(codexCheckDetail(s.env, "0.163.0", "0.7.0")).toBe("hooks did not load in Codex 0.163.0: Codex lists no Stop hook from Orrery");
	});
});
