# Lanes in pi

Lanes run inside pi, on the workstation. Each lane is a folder (its workspace). When you start pi in that folder,
the Orrery extension gives the agent its memory. See [deployment and backups](deploy.md) for always-on hosts
and remote backup copies.

## Install

The TUI does this for you: run `orrery`, open Tools (4), select pi and press `I` (or `orrery tools install pi`). By hand:

Add a one-line extension file to pi that imports Orrery by its absolute path:

```bash
printf 'export { default } from "%s/src/pi/index.ts";\n' ~/code/orrery > ~/.pi/agent/extensions/orrery.ts
```

Don't symlink `src/pi` into the extensions folder. pi resolves an extension's imports from where it finds the file,
so a link breaks Orrery's imports, and pi then fails to start at all.

Install from a checkout. The install copies the last commit and its runtime packages to `~/.orrery/app`, so pi finds
typebox and smol-toml there, and pi loads the extension from that copy.

```bash
cd ~/code/orrery
npm_config_ignore_scripts=true npm ci
npm run install-local
```

To remove Orrery from pi, delete `~/.pi/agent/extensions/orrery.ts`.

The install also puts `orrery` on your PATH, as `~/.local/bin/orrery`.

Write the config. Start from [deploy/workstation/config.example.toml](../deploy/workstation/config.example.toml).
`~` works in `data_dir`, which you can leave out to keep memory in `~/.orrery`.

```bash
install -D deploy/workstation/config.example.toml ~/.orrery/config.toml
```

The extension targets pi 1.0.4 and is also tested with 1.1.0. If you use mise, select a compatible version:

```bash
mise use -g pi@1.0.4
```

## Daily use

One terminal panel per lane. Start pi in the lane's folder:

```bash
cd ~/code/agent-Atlas && pi -c
```

The first time in a lane folder that already has old pi sessions, start with `pi` (a new session), not `pi -c`.
Otherwise the old session is copied into memory as if it were new.

The same lane can also be opened in Claude Code (see [claude-code.md](claude-code.md)) or OMP (see [omp.md](omp.md)), one at a time.

The folder picks the lane: pi's cwd must be the lane's workspace or a folder inside it. The footer shows the lane,
the message count, and "summarizing" while summaries are pending. While summary calls fail it says
"SUMMARIES FAILING: <source and reason> · /compactor" (they retry on their own), and "SUMMARIES STOPPED" if the
summarizer gave up or its model is unknown, with the reason. A notice says so once when summaries start failing or
stop, and once when they work again.

Summaries use Orrery's own logins, in pi and in Claude Code alike (pi's `/login` stays for the agent's model). From a
shell: `orrery login openai` (Sign in with ChatGPT), or `orrery login --key openai|anthropic|openrouter` for an API key
(typed hidden; `--from-pi` copies a key pi's `/login` already saved). `orrery logins` lists what is saved, never the
keys; `orrery logout openai` or `orrery logout --key <name>` removes one.
Orrery's logins live in its own credential file, `credentials.json` in `~/.orrery/` (the config's `credentials` key can move it), mode 0600.

Commands from Orrery:

- `/memory`: messages, summaries, view size, summary model, token use, and why summaries fail or stopped.
- `/compactor`: a menu: Sign in (ChatGPT, OpenRouter) / API key (OpenAI, Anthropic, OpenRouter) / Local, then the provider, then
  the model (with prices for keys). A long list (OpenRouter) asks for words to narrow it first. Each switch makes one
  test call; a failure keeps the current model and says why. `/compactor key openrouter/<model> [thinking]` switches
  directly; `/compactor reset` returns to the config. The choice survives restarts. The TUI's `M` (or `orrery compactor <Lane> …` in a shell) also switches a lane that is open in pi: pi takes the change within 5 seconds and says so. Sign-in is available in the picker or through
  `orrery login`; pasted keys are entered in a terminal, never in chat.
- `/browse`: writes `memory.html` in the lane's data folder and opens it: the view, all messages, the summary tree.
  The notice gives the path, so you can open it yourself over ssh.

`/model` and `/login` are pi's own. `/model` picks the agent's model. The `model` key in the config is used only by
Orrery's own commands.

Before each message, pi's context is replaced by the memory view: the summaries and the newest messages. Only the
current run is sent in full. Memory keeps your messages and the lane's replies only. Tool calls and their results stay
visible to the model during the run but are not logged. Code history lives in git.

The view is 64–128 KB. It grows by one line per message; once its summaries pass 128 KB (`view_bytes`), one batch
merges the oldest lines down to 64 KB. Between batches a message only adds lines at the end, so the model's prompt
cache keeps the rest of the view. The view is saved with the memory and reopens as it was. The first open after
upgrading builds it once, which costs one cache miss. Each summary call reads its own smaller view, 16–32 KB, whose
top is `compactor_context_bytes`. `/memory` and `orrery status` show the view's size counting summarized lines only,
so right after an import it reads near 0 until summaries are built.

A `!cmd` you run between messages goes to the model with your next message, but not into memory. A `!!cmd` goes to
neither. A `!cmd` you run while the agent is working goes nowhere.

If summaries are pending, a message waits for them for at most 60 seconds. Then it goes out with lines that say
"(not summarized yet: zoom it)", and a warning says so. A message does not wait at all while summaries are failing or
stopped; the warning gives the reason.

If the summary model is unknown to Orrery, the lane still opens with its memory. Pick a model with `/compactor`, and
summaries start.

pi's own compaction is off in lanes, so a `pi -c` session keeps growing. Start a fresh session with `/new` now and then
(for example weekly). Memory carries over.

Forks (`/fork`, `pi --fork`) are not copied into memory twice.

## Memory tools the model has

- `zoom`: read the original text behind a summary.
- `date`: find messages by date.
- `search`: search the log.

A lane with `reads = ["*"]` (or a list of lane names), like Birch, also gets `lanes` and `lane_memory`. They list
the other lanes and read their memory. They are read-only.

## Imports and builds

Import a lane's Claude Code and Codex history. Preview first, review the report, then commit.

```bash
orrery import Atlas --dry-run
orrery import Atlas --commit import-Atlas/preview.jsonl
```

Orrery reads the Claude Code sessions in the lane's own project folder. A session filed under another project is
added with `--claude-file FILE` (repeatable; `--claude none` imports only the named files). A record whose uuid was
already read, in any file, is read once.

```bash
orrery import Elm --dry-run --claude none --claude-file ~/.claude/projects/-home-me-other-project/<session>.jsonl
```

Orrery finds a Codex session only if it started in the lane's folder. If a session started elsewhere and was later
resumed there, name its rollout file (repeatable; `--codex none` skips the sessions folder and imports only the named
files):

```bash
orrery import Elm --dry-run --codex-file ~/.codex/sessions/2026/05/01/rollout-2026-05-01T10-00-00-abc.jsonl
```

The summary and the report's "Left out" section list what was skipped on purpose. A forked Codex session starts with
a copy of its parent's history, stamped with the fork's start time; that copy is skipped. If the parent's rollout is
not imported too, a warning says so: add it with `--codex-file` to keep those messages with their real dates.
Claude Code records copied into a resumed session (same uuid) are read once. Codex subagent sessions are skipped.

Build the summary tree for a big import with the CLI. Close that lane's pi first.

```bash
orrery compact Atlas
```

`orrery compact` uses Orrery's own login, not pi's. Run `orrery login <provider>` once first (for example
`orrery login openai`, which signs in with ChatGPT).

## Backups

A user timer can run `orrery backup` at 01:15 and mirror the result to a backup host with rsync.
First create your local `backup.env` from [the example](../deploy/workstation/backup.env.example), with the host,
user and SSH identity for your backup destination. See [deployment and backups](deploy.md#workstation-backups)
for the complete setup. The script refuses to run without this file.

The service runs the installed script, `~/.orrery/app/current/deploy/workstation/backup.sh`. Install the timer:

```bash
cd ~/.orrery/app/current/deploy/workstation
install -D -m 644 orrery-backup.service orrery-backup.timer -t ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now orrery-backup.timer
systemctl --user start orrery-backup.service
```

See whether last night's backup worked:

```bash
systemctl --user status orrery-backup.service
systemctl --user list-timers orrery-backup.timer
journalctl --user -u orrery-backup.service
```

The remote destination is a mirror of the local backups, with the same retention (`orrery backup` keeps 14 days). The script refuses to
sync when the local backups folder is missing or empty, so a failed backup cannot wipe the remote copy.

Backups are in `~/.orrery/backups/<date>/<Lane>/`. Restore with `orrery restore <Lane> --from <date>`,
with the lane's pi closed.

## One writer

Only one pi can write to a lane. A second pi on the same lane shows a warning and runs without memory. The path guard
still applies to it. Close the first one, or work in it.

## Limits

- No memory without a good config. A malformed config file shows a warning ("running without memory") and pi runs
  as usual.
- pi's own compaction is cancelled in lanes. The memory view replaces it. The one exception is overflow recovery:
  if the model's window overflows, pi may compact once to recover.
- The path guard judges a path the way pi's tools resolve it (`~`, a leading `@`, `file://`, relative to pi's cwd)
  and follows symlinks. So write and edit cannot reach outside the lane folder and the allowed roots, even through a
  link. bash is only checked for ssh keys and credential stores. It is a seatbelt, not a sandbox.
- Credential files: the guard blocks ssh keys and credential stores, `~/.pi/agent/models.json` and `/proc/*/environ`.
  It refuses a grep, find or ls rooted at home or above, at a folder that holds credentials (like `~/.pi` or Orrery's
  data folder), or in `/proc`. Search a narrower folder instead. Reads elsewhere are allowed: lanes read other repos.
- The guard knows pi's built-in tools only. Tools added by other pi packages (for example context-mode's
  `ctx_execute`) are not checked.
- A message does not wait for summaries longer than 60 seconds, and not at all while they are failing or stopped.
- Memory tools read what is in the log. Text that was never sent through pi (for example, work in another tool) is not
  there until you import it.
- The CLI (`orrery run`) and the always-on service are the old path. Do not run a lane there and in pi at once.

For launching this tool through Ori, see [Ori](ori.md).
