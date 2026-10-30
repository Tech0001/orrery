# Agents in Grok Build

An agent can run in Grok Build as well as in pi, OMP, Claude Code, Codex and OpenCode, on the same memory
(`~/.orrery/agents/<Name>/`). Monday in Codex and Tuesday in Grok are one memory. Once Orrery is connected to Grok
(see [Install](#install)), a Grok session of an agent gets the agent's memory view and instructions at launch, the
memory tools, Orrery's guard on every tool call, and a status row under the prompt, and each turn you type is recorded
into the agent's memory.

Tested with Grok Build 1.0.70 on Linux (`grok --version`). macOS is not yet verified (see Limits). Grok's own manual
comes with it, in `~/.grok/docs/user-guide/`.

## Install

1. Grok Build, installed on its own and signed in.
2. Orrery 0.10.0 or later, as in the README's Quick start.
3. A login for summaries. Summaries run in the background on Orrery's own login, not Grok's: `orrery login openai`,
   or another source from the README's Summaries.

Orrery's setup (the install script and `orrery update` run it; `orrery setup` runs it again) asks `Connect Orrery to
Grok?` when `grok` is on PATH or Grok's folder is there. Or open Tools (4), select Grok and press `I`; `orrery agent
<Name> --tool grok` asks too, when Orrery isn't connected (see [What happens at launch](#what-happens-at-launch)). It
writes two things in Grok's folder (`$GROK_HOME`, else `~/.grok`):

- **`hooks/orrery.json`**, Orrery's hooks for every Grok session: the session's start, each prompt, each tool call,
  each turn's end, a turn you interrupt, and the session's end. Each runs `orrery grok-hook <event>` from the installed
  program (`~/.orrery/app/current`), through `/bin/sh` with a fixed script that holds none of the hook's input. If
  Orrery is gone, the hook reads its input and exits quietly, so Grok shows no hook error. Session start may take 15
  seconds, the others 10. A file of that name that is not Orrery's is set aside first, after asking, as
  `orrery.json.before-orrery-<date>`, a name Grok doesn't load.
- **Two entries in `config.toml`**: the status row (`[ui.status_line]`, running `orrery grok-status`, or nothing,
  quietly, if Orrery is gone) and the memory tools (`[mcp_servers.orrery]`, running `orrery mcp --tool grok` with the
  launch's `ORRERY_AGENT` and its token). Each
  is added only when the config has none, after every line already there, and the config is copied first, as
  `config.toml.before-orrery-<date>`. A status line of your own stays: setup says so, and how to show Orrery's row (run
  `orrery grok-status` from it; it reads Grok's status JSON on stdin). An `[mcp_servers.orrery]` of your own stays too,
  and Grok then gets no memory tools from Orrery.

If you later delete one of Orrery's entries, the next setup or update asks again before adding it back, and
`orrery agent` names it at each launch, without asking (see What happens at launch). `orrery uninstall` removes the
hook file and the two entries while they still read as Orrery wrote them, after a copy of the config, and leaves the
rest of the file as it was. A rollback or an update to a release before 0.10.0 removes them too: an older Orrery
answers Grok's hooks with an error, which would block every prompt.

The Tools page shows Grok's wiring with the version tested (`tested with Grok 1.0.70`), and `orrery tools` the same.
`orrery tools install` doesn't take Grok; setup and `I` do.

### Folder trust

Grok holds back your own hooks, Orrery's among them, in a folder you haven't trusted, and while you have such a hook it
asks for trust in every folder you open it in but your home folder and the filesystem's root (Grok's manual, "Hooks").
So once Orrery is connected, Grok asks `Do you trust the contents of this directory?` in each new folder. Say yes to
open an agent there. In Grok 1.0.70, no quits Grok.

Trusting a folder also turns on that folder's own MCP and language servers, hooks, project instructions and skills
(Grok's manual), which is your decision to make about each project. So Orrery never trusts a folder for you and never
passes `--trust`. Trust a folder when Grok asks, with Grok's `/hooks-trust`, or with `orrery agent <Name> --tool grok
-- --trust`; Grok's `/hooks-untrust` takes it back (Grok's manual, "Hooks"). Grok keeps the answers in
`trusted_folders.toml` in its folder.

## Opening an agent

```bash
orrery agent <Name> --tool grok                    # in the current folder
orrery agent <Name> --tool grok -- <grok arguments>
orrery agent set <Name> --tool grok                # Grok from now on: orrery agent <Name>
```

The TUI does the same from the Agents page (Enter or `L`) for an agent whose `tool` is `grok`, and asks first whether
to open it here or in its default folder. Grok opens an agent in any folder, with no setup step per agent (Grok itself
asks to trust a new folder: see [Folder trust](#folder-trust)).

- What follows `--` goes to Grok, such as `--resume <id>`, `--continue`, `-m <model>` or `--trust`. Two things are
  refused before Grok starts: Grok's leader mode (`--leader`, or Grok's `agent … leader`, `leader worker start` and
  `worker start` commands), since Orrery opens agents with `--no-leader` (see What happens at launch); and rules of
  your own (`--rules`, `--append-system-prompt`) when Orrery gives the agent's: Grok takes them once, so put yours in
  the agent's `instructions.md`.
- A plain `grok` is not an agent's session, even in the agent's folder: no memory and no recording. See
  [A plain Grok](#a-plain-grok).
- `orrery agent` refuses an agent whose memory is still being built, and asks before opening an agent that is already
  open elsewhere (a second session is read-only), as for every tool.
- Not through Ori yet: an agent whose `launcher` is `ori` is refused for Grok, as for OpenCode, and told to set it to
  `direct` (`orrery agent set <Name> launcher direct`). A Grok session through Ori has not been checked (see
  [Ori](ori.md)).

Moving an agent over: close it in the other tool, then `orrery agent <Name> --tool grok`. It can go back later.
Orrery doesn't import Grok chats; the README's Importing chats covers Claude Code and Codex.

## What happens at launch

Grok starts in the folder with `ORRERY_AGENT` and a one-time `ORRERY_AGENT_TOKEN`, which the first Grok process claims
(its memory server's start or its first session start), so a Grok the agent starts from its own shell is not the
agent. Its command line adds:

- `--no-leader`. In Grok's leader mode (`--leader`, or `[cli] use_leader = true` in its config, which `--no-leader`
  overrides) one shared process runs every session's hooks and memory tools with its first session's environment,
  where one agent's session can't be told from another's.
- `--rules`, which Grok appends to its system prompt for the whole session: the agent's memory section, then its
  instructions (see [The memory view](#the-memory-view) and [Instructions](#instructions)).

The memory section and the instructions travel on Grok's command line, so they show in `ps`, like every argument, and
other users of the computer can read them while the session runs, though the memory files themselves are private. So
can every program of yours, other agents' shells among them (`ps auxww`, `/proc/<pid>/cmdline`), whatever their
`reads` allows.
`orrery agent` says before Grok starts when the memory had to be made smaller to fit, and when the arguments resume a
session (see The memory view).

Orrery's hooks, status row and memory tools come from Grok's own folder (see Install). Without the hooks a session
would get its memory section but no recording and no Orrery guard (unless Grok loads Orrery's Claude Code plugin,
whose guard then runs), and without the config entries, no memory tools or row. So when Grok's hook file isn't this
Orrery's, `orrery agent` and the TUI ask first, as they ask for pi's extension, with the steps setup takes:

```
Orrery's hooks for Grok are not installed, so this session won't record. Connecting Orrery to Grok will:
  write ~/.grok/hooks/orrery.json (Orrery's hooks for every Grok session)
  add Orrery's status row and memory tools to ~/.grok/config.toml unless it has its own (a copy of it first)
Connect Orrery to Grok now?
```

A hook file of another Orrery's, or one that isn't Orrery's, is asked about the same way (`Grok doesn't run this
Orrery's hooks, so this session may not record`): a yes replaces another Orrery's, and sets one that isn't Orrery's
aside first. Yes connects it, as setup does, and opens the agent; no, or no terminal to answer on, opens nothing
(`--yes` answers yes).

When the hook file is this Orrery's and only a config entry of Orrery's is missing (you may have removed it on purpose),
the session still records and is guarded, so nothing is asked: the launch names the entry and opens the agent, and
adds nothing back (`Grok's config has no [ui.status_line], so this session shows no Orrery status row; orrery setup
adds it back.`). When Orrery can't read Grok's folder to tell, it says so and opens the agent. When Orrery's hooks are
switched off in Grok's `/hooks` (connected already, connected by the question above, or when Orrery can't tell), it
says which (the recording hooks, the guard, or both) and how to switch them on, and opens the agent: connecting
doesn't switch them back on. When it can't read Grok's `/hooks` settings (`disabled-hooks` in Grok's folder),
it says that instead, and that the guard of Orrery's Claude Code plugin, if Grok loads it, keeps checking the session's
tool calls. When Grok's config switches Orrery's memory tools off (`grok mcp disable orrery`, or Grok's `/mcps`: the
entry's `enabled = false`, or `disabled_mcp_servers` naming it), it says so and how to switch them back on (`grok mcp
enable orrery`, in your own terminal), and opens the agent; `orrery tools` says so on Grok's row too.

## What's recorded

- Your prompts, and the agent's final reply each time a turn ends. A turn you interrupt keeps its prompt, with no reply.
  Tool calls, their output and the model's reasoning are not kept, and neither is a `!` command you type: those are
  yours, and Grok runs no hooks for them.
- Only what Grok's own record of the session confirms. Grok runs its hooks through a pipe, so any program could feed
  Orrery's hook command made-up words; the session's log in Grok's folder is the proof:
  - a session counts only when Grok's folder is the one the Grok process was started with, the Grok process has the
    session's record open for writing there, nothing on the way is a link, and the session is a person's own, not a
    subagent's. Never where the hook's input or its environment says;
  - a prompt counts once the log has your typed message with the same words, in that turn. A turn Grok starts on its
    own (a scheduled prompt firing, or a background subagent's or task's result waking it) is not yours, and neither
    is a subagent's own session;
  - a reply counts once that turn has ended and the log has its final message. Grok cuts the copy a hook gets at 32,768
    characters; Orrery records the log's words, whole.

  What the log never confirms is dropped after a grace of 30 seconds, and `orrery status` counts it: `N unconfirmed
  messages not recorded` (`unconfirmedMessages` in `orrery status --json`). A session start that can't be confirmed
  says so and records nothing: `Orrery: can't confirm this is this Grok's own session (…), so this session isn't
  recorded.`
- `/new` and `/clear` start a new session in the same Grok, and the recording moves to it. Grok keeps the earlier one
  open (`/dashboard` switches back to it), but Orrery records only the session the latest session start took.
- **A second Grok on the same session.** A Grok that opens a session another Grok records (`grok -r <id>`, which the
  guard refuses in shell text, or one you start yourself) writes its own turns into the same log, so the log can no
  longer tell your typed prompts from the other Grok's. Orrery's hooks run in that Grok too, and its session start marks
  the session: the first Grok's recorder confirms nothing more of it, and its row and next session start say so in one
  line, `read-only: another Grok wrote to this session; recording paused — reopen it to record again`. Turns recorded
  before stay. Reopen the session once the other Grok is gone (quit Grok and resume it with `orrery agent <Name> --tool
  grok -- --resume <id>`, or switch to another session and back): it records again from there. Opened while the other
  Grok still runs, it stays paused. The second Grok records nothing of it either: one started from an agent's shell or
  a plain one never does, and an agent's says `Orrery: another Grok has this session open and records it, so this one
  isn't recorded.`
- Resuming through `orrery agent <Name> --tool grok -- --resume <id>` goes on recording into the same memory, from
  where the session is now: its old turns are not recorded again.
- The hooks only drop each event in a spool; a recorder in the background holds the agent for the session, records the
  spool into memory, runs the summaries, and leaves once Grok is gone and the summaries are done. It is the same
  recorder Claude Code and Codex use.
- One writer: an agent records in one place at a time. A Grok session of an agent that is open elsewhere is read-only:
  its memory section says that this session isn't recorded, it gets the memory tools, and its row says where the agent
  is open.
- Each session start gives Grok a message with the agent's state (`Orrery · <Name> · N msgs · recording`, or why not),
  summary trouble and Orrery's update notices. Grok 1.0.70 shows it after `/clear` and on a resume, but not at a fresh
  launch, where its welcome screen covers it. The status row shows the state too, from your first prompt on.

## The status row

Under the prompt, Grok shows Orrery's row for an agent's session:

- `Orrery · <Name> · N msgs · recording` (`no memory yet` in place of the count for an agent with none);
- `… · not recording yet`: the recorder hasn't started yet;
- `… · read-only: open in pi` (or wherever the agent is open), or the recorder's own reason, such as `another Grok
  wrote to this session; recording paused — reopen it to record again` (see [What's recorded](#whats-recorded));
- `… · not recording: ` and why: Orrery's hooks are switched off in `/hooks`; Orrery's session start hasn't run for
  this session; this Grok records another of its sessions now; or Orrery's recorder stopped (see
  [Troubleshooting](#troubleshooting));
- `Orrery · not recording: leader mode; Orrery opens agents with --no-leader`, with no agent's name: the row runs under
  Grok's shared leader (leader mode; see [What happens at launch](#what-happens-at-launch)). A session's own Grok in
  leader mode shows no row.

A plain grok shows no row. Grok runs the row command at every change and while a turn runs; it reads only the agent's
message count, never a word of memory, and takes no lock. Grok hides the row on its welcome screen, and after a launch
it stays empty until your first prompt. After `/new` and `/clear` it usually reads `not recording yet` until your next
prompt, though the session records: Grok 1.0.70 doesn't run the row again when the session start finishes.

## The memory view

When `orrery agent` opens Grok, the memory section (how memory works, then the view, the same text every tool gets)
goes into Grok's system prompt with `--rules`, ahead of the instructions. Grok's session start can't give the model
context, so the view is the one from the launch, for the whole session: `/clear` and `/compact` keep it, turns since
the launch are in the conversation or reachable with `zoom` and `search`, and a new `orrery agent` launch gives a fresh
view. Grok keeps the system prompt in its own session folder, so the view is in there too.

- **Resume.** Grok doesn't apply `--rules` on `--resume` or `--continue`: a resumed session keeps the memory section of
  its first launch, never doubled, and `orrery agent` says so (`a resumed Grok session keeps <Name>'s memory as it was
  at that session's first launch; newer memory is reachable with the zoom and search tools. Start a new session for a
  fresh view.`). A session first launched with no memory has none after a resume either.
- **Size.** One argument holds at most 131,000 bytes. The instructions go in whole, and the memory section gets the
  rest. A view too large for it starts the session with a smaller view; while its newer lines aren't summarized yet,
  with that view's newest lines, and the model is told that older lines are left out and that `zoom` and `search` reach
  them. `orrery agent` says which before Grok starts.

## Memory tools

The model gets `zoom`, `date` and `search` from the `orrery` MCP server (`orrery__search`, …), plus `agents` and
`agent_memory` for an agent whose `reads` allows it. They read snapshots of the agent's memory. Some models look their
tools up first; the memory section tells the model to look for the zoom, date and search tools when it doesn't see
them. The server serves only the agent `ORRERY_AGENT` names, with its token, so a plain grok gets no memory tools.

Grok also loads Orrery's Claude Code plugin, if you have it, through its Claude Code compatibility. That plugin's
server serves nothing under Grok, so there is one set of memory tools ([Claude Code](claude-code.md#in-grok-build)).

## Instructions

The agent's `instructions.md` (`E` in the TUI, or `orrery agent edit <Name>`) reaches the model with `--rules`, after
the memory section, up to 32 KB; more is cut, with a notice. A session reads them when it is launched, so a change
applies at the next `orrery agent`. Grok's own rules (`AGENTS.md` in a trusted folder, your `~/.grok/rules/`) load as
usual, beside them.

## Compaction

Grok keeps its own compaction: `/compact`, or the automatic one near the model's context limit. Orrery doesn't replace
it. Grok's compaction hooks carry no text, and the memory section is in the system prompt, which a compaction keeps:
afterwards the model has Grok's summary of the conversation and the launch's view, unchanged.

## Remote memory

An agent with a remote works as in the other tools ([remote agents](remote.md)): `orrery agent` asks the remote first,
refuses an agent open on another machine, and asks before taking over a stale lock. The recorder saves after each turn.

## The guard

Once Orrery is connected to Grok (see [Install](#install)), every tool call in a Grok session goes through Orrery's
guard first (Grok's `PreToolUse` hook), subagents' and workflows' calls included. Orrery's hooks are global, so the
guard runs in every Grok session: in an agent's with the rules every tool gets (credential files, `.env` and the other
secret files, what `[guard] protect` lists, Orrery's data folder and other agents' memory views refused; writes inside
the folder Grok was opened in, or the agent's default folder when it is inside it, and its `allowed_roots`; see the
README's Safety), and in a plain grok with Orrery's own rules (see [A plain Grok](#a-plain-grok)).

How it reads Grok's tools:

- **Shell commands** (`run_terminal_command`, `monitor`): the shell-text rules every tool gets, with relative names read
  from the folder Grok gives the hook, the one the session started in. A command's own `cwd` is a folder it reads.
- **`read_file`, `view_image`, `grep`, `list_dir`** (and Grok's other read and search tools): reads of their path.
- **`write`, `search_replace`, `hashline_edit`**: writes of their path. An `apply_patch` is read as Codex's patches are.
- **MCP tools** (`server__tool`) **and every other tool** (`web_fetch`, `spawn_subagent`, …): the heuristics Claude
  Code's guard uses (paths and command lines under known keys). An MCP call whose arguments are still in a file is
  refused.
- **A call Grok cut.** Grok cuts a tool input over 128 KiB and says so. A cut string a rule reads (a command, a path)
  refuses the call; what a file tool writes goes through, but in an agent's session a write into a skills folder whose
  text was cut is refused.

A refusal reaches the model as `Orrery guard: <reason>`, and Grok shows the call as blocked by Orrery's hook. A config
that cannot be read refuses every call until it is fixed. The guard judges within 4 seconds of starting and refuses
what it can't judge in time, an input over 1 MB, and any error.

The guard also refuses shell text that runs Orrery's hook plumbing: the hook commands (`grok-hook`, `codex-hook`,
`claude-hook`) named anywhere, or Orrery's program with the word `holder`. An agent that ran a hook by hand could feed
it made-up input. The cost: a shell command that only names them is refused too, such as `grep -r grok-hook src/` or a
`git commit -m` whose message names one. Run those yourself, or search with Grok's file tools. The same goes for
Orrery's commands that agents may not run (README, Safety). `orrery grok-status`, which only reads, runs in an agent's
shell, as `orrery claude-mod` does.

**Grok's own folder.** Grok loads and runs much of what is in its folder, so no tool writes there and no shell text
names it, in every session, plain ones too, but in the parts Grok's own features write:

- **Open:** its memory, skills and workflows, `/learn`'s runs, the background-task skill's logs, plugins' data,
  `/implement`'s notes, the bundled skills, its docs and logs, and its session worktrees (`grok -w`), which are your
  checkouts.
- **Kept, everything else:** its hooks (Orrery's hook file among them), `config.toml` (Orrery's entries among them), its
  policy files, the `/hooks` switch, the trust list, plugins, agents, the bundle's agents, `lsp.json`, its session
  records, and anything a later Grok adds there.
- File tools may read all of it, but an agent's session reads neither Grok's login nor its session records, which are
  what Orrery checks prompts against. Shell text may not name the folder itself or a kept part (`ls ~/.grok`, `cat
  ~/.grok/config.toml`): read those with Grok's file tools. The cost: in no Grok session can the model change Grok's
  settings, hooks, plugins or agents for you. Change them yourself.
- **Links.** A kept entry that a link takes out of the folder (a `config.toml` kept in a dotfiles folder) is kept where
  it really is too. An open part that a link takes into the rest of the folder, to the folder itself or a folder that
  holds it, or nowhere, is kept. One linked out of the folder (skills kept in a dotfiles folder) stays open to file
  tools through the link; from the shell, write to it where it really is.
- **Shell text that names an open part** may not also change folder (`cd`, `pushd`, `git -C` and the like), hold a
  `..`, or make a link (`ln`, `cp -s`, `cp -l`), any of which could reach the rest. Where the text names session
  worktrees alone, a `cd` and the like go into a worktree, by its full path (`~/.grok/worktrees/<repo>/…`); `cd -`, a
  bare `cd`, `cd ~`, a folder-stack argument (`pushd +1`), a relative `cd` after it and `~/.grok/worktrees` itself are
  refused there: put such commands in a text of their own. A path of Grok's folder
  after a command substitution's opening (`$(`, a backquote, `${ …; }`), or in text whose parentheses don't pair up, is
  refused too: put the substitution after the path, or in a command of its own.
- **A session that runs in Grok's folder.** In a part of it (a `grok -w` session in its worktree), a relative path whose
  `..` leaves that part is refused: name it in full. In the folder itself or a kept part, every relative path is read
  from there, and only those into an open part pass: a bare word that names an entry there (`hooks`, `agents`, even in a
  commit message) is refused, and so are `.`, globs, a command substitution or `${…}`, a short option whose glued value
  names an entry (`cp -vthooks x`), and `>& name`.
- **A session at home or beside Grok's folder.** Grok's folder spelt from there (`.grok/…`, `../.grok/…`, `.grok*`) is
  read as its path, so what is refused by its full path is refused that way too. A project's own `.grok` folder is the
  project's.

**Grok's own commands.** Grok's CLI writes what the guard keeps in Grok's folder, runs sessions and leaders outside
`orrery agent`, and can open a session that is live in another Grok, so in every session, plain ones too, shell text
may not run `grok` (or a path to it, or its release binary) with:

- `-r`/`--resume`, `-c`/`--continue` or `-s`/`--session-id`, among its own options, before or after its prompt. A second
  Grok that opens a live session writes its own prompt into that session's log, where it would read as typed (see
  [What's recorded](#whats-recorded));
- `--trust`, anywhere: it trusts a folder for good;
- any subcommand Grok 1.0.70's `--help` lists but its read-only ones: so `mcp add`, `remove`, `enable`, `disable` and
  `doctor`; `plugin install` and the rest that change plugins or marketplaces; `update` and `setup` (even `--check`
  and `--json`); `login`; `logout`; `memory clear`; `sessions delete`; `agent` (its `stdio`, `serve`, `headless` and
  `leader` run sessions outside `orrery agent` and load them by id); `leader` and `worker` (which run Grok's shared
  leader); `dashboard`; `export` and `trace` (they write files, the clipboard or an upload); `clone`; `wrap`; `doctor`;
  and `worktree`'s commands that change worktrees.

Its read-only commands pass: `grok --version`, `--help`, `help`, `version`, `models`, `inspect`, `completions`,
`usage`, `du` (but `--clean`), `mcp list`, `plugin list` (but `--available`), `plugin details` and `validate`, `plugin
marketplace list`, `sessions list` and `search`, and `worktree list` and `show`. So does any command's own `--help`, given
before the command's first argument and before any `--` (`grok mcp add --help`, not `grok mcp add x -- cmd --help`);
`-h` doesn't count, since Orrery reads the text in lower case and `mcp add`'s `-H` is a header. Grok takes its
subcommand from the first word that is no option or value, or from the next when that first is its prompt (`grok hi mcp
list` runs `mcp list`), and both places are read. A word built at run time (`$M`, `$(…)`) or a glob counts as an
option's value when one comes before it; where the subcommand stands it is refused when it could be a refused command
(a glob that could name one, or a later word that is one: `grok $C disable orrery`). As with Orrery's commands, text
that only names one is refused too (`echo grok update`), and so is a prompt given as Grok's first word that starts with
a subcommand's name (`grok "update the docs"`): give it with `-p`. Grok's `--help` lists no option that starts it
without its hooks. Run these yourself in your own terminal.

### Its limits in Grok

It is a seatbelt, not a sandbox. On top of the limits every tool has (see
[the guard in Claude Code](claude-code.md#the-guard)), in Grok:

- **A hook that crashes or times out lets the call through.** That is Grok's rule: only a refusal blocks. Orrery's
  guard answers within its own time (above), and a crash or a stall of its own is refused; what goes wrong before the
  guard is loaded still lets the call through.
- **`!` commands** you type in Grok are yours and raise no hook: the guard never sees them.
- **Grok's other hook and server sources are yours, not kept:** a project's `.grok/hooks/*.json`, `.grok/config.toml`
  and `.grok/lsp.json`, its `.claude/settings*.json` and `.cursor/hooks.json`, your Claude Code settings file and Cursor
  hooks file, and the scripts and hook files that Grok's config or its `hooks-paths` list names outside Grok's folder. A
  hook or server an agent plants there runs outside the guard in a later session, and a hook may rewrite a call after
  Orrery judged it, as a script an agent writes and later runs does.
- **A session worktree's own git config and hooks** are writable, as any project's: if Grok runs git there on its own
  (its cleanup; unverified), something planted there runs outside the guard.
- **Plugins' data is open**, so a plugin whose hooks read commands from its own data folder could be steered by a write
  there.
- **Shell text reaches the rest of Grok's folder** through a link brought into an open part whole (`cp -a`, `mv`,
  `tar`, `git clone`, a checkout) or made by a script; a relative path after a `cd` in the same text; a relative path
  spelt another way from the call's folder (`../u/.grok` from home, through a link); a path assembled from variables,
  parameter expansions or substitutions, from a session started in Grok's folder too; a bare word, run in Grok's
  folder itself, that names an entry Grok would load that isn't there yet (`touch disabled-hooks`; not one an output
  redirection writes); and a folder change or link made by another program (`find -execdir`, `env -C`, `tar -C`,
  `xargs`, `sh -c`; `link`, `busybox ln`, `rsync` or `cp` keeping links). File tools follow links and are refused.
- **Grok's persistent shell** keeps a `cd` (and the `pushd` stack) from one call to the next, but the guard reads
  relative paths from the folder the session started in. After a call that goes into a session worktree, a later
  call's relative path (`echo x > ../../../hooks/e.json`), or its `popd` or `cd -` back, is read from there and gets
  through.
- **A name built from a variable**, read from a file, or printed by another program gets through the shell-text rules,
  as in every tool, and so does a `grok` command reached that way, through an alias or a link of another name, or from
  a script, and one whose whole subcommand is built at run time (`grok $C`, with `C` holding `mcp disable orrery`).
- **Grok's read-only commands are 1.0.70's.** A subcommand a later Grok adds is refused until Orrery lists it, but an
  option a later Grok adds to a read-only command that writes passes until Orrery refuses it.
- **A coding tool an agent starts with its own settings** is a second program, as a script is: a Grok started with
  another `GROK_HOME` (or another home) loads none of Orrery's hooks, so it has no guard and doesn't mark a session it
  opens; a Claude Code started with its own config folder loads no Orrery plugin. Started from an agent's shell they
  still open no memory and record nothing.

## A plain Grok

A `grok` started without `orrery agent` still runs Orrery's hooks, since they are global, but it is no agent's session:
no memory, no recording, no memory tools and no row. In an agent's folder its session start says so: `Orrery: this
folder is <Name>'s, but this Grok wasn't opened as <Name>, so it opens no memory and records nothing. Open it with
orrery agent <Name> --tool grok.` (Grok 1.0.70 shows that message after `/clear` or a resume; at a fresh launch its
welcome screen covers it.)

Its guard keeps Orrery's own rules, as Claude Code's does in a session that is no agent's (README,
[Sessions that are no agent's](../README.md#sessions-that-are-no-agents)): Orrery's home, config, program and logins,
every agent's memory view, the session records, Orrery's commands and plumbing in shell text, and Grok's folder as
above. `orrery` run from its shell runs only `help`, `--version`, `status` and `usage`, and those show no agent:

```
This is a Grok session that is no agent's (process 4242), so it shows no agent. Run orrery status in your own terminal or the TUI.
```

A Grok started from inside an agent's session (a `grok` the agent runs from its shell) opens no memory and records
nothing, says so at its session start (which Grok 1.0.70 shows after `/clear` or a resume, but not at a fresh launch),
and keeps that agent's rules in its guard (both agents' rules, in another agent's folder).

## Your own Grok settings still apply

- Your `~/.grok/config.toml` (model, permissions, sandbox), your hooks, MCP servers, plugins, rules and skills all apply
  in an agent's session, alongside Orrery's. Grok's permissions and sandbox are yours: the guard adds to them and
  changes none.
- Grok's own memory (`[memory] enabled`, off by default; `/memory`) is Grok's, not the agent's, and Orrery leaves it as
  you set it. When it is on, its notes (global, and per repository) are read and written by every Grok session, every
  agent's among them.
- Grok's `/hooks` tab can switch Orrery's hooks off; Grok saves that in `disabled-hooks` in its folder. With them off,
  the session isn't recorded (the row says so). With the guard hook off, tool calls run unguarded, unless Grok also
  loads Orrery's Claude Code plugin, whose guard then runs instead. `orrery agent` says at launch which of them are off,
  or that it couldn't read `disabled-hooks`.

## Troubleshooting

- Grok asks `Do you trust the contents of this directory?`: that is Grok's folder trust (see Install). Say yes to open
  the agent there.
- No row, nothing recorded and no memory tools: the session is a plain `grok` (open the agent with `orrery agent <Name>
  --tool grok`), or Orrery's side of Grok isn't installed, and then no Orrery guard runs either (Orrery's Claude Code
  plugin guards the session, if Grok loads it). `orrery agent` asks to connect it (see What happens at launch);
  `orrery tools` shows Grok's row, and `orrery setup`, or `I` on Tools, connect it too. Remember the row stays empty
  until your first prompt.
- A status line of your own and no Orrery row: setup kept yours. Run `orrery grok-status` from it.
- `not recording yet`: the recorder hasn't started yet. Right after `/new` or `/clear` that is Grok not refreshing the
  row (see The status row); it changes with your next prompt. If it stays, read `holder.log` in the agent's data folder,
  under `claude/`.
- `not recording: Orrery's hooks are switched off in /hooks`: switch them on in Grok's `/hooks` tab (Global hooks),
  then start a new session (`/new`) or resume.
- `not recording: Orrery's SessionStart hasn't run for this session; resume it or start a new one`: its hook was
  switched off when the session started and on since, or it crashed, timed out or couldn't confirm the session (its
  message says why after `/new` or a resume). Do as it says.
- `not recording: this Grok records another of its sessions now`: you switched back to an earlier session of this Grok
  (`/dashboard`), and Orrery records the one its latest session start took. Start a new session, or resume this one.
- `not recording: Orrery's recorder stopped; a new session or a resume starts it again`: do that; `holder.log` says why
  it stopped.
- `read-only`: the agent is open elsewhere, in the tool the row names. `orrery status` shows it.
- `read-only: another Grok wrote to this session; recording paused — reopen it to record again`: another Grok opened
  this session (see [What's recorded](#whats-recorded)). Once it is gone, quit and resume the session with `orrery agent
  <Name> --tool grok -- --resume <id>`, or switch to another session and back.
- `Orrery: another Grok has this session open and records it, so this one isn't recorded.`: you opened a session that
  is live in another Grok. Close one of the two.
- `grok -r can't run from a session's shell` (or `grok mcp disable`, `grok --trust` and the others): run that `grok`
  command in your own terminal (see [The guard](#the-guard)).
- `Orrery's memory tools are switched off in Grok's config`: `grok mcp disable orrery` or Grok's `/mcps` switched
  them off; `grok mcp enable orrery`, in your own terminal, switches them back on.
- `can't confirm this is this Grok's own session`: the reason follows in brackets, such as Grok not holding the session
  open, a link on the way, a subagent's session, or a system that can't say which files Grok has open. The session is
  not recorded; open the agent again with `orrery agent`.
- `Orrery opens Grok with --no-leader: in leader mode …`: leave out `--leader` (or the leader command it names). If
  Grok runs its leader anyway (a policy pin of `use_leader`, say), the session start says `Grok runs this session's
  hooks and memory tools in its shared leader process (leader mode) …`: nothing is recorded, no memory tools are served,
  and the guard keeps Orrery's own rules, as in a plain grok.
- `Orrery gives Grok <Name>'s memory and instructions as its --rules, which Grok takes once`: put your rules in the
  agent's `instructions.md`.
- `<Name>'s memory view is too large for Grok's command line`, or `starts with its newest lines`: the session starts
  with less of the view (see The memory view); `zoom` and `search` reach the rest.
- The model doesn't remember something said after the launch, in a resumed session: a resume keeps its first launch's
  memory section. Start a new session.
- `This command names Grok's folder or what Grok loads and runs in it`: read those files with Grok's file tools, and
  change Grok's settings yourself.
- `can't run here: this is a Grok session that is no agent's`, or `orrery status` showing no agent: that is a plain
  `grok`. Run the command in your own terminal, or open the agent with `orrery agent <Name> --tool grok`.
- `unconfirmed messages not recorded` in `orrery status`: prompts or replies Grok's log never confirmed as yours, such
  as turns Grok started on its own or a subagent's prompts.
- After updating Orrery, restart open Grok sessions: the hooks run the new version at once, but a session's recorder
  keeps the one it started with.
- Summaries failing: check `orrery login`; switch the source with `orrery compactor <Name>`.

## Files

- `<agent data>/instructions.md`, the agent's instructions;
- `<agent data>/claude/`: the spool, `holder.json`, and `holder.log`, which holds no message text (the folder is shared
  with Claude Code's and Codex's recorder);
- `<agent data>/claims/`: which process has claimed `ORRERY_AGENT_TOKEN`;
- `<agent data>/status.json`, which `orrery status` reads;
- `<agent data>/claude/unconfirmed.json`: how many prompts and replies the log never confirmed (a count, no words);
- `<data>/grok-processes/`: each Grok process's pick, so a session keeps the agent it started with;
- `<data>/session-hosts/`: the Grok process of each open agent session, with its session id, so `orrery` knows a
  command run inside it;
- in Grok's folder: `hooks/orrery.json`, Orrery's two entries in `config.toml`, and `config.toml.before-orrery-<date>`,
  the copy setup made before changing it.

Grok keeps its usual files in its folder: its sessions (Orrery reads a session's log there), its trust list and its
`/hooks` switches.

## Testing

- `npm test` covers the launch, the hooks, the recorder's confirmation against Grok's log, the guard, the install and
  the status row without Grok (`test/grok/`, `test/cli/grok-hook.test.ts`). `npm run test:binary` runs the status row
  on the compiled program too.
- `scripts/grok-e2e.sh` is the real run: real Grok, the real model, two launches with five short turns and one
  `/compact`, so it costs usage. Run it from your own terminal, not an agent's shell; it needs `tmux`. It uses a temp
  agent in a temp Orrery home, a temp home folder and a scratch git repo, with your Grok folder for the sign-in and
  Grok's own memory off for the run. With Orrery's hooks not installed in Grok's folder, it puts this checkout's hook
  file and memory server in the scratch repo's `.grok`; with them installed, the run uses those. `orrery agent` runs
  with a Grok folder of the run's own, so the first launch's question to connect Orrery to Grok (answered yes) writes
  there, and Grok itself runs with yours. It trusts only the scratch repo (`--trust`), and at the end, once every
  process it started is gone, removes that entry from Grok's trust list, after a copy of it; if anything of the run's is
  left there, it names the lines to remove by hand and keeps the copy. It checks that a new session's system prompt
  holds a codeword from the first session's memory and that the model still answers it after `/compact`, that typed
  turns are recorded once each, that a forged `grok-hook` run from the agent's shell is refused and plants nothing, and
  the status row's text from `orrery grok-status` in the agent's shell (and on screen, when Orrery's row is in Grok's
  config). It checks that Grok's `config.toml` and `hooks/` are unchanged, leaves no process behind, and lists the Grok
  session folders it made.

## Limits

- Grok changes fast. The session log's fields are Grok 1.0.70's; a Grok that writes them differently isn't recorded.
- The view is read at launch only. A resumed session keeps its first launch's memory section.
- The memory section and the instructions are on Grok's command line, which other users of the computer can read, and
  so can other agents' shells.
- Leader mode is not supported: agents open with `--no-leader`. Nor is Ori: a Grok agent whose launcher is `ori` is
  refused.
- A program of yours that writes in Grok's folder (appends to a live session's log, puts files in a live session's
  folder, or renames a session folder there) can make words look like Grok's own. The guard keeps agents' tools out of
  Grok's folder, not a program that builds the path itself.
- A second Grok on a live session marks it only when Orrery's hooks run in it and its Orrery config is the same data
  folder's: one started with another `GROK_HOME`, with Grok's hooks masked, under a leader, or with another Orrery home
  marks nothing, and its turns in the log could be confirmed by a prompt hook made up in the recording Grok's shell.
  Starting one is refused in shell text; a script or a program of another name gets through.
- A made-up session start that names another session the same Grok keeps open moves the recording there until the next
  real session start. It adds no words: only Grok's own log confirms them.
- `orrery usage` shows only summary tokens for Grok sessions, not the session's own.
- Events left by a crash are recorded by the next Claude Code, Codex or Grok session of the agent.
- Only the Grok Build terminal app is covered. Grok's ACP agent (`grok agent`), its dashboard and its desktop app were
  not checked.
- **macOS is not yet verified.** There Orrery asks `lsof` which files Grok holds open, and `ps` for its environment; if
  either can't say, the session start says so and records nothing. `ps` joins the environment with spaces, so a value
  holding one can't be read for sure: when `HOME`, `GROK_HOME`, `ORRERY_HOME` or `ORRERY_CONFIG` holds a space (or one
  of them stands twice), Grok's sessions there aren't recorded, and the session start says it can't tell (fail closed).
  Each hook, status row run and guard call asks `ps` twice there.

For the architecture of hooks and confirmation across tools, see [the architecture guide](architecture.md).
