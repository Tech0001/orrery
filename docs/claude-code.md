# Lanes in Claude Code

A lane can run in Claude Code as well as in pi, on the same memory (`~/.orrery/lanes/<Lane>/`). Monday in
pi and Tuesday in Claude Code are one memory. Claude's subscription covers Claude Code, not pi.

## Install, once per machine

Or run `orrery`, open Tools (4), select Claude Code and press `I` (`orrery tools install claude-code`).

1. Orrery itself, as in [pi.md](pi.md): `npm run install-local`, which installs the `orrery` command, wires the
   plugin from `~/.orrery/app/current`, and needs `~/.orrery/config.toml`.
2. A login for summaries. Summaries run in the background on Orrery's own login, not Claude's. Run
   `orrery login openai` (Sign in with ChatGPT) for the lanes' `compactor_model`.
3. The plugin: `npm run install-local` wires this. If you must do it by hand, add the installed copy, never a
   checkout (that would move the plugin off `app/current`):

   ```bash
   claude plugin marketplace add ~/.orrery/app/current
   claude plugin install orrery@orrery
   ```

The plugin is installed for every folder, but a lane records in Claude Code only once `orrery claude-setup <Lane>` has
run for it (below). In any other lane's folder, or a subfolder of one, Claude Code runs without recording: no
recorder starts, nothing is kept, and the lane stays free for pi. The first line the model gets says so, and so does
a message to you. The guard still applies there.

The plugin runs `~/.local/bin/orrery`, so it uses the installed version (`~/.orrery/app/current`) and this
machine's Node. After a change to Orrery's code, run `npm run install-local` again; new hook processes use the new
version at once, while a running session's own recorder keeps the old one until the session restarts. Without that
launcher the hooks do nothing: they exit quietly and print nothing. Claude Code then lists the `orrery` MCP server as failed to connect.

After a change to `claude-plugin/` itself, bump `version` in `claude-plugin/.claude-plugin/plugin.json` (a fixed
version can keep a cached copy), then refresh the copy Claude Code installed. `claude plugin update orrery@orrery`
may do it in one step; otherwise:

```bash
claude plugin marketplace update orrery
claude plugin uninstall orrery@orrery
claude plugin install orrery@orrery
```

## Set up a lane, once

Launching a Claude Code lane from the TUI (`L`) offers this setup the first time.

```bash
orrery claude-setup <Lane>
```

- A lane folder of its own gets `CLAUDE.md` with `@AGENTS.md` and `@.orrery/view.md`.
- A shared repo gets `CLAUDE.local.md` instead, with `CLAUDE.local.md` and `.orrery/` listed in `.git/info/exclude`, so
  nothing in the repo changes.
- If `CLAUDE.md` is a symlink (often `CLAUDE.md -> AGENTS.md`), setup uses `CLAUDE.local.md` and never writes through
  the link. Its report says so, with the link's target quoted.
- `AGENTS.md` is loaded once. Claude Code's builtin AGENTS.md support (2.1.291) loads it by default only in a project
  with no `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md`, and setup always leaves one of those, importing
  `@AGENTS.md` itself unless `CLAUDE.md` already loads it.
- Setup never writes through a symlink. It refuses, and writes nothing, when a file it would edit (`CLAUDE.md` or
  `CLAUDE.local.md`, and the repo's `info/exclude`) is a symlink, is not a regular file, or is over 256 KB, or when
  `.orrery/` or the repo's `info/` folder is a symlink, or is not a folder of yours. The exclude file is the one git
  names (`git rev-parse --git-path info/exclude`). For a lane in a repo's subfolder, or in a worktree, that is the
  main repository's, outside the workspace, and setup uses it.
- In a git workspace, `.orrery/` must be invisible to git, because the view holds your messages. Setup refuses when
  `.orrery/` is tracked, is not ignored (a repo's own `.gitignore` can undo `.git/info/exclude`, for example with
  `!.orrery/`), or is spelled differently by the repo (a case variant). Fix the repo, then run setup again. Setup
  runs git itself, never through a shell string.
- After a good setup it writes a trusted marker in the lane's data folder (`claude/setup.json`). The view is written
  only where that marker exists, so a repo cannot make Orrery start writing into it. Setup is the only way a workspace
  starts receiving the view.
- It is safe to rerun.

Moving an agent over (the spec's section 6):

1. close it in pi or Codex;
2. run `orrery claude-setup <Lane>`;
3. `cd <lane folder> && claude`.

Only lanes where `claude-setup` ran record in Claude Code. In the others the guard still applies, and memory is not
touched. The lane can go back to pi later.

## Mod mode

With Claude Code 2.1.287 or newer and the Orrery plugin 0.3.0, a lane can get its memory from the Orrery mod instead
of the view file:

    orrery claude-setup <Lane> --mod

- **The view goes in the system prompt.** The mod adds it when the session starts, and refreshes it at each
  compaction. The `@.orrery/view.md` line is removed from CLAUDE.local.md, and from CLAUDE.md where Orrery wrote it (a
  lane folder that is not a git repo). A committed CLAUDE.md in a git repo keeps its line, and the command says so.
  `.orrery/view.md` is deleted (unless git tracks it); `@AGENTS.md` stays.
- **Orrery answers compaction.** `/compact`, Claude Code's own automatic compaction, and the mod's keep the last turn
  (its prompt, tool calls and reply) and refresh the view, with no model call. It waits up to 30 s for the summaries of
  the turns just recorded. After an Orrery compaction the kept last turn carries its text and tool calls, not images,
  the model's thinking or attachments. A turn kept in the middle of its tool loop (Claude Code's own threshold, or an
  Esc there) keeps everything, and its memory section can then stay stale until the next compaction.
- **The conversation compacts itself** once it passes the lane's `compact_at` (default 200,000 tokens, at least
  100,000): `orrery lane set <Lane> --compact-at 150000`, or the TUI's `E`. Only interactive sessions; `claude -p`
  compacts at `/compact` and Claude Code's own threshold. If a compaction the mod started cannot be answered, the
  conversation stays as it is and the mod starts no more in that session; when only the last turn was too large to
  keep, it tries again after a later turn.
- **Fallbacks.** When the view cannot be read, the lane has no memory yet, or the last turn alone is over half of
  `compact_at`, Claude Code compacts its own way and one line says why. If the mod is not loaded at all (an older
  Claude Code, or mods turned off), the session runs without the memory view and the model is told to say so.
- **A session that is not recorded** (read-only, another window on the lane) compacts the Claude Code way: its older
  turns are not all in memory.
- **Recording, the guard and the one-writer rule are unchanged.**
- **Switching back:** plain `orrery claude-setup <Lane>` puts the view file and its import line back (in CLAUDE.md for
  a lane folder that is not a git repo, CLAUDE.local.md in a repo). Either switch takes effect at the next session
  start. Before going back to an older Orrery version, run plain `orrery claude-setup <Lane>`: older versions do not
  know mod mode and stop recording the lane.
- After a compaction Claude Code does not list its deferred tools again; the memory section tells the model to load
  `zoom`, `date` and `search` with ToolSearch when they are not listed.

What you see in a mod-mode lane: until your first prompt, a band above the prompt shows the Orrery logo with `Orrery ·
<Lane>` and the lane's state (`memory loaded · N msgs · recording`, `no memory yet`, or `read-only (another window
records this lane)`); a narrow or short window shows the two lines without the logo (the logo needs the band to be 60
columns wide, which is the terminal less Claude Code's margin, and 5 rows tall), as do surfaces other than the
terminal. `Orrery · <Lane> · N msgs`, as pi's status line reads, stays among the mode labels at the right of the
prompt footer for the whole session; the count moves after each turn, once the turn has reached memory (in a
read-only window, when the recording window's turns have landed and this window ends a turn). In a narrow window
Claude Code puts the mode labels on a line of their own under the footer. After a
`/compact`, Claude Code's own `Compacted (ctrl+o to see full summary)` row is followed by Orrery's line: `Orrery
compacted: kept the last turn …`, or why Claude Code compacted its own way. A compaction the mod started, or Claude
Code's automatic one, logs the same line once it is done. Lanes not in mod mode, and folders outside any lane, show
none of this.

## Bring an agent's history

Claude Code files a session under the project folder it started in. An agent whose past lives under another
project can be imported by naming those files, with the lane's own folder skipped:

```bash
orrery import Rowan --dry-run --claude none \
  --claude-file ~/.claude/projects/-home-alex-code-sample-project/<session>.jsonl \
  --claude-file ~/.claude/projects/-home-alex-code-sample-project/<other-session>.jsonl
```

Review the report, then `orrery import Rowan --commit <out>/preview.jsonl`, then `orrery compact Rowan`, with Rowan
closed everywhere. Do it before the first session in the new lane folder. A file that is missing, or is no Claude
Code session, stops the import before anything is written. A record that appears in two files (a resumed session)
is imported once.

## Daily use

Start Claude Code at the lane folder's root.

- The first line the model gets is `orrery · <Lane> · N msgs · recording`, or `read-only: this session is not
  recorded`, `not recording yet` (the recorder did not answer in time), `not set up for Claude Code here, so this
  session is not recorded` (run `orrery claude-setup <Lane>`), or `no memory yet` in place of the message count. When
  something is off, the line after it says why: the lane is open elsewhere, the recorder did not answer, `CLAUDE.md`
  does not load the view, or git is the problem (below).
- Memory keeps your prompts and each turn's final reply. Tool calls, tool output, thinking, subagents and slash
  commands are not kept. The reply to one of Orrery's own commands (`/orrery:memory`, `/orrery:compactor`,
  `/orrery:browse`) is not kept either, as in pi. The reply to any other slash command or skill is real work, so it is
  kept, without the command.
- The view loads when a session starts. A long session runs on the view it started with plus its own transcript.
  Start a fresh session (or `--resume`) to pick up a newer view.
- If git cannot answer whether `.orrery/` is ignored (git missing, a broken repo, a timeout), the view is taken out of
  the workspace until git can answer again. The session that takes it out says so at the start; the next write that
  passes the check puts it back silently.
- If `.orrery/` becomes visible to git after setup, SessionStart removes the marker and the view and says why. That
  session, and every later one, is not recorded until you fix the repo and run `orrery claude-setup <Lane>` again.
- Claude Code also loads your claude.ai connectors. One that needs authorization can make the model add a note like
  "…connectors won't work until you authorize them" to its replies, and those replies are memory. Authorize or remove
  those connectors on claude.ai. In Claude Code 2.1.291 (seen in its binary), `ENABLE_CLAUDEAI_MCP_SERVERS=0` in the
  environment also stops it loading them.
- When a lane's summaries start failing or stop, you get a one-line notice (once, and once more when they recover)
  saying which source and why, for example "the OpenRouter account has no balance". It is shown to you, not to the
  model, so it never enters memory. Summaries keep retrying; switch the source with `/orrery:compactor`.
- Claude Code's own compaction stays on.

## Commands

- `/orrery:memory` runs `orrery status .` and `orrery usage .`.
- `/orrery:compactor` shows the summary model and the sources: Sign in (`openai`), API key (`openai`, `anthropic`,
  `openrouter`) and Local (only when configured), with what is saved. `/orrery:compactor key openrouter haiku` lists
  matching models with prices; `/orrery:compactor key openrouter/<model> [thinking]` switches after one test call (a
  failure keeps the current model and says why); `reset` goes back to the config's model. Keys are saved from a shell
  only (`orrery login --key …`), never in chat. The choice is shared with pi's `/compactor`. The plugin grants only `orrery-run compactor` to this
  command, and only you can start it; a
  command with `;`, `|` or `$(...)` in what you typed is meant to fall outside that grant. In the end-to-end run under
  `--permission-mode default` (Claude Code 2.1.291), Claude Code's permission check stopped
  `/orrery:compactor x $(touch …)` and `/orrery:compactor x; touch …` before anything ran. Its reasons were "A nested
  command in this command can't be checked before it runs" for the first; for the second, the `touch` "needs
  approval" because its path was outside the session's working folders. The skill was loaded, the `touch` never
  happened, Orrery was not called, no model turn ran, and nothing entered memory. `claude -p` shows that message only
  in its `stream-json` output, not as an answer. The message ends "Allowing runs the command as written", which
  suggests an interactive session asks you instead; that, a target inside the workspace, and other permission modes
  were not checked. The three commands with plain arguments ran with no prompt.
- `/orrery:browse` writes the memory explorer to `memory.html` in the lane's data folder and opens it.

These commands are for you: the model cannot start them. The same commands work from a shell, with the lane name or
`.` for the lane whose workspace holds the current folder:

```bash
orrery status [<Lane>]
orrery compactor <Lane> [signin|key|local [name [words] | name/model [thinking]] | provider/id [thinking] | reset]
orrery browse <Lane> --open
orrery claude-setup <Lane> --mod                  # switch a lane to mod mode; plain claude-setup switches back
orrery lane set <Lane> --compact-at TOKENS        # where the mod compacts (at least 100000)
orrery claude-mod view --cwd DIR [--session ID] [--wait-ms N [--spool-only]]   # the mod's own call: the lane's memory section as JSON
```

In the plugin's commands, `.` is the folder of the Bash tool's shell: the folder Claude Code started in, or wherever a
`cd` in the Bash tool has moved it since (Claude Code gives these commands no `CLAUDE_PROJECT_DIR`). Any folder inside
the lane's workspace still names the lane. From a folder outside it, the command answers that the folder is in no
lane's workspace; `orrery <command> <Lane>` in a shell still works.

`orrery compactor` tests the model with one call, using Orrery's own logins, before it switches. If the model is switched
while a Claude Code session records the lane, that session's recorder applies it, and the command waits up to 10 seconds for it. While pi holds the
lane, use `/compactor` in pi.

## Memory tools

The model gets `zoom`, `date` and `search` (named `mcp__plugin_orrery_orrery__…`), plus `lanes` and `lane_memory` for
readers like Birch. They read snapshots of the lane's memory. Outside a lane they list no tools.

## One writer

A lane records in one place at a time.

- Claude Code in a lane that pi (or another Claude Code) holds runs read-only, and says so. It still loads the view and
  has the memory tools, but nothing it says is recorded.
- While pi holds the lane, a Claude Code session is read-only. While a Claude Code session records, pi runs without
  memory and warns that the lane is open in Claude Code (a second pi's warning says "already open in another pi").
- After a session ends, its recorder finishes the summaries for up to 10 minutes. A new session, or pi, opened meanwhile
  takes the lane over at once.

## The guard

Claude Code's tool calls in a lane folder get pi's rules. A credential file is refused through any tool, in reads
as well as writes (`~/.ssh`, credential stores, `~/.claude/.credentials.json`, `~/.claude.json`, Orrery's
`credentials.json`). Other files in Orrery's data folder, such as another lane's `memory.sqlite`, can be read, as in pi, and writes stay inside the workspace and its `allowed_roots`.

Claude Code's own per-user state stays writable, and only this:

- this project's folder under `~/.claude/projects/` (auto memory);
- `~/.claude/plans/`;
- Claude Code's scratch folder, `$CLAUDE_CODE_TMPDIR/claude-<uid>/`, else `$TMPDIR/claude-<uid>/` (`/tmp/claude-<uid>/` when neither is set), if it exists.

The guard runs before every tool. A hook that crashes does not block. It is a seatbelt, not a sandbox. Its known limits:

- Tools the guard does not know are judged by heuristics: path-like keys (`path`, `file`, `dir`, `source`, …),
  destination keys (`out_dir`, `output`, `dest`, `target`, `save_path`), write verbs in the tool's name, and strings
  that start like a path. A tool that names a file under another key, or writes without a verb or a destination key, is
  not confined to the lane.
- What a tool writes (`content`, `new_source`, `old_string`, `new_string`) is never read as a path, so an MCP tool that
  takes a path under one of those keys is unchecked.
- Text that spans lines, or is over 4,096 characters once normalized, is treated as text. A tool that pulls a path out
  of such text is unchecked.
- A one-line text value that starts like a path and names a credential file is refused, even in a tool that only sends
  text.
- `target` and `output` are destinations in every tool, so an absolute value outside the lane is refused. A copy or move
  tool named for writing has its source outside the lane refused.
- Bash and MCP writes are confined only by those heuristics (pattern checks on command lines, tool-name verbs and
  path-like keys). Obfuscated spellings (`~/.ss''h`, `~/.claude.j*n`) get through, and Bash can write anywhere, as in pi.
- `/proc/self` and `/dev/fd` paths name the hook's process, not Claude Code's.
- Auto memory for a worktree, or for a lane in a repo's subfolder, is not writable: it lives under the git root's
  folder. `CLAUDE_CONFIG_DIR`, `autoMemoryDirectory`, `plansDirectory` and `TMP`/`TEMP` are not followed for writes, so
  those writes are refused.
- Project folders collide the way Claude Code's own folders do (`/a-b` and `/a/b` share one).
- One call is checked for about 2 seconds at most. A call that names more paths than that, or whose paths take longer
  to check, is refused. So is a command line, Grep glob or Glob pattern over 64 KB, and a hook input over 1 MB (a
  single `Write` over 1 MB included). The 1 MB rule holds even outside a lane when `CLAUDE_PROJECT_DIR` is unset;
  Claude Code always sets it for hooks.
- A filesystem call that blocks (a hung network mount, a macOS automount such as `/net/<host>`) can still hold the hook
  past Claude Code's timeout, and that call then runs unchecked.

## Files

- `<workspace>/.orrery/view.md`, the memory view (mode 0600);
- `CLAUDE.md` or `CLAUDE.local.md`, with the two import lines;
- `<lane data>/claude/`: the spool, `holder.json`, `setup.json` (the marker) and `holder.log`, which holds no message
  text;
- `<lane data>/status.json`, which `orrery status` reads;
- `<lane data>/memory.html`, from `/orrery:browse`.

## Troubleshooting

- "did not answer": read `holder.log`.
- "read-only": the lane is open in pi or another Claude Code. `orrery status` shows it.
- "not set up for Claude Code here": run `orrery claude-setup <Lane>`, then start a new session.
- No view: run `orrery claude-setup <Lane>`, and start Claude Code at the lane's root.
- "git cannot answer" or ".orrery/ is visible to git": fix the repo (ignore `.orrery/`, untrack it), then rerun setup.
- Summaries failing: check `orrery login`.
- `/orrery:compactor` in a lane pi holds: use `/compactor` in pi.

## Testing

- `npm test` covers the hooks, the holder, the guard, the MCP server and the pi/Claude Code cross-tool check
  (`test/claude/cross-tool.test.ts`: one lane opened in pi, then in Claude Code through the hook CLI, keeps one memory,
  and the second agent runs without recording while the first holds the lane), all without Claude.
- `scripts/claude-e2e.sh` is the real `claude -p` run. It costs usage (about a dozen short sessions), so run it after
  changes to the hooks or the plugin, or after a Claude Code update. It works on a temp lane with made-up content, runs
  Claude Code on a temp `HOME` whose `.claude` links to yours (for the login), leaves out your settings
  (`--setting-sources project,local`) and loads the plugin with `--plugin-dir`. If the plugin is installed, it stops:
  uninstall it for the run. Each check prints `PASS` or `FAIL`, and `INFO` lines say what each session answered and
  what `.` was.
- Through that link, a run writes Claude Code's usual per-session files into your `~/.claude`: the temp project's
  transcript folder, `session-env/<session>` and, the first time, `plugins/data/orrery-inline`. Its cleanup removes
  only its own: the folders named for its session ids or its temp folder, and `plugins/data/orrery-inline` when the
  run made it and it is still empty. Like any session, Claude Code may also tidy its shared caches there.
- In `claude -p`, Claude Code did not load even an unfenced `@~/…` import from `CLAUDE.md`, so the run's
  `@~/.ssh/config` canary is not live there; the `@canary.md` canary inside the workspace is.

## Limits

- The view is 64–128 KB, about 22K–44K tokens per session.
- The view is per session: it is read once at the start. Not yet checked (for the next manual end-to-end run):
  whether a running session gets the recorder's later rewrites of `view.md` as "file changed" notes, as `--resume`
  does.
- Hooks that fail don't block the session; they say so, or say nothing.
- Claude Code changes fast; the plugin is written against its current hooks and plugin format.
- `orrery usage` shows only summary tokens for Claude Code sessions, not the session's own.
- Events left by a crash are recorded by the next Claude Code session of the lane.

For launching this tool through Ori, see [Ori](ori.md).
