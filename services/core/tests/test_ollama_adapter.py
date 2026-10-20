"""Contract tests for OllamaAdapter against scripted HTTP responses (no real model server).

Response bodies mirror the shapes observed from Ollama 0.40.6 on this machine.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Callable

import httpx
import pytest

from app.models.base import ChatMessage, GenerationOptions, GenerationResult, ProviderError, TextDelta
from app.models.ollama import OllamaAdapter, validate_base_url

MESSAGES = [ChatMessage("user", "hi")]
TAGS = {
    "models": [
        {"name": "llama3.2:3b", "details": {"parameter_size": "3.2B"}, "capabilities": ["completion", "tools"]},
        {"name": "qwen3:4b", "details": {"parameter_size": "4.0B"}, "capabilities": ["completion", "thinking"]},
    ]
}


def ndjson(*items: dict) -> bytes:
    return b"".join(json.dumps(i).encode() + b"\n" for i in items)


def chunk(text: str) -> dict:
    return {"model": "llama3.2:3b", "message": {"role": "assistant", "content": text}, "done": False}


DONE = {
    "model": "llama3.2:3b",
    "message": {"role": "assistant", "content": ""},
    "done": True,
    "done_reason": "stop",
    "prompt_eval_count": 31,
    "eval_count": 4,
    "total_duration": 1000,
}


def make(handler: Callable[[httpx.Request], httpx.Response], **kwargs) -> OllamaAdapter:  # type: ignore[no-untyped-def]
    return OllamaAdapter(transport=httpx.MockTransport(handler), **kwargs)


async def collect(adapter: OllamaAdapter, model: str = "llama3.2:3b") -> list:
    return [item async for item in adapter.stream_chat(model, MESSAGES, GenerationOptions(max_output_tokens=64))]


def run(coro):  # type: ignore[no-untyped-def]
    return asyncio.run(coro)


def test_streams_deltas_then_result_with_provenance() -> None:
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        return httpx.Response(200, content=ndjson(chunk("Hello"), chunk(" there"), DONE))

    items = run(collect(make(handler)))
    assert items[:2] == [TextDelta("Hello"), TextDelta(" there")]
    result = items[2]
    assert isinstance(result, GenerationResult)
    assert (result.provider, result.model, result.finish_reason) == ("ollama", "llama3.2:3b", "stop")
    assert (result.prompt_tokens, result.completion_tokens) == (31, 4)
    body = seen[0]
    assert body["stream"] is True and body["model"] == "llama3.2:3b"
    assert body["options"]["num_predict"] == 64
    assert body["messages"] == [{"role": "user", "content": "hi"}]
    assert "think" not in body


def test_thinking_models_get_reasoning_separated_and_discarded() -> None:
    bodies: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/tags":
            return httpx.Response(200, json=TAGS)
        bodies.append(json.loads(request.content))
        reasoning = {"model": "qwen3:4b", "message": {"role": "assistant", "content": "", "thinking": "Hmm..."}, "done": False}
        return httpx.Response(200, content=ndjson(reasoning, chunk("ok"), DONE))

    async def scenario() -> tuple[list, list]:
        adapter = make(handler)
        await adapter.health()
        return await collect(adapter, "qwen3:4b"), await collect(adapter, "llama3.2:3b")

    thinking_items, plain_items = run(scenario())
    assert bodies[0]["think"] is True
    assert bodies[0]["options"]["num_predict"] >= 4096
    assert "think" not in bodies[1] and bodies[1]["options"]["num_predict"] == 64
    # Only the answer is surfaced; the reasoning trace never becomes output.
    assert [i for i in thinking_items if isinstance(i, TextDelta)] == [TextDelta("ok")]
    assert [i for i in plain_items if isinstance(i, TextDelta)] == [TextDelta("ok")]


def test_health_lists_models() -> None:
    health = run(make(lambda r: httpx.Response(200, json=TAGS)).health())
    assert health.reachable and health.provider == "ollama"
    assert [m.name for m in health.models] == ["llama3.2:3b", "qwen3:4b"]
    assert health.models[0].parameter_size == "3.2B"


def test_health_reports_unreachable_and_malformed() -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    down = run(make(refuse).health())
    assert down.reachable is False and "not reachable" in down.detail
    bad = run(make(lambda r: httpx.Response(200, json={"models": "nope"})).health())
    assert bad.reachable is False
    empty = run(make(lambda r: httpx.Response(200, json={"models": []})).health())
    assert empty.reachable is True and empty.models == () and "no models" in empty.detail


@pytest.mark.parametrize(
    ("response", "code"),
    [
        (httpx.Response(404, json={"error": "model 'nope:1b' not found"}), "model_not_found"),
        (httpx.Response(500, json={"error": "out of memory"}), "provider_error"),
        (httpx.Response(200, content=b"<html>not json</html>\n"), "invalid_response"),
        (httpx.Response(200, content=b"[1,2]\n"), "invalid_response"),
        (httpx.Response(200, content=ndjson(chunk("partial"))), "invalid_response"),  # no done record
        (httpx.Response(200, content=ndjson({"model": "x", "message": {"content": 5}, "done": False})), "invalid_response"),
        (httpx.Response(200, content=ndjson({"model": "x", "message": {"content": "a"}})), "invalid_response"),
        (httpx.Response(200, content=ndjson(DONE)), "empty_response"),
        (httpx.Response(200, content=ndjson(chunk("a"), {"error": "runner crashed"})), "provider_error"),
    ],
)
def test_failures_map_to_explicit_provider_errors(response: httpx.Response, code: str) -> None:
    with pytest.raises(ProviderError) as caught:
        run(collect(make(lambda r: response)))
    assert caught.value.code == code
    assert caught.value.detail


def test_model_not_found_names_the_model() -> None:
    response = httpx.Response(404, json={"error": "model 'nope:1b' not found"})
    with pytest.raises(ProviderError) as caught:
        run(collect(make(lambda r: response), "nope:1b"))
    assert "nope:1b" in caught.value.detail


def test_connection_refused_is_provider_unavailable() -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    with pytest.raises(ProviderError) as caught:
        run(collect(make(refuse)))
    assert caught.value.code == "provider_unavailable"


def test_read_timeout_before_first_token_is_timeout() -> None:
    def slow(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("no bytes", request=request)

    with pytest.raises(ProviderError) as caught:
        run(collect(make(slow)))
    assert caught.value.code == "timeout"


def test_stall_mid_stream_hits_bounded_read_timeout() -> None:
    # MockTransport does not enforce timeouts, so exercise the real socket path instead.
    async def scenario() -> list:
        async def app(scope, receive, send):  # type: ignore[no-untyped-def]
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": ndjson(chunk("first")), "more_body": True})
            await asyncio.sleep(5)
            await send({"type": "http.response.body", "body": ndjson(DONE)})

        import socket

        import uvicorn

        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(app, log_level="error", lifespan="off"))
        serving = asyncio.create_task(server.serve(sockets=[sock]))
        while not server.started:
            await asyncio.sleep(0.01)
        adapter = OllamaAdapter(f"http://127.0.0.1:{port}", read_timeout=0.5)
        got: list = []
        try:
            async for item in adapter.stream_chat("llama3.2:3b", MESSAGES, GenerationOptions()):
                got.append(item)
        finally:
            await adapter.aclose()
            server.should_exit = True
            await serving
        return got

    with pytest.raises(ProviderError) as caught:
        run(scenario())
    assert caught.value.code == "timeout"


def test_cancelling_the_consumer_closes_the_stream() -> None:
    closed = asyncio.Event()

    class Stream(httpx.AsyncByteStream):
        async def __aiter__(self) -> AsyncIterator[bytes]:
            yield ndjson(chunk("first"))
            await asyncio.sleep(30)
            yield ndjson(DONE)

        async def aclose(self) -> None:
            closed.set()

    async def scenario() -> None:
        adapter = make(lambda r: httpx.Response(200, stream=Stream()))
        got_first = asyncio.Event()

        async def consume() -> None:
            async for _ in adapter.stream_chat("llama3.2:3b", MESSAGES, GenerationOptions()):
                got_first.set()

        task = asyncio.create_task(consume())
        await asyncio.wait_for(got_first.wait(), 2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await asyncio.wait_for(closed.wait(), 2)

    run(scenario())


@pytest.mark.parametrize(
    "url",
    [
        "https://127.0.0.1:11434",
        "http://example.com:11434",
        "http://localhost:11434",
        "http://192.168.1.5:11434",
        "http://127.0.0.1:11434/api",
        "http://user:pw@127.0.0.1:11434",
    ],
)
def test_only_loopback_literal_endpoints_are_accepted(url: str) -> None:
    with pytest.raises(ValueError):
        validate_base_url(url)


def test_loopback_endpoint_is_accepted() -> None:
    assert validate_base_url("http://127.0.0.1:11434/") == "http://127.0.0.1:11434"
