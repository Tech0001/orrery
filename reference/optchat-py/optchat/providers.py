"""Streaming Anthropic, Responses, OpenRouter and local OpenAI-compatible adapters.

Provider-native assistant objects are retained verbatim inside a turn, including
opaque reasoning/signatures. The harness logs only ordinary text and tool activity.
"""

from __future__ import annotations

import copy
import json
import re
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass, field

import httpx

from .config import ModelConfig

EventSink = Callable[[str, str], Awaitable[None]]
MARKS = (50_000, 80_000, 100_000)


class ProviderError(RuntimeError):
    pass


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: str


@dataclass
class Step:
    text: str = ""
    calls: list[ToolCall] = field(default_factory=list)
    usage: dict = field(default_factory=dict)


async def silent(kind: str, text: str):
    pass


def view_pieces(view: str, marks=MARKS) -> list[tuple[str, bool]]:
    """Cut at line ends BEFORE absolute character offsets; concatenation is exact."""
    pieces = []
    start = 0
    for mark in marks:
        if mark >= len(view):
            continue
        end = view.rfind("\n", start, mark) + 1
        if end > start:
            pieces.append((view[start:end], True))
            start = end
    if start < len(view):
        pieces.append((view[start:], False))
    return pieces


class Provider:
    def __init__(self, config: ModelConfig, client: httpx.AsyncClient | None = None):
        self.config = config
        self.key = config.key()
        self.client = client or httpx.AsyncClient(timeout=config.timeout, follow_redirects=False)
        self._owns_client = client is None

    def session(self, system: str, view: str, text: str, tools: list[dict]):
        if self.config.provider == "anthropic":
            return AnthropicSession(self, system, view, text, tools)
        if self.config.provider == "openai":
            return ResponsesSession(self, system, view, text, tools)
        return ChatSession(self, system, view, text, tools)

    async def events(self, endpoint: str, payload: dict):
        headers = {"Content-Type": "application/json", "Accept": "text/event-stream"}
        if self.config.provider == "anthropic":
            headers.update({"x-api-key": self.key, "anthropic-version": "2023-06-01"})
        elif self.key:
            headers["Authorization"] = f"Bearer {self.key}"
        if self.config.provider == "openrouter":
            headers["X-OpenRouter-Title"] = "OptChat"
        url = self.config.base_url.rstrip("/") + endpoint
        try:
            async with self.client.stream("POST", url, headers=headers, json=payload) as response:
                if response.status_code >= 400:
                    body = (await response.aread()).decode("utf-8", errors="replace")
                    # Limit provider diagnostics and redact the configured secret if echoed.
                    if self.key:
                        body = body.replace(self.key, "[redacted]")
                    raise ProviderError(
                        f"{self.config.provider} HTTP {response.status_code}: {body[:2000]}"
                    )
                data = []
                async for line in response.aiter_lines():
                    if line.startswith("data:"):
                        data.append(line[5:].lstrip(" "))
                    elif not line and data:
                        raw = "\n".join(data)
                        data.clear()
                        if raw == "[DONE]":
                            yield {"type": "[DONE]"}
                            continue
                        event = json.loads(raw)
                        if event.get("error") or event.get("type") == "error":
                            raise ProviderError(
                                f"Provider stream error: {event.get('error', 'unknown')}"
                            )
                        yield event
                if data:
                    raise ProviderError("Incomplete SSE event; retry the turn")
        except (httpx.HTTPError, json.JSONDecodeError) as exc:
            raise ProviderError(f"{self.config.provider} request failed: {exc}") from exc

    async def close(self):
        if self._owns_client:
            await self.client.aclose()


class Session:
    def __init__(self, provider: Provider, system: str, view: str, text: str, tools: list[dict]):
        self.provider = provider
        self.config = provider.config
        self.system = system
        self.tools = copy.deepcopy(tools)
        self.history: list[dict] = []

    def send(self, text: str):
        self.history.append({"role": "user", "content": text})


class AnthropicSession(Session):
    def __init__(self, provider, system, view, text, tools):
        super().__init__(provider, system, view, text, tools)
        blocks = []
        for piece, marked in view_pieces(view):
            block = {"type": "text", "text": piece}
            if marked:
                block["cache_control"] = {"type": "ephemeral"}
            blocks.append(block)
        blocks.append({"type": "text", "text": text})
        self.history.append({"role": "user", "content": blocks})

    def payload(self):
        payload = {
            "model": self.config.model,
            "system": self.system,
            "messages": self.history,
            "max_tokens": self.config.max_tokens,
            "stream": True,
            "cache_control": {"type": "ephemeral"},
        }
        if self.config.effort:
            payload["output_config"] = {"effort": self.config.effort}
        if self.tools:
            payload["tools"] = [
                {
                    "name": t["name"],
                    "description": t["description"],
                    "input_schema": t["parameters"],
                }
                for t in self.tools
            ]
        return payload

    def results(self, results: list[tuple[ToolCall, str]]):
        self.history.append(
            {
                "role": "user",
                "content": [
                    {"type": "tool_result", "tool_use_id": call.id, "content": text}
                    for call, text in results
                ],
            }
        )

    async def step(self, sink: EventSink = silent) -> Step:
        blocks = {}
        inputs = {}
        usage = {}
        complete = False
        stop = None
        async for event in self.provider.events("/messages", self.payload()):
            kind = event.get("type")
            if kind == "message_start":
                usage.update(event["message"].get("usage", {}))
            elif kind == "content_block_start":
                blocks[event["index"]] = copy.deepcopy(event["content_block"])
            elif kind == "content_block_delta":
                index, delta = event["index"], event["delta"]
                block = blocks[index]
                delta_type = delta["type"]
                if delta_type == "input_json_delta":
                    inputs[index] = inputs.get(index, "") + delta["partial_json"]
                else:
                    key = {
                        "text_delta": "text",
                        "thinking_delta": "thinking",
                        "signature_delta": "signature",
                    }.get(delta_type)
                    if key:
                        block[key] = block.get(key, "") + delta[key]
                        if key in ("text", "thinking"):
                            await sink(
                                "talk_delta" if key == "text" else "thought_delta", delta[key]
                            )
            elif kind == "content_block_stop":
                index = event["index"]
                block = blocks[index]
                if index in inputs:
                    try:
                        block["input"] = json.loads(inputs[index])
                    except ValueError as exc:
                        raise ProviderError("Incomplete tool input from Anthropic") from exc
                if block["type"] == "text":
                    await sink("talk", block["text"])
                elif block["type"] == "thinking":
                    await sink("thought", block.get("thinking", ""))
                elif block["type"] == "tool_use":
                    call = ToolCall(
                        block["id"], block["name"], json.dumps(block["input"], ensure_ascii=False)
                    )
                    await sink("tool_ready", json.dumps(asdict(call), ensure_ascii=False))
            elif kind == "message_delta":
                usage.update(event.get("usage", {}))
                stop = event.get("delta", {}).get("stop_reason", stop)
            elif kind == "message_stop":
                complete = True
        if not complete:
            raise ProviderError("Anthropic stream ended before message_stop")
        content = [blocks[i] for i in sorted(blocks)]
        self.history.append({"role": "assistant", "content": content})
        await sink("usage", json.dumps(usage))
        if stop not in ("end_turn", "tool_use", "stop_sequence"):
            raise ProviderError(f"Anthropic response stopped with {stop!r}; no tools executed")
        return Step(
            "\n".join(b["text"] for b in content if b["type"] == "text"),
            [
                ToolCall(b["id"], b["name"], json.dumps(b["input"], ensure_ascii=False))
                for b in content
                if b["type"] == "tool_use"
            ],
            usage,
        )


class ResponsesSession(Session):
    def __init__(self, provider, system, view, text, tools):
        super().__init__(provider, system, view, text, tools)
        blocks = []
        for piece, marked in view_pieces(view):
            block = {"type": "input_text", "text": piece}
            if marked and self.config.explicit_cache:
                block["prompt_cache_breakpoint"] = {"mode": "explicit"}
            blocks.append(block)
        blocks.append({"type": "input_text", "text": text})
        self.history = [{"role": "user", "content": blocks}]

    def payload(self):
        payload = {
            "model": self.config.model,
            "instructions": self.system,
            "input": self.history,
            "store": False,
            "stream": True,
            "include": ["reasoning.encrypted_content"],
            "max_output_tokens": self.config.max_tokens,
        }
        reasoning = {}
        if self.config.effort:
            reasoning["effort"] = self.config.effort
        if self.config.reasoning_context:
            reasoning["context"] = self.config.reasoning_context
        if reasoning:
            payload["reasoning"] = reasoning
        if self.config.explicit_cache:
            payload["prompt_cache_options"] = {"mode": "implicit"}
        if self.tools:
            payload["tools"] = [{"type": "function", **t, "strict": True} for t in self.tools]
        return payload

    def results(self, results: list[tuple[ToolCall, str]]):
        self.history.extend(
            {"type": "function_call_output", "call_id": call.id, "output": text}
            for call, text in results
        )

    async def step(self, sink: EventSink = silent) -> Step:
        response = None
        seen = set()
        async for event in self.provider.events("/responses", self.payload()):
            kind = event.get("type", "")
            if kind in ("response.output_text.delta", "response.refusal.delta"):
                await sink("talk_delta", event["delta"])
            elif kind == "response.reasoning_summary_text.delta":
                await sink("thought_delta", event["delta"])
            elif kind == "response.output_item.done":
                item = event["item"]
                seen.add(item["id"])
                await self._entry(item, sink)
            elif kind in ("response.completed", "response.incomplete", "response.failed"):
                response = event["response"]
        if response is None:
            raise ProviderError("OpenAI stream ended before a final response")
        output = response.get("output", [])
        for item in output:
            if item.get("id") not in seen:
                await self._entry(item, sink)
        # Do not reconstruct or filter this list: phase, encrypted reasoning and signatures matter.
        self.history.extend(output)
        usage = response.get("usage") or {}
        await sink("usage", json.dumps(usage))
        if response.get("status") != "completed":
            raise ProviderError(
                f"OpenAI response {response.get('status')}: "
                f"{response.get('incomplete_details') or response.get('error')}"
            )
        text = "\n".join(self._text(item) for item in output if item["type"] == "message")
        calls = [
            ToolCall(item["call_id"], item["name"], item["arguments"])
            for item in output
            if item["type"] == "function_call"
        ]
        return Step(text, calls, usage)

    @staticmethod
    def _text(item):
        return "\n".join(
            block.get("text", block.get("refusal", ""))
            for block in item.get("content", [])
            if block["type"] in ("output_text", "refusal")
        )

    async def _entry(self, item, sink):
        if item["type"] == "message":
            await sink("talk", self._text(item))
        elif item["type"] == "reasoning":
            await sink("thought", "\n".join(s.get("text", "") for s in item.get("summary", [])))
        elif item["type"] == "function_call":
            call = ToolCall(item["call_id"], item["name"], item["arguments"])
            await sink("tool_ready", json.dumps(asdict(call), ensure_ascii=False))


def merge_delta(target: dict, delta: dict) -> None:
    """Accumulate native chat deltas, including OpenRouter reasoning_details by index."""
    for key, value in delta.items():
        if key == "index":
            continue
        if value is None:
            continue
        if isinstance(value, str):
            # Metadata describes the item; content/signature/data fields are streamed pieces.
            if key in ("role", "type", "id", "format"):
                target[key] = value
            else:
                target[key] = target.get(key, "") + value
        elif isinstance(value, dict):
            merge_delta(target.setdefault(key, {}), value)
        elif isinstance(value, list):
            items = target.setdefault(key, [])
            for position, entry in enumerate(value):
                index = entry.get("index", position)
                if type(index) is not int or not 0 <= index <= 4096:
                    raise ProviderError("Invalid streamed item index")
                while len(items) <= index:
                    items.append({})
                merge_delta(items[index], entry)
                if key == "reasoning_details":
                    items[index]["index"] = index
        else:
            target[key] = value


class ChatSession(Session):
    def __init__(self, provider, system, view, text, tools):
        super().__init__(provider, system, view, text, tools)
        self.anthropic_cache = (
            self.config.provider == "openrouter" and self.config.model.startswith("anthropic/")
        )
        blocks = []
        for piece, marked in view_pieces(view):
            block = {"type": "text", "text": piece}
            if marked and self.anthropic_cache:
                block["cache_control"] = {"type": "ephemeral"}
            blocks.append(block)
        blocks.append({"type": "text", "text": text})
        content = view + "\n\n" + text if self.config.provider == "local" else blocks
        self.history = [{"role": "system", "content": system}, {"role": "user", "content": content}]

    def payload(self):
        messages = copy.deepcopy(self.history)
        payload = {
            "model": self.config.model,
            "messages": messages,
            "stream": True,
            "max_tokens": self.config.max_tokens,
        }
        if self.anthropic_cache:
            # OpenRouter forwards automatic caching without changing native message shapes.
            payload["cache_control"] = {"type": "ephemeral"}
        if self.config.provider == "openrouter":
            payload["stream_options"] = {"include_usage": True}
            if self.config.effort:
                payload["reasoning"] = {"effort": self.config.effort}
        if self.tools:
            payload["tools"] = [{"type": "function", "function": t} for t in self.tools]
        return payload

    def results(self, results: list[tuple[ToolCall, str]]):
        self.history.extend(
            {"role": "tool", "tool_call_id": call.id, "content": text} for call, text in results
        )

    async def step(self, sink: EventSink = silent) -> Step:
        message = {"role": "assistant"}
        usage = {}
        finish = None
        done = False
        async for event in self.provider.events("/chat/completions", self.payload()):
            if event.get("type") == "[DONE]":
                done = True
                continue
            if event.get("usage"):
                usage = event["usage"]
            for choice in event.get("choices", []):
                if choice.get("index", 0) != 0:
                    continue
                delta = choice.get("delta", {})
                merge_delta(message, delta)
                if delta.get("content"):
                    await sink("talk_delta", delta["content"])
                thought = delta.get("reasoning_content") or delta.get("reasoning")
                if thought:
                    await sink("thought_delta", thought)
                if choice.get("finish_reason"):
                    finish = choice["finish_reason"]
        if not done or not finish:
            raise ProviderError("Chat stream ended before [DONE] / finish_reason")
        text = message.get("content") or ""
        if not isinstance(text, str):
            raise ProviderError("Expected text content from chat provider")
        message.setdefault("content", None)
        self.history.append(message)
        if text:
            await sink("talk", text)
        await sink("usage", json.dumps(usage))
        if finish not in ("stop", "tool_calls"):
            raise ProviderError(f"Chat response stopped with {finish!r}; no tools executed")
        calls = []
        for i, call in enumerate(message.get("tool_calls", [])):
            if not call:
                raise ProviderError("Sparse tool call list")
            # Some local servers omit ids. Supply the same id in the replay and result.
            call.setdefault("id", f"local_{len(self.history)}_{i}")
            call.setdefault("type", "function")
            fn = call["function"]
            calls.append(ToolCall(call["id"], fn["name"], fn.get("arguments", "{}")))
            await sink("tool_ready", json.dumps(asdict(calls[-1]), ensure_ascii=False))
        return Step(text, calls, usage)


class DemoProvider:
    """A transparent offline fixture that demonstrates real memory tool round trips."""

    def session(self, system, view, text, tools):
        return DemoSession(view, text)

    async def close(self):
        pass


class DemoSession:
    def __init__(self, view, text):
        self.view = view
        self.text = text
        self.result = None

    def send(self, text):
        self.text += "\n\n" + text

    def results(self, results):
        self.result = "\n".join(text for _, text in results)

    async def step(self, sink: EventSink = silent):
        match = re.fullmatch(r"\s*(zoom|date)\s+(\d+)(?:\s+(\d+))?\s*", self.text)
        if self.result is None and match:
            tool, id, n = match.groups()
            args = {"id": int(id)}
            if tool == "zoom":
                args["n"] = int(n or 1)
            return Step(calls=[ToolCall("demo-call", tool, json.dumps(args))])
        text = (
            "[Offline demo — no AI inference]\n" + self.result
            if self.result is not None
            else "[Offline demo — no AI inference] Your message is stored. "
            "Try `zoom 0 1` to retrieve the first message, or `date 0` for its timestamp."
        )
        await sink("talk_delta", text)
        await sink("talk", text)
        return Step(text)


def make_provider(config: ModelConfig):
    return DemoProvider() if config.provider == "demo" else Provider(config)
