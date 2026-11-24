# Agents in the Antigravity CLI

An agent can run in Google's Antigravity CLI (`agy`) as well as in pi, OMP, Claude Code, Codex, OpenCode and Grok Build,
on the same memory (`~/.orrery/agents/<Name>/`). Once Orrery is connected to Antigravity (see [Install](#install)), a
conversation of an agent gets the agent's instructions and memory view before its first model call and again after
each compaction, the memory tools, Orrery's guard on every tool call, and a status row, and each turn you type is
recorded into the agent's memory. Antigravity's own agent, tools and model stay as they are: pick any model agy offers
(`agy models`), such as Gemini 4 Neon where your plan has it, with `-- --model <id>`.

Tested with the Antigravity CLI 1.5.13 on Linux (`agy --version`) and Gemini 3.8 Flash. macOS, the Antigravity App and
its IDE extensions are not yet verified (see Limits).

## Install

1. The Antigravity CLI, installed on its own and signed in (run `agy` once).
2. Orrery 0.11.0 or later, as in the README's Quick start.
3. A login for summaries. Summaries run on Orrery's own login, not Antigravity's: `orrery login openai`, or another
   source from the README's Summaries.

Orrery's setup (the install script and `orrery update` run it; `orrery setup` runs it again) asks `Connect Orrery to
Antigravity?` when `agy` is on PATH or its folder (`~/.gemini/antigravity-cli`) is there. Or open Tools (4), select
Antigravity and press `I`; `orrery agent <Name> --tool antigravity` asks too when Orrery isn't connected. It adds one
entry of Orrery's to each of three files of Antigravity's, each copied first (`<file>.before-orrery-<date>`), leaving
the rest of each file as it was:

- **`~/.gemini/config/hooks.json`**, Antigravity's global hooks: an `orrery` entry with `PreInvocation` (before each
  model call), `PreToolUse` (the guard, every tool) and `Stop` (each turn's end). Each runs `orrery agy-hook <event>`
  from the installed program (`~/.orrery/app/current`) through a fixed shell line that holds none of the hook's input.
  A session with no agent gets an answer from that line at once, without starting Orrery, but for the guard. If Orrery
  is gone, the line reads its input and answers as if nothing were there.
- **`~/.gemini/config/mcp_config.json`**: an `orrery` server, running `orrery mcp --tool antigravity`, with `zoom`,
  `date` and `search` loaded up front (agy names them `mcp_orrery_zoom`, `mcp_orrery_date`, `mcp_orrery_search`); the
  others the model reaches through agy's `call_mcp_tool`.
- **`~/.gemini/antigravity-cli/settings.json`**: Orrery's status line (`orrery agy-status`), shown below agy's own row.
  A status line of your own stays; run `orrery agy-status` from it to show Orrery's.

An `orrery` hooks entry or server that isn't Orrery's stays as it is, and setup says so; `orrery agent` then says the
conversation won't be recorded or guarded, and asks before opening it. `orrery uninstall` removes
Orrery's three entries while they still read as Orrery wrote them, after a copy of each file. A rollback or an update to
a release before 0.11.0 removes them too: an older Orrery answers the guard with an error, and agy takes a failing guard
as a refusal of every tool call.

The Tools page shows Antigravity's wiring with the version tested (`tested with agy 1.5.13`), and `orrery tools` the
same.

## Opening an agent

```bash
orrery agent <Name> --tool antigravity                    # in the current folder
orrery agent <Name> --tool antigravity -- --model <id>    # pick agy's model
orrery agent set <Name> --tool antigravity                # Antigravity from now on: orrery agent <Name>
```

The TUI does the same from the Agents page (Enter or `L`) for an agent whose `tool` is `antigravity`.

- What follows `--` goes to agy, such as `--model <id>`, `--continue`, `--conversation <id>` or `-p <prompt>`.
  `--remote-agent` is refused: a remote agent's hooks run on another machine, where nothing records or guards it.
- A plain `agy` is not an agent's session, even in the agent's folder: no memory and no recording (see
  [A plain agy](#a-plain-agy)).
- `orrery agent` refuses an agent whose memory is still being built, and asks before opening an agent that is already
  open elsewhere (a second session is read-only), as for every tool.
- Not through Ori yet: an agent whose `launcher` is `ori` is refused for Antigravity, and told to set it to `direct`.

agy starts with `ORRERY_AGENT` and a one-time `ORRERY_AGENT_TOKEN` in its environment, which the agy process claims at
its first model call. Nothing of the memory goes on its command line.

## What happens in a conversation

- **Before each model call** (Antigravity's `PreInvocation`), Orrery checks that the conversation is this agy's own:
  agy holds the conversation's presence lock open for writing in its own folder, and the conversation's first step is a
  prompt you typed (a subagent's conversation is not). The first time, it records agy as the agent's session host and
  starts the recorder. When the conversation has no memory view yet, or none since its last compaction, it gives the
  model a status line (`Orrery · <Name> · N msgs · recording`, or why not), the agent's instructions and its memory
  section, as system messages of at most 40 KB each (agy cuts a longer one).
- **Each turn's end** (`Stop`) tells the recorder to read the conversation's record.
- **Each tool call** (`PreToolUse`) goes through the guard (see [The guard](#the-guard)).

Antigravity fires no session start when a conversation is resumed, so all of this happens at the first model call of
each agy process, a resumed conversation's included.

## What's recorded

- Your prompts, and the agent's final reply of each turn. Tool calls, their output and the model's reasoning are not
  kept. A slash command (`/compact`, `/model`) is not recorded, nor its reply.
- Only what agy's own record of the conversation shows (`~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/
  transcript_full.jsonl`), in its words: a prompt is a step agy marks as typed by you. A message a hook adds, a
  subagent's result, a Stop hook's "continue" and Orrery's own view are not your prompts (seen live; a prompt agy's
  `schedule` tool fires was not checked). The hooks pass no words; the recorder reads them from that file, which no
  tool may write (see The guard).
- A turn's reply is recorded once the turn is over: at its end, when your next prompt comes, or when agy quits.
- Resuming a conversation (`--conversation <id>`, `--continue`, `/resume`) goes on recording from where it is now; its
  earlier turns are not recorded again.
- One writer: an agent records in one place at a time. A conversation of an agent that is open elsewhere is read-only:
  its memory section says so, it gets the memory tools, and its row says where the agent is open.
- The recorder is the one Claude Code, Codex and Grok use: it holds the agent for the conversation, runs the summaries,
  and leaves once agy is gone and the summaries are done.

## The memory view

The model gets the agent's memory section (how memory works, then the view) as system messages in the conversation,
before its first call. A compaction (`/compact`, or agy's own near the context limit) summarizes the conversation,
the view included, so at the next model call Orrery gives the view again, as it is then: what was recorded since,
here or in any other tool, is in it. Between compactions the conversation keeps the view it was given; turns since are
in the conversation, and the memory tools reach everything.

Antigravity's compaction is its own: it asks its model for a summary of the conversation. Orrery doesn't replace it.

## Memory tools

`zoom`, `date` and `search`, plus `agents` and `agent_memory` for an agent whose `reads` allows it, from the `orrery`
MCP server; agy names them `mcp_orrery_<tool>`. The guard approves them in an agent's conversation, so agy asks no
permission for them, but only while the `orrery` server agy runs is the one setup wrote in Antigravity's global
`mcp_config.json`, for this Orrery, and no other server, there or in a workspace's `.agents/mcp_config.json`, has a
name starting `orrery` (in any case): a server of someone else's under that name, or one whose tools agy would name
like Orrery's (a server `orrery_agent` with a tool `memory` is `mcp_orrery_agent_memory`), would otherwise run with
Orrery's approval.
Otherwise agy asks, as for any MCP tool; `agy -p`, which can't ask, then refuses them unless a rule allows them
(`--settings '{"permissions":{"allow":["mcp(orrery/*)"]}}'`, or `permissions.allow` in agy's settings). The server
serves only the agent `ORRERY_AGENT` names, with its token, as the agy process was started with them, so a plain agy
gets no memory tools.

## The status row

Below agy's own status row: `Orrery · <Name> · N msgs · recording`, or `not recording yet` before the conversation's
first model call, `read-only: open in <tool>` when the agent is open elsewhere, or `not recording:` and why (the
recorder stopped, or this agy records another of its conversations). A plain agy shows no row. It reads only the
agent's message count, never a word of memory.

## The guard

Once Orrery is connected, every tool call in every agy session goes through Orrery's guard first, a subagent's
included: in an agent's conversation with the rules every tool gets (credential files, `.env` and the other secret
files, what `[guard] protect` lists, Orrery's data folder and other agents' memory views refused; writes inside the
folder agy was opened in, or the agent's default folder when it is inside it, and its `allowed_roots`; see the README's
Safety), and in a plain agy with Orrery's own rules.

How it reads agy's tools:

- **`run_command`**: the shell-text rules every tool gets; its `Cwd` is a folder it runs in.
- **`read_file`, `view_file`**: reads of their path. **`list_dir`, `find_by_name`, `grep_search`**: listings and searches
  of their folder.
- **`write_file`, `write_to_file`, `edit_file`, `replace_file_content`, `multi_replace_file_content`**: writes of their
  path.
- **MCP tools and every other tool** (`call_mcp_tool`, `invoke_subagent`, …): the heuristics Claude Code's guard uses
  (paths and command lines under known keys).
- A call that also names an argument under the name the guard reads it by (`file_path` beside agy's `Path`) is
  refused: the guard would judge the one agy doesn't use.

A refusal reaches the model as `tool call denied by pre-tool hook: Orrery guard: <reason>`. The guard always answers
(agy lets a call through when a hook answers nothing); a config that cannot be read refuses every call until it is
fixed, and so does any error.

**Antigravity's own files.** In every session, plain ones too, no tool writes and no shell text names:

- its conversation records (`~/.gemini/antigravity-cli/brain/`, `conversations/`, `presence/` and
  `conversation_summaries.db`), which Orrery records from and proves a conversation by; read them with a file tool;
- the settings that load hooks and servers into its sessions: `~/.gemini/config/hooks.json`, `mcp_config.json` and
  `plugins/`, the CLI's `settings.json`, and a project's `.agents/hooks.json` and `.agents/mcp_config.json`.

What you attach to a conversation (an image, say) lands in `brain/<conversation>/.user_uploaded/`. A file tool reads it
but can't copy it, so one plain `cp` of those files out to a folder of yours is let through, and so is one plain
`cat`, `head`, `tail`, `wc`, `ls` or `sed -n` of them: the full path written out (`~/…` or absolute), no option, pipe,
redirection or `..`, and the copy going nowhere in Antigravity's own files. A file there that is a link is judged as
where it leads.

Its skills, rules and other customizations stay open. Shell text that runs Orrery's hook plumbing (`agy-hook`, and the
other tools' hook commands) is refused too, as in every tool.

## A plain agy

An `agy` started without `orrery agent` has no `ORRERY_AGENT`: Orrery's hooks give it no memory and record nothing, and
it gets no memory tools and no row. The guard runs with Orrery's own rules: every agent's memory, Orrery's data and
settings, the tools' session records and Antigravity's own files are kept from it.

## Troubleshooting

- No row, no memory and nothing recorded: the conversation is a plain `agy` (open the agent with `orrery agent <Name>
  --tool antigravity`), or Orrery isn't connected to Antigravity (`orrery tools` shows its row; `orrery setup` or `I`
  connects it).
- A status line of your own and no Orrery row: setup kept yours. Run `orrery agy-status` from it.
- `not recording yet` after the first prompt: read `holder.log` in the agent's data folder, under `claude/`.
- `Orrery: can't confirm this is this Antigravity's own conversation (…)`: the reason follows, such as agy not holding
  the conversation open, a link on the way, or a system that can't say which files agy has open. The conversation is
  not recorded and gets no memory; open the agent again with `orrery agent`.
- A tool call refused with `This command names Antigravity's own files`: read those files with a file tool, and change
  Antigravity's settings yourself.
- After updating Orrery, restart open agy sessions: the hooks run the new version at once, but a conversation's
  recorder keeps the one it started with.
- Summaries failing: check `orrery login`; switch the source with `orrery compactor <Name>`.

## Files

- `<agent data>/instructions.md`, the agent's instructions;
- `<agent data>/claude/`: the spool, `holder.json` and `holder.log` (no message text), shared with the other tools'
  recorder;
- `<agent data>/claims/`: which process has claimed `ORRERY_AGENT_TOKEN`;
- `<data>/antigravity-processes/`: each agy process's pick, so a conversation keeps the agent it started with;
- `<data>/antigravity-conversations/`: where each conversation's record was read up to, and when its view was given;
- `<data>/session-hosts/`: the agy process of each open agent conversation;
- in Antigravity's folders: Orrery's entries in `~/.gemini/config/hooks.json` and `mcp_config.json` and in
  `~/.gemini/antigravity-cli/settings.json`, and each file's `.before-orrery-<date>` copy.

## Testing

- `npm test` covers the record's reading, the hooks' process checks, the guard, the install and its removal without agy
  (`test/antigravity/`).
- `test/antigravity/real-agy.test.ts` runs the installed, signed-in agy against its real model (Gemini 3.8 Flash low by
  default; `ORRERY_TEST_AGY_MODEL` picks another) with a scratch Orrery config and a scratch workspace whose own
  `.agents/hooks.json` and `mcp_config.json` run this checkout: the instructions and view before the first call,
  recording, the view again after `/compact`, the memory tools, the guard and a plain agy. It costs usage and is
  skipped without agy or a login (`ORRERY_TEST_AGY=0` skips it).

## Limits

- Antigravity changes fast. The record's fields are agy 1.5.13's; an agy that writes them differently isn't recorded.
- A project's own `.agents/hooks.json`, `.agents/mcp_config.json` and `.agents/agents/` load without asking in agy, as
  its own docs say: they are the project's, as Claude Code's project settings are. Agents can't write them, but a
  project you clone may bring them. Orrery has no settings check for Antigravity (Grok has one).
- Between compactions a conversation keeps the view it was given; the memory tools reach what came since.
- A program of yours that writes in Antigravity's folder can make words look like agy's own. The guard keeps agents'
  tools out of it, not a program that builds the path itself.
- Antigravity's hooks file is global: the Antigravity App and its IDE extensions load it too, where Orrery's hooks run
  as in a plain agy (no memory, the plain guard). That was not checked.
- If Orrery's program is deleted without `orrery uninstall`, its hook lines stay and let every tool call through
  unchecked (they answer as if nothing were there), rather than refuse every call in every agy session. Agents can't
  delete it: the guard keeps them out of Orrery's installed program. Uninstall removes the lines.
- `orrery usage` shows only summary tokens for agy conversations, not the conversation's own.
- **macOS is not yet verified.** There Orrery asks `lsof` which files agy holds open, and `ps` for its environment; if
  either can't say, the conversation is not recorded.

For the architecture of hooks and recording across tools, see [the architecture guide](architecture.md).
