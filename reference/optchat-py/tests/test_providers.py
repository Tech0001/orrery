import copy
import json
import os
import unittest
from unittest.mock import patch

import httpx

from optchat.config import ModelConfig
from optchat.providers import Provider, ProviderError, ToolCall, view_pieces
from optchat.tools import INTEGER, definition


def sse(events):
    return "".join(
        "data: " + (e if isinstance(e, str) else json.dumps(e)) + "\n\n" for e in events
    ).encode()


def anthropic(text="hello", tool=False):
    events = [
        {"type": "message_start", "message": {"usage": {"input_tokens": 7}}},
        {
            "type": "content_block_start",
            "index": 0,
            "content_block": {"type": "thinking", "thinking": "", "signature": ""},
        },
        {
            "type": "content_block_delta",
            "index": 0,
            "delta": {"type": "thinking_delta", "thinking": "private thought"},
        },
        {
            "type": "content_block_delta",
            "index": 0,
            "delta": {"type": "signature_delta", "signature": "opaque-signature"},
        },
        {"type": "content_block_stop", "index": 0},
        {"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}},
        {"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": text}},
        {"type": "content_block_stop", "index": 1},
    ]
    if tool:
        events += [
            {
                "type": "content_block_start",
                "index": 2,
                "content_block": {"type": "tool_use", "id": "call-1", "name": "zoom", "input": {}},
            },
            {
                "type": "content_block_delta",
                "index": 2,
                "delta": {"type": "input_json_delta", "partial_json": '{"id":0,'},
            },
            {
                "type": "content_block_delta",
                "index": 2,
                "delta": {"type": "input_json_delta", "partial_json": '"n":1}'},
            },
            {"type": "content_block_stop", "index": 2},
        ]
    return events + [
        {
            "type": "message_delta",
            "delta": {"stop_reason": "tool_use" if tool else "end_turn"},
            "usage": {"output_tokens": 5, "cache_read_input_tokens": 6},
        },
        {"type": "message_stop"},
    ]


class ProviderTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.env = patch.dict(
            os.environ,
            {
                "ANTHROPIC_API_KEY": "test-key",
                "OPENAI_API_KEY": "test-key",
                "OPENROUTER_API_KEY": "test-key",
            },
        )
        self.env.start()
        self.addCleanup(self.env.stop)

    def provider(self, kind, responses, **kwargs):
        requests = []

        def handle(request):
            requests.append((str(request.url), json.loads(request.content)))
            response = responses.pop(0)
            return httpx.Response(
                200, content=sse(response), headers={"content-type": "text/event-stream"}
            )

        client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
        self.addAsyncCleanup(client.aclose)
        return Provider(ModelConfig(provider=kind, **kwargs), client), requests

    async def test_anthropic_stream_replays_signatures_and_tool_input(self):
        provider, requests = self.provider("anthropic", [anthropic(tool=True), anthropic("done")])
        session = provider.session(
            "constant",
            "<chat>old</chat>",
            "new",
            [definition("zoom", "open", id=INTEGER, n=INTEGER)],
        )
        seen = []

        async def sink(kind, text):
            seen.append((kind, text))

        first = await session.step(sink)
        self.assertEqual(json.loads(first.calls[0].arguments), {"id": 0, "n": 1})
        assistant = copy.deepcopy(session.history[-1])
        session.results([(first.calls[0], "original")])
        session.send("steering")
        await session.step()
        self.assertEqual(requests[1][1]["messages"][1], assistant)
        self.assertEqual(assistant["content"][0]["signature"], "opaque-signature")
        self.assertEqual(requests[1][1]["messages"][2]["content"][0]["tool_use_id"], "call-1")
        self.assertEqual(requests[0][1]["cache_control"], {"type": "ephemeral"})
        self.assertIn(("talk", "hello"), seen)
        self.assertIn(("thought", "private thought"), seen)
        self.assertEqual(first.usage["cache_read_input_tokens"], 6)

    async def test_anthropic_truncated_stream_cannot_execute_tools(self):
        provider, _ = self.provider("anthropic", [anthropic(tool=True)[:-1]])
        with self.assertRaisesRegex(ProviderError, "message_stop"):
            await provider.session("s", "v", "t", []).step()

    async def test_anthropic_output_limit_is_not_treated_as_success(self):
        events = anthropic(tool=True)
        events[-2]["delta"]["stop_reason"] = "max_tokens"
        provider, _ = self.provider("anthropic", [events])
        with self.assertRaisesRegex(ProviderError, "max_tokens"):
            await provider.session("s", "v", "t", []).step()

    async def test_responses_preserves_entire_native_output_with_encrypted_reasoning(self):
        reasoning = {
            "id": "r1",
            "type": "reasoning",
            "summary": [{"type": "summary_text", "text": "thought"}],
            "encrypted_content": "opaque",
            "status": "completed",
        }
        message = {
            "id": "m1",
            "type": "message",
            "role": "assistant",
            "phase": "commentary",
            "status": "completed",
            "content": [{"type": "output_text", "text": "looking", "annotations": []}],
        }
        call = {
            "id": "f1",
            "type": "function_call",
            "call_id": "c1",
            "name": "zoom",
            "arguments": '{"id":0,"n":1}',
            "status": "completed",
        }
        output = [reasoning, message, call]
        events = [{"type": "response.output_item.done", "item": item} for item in output]
        events += [
            {
                "type": "response.completed",
                "response": {
                    "status": "completed",
                    "output": output,
                    "usage": {"input_tokens_details": {"cached_tokens": 10}},
                },
            }
        ]
        final = {
            "type": "response.completed",
            "response": {"status": "completed", "output": [message], "usage": {}},
        }
        provider, requests = self.provider("openai", [events, [final]])
        session = provider.session("system", "<chat/>", "new", [])
        first = await session.step()
        session.results([(first.calls[0], "result")])
        session.send("mid-run user")
        await session.step()
        body = requests[1][1]
        self.assertFalse(body["store"])
        self.assertEqual(body["reasoning"]["context"], "all_turns")
        self.assertEqual(body["input"][1:4], output)
        self.assertEqual(body["input"][4]["call_id"], "c1")
        self.assertNotIn("previous_response_id", body)

    async def test_openrouter_fragmented_calls_and_reasoning_are_replayed(self):
        events = [
            {
                "choices": [
                    {
                        "index": 0,
                        "delta": {
                            "role": "assistant",
                            "reasoning_details": [
                                {
                                    "index": 0,
                                    "type": "reasoning.encrypted",
                                    "data": "abc",
                                    "id": "r1",
                                    "format": "anthropic-v1",
                                }
                            ],
                        },
                    }
                ]
            },
            {
                "choices": [
                    {
                        "index": 0,
                        "delta": {
                            "reasoning_details": [{"index": 0, "data": "def"}],
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "id": "c1",
                                    "type": "function",
                                    "function": {"name": "zoom", "arguments": '{"id":0,'},
                                }
                            ],
                        },
                    }
                ]
            },
            {
                "choices": [
                    {
                        "index": 0,
                        "delta": {
                            "tool_calls": [{"index": 0, "function": {"arguments": '"n":1}'}}]
                        },
                        "finish_reason": "tool_calls",
                    }
                ]
            },
            {
                "choices": [],
                "usage": {"prompt_tokens": 10, "prompt_tokens_details": {"cached_tokens": 8}},
            },
            "[DONE]",
        ]
        final = [
            {"choices": [{"index": 0, "delta": {"content": "done"}, "finish_reason": "stop"}]},
            "[DONE]",
        ]
        provider, requests = self.provider("openrouter", [events, final])
        session = provider.session("system", "view", "new", [])
        step = await session.step()
        self.assertEqual(json.loads(step.calls[0].arguments), {"id": 0, "n": 1})
        session.results([(step.calls[0], "result")])
        session.send("steer")
        await session.step()
        replay = requests[1][1]["messages"][2]
        self.assertEqual(replay["reasoning_details"][0]["data"], "abcdef")
        self.assertEqual(replay["reasoning_details"][0]["format"], "anthropic-v1")
        self.assertEqual(replay["tool_calls"][0]["id"], "c1")
        self.assertTrue(requests[0][0].endswith("/api/v1/chat/completions"))

    async def test_local_server_no_key_vendor_options_or_cache_fields(self):
        events = [
            {
                "choices": [
                    {
                        "delta": {"content": "local response", "reasoning_content": "internal"},
                        "finish_reason": "stop",
                    }
                ]
            },
            "[DONE]",
        ]
        provider, requests = self.provider(
            "local", [events], base_url="http://localhost:1234/v1", model="my-model"
        )
        result = await provider.session("system", "view", "new", []).step()
        self.assertEqual(result.text, "local response")
        body = requests[0][1]
        self.assertEqual(requests[0][0], "http://localhost:1234/v1/chat/completions")
        self.assertEqual(body["messages"][1]["content"], "view\n\nnew")
        self.assertNotIn("reasoning", body)
        self.assertNotIn("cache_control", json.dumps(body))

    async def test_local_tool_id_generated_consistently_when_omitted(self):
        events = [
            {
                "choices": [
                    {
                        "delta": {
                            "tool_calls": [
                                {"index": 0, "function": {"name": "date", "arguments": '{"id":0}'}}
                            ]
                        },
                        "finish_reason": "tool_calls",
                    }
                ]
            },
            "[DONE]",
        ]
        provider, _ = self.provider("local", [events])
        session = provider.session("s", "v", "t", [])
        step = await session.step()
        session.results([(step.calls[0], "today")])
        self.assertEqual(
            session.history[-2]["tool_calls"][0]["id"], session.history[-1]["tool_call_id"]
        )

    async def test_http_errors_report_status_and_redact_key(self):
        client = httpx.AsyncClient(
            transport=httpx.MockTransport(lambda r: httpx.Response(401, text="bad test-key"))
        )
        self.addAsyncCleanup(client.aclose)
        provider = Provider(ModelConfig(), client)
        with self.assertRaisesRegex(ProviderError, r"HTTP 401: bad \[redacted\]"):
            await provider.session("s", "v", "t", []).step()

    async def test_chat_partial_stream_is_rejected(self):
        provider, _ = self.provider("local", [[{"choices": [{"delta": {"content": "partial"}}]}]])
        with self.assertRaisesRegex(ProviderError, "ended before"):
            await provider.session("s", "v", "t", []).step()

    async def test_cache_layout_has_three_view_marks_plus_request_end(self):
        view = "<chat>\n" + "0+1|" + ("abcé" * 100 + "\n") * 300 + "</chat>"
        pieces = view_pieces(view)
        self.assertEqual("".join(text for text, _ in pieces), view)
        self.assertEqual(sum(marked for _, marked in pieces), 3)
        self.assertTrue(all(text.endswith("\n") for text, marked in pieces if marked))
        provider, _ = self.provider("anthropic", [])
        payload = provider.session("s", view, "new", []).payload()
        self.assertEqual(
            sum("cache_control" in block for block in payload["messages"][0]["content"]), 3
        )
        self.assertIn("cache_control", payload)
        self.assertEqual(payload["messages"][0]["content"][-1], {"type": "text", "text": "new"})

    async def test_cache_markers_do_not_accumulate_on_old_openrouter_tool_results(self):
        provider, _ = self.provider("openrouter", [])
        view = ("a" * 100 + "\n") * 1100
        session = provider.session("s", view, "new", [])
        for i in range(3):
            session.history.append({"role": "assistant", "content": "calling"})
            session.results([(ToolCall(str(i), "zoom", "{}"), "result")])
            body = session.payload()
            self.assertEqual(json.dumps(body).count('"cache_control"'), 4)
            self.assertEqual(json.dumps(session.history).count('"cache_control"'), 3)

    def test_view_marks_skip_short_views_and_long_unbroken_lines(self):
        self.assertEqual(view_pieces("short"), [("short", False)])
        self.assertEqual(view_pieces("x" * 110_000), [("x" * 110_000, False)])
