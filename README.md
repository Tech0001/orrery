<p align="center"><img src="assets/orrery.svg" width="140" alt="Orrery"></p>

<h1 align="center">Orrery</h1>

<p align="center"><b>Persistent memory for coding agents, across sessions, models, tools and machines.</b></p>

<p align="center">
  <a href="https://github.com/Tech0001/orrery/actions/workflows/ci.yml"><img src="https://github.com/Tech0001/orrery/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
</p>

<p align="center"><img src="assets/screenshots/agents.png" width="800" alt="The Agents page of the Orrery TUI"></p>

A coding agent forgets everything when its session ends, and a long project outgrows any one conversation. Orrery
gives each of your agents a lasting memory: every message it has seen, plus a tree of summaries over them. The agent
works from a compact view of its whole history and can look up the original messages whenever it needs them.

The memory belongs to the agent, not to a session, a folder or a tool. Start a fresh session, change models, move
from pi to Claude Code, open the agent in another project or carry on from another computer, and it still remembers.

## What you can do

- **Keep one agent across tools.** pi, OMP (oh-my-pi) and Claude Code all read and record the same agent's memory.
  OpenRouter's Ori can launch it too. Codex can be launched but has no memory yet.
- **Open any agent anywhere.** `orrery agent Atlas` starts Atlas's tool in the folder you are in, with its
  instructions and memory. The folder's own `AGENTS.md` or `CLAUDE.md` still applies as that project's rules.
- **Turn existing chats into an agent.** Pick one or more of your Claude Code or Codex chats from a list and they
  become an agent that remembers those conversations. The chats themselves are only read, never changed.
- **Give each agent its instructions.** Who it is and how it works, sent to the model ahead of its memory.
- **Choose how summaries are paid for.** Sign in with your ChatGPT account (the one Codex uses) or OpenRouter, use an
  OpenAI, Anthropic or OpenRouter API key, or run a local model server. See [Summaries](#summaries).
- **Let agents read each other.** An agent you allow can look up other agents' memory, read-only.
- **Compact Claude Code sessions for free.** With the optional mod, Claude Code's compaction is answered from the
  agent's memory: about two seconds, no additional tokens.
- **Take an agent to another computer.** Keep its memory on your own SSH server or a Cloudflare Worker, encrypted
  before it leaves your machine.
- **Back up and restore.** `orrery backup` snapshots every agent (on Linux, a systemd timer can run it nightly), and
  `orrery restore` puts one back.
- **See what it costs.** Tokens per agent and day, with cache hits and cost.
- **Install once, update in place.** One program, with no Node, npm or Git needed; `orrery update` and rollback.

## Screens

| Agent details | Logins and remotes |
| --- | --- |
| <img src="assets/screenshots/agent.png" alt="One agent's instructions, memory, summary model, backup and token use"> | <img src="assets/screenshots/logins.png" alt="Summary sign-ins, API keys and memory remotes"> |
| **Usage** | **Tools** |
| <img src="assets/screenshots/usage.png" alt="Tokens per agent and day, with cache hits and cost"> | <img src="assets/screenshots/tools.png" alt="Installed coding tools and the state of Orrery in each"> |

## Quick start

You need:
- Linux or macOS, x64 or arm64. On Windows, use WSL. Alpine and other musl Linux is not supported yet.
- At least one coding tool: pi, OMP or Claude Code, installed on its own.
- A way to make summaries: a ChatGPT or OpenRouter account, an API key, or a local model server (see
  [Summaries](#summaries)).

**1. Install.**

```bash
curl -fsSL https://github.com/Tech0001/orrery/releases/latest/download/install.sh | sh
```

The script checks the download, installs Orrery into `~/.orrery`, and asks before connecting it to each coding tool
it finds. It puts the `orrery` command in `~/.local/bin`; add that folder to your PATH if it is not there already.

**2. Start Orrery.**

```bash
orrery
```

The first run asks where to keep memory, your first agent's name, its folder and tool, and how to make summaries: a
sign-in or an API key. For a local model server instead, add it to `~/.orrery/config.toml` first, as
[Summaries](#summaries) shows, and add the agent with **N**.

**3. Open your agent.** On the **Agents** page, select it and press **Enter**. If you started Orrery outside the
agent's folder, it asks whether to open the agent here or there. Its tool starts; quit the tool to come back.

**4. Add more.** Press **N** for a new agent. Start it empty, turn an existing Claude Code or Codex chat into it, or
(once you have a remote) fetch one from another computer.

### Getting around the TUI

| Page | Keys |
| --- | --- |
| **1 Agents** | **Enter** open · **i** details · **N** new · **M** summary model · **E** instructions · **C** settings · **s** sort · **/** filter. On an agent's details: **B** browse its memory, **A** archive it |
| **2 Logins** | **A** add or replace a sign-in or key · **T** test · **D** remove · **R** add a remote |
| **3 Usage** | **+** / **-** more or fewer days |
| **4 Tools** | **Enter** details · **I** install or repair Orrery's side of pi, OMP or Claude Code |

**?** shows help on any page and **q** quits. Nearly everything the TUI does can also be done from the command line;
`orrery help` lists the commands, and `orrery help <command>` every option of one.

## Agents

An agent is a name, instructions, memory and settings, all kept in `~/.orrery`:

    ~/.orrery/
      config.toml               settings: one [agents.<Name>] section per agent
      agents/<Name>/
        instructions.md         who the agent is
        memory.sqlite           what it remembers

**Instructions.** Edit them with **E** in the TUI or `orrery agent edit Atlas`. They reach the model ahead of the
memory, up to 32 KB. Only you edit them: an agent can suggest a change in chat but cannot make it.

**Default folder.** An agent can have one (`folder = "…"`, or **C** in the TUI). Starting its tool there, or in any
folder inside it, picks that agent automatically, as if you had run `orrery agent`. Choose a folder that belongs to
the agent, not a broad one like your home folder, or every session under it records into that agent. With no default
folder, the agent opens only through Orrery. Claude Code needs one setup step per agent first; see
[Coding tools](#coding-tools).

**Importing chats.** **N**, then **From an existing chat**, lists your Claude Code and Codex chats, newest first,
and marks the ones written to in the last ten minutes as in use. Pick one, or mark several with Space and they are
combined in time order. Orrery reads them, shows a short report, and creates the agent. Its memory builds in the
background, the agents list shows the progress, and the agent opens once the build is done. An import is a
snapshot: anything said in those chats later is not in the agent. From the command line, `orrery import` can also
gather a whole project's Claude Code and Codex history; see `orrery help import`.

**Reading other agents.** In the agent's `[agents.<Name>]` section of `config.toml`, `reads = ["Atlas", "Birch"]`
(or `["*"]` for all) lets it use the `agents` and `agent_memory` tools to look into those agents' memory, read-only.

**One session at a time.** An agent records from one session. A second session on the same agent runs without its
memory in pi and OMP, and read-only in Claude Code.

**Archiving.** **A** on a closed agent's page takes it out of the list; its memory stays on disk.

## Summaries

Each agent has two models: the one you chat with, chosen in your coding tool, and the one that writes its summaries,
chosen in Orrery. They are independent: change either one and the memory stays the same.

| Summaries from | Set up with | Notes |
| --- | --- | --- |
| Your ChatGPT account (the sign-in Codex uses) | `orrery login openai` | Opens your browser; `--manual` to paste the result over SSH |
| OpenRouter | `orrery login openrouter` | Signs in and saves an OpenRouter key |
| An API key: OpenAI, Anthropic or OpenRouter | `orrery login --key anthropic` | Typed into a hidden prompt; `--from-pi` copies a key pi already has |
| A local model server | `[[providers]]` in `config.toml` | Any OpenAI-compatible server, such as llama.cpp |

The **Logins** page does the same. Orrery keeps its own logins, separate from your coding tools', in a private file
(mode 0600).

To choose an agent's summary model, press **M** on the Agents page, or use `orrery compactor Atlas` to see its
current one, `orrery compactor Atlas signin` (or `key`, `local`) to list choices, and, for example,
`orrery compactor Atlas key anthropic/<model>` to switch. The new model is tested with a real call first; if that
fails, the agent keeps the old one.

A local server looks like this in `config.toml`:

```toml
[[providers]]
id = "llama"
base_url = "http://127.0.0.1:8080/v1"
models = [{ id = "my-model", context_window = 32768, max_tokens = 8192 }]
```

`orrery compactor Atlas local llama/my-model` then switches to it. If the server needs a key, `api_key_env = "NAME"` sends
the one in that environment variable.

## Coding tools

| Tool | What Orrery adds | Guide |
| --- | --- | --- |
| pi | An extension: memory, recording, the memory tools and `/compactor` | [docs/pi.md](docs/pi.md) |
| OMP (oh-my-pi) | The same, through OMP's own extension entry; `/orrery` and `/compactor` | [docs/omp.md](docs/omp.md) |
| Claude Code | A plugin with hooks and memory tools, plus an optional mod for the system prompt and compaction | [docs/claude-code.md](docs/claude-code.md) |
| Ori | Launches the agent with an OpenRouter model; Orrery keeps the memory | [docs/ori.md](docs/ori.md) |
| Codex | Launch only, no memory yet | |

Connect a tool with **I** on the **Tools** page, or `orrery tools install pi`. Each guide lists the versions tested
and the known limits. Claude Code needs one more step per agent before it records, described in its guide:
`orrery claude-setup Atlas` loads the memory in the agent's default folder, and `--mod` loads it through the mod,
which also lets Claude Code open the agent in any folder.

The Claude Code desktop app works too: after `orrery claude-setup <Name>`, start a session in the agent's folder, and
the app's Claude Code records it and loads the memory (tested with the Linux app). Claude Code on the web runs in the
cloud and can't reach the memory on your machine.

## If you are an agent helping someone with Orrery

The TUI is for people; you have the command line. `orrery help all` lists every command and option. Start here:

| To | Run |
| --- | --- |
| See every agent, whether it is open, and its memory and summary state | `orrery status --json` |
| See which coding tools are installed and connected | `orrery tools --json` |
| See which sign-ins and keys are saved (never the keys themselves) | `orrery logins --json` |
| See token use and cost | `orrery usage --json` |
| Add an agent, or change its folder, tool or settings | `orrery agent add …`, `orrery agent set …` |
| See or switch an agent's summary model | `orrery compactor <Name> …` |
| Preview importing chats into an agent | `orrery import <Name> --dry-run …` |

Leave these to the person, in their own terminal:

- **Sign-ins and API keys.** `orrery login` opens a browser, and `orrery login --key` asks for the key in a hidden
  prompt. Never ask for a key in chat.
- **Instructions.** `orrery agent edit` needs a terminal, and an agent's instructions are its person's to change.
- **Installing, updating and uninstalling.** These ask questions on the terminal and replace the program you are
  running on.
- **Committing an import.** Show the person the dry-run report, and run `orrery import <Name> --commit <preview file>`
  only once they have read it.

Orrery's own files are off-limits to agents: your tools are refused anywhere in `~/.orrery`, except that file tools may
read the config and the installed program, and shell commands that name `.orrery` are refused. Ask the CLI instead.
Your own memory has its own tools: `zoom`, `date` and `search` (`memory_search` in OMP).

## Memory that follows you

Push a closed agent to a remote, then pull it on another computer:

```bash
orrery agent push Atlas --to home      # on the first computer
orrery agent pull Atlas --from home    # on the second
```

A remote is a folder on your own SSH server or a Cloudflare Worker (`orrery remote add`). Memory and instructions are
encrypted before upload with a recovery code that only you keep. One computer writes at a time, and another can take
over. See [remote agents](docs/remote.md).

## Backups

`orrery backup` snapshots every agent's memory and instructions into `~/.orrery/backups/` and keeps 14 days.
To put one back, close the agent first, then run `orrery restore Atlas --from 2026-10-01`. It keeps the agent's current
instructions if it has any. On Linux, a systemd timer can run
the backup every night and copy it to another machine over SSH; on macOS, run it yourself for now. See
[deployment and backups](docs/deploy.md).

## Updating and uninstalling

```bash
orrery update              # install the latest release
orrery install --rollback  # go back to the previous version
orrery uninstall           # remove the program; memory, config and logins stay
```

Agents that are open keep their version until they restart. The Agents page says when one is waiting, and the pi, OMP
or Claude Code session says once: "Orrery was updated to 0.6.2; restart this session to use it." Orrery checks for a
new release at most once a day, shared by the TUI and every agent's session (pi, OMP, and Claude Code's recorder); the
TUI header and each session then say once that it is out. A session never waits on the check: it shows what the last
one found, and a newer answer when it comes. The check is one request to `github.com`, which sees your IP address;
`check = false` under `[updates]` in `config.toml` turns it off, and the release notice with it (the restart notice
needs no request and stays). Notices reach you, never the model. `orrery uninstall --purge` also deletes `~/.orrery`,
after you type `delete`.

The install script also takes `--yes` (answer every question yes; with no terminal and no `--yes`, it skips the
questions, lists them and exits non-zero), `ORRERY_VERSION` (a specific release) and `ORRERY_HOME` (somewhere other
than `~/.orrery`; set it in your shell profile too, since every `orrery` run and coding tool reads it):
`curl -fsSL … | ORRERY_VERSION=0.6.0 sh -s -- --yes`.

## How it works

Each message is appended to the agent's own SQLite file. In the background, a summary model builds a binary tree of
summaries over those messages. The agent receives a 64–128 KB view: recent messages word for word, older ones as
summaries that get coarser with age. Between rebuilds, new lines only extend the view, so providers can serve most
of the prompt from cache. The [architecture guide](docs/architecture.md) covers the store, the view, scheduling and
the trade-offs.

## Safety

Orrery guards credentials: an agent's tool calls that would read key files, your logins or another agent's memory are
refused, and Orrery's own config and program are read-only to agents. An agent's file edits also stay inside the
folder it was opened in; `allowed_roots = ["/abs/path"]` in its `[agents.<Name>]` section adds more. **It is a guard, not a sandbox.** It checks
file paths and the text of shell commands, so a determined program can get around it; the
[architecture guide](docs/architecture.md#the-credential-guard) lists the known limits.

Logins are kept in private files (mode 0600), never in the config. Your agents' memory on disk is not encrypted;
copies sent to a remote are. Model providers see whatever context is sent to them, memory included.

## Development

From a checkout (see [CONTRIBUTING.md](CONTRIBUTING.md#setup)):

```bash
npm run check           # TypeScript and the full test suite
npm run test:binary     # the compiled program; needs Bun (see .bun-version)
npm run test:bun-suite  # the full suite on Bun
npm run demo            # the TUI with five fictional agents: no model calls, nothing of yours touched
```

The suite has more than 2,000 tests and uses synthetic data only. Tests against real pi, OMP and Ori run when those
programs are installed; CI runs the suite on Node 22.19 and 24 and on macOS. [CONTRIBUTING.md](CONTRIBUTING.md) covers
bug reports, pull requests and the real-tool tests; [SECURITY.md](SECURITY.md) says how to report a security problem
privately.

## Credits

The memory design follows [OptChat by Victor Taelin](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449).
Orrery builds on [pi](https://github.com/earendil-works/pi) and integrates with
[oh-my-pi](https://github.com/can1357/oh-my-pi). The Python reference in [reference/optchat-py](reference/optchat-py)
is used for behavioral parity tests.

## License

MIT. See [LICENSE](LICENSE).
