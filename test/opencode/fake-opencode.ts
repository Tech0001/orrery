/**
 * A fake OpenCode 2.0.30 for the tests: an executable `opencode` in `bin`, run by this test runtime (Node, or Bun under
 * test:bun-suite). `--version` says its version; `serve --stdio --port 0` prints `{"url": …}` on its first line and
 * answers GET /api/plugin as `mode` says (with basic auth "opencode" and OPENCODE_PASSWORD, as the real one asks), until
 * stdin ends; anything else is a session, which writes what it was started with and exits with `exitCode` (after
 * `sessionMs`). Every run
 * appends a JSON line to `<bin>/opencode.log`: the arguments, the folder, the environment, and for a session the token
 * file the config content names (its mode, its folder's mode, its text).
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type FakeMode = "active" | "failed" | "absent" | "slow-active" | "silent" | "remote-url" | "die" | "unauthorized";

export interface FakeRun {
	readonly args: string[];
	readonly cwd: string;
	readonly pid: number;
	readonly env: Record<string, string>;
	readonly tokenFile?: { readonly mode: number; readonly folderMode: number; readonly text: string } | { readonly missing: true };
}

const SCRIPT = String.raw`
const { appendFileSync, readFileSync, statSync } = require("node:fs");
const { createServer } = require("node:http");
const { dirname, join } = require("node:path");
const bin = __BIN__;
const settings = JSON.parse(readFileSync(join(bin, "opencode.json"), "utf8"));
const args = process.argv.slice(2);
const log = (extra) => appendFileSync(join(bin, "opencode.log"), JSON.stringify({ args, cwd: process.cwd(), pid: process.pid, env: process.env, ...extra }) + "\n");
if (args[0] === "--version") {
	log({});
	process.stdout.write(settings.version + "\n", () => process.exit(0));
	return;
}
if (args[0] === "serve") {
	log({});
	if (settings.mode === "die") process.exit(7);
	if (settings.mode === "silent") {
		process.stdin.resume();
		process.stdin.on("end", () => process.exit(0));
		return;
	}
	let folder = "";
	try {
		folder = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT).plugins[0].package;
	} catch {}
	let polls = 0;
	const builtin = { id: "builtin.one", source: { type: "builtin" }, features: { server: true }, state: { status: "active" } };
	const server = createServer((request, response) => {
		const expected = "Basic " + Buffer.from("opencode:" + process.env.OPENCODE_PASSWORD).toString("base64");
		if (settings.mode === "unauthorized" || request.headers.authorization !== expected) {
			response.writeHead(401).end("{}");
			return;
		}
		polls++;
		const mine = { id: "orrery", source: { type: "local", path: join(folder, "server.js") }, features: { server: true } };
		const data =
			settings.mode === "active" ? [builtin, { ...mine, state: { status: "active" } }]
			: settings.mode === "slow-active" ? (polls < 4 ? [] : [builtin, { ...mine, state: { status: "active" } }])
			: settings.mode === "failed" ? [builtin, { source: { type: "local", path: folder }, features: { server: true }, state: { status: "failed", error: "Error: boom in setup\n    at setup (server.js:1:2)", ref: "err_1" } }]
			: [builtin];
		response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ location: { directory: process.cwd() }, data }));
	});
	server.listen(0, "127.0.0.1", () => {
		const port = server.address().port;
		process.stdout.write(JSON.stringify({ url: settings.mode === "remote-url" ? "http://example.com:" + port : "http://127.0.0.1:" + port }) + "\n");
	});
	process.stdin.resume();
	process.stdin.on("end", () => {
		appendFileSync(join(bin, "opencode.log"), JSON.stringify({ ended: true, polls }) + "\n");
		process.exit(0);
	});
	return;
}
let tokenFile;
try {
	const path = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT).plugins[0].options.tokenFile;
	try {
		tokenFile = { mode: statSync(path).mode & 0o777, folderMode: statSync(dirname(path)).mode & 0o777, text: readFileSync(path, "utf8") };
	} catch {
		tokenFile = { missing: true };
	}
} catch {}
log({ tokenFile });
process.exitCode = settings.exitCode ?? 0;
if (settings.sessionMs > 0) setTimeout(() => {}, settings.sessionMs);
`;

/** Writes the fake into `bin` (and its settings); returns how to change its mode and read its runs. */
export function fakeOpenCode(bin: string, options: { readonly mode?: FakeMode; readonly version?: string; readonly exitCode?: number; readonly sessionMs?: number } = {}) {
	const path = join(bin, "opencode");
	const settings = { mode: options.mode ?? "active", version: options.version ?? "opencode v2.0.30", exitCode: options.exitCode ?? 0, sessionMs: options.sessionMs ?? 0 };
	const write = () => writeFileSync(join(bin, "opencode.json"), JSON.stringify(settings));
	write();
	writeFileSync(path, `#!${process.execPath}\n(() => {${SCRIPT.replace("__BIN__", JSON.stringify(bin))}})();\n`);
	chmodSync(path, 0o755);
	const log = join(bin, "opencode.log");
	return {
		path,
		setMode(mode: FakeMode) {
			settings.mode = mode;
			write();
		},
		/** Every run so far, oldest first (a server's "ended" lines aside). */
		runs(): FakeRun[] {
			if (!existsSync(log)) return [];
			return readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as FakeRun & { ended?: true }).filter((run) => run.ended !== true);
		},
		/** How many times a server's lease ended (stdin closed), with how many plugin lists it served. */
		ended(): { polls: number }[] {
			if (!existsSync(log)) return [];
			return readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { ended?: true; polls: number }).filter((run) => run.ended === true);
		},
	};
}
