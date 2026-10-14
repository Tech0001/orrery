import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { entries, ENTRY_TAILS } from "../../src/install/layout.ts";
import { cleanupScratch, tempDir } from "./support.ts";

afterEach(cleanupScratch);

describe("entries", () => {
	it("a release folder (bin/orrery) is the binary style; anything else the source style; current is kept in the path", () => {
		const app = join(tempDir("orrery-layout-"), "app");
		mkdirSync(join(app, "0.6.0", "bin"), { recursive: true });
		writeFileSync(join(app, "0.6.0", "bin", "orrery"), "", { mode: 0o755 });
		mkdirSync(join(app, "0.5.0-9d7452f", "src"), { recursive: true });
		symlinkSync("0.6.0", join(app, "current"));
		const current = join(app, "current");
		expect(entries(current)).toEqual({ style: "binary", cli: join(current, "bin", "orrery"), pi: join(current, "extensions", "pi.js"), omp: join(current, "extensions", "omp.js") });
		expect(entries(join(app, "0.5.0-9d7452f")).style).toBe("source");
		expect(entries(join(app, "0.5.0-9d7452f")).pi).toBe(join(app, "0.5.0-9d7452f", "src", "pi", "index.ts"));
		expect(entries(join(app, "0.5.0-9d7452f"))).toEqual({
			style: "source",
			cli: join(app, "0.5.0-9d7452f", "src", "cli", "main.ts"),
			pi: join(app, "0.5.0-9d7452f", "src", "pi", "index.ts"),
			omp: join(app, "0.5.0-9d7452f", "src", "omp", "index.ts"),
		});
	});

	it("lists both styles' tails, binary first", () => {
		expect(ENTRY_TAILS).toEqual({
			cli: [join("bin", "orrery"), join("src", "cli", "main.ts")],
			pi: [join("extensions", "pi.js"), join("src", "pi", "index.ts")],
			omp: [join("extensions", "omp.js"), join("src", "omp", "index.ts")],
		});
	});
});
