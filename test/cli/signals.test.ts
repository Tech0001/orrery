import { afterEach, describe, expect, it } from "vitest";
import { SignalStop, stopOnSignals } from "../../src/cli/signals.ts";

const disposers: (() => void)[] = [];
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
});

describe("stopOnSignals", () => {
	it("turns SIGTERM into a graceful stop and a second signal into an immediate exit", () => {
		const controller = new AbortController();
		const exits: number[] = [];
		disposers.push(stopOnSignals(controller, (code) => exits.push(code)));
		process.emit("SIGTERM");
		expect(controller.signal.aborted).toBe(true);
		expect(controller.signal.reason).toBeInstanceOf(SignalStop);
		expect((controller.signal.reason as SignalStop).signal).toBe("SIGTERM");
		expect(exits).toEqual([]);
		process.emit("SIGHUP");
		expect(exits).toEqual([129]);
	});

	it("treats SIGHUP (tmux kill-server) the same way, and stops listening once disposed", () => {
		const controller = new AbortController();
		const exits: number[] = [];
		const dispose = stopOnSignals(controller, (code) => exits.push(code));
		process.emit("SIGHUP");
		expect((controller.signal.reason as SignalStop).signal).toBe("SIGHUP");
		dispose();
		expect(process.listenerCount("SIGHUP")).toBe(0);
		expect(process.listenerCount("SIGTERM")).toBe(0);
	});

	it("leaves a stop that already happened (a fatal error) alone", () => {
		const controller = new AbortController();
		controller.abort(new Error("store poisoned"));
		const exits: number[] = [];
		disposers.push(stopOnSignals(controller, (code) => exits.push(code)));
		process.emit("SIGTERM");
		expect(controller.signal.reason).toBeInstanceOf(Error);
		expect(exits).toEqual([143]);
	});
});
