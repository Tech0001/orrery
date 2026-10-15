import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readLines } from "../../src/import/lines.ts";
import { tempDir } from "../agent/support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function file(content: string): string {
	const dir = tempDir("orrery-lines-");
	dirs.push(dir);
	const path = join(dir, "f.jsonl");
	writeFileSync(path, content);
	return path;
}

describe("readLines", () => {
	it("streams lines across chunk boundaries without splitting multi-byte characters", () => {
		const long = `x${"é".repeat(700_000)}`; // 1.4 MB: crosses the 1 MiB read size mid-character
		expect([...readLines(file(`a\n${long}\n\nccc`))]).toEqual(["a", long, "", "ccc"]);
	});

	it("closes the file when the caller stops early", () => {
		const path = file("first\nsecond\n");
		// /dev/fd lists this process's open files on both Linux and macOS (/proc exists only on Linux).
		const openFds = () => readdirSync("/dev/fd").length;
		const before = openFds();
		for (const line of readLines(path)) {
			expect(line).toBe("first");
			break;
		}
		expect(openFds()).toBe(before);
	});
});
