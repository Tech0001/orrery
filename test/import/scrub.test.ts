import { describe, expect, it } from "vitest";
import { scrub } from "../../src/import/scrub.ts";

describe("scrub", () => {
	it("redacts common credentials and keeps the surrounding text", () => {
		const input = [
			"anthropic sk-ant-" + "oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
			"openai sk-" + "proj-AbCdEfGhIjKlMnOpQrStUvWx",
			"gh ghp" + "_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
			"aws AKIA" + "ABCDEFGHIJKLMNOP",
			"jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2lnbmF0dXJl",
			'config: api_key = "q8Zr2Lm9Kd71XwQpTt5v"',
			"-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----",
		].join("\n");
		const { text, kinds } = scrub(input);
		for (const secret of ["sk-ant-oat01", "sk-proj-AbCd", "ghp_AbCd", "AKIAABCD", "eyJhbGci", "q8Zr2Lm9", "b3BlbnNzaC1rZXk"]) {
			expect(text).not.toContain(secret);
		}
		expect(text).toContain("anthropic [REDACTED:anthropic-key]");
		expect(text).toContain('api_key = "[REDACTED:assignment]"');
		expect(kinds.sort()).toEqual(["anthropic-key", "assignment", "aws-key", "github-token", "jwt", "openai-key", "private-key"]);
	});

	it("redacts env-style names, quoted passwords, bearer tokens and URL credentials", () => {
		const input = [
			"export GITLAB_TOKEN=4f3a9c2e1b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39",
			'OPENAI_API_KEY="abcd1234efgh5678ijkl"',
			'DB_PASSWORD="Tr0ub4dor&3"',
			'curl -H "Authorization: Bearer abc123DEF456ghi789JKL" http://127.0.0.1:18080/v1',
			"git clone https://alex:hunter2secret@example.internal:3000/examples/x.git",
		].join("\n");
		const { text, kinds } = scrub(input);
		for (const secret of ["4f3a9c2e", "abcd1234", "Tr0ub4dor", "abc123DEF", "hunter2secret"]) expect(text).not.toContain(secret);
		expect(text).toContain("export GITLAB_TOKEN=[REDACTED:assignment]");
		expect(text).toContain('DB_PASSWORD="[REDACTED:assignment]"');
		expect(text).toContain("Bearer [REDACTED:bearer-token]");
		expect(text).toContain("https://alex:[REDACTED:url-credential]@example.internal:3000/examples/x.git");
		expect(text).toContain("http://127.0.0.1:18080/v1");
		expect(kinds.sort()).toEqual(["assignment", "assignment", "assignment", "bearer-token", "url-credential"]);
	});

	it("redacts JSON keys, CLI flags, short literal passwords, lowercase bearer and PGP or truncated private keys", () => {
		const input = [
			'{"api_key": "k3y-1234", "client_secret": "abc12345xyz"}',
			"gh auth login --token gho_short1234 && tool --password=pa55word",
			"password: hunter2",
			"authorization: bearer abcdefghij0123456789",
			"Authorization: Basic dXNlcjpwYXNzd29yZDEyMw==",
			"-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF0secretbody\n-----END PGP PRIVATE KEY BLOCK-----",
			"-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAtruncated",
		].join("\n");
		const { text } = scrub(input);
		for (const secret of ["k3y-1234", "abc12345xyz", "gho_short1234", "pa55word", "hunter2", "abcdefghij0123456789", "dXNlcjpw", "lQOYBF0", "MIIEowIBAAKCAQEA"]) {
			expect(text).not.toContain(secret);
		}
		expect(text).toContain('"api_key": "[REDACTED:assignment]"');
		expect(text).toContain("password: [REDACTED:assignment]");
	});

	it("has no length or spacing gaps: aligned configs, long names, long tokens, colons in URL passwords", () => {
		const longJwt = `eyJhbGciOiJIUzI1NiJ9.eyJ${"a".repeat(10_000)}.c2lnbmF0dXJlc2lnbmF0dXJl`;
		const input = [
			'password            = "Sup3rSecret!"',
			'SOME_SERVICE_PRODUCTION_DATABASE_ADMIN_REPLICA_PASSWORD="abc12345678"',
			`ghp_${"b".repeat(300)}`,
			`token ${longJwt}`,
			`api_key="${"c1".repeat(2_500)}"`,
			"https://bot:pa:ss123@host/x",
			"key-sk-" + "proj-AbCdEfGhIjKlMnOpQrStUvWx",
			'"api_key":\n    "q8Zr2Lm9Kd71"',
		].join("\n");
		const { text } = scrub(input);
		for (const secret of ["Sup3rSecret", "abc12345678", "bbbbbbbbbb", "aaaaaaaaaa", "c1c1c1c1", "pa:ss123", "ss123", "AbCdEfGh", "q8Zr2Lm9"]) {
			expect(text).not.toContain(secret);
		}
		expect(text).toContain("https://bot:[REDACTED:url-credential]@host/x");
	});

	it("closes the reviewed gaps: passphrases, plain-letter or digit tokens, empty-user URLs, escaped JSON, CLI passwords, vendor tokens", () => {
		const input = [
			"password=correcthorsebatterystaple",
			"secret: correcthorsebatterystaple",
			"TOKEN=abcdefghijklmnopqrstuvwxyz",
			"api_key = 1234567890123456789",
			"redis://:s3cretpw@host:6379/0",
			'body: "{\\"password\\":\\"Tr0ub4dor3\\",\\"token\\":\\"abcdef0123456789xyz\\"}"',
			"curl -u alex:Tr0ub4dor3 http://example.internal:3000/api/v1/user",
			"curl --user=alex:Tr0ub4dor4 https://example.test",
			"sshpass -p Hunter2pass ssh alex@example.internal",
			"mysql -uroot -pSecret1 sample",
			`hf_${"A1b2C3d4".repeat(5)} sk_live_${"x9Y8".repeat(6)} AIza${"Sy0aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV"} npm_${"a1B2".repeat(9)}`,
			"tskey-" + "auth-k1a2b3c4CNTRL-AbCdEfGhIjKlMnOpQrStUv https://hooks.slack.com/" + "services/T0001/B0002/XyZxyzXyZxyz",
		].join("\n");
		const { text } = scrub(input);
		for (const secret of [
			"correcthorse",
			"abcdefghijklmnop",
			"1234567890123456789",
			"s3cretpw",
			"Tr0ub4dor3",
			"abcdef0123456789xyz",
			"Tr0ub4dor4",
			"Hunter2pass",
			"Secret1",
			"A1b2C3d4",
			"x9Y8x9Y8",
			"Sy0aB1cD",
			"a1B2a1B2",
			"k1a2b3c4",
			"XyZxyzXyZxyz",
		]) {
			expect(text, secret).not.toContain(secret);
		}
		expect(text).toContain("curl -u alex:[REDACTED:url-credential] http://example.internal:3000/api/v1/user");
		const slashes = scrub('password="pa\\ss0rd!x"\nsecret=abc\\def123\napi_key: "C:\\keys\\prod\\k3y"').text;
		for (const secret of ["ss0rd", "def123", "abc", "prod", "k3y"]) expect(slashes, secret).not.toContain(secret);
		expect(text).toContain("redis://:[REDACTED:url-credential]@host:6379/0");
	});

	it("leaves commit ids, UUIDs, hashes and ordinary prose alone", () => {
		const input =
			"landed 0123456789abcdef0123456789abcdef01234567, session 00000000-1111-4222-8333-444444444444, " +
			"sha256 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef, the token budget is fine, " +
			"password: required, max_tokens = 128000, --max-tokens 128000, " +
			"remote http://example.internal:3000/examples/orrery.git, ssh alex@example.internal, basic setup, " +
			"git push -u origin main, mysql -p sample, password: optional, http://:8080/health";
		expect(scrub(input)).toEqual({ text: input, kinds: [] });
	});

	it("stays linear on adversarial input", () => {
		const n = 200_000;
		const inputs = [
			"token".repeat(n / 5),
			"token ".repeat(n / 6),
			`Bearer${" ".repeat(n)}`,
			"-eyJ".repeat(n / 4),
			`GITLAB_TOKEN${" ".repeat(n)}x`,
			"a://b:".repeat(n / 6),
			`password="${"x".repeat(n)}`,
			"-----BEGIN RSA PRIVATE KEY-----".repeat(n / 32),
			`ghp_${"a".repeat(n)}_`,
			"a.".repeat(n / 2),
			`password${" ".repeat(n)}`,
			`x://u:${"p".repeat(n)}`,
			`api_key="${"x".repeat(n)}`,
			"password:".repeat(n / 9),
			` eyJ${"a".repeat(n)}`,
			` eyJ${"a".repeat(20)}.${"b".repeat(n)}`,
			`mysql ${"x -".repeat(n / 3)}`,
			` -u ${"a".repeat(n)}`,
			'\\"password\\":'.repeat(n / 14),
			`sshpass -p ${"q".repeat(n)}`,
		];
		for (const input of inputs) {
			const started = performance.now();
			scrub(input);
			// Linear takes a few ms; quadratic on 200,000 characters takes many seconds. The margin is for a busy CI runner.
			expect(performance.now() - started, input.slice(0, 20)).toBeLessThan(1000);
		}
	});
});
