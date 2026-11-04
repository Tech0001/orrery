import { closeSync, openSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openFiles, parseLsofFiles } from "../../src/agent/open-files.ts";
import { processEnv } from "../../src/agent/process.ts";
import { tempDir } from "./support.ts";

const dirs: string[] = [];
const fds: number[] = [];
afterEach(() => {
	for (const fd of fds.splice(0)) closeSync(fd);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A file of its own for each way of opening it, opened by this process. */
function opened(): Record<"read" | "append" | "write" | "both", string> {
	const dir = tempDir("orrery-open-files-");
	dirs.push(dir);
	const files = { read: join(dir, "read"), append: join(dir, "append"), write: join(dir, "write"), both: join(dir, "both") };
	for (const path of Object.values(files)) writeFileSync(path, "");
	fds.push(openSync(files.read, "r"), openSync(files.append, "a"), openSync(files.write, "w"), openSync(files.both, "r+"));
	return files;
}

/** Whether each of `files` is open for writing, as `open` says (undefined: not listed, or not said). */
const writes = (open: ReturnType<typeof openFiles>, files: Record<string, string>) => Object.fromEntries(Object.entries(files).map(([name, path]) => [name, open?.find((file) => file.path === path)?.writes]));

describe("openFiles: how a process has each file open", () => {
	it.skipIf(process.platform !== "linux")("Linux: for writing when its descriptor's flags say write-only or read-write (/proc/<pid>/fdinfo)", () => {
		const files = opened();
		expect(writes(openFiles(process.pid), files)).toEqual({ read: false, append: true, write: true, both: true });
	});

	it.skipIf(process.platform !== "linux")("macOS's way, lsof's access mode (r, w, u), read as Linux's lsof gives it", () => {
		const files = opened();
		expect(writes(openFiles(process.pid, "darwin"), files)).toEqual({ read: false, append: true, write: true, both: true });
	});

	it("reads lsof's fields: each file's name, with the access mode said before it; none said, or one it doesn't know, is unknown", () => {
		expect(parseLsofFiles("p123\nfcwd\na \nn/home/u\nf3\naw\nn/x/a\nf4\nar\nn/x/b\nf5\nau\nn/x/c\nf6\nn/x/d\nf7\na?\nn/x/e\n")).toEqual([
			{ path: "/home/u" },
			{ path: "/x/a", writes: true },
			{ path: "/x/b", writes: false },
			{ path: "/x/c", writes: true },
			{ path: "/x/d" },
			{ path: "/x/e" },
		]);
		// A mode is the file's own: never carried to the next file.
		expect(parseLsofFiles("p1\nf3\naw\nn/x/a\nf4\nn/x/b\n")).toEqual([{ path: "/x/a", writes: true }, { path: "/x/b" }]);
	});
});

describe("processEnv withoutArgs: the environment of a process whose arguments others wrote", () => {
	it("macOS: reads only the words after the process's arguments, so a word among them is never taken for a variable it lacks", () => {
		const args = "/Users/u/.grok/bin/grok --rules GROK_HOME=/made/up HOME=/made/up";
		const asked: string[][] = [];
		const ps = (env: string, plain = args) => (arg: readonly string[]) => {
			asked.push([...arg]);
			return arg.includes("-wwE") ? `${args} ${env}\n` : `${plain}\n`;
		};
		const mac = (env: string, plain?: string) => ({ platform: "darwin" as const, withoutArgs: true, ps: ps(env, plain) });
		expect(processEnv(4242, ["GROK_HOME", "HOME"], mac("PATH=/usr/bin HOME=/Users/u"))).toEqual({ HOME: "/Users/u" });
		expect(asked).toEqual([
			["-wwE", "-o", "command=", "-p", "4242"],
			["-ww", "-o", "command=", "-p", "4242"],
		]);
		expect(processEnv(4242, ["GROK_HOME", "HOME"], mac("PATH=/usr/bin HOME=/Users/u GROK_HOME=/Users/u/g"))).toEqual({ HOME: "/Users/u", GROK_HOME: "/Users/u/g" });
		// Without it, the word among the arguments is taken: why Grok's check asks withoutArgs.
		expect(processEnv(4242, ["GROK_HOME"], { platform: "darwin", ps: ps("PATH=/usr/bin HOME=/Users/u") })).toEqual({ GROK_HOME: "/made/up" });
		// ps's two answers that don't line up, or one that fails, or an environment ps withholds: can't be read.
		expect(processEnv(4242, ["HOME"], mac("PATH=/usr/bin HOME=/Users/u", "/Users/u/.grok/bin/grok --other"))).toBeUndefined();
		expect(processEnv(4242, ["HOME"], { platform: "darwin", withoutArgs: true, ps: (arg) => (arg.includes("-wwE") ? `${args} HOME=/Users/u\n` : undefined) })).toBeUndefined();
		expect(processEnv(4242, ["HOME"], mac(""))).toBeUndefined();
	});

	it("Linux: /proc/<pid>/environ holds the environment alone, read as ever", () => {
		const read = () => "PATH=/usr/bin\0HOME=/home/u\0GROK_HOME=/g\0";
		expect(processEnv(4242, ["GROK_HOME", "HOME"], { platform: "linux", withoutArgs: true, read })).toEqual({ HOME: "/home/u", GROK_HOME: "/g" });
		// unambiguous changes nothing there: each variable is its own string, spaces and all.
		const spaced = () => "PATH=/usr/bin\0HOME=/home/u u\0ORRERY_AGENT=Atlas\0";
		expect(processEnv(4242, ["HOME", "ORRERY_AGENT"], { platform: "linux", withoutArgs: true, unambiguous: true, read: spaced })).toEqual({ HOME: "/home/u u", ORRERY_AGENT: "Atlas" });
	});

	it("macOS unambiguous: a variable asked for that stands twice, or whose value a space cut, can't be read; others don't matter", () => {
		const args = "/Users/u/.grok/bin/grok --rules x";
		const mac = (env: string) => ({ platform: "darwin" as const, withoutArgs: true, unambiguous: true, ps: (arg: readonly string[]) => (arg.includes("-wwE") ? `${args} ${env}\n` : `${args}\n`) });
		const names = ["ORRERY_AGENT", "ORRERY_AGENT_TOKEN", "HOME"];
		expect(processEnv(4242, names, mac("PATH=/usr/bin HOME=/Users/u ORRERY_AGENT=Atlas ORRERY_AGENT_TOKEN=0123"))).toEqual({ HOME: "/Users/u", ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: "0123" });
		// A variable not asked for may hold spaces; one asked for, last, with nothing after it, is whole.
		expect(processEnv(4242, names, mac("PATH=/usr/bin TERM_TITLE=a b c HOME=/Users/u ORRERY_AGENT=Atlas"))).toEqual({ HOME: "/Users/u", ORRERY_AGENT: "Atlas" });
		// Twice (a value of another variable that reads as one), or cut by a space: undefined.
		expect(processEnv(4242, names, mac("PATH=/usr/bin X=ORRERY_AGENT ORRERY_AGENT=Birch HOME=/Users/u ORRERY_AGENT=Atlas"))).toBeUndefined();
		expect(processEnv(4242, names, mac("PATH=/usr/bin HOME=/Users/u u ORRERY_AGENT=Atlas"))).toBeUndefined();
		expect(processEnv(4242, names, mac("PATH=/usr/bin HOME=/Users/u ORRERY_AGENT=At las"))).toBeUndefined();
		// Without unambiguous, as before: the last word naming one, and a value cut at its space.
		expect(processEnv(4242, ["HOME"], { ...mac("PATH=/usr/bin HOME=/Users/u u"), unambiguous: false })).toEqual({ HOME: "/Users/u" });
	});
});
