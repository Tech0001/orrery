/**
 * Redacts key-shaped secrets before history leaves this machine (spec §7). Pattern-only by design: an entropy
 * check would also redact the git SHAs, hashes and ids this history is full of.
 *
 * Every pattern is linear in the input, without capping what it can match: a pattern is only tried where a run
 * starts, and where a run must be followed by something (a dot, a quote, an @), the whole run is taken at once with
 * a lookahead and a backreference, so the engine never backtracks into it.
 */

type Rule = readonly [kind: string, pattern: RegExp, keep?: (value: string) => boolean];

/** `run` matched as a whole: what `(?>run)` would be in an engine with atomic groups. */
const atomic = (name: string, run: string) => String.raw`(?=(?<${name}>${run}))\k<${name}>`;

const WORD_START = String.raw`(?<![A-Za-z0-9_])`;
const TOKEN_START = String.raw`(?<![A-Za-z0-9_-])`;
const B64URL = "[A-Za-z0-9_-]";

const TOKENS: readonly Rule[] = [
	["anthropic-key", new RegExp(`${WORD_START}sk-ant-[A-Za-z0-9_-]{20,}`, "g")],
	["openai-key", new RegExp(`${WORD_START}sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}`, "g")],
	["github-token", new RegExp(`${WORD_START}(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})`, "g")],
	["aws-key", new RegExp(`${WORD_START}(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Za-z])`, "g")],
	["slack-token", new RegExp(`${WORD_START}xox[abprs]-[A-Za-z0-9-]{10,}`, "g")],
	["jwt", new RegExp(`${TOKEN_START}eyJ${atomic("h", `${B64URL}{10,}`)}\\.${atomic("p", `${B64URL}{10,}`)}\\.${B64URL}{10,}`, "g")],
	["huggingface-token", new RegExp(`${WORD_START}hf_[A-Za-z0-9]{30,}`, "g")],
	["stripe-key", new RegExp(`${WORD_START}[rs]k_(?:live|test)_[A-Za-z0-9]{20,}`, "g")],
	["google-key", new RegExp(`${WORD_START}AIza[0-9A-Za-z_-]{35}`, "g")],
	["npm-token", new RegExp(`${WORD_START}npm_[A-Za-z0-9]{36,}`, "g")],
	["tailscale-key", new RegExp(`${WORD_START}tskey-[a-z]+-[A-Za-z0-9-]{20,}`, "g")],
	["slack-webhook", /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g],
];

// A secret-looking name, including env-style names such as GITLAB_TOKEN or OPENAI_API_KEY.
const KEYWORD = "(?:api[_-]?key|secret|token|password|passwd|private[_-]?key|access[_-]?key)";
const NAME = String.raw`[A-Za-z0-9_]{0,64}${KEYWORD}[A-Za-z0-9_]{0,64}`;
const STRONG_NAME = String.raw`[A-Za-z0-9_]{0,64}(?:password|passwd|secret)[A-Za-z0-9_]{0,64}`;
const FLAG_NAME = String.raw`--?[A-Za-z0-9_-]{0,64}(?:token|password|passwd|secret|api[_-]?key)[A-Za-z0-9_-]{0,64}`;
// A quote, also backslash-escaped as in a JSON string inside a log line or a curl -d echo.
const QUOTE = String.raw`\\?["']`;
// Between a name and its value: an optional closing quote (JSON), then ":" or "=" with any spacing, aligned or not.
const SEPARATOR = String.raw`(?:${QUOTE})?${atomic("s1", String.raw`\s*`)}[:=]${atomic("s2", String.raw`\s*`)}`;
// Words that stand where a password would ("password: required"), never a password themselves.
const PLACEHOLDER = /^(?:required|optional|true|false|null|none|string|redacted|empty|unset|undefined|hidden|masked)$/i;

/** Each pattern has a `prefix` group that is kept and a `value` group that is redacted. */
const PAIRS: readonly Rule[] = [
	// Bearer value, Authorization: Basic value
	["bearer-token", /\b(?<prefix>bearer[ \t]+)(?<value>[A-Za-z0-9._~+/=-]{16,})/gi],
	["bearer-token", /\b(?<prefix>authorization[ \t]*:[ \t]*(?:basic|token)[ \t]+)(?<value>[A-Za-z0-9._~+/=-]{8,})/gi],
	// scheme://user:password@host (the user may be empty, the password may contain ":")
	["url-credential", new RegExp(String.raw`\b(?<prefix>[a-z][a-z0-9+.-]{0,20}://[^\s:/@]{0,256}:)${atomic("value", String.raw`[^\s/@]+`)}(?=@)`, "gi")],
	// curl -u user:password, curl --user=user:password
	["url-credential", new RegExp(String.raw`${TOKEN_START}(?<prefix>(?:-u|--user)(?:[ \t]{1,4}|=)[^\s:"']{1,128}:)(?<value>[^\s"']+)`, "g")],
	// sshpass -p password, mysql -ppassword (case-sensitive: -P is mysql's port)
	["cli-password", /\b(?<prefix>sshpass[ \t]+-p[ \t]*)(?<value>[^\s"']+)/g],
	["cli-password", /\b(?<prefix>(?:mysql|mysqldump|mysqladmin|mariadb)\b[^\n]{0,200}?[ \t]-p)(?<value>[^\s"'-][^\s"']*)/g],
	// name = "value", and JSON "name": "value": any quoted value of 8+ characters (backslash escapes included)
	["assignment", new RegExp(String.raw`\b(?<prefix>${NAME}${SEPARATOR}(?<q>["']))${atomic("value", String.raw`(?:[^"'\s\\]|\\\S){8,}`)}(?=\k<q>)`, "gi")],
	// the same inside a JSON string, where the quotes themselves are escaped: \"name\":\"value\"
	["assignment", new RegExp(String.raw`\b(?<prefix>${NAME}${SEPARATOR}(?<q>\\["']))${atomic("value", String.raw`[^"'\s\\]{8,}`)}(?=\k<q>)`, "gi")],
	// password = value: unquoted, 6+ characters, unless it is a placeholder word ("password: required")
	["assignment", new RegExp(String.raw`\b(?<prefix>${STRONG_NAME}${SEPARATOR})(?<value>[^\s"',;]{6,})`, "gi"), (value) => PLACEHOLDER.test(value)],
	// token = value: unquoted, 16+ token characters
	["assignment", new RegExp(String.raw`\b(?<prefix>${NAME}${SEPARATOR}(?:${QUOTE})?)(?<value>[A-Za-z0-9_\-./+=]{16,})`, "gi")],
	// --token value, --password=value
	["assignment", new RegExp(String.raw`${TOKEN_START}(?<prefix>${FLAG_NAME}[ =]{1,4})(?<value>[^\s"'=-][^\s"']{7,})`, "gi")],
];

const KEY_BEGIN = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY[A-Z ]{0,20}-----/g;
const KEY_END = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY[A-Z ]{0,20}-----/g;
// The body of a key whose END line is missing: base64, whitespace and "Name: value" header lines.
const KEY_BODY = /(?:[A-Za-z0-9+/=\s]|[A-Za-z-]{1,40}:[^\n]{0,200}\n){0,40000}/y;
const KEY_MAX_BYTES = 40_000;

function redactPrivateKeys(text: string, kinds: string[]): string {
	const ends = [...text.matchAll(KEY_END)].map((match) => ({ at: match.index, stop: match.index + match[0].length }));
	let out = "";
	let last = 0;
	let next = 0;
	for (const begin of text.matchAll(KEY_BEGIN)) {
		if (begin.index < last) continue;
		const bodyStart = begin.index + begin[0].length;
		while (next < ends.length && ends[next].at < bodyStart) next++;
		let stop: number;
		if (next < ends.length && ends[next].at - bodyStart <= KEY_MAX_BYTES) stop = ends[next].stop;
		else {
			KEY_BODY.lastIndex = bodyStart;
			KEY_BODY.exec(text);
			stop = KEY_BODY.lastIndex || bodyStart;
		}
		out += `${text.slice(last, begin.index)}[REDACTED:private-key]`;
		kinds.push("private-key");
		last = stop;
	}
	return last === 0 ? text : out + text.slice(last);
}

export function scrub(input: string): { text: string; kinds: string[] } {
	const kinds: string[] = [];
	let text = redactPrivateKeys(input, kinds);
	for (const [kind, pattern] of TOKENS) {
		text = text.replace(pattern, () => {
			kinds.push(kind);
			return `[REDACTED:${kind}]`;
		});
	}
	for (const [kind, pattern, keep] of PAIRS) {
		text = text.replace(pattern, (...args: unknown[]) => {
			const { prefix, value } = args.at(-1) as { prefix: string; value: string };
			if (value.startsWith("[REDACTED") || keep?.(value)) return args[0] as string;
			kinds.push(kind);
			return `${prefix}[REDACTED:${kind}]`;
		});
	}
	return { text, kinds };
}
