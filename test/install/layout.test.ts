import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { endsWithSegments, entries, ENTRY_TAILS, inApp, isOrreryCommand, isOrreryRoot } from "../../src/install/layout.ts";
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
		expect(entries(current)).toEqual({ style: "binary", cli: join(current, "bin", "orrery"), pi: join(current, "extensions", "pi.js"), omp: join(current, "extensions", "omp.js"), opencode: join(current, "extensions", "opencode") });
		expect(entries(join(app, "0.5.0-9d7452f")).style).toBe("source");
		expect(entries(join(app, "0.5.0-9d7452f")).pi).toBe(join(app, "0.5.0-9d7452f", "src", "pi", "index.ts"));
		expect(entries(join(app, "0.5.0-9d7452f"))).toEqual({
			style: "source",
			cli: join(app, "0.5.0-9d7452f", "src", "cli", "main.ts"),
			pi: join(app, "0.5.0-9d7452f", "src", "pi", "index.ts"),
			omp: join(app, "0.5.0-9d7452f", "src", "omp", "index.ts"),
			// A source copy's OpenCode plugin folder holds only the plugin's entry (OpenCode loads server.* there).
			opencode: join(app, "0.5.0-9d7452f", "src", "opencode", "plugin"),
		});
	});

	it("matches tails by whole path segments", () => {
		expect(endsWithSegments("/a/bin/orrery", join("bin", "orrery"))).toBe(true);
		expect(endsWithSegments("/a/mybin/orrery", join("bin", "orrery"))).toBe(false);
		expect(endsWithSegments("/a/notextensions/pi.js", join("extensions", "pi.js"))).toBe(false);
	});

	it("knows an entry under this home's app/ (current or a version, even one that is gone), and nothing beside or above it", () => {
		const app = join(tempDir("orrery-layout-"), "app");
		expect(inApp(app, join(app, "current", "bin", "orrery"), ENTRY_TAILS.cli)).toBe(true);
		expect(inApp(app, join(app, "0.5.0-gone", "src", "cli", "main.ts"), ENTRY_TAILS.cli)).toBe(true);
		expect(inApp(app, join(app, "bin", "orrery"), ENTRY_TAILS.cli)).toBe(false);
		expect(inApp(app, join(app, "current", "x", "bin", "orrery"), ENTRY_TAILS.cli)).toBe(false);
		expect(inApp(app, join(app, "..", "other", "bin", "orrery"), ENTRY_TAILS.cli)).toBe(false);
		expect(inApp(app, join(`${app}2`, "current", "bin", "orrery"), ENTRY_TAILS.cli)).toBe(false);
	});

	it("calls a command Orrery's only under this home's app/ or in a provable Orrery checkout or release", () => {
		const base = tempDir("orrery-layout-");
		const app = join(base, "home", "app");
		const release = join(base, "release");
		mkdirSync(join(release, "bin"), { recursive: true });
		writeFileSync(join(release, "bin", "orrery"), "", { mode: 0o755 });
		writeFileSync(join(release, "VERSION"), "0.6.0\n");
		const checkout = join(base, "checkout");
		mkdirSync(join(checkout, "src", "cli"), { recursive: true });
		writeFileSync(join(checkout, "src", "cli", "main.ts"), "");
		writeFileSync(join(checkout, "package.json"), '{"name":"orrery"}');
		const other = join(base, "other");
		mkdirSync(join(other, "bin"), { recursive: true });
		writeFileSync(join(other, "bin", "orrery"), "", { mode: 0o755 });
		writeFileSync(join(other, "VERSION"), "not a version\n");
		expect(isOrreryRoot(release)).toBe(true);
		expect(isOrreryRoot(checkout)).toBe(true);
		expect(isOrreryRoot(other)).toBe(false);
		expect(isOrreryCommand(join(release, "bin", "orrery"), app)).toBe(true);
		expect(isOrreryCommand(join(checkout, "src", "cli", "main.ts"), app)).toBe(true);
		expect(isOrreryCommand(join(app, "current", "bin", "orrery"), app)).toBe(true); // dangling: no app yet
		expect(isOrreryCommand(join(other, "bin", "orrery"), app)).toBe(false);
		expect(isOrreryCommand("/old/release/bin/orrery", app)).toBe(false);
		expect(isOrreryCommand("/bin/orrery", app)).toBe(false);
	});

	it("lists both styles' tails, binary first", () => {
		expect(ENTRY_TAILS).toEqual({
			cli: [join("bin", "orrery"), join("src", "cli", "main.ts")],
			pi: [join("extensions", "pi.js"), join("src", "pi", "index.ts")],
			omp: [join("extensions", "omp.js"), join("src", "omp", "index.ts")],
			opencode: [join("extensions", "opencode"), join("src", "opencode", "plugin")],
		});
	});
});
