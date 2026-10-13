import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "../lane/support.ts";

const EXIT = new URL("../../src/cli/exit.ts", import.meta.url).pathname;
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Runs `body` as a script whose stdout goes through a pipe nobody reads for the first 300 ms (as the Orrery mod's
 * `process.run` reads `orrery claude-mod view`), and returns what came through and the script's exit code.
 */
function slowRead(body: string): { length: number; code: number } {
	const dir = tempDir("orrery-exit-");
	dirs.push(dir);
	const script = join(dir, "script.ts");
	writeFileSync(script, body);
	const run = spawnSync("sh", ["-c", `{ "$1" --disable-warning=ExperimentalWarning "$2/script.ts"; echo $? > "$2/code"; } | { sleep 0.3; cat; }`, "sh", process.execPath, dir], {
		encoding: "utf8",
		maxBuffer: 10_000_000,
	});
	return { length: run.stdout.length, code: Number(readFileSync(join(dir, "code"), "utf8")) };
}

describe("exitWhenFlushed", () => {
	// A reply bigger than a pipe holds (64 KB) came out cut at 65,536 bytes: process.exit dropped what the pipe had not
	// taken yet.
	it("exits with the code only after all of stdout went into a pipe its reader drains late", () => {
		const run = slowRead(`import { exitWhenFlushed } from ${JSON.stringify(EXIT)};\nprocess.stdout.write("x".repeat(300_000) + "\\n");\nexitWhenFlushed(3);\n`);
		expect(run).toEqual({ length: 300_001, code: 3 });
	});
});
