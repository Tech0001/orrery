"""A fresh session per turn, with queued input and steering at tool boundaries."""

from __future__ import annotations

import asyncio
import json
from collections import deque

from .memory import Memory
from .prompts import MASTER, VIEW_DOC
from .providers import EventSink, ProviderError, ToolCall, silent
from .tools import Toolset, cap_text


class Engine:
    def __init__(
        self,
        memory: Memory,
        provider,
        tools: Toolset,
        instructions: str = "",
        sink: EventSink = silent,
        max_steps: int = 100,
    ):
        self.memory = memory
        self.provider = provider
        self.tools = tools
        self.system = "\n\n".join(p for p in (MASTER, VIEW_DOC, instructions) if p)
        self.sink = sink
        self.max_steps = max_steps
        self.pending: deque[str] = deque()
        self.idle = asyncio.Event()
        self.idle.set()
        self._wake = asyncio.Event()
        self._worker: asyncio.Task | None = None
        self._turn_task: asyncio.Task | None = None
        self.last_error: str | None = None
        self._logged_calls: set[str] = set()

    def start(self):
        if self._worker is None:
            self._worker = asyncio.create_task(self._run(), name="optchat-turns")

    def submit(self, text: str):
        if text.strip():
            self.pending.append(text)
            self.idle.clear()
            self._wake.set()

    async def _event(self, kind: str, text: str):
        if kind == "talk" and text:
            self.memory.append("talk", text)
        elif kind == "tool_ready":
            await self._record_call(ToolCall(**json.loads(text)))
            return
        # Reasoning (including display summaries) is deliberately never persisted.
        await self.sink(kind, text)

    async def _record_call(self, call: ToolCall):
        if call.id not in self._logged_calls:
            text = f"{call.name} {call.arguments}"
            self.memory.append("tool", text)
            self._logged_calls.add(call.id)
            await self.sink("tool", text)

    def _take(self) -> list[str]:
        texts = list(self.pending)
        self.pending.clear()
        return texts

    def _preserve_pending(self):
        for text in self._take():
            self.memory.append("user", text)

    async def _turn(self):
        try:
            if not self.memory.settled:
                await self.sink(
                    "status", "Waiting for memory summaries; /cancel preserves your message."
                )
            await self.memory.settle()
            # The snapshot excludes all of the new messages. Each is logged whole AFTER it.
            view = self.memory.render()
            texts = self._take()
            for text in texts:
                self.memory.append("user", text)
            session = self.provider.session(
                self.system, view, "\n\n".join(texts), self.tools.definitions
            )
            for _ in range(self.max_steps):
                self._logged_calls.clear()
                step = await session.step(self._event)
                if not step.calls:
                    if not step.text:
                        raise ProviderError("The model returned neither text nor tool calls")
                    return
                results = []
                for call in step.calls:
                    await self._record_call(call)
                    try:
                        arguments = json.loads(call.arguments)
                        result = await self.tools.execute(call.name, arguments)
                    except (ValueError, OSError, TypeError) as exc:
                        result = f"Tool error: {exc}"
                    # Exact zoom results must remain available verbatim to the model.
                    # The original message already exists in ROOT; cap the duplicate echo.
                    logged = cap_text(result, self.tools.cap)
                    self.memory.append("echo", logged)
                    await self.sink("echo", logged)
                    results.append((call, result))
                session.results(results)
                texts = self._take()
                for text in texts:
                    self.memory.append("user", text)
                if texts:
                    session.send("\n\n".join(texts))
            raise ProviderError(f"Stopped at the configured {self.max_steps} API-step limit")
        except asyncio.CancelledError:
            self._preserve_pending()
            await self.sink("status", "Turn cancelled. Accepted messages remain in the log.")
            raise
        except Exception:
            self._preserve_pending()
            raise
        finally:
            await self.sink("turn_end", "")

    async def _run(self):
        while True:
            await self._wake.wait()
            self._wake.clear()
            while self.pending:
                self.last_error = None
                self._turn_task = asyncio.create_task(self._turn())
                try:
                    await self._turn_task
                except asyncio.CancelledError:
                    if asyncio.current_task().cancelling():
                        raise
                except Exception as exc:  # noqa: BLE001 -- isolate failed turns; keep the terminal alive
                    self.last_error = str(exc)
                    await self.sink("error", str(exc))
                finally:
                    self._turn_task = None
            self.idle.set()

    async def cancel(self):
        if self._turn_task:
            self._turn_task.cancel()
            await asyncio.gather(self._turn_task, return_exceptions=True)
        else:
            self._preserve_pending()
        self.idle.set()

    async def close(self):
        await self.cancel()
        if self._worker:
            self._worker.cancel()
            await asyncio.gather(self._worker, return_exceptions=True)
