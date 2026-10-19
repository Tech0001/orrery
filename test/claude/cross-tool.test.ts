import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { claudeSetup } from "../../src/claude/setup.ts";
import { pendingEvents } from "../../src/claude/spool.ts";
import { readHolder } from "../../src/agent/handover.ts";
import { cleanup, close, isolatedHome, lastAgent, pi, world } from "../pi/world.ts";
import { fakeClaude, messages, waitUntil } from "./support.ts";

afterEach(cleanup);

describe("one agent in pi and in Claude Code", () => {
	const home = isolatedHome();

	it("keeps one memory across both, and the second runs read-only while the first holds the agent", async () => {
		const { root, config, configPath } = world();
		const ws = join(root, "agent-Atlas");
		const atlas = config.agents.get("Atlas")!;
		// Claude Code records only in an agent where claude-setup ran.
		claudeSetup(atlas);
		const claude = fakeClaude();
		// pi runs in this process, the fake Claude Code's parent; the real two are siblings. pi's host is a bystander, so
		// the Claude Code is not taken as started inside pi's session (src/agent/sessions.ts).
		const piHost = spawn("sleep", ["60"], { stdio: "ignore" });
		const host = { owner: piHost.pid as number };
		// The hook processes get the scratch home too (said here anyway).
		const env = { ORRERY_CONFIG: configPath, CLAUDE_PROJECT_DIR: ws, HOME: home() };
		const hookCli = async (event: string, input: object, vars: Record<string, string>) => claude.hook(event, input, vars);
		try {
			const first = await pi(root, ws, config, undefined, host);
			first.setResponses([fauxAssistantMessage("pi reply")]);
			await first.session.prompt("pi says hello");
			const held = JSON.parse((await hookCli("session-start", { session_id: "c1", cwd: ws, source: "startup" }, env)).stdout);
			expect(held.hookSpecificOutput.additionalContext).toContain("read-only");
			await hookCli("user-prompt-submit", { session_id: "c1", cwd: ws, prompt: "lost words" }, env);
			expect(pendingEvents(atlas.dir, "c1")).toEqual([]);
			await close(first);
			const recording = JSON.parse((await hookCli("session-start", { session_id: "c2", cwd: ws, source: "startup" }, env)).stdout);
			expect(recording.hookSpecificOutput.additionalContext).toMatch(/2 msgs · recording/);
			await hookCli("user-prompt-submit", { session_id: "c2", cwd: ws, prompt: "claude says hello" }, env);
			await hookCli("stop", { session_id: "c2", cwd: ws, last_assistant_message: "claude reply" }, env);
			await waitUntil(() => messages(atlas).length === 4);
			const second = await pi(root, ws, config, undefined, host);
			expect(second.notices).toContainEqual({ message: "Atlas is open in Claude Code; this pi runs without memory.", type: "warning" });
			await close(second);
			await hookCli("session-end", { session_id: "c2", cwd: ws, reason: "other" }, env);
			await waitUntil(() => readHolder(atlas.dir) === undefined, 10_000);
			await pi(root, ws, config, undefined, host);
			expect(lastAgent().view.store.root.map((m) => `${m.kind}: ${m.text}`)).toEqual(["user: pi says hello", "talk: pi reply", "user: claude says hello", "talk: claude reply"]);
		} finally {
			claude.kill();
			piHost.kill();
		}
	}, 60_000);
});
