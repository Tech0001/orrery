import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { argsRefusal, inheritsOrreryPlugin, launchConfigContent, opencodeArgs, pluginFolder } from "../../src/opencode/launch.ts";
import { configContent, PLUGIN_ID, readPluginOptions } from "../../src/opencode/options.ts";

describe("OpenCode's command line", () => {
	it("always gives --standalone and the folder, before the person's arguments", () => {
		expect(opencodeArgs("/w/proj", [])).toEqual(["--standalone", "/w/proj"]);
		expect(opencodeArgs("/w/proj", ["--continue", "--prompt", "run the tests"])).toEqual(["--standalone", "/w/proj", "--continue", "--prompt", "run the tests"]);
	});

	it("puts --standalone after a session subcommand the arguments start with (run, mini open where they start)", () => {
		expect(opencodeArgs("/w/proj", ["run", "fix it"])).toEqual(["run", "--standalone", "fix it"]);
		expect(opencodeArgs("/w/proj", ["mini", "--continue"])).toEqual(["mini", "--standalone", "--continue"]);
		// A word later on is no subcommand.
		expect(opencodeArgs("/w/proj", ["--prompt", "run"])).toEqual(["--standalone", "/w/proj", "--prompt", "run"]);
	});

	it("refuses --server (another server never loads the launch's plugin) and subcommands that open no session", () => {
		expect(argsRefusal("Atlas", ["--server", "http://127.0.0.1:4096"])).toBe("OpenCode's --server connects to another server, which doesn't load Orrery's plugin (no memory, no guard): open Atlas without it.");
		expect(argsRefusal("Atlas", ["run", "--server=http://x", "go"])).toContain("--server connects to another server");
		// After --, a word is the person's text.
		expect(argsRefusal("Atlas", ["run", "--", "--server"])).toBeUndefined();
		for (const sub of ["acp", "serve", "session", "auth", "models"]) {
			expect(argsRefusal("Atlas", [sub])).toBe(`opencode ${sub} opens no session for Atlas: run it as plain opencode, or open Atlas in OpenCode's TUI, run or mini.`);
		}
		for (const fine of [[], ["--continue"], ["run", "go"], ["mini"], ["--prompt", "serve"]]) expect(argsRefusal("Atlas", fine)).toBeUndefined();
	});

	it("knows an OPENCODE_CONFIG_CONTENT that names an Orrery plugin folder (inherited from an Orrery session's shell)", () => {
		const orrery = (folder: string) => ({ OPENCODE_CONFIG_CONTENT: configContent(folder, { agent: "Atlas", tokenFile: "/t/x" }) });
		expect(inheritsOrreryPlugin(orrery("/h/app/current/extensions/opencode"))).toBe(true);
		expect(inheritsOrreryPlugin(orrery("/src/orrery/src/opencode/plugin"))).toBe(true);
		expect(inheritsOrreryPlugin({ OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugins: ["/h/app/current/extensions/opencode"] }) })).toBe(true);
		// The person's own: another plugin, other settings, JSONC, nothing.
		expect(inheritsOrreryPlugin(orrery("/h/plugins/mine"))).toBe(false);
		expect(inheritsOrreryPlugin({ OPENCODE_CONFIG_CONTENT: '{"model": "x/y"}' })).toBe(false);
		expect(inheritsOrreryPlugin({ OPENCODE_CONFIG_CONTENT: '{ // mine\n "plugins": ["/h/app/current/extensions/opencode"] }' })).toBe(false);
		expect(inheritsOrreryPlugin({})).toBe(false);
	});

	it("names the plugin folder of the install shape at hand: a release's extensions/opencode, a checkout's src/opencode/plugin", () => {
		const checkout = fileURLToPath(new URL("../..", import.meta.url));
		expect(pluginFolder({}, checkout)).toBe(join(checkout, "src", "opencode", "plugin"));
	});
});

describe("the person's own OPENCODE_CONFIG_CONTENT at launch", () => {
	const ours = configContent("/h/app/current/extensions/opencode", { agent: "Atlas", tokenFile: "/t/x" });
	const entry = JSON.parse(ours).plugins[0];

	it("is Orrery's alone when there is none", () => {
		expect(launchConfigContent(undefined, ours)).toEqual({ content: ours });
		expect(launchConfigContent("", ours)).toEqual({ content: ours });
		expect(launchConfigContent("  \n", ours)).toEqual({ content: ours });
	});

	it("keeps theirs, JSON or JSONC, with Orrery's plugin entry after their own plugins", () => {
		expect(JSON.parse(launchConfigContent('{"model": "x/y", "plugins": ["their-plugin", {"package": "/p/two"}]}', ours).content)).toEqual({ model: "x/y", plugins: ["their-plugin", { package: "/p/two" }, entry] });
		expect(JSON.parse(launchConfigContent('{"model": "x/y"}', ours).content)).toEqual({ model: "x/y", plugins: [entry] });
		const jsonc = '\uFEFF{\n  // the model\n  "model": "x/y", /* a note, with a "quote" */\n  "url": "http://a/*b*/c//d",\n  "plugins": ["their-plugin",],\n  "nested": {"a": [1, 2,], "b": "\\" // not a comment\\\\",},\n}\n';
		expect(JSON.parse(launchConfigContent(jsonc, ours).content)).toEqual({ model: "x/y", url: "http://a/*b*/c//d", plugins: ["their-plugin", entry], nested: { a: [1, 2], b: '" // not a comment\\' } });
	});

	it("drops an Orrery plugin entry theirs carries (inherited from the shell of a session Orrery opened), and keeps the rest", () => {
		const inherited = JSON.stringify({ model: "x/y", plugins: ["their-plugin", { package: "/h/app/current/extensions/opencode", options: { agent: "Birch", tokenFile: "/t/y" } }, "/src/orrery/src/opencode/plugin"] });
		expect(JSON.parse(launchConfigContent(inherited, ours).content)).toEqual({ model: "x/y", plugins: ["their-plugin", entry] });
	});

	it("is Orrery's alone, and says why, when theirs can't be read or merged", () => {
		for (const [theirs, why] of [
			["{model: x}", /isn't JSON or JSONC/],
			['{"a": 1', /isn't JSON or JSONC/],
			['{"a": /* open', /isn't JSON or JSONC/],
			["[1, 2]", /isn't a JSON object/],
			["null", /isn't a JSON object/],
			['{"plugins": "one"}', /"plugins" isn't a list/],
		] as const) {
			const merged = launchConfigContent(theirs, ours);
			expect(merged.content, theirs).toBe(ours);
			expect(merged.unread, theirs).toMatch(why);
		}
	});
});

describe("the plugin's options", () => {
	it("are the plugin folder and {agent, tokenFile} in OPENCODE_CONFIG_CONTENT, as OpenCode 2.0.30 reads them", () => {
		const content = configContent("/h/app/current/extensions/opencode", { agent: "Atlas", tokenFile: "/h/tokens/opencode-1-aaaaaaaaaaaa" });
		expect(JSON.parse(content)).toEqual({ plugins: [{ package: "/h/app/current/extensions/opencode", options: { agent: "Atlas", tokenFile: "/h/tokens/opencode-1-aaaaaaaaaaaa" } }] });
		expect(PLUGIN_ID).toBe("orrery");
	});

	it("are read back without throwing, and anything else says what is missing", () => {
		expect(readPluginOptions({ agent: "Atlas", tokenFile: "/t/x" })).toEqual({ agent: "Atlas", tokenFile: "/t/x" });
		expect(readPluginOptions(undefined)).toEqual({ problem: "no agent named in the plugin's options" });
		expect(readPluginOptions({ agent: " " })).toEqual({ problem: "no agent named in the plugin's options" });
		expect(readPluginOptions({ agent: "Atlas", tokenFile: "relative/x" })).toEqual({ problem: "no token file named in the plugin's options" });
	});
});
