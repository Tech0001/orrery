import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compactCommand } from "../../src/cli/commands.ts";
import { parseConfig } from "../../src/lane/config.ts";
import { MemoryStore } from "../../src/memory/index.ts";
import { cleanEnv, cliCommand } from "../claude/support.ts";
import { fauxModels, laneConfigToml, tempDir } from "../lane/support.ts";
import { streamReply } from "../pi/remote-real-support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Three long messages in a lane's memory, enough for summaries. */
function seedHistory(laneDir: string): void {
	mkdirSync(laneDir, { recursive: true });
	const store = MemoryStore.open(join(laneDir, "memory.sqlite"));
	store.appendBatch([0, 1, 2].map((i) => ({ kind: "user" as const, text: `${i} ${"long history ".repeat(80)}` })));
	store.close();
}

describe("compactCommand", () => {
	it("builds every summary with the lane's compactor and records its usage", async () => {
		const dir = tempDir("orrery-compact-");
		dirs.push(dir);
		const config = parseConfig(laneConfigToml({ dataDir: join(dir, "data"), workspace: join(dir, "ws") }), dir);
		const laneDir = config.lanes.get("Test")!.dir;
		seedHistory(laneDir);
		const { models } = fauxModels();
		await compactCommand(config, "test", models);
		const reopened = MemoryStore.openReadOnly(join(laneDir, "memory.sqlite"));
		expect(reopened.nodeCount).toBe(4);
		expect(reopened.usageRows().filter((r) => r.role === "compactor").length).toBeGreaterThan(0);
		reopened.close();
	});

	// The whole model path in a CLI process (the binary under test:binary): models.ts and pi-ai's providers load, and
	// the summaries come from an OpenAI-compatible server.
	it("runs `orrery compact` as a process against an OpenAI-compatible server", async () => {
		const dir = tempDir("orrery-compact-");
		dirs.push(dir);
		let chats = 0;
		const server = createServer((req, res) => {
			req.resume();
			req.on("end", () => {
				chats += 1;
				streamReply(res, "A short summary of the history.");
			});
		});
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		try {
			const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
			const config = join(dir, "config.toml");
			writeFileSync(
				config,
				[
					`data_dir = ${JSON.stringify(join(dir, "data"))}`,
					`credentials = ${JSON.stringify(join(dir, "credentials.json"))}`,
					"[[providers]]",
					'id = "local"',
					`base_url = ${JSON.stringify(baseUrl)}`,
					"[[providers.models]]",
					'id = "m"',
					"context_window = 128000",
					"max_tokens = 4096",
					"[lanes.Test]",
					`workspace = ${JSON.stringify(join(dir, "ws"))}`,
					'compactor_model = "local/m"',
					'compactor_thinking = "off"',
					"",
				].join("\n"),
			);
			const laneDir = join(dir, "data", "lanes", "Test");
			seedHistory(laneDir);
			const c = cliCommand(["compact", "Test", "--config", config]);
			const child = spawn(c.cmd, c.args, { env: cleanEnv({ HOME: dir }) });
			let out = "";
			child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
			child.stderr.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
			const code = await new Promise<number | null>((done) => child.on("exit", done));
			expect([code, out]).toEqual([0, expect.stringMatching(/^Done: [1-9]\d* summaries for 3 messages\.\n$/)]);
			expect(chats).toBeGreaterThan(0);
			const store = MemoryStore.openReadOnly(join(laneDir, "memory.sqlite"));
			try {
				expect(store.nodeCount).toBeGreaterThan(0);
				expect(store.usageRows().filter((r) => r.role === "compactor").map((r) => r.model)).toContain("local/m");
			} finally {
				store.close();
			}
		} finally {
			server.close();
		}
	}, 60_000);
});
