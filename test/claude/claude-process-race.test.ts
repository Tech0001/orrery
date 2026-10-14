/**
 * Two deciders of one Claude Code process at once (src/claude/pick.ts claudeSession): the MCP server and SessionStart
 * both find no record. The test runs the second decision at the instant the first has written its record whole but not
 * yet linked it into place; the first then finds the second's record there and must take it, not its own.
 */

import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ClaudePicked, claudeSession } from "../../src/claude/pick.ts";
import { writeSetupMarker } from "../../src/claude/view-file.ts";
import { parseConfig } from "../../src/lane/config.ts";
import { tempDir } from "../lane/support.ts";

/** Runs once, at the first decider's moment between writing its record and linking it into place. */
const hook = vi.hoisted(() => ({ between: undefined as (() => void) | undefined }));

vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return {
		...fs,
		default: fs,
		linkSync: (...args: Parameters<typeof fs.linkSync>) => {
			const between = hook.between;
			hook.between = undefined;
			between?.();
			return fs.linkSync(...args);
		},
	};
});

const dirs: string[] = [];
afterEach(() => {
	hook.between = undefined;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("two deciders of one Claude Code process", () => {
	it("race: the loser reads the winner's record and answers with it", () => {
		const root = tempDir("orrery-decide-race-");
		dirs.push(root);
		for (const folder of ["agent-Test", "agent-Other", "elsewhere"]) mkdirSync(join(root, folder));
		const lane = (name: string) => `[lanes.${name}]\nworkspace = ${JSON.stringify(join(root, `agent-${name}`))}\ncompactor_model = "faux-compactor/faux-1"\n`;
		const config = parseConfig(`data_dir = ${JSON.stringify(join(root, "data"))}\n${lane("Test")}${lane("Other")}`, root);
		// Other's folder is set up the file way: an agent opened there by ORRERY_AGENT is refused.
		writeSetupMarker(config.lanes.get("Other")?.dir as string, join(root, "agent-Other"), "CLAUDE.md");
		const env = { ORRERY_AGENT: "Test" };
		// The two would decide differently (their folders differ), so the answer tells whose record stands.
		let winner: ClaudePicked | undefined;
		hook.between = () => {
			winner = claudeSession(config, { env, cwd: join(root, "agent-Other"), pid: process.pid, decide: true });
		};
		const loser = claudeSession(config, { env, cwd: join(root, "elsewhere"), pid: process.pid, decide: true });
		expect(winner).toEqual({ kind: "in-view-folder", name: "Test", host: "Other" });
		expect(loser).toEqual(winner);
		expect(JSON.parse(readFileSync(join(config.dataDir, "claude-processes", `${process.pid}.json`), "utf8"))).toMatchObject({ kind: "refused", why: "in-view-folder" });
	});
});
