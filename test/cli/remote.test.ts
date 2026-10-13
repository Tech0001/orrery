import { spawnSync } from "node:child_process";
import { readFileSync, statSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { remoteCommand, setStorageForTests } from "../../src/cli/remote.ts";
import { loadConfig } from "../../src/lane/config.ts";
import { createKey, keyToCode, codeToKey, keyMatches, seal, sealCheck } from "../../src/remote/crypto.ts";
import { RemoteError } from "../../src/remote/types.ts";
import { FakeStorage } from "../../src/remote/fake.ts";
import { checkOutLane } from "../../src/remote/checkout.ts";
import { openStorage } from "../../src/remote/index.ts";
import { readRemoteSecret, removeRemoteSecret, saveRemoteSecret } from "../../src/remote/secrets.ts";
import { cleanEnv, cliCommand } from "../claude/support.ts";
import { tempDir } from "../lane/support.ts";

let dir: string;
let path: string;
let storage: FakeStorage;
let clock: number;
const code = "k".repeat(43);
const token = "never-print-this-token";
const peer = { machine: "macbook", device: "other", pid: 123 };
const BASE = '# keep this comment\n[remotes.home]\nkind = "cloudflare"\nurl = "https://example.com"\n';
beforeEach(() => {
	dir = tempDir("orrery-remote-cli-");
	path = join(dir, "config.toml");
	writeFileSync(path, `data_dir = "${dir}/data"\n${BASE}`);
	clock = Date.parse("2026-10-12T14:02:00Z");
	storage = new FakeStorage({ name: "home", now: () => clock });
	setStorageForTests(() => storage);
	saveRemoteSecret(loadConfig(path), "home", { key: code, token });
});
afterEach(() => { setStorageForTests(undefined); rmSync(dir, { recursive: true, force: true }); });
const cli = (...args: string[]) => {
	const c = cliCommand(["--config", path, ...args]);
	return spawnSync(c.cmd, c.args, { env: cleanEnv({}), encoding: "utf8", timeout: 15000 });
};

describe("orrery remote lanes", () => {
	it("lists closed, held and stale lanes without changing their locks", async () => {
		const taken = await storage.take("Birch", peer);
		if (!taken.ok) throw new Error("held");
		await storage.release("Birch", taken.lock);
		await storage.take("Atlas", peer);
		const before = await storage.list();
		const text = await remoteCommand(path, ["lanes", "home"]);
		expect(text).toContain("Birch");
		expect(text).toContain("closed");
		expect(text).toContain("Atlas");
		expect(text).toContain("open on macbook");
		expect(await storage.list()).toEqual(before);
		clock += 181000;
		expect(await remoteCommand(path, ["lanes", "home"])).toContain("stale");
	});

	it("returns valid JSON with no encryption key or access token", async () => {
		await storage.take("Atlas", peer);
		const text = await remoteCommand(path, ["lanes", "home"], { json: true });
		expect(JSON.parse(text)).toMatchObject({ remote: "home", lanes: [{ lane: "Atlas", newestSave: 0, lock: { holder: peer, held: true, stale: false } }] });
		expect(text).not.toContain(code);
		expect(text).not.toContain(token);
	});

	it("reports an empty remote clearly in text and as an empty JSON list", async () => {
		expect(await remoteCommand(path, ["lanes", "home"])).toMatch(/no lanes/i);
		expect(JSON.parse(await remoteCommand(path, ["lanes", "home"], { json: true }))).toEqual({ remote: "home", lanes: [] });
	});

	it("refuses unknown remotes even when a storage hook is installed", async () => {
		await expect(remoteCommand(path, ["lanes", "missing"])).rejects.toThrow(/unknown remote/i);
	});

	it("does not let terminal control characters in holder names escape", async () => {
		await storage.take("Atlas", { ...peer, machine: "mac\u001b[31mbook\nforged row" });
		const text = await remoteCommand(path, ["lanes", "home"]);
		expect(text).not.toContain("\u001b");
		expect(text.trim().split("\n")).toHaveLength(1);
	});
});

describe("orrery remote remove", () => {
	it("warns and refuses removal without --yes, preserving the only saved key", async () => {
		const before = readFileSync(path, "utf8");
		await expect(remoteCommand(path, ["remove", "home"])).rejects.toThrow(/key.*recovery code.*--yes/i);
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(readRemoteSecret(loadConfig(path), "home")).toEqual({ key: code, token });
		const result = cli("remote", "remove", "home");
		expect(result.status).toBe(1); expect(result.stderr).toContain("--yes");
	});

	it("accepts a TUI confirmation and preserves credentials when declined", async () => {
		let warning = "";
		const refused = await remoteCommand(path, ["remove", "home"], {}, { secret: async () => undefined, confirm: async (q) => { warning = q; return false; } });
		expect(warning).toMatch(/key.*recovery code/i); expect(refused).toContain("Not removed");
		expect(readRemoteSecret(loadConfig(path), "home")?.key).toBe(code);
		await remoteCommand(path, ["remove", "home"], {}, { secret: async () => undefined, confirm: async () => true });
		expect(loadConfig(path).remotes.has("home")).toBe(false);
		expect(readRemoteSecret(loadConfig(path), "home")).toBeUndefined();
	});

	it("removes public config and its secret, preserving other remotes and comments", async () => {
		writeFileSync(path, `${readFileSync(path, "utf8")}\n# keep other\n[remotes.other]\nkind = "cloudflare"\nurl = "https://other.example.com"\n`);
		saveRemoteSecret(loadConfig(path), "other", { key: "o".repeat(43), token: "other-token" });
		await storage.take("Atlas", peer);
		const before = await storage.list();
		const text = await remoteCommand(path, ["remove", "home"], { yes: true });
		expect(text).toMatch(/key.*recovery code/i);
		const config = loadConfig(path);
		expect([...config.remotes.keys()]).toEqual(["other"]);
		expect(readRemoteSecret(config, "home")).toBeUndefined();
		expect(readRemoteSecret(config, "other")?.token).toBe("other-token");
		expect(readFileSync(path, "utf8")).toContain("# keep other");
		expect(readFileSync(path, "utf8")).toContain("# keep this comment");
		expect(text).not.toContain(code);
		expect(text).not.toContain(token);
		expect(await storage.list()).toEqual(before);
	});

	it("refuses a remote a lane uses and changes neither config nor credentials", async () => {
		writeFileSync(path, `${readFileSync(path, "utf8")}\n[lanes.Atlas]\nworkspace = "${dir}"\ncompactor_model = "openai/gpt-6.1-sol"\nremote = "home"\n`);
		const before = readFileSync(path, "utf8");
		await expect(remoteCommand(path, ["remove", "home"])).rejects.toThrow(/Atlas.*uses/);
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(readRemoteSecret(loadConfig(path), "home")).toEqual({ key: code, token });
	});

	it("restores the config if credential deletion fails, so removal can be retried", async () => {
		const before = readFileSync(path, "utf8");
		const data = join(dir, "data");
		const actual = join(dir, "actual-data");
		renameSync(data, actual);
		symlinkSync(actual, data, "dir"); // readable, but writePrivate correctly refuses this directory
		await expect(remoteCommand(path, ["remove", "home"], { yes: true })).rejects.toThrow(/not a real folder/);
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(readRemoteSecret(loadConfig(path), "home")).toEqual({ key: code, token });
		unlinkSync(data);
		renameSync(actual, data);
		await remoteCommand(path, ["remove", "home"], { yes: true });
		expect(loadConfig(path).remotes.size).toBe(0);
		expect(readRemoteSecret(loadConfig(path), "home")).toBeUndefined();
	});

	it("is wired into the CLI and needs no connection to remove a remote", () => {
		const result = cli("remote", "remove", "home", "--yes");
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("Removed remote home");
		expect(loadConfig(path).remotes.size).toBe(0);
		expect(readRemoteSecret(loadConfig(path), "home")).toBeUndefined();
	});

	it("wires remote lanes errors and help into the CLI", () => {
		const result = cli("remote", "lanes", "missing", "--json");
		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(/unknown remote/i);
		expect(result.stdout).toBe("");
		const help = cli("help");
		expect(help.stdout).toContain("remote lanes <name> [--json]");
		expect(help.stdout).toContain("remote remove <name>");
	});

	it.each([[], ["lanes"], ["remove"], ["bad", "home"], ["remove", "home", "extra"]].map((args) => [args] as const))("rejects incomplete or ambiguous arguments (%j)", async (args) => {
		const before = readFileSync(path, "utf8");
		await expect(remoteCommand(path, args)).rejects.toThrow();
		expect(readFileSync(path, "utf8")).toBe(before);
	});
});


function newConfig(): void {
	removeRemoteSecret(loadConfig(path), "home");
	writeFileSync(path, `data_dir = "${dir}/data"\n# preserved\n[hosts.server]\nhost = "192.0.2.1"\nuser = "me"\nidentity_file = "id"\n`);
}
const interaction = (answer: string) => ({ secret: async () => answer });

describe("remote add and recovery", () => {
	it.each(["server", "cloudflare"] as const)("recovers a configured %s remote without connection flags or config edits", async (kind) => {
		removeRemoteSecret(loadConfig(path), "home");
		if (kind === "server") {
			newConfig();
			writeFileSync(path, `${readFileSync(path, "utf8")}\n[remotes.home]\nkind = "server"\nhost = "server"\nfolder = "my memory" # keep\n`);
		}
		const before = readFileSync(path, "utf8"); const key = createKey(); const recovery = keyToCode(key);
		const check = sealCheck(key); await storage.putCheck(check); await storage.take("Atlas", peer);
		const lanes = await storage.list(); const prompts: string[] = [];
		setStorageForTests((config, name, secret) => {
			expect(config.remotes.get(name)?.kind).toBe(kind);
			if (kind === "cloudflare") expect(secret?.token).toBe(token);
			else expect(config.remotes.get(name)).toMatchObject({ host: { host: "192.0.2.1", user: "me" }, folder: "my memory" });
			return storage;
		});
		const out = await remoteCommand(path, ["add", "home"], {}, { secret: async (prompt) => {
			prompts.push(prompt); return prompt.startsWith("Cloudflare") ? token : recovery;
		} });
		expect(prompts).toEqual(kind === "cloudflare" ? ["Cloudflare access token (hidden):", "Recovery code (hidden):"] : ["Recovery code (hidden):"]);
		expect(readRemoteSecret(loadConfig(path), "home")).toEqual({ key: recovery, ...(kind === "cloudflare" ? { token } : {}) });
		expect(readFileSync(path, "utf8")).toBe(before); expect(await storage.getCheck()).toEqual(check);
		expect(await storage.list()).toEqual(lanes);
		expect(out).toContain("Added remote home"); expect(out).not.toContain(token); expect(out).not.toContain(recovery);
	});

	it("recovers a configured remote from secret files without prompting", async () => {
		removeRemoteSecret(loadConfig(path), "home");
		const key = createKey(); const recovery = keyToCode(key); await storage.putCheck(sealCheck(key));
		writeFileSync(join(dir, "code"), `${recovery}\n`); writeFileSync(join(dir, "token"), `${token}\n`);
		const before = readFileSync(path, "utf8");
		const out = await remoteCommand(path, ["add", "home"], { "code-file": join(dir, "code"), "token-file": join(dir, "token") }, { secret: async () => { throw new Error("unexpected prompt"); } });
		expect(readRemoteSecret(loadConfig(path), "home")).toEqual({ key: recovery, token });
		expect(readFileSync(path, "utf8")).toBe(before); expect(out).not.toContain(recovery); expect(out).not.toContain(token);
	});

	it("reuses a saved Cloudflare token when only the key needs recovery", async () => {
		saveRemoteSecret(loadConfig(path), "home", { key: "", token });
		const key = createKey(); const recovery = keyToCode(key); await storage.putCheck(sealCheck(key));
		setStorageForTests((_config, _name, secret) => { expect(secret?.token).toBe(token); return storage; });
		const prompts: string[] = [];
		await remoteCommand(path, ["add", "home"], {}, { secret: async (prompt) => { prompts.push(prompt); return recovery; } });
		expect(prompts).toEqual(["Recovery code (hidden):"]);
		expect(readRemoteSecret(loadConfig(path), "home")).toEqual({ key: recovery, token });
	});

	it("asks only for a missing token when the configured remote's saved key already matches", async () => {
		const key = createKey(); const recovery = keyToCode(key); await storage.putCheck(sealCheck(key));
		saveRemoteSecret(loadConfig(path), "home", { key: recovery });
		const prompts: string[] = [];
		const out = await remoteCommand(path, ["add", "home"], {}, { secret: async (prompt) => { prompts.push(prompt); return token; } });
		expect(prompts).toEqual(["Cloudflare access token (hidden):"]);
		expect(readRemoteSecret(loadConfig(path), "home")).toEqual({ key: recovery, token });
		expect(out).not.toContain(recovery); expect(out).not.toContain(token);
	});

	it.each(["wrong code", "cancel", "offline"])("keeps existing config and credentials when configured recovery fails: %s", async (failure) => {
		const previous = { key: "", token }; saveRemoteSecret(loadConfig(path), "home", previous);
		const before = readFileSync(path, "utf8"); const check = sealCheck(createKey()); await storage.putCheck(check);
		if (failure === "offline") storage.getCheck = async () => { throw new RemoteError("unreachable", `offline ${token}`); };
		const wrong = keyToCode(createKey());
		let message = "";
		try { await remoteCommand(path, ["add", "home"], {}, interaction(failure === "cancel" ? "" : wrong)); } catch (error) { message = (error as Error).message; }
		expect(message).toMatch(failure === "wrong code" ? /does not match/ : failure === "cancel" ? /cancelled/ : /offline/);
		expect(message).not.toContain(token); expect(message).not.toContain(wrong);
		expect(readRemoteSecret(loadConfig(path), "home")).toEqual(previous); expect(readFileSync(path, "utf8")).toBe(before);
	});

	it("refuses a configured remote without a key check unless told it is new, then creates its key", async () => {
		removeRemoteSecret(loadConfig(path), "home"); const before = readFileSync(path, "utf8");
		await expect(remoteCommand(path, ["add", "home"], {}, interaction(token))).rejects.toThrow(/no key check.*remote add home --new/i);
		expect(await storage.getCheck()).toBeUndefined(); expect(readRemoteSecret(loadConfig(path), "home")).toBeUndefined();
		const out = await remoteCommand(path, ["add", "home"], { new: true }, interaction(token));
		expect(out).toMatch(/Keep this recovery code somewhere safe/);
		expect(await storage.getCheck()).toBeDefined(); expect(readRemoteSecret(loadConfig(path), "home")?.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(readFileSync(path, "utf8")).toBe(before);
	});

	it("refuses a configured remote that has lanes but no key check", async () => {
		removeRemoteSecret(loadConfig(path), "home"); const before = readFileSync(path, "utf8");
		await storage.take("Atlas", { machine: "other", device: "other", pid: 1 });
		await expect(remoteCommand(path, ["add", "home"], { new: true }, interaction(token))).rejects.toThrow(/lanes.*no key check/i);
		expect(await storage.getCheck()).toBeUndefined(); expect(readRemoteSecret(loadConfig(path), "home")).toBeUndefined();
		expect(readFileSync(path, "utf8")).toBe(before);
	});

	it("keeps configured endpoints fixed and still requires a kind for new remotes", async () => {
		const before = readFileSync(path, "utf8");
		await expect(remoteCommand(path, ["add", "home"], { cloudflare: "https://other.example.com" })).rejects.toThrow(/already.*config/i);
		await expect(remoteCommand(path, ["add", "new"])).rejects.toThrow(/one of.*server.*cloudflare/);
		expect(readFileSync(path, "utf8")).toBe(before);
	});

	it("makes the missing-key and token hints name the bare recovery command", async () => {
		removeRemoteSecret(loadConfig(path), "home");
		writeFileSync(path, `${readFileSync(path, "utf8")}\n[lanes.Atlas]\nworkspace = "${dir}"\ncompactor_model = "openai/gpt-6.1-sol"\nremote = "home"\n`);
		const config = loadConfig(path);
		expect(() => openStorage(config, "home")).toThrow("No token for remote home on this machine: run orrery remote add home");
		try { openStorage(config, "home"); } catch (error) { expect((error as Error).message).not.toContain("--cloudflare"); }
		await expect(checkOutLane(config, config.lanes.get("Atlas")!, { storage, report: () => {} })).rejects.toMatchObject({ kind: "key-missing", message: "No key for remote home on this machine: run orrery remote add home" });
		const run = cli("remote", "add", "home");
		expect(run.status).toBe(1); expect(run.stderr).toContain("--token-file"); expect(run.stderr).not.toContain("Choose exactly one");
	});

	it("refuses --code-file on an empty remote without creating a new key", async () => {
		newConfig(); const before = readFileSync(path, "utf8");
		writeFileSync(join(dir, "code"), `${keyToCode(createKey())}\n`);
		await expect(remoteCommand(path, ["add", "home"], { server: "server:memory", "code-file": join(dir, "code") })).rejects.toThrow(/no key check.*code-file|code-file.*no key check/i);
		expect(await storage.getCheck()).toBeUndefined(); expect(readFileSync(path, "utf8")).toBe(before);
		expect(readRemoteSecret(loadConfig(path), "home")).toBeUndefined();
	});

	it("refuses a remote with lanes but no key check instead of creating another key", async () => {
		newConfig(); const before = readFileSync(path, "utf8"); await storage.take("Atlas", peer); const lanes = await storage.list();
		await expect(remoteCommand(path, ["add", "home"], { server: "server:memory" })).rejects.toThrow(/lanes.*no key check/i);
		expect(await storage.getCheck()).toBeUndefined(); expect(await storage.list()).toEqual(lanes);
		expect(readFileSync(path, "utf8")).toBe(before); expect(readRemoteSecret(loadConfig(path), "home")).toBeUndefined();
	});

	it.each([`${token}\nsecond-secret\n`, `${token}\rsecond-secret`, `\n${token}\n`])("refuses multiline token files without echoing their content", async (content) => {
		newConfig(); writeFileSync(join(dir, "token"), content);
		await expect(remoteCommand(path, ["add", "home"], { cloudflare: "https://example.com", "token-file": join(dir, "token") })).rejects.toThrow(/single line/i);
		expect(await storage.getCheck()).toBeUndefined(); expect(loadConfig(path).remotes.size).toBe(0);
	});
	it.each(["server", "cloudflare"])("creates a %s remote, keeps its credentials private and prints the new code once", async (kind) => {
		newConfig();
		const options = kind === "server" ? { server: "server:-folder with 'quotes':and:$dollars" } : { cloudflare: "https://example.com" };
		const out = await remoteCommand(path, ["add", "home"], options, interaction(token));
		const config = loadConfig(path);
		const secret = readRemoteSecret(config, "home")!;
		expect(secret.key).toHaveLength(43);
		expect(out.split(secret.key)).toHaveLength(2);
		expect(out).toContain("Keep this recovery code somewhere safe. Another machine needs it to read this remote.");
		expect(keyMatches(codeToKey(secret.key), (await storage.getCheck())!)).toBe(true);
		expect(config.remotes.get("home")?.kind).toBe(kind);
		expect(readFileSync(path, "utf8")).toContain("# preserved");
		expect(readFileSync(path, "utf8")).not.toContain(secret.key);
		expect(out).not.toContain(token);
		expect(statSync(join(config.dataDir, "remotes.json")).mode & 0o777).toBe(0o600);
		if (kind === "cloudflare") expect(secret.token).toBe(token);
		else expect(config.remotes.get("home")).toMatchObject({ folder: "-folder with 'quotes':and:$dollars" });
	});

	it("imports existing keys from files without prompting or printing credentials", async () => {
		newConfig();
		const key = createKey(); await storage.putCheck(sealCheck(key));
		writeFileSync(join(dir, "code"), `${keyToCode(key)}\n`);
		writeFileSync(join(dir, "token"), `${token}\n`);
		const out = await remoteCommand(path, ["add", "home"], { cloudflare: "https://example.com", "code-file": join(dir, "code"), "token-file": join(dir, "token") }, { secret: async () => { throw new Error("unexpected prompt"); } });
		expect(readRemoteSecret(loadConfig(path), "home")).toEqual({ key: keyToCode(key), token });
		expect(out).not.toContain(keyToCode(key)); expect(out).not.toContain(token);
	});

	it("refuses the wrong recovery code and preserves config and credentials", async () => {
		newConfig(); const before = readFileSync(path, "utf8");
		await storage.putCheck(sealCheck(createKey()));
		await expect(remoteCommand(path, ["add", "home"], { server: "server:memory" }, interaction(keyToCode(createKey())))).rejects.toThrow(/recovery code/);
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(readRemoteSecret(loadConfig(path), "home")).toBeUndefined();
	});

	it("keeps a newly generated key recoverable when the putCheck reply is lost", async () => {
		newConfig(); const put = storage.putCheck.bind(storage);
		storage.putCheck = async (file) => { await put(file); throw new RemoteError("unreachable", "reply lost"); };
		await expect(remoteCommand(path, ["add", "home"], { server: "server:memory" })).rejects.toThrow(/reply lost/);
		const secret = readRemoteSecret(loadConfig(path), "home")!;
		expect(keyMatches(codeToKey(secret.key), (await storage.getCheck())!)).toBe(true);
		storage.putCheck = put;
		const out = await remoteCommand(path, ["add", "home"], { server: "server:memory" }, { secret: async () => { throw new Error("saved key should recover setup"); } });
		expect(loadConfig(path).remotes.has("home")).toBe(true);
		expect(out).toContain(secret.key);
	});

	it("requires secret files in non-TTY use and rejects conflicting remote kinds", async () => {
		newConfig();
		const run = cli("remote", "add", "home", "--cloudflare", "https://example.com");
		expect(run.status, run.stderr).toBe(1); expect(run.stderr).toContain("--token-file");
		await expect(remoteCommand(path, ["add", "home"], { server: "server:m", cloudflare: "https://example.com" })).rejects.toThrow(/one of/);
		expect(loadConfig(path).remotes.size).toBe(0);
	});
});

describe("remote test, key and log", () => {
	async function workingKey() {
		const key = createKey(); saveRemoteSecret(loadConfig(path), "home", { key: keyToCode(key), token });
		await storage.putCheck(sealCheck(key)); return key;
	}
	it("tests reachability, locks and decryption and removes its test lane", async () => {
		await workingKey();
		const text = await remoteCommand(path, ["test", "home"]);
		expect(text.match(/✓/g)).toHaveLength(4);
		expect(text).toMatch(/key.*decrypt/i);
		expect(await storage.list()).toEqual([]);
	});
	it("reports failed key verification without leaving its test lock held or exposing secrets", async () => {
		// The remote's check was made with one key; this machine holds another.
		saveRemoteSecret(loadConfig(path), "home", { key: keyToCode(createKey()), token });
		await storage.putCheck(sealCheck(createKey()));
		await expect(remoteCommand(path, ["test", "home"])).rejects.toThrow(/✗.*key/i);
		expect(await storage.list()).toEqual([]);
	});
	it("does not delete a lane already named orrery-test", async () => {
		await workingKey(); const taken = await storage.take("orrery-test", peer); if (!taken.ok) throw new Error("held");
		await storage.snapshot("orrery-test", taken.lock, 0, new Uint8Array([7])); await storage.release("orrery-test", taken.lock);
		await expect(remoteCommand(path, ["test", "home"])).rejects.toThrow(/orrery-test.*memory/);
		expect((await storage.fetch("orrery-test", -1)).snapshot?.file).toEqual(new Uint8Array([7]));
	});
	it("cleans up an empty test lane left by an older remote test", async () => {
		await workingKey(); const taken = await storage.take("orrery-test", peer); if (!taken.ok) throw new Error("held");
		await storage.release("orrery-test", taken.lock);
		expect(await remoteCommand(path, ["test", "home"])).toContain("✓ key decrypts");
		expect(await storage.list()).toEqual([]);
	});
	it("does not delete memory created in orrery-test between listing and taking its lock", async () => {
		await workingKey(); const take = storage.take.bind(storage); let first = true;
		storage.take = async (lane, holder, options) => {
			if (first) {
				first = false; const other = await take(lane, peer); if (!other.ok) throw new Error("held");
				await storage.snapshot(lane, other.lock, 0, new Uint8Array([8])); await storage.release(lane, other.lock);
			}
			return take(lane, holder, options);
		};
		await expect(remoteCommand(path, ["test", "home"])).rejects.toThrow(/orrery-test.*memory/);
		expect((await storage.fetch("orrery-test", -1)).snapshot?.file).toEqual(new Uint8Array([8]));
		expect((await storage.list())[0].lock?.held).toBe(false);
	});
	it("releases the test lock if cleanup fails and reports the failure", async () => {
		await workingKey(); storage.drop = async () => { throw new RemoteError("unreachable", "offline"); };
		await expect(remoteCommand(path, ["test", "home"])).rejects.toThrow(/test lane removed.*offline/);
		expect((await storage.list())[0].lock?.held).toBe(false);
	});
	it("prints the code only through the explicit key command, after a secret warning", async () => {
		const key = await workingKey();
		expect(await remoteCommand(path, ["key", "home"])).toBe(`This is a secret.\n${keyToCode(key)}\n`);
		expect(cli("remote", "key", "home").stdout).toBe(`This is a secret.\n${keyToCode(key)}\n`);
		await expect(remoteCommand(path, ["key", "home"], { json: true })).rejects.toThrow(/json/);
	});
	it("marks only explicit takeovers and shows their source, ignoring ordinary lock changes", async () => {
		const key = await workingKey();
		writeFileSync(path, `${readFileSync(path, "utf8")}\n[lanes.Atlas]\nworkspace = "${dir}"\ncompactor_model = "openai/gpt-6.1-sol"\nremote = "home"\n`);
		for (let n = 1; n <= 3; n++) {
			const take = await storage.take("Atlas", peer); if (!take.ok) throw new Error("held");
			const header = { v: 1, n, lock: take.lock, machine: "macbook", device: "other", at: "2026-10-12T14:02:00Z", rows: { main: 2, tree: 0, usage: 1, meta: 0 }, sha256: "a".repeat(64), token, key: keyToCode(key), ...(n === 1 || n === 3 ? { takeover: { from: "old-pc" } } : {}) };
			await storage.save("Atlas", take.lock, n, new Uint8Array([n]), seal(key, "Atlas", "log", n, Buffer.from(JSON.stringify(header))));
			await storage.release("Atlas", take.lock);
		}
		const out = await remoteCommand(path, ["log", "atlas"], { json: true });
		expect(JSON.parse(out).log.map((h: { takeover: boolean }) => h.takeover)).toEqual([true, false, true]);
		expect(JSON.parse(out).log[1]).toMatchObject({ n: 2, rows: { main: 2, usage: 1 } });
		expect(out).not.toContain(token); expect(out).not.toContain(keyToCode(key));
		const text = await remoteCommand(path, ["log", "Atlas"]);
		expect(text.match(/taken over from old-pc/g)).toHaveLength(2); expect(text).not.toContain("lock changed");
	});
	it("rejects tampered and incorrectly bound log entries", async () => {
		const key = await workingKey();
		writeFileSync(path, `${readFileSync(path, "utf8")}\n[lanes.Atlas]\nworkspace = "${dir}"\ncompactor_model = "openai/gpt-6.1-sol"\nremote = "home"\n`);
		const take = await storage.take("Atlas", peer); if (!take.ok) throw new Error("held");
		await storage.save("Atlas", take.lock, 1, new Uint8Array([1]), seal(key, "Atlas", "save", 1, Buffer.from("private malformed text")));
		await expect(remoteCommand(path, ["log", "Atlas"], { json: true })).rejects.toThrow(/decrypt/);
	});
});
