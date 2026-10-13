import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { type Component, type Terminal, TuiAltScreen } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { restoreOnSignals, stopTui, tuiConfigPath, useConfigOption } from "../../src/tui/run.ts";

/** A Terminal that records what is written to it. */
class FakeTerminal implements Terminal {
	readonly writes: string[] = [];
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	get columns(): number {
		return 80;
	}
	get rows(): number {
		return 24;
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

describe("restoring the terminal", () => {
	it("leaves the alternate screen even when the page cannot draw", () => {
		const terminal = new FakeTerminal();
		const tui = new TuiAltScreen(terminal);
		const broken: Component = {
			render: () => {
				throw new Error("cannot draw");
			},
			invalidate: () => {},
		};
		tui.addChild(broken);
		tui.start();
		expect(terminal.writes.join("")).toContain("\x1b[?1049h");
		expect(() => stopTui(tui)).not.toThrow();
		expect(terminal.writes.join("")).toContain("\x1b[?1049l");
	});
});

describe("the config the TUI uses", () => {
	it("sets ORRERY_CONFIG to --config's absolute path, so a launched tool and first run use the same config", () => {
		const env: NodeJS.ProcessEnv = { ORRERY_CONFIG: "/other/config.toml" };
		useConfigOption("scratch/config.toml", env);
		expect(env.ORRERY_CONFIG).toBe(resolve("scratch/config.toml"));
		expect(tuiConfigPath("scratch/config.toml")).toBe(resolve("scratch/config.toml"));
		const untouched: NodeJS.ProcessEnv = { ORRERY_CONFIG: "/other/config.toml" };
		useConfigOption(undefined, untouched);
		expect(untouched).toEqual({ ORRERY_CONFIG: "/other/config.toml" });
	});
});

describe("signals", () => {
	it("restores the terminal on SIGTERM and SIGHUP, then exits; the handlers go on a normal exit", () => {
		for (const [signal, code] of [["SIGTERM", 143], ["SIGHUP", 129]] as const) {
			const target = new EventEmitter();
			const done: string[] = [];
			const release = restoreOnSignals(() => done.push("restore"), (c) => done.push(`exit ${c}`), target);
			expect(target.listenerCount(signal)).toBe(1);
			target.emit(signal, signal);
			expect(done).toEqual(["restore", `exit ${code}`]);
			release();
			expect(target.listenerCount("SIGTERM") + target.listenerCount("SIGHUP")).toBe(0);
		}
	});
});
