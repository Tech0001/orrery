"""Durable daily JSONL streams. All mutations run on the event-loop thread."""

from __future__ import annotations

import fcntl
import json
import os
from collections.abc import Callable
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path

KINDS = frozenset({"user", "talk", "tool", "echo", "note"})


def byte_size(text: str) -> int:
    return len(text.encode("utf-8"))


def now() -> str:
    return datetime.now().astimezone().isoformat()


def valid_date(value: str) -> str:
    stamp = datetime.fromisoformat(value)
    if stamp.tzinfo is None:
        raise ValueError("dates must include a timezone")
    return value


@dataclass(frozen=True)
class Message:
    i: int
    kind: str
    text: str
    size: int
    date: str

    @property
    def source(self) -> str:
        return f"{self.kind}: {self.text}"


@dataclass(frozen=True)
class Part:
    l: int
    i: int

    @property
    def n(self) -> int:
        return 1 << self.l

    @property
    def start(self) -> int:
        return self.i * self.n

    @property
    def end(self) -> int:
        return self.start + self.n

    @property
    def address(self) -> str:
        return f"{self.start}+{self.n}"


@dataclass(frozen=True)
class Node:
    l: int
    i: int
    text: str
    size: int

    @property
    def part(self) -> Part:
        return Part(self.l, self.i)


class StoreError(RuntimeError):
    pass


class Store:
    def __init__(self, path: Path, report: Callable[[str], None] = print):
        self.path = path.resolve()
        self.report = report
        self.root: list[Message] = []
        self.nodes: dict[Part, Node] = {}
        self._closed = False
        self._poisoned = False
        self.path.mkdir(parents=True, exist_ok=True, mode=0o700)
        # A kernel lock is atomic, released on crash, and requires no stale-PID/socket recovery.
        # Never unlink this file: replacing the inode would let another writer bypass the lock.
        self._lock = os.open(self.path / "lock", os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(self._lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(self._lock)
            raise StoreError(f"Another process is using {self.path}") from None
        try:
            for stream in ("main", "tree"):
                (self.path / stream).mkdir(exist_ok=True, mode=0o700)
            self._sync_directory(self.path)
            self._load()
        except BaseException:
            self.close()
            raise

    @staticmethod
    def _sync_directory(path: Path) -> None:
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def _records(self, stream: str):
        for path in sorted((self.path / stream).glob("*.jsonl")):
            with path.open("rb") as handle:
                last = b""
                for number, raw in enumerate(handle, 1):
                    last = raw
                    try:
                        record = json.loads(raw)
                    except (ValueError, UnicodeError):
                        self.report(f"Skipped torn/invalid JSON: {path.name}:{number} ({stream})")
                        continue
                    if not isinstance(record, dict):
                        raise StoreError(f"Expected an object at {path}:{number}")
                    yield record
            if last and not last.endswith(b"\n"):
                fd = os.open(path, os.O_WRONLY | os.O_APPEND)
                try:
                    if os.write(fd, b"\n") != 1:
                        raise StoreError(f"Could not repair newline in {path}")
                    os.fsync(fd)
                finally:
                    os.close(fd)
                self.report(f"Appended missing newline: {path}")

    def _load(self) -> None:
        messages = {}
        for data in self._records("main"):
            try:
                msg = Message(**data)
                if type(msg.i) is not int or msg.i < 0 or msg.kind not in KINDS:
                    raise ValueError("invalid message id or kind")
                if not isinstance(msg.text, str) or msg.size != byte_size(msg.source):
                    raise ValueError("invalid text or byte size")
                valid_date(msg.date)
            except (TypeError, ValueError, AttributeError) as exc:
                raise StoreError(f"Invalid message record: {exc}") from exc
            if msg.i in messages:
                raise StoreError(f"Duplicate message id {msg.i}; refusing to rewrite history")
            messages[msg.i] = msg
        for i in sorted(messages):
            if i != len(self.root):
                raise StoreError(f"Missing message {len(self.root)}; ids cannot be renumbered")
            self.root.append(messages[i])
        for data in self._records("tree"):
            try:
                node = Node(**data)
                if any(type(x) is not int or x < 0 for x in (node.l, node.i)):
                    raise ValueError("invalid coordinates")
                if node.l > len(self.root).bit_length() or node.part.end > len(self.root):
                    raise ValueError("node is outside the log")
                if not node.text.strip() or node.size != byte_size(node.text):
                    raise ValueError("invalid text or byte size")
            except (TypeError, ValueError, AttributeError) as exc:
                raise StoreError(f"Invalid tree record: {exc}") from exc
            if node.part in self.nodes:
                raise StoreError(f"Duplicate node {node.part.address}")
            self.nodes[node.part] = node
        for part in self.nodes:
            if part.l and any(child not in self.nodes for child in children(part)):
                raise StoreError(f"Node {part.address} is missing a child")

    def _append(self, stream: str, value: dict) -> None:
        if self._closed:
            raise StoreError("Store is closed")
        if self._poisoned:
            raise StoreError("A previous write failed; restart before appending more history")
        # File date is the local day of the WRITE, even for imported old timestamps.
        path = self.path / stream / f"{datetime.now().astimezone():%Y-%m-%d}.jsonl"
        new_file = not path.exists()
        payload = (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            try:
                if os.write(fd, payload) != len(payload):
                    raise StoreError("Short write; restart to recover the torn record")
                os.fsync(fd)
            finally:
                os.close(fd)
            if new_file:
                self._sync_directory(path.parent)
        except (OSError, StoreError):
            # A failed fsync can leave a complete line on disk. Keep the lock and refuse
            # further writes until reload, or retrying could duplicate a permanent id.
            self._poisoned = True
            raise

    def append(self, kind: str, text: str, date: str | None = None) -> Message:
        if kind not in KINDS or not isinstance(text, str):
            raise ValueError("Expected a supported message kind and string text")
        msg = Message(
            len(self.root), kind, text, byte_size(f"{kind}: {text}"), valid_date(date or now())
        )
        self._append("main", asdict(msg))
        self.root.append(msg)
        return msg

    def save_node(self, part: Part, text: str) -> Node:
        if part in self.nodes:
            raise StoreError(f"Node {part.address} is immutable")
        if not text.strip() or part.end > len(self.root):
            raise ValueError("Empty or out-of-range node")
        if part.l and any(child not in self.nodes for child in children(part)):
            raise ValueError("Both children must exist before their parent")
        node = Node(part.l, part.i, text, byte_size(text))
        self._append("tree", asdict(node))
        self.nodes[part] = node
        return node

    def close(self) -> None:
        if not self._closed:
            self._closed = True
            os.close(self._lock)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def children(part: Part) -> tuple[Part, Part]:
    return Part(part.l - 1, part.i * 2), Part(part.l - 1, part.i * 2 + 1)
