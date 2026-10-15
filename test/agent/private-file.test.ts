import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writePrivate } from "../../src/agent/private-file.ts";
import { tempDir } from "./support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp(): string {
	const dir = tempDir("orrery-private-");
	dirs.push(dir);
	return dir;
}

describe("writePrivate", () => {
	it("writes whole files, 0600 in a 0700 folder, and leaves no temporary file", () => {
		const dir = temp();
		writePrivate(join(dir, "a", "b.json"), "one");
		writePrivate(join(dir, "a", "b.json"), "two");
		expect(readFileSync(join(dir, "a", "b.json"), "utf8")).toBe("two");
		expect(statSync(join(dir, "a", "b.json")).mode & 0o777).toBe(0o600);
		expect(statSync(join(dir, "a")).mode & 0o777).toBe(0o700);
		expect(readdirSync(join(dir, "a"))).toEqual(["b.json"]);
	});

	it("refuses a folder that is a symlink: nothing lands in its target, whose mode stays as it was", () => {
		const dir = temp();
		const outside = join(dir, "outside");
		mkdirSync(outside);
		chmodSync(outside, 0o755); // not through mkdir's mode, which the umask trims
		symlinkSync(outside, join(dir, "link"));
		expect(() => writePrivate(join(dir, "link", "view.md"), "private")).toThrow(/not a real folder/);
		expect(readdirSync(outside)).toEqual([]);
		expect(statSync(outside).mode & 0o777).toBe(0o755);
	});

	it("can leave the folder's mode alone, for a folder that is not Orrery's own (a folder, a repo's .git/info)", () => {
		const dir = temp();
		mkdirSync(join(dir, "ws"));
		chmodSync(join(dir, "ws"), 0o755);
		writePrivate(join(dir, "ws", "CLAUDE.md"), "text", { keepFolderMode: true });
		expect(statSync(join(dir, "ws")).mode & 0o777).toBe(0o755);
		expect(statSync(join(dir, "ws", "CLAUDE.md")).mode & 0o777).toBe(0o600);
		symlinkSync(join(dir, "ws"), join(dir, "link"));
		expect(() => writePrivate(join(dir, "link", "CLAUDE.md"), "other", { keepFolderMode: true })).toThrow(/not a real folder/);
		expect(readFileSync(join(dir, "ws", "CLAUDE.md"), "utf8")).toBe("text");
	});

	it("cleans up its temporary file when the rename fails", () => {
		const dir = temp();
		mkdirSync(join(dir, "a", "b.json"), { recursive: true });
		writeFileSync(join(dir, "a", "b.json", "keep"), "x");
		expect(() => writePrivate(join(dir, "a", "b.json"), "text")).toThrow();
		expect(readdirSync(join(dir, "a"))).toEqual(["b.json"]);
	});
});
