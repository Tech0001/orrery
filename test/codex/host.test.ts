import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { codexPid, type ProcessInfo, processInfo } from "../../src/codex/host.ts";

const HOST = new URL("../../src/codex/host.ts", import.meta.url).pathname;

describe("codexPid", () => {
	it("is the parent when that is no shell, and passes over shells that did not exec", () => {
		const tree: Record<number, ProcessInfo> = {
			10: { ppid: 1, name: "systemd" },
			20: { ppid: 10, name: "codex" },
			30: { ppid: 20, name: "bash" },
			40: { ppid: 30, name: "zsh" },
			50: { ppid: 20, name: "node" },
		};
		const info = (pid: number) => tree[pid];
		expect(codexPid(20, info)).toBe(20);
		expect(codexPid(30, info)).toBe(20);
		expect(codexPid(40, info)).toBe(20);
		expect(codexPid(50, info)).toBe(50);
		// A process that cannot be read, or a shell whose parent is init, stays as it is.
		expect(codexPid(99, info)).toBe(99);
		expect(codexPid(7, () => ({ ppid: 1, name: "bash" }))).toBe(7);
	});

	it.skipIf(process.platform !== "linux" && process.platform !== "darwin")("finds the real process above a shell that runs the hook, and above none when the shell execs", () => {
		const script = `import(${JSON.stringify(HOST)}).then((m) => process.stdout.write(String(m.codexPid())))`;
		const node = `${JSON.stringify(process.execPath)} --disable-warning=ExperimentalWarning -e ${JSON.stringify(script)}`;
		// sh runs the node and then ":", so it cannot exec: node's parent is sh, whose parent is this process.
		const nested = spawnSync("/bin/sh", ["-c", `${node}; :`], { encoding: "utf8" });
		expect(Number(nested.stdout), nested.stderr).toBe(process.pid);
		const direct = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "-e", script], { encoding: "utf8" });
		expect(Number(direct.stdout), direct.stderr).toBe(process.pid);
		expect(processInfo(process.pid)?.ppid).toBe(process.ppid);
	});
});
