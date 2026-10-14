import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentEnv, sshTarget } from "../../src/agent/env.ts";
import { ctx, tempDir } from "./support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("createAgentEnv (local)", () => {
	it("runs in the folder and reads files, or undefined when missing", async () => {
		const dir = tempDir("orrery-env-");
		dirs.push(dir);
		mkdirSync(join(dir, "ws"));
		writeFileSync(join(dir, "ws", "AGENTS.md"), "be careful");
		const agentEnv = createAgentEnv({ name: "local", kind: "local" }, join(dir, "ws"), join(dir, "ssh"), ctx);
		expect(await agentEnv.readText(join(dir, "ws", "AGENTS.md"))).toBe("be careful");
		expect(await agentEnv.readText(join(dir, "ws", "missing.md"))).toBeUndefined();
		expect(agentEnv.env().cwd).toBe(join(dir, "ws"));
		expect(agentEnv.env()).toBe(agentEnv.env());
		await agentEnv.close();
	});
});

describe("sshTarget", () => {
	it("writes a connect-timeout ssh config and maps the host", () => {
		const dir = tempDir("orrery-ssh-");
		dirs.push(dir);
		const target = sshTarget(
			{ name: "workstation", kind: "ssh", host: "workstation.example.internal", user: "alex", identityFile: "/k", knownHostsFile: "/kh", hostKeyAlias: "orrery-workstation", connectTimeout: 5 },
			join(dir, "ssh"),
		);
		expect(target).toEqual({
			host: "workstation.example.internal",
			user: "alex",
			identityFile: "/k",
			knownHostsFile: "/kh",
			hostKeyAlias: "orrery-workstation",
			configFile: join(dir, "ssh", "workstation.config"),
		});
		expect(readFileSync(target.configFile as string, "utf8")).toContain("ConnectTimeout 5");
	});
});

describe.skipIf(!process.env.ORRERY_TEST_SSH_HOST)("createAgentEnv (ssh, live)", () => {
	it("runs a command on the remote host", async () => {
		const dir = tempDir("orrery-ssh-live-");
		dirs.push(dir);
		const agentEnv = createAgentEnv(
			{
				name: "live",
				kind: "ssh",
				host: process.env.ORRERY_TEST_SSH_HOST as string,
				identityFile: process.env.ORRERY_TEST_SSH_KEY as string,
				knownHostsFile: process.env.ORRERY_TEST_SSH_KNOWN_HOSTS as string,
				hostKeyAlias: "orrery-live",
				connectTimeout: 5,
			},
			"/tmp",
			join(dir, "ssh"),
			ctx,
		);
		const result = await agentEnv.env().exec("echo remote-ok", undefined, ctx);
		expect(result.ok).toBe(true);
		await agentEnv.close();
	});
});
