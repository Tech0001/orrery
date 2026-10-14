import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { installSteps, piExtensionFile, runInstall, type ToolCheck } from "../../src/lane/tools.ts";
import { toolsPage } from "../../src/tui/pages/tools.ts";
import { answer, fakeDeps, keys, makeApp, screen } from "./support.ts";

it("I over a foreign pi extension file keeps a copy and shows where it went", async () => {
	const home = mkdtempSync(join(tmpdir(), "orrery-tui-tools-"));
	try {
		const env = { PATH: "", HOME: home } as NodeJS.ProcessEnv;
		const file = piExtensionFile(env);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, "// someone's own extension\n");
		const other: ToolCheck = { id: "pi", label: "pi", path: "/bin/pi", version: "1.1.0", wiring: "other", detail: "another extension" };
		const app = makeApp(fakeDeps({ tools: () => [other], installSteps: (check) => installSteps(check, "/opt/orrery/app/current", env), install: (steps) => runInstall(steps) }), [toolsPage]);
		keys(app, "I");
		await answer(app, "replace", "y");
		await answer(app, "pi", "\r");
		await app.idle();
		const [aside] = readdirSync(dirname(file)).filter((n) => n.startsWith("orrery.ts.before-orrery-"));
		expect(aside).toBeDefined();
		expect(readFileSync(join(dirname(file), aside as string), "utf8")).toBe("// someone's own extension\n");
		expect(screen(app)).toContain("Done.");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
