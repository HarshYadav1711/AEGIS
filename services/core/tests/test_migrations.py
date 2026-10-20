"""Schema upgrades from a Phase 0 database and conversation-table invariants."""

from __future__ import annotations

import sqlite3
import uuid
from pathlib import Path

import pytest

from app.memory import conversations as store
from app.memory import db


def _phase0_database(path: Path) -> None:
    """Build exactly what a Phase 0 build left on disk: migrations up to v1 only."""
    conn = db.connect(path)
    try:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute(
            "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)"
        )
        for statement in db.MIGRATIONS[0].statements:
            conn.execute(statement)
        conn.execute("INSERT INTO schema_migrations VALUES (1, 'baseline', '2026-10-21T00:00:00+00:00')")
    finally:
        conn.close()


def test_phase0_database_upgrades_in_place(tmp_path: Path) -> None:
    path = tmp_path / "aegis.db"
    _phase0_database(path)
    conn = sqlite3.connect(path)
    created_before = conn.execute("SELECT value FROM app_meta WHERE key = 'created_at'").fetchone()[0]
    conn.close()

    status = db.initialize(path)
    assert status.ok and status.schema_version == db.LATEST_SCHEMA_VERSION

    conn = sqlite3.connect(path)
    try:
        assert [r[0] for r in conn.execute("SELECT version FROM schema_migrations ORDER BY version")] == [m.version for m in db.MIGRATIONS]
        assert conn.execute("SELECT value FROM app_meta WHERE key = 'created_at'").fetchone()[0] == created_before
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        assert {"app_meta", "conversations", "messages", "file_tasks", "file_plans", "file_operations"} <= tables
    finally:
        conn.close()
    # Re-running is a no-op.
    assert db.initialize(path).schema_version == db.LATEST_SCHEMA_VERSION


@pytest.fixture
def database(tmp_path: Path) -> Path:
    path = tmp_path / "aegis.db"
    db.initialize(path)
    return path


def test_only_one_generation_in_flight_per_conversation(database: Path) -> None:
    convo = store.create_conversation(database)
    store.start_turn(database, convo.id, str(uuid.uuid4()), "a", "m")
    with pytest.raises(store.GenerationInProgress):
        store.start_turn(database, convo.id, str(uuid.uuid4()), "b", "m")
    _, messages = store.get_conversation(database, convo.id)
    assert len(messages) == 2  # the refused turn left nothing behind


def test_request_id_is_unique_across_conversations(database: Path) -> None:
    rid = str(uuid.uuid4())
    first = store.create_conversation(database)
    turn = store.start_turn(database, first.id, rid, "a", "m")
    store.finish_message(database, turn.assistant.id, status="complete", content="x", provider="p", model="m")
    second = store.create_conversation(database)
    with pytest.raises(store.RequestIdConflict):
        store.start_turn(database, second.id, rid, "a", "m")


def test_terminal_state_is_written_once(database: Path) -> None:
    convo = store.create_conversation(database)
    turn = store.start_turn(database, convo.id, str(uuid.uuid4()), "a", "m")
    store.finish_message(database, turn.assistant.id, status="cancelled", content="par", provider="p", model="m")
    after = store.finish_message(database, turn.assistant.id, status="complete", content="full", provider="p", model="m")
    assert (after.status, after.content) == ("cancelled", "par")


def test_schema_rejects_invalid_rows(database: Path) -> None:
    convo = store.create_conversation(database)
    conn = db.connect(database)
    try:
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO messages (id, conversation_id, seq, role, content, status, created_at) "
                "VALUES ('x', ?, 1, 'assistant', '', 'succeeded-ish', 'now')",
                (convo.id,),
            )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO messages (id, conversation_id, seq, role, content, status, created_at) "
                "VALUES ('y', ?, 1, 'tool', '', 'complete', 'now')",
                (convo.id,),
            )
        with pytest.raises(sqlite3.IntegrityError):  # unknown conversation (foreign key)
            conn.execute(
                "INSERT INTO messages (id, conversation_id, seq, role, content, status, client_request_id, created_at) "
                "VALUES ('z', 'nope', 1, 'user', 'a', 'complete', 'r', 'now')"
            )
    finally:
        conn.close()


def test_recover_interrupted_only_touches_in_flight_rows(database: Path) -> None:
    convo = store.create_conversation(database)
    done = store.start_turn(database, convo.id, str(uuid.uuid4()), "a", "m")
    store.finish_message(database, done.assistant.id, status="complete", content="ok", provider="p", model="m")
    live = store.start_turn(database, convo.id, str(uuid.uuid4()), "b", "m")
    assert store.recover_interrupted(database) == 1
    assert store.get_message(database, done.assistant.id).status == "complete"
    recovered = store.get_message(database, live.assistant.id)
    assert (recovered.status, recovered.error_code) == ("failed", "interrupted")


def test_title_comes_from_first_prompt_only(database: Path) -> None:
    convo = store.create_conversation(database)
    first = store.start_turn(database, convo.id, str(uuid.uuid4()), "  Plan   my\nweek " + "x" * 80, "m")
    store.finish_message(database, first.assistant.id, status="complete", content="ok", provider="p", model="m")
    store.start_turn(database, convo.id, str(uuid.uuid4()), "something else", "m")
    conversation, _ = store.get_conversation(database, convo.id)
    assert conversation.title.startswith("Plan my week x")
    assert len(conversation.title) <= store.TITLE_MAX
