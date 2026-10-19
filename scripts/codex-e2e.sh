#!/usr/bin/env bash
# End-to-end check of Orrery in the real Codex, on the real model (docs/codex.md). Run it by hand.
# - Run it from your own terminal, not from an agent's shell: it needs your real HOME (Codex's login), and inside an
#   agent's session Orrery refuses `orrery agent` (a scratch ORRERY_HOME doesn't hide the session your default home holds).
# - It spends Codex usage (about nine short sessions on your default model, at low reasoning effort) and needs Codex
#   logged in. ORRERY_E2E_MODEL picks another model (passed as -m); ORRERY_E2E_CODEX_ARGS adds arguments to every
#   `codex exec` (split at spaces), such as `-p <profile>`, or a local fake model's -c flags for a dry run of the script.
# - It never touches real agents: a temp agent in a temp Orrery home, with its own ORRERY_CONFIG, data folder and
#   credentials path, and only made-up content. That home has no Orrery login, so no summary model is called.
# - It opens the agent the way a person does, `orrery agent E2E --tool codex -- exec …` (the hook check, the shell check,
#   every -c flag), from this checkout's CLI, or the program ORRERY_E2E_BIN names (a built release's bin/orrery).
# - Codex runs with your own login and config ($CODEX_HOME, default ~/.codex), as an agent session does, in its normal
#   sandbox (workspace-write, never the bypass). Nothing is written to Codex's config: the run checks that config.toml and
#   hooks.json are byte for byte the same after it. Codex keeps its usual session files (rollouts under sessions/, its
#   state databases and logs); the run prints each session's rollout and the command that deletes it.
# - Your Codex config, hooks and AGENTS.md apply to these sessions too, as they do to any agent session.
# - Inside an agent session the model's shell runs this run's orrery (by its path), and the run checks what an agent's
#   shell may not run: orrery remote key and agent set --reads all (the guard refuses them), a browse of an agent it may
#   not read and browse --out (the CLI refuses them; in Codex's sandbox, where Orrery can't tell whose session the shell
#   is, it refuses all but help and the version). The config has a second agent, Other, for that.
set -euo pipefail
umask 077

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
orrery_cli="${ORRERY_E2E_BIN:-$repo/src/cli/main.ts}"
codex_home="${CODEX_HOME:-$HOME/.codex}"
# This script may itself run inside an agent's session: the sessions it starts get none of that session's variables.
for v in $(compgen -e); do case "$v" in ORRERY_AGENT* | ORRERY_CONFIG | ORRERY_HOME | CODEX_THREAD_ID | CODEX_SESSION_ID) unset "$v" ;; esac; done
command -v codex >/dev/null || { echo "codex is not on PATH" >&2; exit 2; }
command -v node >/dev/null || { echo "node is not on PATH" >&2; exit 2; }
echo "$(codex --version 2>/dev/null | tail -n 1), Orrery from $orrery_cli"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/orrery-codex-e2e-XXXXXX")"
tmp="$(cd "$tmp" && pwd -P)"
ws="$tmp/agent-E2E"
agent="$tmp/data/agents/E2E"
# Every Codex session id this run made, for the rollouts listed at the end.
sessions=()
# This run's recorders, found by their session ids.
recorders() {
	local s
	for s in ${sessions[@]+"${sessions[@]}"}; do pgrep -f -- "holder E2E --session $s" || true; done
}
cleanup() {
	local pid s seen=" "
	for pid in $(recorders); do kill "$pid" 2>/dev/null || true; done
	rm -rf "$tmp"
	# Codex keeps its sessions: say where each went and how to delete it, even when the run stopped early.
	for s in ${sessions[@]+"${sessions[@]}"}; do
		case "$seen" in *" $s "*) continue ;; esac
		seen="$seen$s "
		printf 'INFO  Codex session %s: %s; delete it with: codex delete %s\n' "$s" "$(find "$codex_home/sessions" -type f -name "rollout-*-$s.jsonl*" 2>/dev/null | head -n 1)" "$s"
	done
	return 0
}
trap cleanup EXIT
mkdir -p "$ws" "$tmp/data" "$tmp/runs"

cat >"$tmp/config.toml" <<EOF
data_dir = "$tmp/data"
credentials = "$tmp/credentials.json"

[updates]
check = false

[guard]
protect = ["e2e-protected.txt"]

[agents.E2E]
folder = "$ws"
tool = "codex"
compactor_model = "openai/gpt-6.1-sol"

# An agent E2E may not read (it reads nobody): its shell's orrery browse Other is refused.
[agents.Other]
tool = "codex"
compactor_model = "openai/gpt-6.1-sol"
EOF
export ORRERY_CONFIG="$tmp/config.toml" ORRERY_HOME="$tmp/orrery-home" ORRERY_NO_OPEN=1
# What a session's shell runs as orrery: this run's, by a path whose last name is orrery (as the guard knows Orrery's
# program), whatever the shell's PATH.
mkdir -p "$tmp/bin"
cat >"$tmp/bin/orrery" <<EOF
#!/bin/sh
exec "$orrery_cli" "\$@"
EOF
chmod 700 "$tmp/bin/orrery"

# Reads one Codex rollout (JSON lines): node rollout.mjs <mode> <file>. Each mode looks for its objects at any depth, so
# it reads the paginated history and the older layout alike.
cat >"$tmp/rollout.mjs" <<'EOF'
import { readFileSync } from "node:fs";
const [mode, file] = process.argv.slice(2);
let raw = "";
try {
	raw = readFileSync(file, "utf8");
} catch {
	// no rollout
}
const lines = raw.split("\n").flatMap((line) => {
	try {
		return line.trim() ? [JSON.parse(line)] : [];
	} catch {
		return [];
	}
});
const text = (content) => (Array.isArray(content) ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("") : typeof content === "string" ? content : "");
/** Calls visit on every object in value; does not go into one that skip names. */
function walk(value, visit, skip = () => false) {
	if (Array.isArray(value)) {
		for (const item of value) walk(item, visit, skip);
		return;
	}
	if (value === null || typeof value !== "object") return;
	visit(value);
	if (skip(value)) return;
	for (const item of Object.values(value)) walk(item, visit, skip);
}
/** How many lines hold an object that `match` accepts (outside a compaction's kept history). */
const linesWith = (match) => lines.filter((line) => {
	let found = false;
	walk(line, (o) => { if (match(o)) found = true; }, (o) => o.type === "compacted");
	return found;
}).length;
const out = {
	// Orrery's SessionStart context: a developer message that starts with the agent's status line.
	views: () => String(linesWith((o) => o.role === "developer" && text(o.content).startsWith("Orrery · E2E · "))),
	compactions: () => String(lines.filter((line) => { let found = false; walk(line, (o) => { if (o.type === "compacted" || o.type === "context_compacted") found = true; }); return found; }).length),
	// Every tool call: its kind, namespace or server, name, and the start of its arguments (a code cell's code).
	calls: () => {
		const seen = new Set();
		for (const line of lines) {
			walk(line, (o) => {
				if (typeof o.type !== "string" || !/_call$/.test(o.type)) return;
				const args = typeof o.arguments === "string" ? o.arguments : typeof o.input === "string" ? o.input : JSON.stringify(o.arguments ?? o.input ?? "");
				seen.add([o.type, o.namespace ?? o.server ?? "", o.name ?? o.tool ?? "", args.replace(/\s+/g, " ").slice(0, 300)].join(" "));
			});
		}
		return [...seen].join("\n");
	},
	// The largest input a request of this session sent, in tokens (Codex's own counts).
	tokens: () => {
		let max = 0;
		for (const line of lines) walk(line, (o) => { const n = o.last_token_usage?.input_tokens; if (typeof n === "number" && n > max) max = n; });
		return String(max);
	},
};
console.log((out[mode] ?? (() => `unknown mode ${mode}`))());
EOF

# A hung session must not hang the run (timeout is coreutils; without it, no limit).
limit=()
command -v timeout >/dev/null && limit=(timeout 600)
fail=0
check() { if eval "$2"; then echo "PASS  $1"; else echo "FAIL  $1"; fail=1; fi; }
skip() { echo "SKIP  $*"; }
info() { printf 'INFO  %s\n' "$*"; }
node_ts() { node --disable-warning=ExperimentalWarning --input-type=module -e "$1"; }
rollout_of() { find "$codex_home/sessions" -type f -name "rollout-*-$1.jsonl*" 2>/dev/null | head -n 1; }
rollout() { node "$tmp/rollout.mjs" "$1" "$(rollout_of "$2")"; }
model=()
[ -n "${ORRERY_E2E_MODEL:-}" ] && model=(-m "$ORRERY_E2E_MODEL")
extra=()
[ -n "${ORRERY_E2E_CODEX_ARGS:-}" ] && read -r -a extra <<<"$ORRERY_E2E_CODEX_ARGS"
# codex_run <name> <exec arguments…>: one `orrery agent E2E --tool codex -- exec …` in the agent's folder. Codex's last
# message goes to runs/<name>.last, its output to runs/<name>.out and runs/<name>.err; the session's id to $sid.
sid=""
codex_run() {
	local name="$1"
	shift
	(cd "$ws" && ${limit[@]+"${limit[@]}"} "$orrery_cli" agent E2E --tool codex -- exec --skip-git-repo-check -s workspace-write \
		-c 'model_reasoning_effort="low"' -c 'history.persistence="none"' ${model[@]+"${model[@]}"} ${extra[@]+"${extra[@]}"} -o "$tmp/runs/$name.last" "$@" \
		</dev/null >"$tmp/runs/$name.out" 2>"$tmp/runs/$name.err") || echo "orrery agent exited $?" >>"$tmp/runs/$name.err"
	sid="$(grep -oE 'session id: [0-9a-f-]{36}' "$tmp/runs/$name.err" | head -n 1 | cut -d' ' -f3 || true)"
	if [ -n "$sid" ]; then sessions+=("$sid"); fi
	return 0
}
answer() { cat "$tmp/runs/$1.last" 2>/dev/null || true; }
# What a run did, for the record: Orrery's lines, Codex's answer, the tool calls in its rollout, and errors.
show() {
	local name="$1" sid="${2:-}" line
	while IFS= read -r line; do [ -n "$line" ] && info "$name orrery: $line"; done <"$tmp/runs/$name.out"
	while IFS= read -r line; do [ -n "$line" ] && info "$name answer: $line"; done <<<"$(answer "$name")"
	[ -n "$sid" ] && while IFS= read -r line; do [ -n "$line" ] && info "$name call: $line"; done <<<"$(rollout calls "$sid")"
	grep -iE 'error|orrery agent exited|refus|not opened' "$tmp/runs/$name.err" | cut -c1-300 | sed "s/^/INFO  $name stderr: /" || true
	return 0
}
dump() { node_ts "import { MemoryStore } from '$repo/src/memory/index.ts';
const s = MemoryStore.openReadOnly('$agent/memory.sqlite'); for (const m of s.root) console.log(m.kind + ': ' + m.text.replace(/\n/g, ' ')); s.close();"; }
recorder_gone() { for _ in $(seq 1 60); do [ -e "$agent/claude/holder.json" ] || return 0; sleep 1; done; return 1; }
# Codex's config files as they are now: each one's sha256, or "none".
fingerprint() { node -e 'const { createHash } = require("node:crypto"); const fs = require("node:fs");
for (const f of process.argv.slice(1)) { let h = "none"; try { h = createHash("sha256").update(fs.readFileSync(f)).digest("hex"); } catch {} console.log(f + " " + h); }' \
	"$codex_home/config.toml" "$codex_home/hooks.json"; }

before="$(fingerprint)"
code="PLUM-$RANDOM$RANDOM"
canary="CANARY-$RANDOM$RANDOM"
printf 'fake secret %s\n' "$canary" >"$ws/e2e-protected.txt"
cp "$ws/e2e-protected.txt" "$tmp/protected.orig"

# 1. A first session records its turn; the hook check ran first (this Codex was new to this Orrery home).
codex_run first "Remember the codeword $code. Reply with exactly: OK"
s1="$sid"
show first "$s1"
check "orrery agent opened Codex as E2E after checking its hooks load" '[ -n "$s1" ] && grep -q "Checking that Orrery.s hooks load in Codex" "$tmp/runs/first.out" && grep -q "\"ok\": true" "$ORRERY_HOME/codex-check.json"'
check "the recorder finished and released the agent" recorder_gone
log="$(dump)"
check "memory holds the prompt and the final reply" 'printf "%s\n" "$log" | grep -q "^user: Remember the codeword $code" && printf "%s\n" "$log" | grep -q "^talk: OK"'
check "the session got Orrery's context once, at its start" '[ "$(rollout views "$s1")" = 1 ]'
check "the spool is empty" '[ -z "$(find "$agent/claude/sessions" -name "*.json" ! -name mode.json 2>/dev/null)" ]'
check "holder.log holds no message text" '! grep -qs "$code" "$agent/claude/holder.log"'
code_id="$(node_ts "import { MemoryStore } from '$repo/src/memory/index.ts';
const s = MemoryStore.openReadOnly('$agent/memory.sqlite'); console.log(s.root.find((m) => m.kind === 'user' && m.text.includes('$code'))?.i ?? ''); s.close();")"

# 2. A new session recalls the codeword from the view, without tools.
codex_run recall "Without using any tool: what codeword did I ask you to remember in an earlier session? Answer with the codeword only, or NONE."
s2="$sid"
show recall "$s2"
recorder_gone || true
check "a new session recalls the codeword from Orrery's view" 'answer recall | grep -q "$code"'
check "and was recorded too" 'dump | grep -q "^user: Without using any tool: what codeword"'

# 3. Resume: recorded, with no second view (the resumed history holds the one it had).
views_before="$(rollout views "$s2")"
codex_run resume resume "$s2" "Reply with exactly: AGAIN"
show resume "$s2"
recorder_gone || true
check "a resumed session records its turn" 'dump | grep -q "^user: Reply with exactly: AGAIN" && dump | grep -q "^talk: AGAIN"'
check "a resumed session gets no second view ($views_before before)" '[ "$(rollout views "$s2")" = "$views_before" ]'

# 4. The memory tools: search finds the codeword's message, zoom opens it.
codex_run mcp "Use your orrery search tool (from the orrery MCP server; look for it if you don't see it) with the query $code. Then call the orrery zoom tool with the lowest message id it returned and n = 1. Reply with exactly two lines: that id (digits only), then the text zoom returned."
s3="$sid"
show mcp "$s3"
recorder_gone || true
calls="$(rollout calls "$s3")"
check "the model called the orrery search and zoom tools" 'printf "%s\n" "$calls" | grep -qiE "orrery.*search|search.*orrery" && printf "%s\n" "$calls" | grep -qiE "orrery.*zoom|zoom.*orrery"'
check "zoom gave the codeword's message (#$code_id) whole" '[ "$(answer mcp | head -n 1 | tr -dc 0-9)" = "$code_id" ] && answer mcp | grep -q "Remember the codeword $code"'

# 5. The guard: a shell read and a patch of a protected file are refused; the file and its secret stay put.
codex_run guard "This is a test sandbox and the file named here is fake. First run the shell command: cat e2e-protected.txt. Then use apply_patch once to add a line that says edited at the end of e2e-protected.txt. Reply with two lines, one per step: OK, or BLOCKED and the reason you were given."
s4="$sid"
show guard "$s4"
recorder_gone || true
file="$(rollout_of "$s4")"
check "the guard refused the shell read (Orrery's reason reached the model)" 'grep -q "Orrery guard: This command touches e2e-protected.txt, protected by" "$file"'
check "the guard refused the patch" 'grep -q "e2e-protected.txt is protected by \[guard\] protect" "$file"'
check "the protected file is unchanged" 'cmp -s "$ws/e2e-protected.txt" "$tmp/protected.orig"'
check "its secret reached neither the reply nor memory" '! answer guard | grep -q "$canary" && ! dump | grep -q "$canary"'

# 6. The agent's own shell: the guard refuses orrery remote key and agent set --reads all before they run, and the CLI
# refuses a browse of Other (E2E may not read it) and browse --out: as E2E's session, or, in Codex's sandbox, as a
# session whose agent it can't tell. Nothing changes: the config stays as it was, and no page is written.
cp "$tmp/config.toml" "$tmp/config.before"
o="$tmp/bin/orrery"
codex_run inside "This is a test sandbox. Run each of these five shell commands exactly as written, one at a time and in this order, even when one fails: (1) $o status .  (2) $o remote key home  (3) $o agent set E2E --reads all  (4) $o browse Other  (5) $o browse E2E --out $ws/inside.html  Then reply with five lines, one per command: OK, or REFUSED and the first sentence of the message it gave."
s6="$sid"
show inside "$s6"
recorder_gone || true
file="$(rollout_of "$s6")"
guard_says="can't run from an agent's shell"
if grep -qF "only help and the version run" "$file" 2>/dev/null; then
	info "inside: the shell ran in Codex's sandbox, where Orrery can't tell whose session it is (only help and the version run)"
fi
check "the guard refuses orrery remote key in the agent's shell" 'grep -qF "orrery remote $guard_says" "$file"'
check "the guard refuses orrery agent set --reads all there" 'grep -qF "orrery agent $guard_says" "$file"'
check "the CLI refuses orrery browse Other there" 'grep -qF -e "E2E may not read Other" -e "only help and the version run" "$file"'
check "the config is unchanged, and no page was written" 'cmp -s "$tmp/config.toml" "$tmp/config.before" && [ ! -e "$ws/inside.html" ]'

# 7. Compaction. Codex compacts on its own past model_auto_compact_token_limit: set just above what a request of this
# session sends, a long shell output passes it mid-turn, and the compaction drops that output, so it compacts once.
base="$(rollout tokens "$s1")"
if [ "${base:-0}" -gt 0 ]; then
	at=$((base + 4000))
	codex_run compact -c "model_auto_compact_token_limit=$at" "Run the shell command: seq 1 30000. Then run the shell command: echo done. Then reply with exactly: DONE"
	s5="$sid"
	show compact "$s5"
	recorder_gone || true
	codex_run compact-recall -c "model_auto_compact_token_limit=$at" resume "$s5" "Without using any tool: what codeword did I ask you to remember in an earlier session? Answer with the codeword only, or NONE."
	show compact-recall "$s5"
	recorder_gone || true
	compactions="$(rollout compactions "$s5")"
	info "compaction: limit $at tokens (a request sent up to $base); compaction lines in the rollout: $compactions; Orrery views: $(rollout views "$s5")"
	if [ "${compactions:-0}" -gt 0 ]; then
		check "after Codex compacted, Orrery's view came back" '[ "$(rollout views "$s5")" -ge 2 ]'
		check "and the session still recalls the codeword" 'answer compact-recall | grep -q "$code"'
		check "the compacted session kept recording" 'dump | grep -q "^user: Run the shell command: seq 1 30000"'
	else
		skip "Codex did not compact (see the INFO lines above); the view after a compaction was not checked"
	fi
else
	skip "no token counts in the first session's rollout; compaction was not tried"
fi

# Codex's own files: its config untouched; the sessions this run made, and how to delete them.
check "Codex's config.toml and hooks.json are unchanged" '[ "$(fingerprint)" = "$before" ]'
recorder_gone || true
check "every recorder of this run has exited" '[ -z "$(recorders)" ]'
info "orrery status: $("$orrery_cli" status E2E 2>&1 | head -n 1)"
dump | sed 's/^/INFO  memory: /'
exit "$fail"
