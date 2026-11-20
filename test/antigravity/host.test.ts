import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agyPid, isAgy, ownConversation, validConversation } from "../../src/antigravity/host.ts";
import { agyFolder, agyTranscript, isAgyProcess } from "../../src/antigravity/names.ts";
import { tempDir } from "../agent/support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const home = () => {
	const dir = tempDir("orrery-agy-home-");
	dirs.push(dir);
	return dir;
};
const C = "e6f5acd5-ee5c-4b2b-b2c4-bbcbda5781a2";
const presence = (h: string, id = C) => {
	const folder = agyFolder(h) as string;
	mkdirSync(join(folder, "presence"), { recursive: true });
	const lock = join(folder, "presence", `${id}.lock`);
	writeFileSync(lock, "");
	return lock;
};

describe("Antigravity's process", () => {
	it("is the program named antigravity (mise's install) or agy, by the file it runs", () => {
		expect(isAgyProcess("antigravity")).toBe(true);
		expect(isAgyProcess("agy")).toBe(true);
		expect(isAgyProcess("bash")).toBe(false);
		expect(isAgy(7, () => "/home/u/.local/share/mise/installs/antigravity-cli/1.5.13/antigravity")).toBe(true);
		expect(isAgy(7, () => "/usr/bin/python3")).toBe(false);
		expect(isAgy(7, () => undefined)).toBe(false);
	});

	it("is the hook's parent, past shells; an orphaned shell has none", () => {
		const tree: Record<number, { ppid: number; name: string }> = { 10: { ppid: 9, name: "sh" }, 9: { ppid: 8, name: "antigravity" }, 20: { ppid: 1, name: "bash" } };
		expect(agyPid(10, (pid) => tree[pid])).toBe(9);
		expect(agyPid(20, (pid) => tree[pid])).toBeUndefined();
	});

	it("takes conversation ids that are UUIDs", () => {
		expect(validConversation(C)).toBe(true);
		expect(validConversation("../x")).toBe(false);
		expect(validConversation("abc")).toBe(false);
	});
});

describe("a conversation as agy's own", () => {
	it("is one whose presence lock agy holds open for writing under the folder it was started with", () => {
		const h = home();
		const lock = presence(h);
		const own = ownConversation(1, C, h, () => [{ path: lock, writes: true }]);
		// The folder as it really is (macOS's temp folder is under /private).
		const folder = realpathSync(agyFolder(h) as string);
		expect(own).toEqual({ folder, transcript: agyTranscript(folder, C) });
	});

	it("is refused when agy holds it only to read, more than once, not at all, or the system can't tell", () => {
		const h = home();
		const lock = presence(h);
		expect(ownConversation(1, C, h, () => [{ path: lock, writes: false }])).toBe("Antigravity doesn't have it open for writing");
		expect(ownConversation(1, C, h, () => [{ path: lock }])).toBe("this system can't tell whether Antigravity has it open for writing");
		expect(ownConversation(1, C, h, () => [{ path: lock, writes: true }, { path: lock, writes: true }])).toBe("Antigravity has it open more than once");
		expect(ownConversation(1, C, h, () => [])).toBe("Antigravity doesn't have it open");
		expect(ownConversation(1, C, h, () => undefined)).toBe("this system can't tell which files Antigravity has open");
	});

	it("is refused for a lock under another folder (a file the agent made), a HOME that names none, or a bad id", () => {
		const h = home();
		presence(h);
		const other = home();
		const elsewhere = presence(other);
		expect(ownConversation(1, C, h, () => [{ path: elsewhere, writes: true }])).toBe("Antigravity doesn't have it open");
		expect(ownConversation(1, C, undefined, () => [])).toBe("Antigravity's environment names no HOME");
		expect(ownConversation(1, C, "relative", () => [])).toBe("Antigravity's environment names no HOME");
		expect(ownConversation(1, "../../x", h, () => [])).toBe("the conversation id is no Antigravity id");
	});

	it("is refused when its record's folder is a link", () => {
		const h = home();
		const lock = presence(h);
		const folder = agyFolder(h) as string;
		const target = home();
		mkdirSync(join(folder, "brain"), { recursive: true });
		symlinkSync(target, join(folder, "brain", C));
		expect(ownConversation(1, C, h, () => [{ path: lock, writes: true }])).toBe("its record is a link, or has one on the way");
	});
});
