import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { thirdPartyLicenses } from "../../scripts/build-release.ts";
import { tempDir } from "../lane/support.ts";
import { PINNED_BUN, REPO } from "./support.ts";

const TEXTS = join(REPO, "scripts", "licenses");
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface FixturePackage {
	readonly lock?: { dev?: boolean; devOptional?: boolean; optional?: boolean };
	readonly json?: { license?: string; author?: unknown };
	readonly licenseFile?: string;
	readonly installed?: boolean;
}

/** A source tree: package-lock.json naming `packages` (all at 1.0.0) and their folders in node_modules. */
function tree(packages: Record<string, FixturePackage>): string {
	const from = tempDir("orrery-licenses-");
	dirs.push(from);
	const lock: Record<string, object> = { "": { name: "fixture" } };
	for (const [name, p] of Object.entries(packages)) {
		lock[`node_modules/${name}`] = { version: "1.0.0", ...p.lock };
		if (p.installed === false) continue;
		const dir = join(from, "node_modules", name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", ...p.json }));
		if (p.licenseFile !== undefined) writeFileSync(join(dir, "LICENSE"), p.licenseFile);
	}
	writeFileSync(join(from, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: lock }));
	return from;
}

const count = (text: string, part: string) => text.split(part).length - 1;

describe("thirdPartyLicenses", () => {
	it("gives each shipped package's license and author, and each standard text once at the end for those with no license file", () => {
		const from = tree({
			"with-file": { json: { license: "ISC", author: { name: "Ada Example", email: "ada@example.org", url: "https://example.org" } }, licenseFile: "ISC text of with-file\n" },
			"no-file": { json: { license: "MIT", author: "Bo Example" } },
			"no-author": { json: { license: "MIT" } },
			dual: { json: { license: "(MIT OR Apache-2.0)", author: "Cy Example" } },
			"dev-optional": { lock: { devOptional: true }, json: { license: "MIT", author: "Di Example" }, licenseFile: "dev-optional's own text\n" },
			"dev-only": { lock: { dev: true }, json: { license: "MIT" }, licenseFile: "dev only\n" },
			"other-platform": { lock: { optional: true }, installed: false },
		});
		const text = thirdPartyLicenses(from, TEXTS);
		expect(text).toContain("==== with-file@1.0.0 ====\nLicense: ISC\nAuthor: Ada Example <ada@example.org> (https://example.org)\nISC text of with-file\n");
		expect(text).toContain("==== no-file@1.0.0 ====\nLicense: MIT\nAuthor: Bo Example\n(no license file in the package: the standard MIT text is at the end of this file)\n");
		expect(text).toContain("==== no-author@1.0.0 ====\nLicense: MIT\nAuthor: not given in the package\n");
		expect(text).toContain("==== dual@1.0.0 ====\nLicense: (MIT OR Apache-2.0)\nAuthor: Cy Example\n(no license file in the package: the standard MIT and Apache-2.0 texts are at the end of this file)\n");
		// A devOptional package can ship; a dev one and one not installed here do not.
		expect(text).toContain("==== dev-optional@1.0.0 ====\nLicense: MIT\nAuthor: Di Example\ndev-optional's own text\n");
		expect(text).not.toContain("dev-only@");
		expect(text).not.toContain("other-platform@");
		const mit = readFileSync(join(TEXTS, "MIT.txt"), "utf8");
		const apache = readFileSync(join(TEXTS, "Apache-2.0.txt"), "utf8");
		expect([count(text, mit), count(text, apache)]).toEqual([1, 1]);
		const standard = text.indexOf("\n==== Standard license texts ====\n");
		expect(standard).toBeGreaterThan(text.lastIndexOf("@1.0.0 ===="));
		expect(text.indexOf(mit)).toBeGreaterThan(standard);
	});

	it("adds only the MIT text Bun needs when every package ships its own license file", () => {
		const text = thirdPartyLicenses(tree({ a: { json: { license: "ISC", author: "A" }, licenseFile: "a's text\n" } }), TEXTS);
		expect(text).toContain(`\n==== Standard license texts ====\n\n---- MIT ----\n${readFileSync(join(TEXTS, "MIT.txt"), "utf8")}`);
		expect(text).not.toContain("---- Apache-2.0 ----");
	});

	it("names the Bun runtime inside bin/orrery first, with Bun's own LICENSE.md for the pinned version", () => {
		const text = thirdPartyLicenses(tree({ a: { json: { license: "ISC", author: "A" }, licenseFile: "a's text\n" } }), TEXTS);
		const bun = readFileSync(join(TEXTS, "bun-LICENSE.md"), "utf8");
		// Bun's LICENSE.md names what it links statically, JavaScriptCore (LGPL) among them, and where its WebKit source is.
		expect(bun).toMatch(/^Bun itself is MIT-licensed\./);
		expect(bun).toContain("statically links JavaScriptCore");
		expect(bun).toContain("https://github.com/oven-sh/webkit");
		expect(text).toContain(
			`\n==== Bun runtime (inside bin/orrery) ====\nBun ${PINNED_BUN}'s LICENSE.md, from github.com/oven-sh/bun at the tag bun-v${PINNED_BUN}. Bun itself is under the MIT license, whose standard text is at the end of this file.\n${bun}`,
		);
		expect(text.indexOf("==== Bun runtime")).toBeLessThan(text.indexOf("==== a@1.0.0 ===="));
	});

	it("fails naming each license id that has no standard text, and a package that names no license", () => {
		const from = tree({
			odd: { json: { license: "WTFPL", author: "O" } },
			odder: { json: { license: "MIT AND Zlib" } },
			fine: { json: { license: "Zlib" }, licenseFile: "zlib text\n" },
		});
		expect(() => thirdPartyLicenses(from, TEXTS)).toThrow(/no standard license text for WTFPL \(odd@1\.0\.0\); Zlib \(odder@1\.0\.0\)/);
		expect(() => thirdPartyLicenses(tree({ bare: {} }), TEXTS)).toThrow("bare@1.0.0 ships no license file and names no license");
		// An id is a file name only when it looks like one.
		expect(() => thirdPartyLicenses(tree({ sly: { json: { license: "../../MIT" } } }), TEXTS)).toThrow(/no standard license text for \.\.\/\.\.\/MIT \(sly@1\.0\.0\)/);
	});
});
