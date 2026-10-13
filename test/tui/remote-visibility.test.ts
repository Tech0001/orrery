import { expect, it, vi } from "vitest";
import { parseConfig } from "../../src/lane/config.ts";
import { lanesPage } from "../../src/tui/pages/lanes.ts";
import { loginsPage } from "../../src/tui/pages/logins.ts";
import { toolsPage } from "../../src/tui/pages/tools.ts";
import { CONFIG_TEXT, fakeDeps, makeApp, row, screen, settle } from "./support.ts";

function config(remote: boolean) {
	return parseConfig(CONFIG_TEXT + (remote ? '\n[remotes.home]\nkind = "cloudflare"\nurl = "https://example.invalid"\n' : ""), "/d");
}

it.each([false, true])("the Memory column depends on configured remotes, even with only local lanes (remotes: %s)", (remote) => {
	const app = makeApp(fakeDeps({ loadConfig: () => config(remote) }, [row({ name: "Alpha" })]), [lanesPage]);
	const lines = lanesPage.render(app, 120, 10);
	expect(lines[0].includes("Memory")).toBe(remote);
	if (!remote) {
		// Restore the original 19-column minimum for Summaries: the model drops below 100.
		expect(lanesPage.render(app, 99, 10)[0]).not.toContain("Summary model");
		expect(lanesPage.render(app, 100, 10)[0]).toContain("Summary model");
	}
});

it.each([false, true])("Logins uses one no-remotes line or the populated section (remotes: %s)", async (remote) => {
	const app = makeApp(fakeDeps({ loadConfig: () => config(remote) }), [loginsPage]);
	await settle();
	const text = screen(app);
	if (remote) {
		expect(text).toContain("Remotes");
		expect(text).toContain("home");
		expect(text).toContain("Reachable");
		expect(text).not.toContain("No remotes");
	} else {
		expect(text).toContain("No remotes — orrery remote add");
		expect(text).not.toContain("Reachable");
		expect(text).not.toContain("Add remote");
		expect(loginsPage.count(app)).toBe(0);
	}
});

it.each([[false, false], [false, true], [true, false], [true, true]])("Tools shows Wrangler only when found or configured (found: %s, cloudflare: %s)", (found, cloudflare) => {
	const tools = vi.fn(() => [{ id: "wrangler" as const, label: "wrangler", wiring: "none" as const, detail: "Cloudflare Worker tools", ...(found ? { path: "/bin/wrangler", version: "4.45.0" } : {}) }]);
	const app = makeApp(fakeDeps({ loadConfig: () => config(cloudflare), tools }), [toolsPage]);
	expect(screen(app).includes("wrangler")).toBe(found || cloudflare);
	expect(tools).toHaveBeenCalledWith({ probeWrangler: true });
	expect(toolsPage.count(app)).toBe(found || cloudflare ? 2 : 1);
});

it("updates Wrangler visibility when the remotes change during the Tools cache window", () => {
	let current = config(true);
	const app = makeApp(fakeDeps({ loadConfig: () => current, tools: () => [{ id: "wrangler", label: "wrangler", wiring: "none", detail: "Cloudflare Worker tools" }] }), [toolsPage]);
	expect(screen(app)).toContain("wrangler");
	current = config(false);
	app.refresh();
	expect(screen(app)).not.toContain("wrangler");
	current = config(true);
	app.refresh();
	expect(screen(app)).toContain("wrangler");
});
