# Agents in Claude Code

An agent can run in Claude Code as well as in pi, on the same memory (`~/.orrery/agents/<Name>/`). Monday in
pi and Tuesday in Claude Code are one memory. Claude's subscription covers Claude Code, not pi.

## Install, once per machine

Or run `orrery`, open Tools (4), select Claude Code and press `I` (`orrery tools install claude-code`).

1. Orrery itself, as in the README's Quick start: it installs the `orrery` command, wires the plugin from
   `~/.orrery/app/current` once you say yes, and needs `~/.orrery/config.toml` (the first `orrery` run writes it).
2. A login for summaries. Summaries run in the background on Orrery's own login, not Claude's. Run
   `orrery login openai` (Sign in with ChatGPT) for the agents' `compactor_model`.
3. The plugin: the installer wires this after asking (`orrery setup` redoes it). If you must do it by hand, add the installed copy, never a
   checkout (that would move the plugin off `app/current`):

   ```bash
   claude plugin marketplace add ~/.orrery/app/current
   claude plugin install orrery@orrery
   ```

Run setup commands that name the installed app folder in your own terminal: the guard refuses them to an agent's tools
(see [The guard](#the-guard)).

The plugin is installed for every folder. Which agent a Claude Code session is gets decided when it starts, in this
order:

1. `ORRERY_AGENT`, when it names a configured agent. `orrery agent <Name>` sets it, with a one-time token
   (`ORRERY_AGENT_TOKEN`) that the first Claude Code process claims, so a tool the agent starts itself, which inherits
   both variables, is not the agent too. A name that is not configured gives a notice and no memory.
2. The agent whose default folder holds the project folder, so `cd <folder> && claude` still works.
3. None: Claude Code runs without recording. No recorder starts, nothing is kept, and the memory stays free for pi.
   The first line the model gets says so, and so does a message to you. The guard still applies there.

A Claude Code started from inside any agent's session (a `claude -p` from an agent's shell, in its folder or another
agent's) opens no memory and records nothing, and says so: `Orrery: started inside Atlas's session (pi), so this one
opens no memory and records nothing.` The guard stays on with that agent's rules (both agents' rules, in another
agent's folder). Its prompts are the agent's, not yours.

A picked agent records only where it is set up (below): in its default folder after `orrery claude-setup <Name>`, or
in any folder after `orrery claude-setup <Name> --mod`.

The plugin runs `~/.local/bin/orrery`, so it uses the installed version (`~/.orrery/app/current`) and this
machine's Orrery. After `orrery update`, new hook processes use the new
version at once, while a running session's own recorder keeps the old one until the session restarts; the next hook
tells you once, "Orrery was updated to 0.6.2; restart this session to use it." When a newer release is out, a hook
says once "Orrery 0.6.2 is available. Run `orrery update`, then restart this session." Hooks never ask the network: the
recorder makes the daily check in the background (README, Updating and uninstalling), and a later hook shows its
answer. Both notices are messages to you, not the model. Without that
launcher the hooks do nothing: they exit quietly and print nothing. Claude Code then lists the `orrery` MCP server as failed to connect.

**Sessions open across the update to 0.9.0.** The update says `Restart open agent sessions now: sessions left open
across the update aren't recorded until they restart.` Restart them. Until then:

- a session opened with `orrery agent <Name>` (it has a launch token) keeps recording through the previous version's
  recorder, without the transcript check, until its next session start;
- a session the folder picked, or one started with `ORRERY_AGENT` but no token, stops recording, and says so once at
  a prompt or a turn's end: `Orrery was updated while this session was open; restart it to keep recording.`

After a change to `claude-plugin/` itself, bump `version` in `claude-plugin/.claude-plugin/plugin.json` (a fixed
version can keep a cached copy), then refresh the copy Claude Code installed. `claude plugin update orrery@orrery`
may do it in one step; otherwise:

```bash
claude plugin marketplace update orrery
claude plugin uninstall orrery@orrery
claude plugin install orrery@orrery
```

## Opening an agent

```bash
orrery agent <Name>                       # in the current folder
orrery agent <Name> -- <claude arguments>
```

`orrery agent` checks that Claude Code is installed and wired and that the agent is free (or can be taken over), then
starts `claude` here with `ORRERY_AGENT` set. The TUI does the same from the Agents page (Enter or `L`), and asks first
whether to open the agent here or in its default folder. The agent's `tool` setting picks Claude Code; `--tool
claude-code` picks it for one session.

Two cases are refused, with the reason and the fix:

- **Outside the agent's default folder without the mod.** The file setup works in the agent's default folder only
  (`orrery claude-setup <Name>` needs a `folder` in the config). Anywhere else, only the Orrery mod brings the memory
  and instructions into Claude Code: `orrery claude-setup <Name> --mod` (Claude Code 2.1.287 or newer).
- **A folder that another agent holds the file way.** In another agent's default folder, or inside it, the
  `CLAUDE.md` or `CLAUDE.local.md` that `claude-setup` wrote loads that agent's memory view into every Claude Code
  session there, and Claude Code loads the files of every ancestor folder too. Two agents would share one prompt, so
  `orrery agent` refuses and says to open the agent in another folder. The plugin refuses such a session as well.

### The desktop app

The Claude Code desktop app runs its own copy of Claude Code on your machine, with the same plugins, so an agent
set up the file way works there: run `orrery claude-setup <Name>` once, then start a session in the agent's default
folder. The app's sessions record into the agent and load its memory like terminal ones. Checked with the Linux app
and the Claude Code it bundles (2.1.299): a session recorded, and a new session recalled it after the first chat
was deleted.

- `orrery agent <Name>` starts Claude Code in a terminal, not in the app, so an agent without a default folder
  can't be opened from the app.
- Orrery's status line and its notices did not show in the app.
- The mod (`--mod`) is not yet checked in the app.
- Claude Code on the web runs in the cloud and can't reach the memory on your machine.

## Set up an agent, once

Opening a Claude Code agent from the TUI (`L`) offers this setup the first time.

```bash
orrery claude-setup <Name>
```

This is the file setup. It works in the agent's default folder only, and stops with a message when the agent has no
`folder`.

- An agent folder of its own gets `CLAUDE.md` with `@AGENTS.md` and `@.orrery/view.md`.
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
  names (`git rev-parse --git-path info/exclude`). For an agent in a repo's subfolder, or in a worktree, that is the
  main repository's, outside the folder, and setup uses it.
- In a git folder, `.orrery/` must be invisible to git, because the view holds your messages. Setup refuses when
  `.orrery/` is tracked, is not ignored (a repo's own `.gitignore` can undo `.git/info/exclude`, for example with
  `!.orrery/`), or is spelled differently by the repo (a case variant). Fix the repo, then run setup again. Setup
  runs git itself, never through a shell string.
- After a good setup it writes a trusted marker in the agent's data folder (`claude/setup.json`). The view is written
  only where that marker exists, so a repo cannot make Orrery start writing into it. Setup is the only way a folder
  starts receiving the view.
- It is safe to rerun.

In the file setup, `.orrery/view.md` holds the agent's instructions first (up to 32 KB), then its memory. Elsewhere,
only the Orrery mod brings them.

Moving an agent over (the spec's section 6):

1. close it in pi, OMP, Codex or OpenCode;
2. run `orrery claude-setup <Name>` (or add `--mod`);
3. `orrery agent <Name>`, or `cd <agent folder> && claude` for the file setup.

Only agents where `claude-setup` ran record in Claude Code. In the others the guard still applies, and memory is not
touched. The agent can go back to pi later.

## Mod mode

With Claude Code 2.1.287 or newer and the Orrery plugin 0.3.0, an agent can get its instructions and memory from the
Orrery mod instead of the view file:

    orrery claude-setup <Name> --mod

- **Instructions and view go in the system prompt.** The mod adds them when the session starts: the agent's
  `instructions.md` first (up to 32 KB; more is cut, with a notice), then the memory view, which it refreshes at each
  compaction. A session picks up changed instructions at its next start. The `@.orrery/view.md` line is removed from
  CLAUDE.local.md, and from CLAUDE.md where Orrery wrote it (a folder that is not a git repo). A committed CLAUDE.md in
  a git repo keeps its line, and the command says so. `.orrery/view.md` is deleted (unless git tracks it);
  `@AGENTS.md` stays.
- **Any folder.** The mod needs no file in the folder, so `orrery agent <Name>` works anywhere; the folder's own
  `AGENTS.md` and `CLAUDE.md` load as the project's rules.
- **Orrery answers compaction.** `/compact`, Claude Code's own automatic compaction, and the mod's keep the last turn
  (its prompt, tool calls and reply) and refresh the view, with no model call. It waits up to 30 s for the summaries of
  the turns just recorded. After an Orrery compaction the kept last turn carries its text and tool calls, not images,
  the model's thinking or attachments. A turn kept in the middle of its tool loop (Claude Code's own threshold, or an
  Esc there) keeps everything, and its memory section can then stay stale until the next compaction.
- **The conversation compacts itself** once it passes the agent's `compact_at` (default 200,000 tokens, at least
  100,000): `orrery agent set <Name> --compact-at 150000`, or the TUI's `C`. Only interactive sessions; `claude -p`
  compacts at `/compact` and Claude Code's own threshold. If a compaction the mod started cannot be answered, the
  conversation stays as it is and the mod starts no more in that session; when only the last turn was too large to
  keep, it tries again after a later turn.
- **Fallbacks.** When the view cannot be read, the agent has no memory yet, or the last turn alone is over half of
  `compact_at`, Claude Code compacts its own way and one line says why. If the mod is not loaded at all (an older
  Claude Code, or mods turned off), the session runs without the memory view and the model is told to say so.
- **A session that is not recorded** (read-only, another window on the agent) compacts the Claude Code way: its older
  turns are not all in memory.
- **Recording, the guard and the one-writer rule are unchanged.**
- **Switching back:** plain `orrery claude-setup <Name>` puts the view file and its import line back (in CLAUDE.md for
  a folder that is not a git repo, CLAUDE.local.md in a repo). It works in the agent's default folder only, and from
  then on `orrery agent` refuses to open the agent elsewhere in Claude Code. Either switch takes effect at the next
  session start. Before going back to an older Orrery version, run plain `orrery claude-setup <Name>`: older versions
  do not know mod mode and stop recording the agent.
- After a compaction Claude Code does not list its deferred tools again; the memory section tells the model to load
  `zoom`, `date` and `search` with ToolSearch when they are not listed.

What you see in a mod-mode session: until your first prompt, a band above the prompt shows the Orrery logo with `Orrery ·
<Name>` and the agent's state (`memory loaded · N msgs · recording`, `no memory yet`, or `read-only (another window
records this agent)`); a narrow or short window shows the two lines without the logo (the logo needs the band to be 60
columns wide, which is the terminal less Claude Code's margin, and 5 rows tall), as do surfaces other than the
terminal. `Orrery · <Name> · N msgs`, as pi's status line reads, stays among the mode labels at the right of the
prompt footer for the whole session; the count moves after each turn, once the turn has reached memory (in a
read-only window, when the recording window's turns have landed and this window ends a turn). In a narrow window
Claude Code puts the mode labels on a line of their own under the footer. After a
`/compact`, Claude Code's own `Compacted (ctrl+o to see full summary)` row is followed by Orrery's line: `Orrery
compacted: kept the last turn …`, or why Claude Code compacted its own way. A compaction the mod started, or Claude
Code's automatic one, logs the same line once it is done. Agents not in mod mode, and sessions that are no agent's,
show none of this.

## Bring an agent's history

The easiest way is the TUI: on the Agents page press `N`, then "From an existing chat". It lists every Claude Code and
Codex chat, newest first, and marks one written to in the last ten minutes "in use". Pick one or several, name the
agent, choose the tool it continues in and its summary model, and review a short report before anything is written.
The import is a snapshot: the source chats are only read, never changed, and anything said in them afterwards is not in
the agent. Its memory builds in the background, and you can open the agent once that is done.

From a shell, note that Claude Code files a session under the project folder it started in. An agent whose past lives
under another project can be imported by naming those files, with the agent's own folder skipped:

```bash
orrery import Rowan --dry-run --claude none \
  --claude-file ~/.claude/projects/-home-alex-code-sample-project/<session>.jsonl \
  --claude-file ~/.claude/projects/-home-alex-code-sample-project/<other-session>.jsonl
```

The dry run prints progress lines as it works. Claude Code deletes its session files after 30 days by default, so
import early, or raise `cleanupPeriodDays` in `~/.claude/settings.json`.

Review the report, then `orrery import Rowan --commit <out>/preview.jsonl`, then `orrery compact Rowan`, with Rowan
closed everywhere. Do it before the agent's first Claude Code session. A file that is missing, or is no Claude
Code session, stops the import before anything is written. A record that appears in two files (a resumed session)
is imported once.

## Daily use

Open the agent with `orrery agent <Name>`, or start Claude Code at the root of its default folder.

- The first line the model gets is `orrery · <Name> · N msgs · recording`, or `read-only: this session is not
  recorded`, `not recording yet` (the recorder did not answer in time), `not set up for Claude Code here, so this
  session is not recorded` (run `orrery claude-setup <Name>`), or `no memory yet` in place of the message count. When
  something is off, the line after it says why: the agent is open elsewhere (it names the tool), the recorder did not
  answer, `CLAUDE.md` does not load the view, or git is the problem (below).
- Memory keeps your prompts and each turn's final reply. Tool calls, tool output, thinking, subagents' own turns and
  slash commands are not kept. The reply to one of Orrery's own commands (`/orrery:memory`, `/orrery:compactor`,
  `/orrery:browse`) is not kept either, as in pi. The reply to any other slash command or skill is real work, so it is
  kept, without the command.
- A prompt is kept only once Claude Code's own transcript shows it as yours: typed, queued while a turn runs, or given
  to `claude -p` (checked with Claude Code 2.1.302). A message another process sent into the session, such as a
  subagent's report (anything sent to the session's inbox, the agent's own shell included), is kept as
  `[subagent] …`, never as your words, and a task notification is dropped. A prompt the transcript never confirms
  (within 30 seconds of its turn's end) is dropped, and `orrery status` counts it: `N unconfirmed messages not
  recorded`.
- Orrery records only when Claude Code itself calls its hooks, which the compiled `orrery` program checks (the other
  end of the hook's input must be the Claude Code process). Where it can't check, the session says why and is not
  recorded: `Orrery can't check who calls its hooks here (it runs under Node, not its own binary), so this session
  isn't recorded.` The other reasons are a system Orrery doesn't know and a C library that won't load; without `/proc`
  on Linux, Orrery can't read the transcript and says so. If a Claude Code version stops handing its hooks what Orrery
  checks, recording stops with `Orrery: can't confirm prompts in this Claude Code version, so this session isn't
  recorded.`, never silently. Running Orrery from a checkout (`src/cli/main.ts` under Node) therefore records nothing
  in Claude Code; `npm run install-local` installs a compiled one ([CONTRIBUTING.md](../CONTRIBUTING.md)).
- The view loads when a session starts. A long session runs on the view it started with plus its own transcript.
  Start a fresh session (or `--resume`) to pick up a newer view. If a session was started by another agent, or in
  another agent's folder, and this agent resumes it, recording starts at its tail: the other agent's turns are not
  copied.
- If git cannot answer whether `.orrery/` is ignored (git missing, a broken repo, a timeout), the view is taken out of
  the folder until git can answer again. The session that takes it out says so at the start; the next write that
  passes the check puts it back silently.
- If `.orrery/` becomes visible to git after setup, SessionStart removes the marker and the view and says why. That
  session, and every later one, is not recorded until you fix the repo and run `orrery claude-setup <Name>` again.
- Claude Code also loads your claude.ai connectors. One that needs authorization can make the model add a note like
  "…connectors won't work until you authorize them" to its replies, and those replies are memory. Authorize or remove
  those connectors on claude.ai. In Claude Code 2.1.291 (seen in its binary), `ENABLE_CLAUDEAI_MCP_SERVERS=0` in the
  environment also stops it loading them.
- When an agent's summaries start failing or stop, you get a one-line notice (once, and once more when they recover)
  saying which source and why, for example "the OpenRouter account has no balance". It is shown to you, not to the
  model, so it never enters memory. Summaries keep retrying; switch the source with `/orrery:compactor`.
- An agent whose summaries use an OpenCode model (`opencode/…`, chosen in OpenCode) records in Claude Code, but its
  summaries wait until it is open in OpenCode again; a notice says so, and `/orrery:compactor` switches to another
  model.
- Claude Code's own compaction stays on.

## Commands

- `/orrery:memory` runs `orrery status .` and `orrery usage .`.
- `/orrery:compactor` shows the summary model and the sources: Sign in (`openai`), API key (`openai`, `anthropic`,
  `openrouter`) and Local (only when configured), with what is saved. `/orrery:compactor key openrouter haiku` lists
  matching models with prices; `/orrery:compactor key openrouter/<model> [thinking]` switches after one test call (a
  failure keeps the current model and says why); `reset` goes back to the config's model. Keys are saved from your own
  terminal only (`orrery login --key …`), never in chat, and inside the session the command starts no new sign-in.
  The choice is shared with pi's `/compactor`. The plugin grants only `orrery-run compactor` to this command, and only
  you can start it; a
  command with `;`, `|` or `$(...)` in what you typed is meant to fall outside that grant. In the end-to-end run under
  `--permission-mode default` (Claude Code 2.1.291), Claude Code's permission check stopped
  `/orrery:compactor x $(touch …)` and `/orrery:compactor x; touch …` before anything ran. Its reasons were "A nested
  command in this command can't be checked before it runs" for the first; for the second, the `touch` "needs
  approval" because its path was outside the session's working folders. The skill was loaded, the `touch` never
  happened, Orrery was not called, no model turn ran, and nothing entered memory. `claude -p` shows that message only
  in its `stream-json` output, not as an answer. The message ends "Allowing runs the command as written", which
  suggests an interactive session asks you instead; that, a target inside the folder, and other permission modes
  were not checked. The three commands with plain arguments ran with no prompt.
- `/orrery:browse` writes the memory explorer to `memory.html` in the agent's data folder and opens it.

These commands are for you: the model cannot start them. They run inside the agent's session, which lets `orrery` run
only `status`, `usage`, `browse` (no `--out`) and `compactor`, as that agent (README, Safety). In your own terminal the
same commands, and the ones below that change settings, take the agent's name:

```bash
orrery status [<Name>]
orrery compactor <Name> [signin|key|local [name [words] | name/model [thinking]] | provider/id [thinking] | reset]
orrery browse <Name> --open
orrery claude-setup <Name> --mod                  # switch an agent to mod mode; plain claude-setup switches back
orrery agent set <Name> --compact-at TOKENS       # where the mod compacts (at least 100000)
orrery claude-mod view --cwd DIR [--session ID] [--agent NAME [--agent-token T]] [--wait-ms N [--spool-only]]   # the mod's own call: the agent's memory section as JSON
```

In the plugin's commands, `.` is the session's agent, as Orrery recorded it when the session opened, wherever a `cd`
in the Bash tool has moved its shell since. The same goes for `orrery status .` that the model, or a `!` command you
type, runs there; `claude-setup`, `agent set` and every other command that changes something are refused inside the
session, so run those in another terminal. In a session that is no agent's, `.` is the folder of the Bash tool's shell
(Claude Code gives these commands no `CLAUDE_PROJECT_DIR`): with `ORRERY_AGENT` set, that agent; otherwise any folder
inside an agent's default folder names it. From a folder outside every agent's folder, the command answers that the
folder is in no agent's folder; `orrery <command> <Name>` in a shell still works.

`orrery compactor` tests the model with one call, using Orrery's own logins, before it switches. If the model is switched
while a Claude Code session records the agent, that session's recorder applies it, and the command waits up to 10 seconds for it. While pi holds the
agent, use `/compactor` in pi.

## Memory tools

The model gets `zoom`, `date` and `search` (named `mcp__plugin_orrery_orrery__…`), plus `agents` and `agent_memory` for
readers like Birch. They read snapshots of the agent's memory. In a session that is no agent's they list no tools.

## One writer

An agent records in one place at a time.

- Claude Code on an agent that pi, OMP, Codex, OpenCode or another Claude Code session holds runs read-only, and says
  which. It still loads the view and has the memory tools, but nothing it says is recorded.
- While pi holds the agent, a Claude Code session is read-only. While a Claude Code session records, pi runs without
  memory and warns that the agent is open in Claude Code (a second pi's warning says "already open in another pi").
- After a session ends, its recorder finishes the summaries for up to 10 minutes. A new session, or pi, opened meanwhile
  takes the agent over at once.

## The guard

Claude Code's tool calls in an agent's session get pi's rules. A credential file is refused through any tool, in reads
as well as writes (`~/.ssh`, credential stores, `~/.claude/.credentials.json`, `~/.claude.json`, Orrery's
`credentials.json`). So is Orrery's data folder, except reading the installed program (`app/`) and `config.toml`. The
config and the installed program are read-only to agents: no tool may change either. An agent's memory view
(`.orrery/view.md` in its folder) is read only by that agent's own sessions; every other agent's file tools and content
searches are refused it, by their path or a symbolic link to it (a hard link is not caught). Writes stay inside the folder the agent was opened in and its
`allowed_roots`. Setup commands that name the installed app folder (the plugin install above, for one) are refused to
agents, so run them in your own terminal.

Shell text that runs Orrery's hook plumbing is refused too: the hook commands (`claude-hook`, `codex-hook`) named
anywhere, or Orrery's program with the word `holder`. An agent that ran a hook by hand could feed it made-up input and
put words in your mouth in its own memory. The cost: a Bash command that only names them is refused as well, such as
`grep -r claude-hook src/` or a `git commit -m` whose message names one; the Grep tool's pattern is not read this way.
A name built at run time still gets through.

The same goes for Orrery's commands that agents may not run (all but `help`, `--version`, `status`, `usage`, `browse`
and `compactor`; README, Safety): a Bash command that runs `orrery` or the plugin's `orrery-run` with one of them is
refused before it runs (`orrery remote can't run from an agent's shell: …`), and so is one that only names it, such as
`grep -r "orrery restore" src/` or a `git commit -m` that mentions `orrery setup`. Use the Grep tool, and
`git commit -F <file>`. The CLI refuses them inside the session too, for a name the guard can't see.

Claude Code's transcripts are what Orrery checks prompts against, so no tool may change them, and neither may it
change Codex's session files: Write, Edit and the rest are refused anywhere under `~/.claude/projects/` (or
`$CLAUDE_CONFIG_DIR/projects`), `~/.codex/sessions` and `~/.codex/archived_sessions` (or under `$CODEX_HOME`), but
this project's auto-memory folder. Read, Grep and Glob may read them; a Bash command that names one of those folders is
refused, whatever it does (`ls ~/.claude/projects`, and globs that could name one, such as `ls ~/.claude/*`).

OpenCode's config and code are read-only to agents, as in every tool: no tool writes `opencode.json` or
`opencode.jsonc` in any folder, a `.opencode` folder, OpenCode's own config, cache and state folders, its database, or
its system config. OpenCode loads plugins, runs commands and takes permissions from them, with no prompt, the next time
it opens that folder. Read, Grep and Glob may read them; a Bash command that names one is refused, whatever it does.

Skills in `.claude/skills` and `.agents/skills` (Claude Code's own skills folders, which OpenCode loads too) stay
writable with Write, Edit and MultiEdit: a Write is judged by its content, an edit by the file it would leave (the file
must be readable, and hold each old text). A skill that would open with `---` and anything other than YAML or JSON
(`---js`, which OpenCode runs as code) is refused, and so is an edit that adds such a line anywhere in it, and a write
whose result the guard can't see: a NotebookEdit, a copy or move into a skills folder, an MCP or other tool that
writes there. A Bash command that names a skills folder is refused, whatever it does (`ls ~/.claude/skills`, `git add
.claude/skills`): use Read, Glob, Grep, Write and Edit. The cost: a Bash command that only names those files or
folders (a `grep`, a commit message) is refused too, and an agent can't set up OpenCode for a project; you do that
yourself. `.claude/settings.json` and `AGENTS.md` stay writable.

Tool logins in your home folder are refused the same way: `~/.npmrc`, `~/.pypirc`, `~/.cargo/credentials`,
`~/.gem/credentials`, `~/.config/gcloud`, `~/.azure`, `~/.terraform.d/credentials.tfrc.json`, `~/.wrangler`,
`~/.config/.wrangler` (`~/Library/Preferences/.wrangler` on macOS), `~/.cache/huggingface/token` and `stored_tokens`,
`~/.huggingface/token`, `~/.password-store` and `~/.config/op`. A project's own `.npmrc`, `.pypirc`, `.azure` or `.wrangler` stays open; Bash is refused those four only when it names
them from home (`~/.npmrc`, `$HOME/.npmrc`, the home folder's path).

Secret files in any folder are refused too, so agents neither read nor edit them: `.env` and `.env.<anything>`,
`.dev.vars` and `.dev.vars.<anything>`, `.secrets`, `secrets.toml`, `master.key` and `.htpasswd` (the shared templates,
`.example`, `.sample`, `.template` and `.dist` after `.env` or `.dev.vars`, stay open). So is everything `[guard]
protect` lists in the config: a path (`/…` or `~/…`, a file or a folder) or a name (every file or folder so named); new
configs have it with examples, and setup adds it once to an older one; see the [README](../README.md#safety). Its
refusals say `protected by [guard] protect in Orrery's config`.

Claude Code's own per-user state stays writable, and only this:

- this project's auto-memory folder, `~/.claude/projects/<project>/memory/` (the transcripts beside it are not);
- `~/.claude/plans/`;
- Claude Code's scratch folder, `$CLAUDE_CODE_TMPDIR/claude-<uid>/`, else `$TMPDIR/claude-<uid>/` (`/tmp/claude-<uid>/` when neither is set), if it exists.

The guard runs before every tool. A hook that crashes does not block. It is a seatbelt, not a sandbox. Its known limits:

- **A search of a folder can still read a `.env` inside it**, or another of those secret files, or a file a protected
  name covers: only a protected path and the tool logins under home are checked against a Grep's folder. A command over a folder that holds a protected path (`tar`, `grep -r`) is not
  refused either, and a command that has a protected name as a word is refused even when it means something else
  (`git commit -m "ignore .env"`).
- The shell-text rules read a command's text, not what it does. Shell commands that name an `.orrery` folder or a
  custom `ORRERY_CONFIG` file by a path the guard can read are refused, but known limits include variables, `eval`, `cd`, escape codes, brace names split across words, commands that change folder with their own flag (`git -C`, `tar -C`), a swap of the session's own folder in the same command, a shell search of an agent's whole folder, and hard links to a protected file, and a relative path or a link to the config.
- Tools the guard does not know are judged by heuristics: path-like keys (`path`, `file`, `dir`, `source`, …),
  destination keys (`out_dir`, `output`, `dest`, `target`, `save_path`), write verbs in the tool's name, and strings
  that start like a path. A tool that names a file under another key, or writes without a verb or a destination key, is
  not confined to the agent's folder.
- A tool the guard does not know, named neither for writing nor only for reading (`read`, `get`, `list`, `search`, …),
  is refused when any string it carries outside what it writes may name a skill or OpenCode's config or code, even a
  one-word value such as `opencode.json`: the guard can't tell whether it only reads. Claude Code's own LSP tool is
  one, so an LSP call on a skill or on OpenCode's config is refused; Read, Grep and Glob read them.
- What a tool writes (`content`, `new_source`, `old_string`, `new_string`) is never read as a path, so an MCP tool that
  takes a path under one of those keys is unchecked.
- Text that spans lines, or is over 4,096 characters once normalized, is treated as text. A tool that pulls a path out
  of such text is unchecked.
- A one-line text value that starts like a path and names a credential file is refused, even in a tool that only sends
  text.
- `target` and `output` are destinations in every tool, so an absolute value outside the folder is refused. A copy or move
  tool named for writing has its source outside the folder refused.
- Bash and MCP writes are confined only by those heuristics (pattern checks on command lines, tool-name verbs and
  path-like keys). Obfuscated spellings (`~/.ss''h`, `~/.claude.j*n`) get through, and Bash can write anywhere, as in pi.
- `/proc/self` and `/dev/fd` paths name the hook's process, not Claude Code's.
- Auto memory for a worktree, or for an agent in a repo's subfolder, is not writable: it lives under the git root's
  folder. `CLAUDE_CONFIG_DIR`, `autoMemoryDirectory`, `plansDirectory` and `TMP`/`TEMP` are not followed for writes, so
  those writes are refused.
- Project folders collide the way Claude Code's own folders do (`/a-b` and `/a/b` share one).
- One call is checked for about 2 seconds at most. A call that names more paths than that, or whose paths take longer
  to check, is refused. So is a command line, Grep glob or Glob pattern over 64 KB, and a hook input over 1 MB (a
  single `Write` over 1 MB included). The 1 MB rule holds even outside an agent's folder when `CLAUDE_PROJECT_DIR` is
  unset; Claude Code always sets it for hooks.
- A filesystem call that blocks (a hung network mount, a macOS automount such as `/net/<host>`) can still hold the hook
  past Claude Code's timeout, and that call then runs unchecked.

## Files

- `<folder>/.orrery/view.md`, the instructions and memory view (mode 0600; file setup only);
- `CLAUDE.md` or `CLAUDE.local.md`, with the two import lines (file setup only);
- `<agent data>/instructions.md`, the agent's instructions;
- `<agent data>/claude/`: the spool, `holder.json` (with the recorder's version), `setup.json` (the marker),
  `holder.log`, which holds no message text, and `update-notices.json`, which update notices each session has heard;
- `update-check.json` in Orrery's home: the daily update check's answer, shared by the TUI and every session;
- `<agent data>/claims/`: which process has claimed `ORRERY_AGENT_TOKEN`. A claim is written whole and published with a
  hard link, or with an exclusive create where the filesystem has no hard links;
- `<data>/claude-processes/`: each Claude Code process's pick, so a session keeps the agent it started with;
- `<data>/session-hosts/`: the Claude Code process of each open agent session (as every tool records its own), so
  `orrery` knows a command run inside it;
- `<agent data>/claude/unconfirmed.json`: how many prompts the transcript never confirmed (a count, no words);
- `<agent data>/status.json`, which `orrery status` reads;
- `<agent data>/memory.html`, from `/orrery:browse`.

## Troubleshooting

- "did not answer": read `holder.log`.
- "read-only": the agent is open in the tool the notice names (pi, OMP, Codex, OpenCode or another Claude Code session).
  `orrery status` shows it.
- "not set up for Claude Code here": run `orrery claude-setup <Name>`, then start a new session.
- "open outside its folder, where only the Orrery mod brings its memory": run `orrery claude-setup <Name> --mod`, then
  start a new session.
- No view: run `orrery claude-setup <Name>`, and start Claude Code at the root of the agent's folder.
- "git cannot answer" or ".orrery/ is visible to git": fix the repo (ignore `.orrery/`, untrack it), then rerun setup.
- Summaries failing: check `orrery login`.
- `/orrery:compactor` for an agent pi holds: use `/compactor` in pi.
- "can't check who calls its hooks here" or "can't confirm prompts in this Claude Code version": see Daily use; the
  session is not recorded.
- "Orrery was updated while this session was open; restart it to keep recording.": restart the session (see Install,
  once per machine).
- "unconfirmed messages not recorded" in `orrery status`: prompts the transcript never showed as yours. A prompt whose
  words in the transcript differ from what the hook got is counted there too.
- "can't run inside an agent session" from a `!` command or the model's Bash: run that command in another terminal;
  see the README's [Leftover markers](../README.md#leftover-markers) if it happens in a terminal of your own.

## Testing

- `npm test` covers the hooks, the holder, the guard, the MCP server and the pi/Claude Code cross-tool check
  (`test/claude/cross-tool.test.ts`: one agent opened in pi, then in Claude Code through the hook CLI, keeps one memory,
  and the second tool runs without recording while the first holds the agent), and `test/codex/cross-tool.test.ts` does
  the same with Codex, all without Claude.
- `scripts/claude-e2e.sh` is the real `claude -p` run. It costs usage (about a dozen short sessions), so run it after
  changes to the hooks or the plugin, or after a Claude Code update, from your own terminal (not an agent's shell). It
  works on a temp agent with made-up content, runs Claude Code on a temp `HOME` whose `.claude` links to yours (for
  the login), leaves out your settings (`--setting-sources project,local`) and loads the plugin with `--plugin-dir`.
  The hooks run the compiled program: `ORRERY_E2E_BIN` names one (a built release's `bin/orrery`), else the run builds
  one from the checkout first, with the Bun of `.bun-version`. If the plugin is installed, it stops: uninstall it for
  the run. Besides recording, the view, the memory tools, the guard and the plugin's commands, it checks the agent's
  own shell: `orrery status .` runs there, while `orrery remote key`, `orrery agent set … --reads all`, a browse of an
  agent it may not read and `browse --out` are refused, and nothing changes. Each check prints `PASS` or `FAIL`, and
  `INFO` lines say what each session answered and what `.` was.
- Through that link, a run writes Claude Code's usual per-session files into your `~/.claude`: the temp project's
  transcript folder, `session-env/<session>` and, the first time, `plugins/data/orrery-inline`. Its cleanup removes
  only its own: the folders named for its session ids or its temp folder, and `plugins/data/orrery-inline` when the
  run made it and it is still empty. Like any session, Claude Code may also tidy its shared caches there.
- In `claude -p`, Claude Code did not load even an unfenced `@~/…` import from `CLAUDE.md`, so the run's
  `@~/.ssh/config` canary is not live there; the `@canary.md` canary inside the folder is.

## Limits

- The view is 64–128 KB, about 22K–44K tokens per session.
- The view is per session: it is read once at the start. Not yet checked (for the next manual end-to-end run):
  whether a running session gets the recorder's later rewrites of `view.md` as "file changed" notes, as `--resume`
  does.
- Hooks that fail don't block the session; they say so, or say nothing.
- Claude Code changes fast; the plugin is written against its current hooks and plugin format.
- `orrery usage` shows only summary tokens for Claude Code sessions, not the session's own.
- Events left by a crash are recorded by the next Claude Code session of the agent.
- Three processes racing for one token claim can, rarely, both believe they hold it; with two, exactly one wins.
- A process of yours that appends a line to a Claude Code transcript can fake a prompt; the guard stops an agent's
  tools from naming the transcripts, not a program that builds the path itself. The [architecture
  guide](architecture.md#limits) lists the session rules' limits in full.
- The `/orrery:*` command events are not checked against the transcript: an injected one can only drop the agent's
  own reply.
- Sessions left open across the update to 0.9.0: one opened with `orrery agent` keeps recording without the
  transcript check until its next session start, and the others stop recording until they restart (see Install,
  once per machine).
- On macOS the caller check (`LOCAL_PEERPID`) is not yet verified with a real Claude Code.

For launching this tool through Ori, see [Ori](ori.md).
