"""SQLite journal for research tasks (schema v4).

Status lifecycle:

  awaiting_approval --approve--> researching --> generating --> awaiting_save --save--> completed
          |                         |               |
          +--reject--> rejected     +---------------+--> failed / cancelled

Every transition is a conditional update on the expected current status, so a
second approval, a late cancel or a save of an unfinished report cannot apply.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
from pathlib import Path
from typing import Any

from app.memory.db import connect
from app.tasks.file_journal import now

TERMINAL = frozenset({"completed", "failed", "cancelled", "rejected"})
RUNNING = ("researching", "generating")
EVENT_LIMIT = 200


class NotFound(LookupError):
    pass


class StateError(RuntimeError):
    """The task is not in a state that allows this step; `code` is returned by the API as-is."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class _conn:
    def __init__(self, path: Path) -> None:
        self._path = path

    def __enter__(self) -> sqlite3.Connection:
        self._c = connect(self._path)
        self._c.row_factory = sqlite3.Row
        return self._c

    def __exit__(self, *exc: object) -> None:
        self._c.close()


def _event(conn: sqlite3.Connection, task_id: str, kind: str, detail: str) -> None:
    conn.execute(
        "INSERT INTO research_events (task_id, at, kind, detail) VALUES (?, ?, ?, ?)", (task_id, now(), kind, detail)
    )


def add_event(path: Path, task_id: str, kind: str, detail: str) -> None:
    with _conn(path) as conn:
        _event(conn, task_id, kind, detail)


def plan_digest(question: str, key_terms: list[str], urls: list[str]) -> str:
    payload = json.dumps({"q": question, "t": key_terms, "u": urls}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def create_task(
    path: Path,
    *,
    request_text: str,
    question: str,
    key_terms: list[str],
    plan_source: str,
    plan_model: str | None,
    plan_detail: str,
    model: str | None,
    sources: list[tuple[str, str, str | None, str | None]],
) -> str:
    """sources: (url, 'planned' | 'rejected' | 'skipped', code, detail) in the order the user typed them."""
    task_id, ts = str(uuid.uuid4()), now()
    digest = plan_digest(question, key_terms, [u for u, status, _, _ in sources if status == "planned"])
    with _conn(path) as conn:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            """INSERT INTO research_tasks (id, request_text, question, key_terms, plan_source, plan_model, plan_detail,
                                           plan_digest, model, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_approval', ?, ?)""",
            (task_id, request_text, question, json.dumps(key_terms), plan_source, plan_model, plan_detail,
             digest, model, ts, ts),
        )
        for seq, (url, status, code, detail) in enumerate(sources, 1):
            conn.execute(
                """INSERT INTO research_sources (id, task_id, seq, requested_url, status, code, detail)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (str(uuid.uuid4()), task_id, seq, url, status, code, detail),
            )
        planned = sum(s[1] == "planned" for s in sources)
        _event(conn, task_id, "planned", f"Plan via {plan_source}: {planned} source(s) to read, "
                                          f"{len(sources) - planned} refused or over the limit.")
        conn.execute("COMMIT")
    return task_id


def get_task(path: Path, task_id: str) -> dict[str, Any]:
    with _conn(path) as conn:
        row = conn.execute("SELECT * FROM research_tasks WHERE id = ?", (task_id,)).fetchone()
    if row is None:
        raise NotFound(task_id)
    return dict(row)


_LIST_COLUMNS = "id, question, status, model, saved_path, error_code, created_at, updated_at, finished_at"


def list_tasks(path: Path, limit: int = 30) -> list[dict[str, Any]]:
    with _conn(path) as conn:
        rows = conn.execute(
            f"SELECT {_LIST_COLUMNS} FROM research_tasks ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
    return [dict(r) for r in rows]


def sources(path: Path, task_id: str, *, with_text: bool = False) -> list[dict[str, Any]]:
    columns = "*" if with_text else "id, task_id, seq, requested_url, final_url, canonical_url, status, code, " \
        "detail, http_status, content_type, title, sha256, bytes, text_chars, truncated, redirects, retrieved_at"
    with _conn(path) as conn:
        rows = conn.execute(f"SELECT {columns} FROM research_sources WHERE task_id = ? ORDER BY seq", (task_id,))
        return [dict(r) for r in rows.fetchall()]


def update_source(path: Path, source_id: str, **fields: Any) -> None:
    names = ", ".join(f"{k} = ?" for k in fields)
    with _conn(path) as conn:
        conn.execute(f"UPDATE research_sources SET {names} WHERE id = ?", (*fields.values(), source_id))


def get_detail(path: Path, task_id: str) -> dict[str, Any]:
    task = get_task(path, task_id)
    with _conn(path) as conn:
        events = conn.execute(
            "SELECT id, at, kind, detail FROM research_events WHERE task_id = ? ORDER BY id DESC LIMIT ?",
            (task_id, EVENT_LIMIT),
        ).fetchall()
    report = json.loads(task.pop("report_json")) if task["report_json"] else None
    task["key_terms"] = json.loads(task["key_terms"])
    return {
        "task": task,
        "sources": sources(path, task_id),
        "report": report,
        "events": [dict(e) for e in reversed(events)],
    }


def _transition(
    path: Path, task_id: str, expect: tuple[str, ...], status: str, event: tuple[str, str], **fields: Any
) -> bool:
    ts = now()
    if status in TERMINAL:
        fields.setdefault("finished_at", ts)
    sets = "".join(f", {k} = ?" for k in fields)
    marks = ",".join("?" * len(expect))
    with _conn(path) as conn:
        conn.execute("BEGIN IMMEDIATE")
        changed = conn.execute(
            f"UPDATE research_tasks SET status = ?, updated_at = ?{sets} WHERE id = ? AND status IN ({marks})",
            (status, ts, *fields.values(), task_id, *expect),
        ).rowcount
        if changed:
            _event(conn, task_id, *event)
        conn.execute("COMMIT")
    return bool(changed)


def approve(path: Path, task_id: str, digest: str) -> None:
    task = get_task(path, task_id)
    if task["status"] != "awaiting_approval":
        raise StateError("not_awaiting_approval")
    if task["plan_digest"] != digest:
        raise StateError("plan_digest_mismatch")
    ts = now()
    if not _transition(path, task_id, ("awaiting_approval",), "researching",
                       ("approved", "Plan approved; reading sources."), approval_at=ts, started_at=ts):
        raise StateError("not_awaiting_approval")


def reject(path: Path, task_id: str) -> None:
    get_task(path, task_id)
    if not _transition(path, task_id, ("awaiting_approval",), "rejected", ("rejected", "Plan rejected; nothing read.")):
        raise StateError("not_awaiting_approval")


def set_status(path: Path, task_id: str, status: str, expect: tuple[str, ...], event: tuple[str, str]) -> bool:
    return _transition(path, task_id, expect, status, event)


def fail(path: Path, task_id: str, code: str, detail: str, status: str = "failed") -> bool:
    """End an open task as failed/cancelled and close any source still open, so none is left 'fetching'."""
    with _conn(path) as conn:
        conn.execute(
            "UPDATE research_sources SET status = 'failed', code = ?, detail = ? WHERE task_id = ? AND status = 'fetching'",
            (code, f"Interrupted while reading: {detail}", task_id),
        )
        conn.execute(
            "UPDATE research_sources SET status = 'skipped', code = ?, detail = ? WHERE task_id = ? AND status = 'planned'",
            (code, f"Not read: {detail}", task_id),
        )
    return _transition(
        path, task_id, ("awaiting_approval", *RUNNING), status, (status, f"{code}: {detail}"),
        error_code=code, error_detail=detail,
    )


def request_cancel(path: Path, task_id: str) -> bool:
    with _conn(path) as conn:
        changed = conn.execute(
            f"UPDATE research_tasks SET cancel_requested = 1, updated_at = ? WHERE id = ? AND status IN {RUNNING}",
            (now(), task_id),
        ).rowcount
        if changed:
            _event(conn, task_id, "cancel_requested", "Stop requested by the user.")
    return bool(changed)


def store_report(path: Path, task_id: str, report: dict[str, Any], markdown: str) -> bool:
    return _transition(
        path, task_id, ("generating",), "awaiting_save",
        ("report_ready", f"Report generated and verified ({len(markdown)} characters); waiting for a save folder."),
        report_json=json.dumps(report, ensure_ascii=False),
        report_markdown=markdown,
        report_sha256=hashlib.sha256(markdown.encode("utf-8")).hexdigest(),
    )


def record_saved(path: Path, task_id: str, saved_path: str) -> bool:
    return _transition(
        path, task_id, ("awaiting_save",), "completed", ("saved", f"Report written and verified at {saved_path}."),
        saved_path=saved_path, saved_at=now(),
    )


def recover_interrupted(path: Path) -> int:
    """At startup nothing can be running. Reading is side-effect free, so an interrupted run simply fails."""
    with _conn(path) as conn:
        ids = [r[0] for r in conn.execute(f"SELECT id FROM research_tasks WHERE status IN {RUNNING}").fetchall()]
    for task_id in ids:
        fail(path, task_id, "interrupted", "The core stopped during research; nothing was saved. Start a new task.")
    return len(ids)
