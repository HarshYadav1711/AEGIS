"""Conversation API end to end over a real loopback socket, with the scripted FIXTURE provider."""

from __future__ import annotations

import asyncio
import json
import threading
import time
import uuid

import httpx
import pytest

from app.memory import conversations as store
from app.models.base import ProviderError
from tests.conftest import LiveServer
from tests.fixture_adapter import FIXTURE_MODEL, FixtureAdapter


def new_conversation(c: httpx.Client) -> str:
    response = c.post("/conversations")
    assert response.status_code == 201
    return response.json()["conversation"]["id"]


def send(c: httpx.Client, convo: str, content: str = "hello", model: str = FIXTURE_MODEL, rid: str | None = None):  # type: ignore[no-untyped-def]
    body = {"client_request_id": rid or str(uuid.uuid4()), "content": content, "model": model}
    with c.stream("POST", f"/conversations/{convo}/messages", json=body) as response:
        if response.status_code != 200:
            response.read()
            return response.status_code, response.json()
        return 200, [json.loads(line) for line in response.iter_lines() if line]


def wait_until(predicate, timeout: float = 5.0) -> None:  # type: ignore[no-untyped-def]
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError("condition not reached")
        time.sleep(0.02)


def test_requests_require_auth(live_server: LiveServer) -> None:
    with httpx.Client(base_url=live_server.base_url, trust_env=False) as anon:
        assert anon.get("/conversations").status_code == 401
        assert anon.post("/conversations").status_code == 401
        assert anon.get("/models").status_code == 401


def test_full_turn_streams_and_persists(live_server: LiveServer, adapter: FixtureAdapter, settings) -> None:
    with live_server.client() as c:
        convo = new_conversation(c)
        status, events = send(c, convo, "What is AEGIS?")
        assert status == 200
        assert [e["type"] for e in events] == ["accepted", "streaming", "delta", "delta", "complete"]
        accepted = events[0]
        assert accepted["user_message"]["content"] == "What is AEGIS?"
        assert accepted["assistant_message"]["status"] == "pending"
        final = events[-1]["message"]
        assert final["status"] == "complete"
        assert final["content"] == "FIXTURE reply"
        assert (final["provider"], final["model"]) == ("fixture", FIXTURE_MODEL)
        assert final["completion_tokens"] == 2 and final["duration_ms"] is not None

        body = c.get(f"/conversations/{convo}").json()
        assert body["conversation"]["title"] == "What is AEGIS?"
        assert [(m["role"], m["status"]) for m in body["messages"]] == [("user", "complete"), ("assistant", "complete")]
        listed = c.get("/conversations").json()["conversations"]
        assert listed[0]["id"] == convo and listed[0]["message_count"] == 2

    # The system prompt states the real (limited) capabilities and the user prompt is last.
    _, messages = adapter.calls[0]
    assert messages[0].role == "system" and "cannot" in messages[0].content
    assert (messages[-1].role, messages[-1].content) == ("user", "What is AEGIS?")


def test_history_includes_only_completed_turns(live_server: LiveServer, adapter: FixtureAdapter) -> None:
    with live_server.client() as c:
        convo = new_conversation(c)
        send(c, convo, "first")
        adapter.script.error_after = ProviderError("provider_error", "boom")
        send(c, convo, "second fails")
        adapter.script.error_after = None
        send(c, convo, "third")
    _, context = adapter.calls[-1]
    assert [(m.role, m.content) for m in context[1:]] == [
        ("user", "first"),
        ("assistant", "FIXTURE reply"),
        ("user", "third"),
    ]


def test_messages_survive_core_restart(settings, adapter: FixtureAdapter, auth) -> None:  # type: ignore[no-untyped-def]
    from fastapi.testclient import TestClient

    from app.server import create_app

    with TestClient(create_app(settings, adapter), base_url="http://127.0.0.1:8765") as first:
        convo = first.post("/conversations", headers=auth).json()["conversation"]["id"]
        rid = str(uuid.uuid4())
        first.post(
            f"/conversations/{convo}/messages",
            headers=auth,
            json={"client_request_id": rid, "content": "remember me", "model": FIXTURE_MODEL},
        )
    with TestClient(create_app(settings, FixtureAdapter()), base_url="http://127.0.0.1:8765") as second:
        messages = second.get(f"/conversations/{convo}", headers=auth).json()["messages"]
    assert [m["content"] for m in messages] == ["remember me", "FIXTURE reply"]


def test_repeated_request_id_replays_instead_of_duplicating(live_server: LiveServer, adapter: FixtureAdapter) -> None:
    with live_server.client() as c:
        convo = new_conversation(c)
        rid = str(uuid.uuid4())
        _, first = send(c, convo, "once", rid=rid)
        _, again = send(c, convo, "once", rid=rid)
        assert [e["type"] for e in again] == ["accepted", "complete"]
        assert again[0]["replay"] is True
        assert again[-1]["message"]["id"] == first[-1]["message"]["id"]
        assert len(c.get(f"/conversations/{convo}").json()["messages"]) == 2
        other = new_conversation(c)
        status, body = send(c, other, "once", rid=rid)
        assert (status, body["detail"]) == (409, "request_id_reused")
    assert len(adapter.calls) == 1


@pytest.mark.parametrize(
    ("body", "status"),
    [
        ({"client_request_id": "not-a-uuid", "content": "x", "model": FIXTURE_MODEL}, 422),
        ({"client_request_id": str(uuid.uuid4()), "content": "   ", "model": FIXTURE_MODEL}, 422),
        ({"client_request_id": str(uuid.uuid4()), "content": "", "model": FIXTURE_MODEL}, 422),
        ({"client_request_id": str(uuid.uuid4()), "content": "x" * 8001, "model": FIXTURE_MODEL}, 422),
        ({"client_request_id": str(uuid.uuid4()), "content": "a\x00b", "model": FIXTURE_MODEL}, 422),
        ({"client_request_id": str(uuid.uuid4()), "content": "x", "model": "../../etc"}, 422),
        ({"client_request_id": str(uuid.uuid4()), "content": "x", "model": FIXTURE_MODEL, "tools": ["shell"]}, 422),
        ({"content": "x", "model": FIXTURE_MODEL}, 422),
    ],
)
def test_invalid_send_requests_are_rejected(live_server: LiveServer, body: dict, status: int) -> None:
    with live_server.client() as c:
        convo = new_conversation(c)
        assert c.post(f"/conversations/{convo}/messages", json=body).status_code == status
        assert c.get(f"/conversations/{convo}").json()["messages"] == []


def test_unknown_conversation_and_bad_ids(live_server: LiveServer) -> None:
    with live_server.client() as c:
        status, body = send(c, str(uuid.uuid4()))
        assert (status, body["detail"]) == (404, "conversation_not_found")
        assert c.get(f"/conversations/{uuid.uuid4()}").status_code == 404
        assert c.get("/conversations/not-a-uuid").status_code == 422


@pytest.mark.parametrize(
    ("error", "model", "code"),
    [
        (None, "missing-model:7b", "model_not_found"),
        (ProviderError("timeout", "Ollama response timed out."), FIXTURE_MODEL, "timeout"),
        (ProviderError("invalid_response", "not JSON"), FIXTURE_MODEL, "invalid_response"),
    ],
)
def test_provider_failures_are_persisted_as_failed(
    live_server: LiveServer, adapter: FixtureAdapter, error, model: str, code: str
) -> None:
    adapter.script.error_after = error
    with live_server.client() as c:
        convo = new_conversation(c)
        _, events = send(c, convo, model=model)
        terminal = events[-1]
        assert terminal["type"] == "failed"
        assert terminal["error"]["code"] == code
        stored = c.get(f"/conversations/{convo}").json()["messages"][-1]
        assert stored["status"] == "failed" and stored["error_code"] == code
        assert stored["status"] != "complete"


def test_unreachable_provider_fails_honestly(live_server: LiveServer, adapter: FixtureAdapter) -> None:
    adapter.reachable = False
    with live_server.client() as c:
        convo = new_conversation(c)
        _, events = send(c, convo)
        assert [e["type"] for e in events] == ["accepted", "failed"]
        assert events[-1]["error"]["code"] == "provider_unavailable"
        models = c.get("/models").json()
        assert models["reachable"] is False and models["models"] == []


def _hold(adapter: FixtureAdapter, live: LiveServer) -> asyncio.Event:
    event = asyncio.Event()
    adapter.script.hold = event
    return event


def _stream_in_thread(live: LiveServer, convo: str, events: list, stop_after_first_delta: bool = False) -> threading.Thread:
    def run() -> None:
        with live.client(timeout=10) as c:
            body = {"client_request_id": str(uuid.uuid4()), "content": "long", "model": FIXTURE_MODEL}
            try:
                with c.stream("POST", f"/conversations/{convo}/messages", json=body) as response:
                    for line in response.iter_lines():
                        if line:
                            events.append(json.loads(line))
                            if stop_after_first_delta and events[-1]["type"] == "delta":
                                return  # closes the connection mid-generation
            except httpx.TransportError:
                events.append({"type": "connection_lost"})  # expected when the server shuts down

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return thread


def test_user_cancel_stops_generation_and_records_cancelled(live_server: LiveServer, adapter: FixtureAdapter) -> None:
    hold = _hold(adapter, live_server)
    with live_server.client() as c:
        convo = new_conversation(c)
        events: list = []
        thread = _stream_in_thread(live_server, convo, events)
        wait_until(lambda: any(e["type"] == "delta" for e in events))
        message_id = events[0]["assistant_message"]["id"]

        # A second send while one is in flight is refused by the database constraint.
        status, body = send(c, convo, "concurrent")
        assert (status, body["detail"]) == (409, "generation_in_progress")

        result = c.post(f"/generations/{message_id}/cancel").json()
        assert result["cancel_requested"] is True
        assert result["message"]["status"] == "cancelled"
        assert result["message"]["content"] == "FIXTURE "  # partial text kept, clearly not complete
        thread.join(5)
        assert events[-1]["type"] == "cancelled"
        assert adapter.closed_streams == 1
        # Cancelling again is a harmless no-op that reports the stored state.
        again = c.post(f"/generations/{message_id}/cancel").json()
        assert again == {"cancel_requested": False, "message": result["message"]}
    live_server.call(hold.set)


def test_client_disconnect_mid_stream_is_recorded_as_interrupted(
    live_server: LiveServer, adapter: FixtureAdapter, settings
) -> None:
    hold = _hold(adapter, live_server)
    with live_server.client() as c:
        convo = new_conversation(c)
        events: list = []
        _stream_in_thread(live_server, convo, events, stop_after_first_delta=True).join(5)
        message_id = events[0]["assistant_message"]["id"]

        def finished() -> bool:
            return store.get_message(settings.database_path, message_id).status in store.TERMINAL_STATUSES

        wait_until(finished)
        message = store.get_message(settings.database_path, message_id)
        assert (message.status, message.error_code) == ("failed", "interrupted")
        # The conversation is usable again afterwards.
        live_server.call(hold.set)
        adapter.script.hold = None
        _, events = send(c, convo, "after")
        assert events[-1]["type"] == "complete"


def test_total_timeout_is_bounded(settings, adapter: FixtureAdapter) -> None:
    from app.agents.chat import GenerationManager
    from app.memory import db

    db.initialize(settings.database_path)
    convo = store.create_conversation(settings.database_path)
    turn = store.start_turn(settings.database_path, convo.id, str(uuid.uuid4()), "slow", FIXTURE_MODEL)
    adapter.script.delay_s = 1.0

    async def scenario() -> list:
        manager = GenerationManager(settings.database_path, adapter, total_timeout_s=0.3)
        return [e async for e in manager.start(turn).events()]

    events = asyncio.run(scenario())
    assert events[-1]["type"] == "failed"
    assert events[-1]["error"]["code"] == "timeout"


def test_startup_recovers_interrupted_replies(settings, adapter: FixtureAdapter, auth) -> None:  # type: ignore[no-untyped-def]
    from fastapi.testclient import TestClient

    from app.memory import db
    from app.server import create_app

    db.initialize(settings.database_path)
    convo = store.create_conversation(settings.database_path)
    turn = store.start_turn(settings.database_path, convo.id, str(uuid.uuid4()), "crash", FIXTURE_MODEL)
    store.mark_streaming(settings.database_path, turn.assistant.id, "fixture")
    # Simulate the core dying here: the reply is left 'streaming' on disk.

    with TestClient(create_app(settings, adapter), base_url="http://127.0.0.1:8765") as c:
        messages = c.get(f"/conversations/{convo.id}", headers=auth).json()["messages"]
        assert messages[-1]["status"] == "failed"
        assert messages[-1]["error_code"] == "interrupted"
        # And a new turn can start (the one-active-generation slot is free).
        response = c.post(
            f"/conversations/{convo.id}/messages",
            headers=auth,
            json={"client_request_id": str(uuid.uuid4()), "content": "again", "model": FIXTURE_MODEL},
        )
        assert response.status_code == 200


def test_shutdown_during_a_stream_is_prompt_and_recorded(settings, adapter: FixtureAdapter, auth) -> None:  # type: ignore[no-untyped-def]
    """Quitting mid-reply must not wait for the generation: bounded shutdown, honest 'interrupted' record."""
    import socket

    import uvicorn

    from app.main import server_config
    from app.server import create_app

    hold = asyncio.Event()  # never released: the reply would otherwise stream forever
    adapter.script.hold = hold
    app = create_app(settings, adapter)
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    base = f"http://127.0.0.1:{sock.getsockname()[1]}"
    server = uvicorn.Server(server_config(app))
    thread = threading.Thread(target=lambda: asyncio.run(server.serve(sockets=[sock])), daemon=True)
    thread.start()
    wait_until(lambda: server.started)

    events: list = []
    live = LiveServer(app, base, asyncio.new_event_loop(), auth)
    with live.client() as c:
        convo = new_conversation(c)
    streamer = _stream_in_thread(live, convo, events)
    wait_until(lambda: any(e["type"] == "delta" for e in events))
    message_id = events[0]["assistant_message"]["id"]

    started = time.monotonic()
    server.should_exit = True
    thread.join(15)
    assert not thread.is_alive(), "core kept running with an open reply stream"
    assert time.monotonic() - started < 8
    streamer.join(5)
    message = store.get_message(settings.database_path, message_id)
    assert (message.status, message.error_code) == ("failed", "interrupted")
