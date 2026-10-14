import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { cliCommand } from "../claude/support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

it("orrery tools install pi --yes keeps a copy of a foreign extension file and says where it went", () => {
	const home = mkdtempSync(join(tmpdir(), "orrery-tools-"));
	dirs.push(home);
	const bin = join(home, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "pi"), '#!/bin/sh\necho "pi 1.2.0"\n');
	chmodSync(join(bin, "pi"), 0o755);
	const file = join(home, ".pi", "agent", "extensions", "orrery.ts");
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, "// someone's own extension\n");
	const c = cliCommand(["tools", "install", "pi", "--yes"]);
	const env = { ...process.env, HOME: home, ORRERY_HOME: join(home, "orrery-home"), PI_CODING_AGENT_DIR: "", PATH: `${bin}:${process.env.PATH}` };
	const run = spawnSync(c.cmd, c.args, { encoding: "utf8", env });
	expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: "" });
	const [aside] = readdirSync(dirname(file)).filter((n) => n.startsWith("orrery.ts.before-orrery-"));
	expect(aside).toMatch(/^orrery\.ts\.before-orrery-\d{4}-\d{2}-\d{2}$/);
	expect(readFileSync(join(dirname(file), aside as string), "utf8")).toBe("// someone's own extension\n");
	expect(run.stdout).toContain(`set ${file} aside as ${join(dirname(file), aside as string)}`);
	expect(readFileSync(file, "utf8")).toMatch(/^export \{ default \} from /);
});
