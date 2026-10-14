import { spawn } from "node:child_process";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { claudeSetup } from "../../src/claude/setup.ts";
import { pendingEvents } from "../../src/claude/spool.ts";
import { readHolder } from "../../src/lane/handover.ts";
import { cleanup, close, isolatedHome, lastLane, pi, world } from "../pi/world.ts";
import { hookCli, messages, waitUntil } from "./support.ts";

afterEach(cleanup);

describe("one lane in pi and in Claude Code", () => {
	const home = isolatedHome();

	it("keeps one memory across both, and the second runs read-only while the first holds the lane", async () => {
		const { root, config, configPath } = world();
		const ws = join(root, "agent-Atlas");
		const atlas = config.lanes.get("Atlas")!;
		// Claude Code records only in a lane where claude-setup ran.
		claudeSetup(atlas);
		const claude = spawn("sleep", ["60"]);
		// The hook processes get the scratch home too (hookCli inherits this process's environment; said here anyway).
		const env = { ORRERY_CONFIG: configPath, CLAUDE_PROJECT_DIR: ws, CLAUDE_PID: String(claude.pid), HOME: home() };
		try {
			const first = await pi(root, ws, config);
			first.setResponses([fauxAssistantMessage("pi reply")]);
			await first.session.prompt("pi says hello");
			const held = JSON.parse(hookCli("session-start", { session_id: "c1", cwd: ws, source: "startup" }, env).stdout);
			expect(held.hookSpecificOutput.additionalContext).toContain("read-only");
			hookCli("user-prompt-submit", { session_id: "c1", cwd: ws, prompt: "lost words" }, env);
			expect(pendingEvents(atlas.dir, "c1")).toEqual([]);
			await close(first);
			const recording = JSON.parse(hookCli("session-start", { session_id: "c2", cwd: ws, source: "startup" }, env).stdout);
			expect(recording.hookSpecificOutput.additionalContext).toMatch(/2 msgs · recording/);
			hookCli("user-prompt-submit", { session_id: "c2", cwd: ws, prompt: "claude says hello" }, env);
			hookCli("stop", { session_id: "c2", cwd: ws, last_assistant_message: "claude reply" }, env);
			await waitUntil(() => messages(atlas).length === 4);
			const second = await pi(root, ws, config);
			expect(second.notices).toContainEqual({ message: "Atlas is open in Claude Code; this pi runs without memory.", type: "warning" });
			await close(second);
			hookCli("session-end", { session_id: "c2", cwd: ws, reason: "other" }, env);
			await waitUntil(() => readHolder(atlas.dir) === undefined, 10_000);
			await pi(root, ws, config);
			expect(lastLane().view.store.root.map((m) => `${m.kind}: ${m.text}`)).toEqual(["user: pi says hello", "talk: pi reply", "user: claude says hello", "talk: claude reply"]);
		} finally {
			claude.kill();
		}
	}, 60_000);
});
