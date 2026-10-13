"""Plain terminal frontend; no TUI redraws, no lost scrollback."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shlex
import signal
import sys
import threading
from dataclasses import replace
from pathlib import Path

from .compactor import Compactor, DemoSummarizer, ModelSummarizer
from .config import DEFAULTS, ModelConfig, config_template, load_config
from .engine import Engine
from .export import backup, export_html
from .memory import Memory
from .providers import make_provider
from .storage import KINDS, Store, StoreError, valid_date
from .tools import Toolset

HELP = """Commands:
  /help                 Show this help
  /status               Memory size and compactor status
  /view                 Show the agent's memory view
  /zoom ID N            Open a summary, or N=1 for the original message
  /date ID              Show a message timestamp
  /browse [FILE]        Export a local HTML memory browser
  /paste ... /end       Enter a multiline message
  /cancel               Cancel the turn; keep accepted messages
  /quit                 Save and exit (also Ctrl-D after pending work finishes)
You can type a new message while the agent works. It arrives at a tool boundary.
"""


class Terminal:
    def __init__(self, *, thoughts=False, verbose=False):
        self.thoughts = thoughts
        self.verbose = verbose
        self.streaming = False
        self.channel = None

    def notice(self, text: str):
        if self.streaming:
            print(flush=True)
            self.streaming = False
        print(f"[{text}]", file=sys.stderr, flush=True)

    async def event(self, kind: str, text: str):
        if kind in ("talk_delta", "thought_delta"):
            if kind == "thought_delta" and not self.thoughts:
                return
            if self.channel != kind:
                if self.streaming:
                    print(flush=True)
                print("OptChat: " if kind == "talk_delta" else "Thinking: ", end="", flush=True)
                self.channel = kind
            print(text, end="", flush=True)
            self.streaming = True
        elif kind in ("talk", "thought"):
            if self.streaming:
                print(flush=True)
            elif text and (kind == "talk" or self.thoughts):
                print(("OptChat: " if kind == "talk" else "Thinking: ") + text, flush=True)
            self.streaming = False
            self.channel = None
        elif kind == "tool":
            self.notice(f"tool {text[:500]}")
        elif kind == "echo" and self.verbose:
            self.notice(text)
        elif kind == "usage" and self.verbose:
            self.notice(f"usage {text}")
        elif kind in ("status", "error"):
            self.notice(f"{kind}: {text}")
        elif kind == "turn_end":
            if self.streaming:
                print(flush=True)
            self.streaming = False
            self.channel = None
            if sys.stdin.isatty():
                print("you> ", end="", flush=True)


def parser():
    cli = argparse.ArgumentParser(description="OptChat — one endless chat with tree memory")
    cli.add_argument("--config", type=Path, default=Path("optchat.toml"))
    cli.add_argument("--chat-dir", type=Path, help="override the persistent history directory")
    sub = cli.add_subparsers(dest="command", required=True)
    init = sub.add_parser("init", help="write a configuration (never overwrites)")
    init.add_argument("--provider", choices=DEFAULTS, default="anthropic")
    init.add_argument("--model")
    init.add_argument("--base-url")
    for name in ("chat", "ask", "demo"):
        cmd = sub.add_parser(
            name,
            help={
                "chat": "start the interactive agent",
                "ask": "run one turn",
                "demo": "try isolated, deterministic offline memory",
            }[name],
        )
        if name == "ask":
            cmd.add_argument("message")
        cmd.add_argument(
            "--thoughts", action="store_true", help="display provider reasoning; never log it"
        )
        cmd.add_argument("--verbose", action="store_true", help="show tool results and API usage")
    sub.add_parser("status", help="inspect memory without making API calls")
    sub.add_parser("view", help="print the current memory view")
    zoom = sub.add_parser("zoom", help="read original messages or summary children")
    zoom.add_argument("id", type=int)
    zoom.add_argument("n", type=int, nargs="?", default=1)
    date = sub.add_parser("date", help="read a message timestamp")
    date.add_argument("id", type=int)
    browse = sub.add_parser("browse", help="write a self-contained HTML memory browser")
    browse.add_argument("output", type=Path, nargs="?", default=Path("memory.html"))
    archive = sub.add_parser("backup", help="snapshot history and summaries to a new tar.gz file")
    archive.add_argument("output", type=Path)
    ingest = sub.add_parser("import", help="append .jsonl messages or a plain-text note")
    ingest.add_argument("source", type=Path)
    ingest.add_argument("--kind", choices=sorted(KINDS), default="note")
    sub.add_parser("compact", help="build every missing summary, then exit (may use paid APIs)")
    return cli


def ingest(memory: Memory, source: Path, default_kind="note") -> int:
    if source.suffix == ".jsonl":
        records = [json.loads(line) for line in source.read_text().splitlines() if line.strip()]
    else:
        records = [{"kind": default_kind, "text": source.read_text()}]
    prepared = []
    # Validate the ENTIRE input before appending any part of it.
    for offset, item in enumerate(records):
        if not isinstance(item, dict):
            raise TypeError(f"Import record {offset} must be an object")
        text = item.get("text", item.get("content"))
        kind = item.get("kind", item.get("role", default_kind))
        kind = {"assistant": "talk"}.get(kind, kind)
        if not isinstance(text, str) or kind not in KINDS:
            raise ValueError(f"Import record {offset} needs string text and a supported kind")
        id = item.get("i", len(memory.store.root) + offset)
        if type(id) is not int or id != len(memory.store.root) + offset:
            raise ValueError(
                f"Import id {id} would renumber history; expected {len(memory.store.root) + offset}"
            )
        date = item.get("date")
        if date is not None:
            valid_date(date)
        prepared.append((kind, text, date))
    for kind, text, date in prepared:
        memory.append(kind, text, date)
    return len(prepared)


def profile(store: Store, demo: bool):
    path = store.path / "profile.json"
    mode = "demo" if demo else "live"
    if path.exists():
        if json.loads(path.read_text()).get("mode") != mode:
            raise ValueError("Demo and live summaries cannot share a history directory")
    else:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as handle:
            json.dump({"version": 1, "mode": mode}, handle)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        store._sync_directory(store.path)


async def interactive(engine, compactor, memory, terminal):
    queue = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def input_thread():
        # A daemon reader works with terminals, pipes AND redirected regular files.
        # It never writes history and does not keep the process alive on /quit.
        try:
            for line in sys.stdin:
                try:
                    loop.call_soon_threadsafe(queue.put_nowait, line.rstrip("\n"))
                except RuntimeError:
                    return  # The CLI exited while the daemon reader was still blocked.
        finally:
            if not loop.is_closed():
                loop.call_soon_threadsafe(queue.put_nowait, None)

    threading.Thread(target=input_thread, daemon=True).start()
    loop.add_signal_handler(
        signal.SIGINT, lambda: queue.put_nowait("/quit" if engine.idle.is_set() else "/cancel")
    )
    loop.add_signal_handler(signal.SIGTERM, lambda: queue.put_nowait("/quit"))
    print(HELP)
    print(memory.render())
    if sys.stdin.isatty():
        print("you> ", end="", flush=True)
    paste = None
    try:
        while True:
            line = await queue.get()
            if line is None:
                if paste:
                    engine.submit("\n".join(paste))
                await engine.idle.wait()
                break
            if paste is not None:
                if line in ("/quit", "/exit"):
                    if paste:
                        memory.append("user", "\n".join(paste))
                    await engine.cancel()
                    break
                elif line == "/end":
                    engine.submit("\n".join(paste))
                    paste = None
                elif line == "/cancel":
                    if paste:
                        memory.append("user", "\n".join(paste))
                    paste = None
                    terminal.notice("Paste cancelled; text preserved in history")
                else:
                    paste.append(line)
                continue
            if not line.startswith("/"):
                engine.submit(line)
                continue
            try:
                parts = shlex.split(line)
                if not parts:
                    continue
                command, args = parts[0], parts[1:]
                if command in ("/quit", "/exit"):
                    await engine.cancel()
                    break
                if command == "/help":
                    print(HELP)
                elif command == "/cancel":
                    await engine.cancel()
                elif command == "/paste":
                    paste = []
                    terminal.notice("Paste text, then /end on its own line")
                elif command == "/status":
                    print(
                        json.dumps(
                            memory.stats()
                            | {"busy": len(compactor.busy), "retrying": len(compactor.failed)},
                            indent=2,
                        )
                    )
                elif command == "/view":
                    print(memory.render())
                elif command == "/zoom" and 1 <= len(args) <= 2:
                    print(memory.zoom(int(args[0]), int(args[1]) if len(args) > 1 else 1))
                elif command == "/date" and len(args) == 1:
                    print(memory.date(int(args[0])))
                elif command == "/browse" and len(args) <= 1:
                    print(export_html(memory, Path(args[0] if args else "memory.html")))
                else:
                    terminal.notice("Unknown command or arguments; see /help")
            except (ValueError, OSError) as exc:
                terminal.notice(str(exc))
    finally:
        loop.remove_signal_handler(signal.SIGINT)
        loop.remove_signal_handler(signal.SIGTERM)


async def run(args) -> int:
    if args.command == "init":
        args.config.parent.mkdir(parents=True, exist_ok=True)
        with args.config.open("x") as handle:
            handle.write(config_template(args.provider, args.model, args.base_url))
        print(
            f"Wrote {args.config}. Edit [agent] and [compactor] independently, then run: uv run optchat chat"
        )
        return 0
    config = load_config(args.config)
    if args.command == "demo":
        config = replace(
            config,
            directory=args.config.parent / ".optchat/demo",
            agent=ModelConfig(provider="demo"),
            compactor=ModelConfig(provider="demo"),
        )
    if args.chat_dir:
        config = replace(config, directory=args.chat_dir.resolve())
    terminal = Terminal(
        thoughts=getattr(args, "thoughts", False), verbose=getattr(args, "verbose", False)
    )
    active = args.command in ("chat", "ask", "demo", "compact")
    agent_provider = compact_provider = engine = compactor = None
    try:
        if active:
            if (config.agent.provider == "demo") != (config.compactor.provider == "demo"):
                raise ValueError("The offline demo must use demo for both models")
            # Validate credentials before making any changes to the history.
            if args.command != "compact":
                agent_provider = make_provider(config.agent)
            compact_provider = make_provider(config.compactor)
        with Store(config.directory, terminal.notice) as store:
            memory = Memory(store, config.memory.view_bytes)
            if not active:
                if args.command == "status":
                    print(json.dumps(memory.stats(), indent=2))
                elif args.command == "view":
                    print(memory.render())
                elif args.command == "zoom":
                    print(memory.zoom(args.id, args.n))
                elif args.command == "date":
                    print(memory.date(args.id))
                elif args.command == "browse":
                    print(export_html(memory, args.output))
                elif args.command == "backup":
                    print(backup(memory, args.output))
                elif args.command == "import":
                    print(
                        f"Imported {ingest(memory, args.source, args.kind)} messages. Run `optchat compact` to summarize."
                    )
                return 0
            profile(store, config.compactor.provider == "demo")
            summarizer = (
                DemoSummarizer(config.memory.node_bytes)
                if config.compactor.provider == "demo"
                else ModelSummarizer(compact_provider, config.memory)
            )
            compactor = Compactor(memory, summarizer, config.memory, terminal.notice)
            compactor.start()
            try:
                if args.command == "compact":
                    await compactor.drain()
                    print(json.dumps(memory.stats(), indent=2))
                    return 0
                instructions_path = config.instructions or config.workspace / "AGENTS.md"
                instructions = instructions_path.read_text() if instructions_path.exists() else ""
                if config.instructions and not instructions_path.is_file():
                    raise ValueError(f"Instructions file does not exist: {instructions_path}")
                tools = Toolset(
                    memory,
                    config.workspace,
                    allow_shell=config.allow_shell,
                    cap=config.memory.tool_cap,
                )
                engine = Engine(
                    memory, agent_provider, tools, instructions, terminal.event, config.max_steps
                )
                engine.start()
                terminal.notice(
                    f"{config.agent.provider}/{config.agent.model}; memory at {store.path}"
                )
                if args.command == "ask":
                    engine.submit(args.message)
                    await engine.idle.wait()
                else:
                    await interactive(engine, compactor, memory, terminal)
                # Durability does not depend on finishing compression; restart resumes missing nodes.
                try:
                    await asyncio.wait_for(compactor.drain(), timeout=3)
                except TimeoutError:
                    terminal.notice(
                        "Remaining summaries will resume next time; every logged message is saved"
                    )
                return 1 if engine.last_error else 0
            finally:
                if engine:
                    await engine.close()
                await compactor.close()
    finally:
        if agent_provider:
            await agent_provider.close()
        if compact_provider:
            await compact_provider.close()


def main():
    args = parser().parse_args()
    try:
        code = asyncio.run(run(args))
    except (ValueError, TypeError, OSError, StoreError) as exc:
        print(f"optchat: {exc}", file=sys.stderr)
        code = 1
    except KeyboardInterrupt:
        print("\nStopped. Saved history is intact.", file=sys.stderr)
        code = 130
    raise SystemExit(code)
