# Agents in OMP

OMP (oh-my-pi) runs pi extensions, so an agent works in OMP the way it does in pi: open it with `orrery agent <Name>`
(or start OMP in its default folder) and the Orrery extension gives OMP the agent's instructions and memory. Tested with OMP 18.8.7, 18.8.9 and 18.10.2. The guard's path and edit-target rules follow
18.8.7's source, unchanged through 18.10.2. Version 18.10.2 changes native patch placement within a file, not how
target paths are parsed. The isolated real-OMP test passes on 18.10.2.

## Install

The TUI does this for you: run `orrery`, open Tools (4), select OMP and press `I` (or `orrery tools install omp`). By
hand, write a one-line extension file that re-exports Orrery's OMP entry by a relative path:

```bash
mkdir -p ~/.omp/agent/extensions
printf 'export { default } from "%s";\n' "$(realpath --relative-to ~/.omp/agent/extensions ~/.orrery/app/current/extensions/omp.js)" > ~/.omp/agent/extensions/orrery.ts
```

Run it in your own terminal: the guard refuses commands that name the installed app folder to an agent's tools. The path
must be relative. OMP does not follow an absolute re-export, and Orrery then fails to load ("Cannot find
package 'smol-toml'").

OMP reads `PI_CODING_AGENT_DIR` when it is set, like pi. pi and OMP then share one extensions folder, and only one of
them can have Orrery: the Tools page says so and does not install the second. Unset `PI_CODING_AGENT_DIR` for one of
them to have both. `PI_CONFIG_DIR` moves OMP's agent folder to `~/$PI_CONFIG_DIR/agent`: the file then goes in that
folder's `extensions` (the Tools page follows it). A named OMP profile (`~/.omp/profiles/<name>/agent`) needs the same
file in its `extensions` folder, by hand.

Orrery needs its config, as in [pi.md](pi.md). The packed extension carries its own dependencies.

To remove Orrery from OMP, delete `~/.omp/agent/extensions/orrery.ts`.

## Daily use

```bash
cd ~/code/some-project && orrery agent Atlas --tool omp
```

Or set the agent's tool to OMP (`C` in the TUI, or `orrery agent set <Name> --tool omp`) and press Enter or `L`, or start
OMP in the agent's default folder.

Which agent a session is works as in pi: `ORRERY_AGENT` when it names a configured agent (`orrery agent` sets it, with
a one-time token the first OMP process claims, so a tool the agent starts itself is not the agent), then the agent
whose default folder holds OMP's folder, then none: a session that is no agent's, where OMP runs without Orrery's
memory and the guard keeps Orrery's own rules (see [The guard](#the-guard)).

The agent's `instructions.md` (up to 32 KB; more is cut, with a notice) goes into OMP's system prompt under
`# Agent: <Name>`, before the memory section, as in pi's [Instructions](pi.md#instructions). OMP takes changed
instructions at its next start.

Everything in [pi.md](pi.md)'s Daily use holds, with these differences:

- The command is `/orrery`, not `/memory`: OMP's own `/memory` comes first. `/compactor` and `/browse` are the same.
  All three are registered when OMP loads Orrery, so they show in OMP's slash autocomplete in every session; when no
  agent is open they say "no agent memory is open in this OMP".
- The memory tools are `zoom`, `date` and `memory_search`. OMP folds a tool named `search` into its own grep.
- In an agent's session Orrery switches OMP's own features off, for that session only, and writes nothing: OMP's compaction
  (with it `shake` and the frame rescue, which rewrite the session), OMP's memory backend, and auto-titles (their calls
  resend the memory view). In a Claude Code agent's folder, whose `CLAUDE.md` imports `.orrery/view.md`, it also switches off the
  project `CLAUDE.md`, which would put that stale view in the prompt; OMP still loads `AGENTS.md` itself. In other folders
  OMP loads the project `CLAUDE.md` as usual. This holds for `cd <folder> && omp`, `orrery agent` and launches from the TUI alike.
- If an OMP upgrade moved what Orrery uses for that, Orrery still gives memory, says so once, and the footer ends in
  `· OMP settings not applied`. OMP's own compaction and memory may then run as well.
- A message waits at most 25 seconds for pending summaries (OMP drops a hook's answer after 30). Then it goes with "not
  summarized yet" lines, as in pi.
- `/compact` in an agent's session is cancelled without a notice: OMP does not tell the hook a manual compaction from another.
- Subagents (OMP's task tool) get the path guard and no memory: their messages are not recorded. With OMP's opt-in task
  isolation (`task.isolation.enabled`), a subagent runs in a worktree outside the agent's folder (under `~/.omp/wt`) and
  gets no guard either.
- `/fork pane|window|tab` starts a second OMP while the first keeps running. The second runs with the guard only and
  without memory: one writer per agent.
- `/new`, `/resume`, `/fork`, rewinds and branches from `/btw` are recorded once each, as in pi. A `/btw` branch keeps
  the side question and answer it adds.
- `/resume` of a session from another folder, and `/move`, take the session out of the folder it was opened in. Orrery then closes
  the agent's memory (status closed, lock released), switches OMP's own features back on, and says so once. If the new
  folder is an agent's default folder, Orrery opens that agent and records only what comes after the move: the session's
  earlier turns never enter that agent's memory (each agent's memory stays its own). Elsewhere OMP runs as a session
  that is no agent's, with Orrery's own guard rules.
- `/resume @claude` of a Claude Code session that the agent's Claude Code already recorded records its turns again: OMP
  gives them new ids.
- With `OMP_TUI_DEBUG` set, OMP opens a local debug socket that types into the session as you would, so whatever comes
  through it would be recorded as your words. Orrery then opens no memory and records nothing in that session, and
  says so: `Orrery: OMP_TUI_DEBUG is set, so anything sent through OMP's debug socket would count as typed; this
  session opens no memory and records nothing.` The guard stays on. Unset it before opening an agent.
- With `/collab` and write access, a guest you invited can send prompts that are recorded as yours: the invitation is
  yours to give.
- An OMP started from an agent's session (from its `bash`, in its folder or another agent's) opens no memory and
  records nothing, and says so; its guard keeps that agent's rules. As in pi, this is decided once per run: such an
  OMP stays without memory after `/new`, in its subagents and after a reload, even once that agent's session has
  ended. `orrery` run from the agent's `bash` (or a `!` command you type) runs only what reads, as in pi: see the
  README's Safety.
- So does an OMP started from a coding tool's session that is no agent's (one that a Claude Code in another project
  starts in an agent's folder), with a notice that names that tool, as in [pi](pi.md#limits). It stays without memory
  for its run, even after a `/move` into an agent's folder. OMP gives its shells no variable of its own, so a process
  detached from a plain OMP is not known as one.
- The reader tools (`agents`, `agent_memory`) come once per run, as in pi: an OMP that first opened an agent with no
  reads gets them only after a restart.

## One writer

An agent is open in one tool at a time. A second pi, OMP, Claude Code, Codex or OpenCode session on the same agent runs
without memory (read-only in Claude Code, Codex and OpenCode) and says so. The TUI shows an agent open in OMP as open in
OMP.

## The guard

The path guard covers OMP's tools as it covers pi's: write; edit, also of several files at once; ast_edit, each file,
folder or glob it rewrites; lsp; and searches and reads given several paths in one string. OMP's own credential stores
are blocked in every tool, in pi and Claude Code sessions too: `~/.omp/agent/agent.db`, `models.yml`, `.env` and
`secrets.yml`, and `~/.omp/.env`; the same in each profile, in an agent folder `PI_CODING_AGENT_DIR` names, and in the
folder `PI_CONFIG_DIR` moves `~/.omp` to; `agent.db` under `$XDG_DATA_HOME/omp`; and a project's `.omp/secrets.yml`.

Inside Orrery's home (`~/.orrery`), file tools are refused everywhere except reading `app/` and `config.toml`. The
config and the installed program are read-only to agents, and setup commands that name the installed app folder are
refused to them: run those in your own terminal. Only an agent's own sessions read its memory view; other agents'
file tools and content searches are refused it. Writes go to the folder the agent was opened in and its
`allowed_roots`.

Tool logins in your home folder are blocked like OMP's: `~/.npmrc`, `~/.pypirc`, `~/.cargo/credentials`,
`~/.gem/credentials`, `~/.config/gcloud`, `~/.azure`, `~/.terraform.d/credentials.tfrc.json`, `~/.wrangler`,
`~/.config/.wrangler` (`~/Library/Preferences/.wrangler` on macOS), `~/.cache/huggingface/token` and `stored_tokens`,
`~/.huggingface/token`, `~/.password-store` and `~/.config/op`. A project's own `.npmrc`, `.pypirc`, `.azure` or `.wrangler` stays open; `bash` and `eval` are refused those four only
when they name them from home (`~/.npmrc`, `$HOME/.npmrc`, the home folder's path).

Secret files in any folder are blocked like credentials: `.env` and `.env.<anything>`, `.dev.vars` and
`.dev.vars.<anything>`, `.secrets`, `secrets.toml`, `master.key` and `.htpasswd` (the shared templates, `.example`,
`.sample`, `.template` and `.dist` after `.env` or `.dev.vars`, stay open). So is everything the config's `[guard]
protect` lists: a path (`/…` or `~/…`, a file or a folder) or a name (every file or folder so named); new configs have
it with examples, and setup adds it once to an older one; see the [README](../README.md#safety). An edit's text may
name those secret files or a protected name, so an edit can add `.env` or `.dev.vars` to a `.gitignore`; an edit that
targets one is refused. A config that cannot be read is handled as in pi: OMP keeps its `[guard] protect` when that
part reads cleanly, and refuses every tool call when it does not; a `[guard] protect` that lists nothing counts as
none.

`ast_edit` over a folder or a glob rewrites files no argument names, so every file below its base is judged as a write,
by every rule (`node_modules` and `.git` included, links judged where they lead): one over a folder that holds a `.env`,
a protected name, another agent's view, OpenCode's config or a skill is refused, and so is one that reaches more than
50,000 files. Give it the files, or a narrower folder. `lsp` is judged by its action: `rename_file` moves a file, or a
folder with every file in it, and both ends are judged as writes; the actions that only read pass; a symbol rename, an
applied code action, a raw request and an action Orrery doesn't know are refused, since the language server then edits
files no argument names. Make those edits with `edit` or `write`.

OpenCode's config and code are read-only to agents here too, as in every tool, and skills are written only as
ordinary files (see the README's Safety):

- No tool writes `opencode.json` or `opencode.jsonc` in any folder, a `.opencode` folder, OpenCode's own config, cache
  and state folders, its database, or its system config: OpenCode loads plugins, runs commands and takes permissions
  from them, with no prompt, the next time it opens that folder. `read` and the searches may read them.
- A skill in `.claude/skills` or `.agents/skills` (OpenCode loads those) may be written whole with `write`; one that
  would open with `---` and anything other than YAML or JSON (`---js`, which OpenCode runs as code) is refused. OMP's
  `edit` can't change a skill: what its edits leave in the file is not worked out, so they are refused there, and so
  is a `write` to part of a file (a `[path#TAG]` header or a selector).
- `bash` and `eval` text that names OpenCode's config (`opencode.json`, `.opencode`, its folders) or a skills folder is
  refused, whatever the command: read them with `read`, `grep` and `find`. The cost: a `grep`, `ls`, `git add` or
  commit message that names one is refused too, and an agent can't set up OpenCode for a project; you do that yourself.
  `AGENTS.md` and `.claude/settings.json` stay writable.

It is a credential guard, not a sandbox. `bash` and `eval` get only a check of their text for ssh keys and credential
stores. The check also refuses commands that name Orrery's home (`.orrery`), except the agent's own `view.md` by its
full path; a search or `ast_edit` root may name that file from `~/` too, since OMP expands `~` in its own process,
where a shell's `export HOME` does not reach. These shell-text rules are a seatbelt. Known limits include variables, `eval`, `cd`, escape codes, brace names split across words, commands that change folder with their own flag (`git -C`, `tar -C`), a swap of the session's own folder in the same command, a shell search of an agent's whole folder, and hard links to a protected file. The code they run can reach any file.
**A search of a folder can still read a `.env` inside it**, or another of those secret files, or a file a protected
name covers; and a command that has a protected name as a word is refused even when it means something else (`git
commit -m "ignore .env"`).
Shell text that runs Orrery's hook plumbing is refused in `bash` and `eval`: the hook commands (`claude-hook`,
`codex-hook`) named anywhere, or Orrery's program with the word `holder`, so an agent cannot feed a hook made-up input
and put words in your mouth in its memory. The cost: a command that only names them is refused too, such as a `grep`
for them or a commit message that mentions one; OMP's own search tools are not read this way.
The same goes for Orrery's commands that agents may not run (all but `help`, `--version`, `status`, `usage`, `browse`
and `compactor`) and for Claude Code's and Codex's session records (`~/.claude/projects`, `~/.codex/sessions`), which
no tool may write: `bash` and `eval` text that runs or names one is refused (README, Safety).
`bash` runs in the folder its `cwd` names, so that folder is judged as a read of it: a credential folder, Orrery's
home or a protected folder as `cwd` is refused. A relative name in the command is then not seen, as after a `cd`.
Tools from OMP plugins are not checked.

**In a session that is no agent's** (OMP started in a folder that is no agent's, without `orrery agent`) the guard
keeps Orrery's own rules only, as in [pi](pi.md#limits): Orrery's home, data folder and logins file, its config and
installed program, and where your agents' sessions load code from outside its home (OMP's and pi's extensions
folders, Claude Code's plugin copy and its records), all read, never written, every agent's memory view, Claude Code's
and Codex's session records, and `bash` and `eval` text that runs or names an `orrery` command other than `help`,
`--version`, `status` and `usage`. A search or `ast_grep` whose folder holds Orrery's home, or a content search whose
folder holds an agent's memory view, is refused: search a narrower folder. Nothing else: no folder limits, no `.env`, home-login or OMP-store rules, no
`[guard] protect`. Two of OMP's own tools differ there:

- `lsp`'s edits (a symbol rename, an applied code action, a raw request) pass, unless the session's folder, or the file
  the action names, holds or is inside Orrery's files (its home, data folder, logins file or installed program): then
  they are refused, and the edit goes through `edit` or `write`.
- A search or `ast_edit` glob may use ordinary braces (`src/**/*.{ts,tsx}`), extended patterns (`@(a|b)`) and
  negations. One is refused when a group holds `/`, `..`, `~` or `$`, is unbalanced, or expands to a path that starts
  somewhere else (`{,}~/x`); `..` after a wildcard is refused as for agents.

The checks OMP's parsers need in every session still apply there: an edit line that looks like a target but doesn't
read cleanly as one, a `file://` path the guard cannot read, and an `ast_edit` that reaches more than 50,000 files.

Where OMP's own parsers may read more than the guard can, the guard refuses rather than guesses. In an agent's OMP
session these calls are refused, and the model has to rephrase them:

- an edit whose text names a credential file (a tool login under home among them) or a `[guard] protect` path
  anywhere, its content included;
- an edit with a line that looks like a target (a `[path#TAG]` header, `MV`, a `*** … File:` line) but does not read
  cleanly as one. Two forms OMP itself accepts are refused this way too: sloppy mode's bare `*** Edit File:` line (which
  goes on with the previous file) and a quoted path followed by ` all`;
- a `file://` path the guard cannot read as a file;
- a search or ast_edit glob with braces (`{a,b}`), or with `..` after a wildcard, and an ast_edit glob with a negation
  (`!…`) or an extended pattern (`@(…)`, `+(…)`);
- an `ast_edit` over a whole repo whose tree links outside the agent's folder (a pnpm `node_modules`, a git worktree)
  or holds a skill or OpenCode's config, even where OMP's own walk would skip those files (it skips `node_modules`,
  `.git` and what `.gitignore` ignores, and follows no links): run it on a narrower folder, such as `src/`, or give it
  the files.

## Upgrading OMP

Orrery relies on a few OMP internals: its pi compatibility layer, tool load modes, the session events, the settings
registry. Before upgrading OMP, run the real-OMP test with the new binary. It runs OMP in a scratch home and never
touches `~/.omp`:

```bash
ORRERY_TEST_OMP=/path/to/new/omp npm test -- test/omp/real-omp.test.ts
```

The test does not check the guard. Its OMP rules mirror OMP's path and edit parsers, so also compare those sources
with the last version checked (18.10.2) before upgrading.

## Limits

- Not yet tried live: subagents, a long session with compaction off, API-key summaries inside OMP, `omp -c`, `/resume`
  of another folder's session and `/move`, branches from `/btw`.
- With OMP's compaction off, a run that overflows the model's window stops with OMP's error, and the next message
  starts a fresh, trimmed run. pi instead compacts once and retries. Orrery trims every run, so this is rare, but the
  view plus OMP's own prompt is about 44k tokens: use models with a window of 128k tokens or more for agents.
- In a Claude Code agent's folder, toggling anything in OMP's extensions dashboard can save Orrery's session-only switch
  (`context-file:project:CLAUDE.md` in `disabledExtensions`) into the global OMP config, and then no OMP project loads
  its `CLAUDE.md`. If that happens, remove the entry from `disabledExtensions` in `~/.omp/agent/config.yml`.
- The guard's OMP path rules are pinned to OMP 18.8.7's source, unchanged through 18.10.2: they follow how it reads paths
  and edit targets. A later OMP may read a path differently, and the real-OMP test does not check the guard.
- OMP 18.8.9's opt-in `contextFiles.extra` setting can make OMP load `CLAUDE.local.md`. In a Claude Code agent's folder in a
  shared repo, that file imports Orrery's old view file, so OMP would get a stale second view: Orrery switches off only
  the project `CLAUDE.md`. For agents, leave `CLAUDE.local.md` out of `contextFiles.extra`.
- OMP's internal URLs (`local://`, `ssh://`, `vault://`, `artifact://` and the like) are judged as file names inside
  the agent's folder: only their names are checked for credential files, not where they lead.
- An edit to a file that does not exist can be moved by OMP, by its `#TAG`, onto a file of the same name the agent read
  in OMP's session scratch space (`local://`). The guard judges the path as written.
- When an edit's target does not exist, OMP may also write the one file of that name it finds deeper under its folder,
  or one read earlier in the session with the same `#TAG`. The guard's name rules (`.env`, a `[guard] protect` name)
  still apply, since the name is the same; its path rules judge the path as written, not the file OMP finds.
- In `read`, the guard splits a list of paths at commas and spaces even inside braces (`{a,b}`), which OMP keeps
  whole. Each piece is judged on its own.

For launching this tool through Ori, see [Ori](ori.md).
