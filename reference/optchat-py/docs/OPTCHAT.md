# OptChat setup and implementation

This project implements the core of [Victor Taelin's OptChat specification](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449), retrieved at gist revision `f51fe5c910427fd6f384d22823140b1693c76207`. Existing research notes in this workspace are preserved. The directory did not contain application code or Git metadata when this implementation began.

## Install and run

Use Python 3.11+ on Linux or macOS. The only runtime dependency is HTTPX; `uv.lock` pins the resolved environment.

```bash
uv sync
uv run optchat init --provider anthropic
export ANTHROPIC_API_KEY="your-key"
uv run optchat chat
```

`init` refuses to overwrite an existing configuration. If `optchat.toml` already exists, edit it. For a separate configuration, put the global option before the command:

```bash
uv run optchat --config local.toml init --provider local --model qwen3:8b
uv run optchat --config local.toml chat
```

All paths in a configuration are resolved relative to that configuration's directory. `--chat-dir PATH` overrides just the history location. One chat is one history directory; changing the model or provider does not require moving or converting its records.

For an installed command without `uv run`, use `python -m pip install -e .` in your own virtual environment, then `optchat chat`. To stay attached across laptop disconnections, run the CLI on your server inside your preferred terminal multiplexer and reconnect over SSH. No background service is installed automatically.

## Providers

Each of `[agent]` and `[compactor]` has these settings:

| Setting | Meaning |
|---|---|
| `provider` | `anthropic`, `openai`, `openrouter`, `local`, or `demo` |
| `model` | The exact model identifier accepted by that provider |
| `base_url` | API base, including `/v1`; OptChat appends `/messages`, `/responses`, or `/chat/completions` |
| `api_key_env` | Name of an environment variable; never the key itself |
| `max_tokens` | Maximum output tokens per API step, including provider reasoning budget where applicable |
| `effort` | Reasoning effort; use an empty string to omit it for older models; ignored by `local` |
| `timeout` | HTTP inactivity timeout in seconds, default 180 |
| `explicit_cache` | OpenAI Responses cache controls; disable for models that do not accept them |
| `reasoning_context` | OpenAI Responses reasoning context; `all_turns` by default, empty to omit |

Anthropic uses the Messages API. Both roles default to `claude-sonnet-5-5` at medium effort; you can choose a stronger main model or cheaper compactor separately. Provider-native reasoning and signatures are preserved in RAM for a turn. `--thoughts` displays reasoning exposed by the provider; reasoning is never written to the history or summary tree.

OpenAI uses the Responses API with `store: false`, encrypted reasoning replay, fixed view breakpoints, and `reasoning.context = "all_turns"`. The default `gpt-6.1-sol` supports these controls. For older models, disable unsupported cache/reasoning options explicitly rather than silently dropping context. See [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) and [reasoning state](https://developers.openai.com/api/docs/guides/reasoning).

### OpenRouter

```toml
[agent]
provider = "openrouter"
model = "anthropic/claude-sonnet-5.5"
base_url = "https://openrouter.ai/api/v1"
api_key_env = "OPENROUTER_API_KEY"
effort = "medium"

[compactor]
provider = "openrouter"
model = "anthropic/claude-sonnet-5.5"
api_key_env = "OPENROUTER_API_KEY"
max_tokens = 4096
effort = "medium"
```

```bash
export OPENROUTER_API_KEY="your-key"
uv run optchat chat
```

Select a main model that supports tool calling. The adapter uses OpenRouter's [Chat Completions interface](https://openrouter.ai/docs/api/reference/overview), preserves `reasoning_details` across tool steps, and uses Anthropic cache markers only for `anthropic/` models. Other routes use the selected upstream's automatic caching, when available. See [OpenRouter reasoning](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens) and [prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching). No savings or cache-hit rate are assumed from merely sending these fields.

### Local models

Start an OpenAI-compatible inference server separately. Common endpoint defaults are:

| Server | `base_url` |
|---|---|
| Ollama | `http://localhost:11434/v1` |
| llama.cpp server | Use the host/port you started, followed by `/v1` |
| LM Studio | Use its displayed server address, followed by `/v1` |

```toml
[memory]
view_bytes = 16000
jobs = 1

[agent]
provider = "local"
model = "your-installed-tool-capable-model"
base_url = "http://localhost:11434/v1"
max_tokens = 4096
timeout = 300

[compactor]
provider = "local"
model = "your-installed-summary-model"
base_url = "http://localhost:11434/v1"
max_tokens = 2048
timeout = 300
```

No key is required for `local`; set `api_key_env` if your server needs authentication. Local requests do not contain vendor-specific caching or effort settings. They use streaming Chat Completions, with native tool calling for the main agent. The compactor needs only text generation.

The local initialization preset uses a 16,000-byte view and one compaction job, avoiding eight concurrent generations on one local model. This is a starting point, **not a token-limit guarantee**. Reserve context for system instructions, tools, the full new message, and the growing tool loop. Long pastes and exact zooms still need enough model context. OptChat never silently cuts a user message to make it fit. Small models may produce less useful summaries; inspect the HTML tree and tune your model before relying on its retrieval.

For Ollama, context size is configured on the server/model, not through its OpenAI-compatible API. Its [official compatibility guide](https://docs.ollama.com/api/openai-compatibility) describes creating a Modelfile with `PARAMETER num_ctx`. For example, for an already installed model:

```text
FROM qwen3:8b
PARAMETER num_ctx 32768
```

Save as `Modelfile`, run `ollama create optchat-local -f Modelfile`, then set `model = "optchat-local"`. Choose a context size that your hardware can serve. No model weights are downloaded or inference server installed by this project.

### Mix hosted and local models

Use the OpenRouter `[agent]` section above with the local `[compactor]` section. Set `jobs = 1` and a view budget both models can accept. There is no fallback from a failed local model to a paid provider. Failed summaries retry every ten seconds by default; `/cancel` stops a waiting agent turn and preserves its accepted input.

Copyable complete examples are in `examples/`. They are intended to be copied to the project root as `optchat.toml`; paths stay relative to the copied file.

## Terminal and tools

Output is plain text, with token streaming and normal terminal scrollback. Startup prints the current view. `/help` lists all commands. `/paste` starts a multiline input; `/end` submits it. Text entered during tool work is injected after the outstanding tool results. If no tool boundary remains, it starts a fresh turn.

`/cancel` or Ctrl-C during a turn preserves submitted input, including messages not yet delivered. It does not automatically restart a cancelled task. Ctrl-C while idle or `/quit` exits. Ctrl-D/EOF waits for accepted work. Completed response blocks are saved as they arrive; an incomplete streamed block is not treated as a finished reply or tool call. A process killed before it accepts/records input cannot guarantee recovery of keystrokes still in the terminal or queue.

Memory tools:

- `zoom(id, n)` opens a power-of-two, aligned summary range into its two children. `n = 1` returns the original message, including newlines.
- `date(id)` returns the message's date and local time.

Workspace tools:

- `list_files(path)` lists a directory.
- `read_file(path, start_line, line_count)` reads a UTF-8 range, with 1-based line numbers.
- `write_file(path, content)` atomically creates or replaces a UTF-8 file.
- `run_shell(command, timeout_seconds)` is present only with `[chat] allow_shell = true`.

File paths, including symlinks, must resolve within `[chat] workspace`. The memory directory is protected from file writes. Shell execution is **not sandboxed**: enabling it gives commands the process user's machine access, including paths outside the workspace. Shell output is bounded while read, and timeout/cancellation kills its process group. The main loop has a configurable `max_steps` guard (default 100).

Use `[chat] instructions = "my-instructions.md"` to add your own stable instructions, or let the app load `AGENTS.md` from its configured workspace. The file is read once on startup, keeping the system prompt stable within the process.

## History, import, browser, and backup

```text
chat/
  lock                    kernel-held lifetime writer lock
  profile.json            keeps demo and live summaries separate
  main/YYYY-MM-DD.jsonl    {i, kind, text, size, date}
  tree/YYYY-MM-DD.jsonl    {l, i, text, size}
```

Every record is written with one append write and `fsync`; new stream files also sync their containing directory. Records are immutable. Files are named by the local write day, even for imported old timestamps. The original history is never sent wholesale as the initial prompt; the summaries-only view is used instead.

Malformed JSON is reported and skipped at load. A file missing its final newline has one appended. Global ids are never renumbered. If corruption removes an interior id, or valid records conflict, loading stops rather than associating later messages with the wrong ids. Restore the affected file from backup. After a write/fsync failure, further appends are refused until restart so ids cannot be duplicated.

```bash
uv run optchat import old-notes.txt
uv run optchat import old-chat.jsonl
uv run optchat compact
uv run optchat browse memory.html
uv run optchat backup backup-2026-10-04.tar.gz
```

Plain text imports as one `note`. JSONL accepts `kind`/`text`, or `role`/`content` (`assistant` becomes `talk`). A timezone-aware ISO `date` and an `i` are optional; supplied ids must match the next global ids. The entire input is validated before writing. Import is append-only and is **not deduplicated**; importing the same id-less file twice creates two copies. Import itself makes no model calls. `compact` builds missing summaries and can incur provider charges.

The browser is a self-contained HTML snapshot with current view, every original message, every tree level, timestamps, byte sizes, search, and links from summaries to their children. Logged text is HTML-escaped. It makes no network requests. Open the generated file in any browser.

Backups contain `main/`, `tree/`, and the profile, but no live lock or API keys. They refuse to overwrite an existing archive. Restore into an empty location, then use `--chat-dir` to point at the restored `chat` directory. Configuration should be backed up separately. No automatic remote upload or Git commit is performed; each append is already durably saved. Copy backups to separate storage according to your own retention needs.

The history, exports, and backups can contain everything you tell the agent and everything its tools return. They are private local files; they are not encrypted. Directories and new history/export files use restrictive permissions. The selected provider receives the context needed for inference.

## Memory algorithm and caching

The default constants follow the gist: 512-byte node target, 128,000-byte view budget, eight compaction jobs, five size attempts, ten-second retries, and a 30,000-character workspace tool-result cap. Sizes are UTF-8 bytes; cache marks are characters.

Leaves compress one message; parents merge exactly two adjacent children. If the source fits, it is saved verbatim without inference. Compaction processes leaves in order, while independent ready merges can run concurrently. Every compactor prompt receives the already-summarized view up to its range, with no addressing markers. The compactor sees full source messages. Oversize answers are retried in the same conversation with byte-limit feedback; the shortest attempt is retained, even if slightly oversized.

The view appends leaves and merges the eligible pair with maximum `(T - start) / 2^(level + 2)` until it fits, or no built parent can help. It never splits during a process's lifetime. At restart it replays the same append-and-fit fold over saved records. The byte budget is a target: absent parents, oversized nodes, or an irreducible binary forest can temporarily exceed it. There is no truncation of source messages to enforce that target.

Before a turn, the app waits until every view entry is built, snapshots the view, and only then logs and submits the new user message in full. Each turn constructs a fresh provider session. The tool loop preserves that turn's native assistant output and reasoning only in RAM. Responses and tool activity are appended as completed entries; reasoning never enters the permanent log.

Anthropic and Anthropic routes through OpenRouter get stable cache marks at the last newline before 50k, 80k, and 100k characters, plus automatic request-end caching. Short views skip marks beyond their end. OpenAI Responses uses the same stable split points with its own cache fields and automatic request-end caching. No one-hour TTLs or cache-refresh pings are used. `--verbose` prints API usage, including cache read/write counts when provided. The local adapter leaves cache management to the inference server.

## Deliberate differences and scope

- A POSIX `flock` is used instead of the reference's Unix listening socket. It supplies an atomic single-writer lock, is released by the kernel on crashes, and avoids stale-socket takeover races. The lock file is never deleted. Use a local filesystem with reliable locking and fsync semantics.
- `zoom` returns an exact full message to the model even above the generic tool-output cap. Its duplicate `echo` log is capped. This resolves the spec's tension between “message whole” and capping every result; the original remains stored once in full.
- The local preset reduces the view budget and compactor concurrency. This is explicit configuration, not a different tree algorithm.
- The offline demo uses clearly labeled excerpts, not semantic compression. It has its own directory/profile and cannot be mixed with live summaries.
- The CLI implements its own file/shell tools. Optional subagents, computer use, and an MCP server are outside this implementation.
- The gist's compactor and view prompts are retained; the master prompt omits its paragraph promising background subagent/computer reports because those tools are absent.

## Verification

```bash
uv run python -m unittest discover -s tests -v
uv run ruff check optchat tests
uv run ruff format --check optchat tests
uv build
```

Tests use temporary stores, actual subprocess CLI runs, and HTTP stream fixtures for each provider. They cover byte accounting, append/fsync behavior, recovery, locking, summary ordering, incremental tiling, retries, exact zooms, turn freshness, steering/cancellation, opaque reasoning replay, cache layout, scoped tools, import validation, export escaping, and backups. No paid API calls or local model downloads are required to run them. Real-model accuracy, throughput, long-history scale, and cache economics remain measurements to make on the models and hardware you select.
