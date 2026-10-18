# Agents in OpenCode

An agent can run in OpenCode as well as in pi, OMP, Claude Code and Codex, on the same memory
(`~/.orrery/agents/<Name>/`). Monday in Codex and Tuesday in OpenCode are one memory. An OpenCode session of an agent
gets the agent's instructions and its memory view in the system prompt, the memory tools, Orrery's guard on every tool
call, and compaction answered from memory with no model call; each turn is recorded into the agent's memory.

Tested with OpenCode 2.0.30 (`opencode --version` says `opencode v2.0.30`).

## Install

1. OpenCode, installed on its own, with the providers and logins you chat with (OpenCode's own setup).
2. Orrery itself, as in the README's Quick start.
3. A way to make summaries: Orrery's own login (`orrery login openai`, or another source from the README's Summaries),
   or a paid or own-key model of your OpenCode, chosen inside OpenCode (see Summaries through OpenCode).

There is nothing to install on OpenCode's side. Orrery writes nothing to OpenCode's folders (`~/.config/opencode`,
`~/.local/share/opencode`, `~/.local/state/opencode`, `~/.cache/opencode`) and never talks to OpenCode's background
service: its plugin comes with each launch. The Tools page (4) shows OpenCode as `memory`, with the version the plugin
check last verified; `I` installs nothing there.

## Opening an agent

```bash
orrery agent <Name> --tool opencode                    # OpenCode's TUI, in the current folder
orrery agent <Name> --tool opencode -- <opencode arguments>
orrery agent set <Name> --tool opencode                # OpenCode from now on: orrery agent <Name>
```

`tool = "opencode"` in the agent's `[agents.<Name>]` section does the same as `agent set`. The TUI opens it from the
Agents page (Enter or `L`) for an agent whose tool is OpenCode, and asks first whether to open it here or in its default
folder. OpenCode opens an agent in any folder, with no setup step per agent; the folder's own `AGENTS.md` loads as that
project's rules.

`orrery agent` starts `opencode --standalone <folder> [your arguments]`, with `OPENCODE_CONFIG_CONTENT` naming Orrery's
plugin (the installed program's `extensions/opencode` folder), the agent, and the path of the agent's token file.

- **`--standalone`, always.** It gives the session a private OpenCode server, a child of the TUI that ends with it. A
  plain `opencode` talks to OpenCode's shared background service, which never sees a launch's config.
- **Your arguments** follow `--`: `--prompt "…"`, `-c` for the last session, `-s <id>` for one session, `--auto`, or
  `run "…"` for a run without the TUI (and `mini`), which get `--standalone` right after their name. Two kinds are
  refused, with the reason: `--server`, which connects to another server that never loads Orrery's plugin, and the
  subcommands that open no session (`serve`, `acp`, `api`, `session`, `auth`, `models`, `plugin`, `mcp`, `debug`,
  `stats`, `service`, `reload`, `pair`, `upgrade`, `update`, `uninstall`): run those as plain `opencode`.
- **A plain `opencode` is not an agent's session,** even in the agent's folder: no memory, no recording, no guard.
  Opening by folder would need Orrery's plugin in OpenCode's global config and its shared service, which Orrery does
  not write.
- **The token file.** OpenCode's environment and its config content reach the model's shell commands and MCP servers,
  so the agent's one-time token goes in neither. The launch writes it to a file only you can read
  (`tokens/opencode-<pid>-<random>` in Orrery's home, mode 0600 in a 0700 folder) just before OpenCode starts, and
  removes it when OpenCode exits, or when the launcher is stopped (a file a killed launcher left is removed by the
  next launch). The plugin claims the token for this OpenCode's server. `OPENCODE_CONFIG_CONTENT` holds only the plugin
  folder, the agent's name and that path, and the model's shell can see it. `ORRERY_AGENT` and `ORRERY_AGENT_TOKEN`
  are taken out of OpenCode's environment, so a tool the model starts is not the agent; an OpenCode it starts inherits
  the config, finds the token already claimed, and runs as no agent's session, with the guard and without memory.
- `orrery agent` refuses an agent whose memory is still being built, and asks before opening an agent that is already
  open elsewhere (a second session is read-only), as for every tool.
- **Ori** does not open OpenCode agents yet: an agent with `launcher = "ori"` is refused in OpenCode, with how to
  switch to `launcher = "direct"`.

Moving an agent over: close it in the other tool, then `orrery agent <Name> --tool opencode`. It can go back later.
OpenCode's own chats cannot be imported into an agent yet; Claude Code's and Codex's can (README, Importing chats).

## The plugin check

OpenCode's plugin API is new and changes between versions, and a plugin that fails to load leaves a session without
memory or guard, with no word in OpenCode's TUI. So the first time Orrery opens an OpenCode version, again after Orrery
itself is updated, and until a check passes (at every launch when the version can't be read), it asks that OpenCode
whether the plugin loads: a private `opencode serve` in a scratch home inside Orrery's home (`scratch/`), given this
launch's config, its plugin list read until Orrery's plugin is active or failed. It takes about a second, makes no
model call, writes nothing to your OpenCode setup, and reads no `opencode.json` or `.opencode/` from the folders above.
It says `Checking that Orrery's plugin loads in OpenCode 2.0.30…` while it does. The answer is kept
(`opencode-check.json` in Orrery's home) and shown on the Tools page.

If the plugin doesn't load, Orrery says why (`Orrery's plugin doesn't load in OpenCode <version>: <why>. Without it a
session has no memory and no guard.`) and asks `Start OpenCode without Orrery anyway? The session won't be recorded
and the guard will be off. (y/N)`. The default is no. Yes starts plain `opencode` with your arguments, on OpenCode's
shared service as a plain `opencode` runs: not as the agent, with no memory, no recording and no guard, and with no
question about the agent (a second session, or taking over a remote lock). Without a terminal it refuses, even with
`--yes`: only a person can choose that.

## What's recorded

- Your prompts, and the final reply of each run: its text, not its reasoning or tool calls. Tool calls and their
  output, the `!` shell commands you type, and subagents' sessions are not kept. A run that fails or is interrupted
  leaves its reply out; a compaction records nothing.
- Each step's token use, as OpenCode reports it, is recorded too: `orrery usage` shows an OpenCode session's own tokens,
  not only its summaries'.
- The plugin runs in OpenCode's server process for the whole session, as pi's and OMP's extension runs in theirs: it
  opens the agent's memory with the writer lock, records, runs the summaries and keeps the view. The lock is released
  when OpenCode exits.
- A session is OpenCode's session. One the agent started is its own: continue it later (`-- -c`, `-- -s <id>`, or from
  OpenCode's session list) and recording goes on. A session memory doesn't have from its start (a plain OpenCode
  session, another agent's, or one opened while the agent was read-only) is recorded from then on, but keeps
  OpenCode's own compaction (below).
- A session moved to another folder (OpenCode's `session_move`) keeps recording: the plugins of every folder one
  OpenCode serves share the agent's memory.
- One writer: an agent records in one place at a time. An OpenCode session of an agent that is open elsewhere (pi, OMP,
  Claude Code, Codex, or another OpenCode) is read-only: it gets the view and the memory tools, but nothing it says is
  recorded, and a notice says which tool holds the agent.
- Orrery names each session `<Name> · 2026-10-17 14:05`, so OpenCode sends no request to a model for a title (it would
  go to the small model of your chat model's provider, which may have other data terms).

## The memory view

Orrery's plugin adds the agent's instructions, then the memory section (how memory works, then the view), as the last
parts of the system prompt, after OpenCode's own prompt, your `AGENTS.md` files and your config's instructions.

- **Made once per session.** The parts are made at a session's first request in this OpenCode, and every later request
  of the session (each turn, each tool step, its subagents) carries the same bytes until the session is compacted, so
  the provider's cache of the prompt holds. After a compaction they are made again, with what memory has by then.
- **A long session** runs on the view it started with, plus its own transcript. A session continued in a new OpenCode
  (`-c`, `-s`, or reopened from the list) gets the view made again at its first request there.
- **Summaries first.** The first request waits up to 60 seconds for pending summaries (the footer says `summarizing
  before this message…`). If they are not done by then, a notice says the view has unsummarized lines, which the model
  can zoom. While summaries are failing or stopped it doesn't wait; their own notice says why.
- **Read-only sessions** get the view as it was when they started, and the memory section tells the model that the
  session is read-only: nothing said there goes to memory, and a compaction there is OpenCode's own.
- **Subagents** get their session's view and are not recorded.
- The view is added to each request, not saved in OpenCode's session database.

## Instructions

The agent's `instructions.md` (`E` in the TUI, or `orrery agent edit <Name>`) reaches the model as a system part under
`# Agent: <Name>`, before the memory section, up to 32 KB; more is cut, with a notice. They are read when a session's
parts are made, so a change applies at the next session, or the next compaction. Your own `AGENTS.md` files and
OpenCode's `instructions` load as usual.

## Compaction

In the agent's own recorded sessions, Orrery answers OpenCode's compaction from memory, with no model call: `/compact`,
the automatic compaction near the model's context limit, and the one after a request too long for the model. The
summary OpenCode keeps is a short pointer, `The earlier conversation is kept in Orrery's memory: see the Memory section
at the end of the system prompt, which is refreshed with this compaction. Use zoom, date and search for its detail.`,
shown under OpenCode's Compaction divider. OpenCode keeps its most recent turns word for word (its `compaction` setting
says how many tokens), and the next request carries the memory section made again.

A read-only session, and a session memory doesn't have from its start, get OpenCode's own compaction instead, with its
model call: their older turns are not all in memory.

## Memory tools

The model gets `zoom`, `date` and `search`, plus `agents` and `agent_memory` for an agent whose `reads` allows it. They
are the plugin's own tools, given to the model directly from the first request (not behind OpenCode's Code Mode
`execute`), with no MCP server. They read the agent's live memory, or a snapshot of it in a read-only session.

## Status and notices

OpenCode's prompt footer shows the agent's state, on the home screen and in a session: `Orrery · <Name> · N msgs ·
recording`, or `opening memory…`, `summarizing before this message…`, `read-only: <where the agent is open>`, or `no
memory`. Orrery's notices appear as OpenCode toasts: the agent open elsewhere, summary trouble and recovery, an update
("Orrery was updated to 0.8.0; restart this session to use it.", or a release that is out), and anything of Orrery's
that failed. They are shown to you, never to the model.

Every hook of the plugin is wrapped: when one fails, a notice says so and the turn goes on without that part (OpenCode
fails the turn when a plugin's hook throws). If OpenCode turns Orrery's plugin off in a running session (a reload that
failed), the footer turns to `Orrery · NO GUARD, NO MEMORY: OpenCode turned Orrery's plugin off (<why>). Quit OpenCode
and open the agent again.`, with a toast that says the same. The plugin's own log lines (`Orrery: loaded for <Name>.`)
show with OpenCode's `--print-logs`.

## Summaries through OpenCode

Summaries run on Orrery's own sources by default (Sign in, API key, Local), as in every tool. An agent open in
OpenCode can also have them made by a model your OpenCode has, paid or with your own key, through OpenCode's own
providers and logins: Orrery never sees that key.

- **Choosing one.** `/compactor` in OpenCode (also "Orrery: summary model" in the command palette) lists Orrery's
  sources and OpenCode's models, by provider (`OpenCode · <provider>`), the current one first, each with its context
  window and price; the thinking level comes last (off, then the reasoning variants the model has). The pick is tested
  with one small call (an OpenCode model's through OpenCode), then switched to, and a toast says so; a failed test keeps
  the current model. "Back to the config's" returns to the config's model. In the config the same choice is
  `compactor_model = "opencode/<provider>/<model>"` (a model of OpenCode's own gateway is `opencode/opencode/<model>`).
- **Paid and own-key models only.** OpenCode's free models are listed as `free tier, unavailable`, with the reason:
  `OpenCode's free tier only works inside OpenCode chats; background summaries aren't allowed`. OpenCode refuses its
  free tier for a plain background request ("OpenCode's free tier can only be used from within OpenCode.", when Orrery
  tried one), so the free tier is meant for OpenCode's own chats; a summary made as a session would get through, but
  OpenCode's terms also forbid using its services in a way that "automatically or programmatically extracts data or
  Output", and summaries are automated background work. So free models are not offered until OpenCode says background
  use is fine. Free means a model of OpenCode's own gateway (the `opencode` provider, its other plans such as
  `opencode-go`, or any provider set up to go through it) that charges nothing for input, or whose id ends in `-free`.
  A model that turns free later is refused at its next summary: the model list is read again when it is more than a
  minute old.
- **Only while the agent is open in OpenCode.** Opened anywhere else (pi, OMP, Claude Code, Codex), an agent whose
  summaries use an OpenCode model keeps recording, but its summaries wait until it is open in OpenCode again; the status
  says so, and a notice says how to switch to another model there. `orrery compact <Name>` and `orrery run <Name>`
  refuse an OpenCode model in the config, and say how to run them with another; `orrery compactor <Name>` cannot switch
  to one ("OpenCode models are chosen inside OpenCode, where they run"), and the TUI's `M` says to use `/compactor` in
  OpenCode.
- **How a summary goes.** Each summary is one short-lived OpenCode session, titled `Orrery summary · <Name>`, in the
  session's folder, with the chosen model (and its variant for the thinking level). Orrery sets its request through
  OpenCode's `generate` hook: Orrery's summary prompt and the lines to summarize, no tools, no OpenCode prompt. The
  session is removed when the reply is in, so it may show in OpenCode's session list for a moment. One that a crash
  left behind is listed beside the agent's memory (`opencode-summaries.json`) and removed the next time the agent opens
  in OpenCode. A reply to a request that Orrery's hook did not set is never used.
- **Token use.** OpenCode reports no token counts for these requests, so `orrery usage` records them with zero tokens.
  Your provider's dashboard has the real counts.
- **Waiting for the model list.** When the agent opens, the plugin waits up to 15 seconds for OpenCode to list the
  chosen model; one listed later is picked up within a few seconds, and summaries start then.
- **OpenCode's `warming`.** If your OpenCode config turns `warming` on (it is off by default), OpenCode keeps each
  session it sees a request in warm, with a keep-alive request every 4 minutes for 30 minutes. Orrery's summary sessions
  count too: each is gone by the time OpenCode tries, so nothing is sent, but OpenCode keeps a background task per
  summary for those 30 minutes and logs a warning (`failed to warm session`) every 4 minutes. `warming` is one setting
  for every session OpenCode runs, with no switch per session: `"warming": false` stops this, and the warming of your
  agent's own chats with it. Those keep-alive requests go without Orrery's instructions and memory section (OpenCode
  doesn't run the hook Orrery adds them with), so they don't keep that part of the prompt cached.
- A read-only session can't change the summary model: the picker says so.

## The guard

Every tool call in an agent's OpenCode session goes through Orrery's guard first (OpenCode's `execute.before` hook): the
built-in tools, MCP and plugin tools, Code Mode's `execute` and each tool it calls, and subagents' calls. It applies the
rules every tool gets: credential files, secret files such as `.env`, what `[guard] protect` lists, Orrery's data
folder, and other agents' memory views are refused; writes stay inside the folder OpenCode was opened in (or the
agent's default folder, when it is inside it) and the agent's `allowed_roots`; OpenCode's config and code are
read-only, and so are skills' executable front matter (see the README's Safety for the full list). OpenCode's own
login store is refused too, reads included, in OpenCode's sessions and every other tool's: its database (`opencode.db`
in its data folder, a release channel's, or what `OPENCODE_DB` names), which holds its provider keys and sign-ins, and
the `auth.json` older versions kept.
OpenCode's Plan folder, `~/.opencode/plan`, stays writable for its plan files.

Two of those rules matter most here. No tool writes OpenCode's config or code: `opencode.json` or `opencode.jsonc` in
any folder, a `.opencode` folder, OpenCode's own config, cache and state folders, its database, `OPENCODE_CONFIG`'s
file or its system config, since OpenCode would load what an agent wrote there, with no prompt, next to the guard. And
the skills of `.claude/skills` and `.agents/skills`, which OpenCode loads, are written only as ordinary files: `write`
is judged by the text it puts in the file, `edit` by the file it would leave (and again, at the second layer, by the
change OpenCode reports), `patch` by an added file's text, or, for an update, only when the skill can be read and
neither it nor the patch's added lines hold a `---` line naming another language. A skill that would open with `---`
and anything other than YAML or JSON (`---js`, which OpenCode runs as code) is refused, and so is a move into a skills
folder. Shell text that names OpenCode's config or a skills folder is refused, whatever the command: `read`, `glob` and
`grep` read them. The cost: an agent can't set up OpenCode for a project (you write those files yourself), and a shell
`ls`, `cat`, `grep`, `git add` or commit message that names one is refused too.

How it reads OpenCode's tools:

- **`shell`**: the shell-text rules every tool gets, on its command; its `workdir` (the session's folder when it has
  none) is judged as a read of that folder, so a credential folder, Orrery's home or a protected folder as `workdir`
  is refused.
- **`read`, `write`, `edit`**: their path, placed as OpenCode places it (`~` from home, a relative path from the
  session's folder), links followed. For `read`, also each file OpenCode would open when the path is missing (a name
  that differs only in Unicode form, no-break spaces or curly quotes).
- **`patch`**: every file a patch adds, updates, deletes or moves to is a write, read the way OpenCode's own parser
  reads the patch. A patch OpenCode would not apply is refused unread. OpenCode chooses per model whether it gets
  `patch` or `edit` and `write`.
- **`glob`, `grep`**: their search root, as Claude Code's Glob and Grep.
- **`webfetch`, `websearch`**: allowed (the network, as everywhere); a `file:` URL is a read.
- **Code Mode's `execute`**: its JavaScript by the shell-text rules. It can call only MCP, plugin and OpenCode's own
  `opencode_*` tools, never the built-ins, and each tool it calls gets a check of its own, which catches a name built
  from pieces.
- **`session_move`** (`opencode_session_move`): its folder is judged as a `workdir`: a move into a protected folder is
  refused.
- **MCP tools, other plugins' tools and every other tool**: the heuristics Claude Code's guard uses (paths and command
  lines under known keys), a string under `input` or `code` read as shell text, and every patch header in any string
  as a write. A built-in tool must carry the input its schema takes; one another plugin renamed to a built-in's name is
  judged by what it carries.

A refusal reaches the model as the tool's error, `Orrery guard: <reason>`. The guard fails closed: it answers each call
within 4 seconds and refuses what it can't judge in that time, an input over 1 MB, and a command line, Code Mode
program or patch over 64 KB. A config that cannot be read refuses every call until it is fixed, and so does a plugin
that could not start. OpenCode itself has no time limit on a hook: a hook that never answered would hold the call until
you interrupt it.

**The second layer.** As a read or an edit asks OpenCode's leave (its permission check), the guard judges again what
OpenCode says the tool will touch, placed as OpenCode placed it; for a skill, the change OpenCode will make, applied to
the file as it is. It catches a call that another plugin's hook changed after Orrery's judged it, a file `read` opens
in place of a missing one, and a tool a plugin renamed.

The guard adds to OpenCode's own permission rules and approvals, which are yours, and changes none. `--auto` (approve
everything not denied) does not turn it off.

The guard also refuses shell text that runs Orrery's hook plumbing: the hook commands (`codex-hook`, `claude-hook`)
named anywhere, or Orrery's program with the word `holder`. The cost: a shell command that only names them is refused
too, such as a `grep` for them or a commit message that mentions one. A name built at run time still gets through.

### Its limits in OpenCode

It is a seatbelt, not a sandbox. On top of the limits every tool has (see
[the guard in Claude Code](claude-code.md#the-guard)), in OpenCode:

- **Other plugins of yours** that change a call's input after Orrery's hook has judged it: the second layer judges
  reads and edits again, as OpenCode asks leave for them, but a shell command or another tool changed that way is not
  judged again.
- **A session whose plugin OpenCode turned off** (a reload that failed) has no guard at all. The footer says
  `NO GUARD, NO MEMORY`; quit OpenCode and open the agent again.
- **Code Mode's `fetch()`** reaches the network without a tool call (OpenCode refuses `file:` there).
- **A command run in another folder** (`workdir`) that names a file relative to that folder: the rules on names still
  hold (`.env`, a protected name), but the rules on paths read it from the session's folder, as after a `cd`. The same
  goes for a relative path in an MCP tool's patch text.
- **The `!` commands you type** in OpenCode are yours, not tool calls: the guard doesn't see them.
- **A name built from a variable** (`f=.en; cat ${f}v`), read from a file, or printed by another program gets through
  the shell-text rules, as in every tool.

## Troubleshooting

- "Orrery's plugin doesn't load in OpenCode X" after an OpenCode update: that OpenCode loads plugins in a way this
  Orrery does not know. Say no (the default), and use the OpenCode version you had, or wait for an Orrery update. The
  check runs again whenever OpenCode's or Orrery's version changes; `orrery tools` shows its last answer.
- `NO GUARD, NO MEMORY` in the footer: OpenCode turned the plugin off. Quit OpenCode and open the agent again.
- No footer status and no memory: the session was a plain `opencode`. Open the agent with `orrery agent <Name> --tool
  opencode`.
- `read-only`: the agent is open elsewhere, in the tool the notice names. `orrery status` shows it.
- `no memory`: a notice says why (Orrery's config can't be read, the token file, an agent not in the config, a memory
  that could not open). Fix it and open the agent again.
- Summaries waiting: the agent's summary model is an OpenCode model, and the agent is open somewhere else. Open it in
  OpenCode, or choose another model there.
- A free model shown as unavailable in `/compactor`: see Summaries through OpenCode.
- Summaries failing: check `orrery login`, or the OpenCode model's provider; switch with `/compactor`.
- More detail: `orrery agent <Name> --tool opencode -- --print-logs` shows the plugin's log lines on stderr.

## Files

- `tokens/opencode-<pid>-<random>` in Orrery's home: a launch's token file, and beside it `<token file>.feed.json`,
  the footer's status and notices; both are removed when OpenCode exits;
- `opencode-check.json` in Orrery's home: the last plugin check;
- `scratch/` in Orrery's home: the check's scratch OpenCode, removed after each check;
- `<agent data>/instructions.md`, the agent's instructions;
- `<agent data>/status.json`, which `orrery status` reads;
- `<agent data>/opencode-summaries.json`: summary sessions made and not yet removed.

Orrery writes nothing to OpenCode's folders. OpenCode keeps its usual files there: its sessions (in its database), its
prompt history, logs.

## Testing

- `npm test` covers the plugin, the guard, the launch and summaries through OpenCode against a stand-in OpenCode
  (`test/opencode/`).
- `test/opencode/real-opencode.test.ts` runs the installed OpenCode in scratch homes against a fake model, with the
  packed plugin copied outside the repository: the plugin check, recording, the view's bytes, compaction with no model
  request, subagents, a moved session, guard refusals (shell, write, edit, patch, Code Mode, skills, and the second
  layer), and summaries through an own-key model with the free tier refused. It skips when OpenCode is not installed;
  `ORRERY_TEST_OPENCODE` names another binary.
- `scripts/opencode-e2e.sh` is the real run, by hand: real OpenCode and a real model, about nine short sessions. It uses
  a temp agent in a temp Orrery home and a scratch OpenCode home (no login of yours), so it chats with OpenCode's
  default free model unless `ORRERY_E2E_MODEL` names another. It checks the plugin check, recording, the view, a recall
  from it, search and zoom, guard refusals on a dummy protected file, a compaction answered with no model request, no
  title request, and a free model refused for summaries. With `ORRERY_E2E_OPENCODE_CONFIG` (an OpenCode config file of
  yours with a provider and its key) and `ORRERY_E2E_SUMMARY_MODEL` (`opencode/<provider>/<model>`) it also makes
  summaries through that model. It never reads Orrery's saved logins, and checks that your OpenCode config folder is
  unchanged.

## Limits

- OpenCode's plugin API is new and changes fast. The plugin check catches a plugin that doesn't load, not every other
  change.
- `opencode run` sends its message to the model in quotes (OpenCode 2.0.30), and memory keeps the prompt as OpenCode
  sent it.
- OpenCode's chats can't be imported into an agent yet.
- Ori doesn't open OpenCode agents yet.
- Only OpenCode's terminal interface is covered: its web and desktop apps and `acp` were not checked.

For launching tools through Ori, see [Ori](ori.md).
