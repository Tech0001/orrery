"""The incremental, summaries-only view and exact-history navigation."""

from __future__ import annotations

import asyncio
from datetime import datetime

from .storage import Part, Store, children

PLACEHOLDER = "(not summarized yet: zoom it)"


def flatten(text: str) -> str:
    return text.replace("\r\n", " ").replace("\n", " ").replace("\r", " ")


def due(total: int, left: Part) -> float:
    """How due the pair (left, its right sibling) is: (T - last) / 2^l, shifted by 2 (Taelin rev 3, §3.2)."""
    return (total + 1) / (1 << left.l) - left.i


class Memory:
    def __init__(self, store: Store, budget: int = 128_000):
        if budget < 1:
            raise ValueError("View budget must be positive")
        self.store = store
        self.budget = budget  # the ceiling; the floor is half
        self.floor = budget // 2
        self.changed = asyncio.Event()
        # The reference keeps no saved view: each open builds it, every message a line, merged down to the floor.
        self.view: list[Part] = [Part(0, i) for i in range(len(store.root))]
        self.short = True
        self.fit()

    def text(self, part: Part) -> str:
        node = self.store.nodes.get(part)
        return node.text if node else PLACEHOLDER

    def _size(self, part: Part) -> int:
        node = self.store.nodes.get(part)
        return node.size if node else 0

    @property
    def size(self) -> int:
        """Bytes of the built lines; unbuilt lines count 0."""
        return sum(self._size(p) for p in self.view)

    @property
    def first(self) -> int:
        return next((p.start for p in self.view if p not in self.store.nodes), len(self.store.root))

    @property
    def settled(self) -> bool:
        return all(p in self.store.nodes for p in self.view)

    def append(self, kind: str, text: str, date: str | None = None):
        message = self.store.append(kind, text, date)
        self.view.append(Part(0, message.i))
        self.changed.set()
        return message

    def fit(self) -> None:
        """Past the ceiling, or while a batch is short, merge the most due built pairs down to the floor."""
        total = len(self.store.root)
        size = self.size
        if size > self.budget or self.short:
            while size > self.floor:
                best = None
                for index in range(len(self.view) - 1):
                    a, b = self.view[index : index + 2]
                    parent = Part(a.l + 1, a.i // 2)
                    if a.l != b.l or a.i % 2 or b.i != a.i + 1 or parent not in self.store.nodes:
                        continue
                    rank = (due(total, a), -a.start)
                    if best is None or rank > best[0]:
                        best = (rank, index, parent)
                if best is None:
                    break
                _, index, parent = best
                a, b = self.view[index : index + 2]
                size += self._size(parent) - self._size(a) - self._size(b)
                self.view[index : index + 2] = [parent]
            self.short = size > self.floor
        self.changed.set()

    def render(self, *, ids: bool = True, end: int | None = None) -> str:
        lines = []
        for part in self.view:
            if end is not None and part.end > end:
                break
            if not ids and part not in self.store.nodes:
                raise RuntimeError("Compactor context must contain only built summaries")
            prefix = f"{part.address}|" if ids else ""
            lines.append(prefix + flatten(self.text(part)))
        return "<chat>\n" + "\n".join(lines) + "\n</chat>"

    async def settle(self) -> None:
        while not self.settled:
            self.changed.clear()
            await self.changed.wait()

    def zoom(self, id: int, n: int) -> str:
        if (
            type(id) is not int
            or type(n) is not int
            or id < 0
            or n < 1
            or n & (n - 1)
            or id % n
            or id + n > len(self.store.root)
        ):
            return f"No line {id}+{n}."
        if n == 1:
            return f"{id}+0|{self.store.root[id].source}"
        part = Part(n.bit_length() - 1, id // n)
        pair = children(part)
        if any(child not in self.store.nodes for child in pair):
            return f"No line {id}+{n}."
        return "\n".join(f"{p.address}|{flatten(self.text(p))}" for p in pair)

    def date(self, id: int) -> str:
        if type(id) is not int or not 0 <= id < len(self.store.root):
            return f"No message {id}."
        return datetime.fromisoformat(self.store.root[id].date).astimezone().isoformat()

    def stats(self) -> dict:
        return {
            "messages": len(self.store.root),
            "nodes": len(self.store.nodes),
            "view_parts": len(self.view),
            "view_bytes": self.size,
            "view_budget": self.budget,
            "settled": self.settled,
            "first_unsummarized": self.first,
        }
