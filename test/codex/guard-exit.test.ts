import { describe, expect, it } from "vitest";
import { armCodexGuard, CODEX_GUARD_DEADLINE_MS, CODEX_GUARD_WATCHDOG_MS, type GuardExitIo, isCodexGuard } from "../../src/codex/guard-exit.ts";
import { CODEX_HOOKS } from "../../src/codex/launch.ts";

/** A process that records what the guard's last line does with it. */
function fakeProcess(now = 0) {
	const listeners = new Map<string, (error: unknown) => void>();
	const done: { written: string[]; exits: number[]; timer?: { run: () => void; ms: number }; cleared: boolean } = { written: [], exits: [], cleared: false };
	const io: GuardExitIo = {
		on: (event, listener) => listeners.set(event, listener),
		writeSync: (fd, text) => done.written.push(`${fd}:${text}`),
		exit: (code) => done.exits.push(code),
		setTimeout: (run, ms) => {
			done.timer = { run, ms };
			return 1;
		},
		clearTimeout: () => {
			done.cleared = true;
		},
		now: () => now,
	};
	return { io, done, emit: (event: string, error: unknown) => listeners.get(event)?.(error) };
}

describe("the Codex guard's last line", () => {
	it("knows the guard's command line, options or not", () => {
		expect(isCodexGuard(["codex-hook", "pre-tool-use"])).toBe(true);
		expect(isCodexGuard(["--config", "/x/config.toml", "codex-hook", "pre-tool-use"])).toBe(true);
		expect(isCodexGuard(["codex-hook", "stop"])).toBe(false);
		expect(isCodexGuard(["claude-hook", "pre-tool-use"])).toBe(false);
	});

	it("turns a crash or a rejection into exit 2 with the reason on stderr, written before the exit", () => {
		for (const event of ["uncaughtException", "unhandledRejection"]) {
			const p = fakeProcess();
			armCodexGuard(p.io);
			p.emit(event, new Error("boom."));
			expect([event, p.done.written, p.done.exits]).toEqual([event, ["2:Orrery guard: this call could not be checked (boom); nothing was run"], [2]]);
		}
	});

	it("refuses when the process is still waiting at the watchdog's time, counted from the process's start", () => {
		const p = fakeProcess(1500);
		armCodexGuard(p.io);
		expect(p.done.timer?.ms).toBe(CODEX_GUARD_WATCHDOG_MS - 1500);
		p.done.timer?.run();
		expect([p.done.written, p.done.exits]).toEqual([["2:Orrery guard: this call could not be checked in time; nothing was run"], [2]]);
	});

	it("refuses once, and stands down when the guard's own answer is out", () => {
		const p = fakeProcess();
		const armed = armCodexGuard(p.io);
		armed.refuse("first");
		p.emit("uncaughtException", new Error("later"));
		expect(p.done.exits).toEqual([2]);
		const q = fakeProcess();
		armCodexGuard(q.io).disarm();
		q.emit("uncaughtException", new Error("after the answer"));
		q.done.timer?.run();
		expect([q.done.cleared, q.done.exits]).toEqual([true, []]);
	});

	it("judges well inside the PreToolUse timeout the launch sets (Codex lets a call through once it passes)", () => {
		const timeout = (CODEX_HOOKS.find((hook) => hook.event === "PreToolUse")?.timeout ?? 0) * 1000;
		expect(timeout).toBe(10_000);
		expect(CODEX_GUARD_DEADLINE_MS).toBeLessThan(CODEX_GUARD_WATCHDOG_MS);
		expect(CODEX_GUARD_WATCHDOG_MS).toBeLessThanOrEqual(timeout - 4000);
	});
});
