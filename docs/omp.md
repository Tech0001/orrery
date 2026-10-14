# Lanes in OMP

OMP (oh-my-pi) runs pi extensions, so a lane works in OMP the way it does in pi: start OMP in the lane's folder and the
Orrery extension gives the agent its memory. Tested with OMP 18.8.7, 18.8.9 and 18.10.2. The guard's path and edit-target rules follow
18.8.7's source, unchanged through 18.10.2. Version 18.10.2 changes native patch placement within a file, not how
target paths are parsed. The isolated real-OMP test passes on 18.10.2.

## Install

The TUI does this for you: run `orrery`, open Tools (4), select OMP and press `I` (or `orrery tools install omp`). By
hand, write a one-line extension file that re-exports Orrery's OMP entry by a relative path:

```bash
mkdir -p ~/.omp/agent/extensions
printf 'export { default } from "%s";\n' "$(realpath --relative-to ~/.omp/agent/extensions ~/.orrery/app/current/extensions/omp.js)" > ~/.omp/agent/extensions/orrery.ts
```

The path must be relative. OMP does not follow an absolute re-export, and Orrery then fails to load ("Cannot find
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
cd ~/code/agent-Atlas && omp
```

Or set the lane's tool to OMP (`E` in the TUI, or `orrery lane set <Lane> --tool omp`) and press `L`.

Everything in [pi.md](pi.md)'s Daily use holds, with these differences:

- The command is `/orrery`, not `/memory`: OMP's own `/memory` comes first. `/compactor` and `/browse` are the same.
  All three are registered when OMP loads Orrery, so they show in OMP's slash autocomplete in every session; outside a
  lane folder they say "no lane memory is open in this OMP".
- The memory tools are `zoom`, `date` and `memory_search`. OMP folds a tool named `search` into its own grep.
- In a lane folder Orrery switches OMP's own features off, for that session only, and writes nothing: OMP's compaction
  (with it `shake` and the frame rescue, which rewrite the session), OMP's memory backend, and auto-titles (their calls
  resend the memory view). In a Claude Code lane, whose `CLAUDE.md` imports `.orrery/view.md`, it also switches off the
  project `CLAUDE.md`, which would put that stale view in the prompt; OMP still loads `AGENTS.md` itself. In other lanes
  OMP loads the project `CLAUDE.md` as usual. This holds for `cd <lane> && omp` and for launches from the TUI alike.
- If an OMP upgrade moved what Orrery uses for that, Orrery still gives memory, says so once, and the footer ends in
  `· OMP settings not applied`. OMP's own compaction and memory may then run as well.
- A message waits at most 25 seconds for pending summaries (OMP drops a hook's answer after 30). Then it goes with "not
  summarized yet" lines, as in pi.
- `/compact` in a lane is cancelled without a notice: OMP does not tell the hook a manual compaction from another.
- Subagents (OMP's task tool) get the path guard and no memory: their messages are not recorded. With OMP's opt-in task
  isolation (`task.isolation.enabled`), a subagent runs in a worktree outside the lane folder (under `~/.omp/wt`) and
  gets no guard either.
- `/fork pane|window|tab` starts a second OMP while the first keeps running. The second runs with the guard only and
  without memory: one writer per lane.
- `/new`, `/resume`, `/fork`, rewinds and branches from `/btw` are recorded once each, as in pi. A `/btw` branch keeps
  the side question and answer it adds.
- `/resume` of a session from another folder, and `/move`, take the session out of the lane folder. Orrery then closes
  the lane's memory (status closed, lock released), switches OMP's own features back on, and says so once. If the new
  folder is a lane's, Orrery opens that lane and records only what comes after the move: the session's earlier turns
  never enter that lane's memory (each lane's memory stays its own). Elsewhere OMP runs plain, without the guard.
- `/resume @claude` of a Claude Code session that the lane's Claude Code already recorded records its turns again: OMP
  gives them new ids.

## One writer

A lane is open in one tool at a time. A second pi, OMP or Claude Code session on the same lane runs without memory and
says so. The TUI shows a lane open in OMP as open in OMP.

## The guard

The path guard covers OMP's tools as it covers pi's: write; edit, also of several files at once; ast_edit, each file,
folder or glob it rewrites; and searches and reads given several paths in one string. OMP's own credential stores are
blocked in every tool, in pi and Claude Code lanes too: `~/.omp/agent/agent.db`, `models.yml`, `.env` and
`secrets.yml`, and `~/.omp/.env`; the same in each profile, in an agent folder `PI_CODING_AGENT_DIR` names, and in the
folder `PI_CONFIG_DIR` moves `~/.omp` to; `agent.db` under `$XDG_DATA_HOME/omp`; and a project's `.omp/secrets.yml`.

Inside Orrery's home (`~/.orrery`), file tools are refused everywhere except reading `app/` and `config.toml`.

It is a credential guard, not a sandbox. `bash` and `eval` get only a check of their text for ssh keys and credential
stores. The check also refuses commands that name Orrery's home (`.orrery`). The code they run can reach any file.
Tools from OMP plugins are not checked.

Where OMP's own parsers may read more than the guard can, the guard refuses rather than guesses. In OMP lanes these
calls are refused, and the model has to rephrase them:

- an edit whose text names a credential file anywhere, its content included;
- an edit with a line that looks like a target (a `[path#TAG]` header, `MV`, a `*** … File:` line) but does not read
  cleanly as one;
- a `file://` path the guard cannot read as a file;
- a search or ast_edit glob with braces (`{a,b}`), or with `..` after a wildcard.

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
  view plus OMP's own prompt is about 44k tokens: use models with a window of 128k tokens or more in lanes.
- In a Claude Code lane, toggling anything in OMP's extensions dashboard can save Orrery's session-only switch
  (`context-file:project:CLAUDE.md` in `disabledExtensions`) into the global OMP config, and then no OMP project loads
  its `CLAUDE.md`. If that happens, remove the entry from `disabledExtensions` in `~/.omp/agent/config.yml`.
- The guard's OMP path rules are pinned to OMP 18.8.7's source, unchanged through 18.10.2: they follow how it reads paths
  and edit targets. A later OMP may read a path differently, and the real-OMP test does not check the guard.
- OMP 18.8.9's opt-in `contextFiles.extra` setting can make OMP load `CLAUDE.local.md`. In a Claude Code lane in a
  shared repo, that file imports Orrery's old view file, so OMP would get a stale second view: Orrery switches off only
  the project `CLAUDE.md`. In lanes, leave `CLAUDE.local.md` out of `contextFiles.extra`.
- OMP's internal URLs (`local://`, `ssh://`, `vault://`, `artifact://` and the like) are judged as file names inside
  the lane: only their names are checked for credential files, not where they lead.
- An edit to a file that does not exist can be moved by OMP, by its `#TAG`, onto a file of the same name the agent read
  in OMP's session scratch space (`local://`). The guard judges the path as written.
- In `read`, the guard splits a list of paths at commas and spaces even inside braces (`{a,b}`), which OMP keeps
  whole. Each piece is judged on its own.

For launching this tool through Ori, see [Ori](ori.md).
