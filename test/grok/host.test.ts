import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { ProcessInfo } from "../../src/agent/process.ts";
import { grokPid } from "../../src/grok/host.ts";

const HOST = new URL("../../src/grok/host.ts", import.meta.url).pathname;

describe("grokPid", () => {
	it("is the hook's parent, the grok program, passing over shells that did not exec; never past the program to npm's launcher", () => {
		// As seen live: npm's launcher (node), the program it runs (grok), and a hook started by a shell that did not exec.
		const tree: Record<number, ProcessInfo> = {
			10: { ppid: 1, name: "bash" },
			20: { ppid: 10, name: "node" },
			30: { ppid: 20, name: "grok" },
			40: { ppid: 30, name: "sh" },
			50: { ppid: 40, name: "bash" },
			60: { ppid: 30, name: "orrery" },
		};
		const info = (pid: number) => tree[pid];
		expect(grokPid(30, info)).toBe(30);
		expect(grokPid(40, info)).toBe(30);
		expect(grokPid(50, info)).toBe(30);
		expect(grokPid(60, info)).toBe(60);
		expect(grokPid(99, info)).toBe(99);
	});

	it.skipIf(process.platform !== "linux" && process.platform !== "darwin")("finds the real process above a shell that runs the hook", () => {
		const script = `import(${JSON.stringify(HOST)}).then((m) => process.stdout.write(String(m.grokPid())))`;
		const node = `${JSON.stringify(process.execPath)} --disable-warning=ExperimentalWarning -e ${JSON.stringify(script)}`;
		const nested = spawnSync("/bin/sh", ["-c", `${node}; :`], { encoding: "utf8" });
		expect(Number(nested.stdout), nested.stderr).toBe(process.pid);
	});
});
