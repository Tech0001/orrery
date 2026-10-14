import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";

const LANE = fileURLToPath(new URL("../../src/lane/", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "orrery-running-load-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// --preserve-symlinks makes Node keep the link in import.meta.url, as pi and OMP loaders do.
it("reports the folder the module loaded from, though the link it was loaded through is switched before the first call", () => {
	// Two release folders, and a link standing in for app/current.
	for (const version of ["1.0.0", "2.0.0"]) {
		const folder = join(scratch, version);
		mkdirSync(join(folder, "lane"), { recursive: true });
		writeFileSync(join(folder, "VERSION"), `${version}\n`);
		for (const file of ["running.ts", "guard-rules.ts", "home.ts"]) copyFileSync(join(LANE, file), join(folder, "lane", file));
	}
	symlinkSync("1.0.0", join(scratch, "current"));
	const script = `
		const fs = require("node:fs");
		const path = require("node:path");
		const scratch = process.argv[1];
		import(path.join(scratch, "current", "lane", "running.ts")).then((m) => {
			fs.unlinkSync(path.join(scratch, "current"));
			fs.symlinkSync("2.0.0", path.join(scratch, "current"));
			console.log(JSON.stringify({ root: m.runningRoot(), version: m.runningVersion({}) }));
		});`;
	const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--preserve-symlinks", "-e", script, scratch], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: scratch } });
	expect(r.status, r.stderr).toBe(0);
	expect(JSON.parse(r.stdout)).toEqual({ root: join(realpathSync(scratch), "1.0.0"), version: "1.0.0" });
});
