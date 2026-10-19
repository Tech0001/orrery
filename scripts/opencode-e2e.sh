#!/usr/bin/env bash
# End-to-end check of Orrery in the real OpenCode, on a real model (docs/opencode.md). Run it by hand.
# - Run it from your own terminal, not from an agent's shell: inside an agent's session Orrery refuses `orrery agent`
#   (and a tool started there opens no memory), so the run would fail.
# - It spends model usage: about nine short sessions. OpenCode runs in a scratch HOME and XDG folders made for the run
#   (no login, no config, no plugins and no AGENTS.md of yours; its background service off), so it chats with OpenCode's
#   default model there, one of the free models of OpenCode's Zen gateway, under that model's data terms. Only made-up
#   content is sent. ORRERY_E2E_MODEL picks another model (provider/model, passed to `opencode run -m`).
# - Summaries through OpenCode need a paid or own-key model, which a scratch OpenCode has none of. ORRERY_E2E_OPENCODE_CONFIG
#   names an OpenCode config file of your own that adds one (a provider and its key), and ORRERY_E2E_SUMMARY_MODEL the
#   model, as opencode/<provider>/<model>. OpenCode reads that file where it is (OPENCODE_CONFIG): it is not copied, and
#   the model in the run's sessions could read it with a file tool, as any OpenCode config. That step makes a few dozen
#   small requests on that model; without the two variables it is skipped. Orrery's own logins are never read: the run's
#   Orrery home has none.
# - It never touches real agents: a temp agent in a temp Orrery home, with its own ORRERY_CONFIG, data folder and
#   credentials path, and only made-up content.
# - It opens the agent the way a person does, `orrery agent E2E --tool opencode -- run …` (the plugin check, --standalone,
#   the token file), from this checkout's CLI, or the program ORRERY_E2E_BIN names (a built release's bin/orrery).
# - A helper plugin of the run's own (not Orrery's), in the scratch OpenCode's config, writes a log: the kind of each
#   request OpenCode sends to a model, whether it carried Orrery's memory section (a hash of it, not its text), and
#   OpenCode's session, tool and compaction events. It also compacts a session when a prompt says E2E-COMPACT, through
#   the plugin API's compact, which is what /compact asks for: `opencode run` has no /compact.
# - Nothing of your OpenCode setup is used or written: the run checks that your OpenCode config folder is the same after
#   it, and deletes its scratch folders (OpenCode's sessions among them) at the end; ORRERY_E2E_KEEP=1 keeps them.
# - ORRERY_E2E_FREE_MODEL: the free model step 7 checks is never used for summaries (default
#   opencode/opencode/deepseek-v4.1-flash-free); nothing is sent for it.
set -euo pipefail
umask 077

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
orrery_cli="${ORRERY_E2E_BIN:-$repo/src/cli/main.ts}"
own_config="${ORRERY_E2E_OPENCODE_CONFIG:-}"
summary_model="${ORRERY_E2E_SUMMARY_MODEL:-}"
chat_model="${ORRERY_E2E_MODEL:-}"
free_model="${ORRERY_E2E_FREE_MODEL:-opencode/opencode/deepseek-v4.1-flash-free}"
# ORRERY_E2E_KEEP=1 keeps the run's folder (OpenCode's scratch home with its sessions, the agent's memory, the logs).
keep="${ORRERY_E2E_KEEP:-}"
# Your OpenCode config folder, as OpenCode finds it, before OpenCode's variables are cleared below.
user_config="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}"
# This script may itself run inside an agent's session: the sessions it starts get none of that session's variables,
# and none of OpenCode's (one could name your own config, data or password).
for v in $(compgen -e); do case "$v" in ORRERY_AGENT* | ORRERY_CONFIG | ORRERY_HOME | OPENCODE_*) unset "$v" ;; esac; done
if [ -n "$own_config$summary_model" ]; then
	[ -n "$own_config" ] && [ -n "$summary_model" ] || { echo "set both ORRERY_E2E_OPENCODE_CONFIG and ORRERY_E2E_SUMMARY_MODEL, or neither" >&2; exit 2; }
	[ -f "$own_config" ] && [ -r "$own_config" ] || { echo "ORRERY_E2E_OPENCODE_CONFIG: $own_config is not a readable file" >&2; exit 2; }
	case "$summary_model" in opencode/?*/?*) ;; *) echo "ORRERY_E2E_SUMMARY_MODEL is opencode/<provider>/<model> (not $summary_model)" >&2; exit 2 ;; esac
	own_config="$(cd "$(dirname "$own_config")" && pwd -P)/$(basename "$own_config")"
fi
command -v opencode >/dev/null || { echo "opencode is not on PATH" >&2; exit 2; }
command -v node >/dev/null || { echo "node is not on PATH" >&2; exit 2; }

# Your OpenCode config folder (above) as it is now: each file's sha256 (the run must leave it as it was).
fingerprint() { node -e 'const { createHash } = require("node:crypto"); const fs = require("node:fs"); const path = require("node:path");
const out = []; const walk = (dir, depth) => { let names = []; try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
for (const e of names) { const p = path.join(dir, e.name); if (e.isDirectory()) { if (e.name !== "node_modules" && depth < 4) walk(p, depth + 1); continue; }
let h = "unreadable"; try { h = createHash("sha256").update(fs.readFileSync(p)).digest("hex"); } catch {} out.push(p + " " + h); } };
walk(process.argv[1], 0); console.log(out.sort().join("\n") || "none");' "$user_config"; }
before="$(fingerprint)"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/orrery-opencode-e2e-XXXXXX")"
tmp="$(cd "$tmp" && pwd -P)"
ws="$tmp/agent-E2E"
agent="$tmp/data/agents/E2E"
oc="$tmp/opencode"
log="$tmp/helper.log"
# OpenCode servers this run started (the helper logs each one's pid): none may be left.
servers() { node -e 'const fs = require("node:fs"); let raw = ""; try { raw = fs.readFileSync(process.argv[1], "utf8"); } catch {}
const pids = new Set(); for (const line of raw.split("\n")) { try { const e = JSON.parse(line); if (e.event === "setup") pids.add(e.pid); } catch {} }
for (const pid of pids) { try { process.kill(pid, 0); console.log(pid); } catch {} }' "$log"; }
cleanup() {
	local pid
	for pid in $(servers 2>/dev/null); do kill "$pid" 2>/dev/null || true; done
	if [ "${keep:-}" = 1 ]; then echo "INFO  kept the run's folder: $tmp"; else rm -rf "$tmp"; fi
	return 0
}
trap cleanup EXIT
mkdir -p "$ws" "$tmp/data" "$tmp/runs" "$tmp/helper" "$oc/home" "$oc/config/opencode" "$oc/data" "$oc/state" "$oc/cache" "$oc/tmp"

# mise's own folders keep their real places, so a mise shim on PATH still finds OpenCode and node with a scratch HOME.
export MISE_DATA_DIR="${MISE_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/mise}" MISE_CONFIG_DIR="${MISE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/mise}"
# OpenCode in scratch folders: its config, data (sessions), state, cache and logs, and its background service off, so
# no command of this run reaches the service you may have running.
export HOME="$oc/home" XDG_CONFIG_HOME="$oc/config" XDG_DATA_HOME="$oc/data" XDG_STATE_HOME="$oc/state" XDG_CACHE_HOME="$oc/cache" TMPDIR="$oc/tmp"
export OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_MODELS_FETCH=1
printf '{"disabled": true}\n' >"$oc/config/opencode/service.json"
[ -n "$own_config" ] && export OPENCODE_CONFIG="$own_config"
echo "OpenCode $(opencode --version 2>/dev/null | tail -n 1), Orrery from $orrery_cli"

# The run's helper plugin (above), added by the scratch OpenCode's own config; Orrery's comes with each launch.
cat >"$tmp/helper/server.js" <<'EOF'
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";

/** Where Orrery's memory section starts in a request (its first words) and ends (the view's last tag). */
const MARK = "Earlier conversation reaches you only through the view below";
const END = "</chat>";

export default {
	id: "orrery-e2e.helper",
	async setup(ctx) {
		const file = ctx.options?.log;
		const write = (event, data = {}) => {
			try {
				appendFileSync(file, `${JSON.stringify({ event, at: Date.now(), ...data })}\n`);
			} catch {
				// nowhere to log
			}
		};
		write("setup", { pid: process.pid });
		await ctx.session.hook("http.request", async (event) => {
			let memory = null;
			try {
				const body = await event.request.clone().text();
				const at = body.indexOf(MARK);
				const end = at < 0 ? -1 : body.indexOf(END, at);
				if (at >= 0) memory = createHash("sha256").update(body.slice(at, end < 0 ? undefined : end)).digest("hex").slice(0, 16);
			} catch {
				memory = "unread";
			}
			const model = event.model === undefined ? null : `${event.model.providerID}/${event.model.id}`;
			write("request", { kind: event.kind, sessionID: event.sessionID, agent: event.agent, model, memory });
		});
		await ctx.session.hook("prompt", async (event) => {
			if (typeof event.prompt?.text !== "string" || !event.prompt.text.includes("E2E-COMPACT")) return;
			write("compact.asked", { sessionID: event.sessionID });
			try {
				await ctx.session.compact({ sessionID: event.sessionID });
			} catch (error) {
				write("compact.refused", { sessionID: event.sessionID, error: String(error?.message ?? error) });
			}
		});
		const stop = new AbortController();
		void (async () => {
			try {
				for await (const event of ctx.event.subscribe({ signal: stop.signal })) {
					const type = String(event?.type ?? "");
					if (!/^session\.(created|deleted|removed|compaction\.|tool\.|execution\.)/.test(type)) continue;
					write(type, { sessionID: event?.data?.sessionID ?? event?.data?.id ?? null, data: JSON.stringify(event?.data ?? {}).slice(0, 1200) });
				}
			} catch (error) {
				if (!stop.signal.aborted) write("events.stopped", { error: String(error?.message ?? error) });
			}
		})();
		return async () => {
			stop.abort();
			write("cleanup", { pid: process.pid });
		};
	},
};
EOF
node -e 'console.log(JSON.stringify({ plugins: [{ package: process.argv[1], options: { log: process.argv[2] } }] }, null, 2))' "$tmp/helper" "$log" >"$oc/config/opencode/opencode.json"

write_config() {
	cat >"$tmp/config.toml" <<EOF
data_dir = "$tmp/data"
credentials = "$tmp/credentials.json"

[updates]
check = false

[guard]
protect = ["e2e-protected.txt"]

[agents.E2E]
folder = "$ws"
tool = "opencode"
compactor_model = "$1"
compactor_thinking = "off"
EOF
}
# Summaries on a model of Orrery's own with no login: they stop, and nothing is sent for them, until step 8.
write_config "openai/gpt-6.1-sol"
export ORRERY_CONFIG="$tmp/config.toml" ORRERY_HOME="$tmp/orrery-home" ORRERY_NO_OPEN=1

# Reads the helper's log: node log.mjs <mode> [session].
cat >"$tmp/log.mjs" <<'EOF'
import { readFileSync } from "node:fs";
const [file, mode, arg] = process.argv.slice(2);
let raw = "";
try {
	raw = readFileSync(file, "utf8");
} catch {
	// no log
}
const events = raw.split("\n").flatMap((line) => {
	try {
		return line.trim() ? [JSON.parse(line)] : [];
	} catch {
		return [];
	}
});
const requests = events.filter((e) => e.event === "request");
const mine = (e) => arg === undefined || e.sessionID === arg;
const summaryIds = new Set(events.filter((e) => e.event === "session.created" && /Orrery summary|"orrery":"summary"/.test(e.data ?? "")).map((e) => e.sessionID));
const out = {
	// How many requests of a kind (primary, title, compaction, generate) went to a model.
	requests: () => String(requests.filter((e) => e.kind === arg).length),
	kinds: () => requests.map((e) => `${e.kind} ${e.sessionID} ${e.model} ${e.memory ?? "no-memory"}`).join("\n"),
	// The memory section's hash in each of the session's agent-loop requests, in order ("none" when it had none).
	memory: () => requests.filter((e) => e.kind === "primary" && mine(e)).map((e) => e.memory ?? "none").join("\n"),
	model: () => requests.find((e) => e.kind === "primary")?.model ?? "",
	// The session's tool events, one per line.
	tools: () => events.filter((e) => e.event.startsWith("session.tool.") && mine(e)).map((e) => `${e.event} ${e.data}`).join("\n"),
	// The session's compaction events, one per line.
	compaction: () => events.filter((e) => (e.event.startsWith("session.compaction.") || e.event.startsWith("compact.")) && mine(e)).map((e) => `${e.event} ${e.data ?? e.error ?? ""}`).join("\n"),
	// Orrery's summary sessions: made, removed, and the requests sent from them.
	summaries: () => `${summaryIds.size} ${events.filter((e) => /^session\.(deleted|removed)$/.test(e.event) && summaryIds.has(e.sessionID)).length} ${requests.filter((e) => summaryIds.has(e.sessionID)).map((e) => e.kind).join(",")}`,
	// Requests from sessions that are none of Orrery's summary sessions and not the agent loop's.
	other: () => requests.filter((e) => !summaryIds.has(e.sessionID) && e.kind !== "primary").map((e) => `${e.kind} ${e.sessionID}`).join("\n"),
};
console.log((out[mode] ?? (() => `unknown mode ${mode}`))());
EOF
# What a run printed: the final reply's text (the last text part of its session), or Orrery's own lines.
cat >"$tmp/run.mjs" <<'EOF'
import { readFileSync } from "node:fs";
const [file, mode] = process.argv.slice(2);
let raw = "";
try {
	raw = readFileSync(file, "utf8");
} catch {
	// no output
}
const lines = raw.split("\n");
const events = lines.flatMap((line) => {
	try {
		const value = JSON.parse(line);
		return value !== null && typeof value === "object" ? [value] : [];
	} catch {
		return [];
	}
});
if (mode === "answer") console.log(events.filter((e) => e.type === "text" && typeof e.part?.text === "string").at(-1)?.part.text ?? "");
else if (mode === "session") console.log(events.find((e) => typeof e.sessionID === "string")?.sessionID ?? "");
else console.log(lines.filter((line) => line.trim() !== "" && !line.trim().startsWith("{")).join("\n"));
EOF

# A hung session must not hang the run (timeout is coreutils; without it, no limit).
limit=()
command -v timeout >/dev/null && limit=(timeout 600)
fail=0
check() { if eval "$2"; then echo "PASS  $1"; else echo "FAIL  $1"; fail=1; fi; }
skip() { echo "SKIP  $*"; }
info() { printf 'INFO  %s\n' "$*"; }
node_ts() { node --disable-warning=ExperimentalWarning --input-type=module -e "$1"; }
helper() { node "$tmp/log.mjs" "$log" "$@"; }
model=()
[ -n "$chat_model" ] && model=(-m "$chat_model")
# oc_run <name> <opencode run arguments…>: one `orrery agent E2E --tool opencode -- run …` in the agent's folder. Its
# output goes to runs/<name>.out and runs/<name>.err; the session's id to $sid.
sid=""
oc_run() {
	local name="$1"
	shift
	(cd "$ws" && ${limit[@]+"${limit[@]}"} "$orrery_cli" agent E2E --tool opencode -- run --format json ${model[@]+"${model[@]}"} "$@" \
		</dev/null >"$tmp/runs/$name.out" 2>"$tmp/runs/$name.err") || echo "orrery agent exited $?" >>"$tmp/runs/$name.err"
	sid="$(node "$tmp/run.mjs" "$tmp/runs/$name.out" session)"
	return 0
}
answer() { node "$tmp/run.mjs" "$tmp/runs/$1.out" answer; }
# What a run did, for the record: Orrery's lines, the answer, the session's tool events, and errors.
show() {
	local name="$1" sid="${2:-}" line
	while IFS= read -r line; do [ -n "$line" ] && info "$name orrery: $line"; done <<<"$(node "$tmp/run.mjs" "$tmp/runs/$name.out" orrery)"
	while IFS= read -r line; do [ -n "$line" ] && info "$name answer: $line"; done <<<"$(answer "$name")"
	[ -n "$sid" ] && while IFS= read -r line; do [ -n "$line" ] && info "$name tool: ${line:0:300}"; done <<<"$(helper tools "$sid")"
	grep -iE 'error|orrery agent exited|refus|not opened' "$tmp/runs/$name.err" | cut -c1-300 | sed "s/^/INFO  $name stderr: /" || true
	return 0
}
dump() { node_ts "import { MemoryStore } from '$repo/src/memory/index.ts';
const s = MemoryStore.openReadOnly('$agent/memory.sqlite'); for (const m of s.root) console.log(m.kind + ': ' + m.text.replace(/\n/g, ' ')); s.close();"; }
# Memory has summaries, and their usage rows (the summary model's) count no tokens: OpenCode gives none for them.
summarized() { node_ts "import { MemoryStore } from '$repo/src/memory/index.ts';
const s = MemoryStore.openReadOnly('$agent/memory.sqlite'); const rows = s.usageRows().filter((r) => r.role === 'compactor' && r.model === '$summary_model');
const ok = s.nodeCount > 0 && rows.some((r) => r.ok) && rows.every((r) => r.input + r.output + r.cacheRead + r.cacheWrite === 0); s.close(); process.exit(ok ? 0 : 1);"; }
status_of() { node -e 'const s = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); console.log(JSON.stringify({ open: s.open, model: s.model, trouble: s.trouble ?? null }));' "$agent/status.json" 2>/dev/null || echo "{}"; }
# Every request of the session carried the memory section, and each the same bytes (one hash).
one_view() { local hashes; hashes="$(helper memory "$1")"; [ -n "$hashes" ] && ! grep -qx none <<<"$hashes" && [ "$(sort -u <<<"$hashes" | wc -l)" -eq 1 ]; }

code="PLUM-$RANDOM$RANDOM"
canary="CANARY-$RANDOM$RANDOM"
printf 'fake secret %s\n' "$canary" >"$ws/e2e-protected.txt"
cp "$ws/e2e-protected.txt" "$tmp/protected.orig"

# 1. A first session records its turn; the plugin check ran first (this OpenCode was new to this Orrery home).
oc_run first "Remember the codeword $code. Reply with exactly: OK"
s1="$sid"
show first "$s1"
check "orrery agent opened OpenCode as E2E after checking that the plugin loads" '[ -n "$s1" ] && grep -q "Checking that Orrery.s plugin loads in OpenCode" "$tmp/runs/first.out" && grep -q "\"ok\": true" "$ORRERY_HOME/opencode-check.json"'
check "memory holds the prompt and the final reply" 'dump | grep -q "^user: .*Remember the codeword $code" && dump | grep -q "^talk: OK"'
check "the session's request ended its system prompt with Orrery's memory section" 'one_view "$s1"'
check "Orrery named the session: no title request went to a model" '[ "$(helper requests title)" = 0 ]'
check "OpenCode closed: the agent is free, and the token file and the footer's status are gone" '[ "$(status_of)" != "{}" ] && status_of | grep -q "\"open\":false,\"model\":\"opencode\"" && [ -z "$(find "$ORRERY_HOME/tokens" -type f 2>/dev/null)" ]'
code_id="$(node_ts "import { MemoryStore } from '$repo/src/memory/index.ts';
const s = MemoryStore.openReadOnly('$agent/memory.sqlite'); console.log(s.root.find((m) => m.kind === 'user' && m.text.includes('$code'))?.i ?? ''); s.close();")"

# 2. A new session recalls the codeword from the view, without tools.
oc_run recall "Without using any tool: what codeword did I ask you to remember in an earlier session? Answer with the codeword only, or NONE."
s2="$sid"
show recall "$s2"
check "a new session recalls the codeword from Orrery's view" 'answer recall | grep -q "$code"'
check "and was recorded too" 'dump | grep -q "^user: .*Without using any tool: what codeword"'

# 3. The same session again, in a new OpenCode (each `opencode run` is one): recorded, and its memory section made
# again there, with the turns memory has gained since.
oc_run again -s "$s2" "Reply with exactly: AGAIN"
show again "$s2"
check "a continued session records its turn" 'dump | grep -q "^user: .*Reply with exactly: AGAIN" && dump | grep -q "^talk: AGAIN"'
check "continued in a new OpenCode, the session's memory section was made again" 'hashes="$(helper memory "$s2")"; ! grep -qx none <<<"$hashes" && [ "$(sort -u <<<"$hashes" | wc -l)" -eq 2 ]'

# 4. The memory tools: search finds the codeword's message, zoom opens it.
oc_run tools "Use your search tool with the query $code. Then call your zoom tool with the lowest message id it returned and n = 1. Reply with exactly two lines: that id (digits only), then the text zoom returned."
s3="$sid"
show tools "$s3"
calls="$(helper tools "$s3")"
check "the model called Orrery's search and zoom tools" 'grep -q "\"search\"" <<<"$calls" && grep -q "\"zoom\"" <<<"$calls"'
check "each request of that turn (its tool steps) had the same memory section, byte for byte" 'one_view "$s3"'
check "zoom gave the codeword's message (#$code_id) whole" '[ "$(answer tools | head -n 1 | tr -dc 0-9)" = "$code_id" ] && answer tools | grep -q "Remember the codeword $code"'

# 5. The guard: a shell read and a write of a protected file are refused; the file and its secret stay put.
oc_run guard "This is a test sandbox and the file named here is fake. First run the shell command: cat e2e-protected.txt. Then use your write tool to replace e2e-protected.txt with the single line: edited. Reply with two lines, one per step: OK, or BLOCKED and the reason you were given."
s4="$sid"
show guard "$s4"
calls="$(helper tools "$s4")"
check "the guard refused the shell read (Orrery's reason reached the model)" 'grep -q "Orrery guard: This command touches e2e-protected.txt, protected by" <<<"$calls"'
check "the guard refused the write" 'grep -q "e2e-protected.txt is protected by \[guard\] protect" <<<"$calls"'
check "the protected file is unchanged" 'cmp -s "$ws/e2e-protected.txt" "$tmp/protected.orig"'
check "its secret reached neither the reply nor memory" '! answer guard | grep -q "$canary" && ! dump | grep -q "$canary"'

# 6. Compaction, as /compact asks for it, in the session of steps 2 and 3: Orrery answers it from memory, so no request
# goes to a model for it, and the next request carries the memory section again, refreshed.
first_view="$(helper memory "$s2" | head -n 1)"
oc_run compact -s "$s2" "E2E-COMPACT. Without using any tool: what codeword did I ask you to remember in an earlier session? Answer with the codeword only, or NONE."
show compact "$s2"
events="$(helper compaction "$s2")"
while IFS= read -r line; do [ -n "$line" ] && info "compaction: ${line:0:300}"; done <<<"$events"
check "the session was compacted, by Orrery's answer" 'grep -q "^session.compaction.ended" <<<"$events" && ! grep -q "^session.compaction.failed" <<<"$events" && grep -q "kept in Orrery.s memory" <<<"$events"'
check "no compaction request went to a model" '[ "$(helper requests compaction)" = 0 ]'
check "after it, the request carried the memory section, refreshed" 'last="$(helper memory "$s2" | tail -n 1)"; [ "$last" != none ] && [ "$last" != "$first_view" ]'
check "and the session still recalls the codeword" 'answer compact | grep -q "$code"'

# 7. OpenCode's free tier never makes summaries: chosen in the config, it is refused before any request. The message is
# long enough that only a model can summarize it, so its summary waits (for step 8).
write_config "$free_model"
filler="$(for i in $(seq 1 12); do printf 'Made-up background line %s: the test harbour keeps its grey boats in rows by colour. ' "$i"; done)"
oc_run free "Here is made-up background text for this test; do nothing with it. $filler Reply with exactly: FREE"
show free "$sid"
info "status after: $(status_of)"
check "a free OpenCode model ($free_model) is not used for summaries, and says why" 'status_of | grep -q "free tier only works inside OpenCode chats"'
check "no summary request went through OpenCode for it" '[ "$(helper requests generate)" = 0 ]'
check "the session still recorded its turn" 'dump | grep -q "^talk: FREE"'

# 8. Summaries through OpenCode, on a model of your own (ORRERY_E2E_OPENCODE_CONFIG, ORRERY_E2E_SUMMARY_MODEL): what is
# waiting is summarized before the session's first request, each summary in a short-lived session of OpenCode's. A
# second run opens the agent again, which removes a summary session the first one's end cut short.
if [ -n "$summary_model" ]; then
	write_config "$summary_model"
	oc_run summary "Reply with exactly: SUMMARIZED"
	show summary "$sid"
	oc_run summary-again "Reply with exactly: DONE"
	show summary-again "$sid"
	info "status after: $(status_of)"
	info "summary sessions (made, removed, their requests): $(helper summaries)"
	check "summaries were made through OpenCode ($summary_model)" 'read -r made removed kinds <<<"$(helper summaries)"; [ "$made" -gt 0 ] && grep -q generate <<<"$kinds"'
	check "each summary session was removed" 'read -r made removed _ <<<"$(helper summaries)"; [ "$made" = "$removed" ]'
	check "memory holds summaries, recorded with zero token use" summarized
	check "summaries are not failing" '! status_of | grep -q "\"state\""'
else
	skip "summaries through OpenCode: set ORRERY_E2E_OPENCODE_CONFIG (an OpenCode config file with a provider and its key) and ORRERY_E2E_SUMMARY_MODEL (opencode/<provider>/<model>)"
fi

# The run's own traffic, and your OpenCode setup.
while IFS= read -r line; do [ -n "$line" ] && info "request: $line"; done <<<"$(helper kinds)"
check "every request was the agent loop's or a summary's (no title, compaction or other request)" '[ -z "$(helper other)" ]'
check "every OpenCode server of this run has exited" '[ -z "$(servers)" ]'
check "your OpenCode config folder is unchanged" '[ "$(fingerprint)" = "$before" ]'
info "orrery status: $("$orrery_cli" status E2E 2>&1 | head -n 1)"
dump | sed 's/^/INFO  memory: /'
exit "$fail"
