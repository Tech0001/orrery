# Agents in Codex

An agent can run in Codex as well as in pi, OMP, Claude Code and OpenCode, on the same memory
(`~/.orrery/agents/<Name>/`). Monday in Claude Code and Tuesday in Codex are one memory. A Codex session of an agent gets the agent's instructions,
its memory view at the start and after each compaction, the memory tools, and Orrery's guard on every tool call, and
each turn is recorded into the agent's memory.

Needs Codex 0.162.1 or later (tested with 0.163.0: `codex --version` says `codex-cli 0.163.0`), whose session files
Orrery reads to confirm what it records (see What's recorded). An older Codex doesn't record who started a turn, so a
session in it is not recorded, and Orrery says so when it starts.

## Install

1. Codex, installed on its own and signed in.
2. Orrery itself, as in the README's Quick start.
3. A login for summaries. Summaries run in the background on Orrery's own login, not Codex's: `orrery login openai`
   (Sign in with ChatGPT, the same account Codex uses, as a separate login), or another source from the README's
   Summaries.

There is nothing to install on Codex's side, and Orrery writes nothing to `~/.codex`: its hooks, its memory server and
the agent's instructions come on Codex's command line at each launch. The Tools page (4) shows Codex as `memory`, with
the version the hook check last verified; `I` installs nothing there.

## Opening an agent

```bash
orrery agent <Name> --tool codex                   # in the current folder
orrery agent <Name> --tool codex -- <codex arguments>
orrery agent set <Name> --tool codex               # Codex from now on: orrery agent <Name>
```

The TUI does the same from the Agents page (Enter or `L`) for an agent whose `tool` is `codex`, and asks first whether
to open it here or in its default folder. Codex opens an agent in any folder, with no setup step per agent; the folder's
own `AGENTS.md` loads as that project's rules.

- What follows `--` goes to Codex: a prompt, `resume --last`, or `exec "…"` for a run without the TUI. Orrery puts its
  flags where Codex applies them to the session: before your arguments, or right after `exec`, `resume`, `fork` or
  `review`, which must then come first. Codex 0.162.1 reads flags given before `exec` but does not apply them to the
  session, so `-- -m <model> exec "…"` is refused, with the order that works: `-- exec -m <model> "…"`. A resumed or
  forked session also stays off Codex's shared background server, as a new one does.
- A plain `codex` is not an agent's session, even in the agent's folder: no memory, no recording, no guard. Opening by
  folder would need Orrery's hooks in `~/.codex`, which Orrery does not write. It gets the command check only: see
  [A plain Codex](#a-plain-codex).
- `orrery agent` refuses an agent whose memory is still being built, and asks before opening an agent that is already
  open elsewhere (a second session is read-only), as for every tool.

Moving an agent over: close it in pi, OMP, Claude Code or OpenCode, then `orrery agent <Name> --tool codex`. It can go
back later.
To turn existing Codex chats into an agent, see the README's Importing chats.

## What happens at launch

1. **The hook check.** Codex skips a hook it does not trust without a word, and how it trusts hooks can change from one
   version to the next. So the first time Orrery opens a Codex version, again after Orrery itself is updated, and until
   a check passes, it asks that Codex whether Orrery's hooks load: Codex's app server lists them, in a scratch Codex
   home, with no model call. It says `Checking that Orrery's hooks load in Codex 0.162.1…` while it does. The answer is
   kept (`codex-check.json` in Orrery's home) and shown on the Tools page.

   If the hooks don't load, Orrery says why and asks `Start Codex without Orrery anyway? The session won't be recorded
   and the guard will be off. (y/N)`. The default is no. Yes starts plain Codex: not as the agent, with no memory, no
   recording and no guard, and with no question about the agent (a second session, or taking over a remote lock).
   Without a terminal it refuses, even with `--yes`: only a person can choose that.
2. **The shell check, at every launch.** Codex runs each hook through a shell: your account's when it is bash, zsh or
   sh, else bash (zsh on macOS); not a login shell, and never `$SHELL` or fish. Such a shell reads only bash's
   `$BASH_ENV` and zsh's `.zshenv`. If one of them prints, Codex cannot read the hooks' answers: the memory view comes
   garbled, the status line doesn't show, and each prompt adds that output to the model's context. Recording and the
   guard still work. Orrery starts that shell once, the way Codex will, names the file that most likely prints, and asks
   `Start Codex anyway?` (default no). See Troubleshooting.
3. **Codex starts** in the folder, with `ORRERY_AGENT` and a one-time `ORRERY_AGENT_TOKEN` that the first Codex process
   claims, so a Codex the agent starts from its own shell is not the agent. (A plain `codex` it starts is no agent's
   session anyway; one given Orrery's flags, inside any agent's session or a coding tool's session that is no agent's,
   opens no memory and records nothing, and says so.) Its command line adds:
   - Orrery's hooks for session start, each prompt, each turn's end, the session's end and every tool call, with the
     trust values Codex expects for them;
   - the `orrery` memory server (MCP);
   - the agent's instructions, as Codex's developer instructions;
   - Codex's own memory feature off, so the agent has one memory;
   - programs that wait for typed input off (`features.unified_exec_tty=false`): ordinary commands run, but a REPL,
     `git add -p` or a password prompt reads end of input at once. Typing into a running command is a step the guard
     never sees, so Orrery turns it off;
   - `--no-daemon`: Codex runs in this process, not in its shared background server, so the hooks get this launch's
     environment.

The instructions travel on Codex's command line, so they show in `ps`, like every argument.

## What's recorded

- Your prompts, and the agent's reply each time a turn ends (a turn that a spawned agent's report wakes again ends
  twice, and both replies are kept). Tool calls, their output, the model's reasoning, and spawned agents' threads are
  not kept. Codex's own commands (`/compact`, `/model`) never reach the hooks.
- Only what Codex's own record of the session confirms. Codex runs its hooks through a pipe, so any program could feed
  Orrery's hook command made-up words; the session's rollout (Codex's session file under `~/.codex/sessions`, found by
  the session's id, never by what the hook says) is the proof:
  - a session counts only when its rollout says it is your own thread (a spawned agent's thread is never recorded)
    and this Codex holds that rollout open;
  - a prompt counts once the rollout has your message for that turn, with the same words, in a turn you started (in
    the TUI or with `codex exec`). A turn another agent started, or one put in from outside (`codex queue`), is not
    yours;
  - a reply counts once the rollout shows the agent wrote those words in that turn.

  What the rollout never confirms is dropped after a grace of 30 seconds, and `orrery status` counts it: `N
  unconfirmed messages not recorded` (`unconfirmedMessages` in `orrery status --json`). A session start that can't be
  confirmed says so and records nothing: `Orrery: can't confirm this is this Codex's own session (…), so it opens no
  memory and records nothing.` A Codex older than 0.162.1 doesn't record who started a turn, so its session isn't
  recorded either: `Orrery: this Codex (<version>) doesn't record who started a turn; Orrery needs Codex 0.162.1 or
  later, so this session isn't recorded.`
- Moving to another session in Codex's window (`/clear`, `/resume`, `/fork`) moves the recording with it: Codex starts
  a turn of the new session first, and Orrery takes the session only then. A session start for another session with
  no turn of it running is refused (`… Codex moves to a session with a turn of it running, and none is …`), and
  nothing changes.
- The hooks only drop each event in a spool; a recorder in the background holds the agent for the session, records the
  spool into memory, runs the summaries, and leaves once the session has ended and the summaries are done (at most 10
  minutes). It is the same recorder Claude Code uses.
- A session is Codex's session: resuming it through `orrery agent <Name> --tool codex -- resume <id>` goes on recording
  it. When Codex ends it prints `codex resume <id>`, which reopens the chat as plain Codex, with no memory and no guard;
  `orrery agent` then prints the line that resumes it as the agent. It prints none when it can't tell which session
  that Codex was on (you quit before a first prompt, say): use `orrery agent <Name> --tool codex -- resume` and pick
  the session from Codex's list.
- One writer: an agent records in one place at a time. A Codex session of an agent that is open elsewhere (pi, OMP,
  Claude Code, OpenCode, or another Codex session) is read-only: it gets the view and the memory tools, but nothing it
  says is recorded, and it says which tool holds the agent. A session that has ended leaves its recorder finishing summaries;
  a new session takes the agent over at once.
- When you send your first prompt (Codex runs the session-start hook then, not when the TUI opens), a hook message
  shows the agent's state: `Orrery · <Name> · N msgs · recording`, or `read-only: this session is not recorded`, `not
  recording yet` (the recorder did not answer in time), or `no memory yet` in place of the count. Summary trouble and
  Orrery's update notices are shown to you the same way, never to the model.

## The memory view

When a session starts (and after `/clear`), Orrery's session-start hook gives the model the status line and the memory
section: how memory works, then the view. It arrives as developer context, after Codex's instructions and the
`AGENTS.md` files, before your first prompt. At resume (and a fork) no new view is added: the resumed history already
holds the one it had.

A long session runs on the view it started with, plus its own transcript; the view is refreshed after each compaction.
Codex keeps everything the model sees in its own session files under `~/.codex/sessions`, so the view is in there too.

## Memory tools

The model gets `zoom`, `date` and `search` from the `orrery` MCP server (`mcp__orrery__zoom`, …), plus `agents` and
`agent_memory` for an agent whose `reads` allows it. They read snapshots of the agent's memory and need no approval.
Some models look their tools up, or call them from code; the memory section tells the model to look for the zoom, date
and search tools when it doesn't see them. The server serves only the agent `ORRERY_AGENT` names, with its token, so a
plain `codex` gets no memory tools.

## Instructions

The agent's `instructions.md` (`E` in the TUI, or `orrery agent edit <Name>`) reaches the model as Codex's developer
instructions, ahead of the memory, up to 32 KB; more is cut, with a notice. A session reads them when it is launched, so
a change applies at the next `orrery agent`. Codex takes one set of developer instructions, so an agent that has
instructions replaces the `developer_instructions` of your own `~/.codex/config.toml` in its sessions; an agent with
none leaves yours as they are.

## Compaction

Codex keeps its own compaction: `/compact`, or the automatic one near the model's context limit. OpenAI compacts on its
side, and no outside program can supply the compacted text, so Orrery does not replace it (as the Claude Code mod does).

After any compaction Codex runs the session-start hook again (after `/compact`, with your next prompt; after an
automatic one, before the turn goes on), and Orrery gives the view again, refreshed. It first waits up to 15 seconds for
this session's last turns and the summaries. Codex drops the old view when it compacts, so one copy stays. Codex's own
summary of the conversation and Orrery's view are then both in context.

## Remote memory

An agent with a remote works as in the other tools ([remote agents](remote.md)): `orrery agent` asks the remote first,
refuses an agent open on another machine, and asks before taking over a stale lock. The recorder saves after each turn.

## The guard

Every tool call in an agent's Codex session, subagents' included, goes through Orrery's guard first (Codex's
`PreToolUse` hook), with the rules every tool gets: credential files (Codex's own login `~/.codex/auth.json` among them,
as is any `auth.json`), secret files such as `.env`, what `[guard] protect` lists, Orrery's data folder, and other
agents' memory views are refused; writes stay inside the folder Codex was opened in (or the agent's default folder,
when it is inside it) and the agent's `allowed_roots`. See the README's Safety for the full list.

How it reads Codex's tools:

- **Shell commands**: the shell-text rules every tool gets.
- **`apply_patch`**: every file a patch adds, updates, deletes or moves to is a write, read the way Codex's own parser
  reads the patch. A patch the guard cannot read is refused. A patch sent through the shell (`apply_patch <<'EOF'`) is
  judged by its targets in the forms Codex applies itself; any other shell command that names `apply_patch` is refused,
  `grep apply_patch` included.
- **`view_image`**: a read of its path.
- **MCP tools and every other tool**: the heuristics Claude Code's guard uses (paths and command lines under known
  keys).
- **Code cells**: a model that runs its tools from code has each call the cell makes checked on its own.

A refusal reaches the model as `Command blocked by PreToolUse hook: Orrery guard: <reason>`, and the TUI shows it as
blocked by a hook. A config that cannot be read refuses every call until it is fixed.

The guard also refuses shell text that runs Orrery's hook plumbing: the hook commands (`codex-hook`, `claude-hook`)
named anywhere, or Orrery's program with the word `holder`. An agent that ran a hook by hand could feed it made-up input
and put words in your mouth in its own memory. The cost: a shell command that only names them is refused too, such as
`grep -r codex-hook src/` or a `git commit -m` whose message names one. Run those yourself, or search with your
editor. A name built at run time still gets through.

The same goes for Orrery's commands that agents may not run (all but `help`, `--version`, `status`, `usage`, `browse`
and `compactor`; README, Safety): a shell command that runs `orrery` with one of them is refused before it runs, and so
is one that only names it (a `grep` for `orrery restore`, a commit message that mentions `orrery setup`, a patch sent
through the shell whose lines name one). The CLI refuses them inside the session too. Codex's sandboxed shell runs in a
process space of its own (on Linux), where Orrery can't see which agent's session it is: there `orrery` runs only
`help` and the version, not even `status` or `browse`. The memory tools (`zoom`, `date`, `search`) are unaffected:
Codex runs the MCP server outside the sandbox.

Codex's rollouts are what Orrery checks prompts against, so no tool may change them, and neither may it change Claude
Code's transcripts: `apply_patch` is refused anywhere under `~/.codex/sessions` and `~/.codex/archived_sessions` (or
under `$CODEX_HOME`) and `~/.claude/projects`, and shell text that names one of those folders is refused, whatever the
command. Since Codex reads files through its shell, an agent in Codex can't read them either.

OpenCode's config and code are read-only to agents, as in every tool: no `apply_patch` writes `opencode.json` or
`opencode.jsonc` in any folder, a `.opencode` folder, OpenCode's own config, cache and state folders, its database, or
its system config. OpenCode loads plugins, runs commands and takes permissions from them, with no prompt, the next time
it opens that folder. Skills in `.claude/skills` and `.agents/skills`, which OpenCode loads, may be written with
`apply_patch`: a file it adds is judged by its text, and an update only when the skill can be read and neither it nor
the lines the patch adds hold a line that opens front matter in a language other than YAML or JSON (`---js`, which
OpenCode runs as code); a move into a skills folder is refused. Shell text that names OpenCode's config is refused,
whatever the command, and so is shell text that names a skills folder, with one exception: Codex reads files only
through its shell, so its own shell (`exec_command`, not an MCP tool's) may run one plain read of skill files. The
command must be exactly one of these:

- `cat <file>...`
- `head <file>` or `head -n <N> <file>`
- `tail <file>` or `tail -n <N> <file>`
- `sed -n '<A>,<B>p' <file>`
- `ls <folder>`
- `wc <file>...`

`<N>`, `<A>` and `<B>` are numbers. It is one simple command, with no other option (`wc -l`, `head -c`, `tail -f`,
`sed -i` and `ls -la` are refused), no redirection, pipe, `;`, `&&`, `&`, newline or comment, and no variable,
substitution, glob, brace, backslash or `~user`. A word may be quoted, but only around plain path characters (letters,
digits and `. _ / @ + , = : % -`), and every way the guard reads the command (quotes, `$'…'`, braces, backslashes, `..`)
must give the same read. Each file is then judged as a read, links followed, so every other rule still holds: a
credential, a `.env`, a protected file or another agent's view, or a skill that is a link to one, is refused, and so is
a command that also names OpenCode's config. Anything else that names a skills folder is refused, a `grep`, `git add`
or commit message among them, and an agent in Codex can't read OpenCode's config files by name. You set up OpenCode for
a project yourself. `AGENTS.md` stays writable.

### Its limits in Codex

It is a seatbelt, not a sandbox. On top of the limits every tool has (see
[the guard in Claude Code](claude-code.md#the-guard)), in Codex:

- **A command's folder is not seen.** Codex can run a shell command in another folder (its `workdir`) and does not tell
  the hook which. The guard reads relative names from the session's folder. Rules on names still hold anywhere (`.env`,
  `auth.json`, a protected name), but rules on paths (`~/.ssh`, Orrery's home, a `[guard] protect` path, another
  agent's view, where writes may go) can be sidestepped by a command that runs elsewhere and names the file relative to
  there. Only an operating-system sandbox would close this, and Orrery does not set one up.
- **A hook that crashes or times out lets the call through.** That is Codex's rule. Orrery's guard refuses before
  Codex's limit (10 seconds): it judges within 4 seconds of starting, and refuses what it cannot judge in time, an input
  over 1 MB, a command line over 64 KB, any error, and a stall. What goes wrong before the guard is loaded (the runtime
  itself is missing, say) still lets the call through, and so does a file read that blocks past Codex's limit (a hung
  network mount).
- **Hosted web search** runs on OpenAI's side, not as a tool call on your machine; the guard never sees it.
- **Typing into a running command** (`write_stdin`) is not a tool call the hook sees. Orrery turns off the terminal
  that would make it possible (see What happens at launch).
- **A name built from a variable** (`f=.en; cat ${f}v`), read from a file, or printed by another program gets through
  the shell-text rules, as in every tool.
- **Inside the sandbox, no detach is needed.** An agent that clears or sidesteps the session's markers in its
  sandboxed shell (pointing `ORRERY_CONFIG` at a scratch config, say) and hides Orrery's name from the guard can run
  any `orrery` command there, and reads of other agents may work.
- **Under full access, a rollout can be written.** Codex's workspace-write sandbox keeps the shell out of its session
  files; with full access (`--dangerously-bypass-approvals-and-sandbox`, or `danger-full-access`) a program that
  appends to a rollout can fake a turn Orrery then records.
- **A process's decision that can't be saved** (which agent this Codex is): resuming inside Codex's own window can then
  decide again in the same process.
- **`codex queue` adds a turn to a live session.** Any process of yours, the agent's own shell included, can put a
  message into the agent's running Codex session that way. Orrery doesn't record it as yours (Codex marks the turn as
  queued from outside), but the model acts on it, as on anything a process of yours sends.
- **One thread per Codex process.** A Codex process that runs several threads at once (in an editor, or through its app
  server) records only the one its host record names; the others aren't recorded.
- **macOS is not yet verified.** There Orrery asks `lsof` which files Codex holds open, and checks the file at that
  path; if that fails, the session start says so and records nothing.

## A plain Codex

A `codex` started without `orrery agent` loads none of Orrery: no hooks, no memory server, no guard. It is a session
that is no agent's (README, [Sessions that are no agent's](../README.md#sessions-that-are-no-agents)), and gets the
command check only. `orrery` run from its shell (Codex is above it, or, in its sandboxed shell, Codex's
`CODEX_THREAD_ID`, `CODEX_SESSION_ID` or `CODEX_SANDBOX`) runs only `help`, `--version`, `status` and `usage`, and those
show no agent:

```
This is a Codex session that is no agent's (process 4242), so it shows no agent. Run orrery status in your own terminal or the TUI.
```

Everything else is refused: `orrery browse can't run here: this is a Codex session that is no agent's (found
CODEX_THREAD_ID), and those can't read or change Orrery's memory or settings. Run it in your own terminal or the TUI.`,
followed, when a variable found it, by a pointer to the README's Leftover markers. A Codex id that an agent's open
session has recorded is that agent's session, not a plain Codex.

With no guard, a plain Codex's shell can still read Orrery's files directly, as it can any file of yours, and write
them wherever Codex's sandbox lets it. Open an agent with `orrery agent <Name> --tool codex` to get the guard.

## Your own Codex settings still apply

- Your `~/.codex/config.toml` (model, sandbox and approval settings, profiles), your own hooks, your MCP servers and
  your `~/.codex/AGENTS.md` all apply in an agent's session, alongside Orrery's. Codex's sandbox and approvals are
  yours: the guard adds to them and changes none. One exception: an agent's instructions take the place of your own
  `developer_instructions` (see Instructions).
- Don't turn Orrery's hooks off or on in Codex's `/hooks` screen: a toggle there is saved to your `config.toml`. Orrery
  switches its hooks back on at each launch, so it changes nothing for agent sessions, but it leaves an entry in your
  config.
- Codex's own prompts still come: in a git folder it does not trust yet, Codex asks, and saves the answer in its config.

## Troubleshooting

- "Codex runs Orrery's hooks through … -c, which prints when it starts": make the named file print nothing when the
  shell is not interactive. In the file `$BASH_ENV` names, wrap the output in `if [[ $- == *i* ]]; then … fi`; in zsh,
  move it from `.zshenv` to `.zshrc`. Then open the agent again.
- "Orrery's hooks don't load in Codex X" after a Codex update: that Codex reads or trusts hooks in a way this Orrery
  does not know. Say no (the default), and use the Codex version you had, or wait for an Orrery update. The check runs
  again whenever Codex's or Orrery's version changes; `orrery tools` shows its last answer.
- No status line and no memory: the session was a plain `codex`. Open the agent with `orrery agent <Name> --tool codex`.
- "read-only": the agent is open elsewhere, in the tool the notice names. `orrery status` shows it.
- "not recording yet", or "did not answer": read `holder.log` in the agent's data folder, under `claude/`.
- "can't confirm this is this Codex's own session": the reason follows in brackets. Its rollout isn't there or can't
  be read, isn't your own thread (a spawned agent's), isn't open in this Codex (or the system can't say which files
  Codex has open), or Codex moved to a session with no turn of it running. The session is not recorded; open the agent
  again with `orrery agent`.
- "doesn't record who started a turn; Orrery needs Codex 0.162.1 or later": update Codex.
- "unconfirmed messages not recorded" in `orrery status`: prompts or replies the rollout never confirmed, such as
  words that came from outside your own turns.
- After updating Orrery, restart open Codex sessions; the update says `Restart open agent sessions now: sessions left
  open across the update aren't recorded until they restart.` A Codex session open across the update from 0.8.0 records
  nothing until its next session start (a compaction, `/clear` or resume), and after that the previous version's
  recorder, while it still runs, records it without the rollout check. Prompts and replies the old version queued but
  had not saved are dropped and counted, as far as Orrery can tell them apart.
- `Orrery: this Codex hasn't started or resumed a session yet, and only those claim <Name>'s token, so this session
  runs without memory. Resume it, or open <Name> with orrery agent <Name> --tool codex.`: the first session start
  Orrery saw in this Codex was a compaction, `/clear` or a fork, which don't claim the agent's token, and nothing holds
  it. Resume the session (`orrery agent <Name> --tool codex -- resume`), or open the agent again.
- `orrery status .` or `browse` refused in the agent's shell, "only help and the version run": that is Codex's
  sandbox (see The guard). Run them in your own terminal.
- "can't run here: this is a Codex session that is no agent's", or `orrery status` showing no agent: that is a plain
  `codex` (see A plain Codex). Run the command in your own terminal, or open the agent with `orrery agent <Name> --tool
  codex`. With `found CODEX_THREAD_ID` (or another variable) in a terminal of your own, see the README's
  [Leftover markers](../README.md#leftover-markers).
- Summaries failing: check `orrery login`; switch the source with `orrery compactor <Name>`.
- Summaries waiting: the agent's summary model is an OpenCode model (`opencode/…`, chosen in OpenCode), which works only
  while the agent is open in OpenCode. Switch with `orrery compactor <Name>`.

## Files

- `<agent data>/instructions.md`, the agent's instructions;
- `<agent data>/claude/`: the spool, `holder.json`, and `holder.log`, which holds no message text (the folder is shared
  with Claude Code's recorder);
- `<agent data>/claims/`: which process has claimed `ORRERY_AGENT_TOKEN`;
- `<agent data>/status.json`, which `orrery status` reads;
- `<agent data>/claude/codex-sessions.json`: which session each running Codex of the agent is on, for the resume line;
- `<agent data>/claude/unconfirmed.json`: how many prompts and replies the rollout never confirmed (a count, no words);
- `<data>/codex-processes/`: each Codex process's pick, so a session keeps the agent it started with;
- `<data>/session-hosts/`: the Codex process of each open agent session, with its session id, so `orrery` knows a
  command run inside it;
- `codex-check.json` in Orrery's home: the last hook check.

Orrery writes nothing to `~/.codex`. Codex keeps its usual files there: session files, its prompt history, logs.

## Testing

- `npm test` covers the hooks, the recorder, the guard and the launch without Codex (`test/codex/`), including one agent
  in Claude Code and in Codex at once.
- `test/codex/real-codex.test.ts` runs the installed Codex in scratch homes against a fake model: the trust values,
  hooks that load, guard refusals (shell, patch, code cells), compaction and resume, and `orrery agent … -- exec`. It
  skips when Codex is not installed; `ORRERY_TEST_CODEX` names another binary.
- `scripts/codex-e2e.sh` is the real run: real Codex, the real model, about nine short sessions, so it costs usage.
  Run it from your own terminal, not an agent's shell. It uses a temp agent in a temp Orrery home and your Codex login
  and config, in Codex's normal sandbox, and checks recording, the view, resume, a memory tool call, guard refusals on a
  dummy protected file, what the agent's own shell may not run (`orrery remote key`, `orrery agent set … --reads all`,
  a browse of an agent it may not read), and the view after a compaction when Codex compacts. It checks that Codex's
  `config.toml` and `hooks.json` are unchanged, and lists the Codex sessions it made with the `codex delete <id>` that
  removes each.

## Limits

- Codex changes fast. The hook check catches a change in how Codex trusts hooks, not every other change.
- The view is read at a session's start and after each compaction.
- `orrery usage` shows only summary tokens for Codex sessions, not the session's own.
- Events left by a crash are recorded by the next Codex or Claude Code session of the agent.
- Only the Codex CLI is covered. Codex in an editor or in the cloud was not checked; the cloud can't reach the memory on
  your machine.

For launching this tool through Ori, see [Ori](ori.md).
