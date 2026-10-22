"""Conversation and message persistence (schema v2).

Every function opens its own short-lived connection; writes are single
statements or one IMMEDIATE transaction, so a crash leaves either the old or
the new state, never half a turn.
"""

from __future__ import annotations

import sqlite3
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from app.memory.db import connect

MessageStatus = Literal["pending", "streaming", "complete", "failed", "cancelled"]
TERMINAL_STATUSES: frozenset[str] = frozenset({"complete", "failed", "cancelled"})
TITLE_MAX = 60
DEFAULT_TITLE = "New conversation"


@dataclass(frozen=True)
class Conversation:
    id: str
    title: str
    created_at: str
    updated_at: str
    message_count: int = 0


@dataclass(frozen=True)
class Message:
    id: str
    conversation_id: str
    seq: int
    role: Literal["user", "assistant"]
    content: str
    status: MessageStatus
    reply_to: str | None
    client_request_id: str | None
    provider: str | None
    model: str | None
    error_code: str | None
    error_detail: str | None
    finish_reason: str | None
    prompt_tokens: int | None
    completion_tokens: int | None
    duration_ms: int | None
    created_at: str
    completed_at: str | None
    # 'voice' when the user message was spoken and transcribed locally (schema v8); assistant rows stay 'text'.
    input_mode: Literal["text", "voice"] = "text"


@dataclass(frozen=True)
class Turn:
    user: Message
    assistant: Message


class NotFound(LookupError):
    pass


class GenerationInProgress(RuntimeError):
    pass


class RequestIdConflict(RuntimeError):
    """The client request id was already used for a different conversation."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _message(row: sqlite3.Row) -> Message:
    return Message(**{key: row[key] for key in row.keys()})


def _open(path: Path) -> sqlite3.Connection:
    conn = connect(path)
    conn.row_factory = sqlite3.Row
    return conn


def make_title(prompt: str) -> str:
    flat = " ".join(prompt.split())
    return flat if len(flat) <= TITLE_MAX else flat[: TITLE_MAX - 1].rstrip() + "…"


def create_conversation(path: Path) -> Conversation:
    now = _now()
    conversation = Conversation(id=str(uuid.uuid4()), title=DEFAULT_TITLE, created_at=now, updated_at=now)
    with _closing(path) as conn:
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (conversation.id, conversation.title, conversation.created_at, conversation.updated_at),
        )
    return conversation


def list_conversations(path: Path, limit: int = 100) -> list[Conversation]:
    with _closing(path) as conn:
        rows = conn.execute(
            """
            SELECT c.id, c.title, c.created_at, c.updated_at,
                   (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
            FROM conversations c
            ORDER BY c.updated_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [Conversation(**dict(row)) for row in rows]


def get_conversation(path: Path, conversation_id: str) -> tuple[Conversation, list[Message]]:
    with _closing(path) as conn:
        row = conn.execute(
            "SELECT id, title, created_at, updated_at FROM conversations WHERE id = ?", (conversation_id,)
        ).fetchone()
        if row is None:
            raise NotFound(conversation_id)
        messages = [
            _message(r)
            for r in conn.execute("SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq", (conversation_id,))
        ]
    return Conversation(**dict(row), message_count=len(messages)), messages


def get_message(path: Path, message_id: str) -> Message:
    with _closing(path) as conn:
        row = conn.execute("SELECT * FROM messages WHERE id = ?", (message_id,)).fetchone()
    if row is None:
        raise NotFound(message_id)
    return _message(row)


def find_turn(path: Path, client_request_id: str) -> Turn | None:
    """Return the turn previously created for this request id, if any."""
    with _closing(path) as conn:
        user = conn.execute("SELECT * FROM messages WHERE client_request_id = ?", (client_request_id,)).fetchone()
        if user is None:
            return None
        assistant = conn.execute("SELECT * FROM messages WHERE reply_to = ?", (user["id"],)).fetchone()
    if assistant is None:  # pragma: no cover - both rows are written in one transaction
        raise RuntimeError("turn is missing its assistant message")
    return Turn(_message(user), _message(assistant))


def start_turn(
    path: Path, conversation_id: str, client_request_id: str, content: str, model: str,
    input_mode: Literal["text", "voice"] = "text",
) -> Turn:
    """Atomically append the user message and a pending assistant message."""
    now = _now()
    user_id, assistant_id = str(uuid.uuid4()), str(uuid.uuid4())
    with _closing(path) as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            convo = conn.execute("SELECT title FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
            if convo is None:
                raise NotFound(conversation_id)
            seq = int(
                conn.execute(
                    "SELECT COALESCE(MAX(seq), 0) FROM messages WHERE conversation_id = ?", (conversation_id,)
                ).fetchone()[0]
            )
            conn.execute(
                """INSERT INTO messages (id, conversation_id, seq, role, content, status, client_request_id, created_at,
                                         completed_at, input_mode)
                   VALUES (?, ?, ?, 'user', ?, 'complete', ?, ?, ?, ?)""",
                (user_id, conversation_id, seq + 1, content, client_request_id, now, now, input_mode),
            )
            conn.execute(
                """INSERT INTO messages (id, conversation_id, seq, role, content, status, reply_to, provider, model,
                                         created_at)
                   VALUES (?, ?, ?, 'assistant', '', 'pending', ?, NULL, ?, ?)""",
                (assistant_id, conversation_id, seq + 2, user_id, model, now),
            )
            title = make_title(content) if convo["title"] == DEFAULT_TITLE and seq == 0 else convo["title"]
            conn.execute("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?", (title, now, conversation_id))
            conn.execute("COMMIT")
        except sqlite3.IntegrityError as error:
            conn.execute("ROLLBACK")
            text = str(error)
            if "messages_one_active_generation" in text or "messages.conversation_id" in text:
                raise GenerationInProgress(conversation_id) from None
            if "client_request_id" in text:
                raise RequestIdConflict(client_request_id) from None
            raise
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        user = _message(conn.execute("SELECT * FROM messages WHERE id = ?", (user_id,)).fetchone())
        assistant = _message(conn.execute("SELECT * FROM messages WHERE id = ?", (assistant_id,)).fetchone())
    return Turn(user, assistant)


def mark_streaming(path: Path, message_id: str, provider: str) -> None:
    with _closing(path) as conn:
        conn.execute(
            "UPDATE messages SET status = 'streaming', provider = ? WHERE id = ? AND status = 'pending'",
            (provider, message_id),
        )


def finish_message(
    path: Path,
    message_id: str,
    *,
    status: Literal["complete", "failed", "cancelled"],
    content: str,
    provider: str | None,
    model: str | None,
    error_code: str | None = None,
    error_detail: str | None = None,
    finish_reason: str | None = None,
    prompt_tokens: int | None = None,
    completion_tokens: int | None = None,
    duration_ms: int | None = None,
) -> Message:
    """Write the terminal state. Only a non-terminal message can be finished (first writer wins)."""
    now = _now()
    with _closing(path) as conn:
        conn.execute(
            """
            UPDATE messages
            SET status = ?, content = ?, provider = COALESCE(?, provider), model = COALESCE(?, model),
                error_code = ?, error_detail = ?, finish_reason = ?, prompt_tokens = ?, completion_tokens = ?,
                duration_ms = ?, completed_at = ?
            WHERE id = ? AND status IN ('pending', 'streaming')
            """,
            (
                status,
                content,
                provider,
                model,
                error_code,
                error_detail,
                finish_reason,
                prompt_tokens,
                completion_tokens,
                duration_ms,
                now,
                message_id,
            ),
        )
        conn.execute(
            "UPDATE conversations SET updated_at = ? WHERE id = (SELECT conversation_id FROM messages WHERE id = ?)",
            (now, message_id),
        )
        row = conn.execute("SELECT * FROM messages WHERE id = ?", (message_id,)).fetchone()
    return _message(row)


def recover_interrupted(path: Path) -> int:
    """At startup, nothing can still be generating: fail any leftover in-flight replies honestly."""
    with _closing(path) as conn:
        cursor = conn.execute(
            """
            UPDATE messages
            SET status = 'failed', error_code = 'interrupted',
                error_detail = 'The core stopped before this reply finished. Partial output was not kept.',
                content = '', completed_at = ?
            WHERE status IN ('pending', 'streaming')
            """,
            (_now(),),
        )
        return cursor.rowcount


def history(path: Path, conversation_id: str, before_seq: int, limit: int) -> list[Message]:
    """Model context: only turns whose reply completed. Failed/cancelled turns are left out entirely."""
    with _closing(path) as conn:
        rows = conn.execute(
            """
            SELECT m.* FROM messages m
            WHERE m.conversation_id = ? AND m.seq < ?
              AND (
                (m.role = 'assistant' AND m.status = 'complete')
                OR (m.role = 'user' AND EXISTS (
                      SELECT 1 FROM messages a WHERE a.reply_to = m.id AND a.status = 'complete'))
              )
            ORDER BY m.seq DESC LIMIT ?
            """,
            (conversation_id, before_seq, limit),
        ).fetchall()
    return [_message(r) for r in reversed(rows)]


class _closing:
    def __init__(self, path: Path) -> None:
        self._path = path

    def __enter__(self) -> sqlite3.Connection:
        self._conn = _open(self._path)
        return self._conn

    def __exit__(self, *exc: object) -> None:
        self._conn.close()
