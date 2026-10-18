import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { holderFile, openElsewhere, writeHolder } from "../../src/agent/handover.ts";
import { statusOf } from "../claude/support.ts";
import { tempDir } from "./support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function agentDir(): string {
	const dir = tempDir("orrery-handover-");
	dirs.push(dir);
	mkdirSync(join(dir, "claude"), { recursive: true });
	return dir;
}

describe("openElsewhere: where an agent is open, said to a session that can't have it", () => {
	it("names the recorder's host, or the pi or OMP whose status is fresh, as another session of the asker's own tool", () => {
		const dir = agentDir();
		const now = Date.now();
		const recorder = { pid: process.pid, session: "s", claudePid: 777, state: "recording" as const, startedAt: now, updatedAt: now };
		writeHolder(dir, { ...recorder, host: "codex" });
		expect(openElsewhere(dir, "pi")).toBe("open in Codex");
		expect(openElsewhere(dir, "codex")).toBe("open in another Codex session");
		writeHolder(dir, recorder);
		expect(openElsewhere(dir, "omp")).toBe("open in Claude Code");
		expect(openElsewhere(dir, "claude-code")).toBe("open in another Claude Code session");
		rmSync(holderFile(dir));
		writeFileSync(join(dir, "status.json"), JSON.stringify(statusOf("omp")));
		expect(openElsewhere(dir, "omp")).toBe("open in another OMP session");
		expect(openElsewhere(dir, "codex")).toBe("open in OMP");
		writeFileSync(join(dir, "status.json"), JSON.stringify(statusOf("opencode")));
		expect(openElsewhere(dir, "pi")).toBe("open in OpenCode");
		expect(openElsewhere(dir, "opencode")).toBe("open in another OpenCode session");
	});

	it("lists every other tool when nothing says which", () => {
		const dir = agentDir();
		expect(openElsewhere(dir, "pi")).toBe("open elsewhere (OMP, Claude Code, Codex, or another pi session)");
		expect(openElsewhere(dir, "omp")).toBe("open elsewhere (pi, Claude Code, Codex, or another OMP session)");
		expect(openElsewhere(dir, "claude-code")).toBe("open elsewhere (pi, OMP, Codex, or another Claude Code session)");
		expect(openElsewhere(dir, "codex")).toBe("open elsewhere (pi, OMP, Claude Code, or another Codex session)");
		expect(openElsewhere(dir, "opencode")).toBe("open elsewhere (pi, OMP, Claude Code, Codex, or another OpenCode session)");
	});
});
