# Agents in pi

Agents run inside pi, on the workstation. An agent is a name, instructions, memory and settings kept in Orrery's
folder, and it can have a default folder. Open it in any folder with `orrery agent <Name>`, or start pi in its default
folder: the Orrery extension gives pi the agent's instructions and memory. See [deployment and backups](deploy.md) for always-on hosts
and remote backup copies.

## Install

The installer asks, then wires this: it writes pi's extension file and points it at `~/.orrery/app/current`. If pi
is not on PATH, it prints "not found on PATH; not wired" and carries on. If you say no, or there is no terminal to ask
on, it lists what it left and exits non-zero; rerun `orrery setup --yes`. A file there that is not Orrery's is renamed
to `orrery.ts.before-orrery-<date>` before it is replaced. If pi cannot be checked (an unreadable extension file), it
says "check pi by hand: <reason>" and also exits non-zero. The TUI does the same: run `orrery`, open Tools (4), select
pi and press `I` (or `orrery tools install pi`).

If you ever write the file by hand, it is one line that imports Orrery's packed extension from the installed copy:

```bash
printf 'export { default } from "%s/extensions/pi.js";\n' ~/.orrery/app/current > ~/.pi/agent/extensions/orrery.ts
```

Setup commands like this one name the installed app folder, which the guard refuses to an agent's own tools: run them
in your own terminal. The packed file carries its own dependencies, so pi needs nothing else installed. Don't symlink it into the extensions
folder: pi resolves an extension's imports from where it finds the file.

Developing Orrery itself is different: running `orrery` from a checkout is development mode, and `I` on the Tools page then
points at that checkout. See [CONTRIBUTING.md](../CONTRIBUTING.md) for putting agents back on an installed copy.

To remove Orrery from pi, delete `~/.pi/agent/extensions/orrery.ts` (or run `orrery uninstall`).

The install also puts `orrery` on your PATH, as `~/.local/bin/orrery`.

The first `orrery` run writes the config for you. To write it by hand, start from the example the release carries,
`~/.orrery/app/current/deploy/workstation/config.example.toml`. `~` works in `data_dir`, which you can leave out to keep
memory in `~/.orrery`.

```bash
install -D ~/.orrery/app/current/deploy/workstation/config.example.toml ~/.orrery/config.toml
```

Most behavior needs no code: models, memory sizes, when compaction happens and each agent's tool are settings in
`~/.orrery/config.toml`.

The extension targets pi 1.0.4 and is also tested with 1.1.0. If you use mise, select a compatible version:

```bash
mise use -g pi@1.0.4
```

## Daily use

One terminal panel per agent. Open the agent with Orrery, in whatever folder you are working in:

```bash
cd ~/code/some-project && orrery agent Atlas
```

Or start pi in the agent's default folder, as before:

```bash
cd ~/code/agent-Atlas && pi -c
```

The first time in a default folder that already has old pi sessions, start with `pi` (a new session), not `pi -c`.
Otherwise the old session is copied into memory as if it were new.

The same agent can also be opened in Claude Code (see [claude-code.md](claude-code.md)) or OMP (see [omp.md](omp.md)), one at a time.

**Which agent a session is** is decided when it starts, in this order: `ORRERY_AGENT` when it names a configured agent
(`orrery agent` sets it; a name that is not configured gives a notice and no memory), then the agent whose default
folder holds pi's folder, then none, and pi runs without Orrery's memory. `orrery agent` also gives the session a
one-time token that the first pi process claims, so a tool the agent starts itself, which inherits `ORRERY_AGENT`, is
not the agent too. A session belongs to the agent that first ran in it: another agent that resumes it records from its
tail.

The footer shows the agent, the message count, and "summarizing" while summaries are pending. While summary calls fail it says
"SUMMARIES FAILING: <source and reason> · /compactor" (they retry on their own), and "SUMMARIES STOPPED" if the
summarizer gave up or its model is unknown, with the reason. A notice says so once when summaries start failing or
stop, and once when they work again.

When Orrery is updated under an open session (`orrery update` in another terminal), a warning says once "Orrery was
updated to 0.6.2; restart this session to use it." When a newer release is out, one says "Orrery 0.6.2 is available.
Run `orrery update`, then restart this session." The session reads the last daily check when it opens and makes the
check itself in the background when that one is a day old, so it never waits on the network (README, Updating and
uninstalling). Neither notice reaches the model. OMP shows the same.

Summaries use Orrery's own logins, in pi and in Claude Code alike (pi's `/login` stays for the agent's model). From a
shell: `orrery login openai` (Sign in with ChatGPT), or `orrery login --key openai|anthropic|openrouter` for an API key
(typed hidden; `--from-pi` copies a key pi's `/login` already saved). `orrery logins` lists what is saved, never the
keys; `orrery logout openai` or `orrery logout --key <name>` removes one.
Orrery's logins live in its own credential file, `credentials.json` in `~/.orrery/` (the config's `credentials` key can move it), mode 0600.

Commands from Orrery:

- `/memory`: messages, summaries, view size, summary model, token use, and why summaries fail or stopped.
- `/compactor`: a menu: Sign in (ChatGPT, OpenRouter) / API key (OpenAI, Anthropic, OpenRouter) / Local, then the provider, then
  the model (with prices for keys), then the thinking level (the current one first, so Enter keeps it). A long list
  (OpenRouter) asks for words to narrow it first. Each switch makes one
  test call; a failure keeps the current model and says why. `/compactor key openrouter/<model> [thinking]` switches
  directly; `/compactor reset` returns to the config. The choice survives restarts. The TUI's `M` (or `orrery compactor <Name> …` in a shell) also switches an agent that is open in pi: pi takes the change within 5 seconds and says so. Sign-in is available in the picker or through
  `orrery login`; pasted keys are entered in a terminal, never in chat.
- `/browse`: writes `memory.html` in the agent's data folder and opens it: the view, all messages, the summary tree.
  The notice gives the path, so you can open it yourself over ssh.

`/model` and `/login` are pi's own. `/model` picks the agent's model. The `model` key in the config is used only by
Orrery's own commands.

Before each message, pi's context is replaced by the memory view: the summaries and the newest messages. Only the
current run is sent in full. Memory keeps your messages and the agent's replies only. Tool calls and their results stay
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

If the summary model is unknown to Orrery, the agent still opens with its memory. Pick a model with `/compactor`, and
summaries start.

pi's own compaction is off for agents, so a `pi -c` session keeps growing. Start a fresh session with `/new` now and then
(for example weekly). Memory carries over.

Forks (`/fork`, `pi --fork`) are not copied into memory twice.

## Instructions

An agent's instructions are `instructions.md` in its data folder (`~/.orrery/agents/<Name>/`). At session start the
extension adds them to pi's system prompt under a heading that names the agent (`# Agent: <Name>`), before the memory
section. Up to 32 KB reach the model; a longer file is cut there, with a notice in the session and on the Agents page.
A missing or empty file means the agent runs with memory only. The instructions go out whether or not the memory does,
so a session without memory keeps its identity.

Only a person edits them: `E` in the TUI, or `orrery agent edit <Name>` in a terminal (it uses `$EDITOR`, else `nano`,
else `vi`, and needs a terminal). A running pi takes the change at its next start; the Agents page says which open
agents have newer instructions than their session. The folder's own `AGENTS.md` loads as pi normally loads it, as the
project's rules.

## Memory tools the model has

- `zoom`: read the original text behind a summary.
- `date`: find messages by date.
- `search`: search the log.

An agent with `reads = ["*"]` (or a list of agent names), like Birch, also gets `agents` and `agent_memory`. They list
the other agents and read their memory. They are read-only.

## Imports and builds

In the TUI, `N` on the Agents page, then "From an existing chat", turns Claude Code and Codex chats into an agent. The
list shows every chat and marks one written to in the last ten minutes "in use". The import is a snapshot: the source
chats are only read, never changed, and anything said in them afterwards is not in the agent. The memory builds in the
background, and you can open the agent once it is done.

From a shell, import an agent's Claude Code and Codex history. Preview first (the dry run prints progress lines),
review the report, then commit. Claude Code deletes its
session files after 30 days by default, so import early, or raise `cleanupPeriodDays` in `~/.claude/settings.json`.

```bash
orrery import Atlas --dry-run
orrery import Atlas --commit import-Atlas/preview.jsonl
```

Orrery reads the Claude Code sessions in the agent's own project folder. A session filed under another project is
added with `--claude-file FILE` (repeatable; `--claude none` imports only the named files). A record whose uuid was
already read, in any file, is read once.

```bash
orrery import Elm --dry-run --claude none --claude-file ~/.claude/projects/-home-me-other-project/<session>.jsonl
```

Orrery finds a Codex session only if it started in the agent's folder. If a session started elsewhere and was later
resumed there, name its rollout file (repeatable; `--codex none` skips the sessions folder and imports only the named
files):

```bash
orrery import Elm --dry-run --codex-file ~/.codex/sessions/2026/05/01/rollout-2026-05-01T10-00-00-abc.jsonl
```

The summary and the report's "Left out" section list what was skipped on purpose. A forked Codex session starts with
a copy of its parent's history, stamped with the fork's start time; that copy is skipped. If the parent's rollout is
not imported too, a warning says so: add it with `--codex-file` to keep those messages with their real dates.
Claude Code records copied into a resumed session (same uuid) are read once. Codex subagent sessions are skipped.

Build the summary tree for a big import with the CLI. Close that agent's pi first.

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

Backups are in `~/.orrery/backups/<date>/<Name>/`. Restore with `orrery restore <Name> --from <date>`,
with the agent's pi closed.

## One writer

Only one pi can write to an agent. A second pi on the same agent shows a warning and runs without memory. The path guard
still applies to it. Close the first one, or work in it.

## Limits

- No memory without a good config. A malformed config file shows a warning ("running without memory"), and pi runs
  with the default guard on: its folder is the only place it may write, credentials and `.env` files stay out, and so
  does what its `[guard] protect` lists, when the file parses as TOML and that part reads cleanly. If it has a
  `[guard]` table pi cannot read (broken TOML around it, a refused entry), or cannot be read at all, every tool call is
  refused until it is fixed, and the warning says so. With no config file at all, pi runs as usual.
- pi's own compaction is cancelled for agents. The memory view replaces it. The one exception is overflow recovery:
  if the model's window overflows, pi may compact once to recover.
- The path guard judges a path the way pi's tools resolve it (`~`, a leading `@`, `file://`, relative to pi's cwd)
  and follows symlinks. So write and edit cannot reach outside the folder the agent was opened in and its `allowed_roots`, even through a
  link. bash is only checked for text: ssh keys, credential stores, and Orrery's own folders. It is a seatbelt, not a
  sandbox.
- Orrery's data folder is refused to file tools, except reading the installed program (`app/`) and `config.toml`; the
  config and the installed program are read-only to agents. Only an agent's own sessions read its memory view: other
  agents' file tools and content searches are refused it. The shell-text rules are a seatbelt too. Known limits include
  variables, `eval`, `cd`, escape codes, brace names split across words, commands that change folder with their own flag (`git -C`, `tar -C`), a swap of the session's own folder in the same command, a shell search of an agent's whole folder, and hard links to a protected file; a relative path or a link to the config is not caught either.
- Credential files: the guard blocks ssh keys and credential stores, `~/.pi/agent/models.json` and `/proc/*/environ`.
  It refuses a grep, find or ls rooted at home or above, at a folder that holds credentials (like `~/.pi` or Orrery's
  data folder), or in `/proc`. Search a narrower folder instead. Reads elsewhere are allowed: agents read other repos.
- `.env` files and `[guard] protect`: a project's `.env` and `.env.<anything>` (but `.env.example`, `.env.sample`,
  `.env.template` and `.env.dist`) are kept out like credentials, so agents neither read nor edit them. `[guard]
  protect` in the config adds your own paths (`/…` or `~/…`) and names (every file or folder so named); see the
  [README](../README.md#safety). **A search of a folder can still read a `.env` inside it**, or a file a protected name
  covers: only a protected path is checked against a search's folder. A bash command that has a protected name as a
  word is refused even when it means something else (`git commit -m "ignore .env"`).
- The guard knows pi's built-in tools only. Tools added by other pi packages (for example context-mode's
  `ctx_execute`) are not checked.
- A message does not wait for summaries longer than 60 seconds, and not at all while they are failing or stopped.
- Memory tools read what is in the log. Text that was never sent through pi (for example, work in another tool) is not
  there until you import it.
- The CLI (`orrery run <Name>`) and the always-on service are the old path. Do not run an agent there and in pi at once.

For launching this tool through Ori, see [Ori](ori.md).
