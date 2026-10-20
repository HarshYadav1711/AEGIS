"""SQLite journal for file-organization tasks (schema v3).

The journal is the source of truth for what was planned, what the user
decided and what each operation actually did. Approval is a conditional
update bound to one plan id and its digest, so a second approval, a stale
plan or a modified plan can never start an execution.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal

from app.memory.db import connect
from app.tools.file_organizer import PlannedOperation

TaskStatus = Literal[
    "awaiting_folder",
    "planning",
    "awaiting_approval",
    "executing",
    "completed",
    "partial",
    "failed",
    "unknown",
    "cancelled",
    "rejected",
]
TERMINAL_TASK_STATUSES: frozenset[str] = frozenset(
    {"completed", "partial", "failed", "unknown", "cancelled", "rejected"}
)
OPEN_FOR_CANCEL: frozenset[str] = frozenset({"awaiting_folder", "planning", "awaiting_approval"})
PLAN_TTL = timedelta(minutes=15)
EVENT_LIMIT = 200


@dataclass(frozen=True)
class FileTask:
    id: str
    request_text: str
    intent: str
    intent_source: str
    intent_model: str | None
    intent_detail: str
    status: TaskStatus
    root_path: str | None
    root_identity: str | None
    current_plan_id: str | None
    approval_decision: str | None
    approval_plan_id: str | None
    approval_at: str | None
    cancel_requested: int
    error_code: str | None
    error_detail: str | None
    created_at: str
    updated_at: str
    started_at: str | None
    finished_at: str | None


@dataclass(frozen=True)
class FilePlan:
    id: str
    task_id: str
    digest: str
    status: str
    root_path: str
    root_identity: str
    created_at: str
    expires_at: str


@dataclass(frozen=True)
class FileOperation:
    id: str
    plan_id: str
    seq: int
    action: Literal["move", "skip"]
    source_name: str
    category: str | None
    dest_rel: str | None
    size: int | None
    mtime_ns: int | None
    file_id: str | None
    sha256: str | None
    plan_reason: str | None
    status: str
    detail: str | None
    verification: str | None
    started_at: str | None
    finished_at: str | None

    def planned(self) -> PlannedOperation:
        return PlannedOperation(
            seq=self.seq,
            action=self.action,
            source_name=self.source_name,
            category=self.category,  # type: ignore[arg-type]
            dest_rel=self.dest_rel,
            size=self.size,
            mtime_ns=self.mtime_ns,
            file_id=self.file_id,
            sha256=self.sha256,
            reason=self.plan_reason,
        )


@dataclass(frozen=True)
class TaskEvent:
    id: int
    at: str
    kind: str
    detail: str


@dataclass(frozen=True)
class TaskDetail:
    task: FileTask
    plan: FilePlan | None
    operations: list[FileOperation]
    events: list[TaskEvent]


class NotFound(LookupError):
    pass


class ApprovalError(RuntimeError):
    """Approval refused; `code` is a stable reason the API returns as-is."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class _conn:
    def __init__(self, path: Path) -> None:
        self._path = path

    def __enter__(self) -> sqlite3.Connection:
        self._c = connect(self._path)
        self._c.row_factory = sqlite3.Row
        return self._c

    def __exit__(self, *exc: object) -> None:
        self._c.close()


def _row(cls, row: sqlite3.Row):  # type: ignore[no-untyped-def]
    return cls(**{k: row[k] for k in row.keys()})


def _event(conn: sqlite3.Connection, task_id: str, kind: str, detail: str) -> None:
    conn.execute(
        "INSERT INTO file_task_events (task_id, at, kind, detail) VALUES (?, ?, ?, ?)", (task_id, now(), kind, detail)
    )


def add_event(path: Path, task_id: str, kind: str, detail: str) -> None:
    with _conn(path) as conn:
        _event(conn, task_id, kind, detail)


def create_task(
    path: Path, request_text: str, intent_source: str, intent_model: str | None, intent_detail: str
) -> FileTask:
    task_id, ts = str(uuid.uuid4()), now()
    with _conn(path) as conn:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            """INSERT INTO file_tasks (id, request_text, intent, intent_source, intent_model, intent_detail, status,
                                       created_at, updated_at)
               VALUES (?, ?, 'organize_by_type', ?, ?, ?, 'awaiting_folder', ?, ?)""",
            (task_id, request_text, intent_source, intent_model, intent_detail, ts, ts),
        )
        _event(conn, task_id, "interpreted", f"organize_by_type via {intent_source}: {intent_detail}")
        conn.execute("COMMIT")
    return get_task(path, task_id)


def get_task(path: Path, task_id: str) -> FileTask:
    with _conn(path) as conn:
        row = conn.execute("SELECT * FROM file_tasks WHERE id = ?", (task_id,)).fetchone()
    if row is None:
        raise NotFound(task_id)
    return _row(FileTask, row)


def list_tasks(path: Path, limit: int = 30) -> list[FileTask]:
    with _conn(path) as conn:
        rows = conn.execute("SELECT * FROM file_tasks ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
    return [_row(FileTask, r) for r in rows]


def get_detail(path: Path, task_id: str) -> TaskDetail:
    with _conn(path) as conn:
        row = conn.execute("SELECT * FROM file_tasks WHERE id = ?", (task_id,)).fetchone()
        if row is None:
            raise NotFound(task_id)
        task = _row(FileTask, row)
        plan = None
        operations: list[FileOperation] = []
        if task.current_plan_id:
            plan_row = conn.execute("SELECT * FROM file_plans WHERE id = ?", (task.current_plan_id,)).fetchone()
            plan = _row(FilePlan, plan_row)
            operations = [
                _row(FileOperation, r)
                for r in conn.execute("SELECT * FROM file_operations WHERE plan_id = ? ORDER BY seq", (plan.id,))
            ]
        events = [
            _row(TaskEvent, r)
            for r in conn.execute(
                "SELECT id, at, kind, detail FROM file_task_events WHERE task_id = ? ORDER BY id DESC LIMIT ?",
                (task_id, EVENT_LIMIT),
            )
        ]
    return TaskDetail(task, plan, operations, list(reversed(events)))


def set_status(
    path: Path,
    task_id: str,
    status: TaskStatus,
    *,
    expect: tuple[str, ...],
    event: tuple[str, str] | None = None,
    error: tuple[str, str] | None = None,
) -> bool:
    """Conditional transition; returns False (and changes nothing) if the task is not in an expected state."""
    ts = now()
    terminal = status in TERMINAL_TASK_STATUSES
    with _conn(path) as conn:
        conn.execute("BEGIN IMMEDIATE")
        cursor = conn.execute(
            f"""UPDATE file_tasks SET status = ?, updated_at = ?,
                       error_code = COALESCE(?, error_code), error_detail = COALESCE(?, error_detail),
                       finished_at = CASE WHEN ? THEN ? ELSE finished_at END
                WHERE id = ? AND status IN ({",".join("?" * len(expect))})""",
            (status, ts, error[0] if error else None, error[1] if error else None, terminal, ts, task_id, *expect),
        )
        changed = cursor.rowcount == 1
        if changed and event:
            _event(conn, task_id, *event)
        conn.execute("COMMIT")
    return changed


def set_scope(path: Path, task_id: str, root_path: str, root_identity: str, *, rescan: bool = False) -> bool:
    with _conn(path) as conn:
        conn.execute("BEGIN IMMEDIATE")
        cursor = conn.execute(
            """UPDATE file_tasks SET root_path = ?, root_identity = ?, status = 'planning', updated_at = ?
               WHERE id = ? AND status IN ('awaiting_folder', 'awaiting_approval', 'planning')""",
            (root_path, root_identity, now(), task_id),
        )
        if cursor.rowcount == 1:
            if rescan:
                _event(conn, task_id, "rescanned", f"Re-scanning the already selected folder: {root_path}")
            else:
                _event(conn, task_id, "folder_selected", f"Scope set from the folder picker: {root_path}")
        conn.execute("COMMIT")
        return cursor.rowcount == 1


def plan_digest(task_id: str, plan_id: str, root_path: str, root_identity: str, ops: list[dict[str, Any]]) -> str:
    canonical = json.dumps(
        {"task": task_id, "plan": plan_id, "root": root_path, "root_identity": root_identity, "operations": ops},
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def record_plan(
    path: Path, task_id: str, root_path: str, root_identity: str, planned: list[PlannedOperation]
) -> FilePlan:
    """Store a new immutable plan, supersede any earlier one, and await approval."""
    plan_id = str(uuid.uuid4())
    created = datetime.now(timezone.utc)
    rows: list[dict[str, Any]] = []
    for op in planned:
        rows.append(
            {
                "id": str(uuid.uuid4()),
                "seq": op.seq,
                "action": op.action,
                "source_name": op.source_name,
                "category": op.category,
                "dest_rel": op.dest_rel,
                "size": op.size,
                "mtime_ns": op.mtime_ns,
                "file_id": op.file_id,
                "sha256": op.sha256,
                "plan_reason": op.reason,
                "status": "planned" if op.action == "move" else "skipped",
            }
        )
    digest = plan_digest(task_id, plan_id, root_path, root_identity, rows)
    moves = sum(1 for r in rows if r["action"] == "move")
    with _conn(path) as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            task = conn.execute("SELECT status FROM file_tasks WHERE id = ?", (task_id,)).fetchone()
            if task is None or task["status"] != "planning":
                raise ApprovalError("task_not_planning")
            conn.execute(
                "UPDATE file_plans SET status = 'superseded' WHERE task_id = ? AND status = 'awaiting_approval'",
                (task_id,),
            )
            conn.execute(
                """INSERT INTO file_plans (id, task_id, digest, status, root_path, root_identity, created_at, expires_at)
                   VALUES (?, ?, ?, 'awaiting_approval', ?, ?, ?, ?)""",
                (
                    plan_id,
                    task_id,
                    digest,
                    root_path,
                    root_identity,
                    created.isoformat(timespec="milliseconds"),
                    (created + PLAN_TTL).isoformat(timespec="milliseconds"),
                ),
            )
            conn.executemany(
                """INSERT INTO file_operations (id, plan_id, seq, action, source_name, category, dest_rel, size,
                                                mtime_ns, file_id, sha256, plan_reason, status)
                   VALUES (:id, :plan_id, :seq, :action, :source_name, :category, :dest_rel, :size, :mtime_ns,
                           :file_id, :sha256, :plan_reason, :status)""",
                [{**r, "plan_id": plan_id} for r in rows],
            )
            conn.execute(
                """UPDATE file_tasks SET current_plan_id = ?, status = 'awaiting_approval', updated_at = ?
                   WHERE id = ?""",
                (plan_id, now(), task_id),
            )
            _event(conn, task_id, "plan_created",
                   f"Plan {plan_id}: {moves} move(s), {len(rows) - moves} skipped; digest {digest[:12]}")
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        return _row(FilePlan, conn.execute("SELECT * FROM file_plans WHERE id = ?", (plan_id,)).fetchone())


def approve(path: Path, task_id: str, plan_id: str, digest: str) -> FileTask:
    """Bind the user's approval to exactly one stored plan. Only one approval can ever succeed."""
    ts = datetime.now(timezone.utc)
    with _conn(path) as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            task = conn.execute("SELECT * FROM file_tasks WHERE id = ?", (task_id,)).fetchone()
            if task is None:
                raise NotFound(task_id)
            if task["approval_decision"] is not None or task["status"] != "awaiting_approval":
                raise ApprovalError("not_awaiting_approval")
            plan = conn.execute("SELECT * FROM file_plans WHERE id = ? AND task_id = ?", (plan_id, task_id)).fetchone()
            if plan is None or task["current_plan_id"] != plan_id or plan["status"] != "awaiting_approval":
                raise ApprovalError("plan_not_current")
            if plan["digest"] != digest:
                raise ApprovalError("plan_digest_mismatch")
            if datetime.fromisoformat(plan["expires_at"]) <= ts:
                raise ApprovalError("plan_expired")
            ops = conn.execute(
                "SELECT * FROM file_operations WHERE plan_id = ? ORDER BY seq", (plan_id,)
            ).fetchall()
            recomputed = plan_digest(
                task_id, plan_id, plan["root_path"], plan["root_identity"],
                [{k: o[k] for k in ("id", "seq", "action", "source_name", "category", "dest_rel", "size", "mtime_ns",
                                    "file_id", "sha256", "plan_reason", "status")} for o in ops],
            )
            if recomputed != digest:
                raise ApprovalError("plan_digest_mismatch")  # stored operations were altered
            if not any(o["action"] == "move" for o in ops):
                raise ApprovalError("empty_plan")
            stamp = ts.isoformat(timespec="milliseconds")
            conn.execute("UPDATE file_plans SET status = 'approved' WHERE id = ?", (plan_id,))
            conn.execute(
                """UPDATE file_tasks SET approval_decision = 'approved', approval_plan_id = ?, approval_at = ?,
                       status = 'executing', started_at = ?, updated_at = ? WHERE id = ?""",
                (plan_id, stamp, stamp, stamp, task_id),
            )
            _event(conn, task_id, "approved", f"User approved plan {plan_id} (digest {digest[:12]}).")
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
    return get_task(path, task_id)


def reject(path: Path, task_id: str, plan_id: str) -> FileTask:
    with _conn(path) as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            task = conn.execute("SELECT * FROM file_tasks WHERE id = ?", (task_id,)).fetchone()
            if task is None:
                raise NotFound(task_id)
            if task["status"] != "awaiting_approval" or task["current_plan_id"] != plan_id:
                raise ApprovalError("not_awaiting_approval")
            ts = now()
            conn.execute("UPDATE file_plans SET status = 'rejected' WHERE id = ?", (plan_id,))
            conn.execute(
                """UPDATE file_tasks SET approval_decision = 'rejected', approval_plan_id = ?, approval_at = ?,
                       status = 'rejected', finished_at = ?, updated_at = ? WHERE id = ?""",
                (plan_id, ts, ts, ts, task_id),
            )
            _event(conn, task_id, "rejected", f"User rejected plan {plan_id}; no files were touched.")
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
    return get_task(path, task_id)


def cancel_open(path: Path, task_id: str) -> bool:
    """Cancel a task that has not started executing. Returns False if it is not in such a state."""
    with _conn(path) as conn:
        conn.execute("BEGIN IMMEDIATE")
        ts = now()
        cursor = conn.execute(
            f"""UPDATE file_tasks SET status = 'cancelled', cancel_requested = 1, finished_at = ?, updated_at = ?
                WHERE id = ? AND status IN ({",".join("?" * len(OPEN_FOR_CANCEL))})""",
            (ts, ts, task_id, *OPEN_FOR_CANCEL),
        )
        if cursor.rowcount == 1:
            conn.execute(
                "UPDATE file_plans SET status = 'cancelled' WHERE task_id = ? AND status = 'awaiting_approval'",
                (task_id,),
            )
            _event(conn, task_id, "cancelled", "Cancelled by the user before execution; no files were touched.")
        conn.execute("COMMIT")
        return cursor.rowcount == 1


def request_cancel(path: Path, task_id: str) -> bool:
    with _conn(path) as conn:
        cursor = conn.execute(
            "UPDATE file_tasks SET cancel_requested = 1, updated_at = ? WHERE id = ? AND status = 'executing'",
            (now(), task_id),
        )
        if cursor.rowcount == 1:
            _event(conn, task_id, "cancel_requested", "User asked to stop; no further operations will start.")
        return cursor.rowcount == 1


def mark_started(path: Path, op_id: str) -> None:
    """Write-ahead: recorded before the filesystem call so a crash leaves evidence."""
    with _conn(path) as conn:
        cursor = conn.execute(
            "UPDATE file_operations SET status = 'started', started_at = ? WHERE id = ? AND status = 'planned'",
            (now(), op_id),
        )
        if cursor.rowcount != 1:
            raise RuntimeError(f"operation {op_id} is not in the planned state")


def finish_operation(path: Path, op_id: str, status: str, detail: str, verification: dict[str, Any]) -> None:
    with _conn(path) as conn:
        conn.execute(
            """UPDATE file_operations SET status = ?, detail = ?, verification = ?, finished_at = ?
               WHERE id = ? AND status IN ('planned', 'started')""",
            (status, detail, json.dumps(verification, sort_keys=True) if verification else None, now(), op_id),
        )


def mark_not_attempted(path: Path, plan_id: str, detail: str) -> int:
    with _conn(path) as conn:
        return conn.execute(
            """UPDATE file_operations SET status = 'not_attempted', detail = ?, finished_at = ?
               WHERE plan_id = ? AND status = 'planned'""",
            (detail, now(), plan_id),
        ).rowcount


def operations(path: Path, plan_id: str) -> list[FileOperation]:
    with _conn(path) as conn:
        return [
            _row(FileOperation, r)
            for r in conn.execute("SELECT * FROM file_operations WHERE plan_id = ? ORDER BY seq", (plan_id,))
        ]


def outcome_status(ops: list[FileOperation], cancelled: bool) -> TaskStatus:
    moves = [o for o in ops if o.action == "move"]
    verified = sum(o.status == "verified" for o in moves)
    if any(o.status in ("unknown", "started") for o in moves):
        return "unknown"
    if cancelled:
        return "cancelled"
    if moves and verified == len(moves):
        return "completed"
    return "partial" if verified else "failed"


def finish_task(path: Path, task_id: str, status: TaskStatus, summary: str,
                error: tuple[str, str] | None = None) -> None:
    ts = now()
    with _conn(path) as conn:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            """UPDATE file_tasks SET status = ?, finished_at = ?, updated_at = ?,
                   error_code = ?, error_detail = ? WHERE id = ? AND status = 'executing'""",
            (status, ts, ts, error[0] if error else None, error[1] if error else None, task_id),
        )
        _event(conn, task_id, "finished", f"{status}: {summary}")
        conn.execute("COMMIT")


def executing_tasks(path: Path) -> list[FileTask]:
    with _conn(path) as conn:
        return [_row(FileTask, r) for r in conn.execute("SELECT * FROM file_tasks WHERE status = 'executing'")]


def to_json(detail: TaskDetail) -> dict[str, Any]:
    ops = []
    for o in detail.operations:
        item = asdict(o)
        item["verification"] = json.loads(o.verification) if o.verification else None
        ops.append(item)
    return {
        "task": asdict(detail.task),
        "plan": asdict(detail.plan) if detail.plan else None,
        "operations": ops,
        "events": [asdict(e) for e in detail.events],
    }
