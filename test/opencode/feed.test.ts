import { mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FeedReader, feedFileIn, readFeed, writeFeed } from "../../src/opencode/feed.ts";
import { configContent } from "../../src/opencode/options.ts";
import { pluginOff, tuiFeed } from "../../src/opencode/plugin/tui-feed.ts";
import { tempDir } from "../agent/support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = () => {
	const dir = tempDir("orrery-opencode-feed-");
	dirs.push(dir);
	return dir;
};

describe("the plugin's feed for OpenCode's TUI", () => {
	it("is a private file beside the token file, read back as written", () => {
		const dir = join(scratch(), "tokens");
		const file = join(dir, "opencode-1-aaaaaaaaaaaa.feed.json");
		const feed = { tui: 7, line: "Orrery · Atlas · 3 msgs · recording", notices: [{ n: 1, text: "hello", level: "info" as const }] };
		writeFeed(file, feed);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(readFeed(file)).toEqual(feed);
		writeFileSync(file, "{not json");
		expect(readFeed(file)).toBeUndefined();
		writeFileSync(file, JSON.stringify({ tui: "7", line: 1, notices: [] }));
		expect(readFeed(file)).toBeUndefined();
		expect(readFeed(join(dir, "none"))).toBeUndefined();
		// Never through a link.
		writeFeed(join(dir, "real.feed.json"), feed);
		symlinkSync(join(dir, "real.feed.json"), join(dir, "link.feed.json"));
		expect(readFeed(join(dir, "link.feed.json"))).toBeUndefined();
	});

	it("is found through the launch's OPENCODE_CONFIG_CONTENT, by the entry of the TUI entry's own folder (by its real path too)", () => {
		const dir = scratch();
		const tokenFile = "/home/u/home/tokens/opencode-1-aaaaaaaaaaaa";
		const folder = join(dir, "app", "0.8.0", "extensions", "opencode");
		mkdirSync(folder, { recursive: true });
		symlinkSync(join(dir, "app", "0.8.0"), join(dir, "app", "current"));
		const viaCurrent = join(dir, "app", "current", "extensions", "opencode");
		expect(feedFileIn(configContent(viaCurrent, { agent: "Atlas", tokenFile }), folder)).toBe(`${tokenFile}.feed.json`);
		expect(feedFileIn(configContent(folder, { agent: "Atlas", tokenFile }), viaCurrent)).toBe(`${tokenFile}.feed.json`);
		const other = JSON.stringify({ plugins: [{ package: join(dir, "theirs"), options: { tokenFile: "/x" } }, { package: folder, options: { agent: "Atlas", tokenFile } }] });
		expect(feedFileIn(other, folder)).toBe(`${tokenFile}.feed.json`);
		expect(feedFileIn(configContent(join(dir, "somewhere", "else"), { agent: "Atlas", tokenFile }), folder)).toBeUndefined();
		expect(feedFileIn(JSON.stringify({ plugins: [folder, { package: "x" }] }), folder)).toBeUndefined();
		expect(feedFileIn(configContent(folder, { agent: "Atlas", tokenFile: "relative/file" }), folder)).toBeUndefined();
		expect(feedFileIn("{ // jsonc\n}", folder)).toBeUndefined();
		expect(feedFileIn(undefined, folder)).toBeUndefined();
	});

	it("shows its TUI each notice once, and nothing of a feed written for another TUI", () => {
		const dir = join(scratch(), "tokens");
		mkdirSync(dir);
		const tokenFile = join(dir, "opencode-1-aaaaaaaaaaaa");
		const entry = pathToFileURL(join(dir, "plugin", "tui.tsx")).href;
		const reader = tuiFeed({ OPENCODE_CONFIG_CONTENT: configContent(join(dir, "plugin"), { agent: "Atlas", tokenFile }) }, 7, entry) as FeedReader;
		expect(reader.look()).toEqual({ fresh: [] });
		const note = (n: number) => ({ n, text: `notice ${n}`, level: "warning" as const });
		writeFeed(`${tokenFile}.feed.json`, { tui: 7, line: "first", notices: [note(1), note(2)] });
		expect(reader.look()).toEqual({ line: "first", fresh: [note(1), note(2)] });
		expect(reader.look()).toEqual({ line: "first", fresh: [] });
		writeFeed(`${tokenFile}.feed.json`, { tui: 7, line: "second", notices: [note(2), note(3)] });
		expect(reader.look()).toEqual({ line: "second", fresh: [note(3)] });
		writeFeed(`${tokenFile}.feed.json`, { tui: 8, line: "theirs", notices: [note(9)] });
		expect(reader.look()).toEqual({ fresh: [] });
		expect(tuiFeed({}, 7, entry)).toBeUndefined();
	});

	it("says, from OpenCode's plugin list, when OpenCode has turned Orrery's plugin off (a reload that failed): no guard and no memory", () => {
		const folder = join(scratch(), "plugin");
		mkdirSync(folder);
		const list = (state: unknown, path = join(folder, "server.js")) => ({ data: [{ id: "x", source: { type: "builtin" }, state: { status: "active" } }, { id: "orrery", source: { type: "local", path }, state }] });
		expect(pluginOff(list({ status: "active" }), folder)).toBeUndefined();
		expect(pluginOff(list({ status: "failed", error: "Error: setup threw\n    at setup (server.js:1:2)", ref: "err_1" }), folder)).toBe("Orrery · NO GUARD, NO MEMORY: OpenCode turned Orrery's plugin off (Error: setup threw). Quit OpenCode and open the agent again.");
		expect(pluginOff(list({ status: "failed" }), folder)).toBe("Orrery · NO GUARD, NO MEMORY: OpenCode turned Orrery's plugin off (no reason given). Quit OpenCode and open the agent again.");
		// Another folder's plugin, a list still loading, or one in a shape Orrery doesn't know: nothing said.
		expect(pluginOff(list({ status: "failed" }, join(scratch(), "theirs", "server.js")), folder)).toBeUndefined();
		expect(pluginOff({ data: [] }, folder)).toBeUndefined();
		expect(pluginOff({ nope: 1 }, folder)).toBeUndefined();
		expect(pluginOff(undefined, folder)).toBeUndefined();
	});
});
