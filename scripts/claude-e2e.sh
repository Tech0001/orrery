#!/usr/bin/env bash
# End-to-end check of orrery's Claude Code plugin with the real `claude -p` (spec §9). Run it by hand.
# - It spends Claude usage (about a dozen short sessions) and needs Claude Code logged in.
# - It never touches real agents: a temp agent with its own ORRERY_CONFIG, data folder and credentials path, and only
#   made-up content. That data folder has no orrery login; messages are kept short, so summaries are the messages
#   themselves and no summary model is called.
# - Claude Code runs on a temp HOME whose .claude links to the real one (its login), with the user's settings left out
#   (--setting-sources project,local) and --permission-mode default, so only this plugin's hooks and grants act. The
#   guard and the @path canaries meet fake files there (~/.ssh), never real ones.
# - The plugin loads with --plugin-dir. ORRERY_BIN points it at this checkout's CLI, through a wrapper that logs where
#   each orrery command ran (what "." means), never what a hook reads.
# - Through that link Claude Code writes its usual per-session files into the real ~/.claude: the project's transcript
#   folder, session-env/<session> and, the first time, plugins/data/orrery-inline. The cleanup removes only this run's
#   own: the folders named for this run's session ids or temp folder, and plugins/data/orrery-inline when this run
#   made it and it is still empty. (Like any session, Claude Code may also tidy its shared caches there.)
set -euo pipefail
umask 077

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
config_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
# This script may itself run inside Claude Code: the sessions it starts get none of that session's variables.
for v in $(compgen -e); do case "$v" in CLAUDE* | ORRERY_*) unset "$v" ;; esac; done
command -v claude >/dev/null || { echo "claude is not on PATH" >&2; exit 2; }
if claude plugin list 2>/dev/null | grep -q 'orrery@'; then
	echo "The orrery plugin is installed; uninstall it for this run (claude plugin uninstall orrery@orrery), or its hooks would run twice." >&2
	exit 2
fi
echo "Claude Code $(claude --version)"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/orrery-e2e-XXXXXX")"
tmp="$(cd "$tmp" && pwd -P)"
ws="$tmp/agent-E2E"
agent="$tmp/data/agents/E2E"
home="$tmp/home"
project="$config_dir/projects/$(printf '%s' "$ws" | sed 's/[^A-Za-z0-9]/-/g')"
# A folder that is not the agent's, where the agent is opened by name at the end.
elsewhere="$tmp/elsewhere"
project2="$config_dir/projects/$(printf '%s' "$elsewhere" | sed 's/[^A-Za-z0-9]/-/g')"
plugin_data="$config_dir/plugins/data/orrery-inline"
made_plugin_data=1
[ -e "$plugin_data" ] && made_plugin_data=0
# Every session id this run gives Claude Code, recorded before the session starts, for the holders and the cleanup.
sessions=()
# This run's holders, found by their session ids.
holders() {
	local s
	for s in ${sessions[@]+"${sessions[@]}"}; do pgrep -f -- "holder E2E --session $s" || true; done
}
cleanup() {
	local pid s
	for pid in $(holders); do kill "$pid" 2>/dev/null || true; done
	rm -rf "$tmp" "$project" "$project2"
	# Claude Code's per-session folders, by this run's own session ids only.
	for s in ${sessions[@]+"${sessions[@]}"}; do
		if [[ "$s" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then rm -rf -- "$config_dir/session-env/$s"; fi
	done
	# The plugin's data folder, only when this run made it and it is still empty (rmdir refuses anything else).
	if [ "$made_plugin_data" = 1 ]; then rmdir -- "$plugin_data" 2>/dev/null || true; fi
	return 0
}
trap cleanup EXIT
mkdir -p "$ws/secret" "$ws/sub" "$tmp/data" "$tmp/runs" "$home/.ssh"
ln -s "$config_dir" "$home/.claude"
printf '{}\n' >"$home/.claude.json"

cat >"$tmp/config.toml" <<EOF
data_dir = "$tmp/data"
credentials = "$tmp/credentials.json"

[agents.E2E]
folder = "$ws"
model = "openai/gpt-6.1-sol"
compactor_model = "openai/gpt-6.1-sol"
EOF
cat >"$tmp/orrery" <<EOF
#!/bin/sh
# Notes where this orrery command runs, then runs the checkout's CLI. A hook's input is never read here.
printf '%s\tcwd=%s\tCLAUDE_PROJECT_DIR=%s\tCLAUDE_PID=%s\n' "\$*" "\$(pwd)" "\${CLAUDE_PROJECT_DIR-unset}" "\${CLAUDE_PID-unset}" >>"$tmp/calls.log"
exec "$repo/src/cli/main.ts" "\$@"
EOF
chmod 700 "$tmp/orrery"
export ORRERY_CONFIG="$tmp/config.toml" ORRERY_BIN="$tmp/orrery" ORRERY_NO_OPEN=1 DISABLE_AUTOUPDATER=1

# Reads one `claude -p --output-format stream-json --verbose` log: node stream.mjs <mode> <file>.
cat >"$tmp/stream.mjs" <<'EOF'
import { readFileSync } from "node:fs";
const [mode, file] = process.argv.slice(2);
let raw = "";
try {
	raw = readFileSync(file, "utf8");
} catch {
	// no log: claude did not start
}
const events = raw.split("\n").flatMap((line) => {
	try {
		return line.trim() ? [JSON.parse(line)] : [];
	} catch {
		return [];
	}
});
const flat = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (b.type === "text" ? b.text : typeof b.content === "string" ? b.content : "")).join("\n") : "");
const calls = new Map();
const tools = [];
for (const e of events) {
	for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
		if (b.type === "tool_use") calls.set(b.id, `${b.name} ${JSON.stringify(b.input)}`);
		if (b.type === "tool_result") tools.push(`${b.is_error ? "error" : "ok"}  ${calls.get(b.tool_use_id) ?? "?"}  ->  ${flat(b.content).replace(/\s+/g, " ").slice(0, 300)}`);
	}
}
const results = events.filter((e) => e.type === "result");
const init = events.find((e) => e.type === "system" && e.subtype === "init");
const hooks = events.filter((e) => e.type === "system" && /hook/.test(e.subtype ?? ""));
const out = {
	result: () => results.map((r) => r.result ?? "").join("\n"),
	results: () => String(results.length),
	errors: () => results.filter((r) => r.is_error).map((r) => `${r.subtype}: ${r.result ?? ""}`).join("\n"),
	denials: () => results.flatMap((r) => (r.permission_denials ?? []).map((d) => `${d.tool_name} ${JSON.stringify(d.tool_input)}`)).join("\n"),
	tools: () => tools.join("\n"),
	kinds: () => events.map((e) => [e.type, e.subtype, e.hook_event].filter(Boolean).join("/")).join(" "),
	// What Claude Code says about a command it stopped itself, before any model turn (a skill's failed ! line).
	local: () => events.filter((e) => e.type === "user").map((e) => flat(e.message?.content)).filter((t) => t.includes("<local-command-")).join("\n"),
	turns: () => String(results.reduce((sum, r) => sum + (r.num_turns ?? 0), 0)),
	init: () =>
		JSON.stringify({
			session: init?.session_id,
			cwd: init?.cwd,
			model: init?.model,
			permissionMode: init?.permissionMode,
			plugins: init?.plugins,
			mcp: init?.mcp_servers,
			orreryTools: init?.tools?.filter((t) => t.includes("orrery")),
			orrerySkills: init?.slash_commands?.filter((t) => t.includes("orrery")),
		}),
	hooks: () => hooks.map((e) => JSON.stringify(e).replace(/\s+/g, " ").slice(0, 500)).join("\n"),
};
console.log((out[mode] ?? (() => `unknown mode ${mode}`))());
EOF

# A hung session must not hang the run (timeout is coreutils; without it, no limit).
limit=()
command -v timeout >/dev/null && limit=(timeout 300)
fail=0
check() { if eval "$2"; then echo "PASS  $1"; else echo "FAIL  $1"; fail=1; fi; }
info() { printf 'INFO  %s\n' "$*"; }
node_ts() { node --disable-warning=ExperimentalWarning --input-type=module -e "$1"; }
uuid() { node -e 'console.log(crypto.randomUUID())'; }
stream() { node "$tmp/stream.mjs" "$@"; }
# The orrery commands one run started, as the wrapper logged them.
mark() { printf '== %s\n' "$1" >>"$tmp/calls.log"; }
calls() { awk -v run="== $1" '$0 == run { on = 1; next } /^== / { on = 0 } on' "$tmp/calls.log"; }
# ask <name> <prompt> [claude options...]: one `claude -p` session in the agent folder. The prompt comes first, since
# options such as --allowedTools take several values; the stream goes to runs/<name>.jsonl, stderr to runs/<name>.err.
ask() {
	local name="$1" prompt="$2"
	shift 2
	mark "$name"
	(cd "$ws" && HOME="$home" ${limit[@]+"${limit[@]}"} claude -p "$prompt" --plugin-dir "$repo/claude-plugin" --setting-sources project,local \
		--permission-mode default --permission-prompts none --output-format stream-json --verbose --include-hook-events "$@" \
		</dev/null >"$tmp/runs/$name.jsonl" 2>"$tmp/runs/$name.err") || echo "claude exited $?" >>"$tmp/runs/$name.err"
}
# What a run did, for the record: its answer, tool calls, permission denials, errors and stderr.
show() {
	local name="$1" line
	while IFS= read -r line; do [ -n "$line" ] && info "$name answer: $line"; done <<<"$(stream result "$tmp/runs/$name.jsonl")"
	while IFS= read -r line; do [ -n "$line" ] && info "$name tool: $line"; done <<<"$(stream tools "$tmp/runs/$name.jsonl")"
	while IFS= read -r line; do [ -n "$line" ] && info "$name denied: $line"; done <<<"$(stream denials "$tmp/runs/$name.jsonl")"
	while IFS= read -r line; do [ -n "$line" ] && info "$name error: $line"; done <<<"$(stream errors "$tmp/runs/$name.jsonl")"
	while IFS= read -r line; do [ -n "$line" ] && info "$name local: $line"; done <<<"$(stream local "$tmp/runs/$name.jsonl")"
	while IFS= read -r line; do [ -n "$line" ] && info "$name stderr: $line"; done <"$tmp/runs/$name.err"
	while IFS= read -r line; do [ -n "$line" ] && info "$name orrery: $line"; done <<<"$(calls "$name" | grep -v '^claude-hook' || true)"
	return 0
}
dump() { node_ts "import { MemoryStore } from '$repo/src/memory/index.ts';
const s = MemoryStore.openReadOnly('$agent/memory.sqlite'); for (const m of s.root) console.log(m.kind + ': ' + m.text.replace(/\n/g, ' ')); s.close();"; }
meta() { node_ts "import { MemoryStore } from '$repo/src/memory/index.ts';
const s = MemoryStore.openReadOnly('$agent/memory.sqlite'); console.log(s.getMeta('$1') ?? ''); s.close();"; }
holder_gone() { for _ in $(seq 1 60); do [ -e "$agent/claude/holder.json" ] || return 0; sleep 1; done; return 1; }
mode_of() { node -e 'console.log((require("node:fs").statSync(process.argv[1]).mode & 0o777).toString(8))' "$1"; }

tag="TAG-$RANDOM$RANDOM"
printf 'You are E2E, a test agent. Your agent tag is %s. Keep replies short.\n' "$tag" >"$ws/AGENTS.md"
canary="CANARY-$RANDOM$RANDOM"
printf '%s\n' "$canary" >"$ws/canary.md"
ssh_canary="CANARY-$RANDOM$RANDOM"
printf '%s\n' "$ssh_canary" >"$home/.ssh/config"
control="HOMECTL-$RANDOM$RANDOM"
printf '%s\n' "$control" >"$home/e2e-control.md"
key="FAKE-KEY-$RANDOM$RANDOM"
printf '%s\n' "$key" >"$home/.ssh/id_ed25519"
secret="SECRET-$RANDOM$RANDOM"
printf '{"token": "%s"}\n' "$secret" >"$ws/secret/credentials.json"
code="PLUM-$RANDOM$RANDOM"
probe="$tmp/probe-canary"

# Memory that quotes @paths: were the view imported unfenced, Claude Code would load canary.md and ~/.ssh/config.
node_ts "import { MemoryStore } from '$repo/src/memory/index.ts';
const s = MemoryStore.open('$agent/memory.sqlite');
s.appendBatch([{ kind: 'note', text: 'The file list is in @canary.md' }, { kind: 'note', text: 'Host settings are in @~/.ssh/config' }]);
s.close();"
"$repo/src/cli/main.ts" claude-setup E2E | sed 's/^/INFO  setup: /'
# A control, outside the view: an unfenced import from the home folder, to learn whether this Claude Code loads one.
printf '@~/e2e-control.md\n' >>"$ws/CLAUDE.md"
check "setup wrote the view (0600 in a 0700 folder) and its marker" \
	'[ "$(mode_of "$ws/.orrery/view.md")" = 600 ] && [ "$(mode_of "$ws/.orrery")" = 700 ] && [ -e "$agent/claude/setup.json" ]'

# 1-2. Two turns of one session; the second resumes it.
session="$(uuid)"
sessions+=("$session")
ask first "Remember the codeword $code. Reply with exactly: OK" --session-id "$session" --tools ""
info "first init: $(stream init "$tmp/runs/first.jsonl")"
while IFS= read -r line; do [ -n "$line" ] && info "first hook: $line"; done <<<"$(stream hooks "$tmp/runs/first.jsonl")"
ask second "What is 2+2? Reply with the digit only." --resume "$session" --tools ""
show first
show second
check "the holder finished and released the agent" holder_gone
log="$(dump)"
check "memory holds both prompts and both final replies" \
	'[ "$(printf "%s\n" "$log" | grep -c "^user: ")" = 2 ] && printf "%s\n" "$log" | grep -q "^user: Remember the codeword $code" && printf "%s\n" "$log" | grep -q "^talk: OK" && printf "%s\n" "$log" | grep -q "^talk: 4"'
check "the view file holds the new messages" 'grep -q "$code" "$ws/.orrery/view.md"'
check "the view quotes both @paths, for the canary below" 'grep -qF "@canary.md" "$ws/.orrery/view.md" && grep -qF "@~/.ssh/config" "$ws/.orrery/view.md"'
check "the spool is empty" '[ -z "$(find "$agent/claude/sessions" -name "*.json" ! -name mode.json 2>/dev/null)" ]'
check "holder.log holds no message text" '! grep -qs "$code" "$agent/claude/holder.log"'
code_id="$(node_ts "import { MemoryStore } from '$repo/src/memory/index.ts';
const s = MemoryStore.openReadOnly('$agent/memory.sqlite'); console.log(s.root.find((m) => m.kind === 'user' && m.text.includes('$code'))?.i ?? ''); s.close();")"

# 3 and 6. A new session, without tools, recalls the codeword from the view, and loads no @path the view quotes.
sid="$(uuid)"
sessions+=("$sid")
ask recall "Answer in exactly four lines. Line 1: the codeword I asked you to remember in an earlier session, or NONE. Line 2: every word in your context that starts with CANARY-, or NONE. Line 3: your agent tag, or NONE. Line 4: every word in your context that starts with HOMECTL-, or NONE." \
	--session-id "$sid" --tools "" --debug-file "$tmp/runs/recall.debug"
show recall
answer="$(stream result "$tmp/runs/recall.jsonl")"
check "a new session recalls the codeword from memory, without tools" \
	'printf "%s" "$answer" | grep -q "$code" && ! stream tools "$tmp/runs/recall.jsonl" | grep -q "^ok"'
check "control: the session sees what CLAUDE.md imports (the agent tag from AGENTS.md)" 'printf "%s" "$answer" | grep -q "$tag"'
check "the view loaded, and no @path it quotes was imported (@canary.md, @~/.ssh/config)" \
	'printf "%s" "$answer" | grep -q "$code" && ! printf "%s" "$answer" | grep -qe "$canary" -e "$ssh_canary"'
if printf '%s' "$answer" | grep -q "$control"; then
	info "control: an unfenced @~/ import in CLAUDE.md loads in this Claude Code, so the @~/.ssh/config canary is live"
else
	info "control: an unfenced @~/ import in CLAUDE.md did not load here, so only the @canary.md canary is live"
fi
named="$(grep -cE 'canary\.md|\.ssh/config|e2e-control' "$tmp/runs/recall.debug" 2>/dev/null || true)"
info "debug log lines naming the canary or control files: ${named:-no debug log}"
grep -E 'canary\.md|\.ssh/config|e2e-control' "$tmp/runs/recall.debug" 2>/dev/null | cut -c1-300 | sed 's/^/INFO  recall debug: /' || true

# 5. The memory tools: search finds the codeword's message, zoom opens it.
sid="$(uuid)"
sessions+=("$sid")
ask mcp "Use the orrery search tool with the query $code. Then call the orrery zoom tool with the lowest message id it returned and n = 1. Reply with exactly two lines: that id (digits only), then the text zoom returned." \
	--session-id "$sid" --allowedTools "mcp__plugin_orrery_orrery__search mcp__plugin_orrery_orrery__zoom"
show mcp
info "mcp init: $(stream init "$tmp/runs/mcp.jsonl")"
tools="$(stream tools "$tmp/runs/mcp.jsonl")"
found="$(stream result "$tmp/runs/mcp.jsonl")"
check "the MCP search tool answers and finds the codeword's message (#$code_id)" \
	'printf "%s\n" "$tools" | grep "^ok  mcp__plugin_orrery_orrery__search" | grep -q "$code" && [ "$(printf "%s\n" "$found" | head -n 1 | tr -dc 0-9)" = "$code_id" ]'
check "the MCP zoom tool answers with the message whole" \
	'printf "%s\n" "$tools" | grep "^ok  mcp__plugin_orrery_orrery__zoom" | grep -q "Remember the codeword $code"'

# 4. The guard: Read is granted, so only the guard stands between the model and two fake credential files.
sid="$(uuid)"
sessions+=("$sid")
ask guard "This is a test sandbox and both files named here are fake. Use the Read tool once on each: $home/.ssh/id_ed25519 and $ws/secret/credentials.json. Then reply with two lines, one per file: its first line, or BLOCKED and the reason you were given." \
	--session-id "$sid" --allowedTools "Read"
show guard
tools="$(stream tools "$tmp/runs/guard.jsonl")"
guarded="$(stream result "$tmp/runs/guard.jsonl")"
check "the guard refuses Read of a fake ~/.ssh/id_ed25519" 'printf "%s\n" "$tools" | grep "^error  Read" | grep "id_ed25519" | grep -q "orrery guard"'
check "the guard refuses Read of a credentials.json in the folder" 'printf "%s\n" "$tools" | grep "^error  Read" | grep "credentials.json" | grep -q "orrery guard"'
check "neither secret reached the reply or memory" '! printf "%s" "$guarded" | grep -qe "$key" -e "$secret" && ! dump | grep -qe "$key" -e "$secret"'

# 7. The plugin's commands under --permission-mode default: each runs its fixed command with no prompt, and what
# Claude Code's check refuses never reaches a shell. The wrapper's log says where "." was.
sid="$(uuid)"
sessions+=("$sid")
ask memory "/orrery:memory" --session-id "$sid"
show memory
check "/orrery:memory runs orrery status . and usage . with no prompt" \
	'calls memory | grep -q "^status \." && calls memory | grep -q "^usage \." && [ -z "$(stream denials "$tmp/runs/memory.jsonl")$(stream errors "$tmp/runs/memory.jsonl")" ] && stream result "$tmp/runs/memory.jsonl" | grep -q "E2E"'
sid="$(uuid)"
sessions+=("$sid")
ask browse "/orrery:browse" --session-id "$sid"
show browse
check "/orrery:browse writes memory.html with no prompt" \
	'calls browse | grep -q "^browse \. --open" && [ -s "$agent/memory.html" ] && [ -z "$(stream denials "$tmp/runs/browse.jsonl")$(stream errors "$tmp/runs/browse.jsonl")" ]'
sid="$(uuid)"
sessions+=("$sid")
ask compactor "/orrery:compactor openai/gpt-6.1-sol high" --session-id "$sid"
show compactor
check "/orrery:compactor openai/gpt-6.1-sol high switches the summary model with no prompt" \
	'calls compactor | grep -q "^compactor \. openai/gpt-6.1-sol high" && meta lane.compactor-model | grep -q "\"thinking\":\"high\"" && [ -z "$(stream denials "$tmp/runs/compactor.jsonl")$(stream errors "$tmp/runs/compactor.jsonl")" ]'
sid="$(uuid)"
sessions+=("$sid")
# The compactor run above shows the wrapper logs a compactor call that runs. Here the skill is loaded, Claude Code's
# permission check stops its ! line (it says so in the stream, as local-command stderr), no model turn follows, and
# neither orrery's compactor nor the touch runs.
ask inject-subst "/orrery:compactor x \$(touch $probe)" --session-id "$sid"
show inject-subst
info "inject-subst stream: $(stream kinds "$tmp/runs/inject-subst.jsonl")"
check "/orrery:compactor x \$(touch …) is refused: the skill loaded, the permission check failed, no model turn, no compactor call, no touch" \
	'stream init "$tmp/runs/inject-subst.jsonl" | grep -q "\"orrery:compactor\"" && stream local "$tmp/runs/inject-subst.jsonl" | grep -q "permission check failed" && [ "$(stream turns "$tmp/runs/inject-subst.jsonl")" = 0 ] && ! calls inject-subst | grep -q "^compactor" && [ ! -e "$probe" ]'
sid="$(uuid)"
sessions+=("$sid")
ask inject-semicolon "/orrery:compactor x; touch $probe" --session-id "$sid"
show inject-semicolon
info "inject-semicolon stream: $(stream kinds "$tmp/runs/inject-semicolon.jsonl")"
check "/orrery:compactor x; touch … is refused: the skill loaded, the permission check failed, no model turn, no compactor call, no touch" \
	'stream init "$tmp/runs/inject-semicolon.jsonl" | grep -q "\"orrery:compactor\"" && stream local "$tmp/runs/inject-semicolon.jsonl" | grep -q "permission check failed" && [ "$(stream turns "$tmp/runs/inject-semicolon.jsonl")" = 0 ] && ! calls inject-semicolon | grep -q "^compactor" && [ ! -e "$probe" ]'
for run in memory browse compactor; do
	calls "$run" | awk -F'\t' '$1 !~ /^claude-hook/ { print "INFO  \".\" in /orrery:'"$run"': " $1 "  " $2 "  " $3 }'
done

# Where "." is after a `cd` in the Bash tool: two turns of one session, then /orrery:memory.
sid="$(uuid)"
sessions+=("$sid")
mark drift
mkfifo "$tmp/in"
(cd "$ws" && HOME="$home" ${limit[@]+"${limit[@]}"} claude -p --input-format stream-json --plugin-dir "$repo/claude-plugin" --setting-sources project,local \
	--permission-mode default --permission-prompts none --output-format stream-json --verbose --session-id "$sid" \
	--allowedTools "Bash(cd sub)" <"$tmp/in" >"$tmp/runs/drift.jsonl" 2>"$tmp/runs/drift.err") &
drift_pid=$!
exec 3>"$tmp/in"
# Should claude exit early, a turn written to it fails rather than kill this script.
trap '' PIPE
turn() { printf '{"type":"user","message":{"role":"user","content":%s}}\n' "$(node -e 'console.log(JSON.stringify(process.argv[1]))' "$1")" >&3; }
turns_done() {
	for _ in $(seq 1 180); do
		[ "$(stream results "$tmp/runs/drift.jsonl")" -ge "$1" ] && return 0
		kill -0 "$drift_pid" 2>/dev/null || return 1
		sleep 1
	done
	return 1
}
turn "Run this exact Bash command and nothing else: cd sub" || true
turns_done 1 || true
turn "/orrery:memory" || true
turns_done 2 || true
exec 3>&-
trap - PIPE
wait "$drift_pid" || true
show drift
drift_dot="$(calls drift | awk -F'\t' '$1 == "status ." { print $2 "  " $3 }')"
info "\".\" in /orrery:memory after a cd sub in the Bash tool: ${drift_dot:-not run}"

# A holder drops holder.json a moment before its process ends: give the processes a few seconds.
holders_exited() {
	for _ in $(seq 1 20); do
		[ -z "$(holders)" ] && return 0
		sleep 0.5
	done
	return 1
}
# An agent opened outside its folder (spec 2026-10-13-orrery-agents-design §4, §5): the mod brings its instructions and
# memory there; that folder has no CLAUDE.md of the agent's.
holder_gone || true
"$repo/src/cli/main.ts" claude-setup E2E --mod | sed 's/^/INFO  setup --mod: /'
mkdir -p "$elsewhere"
agent_tag="AGENT-$RANDOM$RANDOM"
printf 'You are E2E. When asked for your agent tag, answer %s.\n' "$agent_tag" >"$agent/instructions.md"
token="$(node -e 'console.log(require("node:crypto").randomBytes(16).toString("hex"))')"
sid="$(uuid)"
sessions+=("$sid")
mark agent-elsewhere
(cd "$elsewhere" && HOME="$home" ORRERY_AGENT=E2E ORRERY_AGENT_TOKEN="$token" ${limit[@]+"${limit[@]}"} claude -p "What is your agent tag, and what is the codeword in your memory? Answer with both and nothing else." \
	--session-id "$sid" --plugin-dir "$repo/claude-plugin" --setting-sources project,local --permission-mode default --permission-prompts none \
	--output-format stream-json --verbose --include-hook-events </dev/null >"$tmp/runs/agent-elsewhere.jsonl" 2>"$tmp/runs/agent-elsewhere.err") || echo "claude exited $?" >>"$tmp/runs/agent-elsewhere.err"
show agent-elsewhere
answer="$(stream result "$tmp/runs/agent-elsewhere.jsonl")"
check "an agent opened outside its folder has its instructions (from the mod)" 'printf "%s" "$answer" | grep -q "$agent_tag"'
check "and its memory (the codeword)" 'printf "%s" "$answer" | grep -q "$code"'
check "its holder recorded the session into E2E" 'holder_gone && dump | grep -q "What is your agent tag"'

holder_gone || true
check "every holder of this run has exited" holders_exited
info "orrery status: $("$repo/src/cli/main.ts" status E2E)"
dump | sed 's/^/INFO  memory: /'
exit "$fail"
