"""Voice (Phase 5): transcription API, lifecycle, spoken-command interpretation and memory integration.

Uses the FIXTURE speech engines (tests/voice_fixtures.py) and the FIXTURE model
adapter, so every outcome here is deterministic; expectations are read back from
SQLite or the API. Real local engines are exercised in test_voice_engines.py.
"""

from __future__ import annotations

import asyncio
import json
import socket
import sqlite3
import threading
import time
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
import uvicorn
from fastapi.testclient import TestClient

from app.agents.voice import VoiceManager
from app.config import Settings
from app.main import server_config
from app.memory import adaptive as memory
from app.memory import conversations as store
from app.memory import db
from app.server import create_app
from tests.fixture_adapter import FIXTURE_MODEL, FixtureAdapter
from tests.test_conversations_api import wait_until
from tests.voice_fixtures import FIXTURE_TEXT, FixtureRecognizer, FixtureSynthesizer, wav_bytes


@pytest.fixture
def recognizer() -> FixtureRecognizer:
    return FixtureRecognizer()


@pytest.fixture
def synthesizer() -> FixtureSynthesizer:
    return FixtureSynthesizer()


@pytest.fixture
def vclient(settings: Settings, adapter: FixtureAdapter, recognizer: FixtureRecognizer,
            synthesizer: FixtureSynthesizer, auth: dict[str, str]) -> Iterator[TestClient]:
    app = create_app(settings, adapter, voice_manager=VoiceManager(recognizer, synthesizer))
    with TestClient(app, base_url="http://127.0.0.1:8765", headers=auth) as client:
        yield client


def transcribe(client: TestClient, audio: bytes, rid: str | None = None,
               content_type: str = "audio/wav") -> httpx.Response:
    return client.post("/voice/transcriptions", content=audio,
                       headers={"Content-Type": content_type, "X-Aegis-Request-Id": rid or str(uuid.uuid4())})


def interpret(client: TestClient, text: str, convo: str | None = None, low: bool = False) -> dict[str, Any]:
    response = client.post("/voice/interpret", json={"text": text, "conversation_id": convo, "low_confidence": low})
    assert response.status_code == 200, response.text
    return response.json()


def new_convo(client: TestClient) -> str:
    return client.post("/conversations").json()["conversation"]["id"]


def say(client: TestClient, convo: str, content: str, input_mode: str = "voice") -> list[dict[str, Any]]:
    """Send a (spoken) message through the ordinary conversation pipeline, as the app does after review."""
    body = {"client_request_id": str(uuid.uuid4()), "content": content, "model": FIXTURE_MODEL,
            "input_mode": input_mode}
    with client.stream("POST", f"/conversations/{convo}/messages", json=body) as response:
        assert response.status_code == 200, response.read()
        return [json.loads(line) for line in response.iter_lines() if line]


def notes(adapter: FixtureAdapter, call: int = -1) -> str:
    return next((m.content for m in adapter.calls[call][1][1:] if m.role == "system"), "")


def correct(client: TestClient, target: str, content: str, convo: str | None, rid: str | None = None,
            category: str = "project_exception") -> httpx.Response:
    return client.post("/voice/memory-corrections", json={
        "request_id": rid or str(uuid.uuid4()), "target_id": target, "content": content, "category": category,
        "conversation_id": convo,
    })


REMEMBER = "Remember that my preferred development workflow uses manual commits."
RECALL = "What did I ask you to remember about commits?"
CORRECTION = "Correct that memory: this exception applies only to my test repository."


# ------------------------------------------------------------------ transcription endpoint


def test_voice_endpoints_require_auth(settings: Settings, adapter: FixtureAdapter) -> None:
    app = create_app(settings, adapter, voice_manager=VoiceManager(FixtureRecognizer(), FixtureSynthesizer()))
    with TestClient(app, base_url="http://127.0.0.1:8765") as client:
        assert client.get("/voice/status").status_code == 401
        assert transcribe(client, wav_bytes()).status_code == 401
        assert client.post("/voice/interpret", json={"text": "hi"}).status_code == 401
        assert client.post("/voice/speech", json={"request_id": str(uuid.uuid4()), "text": "hi"}).status_code == 401


def test_status_reports_engines_and_limits(vclient: TestClient) -> None:
    body = vclient.get("/voice/status").json()
    assert body["stt"] == {"engine": "fixture-stt", "model": "fixture", "available": True, "detail": "fixture recognizer"}
    assert body["tts"]["available"] is True and body["tts"]["voices"] == ["Fixture Voice"]
    assert body["limits"] == {"sample_rate": 16000, "max_seconds": 60, "max_speak_chars": 1200}


def test_transcription_result_is_returned_and_audio_is_not_stored(
    vclient: TestClient, recognizer: FixtureRecognizer, settings: Settings,
) -> None:
    before = sorted(p.name for p in settings.data_dir.iterdir())
    response = transcribe(vclient, wav_bytes(seconds=1.5))
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "ok" and body["text"] == FIXTURE_TEXT and body["audio_ms"] == 1500
    assert body["engine"] == "fixture-stt" and body["low_confidence"] is False
    after = sorted(p.name for p in settings.data_dir.iterdir())
    assert after == before  # no audio file appeared
    with sqlite3.connect(settings.database_path) as conn:  # and nothing about the recording was written to the DB
        assert conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM memory_events").fetchone()[0] == 0


@pytest.mark.parametrize(
    ("audio", "content_type", "status", "code"),
    [
        (b"not a wav file at all, just bytes" * 3, "audio/wav", 422, "invalid_audio"),
        (wav_bytes(seconds=1, rate=44100), "audio/wav", 422, "invalid_audio"),
        (wav_bytes(seconds=1, channels=2), "audio/wav", 422, "invalid_audio"),
        (wav_bytes(seconds=0.1), "audio/wav", 422, "audio_too_short"),
        (wav_bytes(seconds=61), "audio/wav", 413, "audio_too_long"),
        (wav_bytes(seconds=1), "application/json", 415, "invalid_audio"),
    ],
    ids=["not-wav", "44khz", "stereo", "too-short", "too-long", "wrong-type"],
)
def test_bad_recordings_are_refused_before_the_engine(
    vclient: TestClient, recognizer: FixtureRecognizer, audio: bytes, content_type: str, status: int, code: str,
) -> None:
    response = transcribe(vclient, audio, content_type=content_type)
    assert (response.status_code, response.json()["detail"]) == (status, code)
    assert recognizer.calls == 0


def test_missing_request_id_is_refused(vclient: TestClient) -> None:
    response = vclient.post("/voice/transcriptions", content=wav_bytes(), headers={"Content-Type": "audio/wav"})
    assert response.status_code == 422


@pytest.mark.parametrize("outcome", ["silence", "unintelligible"])
def test_silence_and_unintelligible_are_reported_not_invented(
    vclient: TestClient, recognizer: FixtureRecognizer, outcome: str,
) -> None:
    recognizer.status_value = outcome
    body = transcribe(vclient, wav_bytes()).json()
    assert body["status"] == outcome and body["text"] == ""


def test_unavailable_engine_is_a_clear_error(vclient: TestClient, recognizer: FixtureRecognizer) -> None:
    recognizer.available = False
    response = transcribe(vclient, wav_bytes())
    assert (response.status_code, response.json()["detail"]) == (503, "stt_unavailable")
    assert vclient.get("/voice/status").json()["stt"]["available"] is False


def test_cancel_stops_a_running_transcription(vclient: TestClient, recognizer: FixtureRecognizer) -> None:
    recognizer.hold = threading.Event()
    rid = str(uuid.uuid4())
    result: list[httpx.Response] = []
    worker = threading.Thread(target=lambda: result.append(transcribe(vclient, wav_bytes(), rid)))
    worker.start()
    assert recognizer.started.wait(5)
    assert vclient.post(f"/voice/jobs/{rid}/cancel").json() == {"cancel_requested": True}
    worker.join(5)
    assert (result[0].status_code, result[0].json()["detail"]) == (409, "cancelled")
    assert vclient.post(f"/voice/jobs/{rid}/cancel").json() == {"cancel_requested": False}  # nothing left to cancel


def test_second_transcription_while_one_runs_is_busy(vclient: TestClient, recognizer: FixtureRecognizer) -> None:
    recognizer.hold = threading.Event()
    worker = threading.Thread(target=lambda: transcribe(vclient, wav_bytes()))
    worker.start()
    assert recognizer.started.wait(5)
    response = transcribe(vclient, wav_bytes())
    assert (response.status_code, response.json()["detail"]) == (409, "voice_busy")
    recognizer.hold.set()
    worker.join(5)


# ------------------------------------------------------------------ speech synthesis endpoint


def test_speech_returns_wav_with_measurements(vclient: TestClient, synthesizer: FixtureSynthesizer) -> None:
    response = vclient.post("/voice/speech", json={"request_id": str(uuid.uuid4()), "text": "Hello there."})
    assert response.status_code == 200 and response.headers["content-type"] == "audio/wav"
    assert response.content[:4] == b"RIFF" and response.headers["X-Aegis-Voice"] == "Fixture Voice"
    assert int(response.headers["X-Aegis-Audio-Ms"]) == 100 and synthesizer.texts == ["Hello there."]


@pytest.mark.parametrize(("body", "code"), [({"text": "hi", "voice": "Someone Else"}, "unknown_voice"),
                                            ({"text": "   "}, "nothing_to_say")])
def test_speech_refusals(vclient: TestClient, body: dict[str, Any], code: str) -> None:
    response = vclient.post("/voice/speech", json={"request_id": str(uuid.uuid4()), **body})
    assert (response.status_code, response.json()["detail"]) == (422, code)


def test_playback_stop_cancels_pending_synthesis(vclient: TestClient, synthesizer: FixtureSynthesizer) -> None:
    synthesizer.hold = threading.Event()
    rid = str(uuid.uuid4())
    result: list[httpx.Response] = []
    worker = threading.Thread(
        target=lambda: result.append(vclient.post("/voice/speech", json={"request_id": rid, "text": "Long reply."})))
    worker.start()
    assert synthesizer.started.wait(5)
    assert vclient.post(f"/voice/jobs/{rid}/cancel").json()["cancel_requested"] is True
    worker.join(5)
    assert (result[0].status_code, result[0].json()["detail"]) == (409, "cancelled")
    assert synthesizer.texts == []


# ------------------------------------------------------------------ interpretation (no writes)


def test_ordinary_question_is_sent_without_review(vclient: TestClient) -> None:
    body = interpret(vclient, "What is the capital of France?")
    assert (body["kind"], body["review_required"], body["category"]) == ("chat", False, None)


def test_low_confidence_transcript_needs_review(vclient: TestClient) -> None:
    body = interpret(vclient, "What is the capital of France?", low=True)
    assert body["review_required"] is True and body["category"] == "transcription_doubt"


def test_recall_question_is_labelled_and_not_reviewed(vclient: TestClient) -> None:
    body = interpret(vclient, RECALL)
    assert (body["kind"], body["review_required"]) == ("recall", False)


def test_remember_always_needs_review_and_writes_nothing(vclient: TestClient, settings: Settings) -> None:
    body = interpret(vclient, REMEMBER)
    assert (body["kind"], body["review_required"]) == ("remember", True)
    assert body["body"] == "my preferred development workflow uses manual commits."
    assert memory.search(settings.database_path) == []


@pytest.mark.parametrize("text", ["Forget that memory.", "Delete what I told you about commits", "Please erase my memories"])
def test_forget_by_voice_is_refused(vclient: TestClient, text: str) -> None:
    body = interpret(vclient, text)
    assert body["kind"] == "forget" and body["review_required"] is True and "Memory panel" in body["reason"]


@pytest.mark.parametrize("text", ["Approve.", "Yes, approve the plan and move the files", "Go ahead", "Proceed with it"])
def test_spoken_approval_is_refused(vclient: TestClient, text: str) -> None:
    body = interpret(vclient, text)
    assert body["kind"] == "approval" and body["review_required"] is True and "Approve button" in body["reason"]


def test_remember_on_an_existing_subject_is_flagged_as_conflict(vclient: TestClient, settings: Settings) -> None:
    memory.add_explicit(settings.database_path, content="My editor is Vim", kind="fact", subject="editor",
                        scope="global")
    body = interpret(vclient, "Remember my editor is VS Code")
    assert body["category"] == "conflicting_claim" and body["conflict"]["content"] == "My editor is Vim"


def test_temporary_remember_is_flagged(vclient: TestClient) -> None:
    body = interpret(vclient, "Remember that I use the staging server for now")
    assert body["kind"] == "remember" and body["category"] == "temporary"


# ------------------------------------------------------------------ spoken memory: remember → recall → correct


def test_spoken_remember_is_stored_with_voice_provenance(vclient: TestClient, settings: Settings) -> None:
    convo = new_convo(vclient)
    events = say(vclient, convo, REMEMBER)
    assert events[-1]["type"] == "complete"
    user = store.get_message(settings.database_path, events[0]["user_message"]["id"])
    assert user.input_mode == "voice" and events[0]["user_message"]["input_mode"] == "voice"
    [fact] = memory.search(settings.database_path, "manual commits")
    assert fact["status"] == "active" and fact["verification"] == "user_stated"
    assert fact["content"] == "my preferred development workflow uses manual commits."
    assert fact["source"]["source_type"] == "user_message" and fact["source"]["source_id"] == user.id
    assert "spoken" in fact["source"]["detail"]


def test_typed_messages_stay_text(vclient: TestClient, settings: Settings) -> None:
    convo = new_convo(vclient)
    events = say(vclient, convo, "hello", input_mode="text")
    assert store.get_message(settings.database_path, events[0]["user_message"]["id"]).input_mode == "text"
    response = vclient.post(f"/conversations/{convo}/messages", json={
        "client_request_id": str(uuid.uuid4()), "content": "x", "model": FIXTURE_MODEL, "input_mode": "telepathy"})
    assert response.status_code == 422


def test_spoken_ordinary_sentence_is_not_stored_as_memory(vclient: TestClient, settings: Settings) -> None:
    convo = new_convo(vclient)
    say(vclient, convo, "My workflow uses manual commits and I like tea.")
    assert memory.search(settings.database_path) == []


def _remember_and_recall(vclient: TestClient) -> tuple[str, dict[str, Any]]:
    convo = new_convo(vclient)
    say(vclient, convo, REMEMBER)
    say(vclient, convo, RECALL)
    [fact] = [f for f in memory.search(vclient.app.state.settings.database_path, "commits")]  # type: ignore[attr-defined]
    return convo, fact


def test_recall_by_voice_puts_the_memory_in_context(vclient: TestClient, adapter: FixtureAdapter) -> None:
    _remember_and_recall(vclient)
    assert "uses manual commits" in notes(adapter)


def test_spoken_correction_resolves_that_memory_and_proposes_a_reviewed_version(
    vclient: TestClient, settings: Settings,
) -> None:
    convo, fact = _remember_and_recall(vclient)
    body = interpret(vclient, CORRECTION, convo)
    assert body["kind"] == "correct" and body["review_required"] is True
    assert body["category"] == "project_exception" and body["target"]["id"] == fact["id"]
    assert body["proposed_content"] == (
        "My preferred development workflow uses manual commits (correction: this exception applies only to my test "
        "repository)."
    )
    assert memory.search(settings.database_path, include_history=True)[0]["version"] == 1  # nothing written yet


def test_applied_spoken_correction_versions_the_memory(
    vclient: TestClient, adapter: FixtureAdapter, settings: Settings,
) -> None:
    convo, fact = _remember_and_recall(vclient)
    proposal = interpret(vclient, CORRECTION, convo)
    rid = str(uuid.uuid4())
    response = correct(vclient, fact["id"], proposal["proposed_content"], convo, rid)
    assert response.status_code == 200, response.text
    new = response.json()["memory"]
    assert new["version"] == 2 and new["lineage_id"] == fact["lineage_id"] and new["status"] == "active"
    assert new["supersedes_id"] == fact["id"] and new["verification"] == "user_stated"
    assert new["source"]["source_type"] == "voice_command" and new["source"]["source_id"] == rid
    assert new["source"]["conversation_id"] == convo and "spoken command" in new["source"]["detail"]
    old = memory.describe(settings.database_path, fact["id"])
    assert old["status"] == "superseded" and old["superseded_by"] == new["id"]
    # A retried apply with the same request id does not create a third version.
    again = correct(vclient, fact["id"], proposal["proposed_content"], convo, rid)
    assert again.status_code == 200 and again.json()["memory"]["id"] == new["id"]
    history = memory.search(settings.database_path, "commits", include_history=True)
    assert sorted(f["version"] for f in history) == [1, 2]
    # The next recall sees only the corrected version.
    say(vclient, convo, RECALL)
    context = notes(adapter)
    assert "only to my test repository" in context and context.count("uses manual commits") == 1


def test_correction_of_superseded_version_is_refused(vclient: TestClient) -> None:
    convo, fact = _remember_and_recall(vclient)
    assert correct(vclient, fact["id"], "First fix.", convo, category="explicit_correction").status_code == 200
    response = correct(vclient, fact["id"], "Second fix on the old version.", convo, category="explicit_correction")
    assert (response.status_code, response.json()["detail"]) == (409, "not_current")


def test_rejected_and_superseded_memories_are_never_targets_or_context(
    vclient: TestClient, adapter: FixtureAdapter, settings: Settings,
) -> None:
    convo, fact = _remember_and_recall(vclient)
    memory.reject(settings.database_path, fact["id"])
    body = interpret(vclient, CORRECTION, convo)
    assert body["target"] is None and all(c["id"] != fact["id"] for c in body["candidates"])
    response = correct(vclient, fact["id"], "Anything.", convo, category="explicit_correction")
    assert (response.status_code, response.json()["detail"]) == (409, "not_current")
    say(vclient, convo, RECALL)
    assert "manual commits" not in notes(adapter)


def test_ambiguous_that_memory_asks_the_user_to_choose(vclient: TestClient, settings: Settings) -> None:
    convo = new_convo(vclient)
    say(vclient, convo, "Remember that my test repository is called sandbox-one.")
    say(vclient, convo, "Remember that my main repository is called aegis.")
    say(vclient, convo, "What is two plus two?")
    body = interpret(vclient, "Correct that memory: it is called delta.", convo)
    assert body["target"] is None and len(body["candidates"]) == 2 and body["proposed_content"] is None
    # When the correction's own words point at one of them, that one is proposed (still only after review).
    body = interpret(vclient, "Correct that memory: the sandbox one is called sandbox-two.", convo)
    assert body["target"]["content"] == "my test repository is called sandbox-one."


def test_correction_without_conversation_context_never_picks_silently(vclient: TestClient, settings: Settings) -> None:
    memory.add_explicit(settings.database_path, content="My workflow uses manual commits", kind="fact", subject=None,
                        scope="global")
    body = interpret(vclient, "Correct that memory: my workflow uses manual commits only in my test repository")
    assert body["target"] is None and [c["content"] for c in body["candidates"]] == ["My workflow uses manual commits"]


def test_temporary_correction_is_not_applied_by_default(vclient: TestClient) -> None:
    convo, _ = _remember_and_recall(vclient)
    body = interpret(vclient, "Correct that memory: for now I use automatic commits.", convo)
    assert body["category"] == "temporary" and "temporary" in body["reason"]


def test_explicit_correction_proposes_the_users_words(vclient: TestClient) -> None:
    convo, _ = _remember_and_recall(vclient)
    body = interpret(vclient, "Correct that memory to say my development workflow uses automatic commits", convo)
    assert body["category"] == "explicit_correction"
    assert body["proposed_content"] == "My development workflow uses automatic commits."


def test_spoken_correction_with_a_secret_is_refused(vclient: TestClient) -> None:
    convo, fact = _remember_and_recall(vclient)
    response = correct(vclient, fact["id"], "My password is hunter2hunter2", convo, category="explicit_correction")
    assert (response.status_code, response.json()["detail"]) == (422, "secret_detected")


def test_correction_request_cannot_set_status_or_provenance(vclient: TestClient) -> None:
    convo, fact = _remember_and_recall(vclient)
    response = vclient.post("/voice/memory-corrections", json={
        "request_id": str(uuid.uuid4()), "target_id": fact["id"], "content": "x", "category": "explicit_correction",
        "status": "active", "verification": "tool_verified"})
    assert response.status_code == 422


# ------------------------------------------------------------------ permission boundaries


def test_spoken_approval_sent_as_chat_does_not_approve_a_file_plan(
    vclient: TestClient, adapter: FixtureAdapter, tmp_path: Path,
) -> None:
    from tests.file_fixtures import make_sample_folder, snapshot

    adapter.script.chunks = ['{"intent": "organize_by_type"}']
    task = vclient.post("/file-tasks/interpret", json={"text": "Organize the files in this folder by type.",
                                                        "model": FIXTURE_MODEL}).json()["task"]
    root = make_sample_folder(tmp_path / "sample")
    before = snapshot(root)
    detail = vclient.post(f"/file-tasks/{task['task']['id']}/scope", json={"root_path": str(root)}).json()
    assert detail["task"]["status"] == "awaiting_approval"
    adapter.script.chunks = ["FIXTURE ", "reply"]
    assert interpret(vclient, "Yes, approve the plan and move the files")["kind"] == "approval"
    say(vclient, new_convo(vclient), "Yes, approve the plan and move the files")  # even if the user sends it anyway
    after = vclient.get(f"/file-tasks/{task['task']['id']}").json()
    assert after["task"]["status"] == "awaiting_approval" and snapshot(root) == before


def test_voice_interpretation_routes_no_tools(vclient: TestClient, adapter: FixtureAdapter) -> None:
    calls = len(adapter.calls)
    interpret(vclient, "Organize the files in my downloads folder by type")
    interpret(vclient, CORRECTION)
    assert len(adapter.calls) == calls  # deterministic: no model call, no task created
    assert vclient.get("/file-tasks").json()["tasks"] == []


# ------------------------------------------------------------------ disconnection and shutdown


def _serve(app) -> tuple[uvicorn.Server, threading.Thread, str]:  # type: ignore[no-untyped-def]
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    base = f"http://127.0.0.1:{sock.getsockname()[1]}"
    server = uvicorn.Server(server_config(app))
    thread = threading.Thread(target=lambda: asyncio.run(server.serve(sockets=[sock])), daemon=True)
    thread.start()
    wait_until(lambda: server.started)
    return server, thread, base


@pytest.mark.parametrize("job", ["transcription", "speech"])
def test_shutdown_during_capture_processing_or_playback_synthesis_is_prompt(
    settings: Settings, adapter: FixtureAdapter, auth: dict[str, str], job: str,
) -> None:
    recognizer = FixtureRecognizer(hold=threading.Event())  # never released
    synthesizer = FixtureSynthesizer(hold=threading.Event())
    server, thread, base = _serve(create_app(settings, adapter, voice_manager=VoiceManager(recognizer, synthesizer)))
    results: list[Any] = []

    def call() -> None:
        with httpx.Client(base_url=base, headers=auth, trust_env=False, timeout=15) as c:
            try:
                if job == "transcription":
                    results.append(c.post("/voice/transcriptions", content=wav_bytes(), headers={
                        "Content-Type": "audio/wav", "X-Aegis-Request-Id": str(uuid.uuid4())}).status_code)
                else:
                    results.append(c.post("/voice/speech", json={"request_id": str(uuid.uuid4()), "text": "x"})
                                   .status_code)
            except httpx.HTTPError as error:
                results.append(type(error).__name__)

    worker = threading.Thread(target=call)
    worker.start()
    assert (recognizer if job == "transcription" else synthesizer).started.wait(5)
    started = time.monotonic()
    server.should_exit = True
    thread.join(15)
    assert not thread.is_alive(), "core kept running with a voice job open"
    assert time.monotonic() - started < 8
    worker.join(5)
    assert results and results[0] != 200  # the job ended as cancelled/interrupted, never as a fake success


def test_renderer_disconnect_mid_transcription_leaves_no_state(vclient: TestClient, recognizer: FixtureRecognizer,
                                                               settings: Settings) -> None:
    """Electron main aborts the request when the renderer goes away; the core may finish, but stores nothing."""
    recognizer.hold = threading.Event()
    worker = threading.Thread(target=lambda: transcribe(vclient, wav_bytes()))
    worker.start()
    assert recognizer.started.wait(5)
    recognizer.hold.set()
    worker.join(5)
    with sqlite3.connect(settings.database_path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == 0


# ------------------------------------------------------------------ schema


def test_v7_database_upgrades_to_v8_with_messages_and_memory_intact(tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    path = tmp_path / "old.db"
    with monkeypatch.context() as m:
        m.setattr(db, "MIGRATIONS", db.MIGRATIONS[:7])
        m.setattr(db, "LATEST_SCHEMA_VERSION", 7)
        assert db.initialize(path).schema_version == 7
        convo = store.create_conversation(path)
        with sqlite3.connect(path) as conn:  # a v7 message row, written the v7 way
            conn.execute("INSERT INTO messages (id, conversation_id, seq, role, content, status, client_request_id, "
                         "created_at) VALUES ('m1', ?, 1, 'user', 'old', 'complete', 'r1', 't')", (convo.id,))
        fact, _ = memory.add_explicit(path, content="Kept across v8.", kind="fact", subject=None, scope="global")
    assert db.initialize(path).schema_version == db.LATEST_SCHEMA_VERSION == 8
    assert store.get_message(path, "m1").input_mode == "text"
    kept = memory.describe(path, fact.id)
    assert kept["content"] == "Kept across v8." and kept["source"]["source_type"] == "memory_ui"
    with sqlite3.connect(path) as conn, pytest.raises(sqlite3.IntegrityError):
        conn.execute("UPDATE messages SET input_mode = 'mind' WHERE id = 'm1'")
