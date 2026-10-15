import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentConfig, parseConfig } from "../../src/agent/config.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import { createKey, keyToCode } from "../../src/remote/crypto.ts";
import { FakeStorage } from "../../src/remote/fake.ts";
import { agentSettings } from "../../src/remote/save-format.ts";
import { saveRemoteSecret } from "../../src/remote/secrets.ts";
import { RemoteSession } from "../../src/remote/session.ts";
import { agentConfigToml } from "../agent/support.ts";

export async function checkoutFixture() {
	const root = mkdtempSync(join(tmpdir(), "orrery-checkout-"));
	const folder = join(root, "folder");
	mkdirSync(folder);
	const config = parseConfig(`${agentConfigToml({ dataDir: join(root, "data"), folder, extra: 'remote = "home"' })}
[remotes.home]
kind = "cloudflare"
url = "https://example.invalid"
`, root);
	const agent = config.agents.get("Test") as AgentConfig & { readonly folder: string };
	const key = createKey();
	saveRemoteSecret(config, "home", { key: keyToCode(key), token: "fake-token" });
	const clock = { value: Date.now() };
	const storage = new FakeStorage({ name: "home", now: () => clock.value });
	const source = join(root, "source");
	const store = MemoryStore.open(join(source, "memory.sqlite"));
	store.append("user", "from the remote");
	store.close();
	await RemoteSession.push({ agent: agent.name, agentDir: source, storage, key, holder: { machine: "macbook", device: "other", pid: 1 }, report: () => {}, settings: agentSettings(agent) });
	return { root, config, agent, key, storage, clock, close: () => rmSync(root, { recursive: true, force: true }) };
}
