"""Golden oracle: build a memory tree with the Python reference and print it as JSON.

Usage: uv run --project reference/optchat-py python test/golden/optchat_golden.py FIXTURE NODE_BYTES VIEW_BYTES MORE
The first messages are built in bulk; the view is then built fresh, and the last MORE messages are added one at a
time, each followed by a drain, recording the view after each.
"""

import asyncio
import json
import sys
import tempfile
from pathlib import Path

from optchat.compactor import Compactor, DemoSummarizer, ruler
from optchat.config import MemoryConfig
from optchat.memory import Memory
from optchat.storage import Store


def lines(memory: Memory) -> list[list[int]]:
    return [[p.l, p.i] for p in memory.view]


async def main(fixture: str, node_bytes: int, view_bytes: int, more: int) -> None:
    config = MemoryConfig(node_bytes=node_bytes, view_bytes=view_bytes, jobs=4, retry_seconds=0.01)
    records = [json.loads(line) for line in Path(fixture).read_text(encoding="utf-8").splitlines()]
    with tempfile.TemporaryDirectory() as tmp:
        with Store(Path(tmp) / "chat", lambda _: None) as store:
            memory = Memory(store, view_bytes)
            for record in records[:-more]:
                memory.append(record["kind"], record["text"], record["date"])
            compactor = Compactor(memory, DemoSummarizer(node_bytes), config, lambda _: None)
            compactor.start()
            await compactor.drain()
            await compactor.close()
            fresh = Memory(store, view_bytes)
            result = {"fresh": lines(fresh), "freshRender": fresh.render(), "steps": []}
            compactor = Compactor(fresh, DemoSummarizer(node_bytes), config, lambda _: None)
            compactor.start()
            for record in records[-more:]:
                fresh.append(record["kind"], record["text"], record["date"])
                await compactor.drain()
                result["steps"].append(lines(fresh))
            await compactor.close()
            result["nodes"] = sorted([n.l, n.i, n.text] for n in store.nodes.values())
            result["render"] = fresh.render()
            result["scale"] = ruler(node_bytes)
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))


asyncio.run(main(sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])))
