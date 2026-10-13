import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from optchat.compactor import Compactor, DemoSummarizer, ModelSummarizer, cut_bytes, ruler
from optchat.config import MemoryConfig
from optchat.memory import PLACEHOLDER, Memory, due
from optchat.providers import Step
from optchat.storage import Part, Store, StoreError


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "chat"

    def test_verbatim_unicode_and_global_ids_survive_restart(self):
        text = "第一行 🌳\nsecond line\x00"
        with Store(self.path) as store:
            message = store.append("user", text, "2026-01-01T12:00:00-07:00")
            self.assertEqual(message.size, len(("user: " + text).encode()))
            store.save_node(Part(0, 0), message.source)
        with Store(self.path) as store:
            self.assertEqual(store.root[0].text, text)
            self.assertEqual(store.nodes[Part(0, 0)].text, "user: " + text)
            self.assertEqual(store.append("talk", "okay").i, 1)

    def test_one_writer_and_release(self):
        store = Store(self.path)
        with self.assertRaisesRegex(StoreError, "Another process"):
            Store(self.path)
        store.close()
        with Store(self.path) as next_store:
            next_store.append("user", "after release")

    def test_torn_tail_is_preserved_reported_and_separated(self):
        with Store(self.path) as store:
            store.append("user", "saved")
        path = next((self.path / "main").glob("*.jsonl"))
        with path.open("ab") as handle:
            handle.write(b'{"i":1,"kind":')
        damaged = path.read_bytes()
        notices = []
        with Store(self.path, notices.append) as store:
            store.append("user", "recovered")
        self.assertTrue(path.read_bytes().startswith(damaged + b"\n"))
        self.assertTrue(any("Skipped" in message for message in notices))
        with Store(self.path, lambda _: None) as store:
            self.assertEqual([m.text for m in store.root], ["saved", "recovered"])

    def test_valid_final_record_without_newline(self):
        with Store(self.path) as store:
            store.append("user", "saved")
        path = next((self.path / "main").glob("*.jsonl"))
        path.write_bytes(path.read_bytes().rstrip(b"\n"))
        with Store(self.path, lambda _: None) as store:
            store.append("talk", "next")
        self.assertEqual(len(path.read_text().splitlines()), 2)

    def test_invalid_middle_record_does_not_renumber_later_ids(self):
        with Store(self.path) as store:
            for text in ("a", "b", "c"):
                store.append("user", text)
        path = next((self.path / "main").glob("*.jsonl"))
        lines = path.read_bytes().splitlines(keepends=True)
        path.write_bytes(lines[0] + b"torn\n" + lines[2])
        with self.assertRaisesRegex(StoreError, "Missing message 1"):
            Store(self.path, lambda _: None)

    def test_parent_requires_children_and_nodes_are_immutable(self):
        with Store(self.path) as store:
            store.append("user", "a")
            store.append("user", "b")
            with self.assertRaisesRegex(ValueError, "Both children"):
                store.save_node(Part(1, 0), "summary")
            store.save_node(Part(0, 0), "a")
            with self.assertRaisesRegex(StoreError, "immutable"):
                store.save_node(Part(0, 0), "changed")

    def test_reasoning_kind_rejected(self):
        with Store(self.path) as store, self.assertRaises(ValueError):
            store.append("thought", "private")

    def test_failed_fsync_cannot_duplicate_ids_on_retry(self):
        with Store(self.path) as store:
            with (
                patch("optchat.storage.os.fsync", side_effect=OSError("disk failure")),
                self.assertRaises(OSError),
            ):
                store.append("user", "written but sync failed")
            with self.assertRaisesRegex(StoreError, "restart"):
                store.append("user", "do not reuse this id")
            with self.assertRaisesRegex(StoreError, "Another process"):
                Store(self.path)
        with Store(self.path) as store:
            self.assertEqual(len(store.root), 1)
            self.assertEqual(store.append("user", "after restart").i, 1)

    def test_each_line_written_once_and_fsynced(self):
        with Store(self.path) as store:
            with (
                patch("optchat.storage.os.write", wraps=os.write) as write,
                patch("optchat.storage.os.fsync", wraps=os.fsync) as sync,
            ):
                store.append("user", "durable")
            self.assertEqual(write.call_count, 1)
            self.assertGreaterEqual(sync.call_count, 1)


class MemoryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = Store(Path(self.temp.name))
        self.addCleanup(self.store.close)
        self.memory = Memory(self.store)

    def compactor(self, summarizer=None, **kwargs):
        config = MemoryConfig(**kwargs)
        compactor = Compactor(self.memory, summarizer or DemoSummarizer(config.node_bytes), config)
        self.addAsyncCleanup(compactor.close)
        compactor.start()
        return compactor

    async def test_short_messages_and_merges_are_free_and_verbatim(self):
        class Never:
            async def summarize(self, *args):
                raise AssertionError("No model calls expected")

        for text in ("keep this", "你好", "three", "four"):
            self.memory.append("user", text)
        compactor = self.compactor(Never())
        await asyncio.wait_for(compactor.drain(), 2)
        self.assertEqual(self.memory.text(Part(0, 1)), "user: 你好")
        self.assertEqual(self.memory.text(Part(1, 0)), "user: keep this\nuser: 你好")
        self.assertEqual(len(self.store.nodes), 7)

    async def test_large_raw_messages_never_leak_into_view(self):
        raw = "secret exact long text " * 3000
        self.memory.append("user", raw)
        self.assertIn(PLACEHOLDER, self.memory.render())
        self.assertNotIn("secret", self.memory.render())
        compactor = self.compactor()
        await asyncio.wait_for(self.memory.settle(), 2)
        self.assertNotIn(PLACEHOLDER, self.memory.render())
        self.assertLess(self.memory.size, 600)
        self.assertEqual(self.memory.zoom(0, 1), "0+0|user: " + raw)
        await compactor.drain()

    async def test_ordered_context_no_ids_and_all_parents_binary(self):
        calls = []

        class Summarizer:
            async def summarize(inner, context, source, merge, part):
                calls.append((context, source, merge))
                self.assertNotIn(PLACEHOLDER, context)
                self.assertNotRegex(context, r"\d+\+\d+\|")
                await asyncio.sleep(0.001)
                return source[:80]

        for i in range(8):
            self.memory.append("user", f"message-{i}: " + "a" * 600)
        compactor = self.compactor(Summarizer(), jobs=3, node_bytes=100)
        await asyncio.wait_for(compactor.drain(), 3)
        leaves = [source for _, source, merge in calls if not merge]
        self.assertEqual(
            [s.split(":")[1].strip() for s in leaves], [f"message-{i}" for i in range(8)]
        )
        self.assertEqual(calls[0][0], "<chat>\n\n</chat>")
        self.assertEqual(len(self.store.nodes), 15)

    async def test_sawtooth_batches_to_the_floor_in_taelins_order(self):
        memory = Memory(self.store, 100)

        def build(i):
            part = Part(0, i)
            while True:
                self.store.save_node(part, "x" * 20)
                memory.fit()
                if part.i % 2 == 0:
                    return
                part = Part(part.l + 1, part.i // 2)

        def keys():
            return [(p.l, p.i) for p in memory.view]

        for i in range(5):
            memory.append("user", f"m{i}")
            build(i)
        self.assertEqual(keys(), [(0, 0), (0, 1), (0, 2), (0, 3), (0, 4)])
        memory.append("user", "m5")
        self.store.save_node(Part(0, 5), "x" * 20)
        memory.fit()
        self.assertEqual(keys(), [(2, 0), (0, 4), (0, 5)])
        memory.append("user", "m6")
        self.assertEqual(keys(), [(2, 0), (0, 4), (0, 5), (0, 6)])
        self.store.save_node(Part(1, 2), "x" * 20)
        memory.fit()
        self.assertEqual(keys(), [(2, 0), (1, 2), (0, 6)])
        build(6)
        memory.append("user", "m7")
        build(7)
        self.assertEqual(keys(), [(2, 0), (1, 2), (0, 6), (0, 7)])
        # Taelin rev 3 §3.2: at T=10, the pair 8-9 is more due than 0-7.
        self.assertGreater(due(10, Part(0, 8)), due(10, Part(2, 0)))

    async def test_contiguous_and_under_the_ceiling_while_growing(self):
        memory = Memory(self.store, 1000)
        compactor = Compactor(
            memory, DemoSummarizer(100), MemoryConfig(node_bytes=100), lambda _: None
        )
        self.addAsyncCleanup(compactor.close)
        compactor.start()
        for i in range(160):
            memory.append("user", f"decision {i}: " + "abc" * 20)
            await asyncio.wait_for(compactor.drain(), 5)
            cursor = 0
            for part in memory.view:
                self.assertEqual(part.start, cursor)
                cursor = part.end
            self.assertEqual(cursor, i + 1)
            self.assertLessEqual(memory.size, 1000)
        fresh = Memory(self.store, 1000)
        self.assertLessEqual(fresh.size, 500)
        self.assertEqual(fresh.view[-1].end, 160)

    async def test_zoom_validation_and_local_date(self):
        self.memory.append("user", "a\nb", "2026-01-01T12:00:00-07:00")
        for id, n in ((-1, 1), (0, 0), (0, 3), (1, 2), (True, 1), (0, True), (0, 2)):
            self.assertTrue(self.memory.zoom(id, n).startswith("No line"))
        self.assertEqual(self.memory.zoom(0, 1), "0+0|user: a\nb")
        self.assertIn("2026-01-01", self.memory.date(0))

    async def test_retry_fixed_delay_reported_once_and_recovers(self):
        attempts = []
        notices = []

        class Flaky:
            async def summarize(self, *args):
                attempts.append(asyncio.get_running_loop().time())
                if len(attempts) <= 2:
                    raise RuntimeError("temporary outage")
                return "user: recovered"

        self.memory.append("user", "a" * 600)
        compactor = self.compactor(Flaky(), retry_seconds=0.015)
        compactor.report = notices.append
        await asyncio.wait_for(compactor.drain(), 2)
        self.assertEqual(len(notices), 1)
        self.assertEqual(len(attempts), 3)
        self.assertGreaterEqual(attempts[1] - attempts[0], 0.014)
        self.assertFalse(compactor.failed)

    async def test_settle_can_be_cancelled_without_exposing_partial_text(self):
        self.memory.append("user", "pending")
        waiter = asyncio.create_task(self.memory.settle())
        await asyncio.sleep(0)
        self.assertFalse(waiter.done())
        waiter.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await waiter
        self.assertEqual(self.store.root[0].text, "pending")


class SummarizerTests(unittest.IsolatedAsyncioTestCase):
    async def test_same_conversation_retries_shortest_and_utf8_feedback(self):
        class FakeSession:
            def __init__(self):
                self.replies = ["é" * 300, "a" * 520, "b" * 540]
                self.sent = []

            async def step(self):
                return Step(self.replies.pop(0))

            def send(self, text):
                self.sent.append(text)

        class FakeProvider:
            def __init__(self):
                self.calls = []
                self.current = FakeSession()

            def session(self, *args):
                self.calls.append(args)
                return self.current

        provider = FakeProvider()
        summarizer = ModelSummarizer(provider, MemoryConfig(tries=3))
        output = await summarizer.summarize(
            "<chat>context</chat>", "whole\nmessage", False, Part(0, 0)
        )
        self.assertEqual(output, "a" * 520)
        self.assertEqual(len(provider.calls), 1)
        self.assertTrue(
            provider.current.sent[0].startswith(
                "Too long: your line is 600 bytes, over the 512-byte limit."
            )
        )
        self.assertNotIn("�", provider.current.sent[0])
        self.assertTrue(provider.calls[0][2].startswith("Compaction: compress message 0"))
        self.assertIn("whole\nmessage", provider.calls[0][2])

    async def test_scale_and_cut_count_bytes(self):
        self.assertEqual(ruler(512), "-" * 512)
        self.assertEqual(cut_bytes("éé", 3), "é")
        self.assertEqual(ruler(1024), "-" * 1024)
