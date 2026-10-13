# OptChat

A working terminal implementation of [Victor Taelin's OptChat specification](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449): one persistent chat, an append-only log, and a binary tree of summaries that the agent can zoom into.

**Providers:** Anthropic, OpenAI Responses, OpenRouter, and local OpenAI-compatible servers (Ollama, llama.cpp, LM Studio). The main agent and compactor are configured independently. Anthropic is the default.

```bash
uv sync
uv run optchat demo
```

The demo needs no API key and uses a separate `.optchat/demo` history. It is a deterministic demonstration of storage and retrieval, **not an AI model**. Type a message, then `zoom 0 1`, `/status`, or `/browse`. Exit with `/quit`.

For real inference, create `optchat.toml` if it does not already exist:

```bash
uv run optchat init --provider anthropic
export ANTHROPIC_API_KEY="your-key"
uv run optchat chat
```

For OpenRouter or local inference, use `--provider openrouter` or `--provider local` when initializing a new configuration, or copy and edit a file from [examples](examples). Keys stay in environment variables. A local server must already be running with the configured model installed.

```bash
# One turn, using the same permanent history:
uv run optchat ask "Remember that the project codename is Cedar."

# These commands never call a model:
uv run optchat status
uv run optchat zoom 0 1
uv run optchat browse memory.html
uv run optchat backup memory-backup.tar.gz
```

The agent has `zoom`, `date`, file reading/writing, and directory listing tools. File tools stay inside the configured workspace and protect the memory directory. Shell execution is available when explicitly enabled in `optchat.toml`.

See the [setup and implementation guide](docs/OPTCHAT.md) for mixed providers, local context sizing, imports, cancellation, caching, and differences from the reference. The optional subagent/computer-use/MCP extensions are not implemented.

```bash
uv run python -m unittest discover -s tests -v
uv run ruff check optchat tests
uv run ruff format --check optchat tests
```

Requires Python 3.11+ on Linux/macOS. Tests cover the memory algorithm, durability, provider request/stream fixtures, and end-to-end CLI behavior. Live inference quality and cache-hit rates require validation against your selected model and account.
