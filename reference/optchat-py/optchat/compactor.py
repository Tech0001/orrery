"""Ordered background compression with concurrent merges and fixed-delay retries."""

from __future__ import annotations

import asyncio
from collections.abc import Callable

from .config import MemoryConfig
from .memory import Memory, flatten
from .prompts import COMPACT, LEAF_TASK, MERGE_TASK, TOO_LONG
from .storage import Part, byte_size, children


def cut_bytes(text: str, limit: int) -> str:
    return text.encode("utf-8")[:limit].decode("utf-8", errors="ignore")


def ruler(limit: int) -> str:
    return "-" * limit


def about_words(limit: int) -> int:
    return (limit * 70 + 256) // 512


class ModelSummarizer:
    def __init__(self, provider, config: MemoryConfig):
        self.provider = provider
        self.config = config

    async def summarize(self, context: str, source: str, merge: bool, part: Part) -> str:
        limit = self.config.node_bytes
        if merge:
            a, b = children(part)
            step = MERGE_TASK.format(
                a=a.address,
                b=b.address,
                limit=limit,
                words=about_words(limit),
                ruler=ruler(limit),
                id=part.start,
                end=part.end - 1,
                source=source,
            )
        else:
            step = LEAF_TASK.format(
                id=part.start,
                limit=limit,
                words=about_words(limit),
                ruler=ruler(limit),
                note="",
                source=source,
            )
        session = self.provider.session(COMPACT, context, step, [])
        attempts = []
        for _ in range(self.config.tries):
            reply = await session.step()
            line = reply.text.strip()
            if not line:
                raise RuntimeError("Compactor returned an empty summary")
            attempts.append(line)
            size = byte_size(line)
            if size <= limit:
                break
            session.send(TOO_LONG.format(size=size, limit=limit, cut=cut_bytes(line, limit)))
        return min(attempts, key=byte_size)


class DemoSummarizer:
    """Deterministic plumbing demo, explicitly NOT a semantic summarizer."""

    def __init__(self, limit: int = 512):
        self.limit = limit

    async def summarize(
        self, context: str, source: str, merge: bool, part: Part | None = None
    ) -> str:
        await asyncio.sleep(0)
        suffix = " [offline demo excerpt]"
        return cut_bytes(flatten(source), self.limit - byte_size(suffix)) + suffix


class Compactor:
    def __init__(
        self,
        memory: Memory,
        summarizer,
        config: MemoryConfig,
        report: Callable[[str], None] = print,
    ):
        self.memory = memory
        self.summarizer = summarizer
        self.config = config
        self.report = report
        self.busy: dict[Part, asyncio.Task] = {}
        self.failed: set[Part] = set()
        self._pump: asyncio.Task | None = None
        self._closed = False

    def start(self) -> None:
        if self._pump is None:
            self._pump = asyncio.create_task(self._run(), name="optchat-compactor")

    def candidates(self):
        total = len(self.memory.store.root)
        first = self.memory.first
        for level in range(total.bit_length()):
            for index in range(total >> level):
                part = Part(level, index)
                if part in self.memory.store.nodes or part in self.busy:
                    continue
                end = index if level == 0 else part.end
                if end > first:
                    continue
                if level and any(child not in self.memory.store.nodes for child in children(part)):
                    continue
                yield part

    async def _run(self):
        while not self._closed:
            self.memory.changed.clear()
            for part in self.candidates():
                if len(self.busy) >= self.config.jobs:
                    break
                self.busy[part] = asyncio.create_task(self._build(part))
            await self.memory.changed.wait()

    async def _build(self, part: Part):
        try:
            if part.l == 0:
                source = self.memory.store.root[part.i].source
            else:
                source = "\n".join(self.memory.text(child) for child in children(part))
            if byte_size(source) <= self.config.node_bytes:
                text = source
            else:
                context = self.memory.render(ids=False, end=part.i if part.l == 0 else part.end)
                if part.l:
                    source = "\n".join(flatten(self.memory.text(c)) for c in children(part))
                text = await self.summarizer.summarize(context, source, bool(part.l), part)
            self.memory.store.save_node(part, text)
            self.failed.discard(part)
            self.memory.fit()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 -- failed nodes retry without killing the pump
            if part not in self.failed:
                self.failed.add(part)
                self.report(
                    f"Compactor {part.address}: {exc}; retrying every {self.config.retry_seconds:g}s"
                )
            await asyncio.sleep(self.config.retry_seconds)
        finally:
            self.busy.pop(part, None)
            self.memory.changed.set()

    async def drain(self):
        # All possible nodes, not just the current view (used for import/one-shot commands).
        expected = sum(
            len(self.memory.store.root) >> level
            for level in range(len(self.memory.store.root).bit_length())
        )
        while len(self.memory.store.nodes) < expected:
            self.memory.changed.clear()
            await self.memory.changed.wait()

    async def close(self):
        self._closed = True
        tasks = ([self._pump] if self._pump else []) + list(self.busy.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.busy.clear()
