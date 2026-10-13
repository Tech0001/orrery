import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("demo command arguments cannot bypass the throwaway home", async () => {
	const home = mkdtempSync(join(tmpdir(), "orrery-demo-cli-"));
	const config = join(home, ".config", "orrery", "config.toml");
	mkdirSync(join(home, ".config", "orrery"), { recursive: true });
	writeFileSync(config, "# synthetic existing config: leave this alone\n");
	const child = spawn(process.execPath, [new URL("../../scripts/demo.ts", import.meta.url).pathname, "--child"], {
		cwd: home,
		env: { HOME: home, TMPDIR: home, TERM: "dumb", ORRERY_CONFIG: config },
	});
	let output = "";
	let quitting = false;
	child.stdout.on("data", (chunk) => {
		output += String(chunk);
		if (!quitting && output.includes("Bellwick")) { quitting = true; child.stdin.write("q"); }
	});
	child.stderr.on("data", (chunk) => { output += String(chunk); });
	// Stay inside the test's own limit (longer on CI, where a cold start of the demo is slower).
	const timer = setTimeout(() => child.kill("SIGTERM"), process.env.CI ? 50_000 : 15_000);
	try {
		const code = await new Promise<number | null>((done, fail) => { child.once("close", done); child.once("error", fail); });
		expect(code, output).toBe(0);
		expect(output).toContain("Bellwick");
		expect(readFileSync(config, "utf8")).toBe("# synthetic existing config: leave this alone\n");
		expect(readdirSync(home).filter((name) => name.startsWith("orrery-demo-"))).toEqual([]);
	} finally {
		clearTimeout(timer);
		rmSync(home, { recursive: true, force: true });
	}
});
