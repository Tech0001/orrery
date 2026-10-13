import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from optchat.compactor import Compactor, DemoSummarizer
from optchat.config import MemoryConfig
from optchat.engine import Engine
from optchat.memory import Memory
from optchat.providers import Step, ToolCall
from optchat.storage import Store
from optchat.tools import Toolset


class ScriptProvider:
    def __init__(self, scripts):
        self.scripts = list(scripts)
        self.sessions = []

    def session(self, system, view, text, tools):
        session = ScriptSession(self.scripts.pop(0), system, view, text, tools)
        self.sessions.append(session)
        return session


class ScriptSession:
    def __init__(self, script, system, view, text, tools):
        self.script = list(script)
        self.system, self.view, self.text, self.tools = system, view, text, tools
        self.sent = []
        self.outputs = []

    async def step(self, sink):
        item = self.script.pop(0)
        if callable(item):
            return await item(sink)
        if item.text:
            await sink("talk", item.text)
        return item

    def send(self, text):
        self.sent.append(text)

    def results(self, results):
        self.outputs.extend(results)


class EngineTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.workspace = Path(self.temp.name)
        self.store = Store(self.workspace / "chat")
        self.addCleanup(self.store.close)
        self.memory = Memory(self.store)
        self.tools = Toolset(self.memory, self.workspace)
        self.compactor = Compactor(self.memory, DemoSummarizer(), MemoryConfig())
        self.addAsyncCleanup(self.compactor.close)

    def engine(self, provider, sink=None):
        kwargs = {"sink": sink} if sink else {}
        engine = Engine(self.memory, provider, self.tools, **kwargs)
        self.addAsyncCleanup(engine.close)
        engine.start()
        return engine

    async def test_each_turn_fresh_snapshot_before_new_messages(self):
        self.compactor.start()
        provider = ScriptProvider([[Step("first response")], [Step("second response")]])
        engine = self.engine(provider)
        engine.submit("first user")
        await asyncio.wait_for(engine.idle.wait(), 2)
        engine.submit("second user")
        await asyncio.wait_for(engine.idle.wait(), 2)
        first, second = provider.sessions
        self.assertNotIn("first user", first.view)
        self.assertIn("first user", second.view)
        self.assertIn("first response", second.view)
        self.assertNotIn("second user", second.view)
        self.assertEqual(second.text, "second user")
        self.assertEqual(first.system, second.system)
        self.assertEqual(first.tools, second.tools)
        self.assertNotIn("not summarized yet", second.view)
        self.assertEqual([m.kind for m in self.store.root], ["user", "talk", "user", "talk"])

    async def test_steering_at_tool_boundary_and_reasoning_not_logged(self):
        self.compactor.start()

        async def think(sink):
            await sink("thought", "NEVER STORE THIS REASONING")
            await sink("talk", "I will inspect the message")
            return Step(calls=[ToolCall("c1", "zoom", '{"id":0,"n":1}')])

        provider = ScriptProvider([[think, Step("done")]])

        async def sink(kind, text):
            if kind == "echo":
                engine.submit("new instruction")

        engine = self.engine(provider, sink)
        engine.submit("original instruction")
        await asyncio.wait_for(engine.idle.wait(), 2)
        self.assertEqual(provider.sessions[0].sent, ["new instruction"])
        self.assertEqual(provider.sessions[0].outputs[0][1], "0+0|user: original instruction")
        all_text = "\n".join(m.text for m in self.store.root)
        self.assertNotIn("NEVER STORE", all_text)
        self.assertEqual(
            [m.kind for m in self.store.root], ["user", "talk", "tool", "echo", "user", "talk"]
        )

    async def test_cancel_while_settling_preserves_unanswered_user_message_once(self):
        self.memory.append("talk", "old unsummarized message")
        started = asyncio.Event()

        async def sink(kind, text):
            if kind == "status":
                started.set()

        provider = ScriptProvider([])
        engine = self.engine(provider, sink)
        engine.submit("don't lose me")
        await asyncio.wait_for(started.wait(), 2)
        await engine.cancel()
        self.assertEqual(
            [m.text for m in self.store.root], ["old unsummarized message", "don't lose me"]
        )
        self.assertEqual(provider.sessions, [])
        await engine.close()
        self.assertEqual(len(self.store.root), 2)

    async def test_cancel_active_request_keeps_queued_steering(self):
        entered = asyncio.Event()

        async def blocked(sink):
            entered.set()
            await asyncio.Event().wait()

        engine = self.engine(ScriptProvider([[blocked]]))
        engine.submit("start")
        await asyncio.wait_for(entered.wait(), 2)
        engine.submit("steering still queued")
        await engine.cancel()
        self.assertEqual([m.text for m in self.store.root], ["start", "steering still queued"])

    async def test_messages_not_taken_after_final_answer_start_new_turn(self):
        self.compactor.start()

        async def first(sink):
            engine.submit("next input")
            await sink("talk", "first done")
            return Step("first done")

        provider = ScriptProvider([[first], [Step("next done")]])
        engine = self.engine(provider)
        engine.submit("initial input")
        await asyncio.wait_for(engine.idle.wait(), 2)
        self.assertEqual(len(provider.sessions), 2)
        self.assertEqual(provider.sessions[1].text, "next input")

    async def test_tool_errors_are_logged_and_returned_to_model(self):
        self.compactor.start()
        provider = ScriptProvider(
            [
                [
                    Step(
                        calls=[
                            ToolCall("c1", "write_file", '{"path":"../outside","content":"bad"}')
                        ]
                    ),
                    Step("handled"),
                ]
            ]
        )
        engine = self.engine(provider)
        engine.submit("write")
        await asyncio.wait_for(engine.idle.wait(), 2)
        result = provider.sessions[0].outputs[0][1]
        self.assertIn("Path escapes", result)
        self.assertIsNone(engine.last_error)
        self.assertEqual(self.store.root[2].kind, "echo")

    async def test_batched_queued_messages_are_logged_separately(self):
        self.compactor.start()
        provider = ScriptProvider([[Step("ok")]])
        engine = self.engine(provider)
        engine.submit("one")
        engine.submit("two")
        await asyncio.wait_for(engine.idle.wait(), 2)
        self.assertEqual(provider.sessions[0].text, "one\n\ntwo")
        self.assertEqual([m.text for m in self.store.root[:2]], ["one", "two"])

    async def test_exact_zoom_exempt_from_result_cap_duplicate_echo_is_capped(self):
        original = "a" * 40_000
        self.memory.append("user", original)
        self.compactor.start()
        provider = ScriptProvider(
            [[Step(calls=[ToolCall("c", "zoom", '{"id":0,"n":1}')]), Step("read")]]
        )
        engine = self.engine(provider)
        engine.submit("retrieve it")
        await asyncio.wait_for(engine.idle.wait(), 2)
        self.assertEqual(provider.sessions[0].outputs[0][1], "0+0|user: " + original)
        echo = next(m for m in self.store.root if m.kind == "echo")
        self.assertLessEqual(len(echo.text), 30_000)
        self.assertIn("omitted", echo.text)

    async def test_failed_request_retains_pending_messages_and_reports_error(self):
        async def fails(sink):
            engine.submit("retain after failure")
            raise RuntimeError("provider unavailable")

        engine = self.engine(ScriptProvider([[fails]]))
        engine.submit("first")
        await asyncio.wait_for(engine.idle.wait(), 2)
        self.assertEqual(engine.last_error, "provider unavailable")
        self.assertEqual([m.text for m in self.store.root], ["first", "retain after failure"])

    async def test_completed_streamed_tool_is_saved_before_cancel_without_execution(self):
        ready = asyncio.Event()

        async def partial_stream(sink):
            await sink(
                "tool_ready",
                json.dumps(
                    {
                        "id": "c1",
                        "name": "write_file",
                        "arguments": '{"path":"should-not-exist","content":"no"}',
                    }
                ),
            )
            ready.set()
            await asyncio.Event().wait()

        engine = self.engine(ScriptProvider([[partial_stream]]))
        engine.submit("start")
        await asyncio.wait_for(ready.wait(), 2)
        await engine.cancel()
        self.assertEqual([m.kind for m in self.store.root], ["user", "tool"])
        self.assertFalse((self.workspace / "should-not-exist").exists())
