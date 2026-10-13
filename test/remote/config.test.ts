import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../../src/lane/config.ts";

const BASE = `
[hosts.home]
host = "192.0.2.10"
user = "alex"
identity_file = "ssh/id_ed25519"

[lanes.Atlas]
workspace = "/home/alex/agent-Atlas"
compactor_model = "openai/gpt-5.1-mini"
`;

describe("remotes in the config", () => {
	it("parses a server and a cloudflare remote and a lane's remote", () => {
		const config = parseConfig(
			`machine_name = "pc"\n${BASE}remote = "home-mem"\n\n[remotes.home-mem]\nkind = "server"\nhost = "home"\nfolder = "orrery lanes"\n\n[remotes.cloud]\nkind = "cloudflare"\nurl = "https://orrery-memory.alex.workers.dev"\n`,
			"/etc/orrery",
		);
		expect(config.machineName).toBe("pc");
		expect(config.lanes.get("Atlas")?.remote).toBe("home-mem");
		const server = config.remotes.get("home-mem");
		expect(server?.kind).toBe("server");
		expect(server?.kind === "server" && server.host.name).toBe("home");
		expect(server?.kind === "server" && server.folder).toBe("orrery lanes");
		expect(config.remotes.get("cloud")).toEqual({ name: "cloud", kind: "cloudflare", url: "https://orrery-memory.alex.workers.dev" });
	});

	it("leaves lanes local and names the machine after the host when nothing is set", () => {
		const config = parseConfig(BASE, "/etc/orrery");
		expect(config.lanes.get("Atlas")?.remote).toBeUndefined();
		expect(config.remotes.size).toBe(0);
		expect(config.machineName.length).toBeGreaterThan(0);
	});

	it.each([
		[`${BASE}remote = "nope"\n`, /unknown remote "nope"/],
		[`${BASE}\n[remotes.x]\nkind = "server"\nhost = "missing"\nfolder = "m"\n`, /unknown host "missing"/],
		[`${BASE}\n[remotes.x]\nkind = "server"\nhost = "local"\nfolder = "m"\n`, /must name an SSH host/],
		[`${BASE}\n[remotes.x]\nkind = "cloudflare"\nurl = "http://example.com"\n`, /must be https/],
		[`${BASE}\n[remotes.x]\nkind = "ftp"\n`, /kind must be one of server, cloudflare/],
		[`${BASE}\n[remotes."bad name"]\nkind = "cloudflare"\nurl = "https://x.dev"\n`, /names use letters/],
		[`${BASE}\n[remotes.x]\nkind = "server"\nhost = "home"\nfolder = ""\n`, /folder must be a non-empty string/],
		[`${BASE}\n[remotes.x]\nkind = "server"\nhost = "home"\nfolder = "   "\n`, /folder must not be empty/],
	])("refuses a bad remote setting (%#)", (text, message) => {
		expect(() => parseConfig(text, "/etc/orrery")).toThrow(ConfigError);
		expect(() => parseConfig(text, "/etc/orrery")).toThrow(message);
	});

	it("allows http only for a loopback cloudflare url (tests)", () => {
		const config = parseConfig(`${BASE}\n[remotes.dev]\nkind = "cloudflare"\nurl = "http://127.0.0.1:8787"\n`, "/etc/orrery");
		expect(config.remotes.get("dev")?.kind).toBe("cloudflare");
	});
});
