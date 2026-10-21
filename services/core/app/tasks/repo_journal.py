"""SQLite journal for read-only repository investigations (schema v7).

Status lifecycle:

  awaiting_repo --picker--> awaiting_approval --approve--> inspecting --> generating --> awaiting_save --save--> completed
        |                        |      ^                       |              |
        |                        +------+ (re-pick)             +--------------+--> failed / cancelled
        +----------------+------------> rejected / cancelled

Every transition is a conditional update on the expected current status, so a
second approval, a late cancel or a save of an unfinished report cannot apply.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from pathlib import Path
from typing import Any

from app.tasks.file_journal import now
from app.tasks.research_journal import NotFound, StateError, _conn

TERMINAL = frozenset({"completed", "failed", "cancelled", "rejected"})
RUNNING = ("inspecting", "generating")
OPEN = ("awaiting_repo", "awaiting_approval")
EVENT_LIMIT = 200

__all__ = ["NotFound", "StateError"]


def _event(conn: Any, task_id: str, kind: str, detail: str) -> None:
    conn.execute("INSERT INTO repo_events (task_id, at, kind, detail) VALUES (?, ?, ?, ?)",
                 (task_id, now(), kind, detail[:600]))


def add_event(path: Path, task_id: str, kind: str, detail: str) -> None:
    with _conn(path) as conn:
        _event(conn, task_id, kind, detail)


def digest(plan: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(plan, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def create_task(path: Path, *, request_text: str, model: str) -> str:
    task_id, ts = str(uuid.uuid4()), now()
    with _conn(path) as conn:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            "INSERT INTO repo_tasks (id, request_text, model, status, created_at, updated_at) "
            "VALUES (?, ?, ?, 'awaiting_repo', ?, ?)",
            (task_id, request_text, model, ts, ts),
        )
        _event(conn, task_id, "created", "Repository investigation requested; waiting for a folder from the picker.")
        conn.execute("COMMIT")
    return task_id


def get_task(path: Path, task_id: str) -> dict[str, Any]:
    with _conn(path) as conn:
        row = conn.execute("SELECT * FROM repo_tasks WHERE id = ?", (task_id,)).fetchone()
    if row is None:
        raise NotFound(task_id)
    return dict(row)


def list_tasks(path: Path, limit: int = 30) -> list[dict[str, Any]]:
    with _conn(path) as conn:
        rows = conn.execute(
            "SELECT id, repo_name, status, saved_path, created_at FROM repo_tasks ORDER BY created_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


def get_detail(path: Path, task_id: str) -> dict[str, Any]:
    """Renderer-safe view: no scan internals (snapshot), plan and report as JSON."""
    task = get_task(path, task_id)
    with _conn(path) as conn:
        events = conn.execute(
            "SELECT id, at, kind, detail FROM repo_events WHERE task_id = ? ORDER BY id DESC LIMIT ?",
            (task_id, EVENT_LIMIT),
        ).fetchall()
    task.pop("scan_json")
    task.pop("root_identity")
    plan = json.loads(task.pop("plan_json")) if task["plan_json"] else None
    report = json.loads(task.pop("report_json")) if task["report_json"] else None
    evidence = json.loads(task.pop("evidence_json")) if task["evidence_json"] else None
    return {"task": task, "plan": plan, "evidence": evidence, "report": report,
            "events": [dict(e) for e in reversed(events)]}


def _transition(path: Path, task_id: str, expect: tuple[str, ...], status: str, event: tuple[str, str],
                **fields: Any) -> bool:
    ts = now()
    if status in TERMINAL:
        fields.setdefault("finished_at", ts)
    sets = "".join(f", {k} = ?" for k in fields)
    marks = ",".join("?" * len(expect))
    with _conn(path) as conn:
        conn.execute("BEGIN IMMEDIATE")
        changed = conn.execute(
            f"UPDATE repo_tasks SET status = ?, updated_at = ?{sets} WHERE id = ? AND status IN ({marks})",
            (status, ts, *fields.values(), task_id, *expect),
        ).rowcount
        if changed:
            _event(conn, task_id, *event)
        conn.execute("COMMIT")
    return bool(changed)


def set_plan(path: Path, task_id: str, *, root_path: str, root_identity: str, repo_name: str,
             plan: dict[str, Any], scan: dict[str, Any]) -> None:
    files = plan["facts"]["files_read"]
    if not _transition(
        path, task_id, OPEN, "awaiting_approval",
        ("planned", f"Read-only scan of {repo_name}: {files} file(s) read by AEGIS's checks, "
                    f"{len(plan['facts']['context'])} excerpt(s) proposed for the model."),
        root_path=root_path, root_identity=root_identity, repo_name=repo_name,
        plan_json=json.dumps(plan, ensure_ascii=False), plan_digest=digest(plan),
        scan_json=json.dumps(scan, ensure_ascii=False),
    ):
        raise StateError("task_not_open")


def approve(path: Path, task_id: str, plan_digest: str, vault_consent: bool) -> None:
    task = get_task(path, task_id)
    if task["status"] != "awaiting_approval":
        raise StateError("not_awaiting_approval")
    if task["plan_digest"] != plan_digest:
        raise StateError("plan_digest_mismatch")
    ts = now()
    consent = "with consent to use the listed vault notes" if vault_consent else "without vault notes"
    if not _transition(path, task_id, ("awaiting_approval",), "inspecting", ("approved", f"Plan approved {consent}."),
                       approval_at=ts, started_at=ts, vault_consent=int(vault_consent)):
        raise StateError("not_awaiting_approval")


def reject(path: Path, task_id: str) -> None:
    get_task(path, task_id)
    if not _transition(path, task_id, OPEN, "rejected", ("rejected", "Rejected; nothing was sent to the model.")):
        raise StateError("task_not_open")


def set_status(path: Path, task_id: str, status: str, expect: tuple[str, ...], event: tuple[str, str],
               **fields: Any) -> bool:
    return _transition(path, task_id, expect, status, event, **fields)


def fail(path: Path, task_id: str, code: str, detail: str, status: str = "failed") -> bool:
    return _transition(path, task_id, (*OPEN, *RUNNING), status, (status, f"{code}: {detail}"),
                       error_code=code, error_detail=detail)


def request_cancel(path: Path, task_id: str) -> bool:
    with _conn(path) as conn:
        changed = conn.execute(
            f"UPDATE repo_tasks SET cancel_requested = 1, updated_at = ? WHERE id = ? AND status IN {RUNNING}",
            (now(), task_id),
        ).rowcount
        if changed:
            _event(conn, task_id, "cancel_requested", "Stop requested by the user.")
    return bool(changed)


def store_report(path: Path, task_id: str, report: dict[str, Any], markdown: str, evidence: dict[str, Any]) -> bool:
    return _transition(
        path, task_id, ("generating",), "awaiting_save",
        ("report_ready", f"Report generated and verified ({len(markdown)} characters); waiting for a save folder."),
        report_json=json.dumps(report, ensure_ascii=False), report_markdown=markdown,
        report_sha256=hashlib.sha256(markdown.encode("utf-8")).hexdigest(),
        evidence_json=json.dumps(evidence, ensure_ascii=False),
    )


def record_saved(path: Path, task_id: str, saved_path: str, unchanged: bool) -> bool:
    check = "repository unchanged" if unchanged else "repository CHANGED since the scan (see report)"
    return _transition(path, task_id, ("awaiting_save",), "completed",
                       ("saved", f"Report written and verified at {saved_path}; {check}."),
                       saved_path=saved_path, saved_at=now())


def recover_interrupted(path: Path) -> int:
    """At startup nothing can be running. The investigation never writes to the repository, so it simply fails."""
    with _conn(path) as conn:
        ids = [r[0] for r in conn.execute(f"SELECT id FROM repo_tasks WHERE status IN {RUNNING}").fetchall()]
    for task_id in ids:
        fail(path, task_id, "interrupted", "The core stopped during the investigation; nothing was saved.")
    return len(ids)
