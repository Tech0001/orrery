# Launching agents through Ori

Ori launches an agent with OpenRouter models. Orrery keeps the memory in the agent, so changing the agent's model
keeps the same memory. Ori and Orrery have separate jobs and separate sign-ins.

## Setup

Install Ori using its [official instructions](https://openrouter.ai/docs/guides/ori/harness):

```bash
curl -fsSL https://openrouter.ai/labs/ori/install.sh | bash
ori login
```

Install the agent too: [pi](pi.md), [OMP](omp.md), [Claude Code](claude-code.md) or [Codex](codex.md). In Orrery's
Tools page, install Orrery's extension or plugin for that agent (Codex needs none). Ori adds its own extension or
settings when it launches the agent.
The Ori row shows its path and an offline version check. Sign-in shows `unknown`: Ori 0.15.7 has no public auth
command guaranteed to stay offline. Enter shows the install and login commands; Orrery does not run them for you.

Set an agent's launcher with C in the TUI, or:

```bash
orrery agent set Atlas launcher ori
orrery agent set Atlas ori_model openai/gpt-4.1-mini
orrery agent Atlas
```

N offers “Launch through Ori?” when Ori is on PATH; the default is No. The Agents table shows `pi · Ori`, and the
agent page shows the selected model. The config form is:

```toml
[agents.Atlas]
folder = "/absolute/path/to/project"
tool = "pi"
launcher = "ori"
ori_model = "openai/gpt-4.1-mini"
compactor_model = "openrouter/openai/gpt-4.1-mini"
```

`ori_model` is optional. Without it, Ori picks the model. `launcher` is optional too; absent means `direct`.
`--launcher` and `--ori-model` are equivalent CLI flags. An empty edit clears either key:

```bash
orrery agent set Atlas ori_model ''
orrery agent set Atlas launcher ''
```

`orrery agent set Atlas launcher direct` sets the key explicitly to `direct`; it does not clear it.

Launch mapping: `pi` → `ori pi`, `omp` → `ori omp`, `claude-code` → `ori claude`, `codex` → `ori codex`.
The folder, existing setup checks, terminal handover and exit status handling are the same as direct launches.
For Codex, Orrery's hooks, memory server and instructions follow `ori codex` as they follow `codex` in a direct launch,
after the same hook check; a Codex session through Ori has not been checked yet. If Ori is missing, Orrery refuses the
launch and names this document.

OpenCode agents are not launched through Ori yet: Ori starts OpenCode its own way, with config of its own that Orrery
has not checked, so `orrery agent` refuses an OpenCode agent whose launcher is `ori` and says to set it to `direct`.

## Sign in for summaries

For agents with `launcher = "ori"`, Orrery's cloud summaries use only its own saved logins. They ignore
`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` from the environment. The same rule applies when
Ori's `ORI_OPENROUTER_SESSION_ID` launch marker is present, including a hand-typed `ori pi`. They do not read
Ori's credentials or call its credential helper. Direct agents without the marker keep their environment fallback.
Choose **Sign in → OpenRouter** in Logins or `/compactor`, or run:

```bash
orrery login openrouter
orrery login openrouter --manual
orrery logins
```

The browser authorizes Orrery through [OpenRouter's public PKCE flow](https://openrouter.ai/docs/guides/overview/auth/oauth).
`--manual` (also `--no-browser`) prints the link without opening a browser. Over SSH, paste the final redirect URL
or code into the terminal on the remote machine. Esc/Ctrl-C cancels and releases the loopback callback port.
Closing stdin does not cancel browser sign-in; it keeps waiting for the callback, cancellation or timeout.

This issues an ordinary OpenRouter API key, saved in Orrery's credential file with mode 0600. It uses the same
slot as `orrery login --key openrouter`. Both Logins rows show `from sign-in` or `pasted key`; replacing a key
from the other origin says so. Removing either row removes the shared key. OpenRouter summaries are billed as
API usage, including when their key came from sign-in. A model is tested before Orrery switches summaries to it.

In Claude Code, `/orrery:compactor signin openrouter` lists models after login. If no key is saved, the text
command gives the terminal login command; sign in there and repeat it. Plugin command expansion cannot host an
interactive sign-in prompt. Interactive pi/OMP pickers and the TUI can sign in within the picker.

## Privacy and limits

Orrery inherits the user's environment when launching an agent. Ori's own defaults therefore apply. Ori 0.15.7
has telemetry on by default; `ORI_TELEMETRY=0` disables it. `ori claude` also syncs cloud sessions by default;
`ORI_CLAUDE_CLOUD_SESSION_SYNC=0` disables that. To disable update checks and updates, set
`ORI_NO_UPDATE_CHECK=1 ORI_DISABLE_UPDATES=1`. Orrery's own probes use these four privacy flags.

Ori empties non-OpenRouter providers in pi's session registry. Orrery uses a separate summary registry, so its
Anthropic, OpenAI and OpenRouter summary catalogs remain available. Catalog availability does not supply a
login: save one in Orrery. Without a saved OpenRouter key, its Sign in row shows `not signed in` and the picker
offers Orrery's sign-in even when Ori exported a key for the agent.

Tested launcher: Ori 0.15.7. The hermetic real-Ori test proves both extensions load in `ori pi`, their status keys
coexist, Orrery commands register, and summary catalogs survive provider suppression. No model call is needed. A scratch live pi check also confirmed recording, `/compactor` cancellation and recall
after switching from `openai/gpt-4.1-mini` to `google/gemini-2.5-flash-lite`. Model-driven `zoom` recall still needs
a successful live check: the model selected an invalid span; a direct read-only zoom returned the stored fact.

**OMP compatibility limit:** Ori 0.15.7 fails before starting OMP 18.8.7, 18.8.9 and 18.10.2. Its extension registers a
bundled `judge` model using the OpenRouter chat API, which OMP rejects. Direct OMP remains supported. The real-Ori
test reports this exact upstream incompatibility as a named skip; `ORRERY_TEST_ORI_STRICT=1` makes it fail. Ori's
OMP extension in this version also provides no separate footer key. Do not assume the two pi footers exist in OMP.

`ori claude` can change Claude Code's auto-compaction window by seeding its model cache. The Orrery mod's
compaction behavior under it still needs the manual check below, and so does Codex through Ori.

## Checks

```bash
npm test -- test/ori/real-ori.test.ts
ORRERY_TEST_ORI=/path/to/ori ORRERY_TEST_OMP=/path/to/omp npm test -- test/ori/real-ori.test.ts
```

The tests use scratch HOME/XDG/config folders and a fake OpenRouter service. Without the binaries they skip.
They never sign in, install extensions globally, or make a live model call.

For a manual memory check, create a scratch agent and point `ORRERY_CONFIG` at its scratch config. Use a private
tmux server, a scratch pi/OMP agent directory and `-e /path/to/orrery/src/pi/index.ts` (or `src/omp/index.ts`) from a checkout.
With the four privacy flags above, launch `ori pi --model <cheap-model>`. State a synthetic fact, ask a second
turn to recall it using `zoom`, open `/compactor`, cancel with Esc, and quit. Start a new session with a different
`--model` and ask it to recall the fact. Do the same in `ori omp` after the upstream startup problem is fixed.
Use at most twelve live turns for the whole check. Never use a real agent for this test.

For the owner to check **Claude Code**: use a scratch agent with Orrery's plugin and mod wired as described in
[claude-code.md](claude-code.md). With the four privacy flags, launch `ori claude --model <cheap-model>` from that
agent's folder. Check the Orrery footer, two-turn recording and `zoom`, `/orrery:compactor`, then quit and recall the fact in
a new model session. Check that the mod still decides when to compact. Ori writes the real `~/.claude.json`
model cache in an ordinary launch; this manual check is deliberately left to the owner. Keep its agent data and
Orrery config in scratch folders, and list `~/.ori` filenames before and after without reading auth files.
