"""Permissioned file-organization agent (Phase 2, ADR-003/ADR-007).

Two bounded LangGraph graphs, split exactly at the human gate:

  plan graph:     validate_scope → build_plan → persist_plan        (ends awaiting approval)
  execute graph:  revalidate → execute_operations → finalize        (runs only after approval)

The approval itself is not a graph step: it is a conditional write in the
SQLite journal bound to one plan id and digest (see tasks/file_journal.py), so
it survives restarts and can be given only once. The model is consulted only
to interpret the request (agents/intent.py); every path, category, policy
decision and filesystem effect comes from deterministic code.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph

from app.agents.intent import Interpretation, interpret
from app.models.base import ModelAdapter
from app.tasks import file_journal as journal
from app.tools.file_organizer import PlannedOperation, build_plan, execute_move, reconcile_move
from app.tools.file_scope import Scope, ScopeError, check_scope_unchanged, validate_root

log = logging.getLogger("aegis.agents.files")

SHUTDOWN_WAIT_S = 5.0


class PlanState(TypedDict, total=False):
    task_id: str
    raw_root: str
    rescan: bool
    scope: Scope
    operations: list[PlannedOperation]
    error: tuple[str, str]


class ExecState(TypedDict, total=False):
    task_id: str
    plan_id: str
    scope: Scope
    error: tuple[str, str]
    cancelled: bool


class TaskBusy(RuntimeError):
    pass


def _route_on_error(next_node: str):  # type: ignore[no-untyped-def]
    return lambda state: "fail" if state.get("error") else next_node


class FileTaskManager:
    def __init__(self, database_path: Path, adapter: ModelAdapter, protected: tuple[Path, ...] = ()) -> None:
        self._db = database_path
        self._adapter = adapter
        self._protected = protected
        self._running: dict[str, asyncio.Task[None]] = {}
        self._cancel: dict[str, asyncio.Event] = {}
        self._plan_graph = self._build_plan_graph()
        self._exec_graph = self._build_exec_graph()

    # ------------------------------------------------------------------ graphs

    def _build_plan_graph(self):  # type: ignore[no-untyped-def]
        db, protected = self._db, self._protected

        async def validate_scope(state: PlanState) -> dict[str, Any]:
            try:
                scope = await asyncio.to_thread(validate_root, state["raw_root"], protected)
            except ScopeError as error:
                return {"error": (error.code, error.detail)}
            if not journal.set_scope(
                db, state["task_id"], str(scope.root), scope.identity, rescan=state.get("rescan", False)
            ):
                return {"error": ("task_not_open", "The task is no longer waiting for a folder.")}
            return {"scope": scope}

        async def build(state: PlanState) -> dict[str, Any]:
            try:
                return {"operations": await asyncio.to_thread(build_plan, state["scope"])}
            except ScopeError as error:
                return {"error": (error.code, error.detail)}
            except OSError as error:
                return {"error": ("scan_failed", f"The folder could not be listed ({error.strerror}).")}

        async def persist(state: PlanState) -> dict[str, Any]:
            scope = state["scope"]
            try:
                journal.record_plan(db, state["task_id"], str(scope.root), scope.identity, state["operations"])
            except journal.ApprovalError as error:
                return {"error": (error.code, "The task changed while the plan was being prepared.")}
            return {}

        async def fail(state: PlanState) -> dict[str, Any]:
            code, detail = state["error"]
            journal.set_status(
                db, state["task_id"], "failed",
                expect=("awaiting_folder", "planning"),
                event=("plan_failed", f"{code}: {detail}"),
                error=(code, detail),
            )
            return {}

        graph = StateGraph(PlanState)
        graph.add_node("validate_scope", validate_scope)
        graph.add_node("build_plan", build)
        graph.add_node("persist_plan", persist)
        graph.add_node("fail", fail)
        graph.add_edge(START, "validate_scope")
        graph.add_conditional_edges("validate_scope", _route_on_error("build_plan"), ["build_plan", "fail"])
        graph.add_conditional_edges("build_plan", _route_on_error("persist_plan"), ["persist_plan", "fail"])
        graph.add_conditional_edges("persist_plan", _route_on_error(END), [END, "fail"])
        graph.add_edge("fail", END)
        return graph.compile()

    def _build_exec_graph(self):  # type: ignore[no-untyped-def]
        db = self._db

        async def revalidate(state: ExecState) -> dict[str, Any]:
            try:
                await asyncio.to_thread(check_scope_unchanged, state["scope"])
            except ScopeError as error:
                return {"error": (error.code, error.detail)}
            journal.add_event(db, state["task_id"], "revalidated", "Folder identity re-checked before execution.")
            return {}

        async def execute(state: ExecState) -> dict[str, Any]:
            task_id, scope = state["task_id"], state["scope"]
            cancel = self._cancel[task_id]
            for op in journal.operations(db, state["plan_id"]):
                if op.action != "move" or op.status != "planned":
                    continue
                if cancel.is_set():
                    return {"cancelled": True}
                journal.mark_started(db, op.id)
                outcome = await asyncio.to_thread(execute_move, scope, op.planned())
                journal.finish_operation(db, op.id, outcome.status, outcome.detail, outcome.verification)
                if outcome.created_folder:
                    journal.add_event(db, task_id, "folder_created", f"Created folder {op.category}/ in the scope.")
                if outcome.status != "failed":
                    continue
                try:  # A vanished or replaced root ends the run; per-file problems do not.
                    await asyncio.to_thread(check_scope_unchanged, scope)
                except ScopeError as error:
                    return {"error": (error.code, error.detail)}
            return {"cancelled": cancel.is_set()}

        async def finalize(state: ExecState) -> dict[str, Any]:
            task_id, plan_id = state["task_id"], state["plan_id"]
            cancelled = bool(state.get("cancelled"))
            error = state.get("error")
            reason = "stopped by the user" if cancelled else (error[1] if error else "not reached")
            journal.mark_not_attempted(db, plan_id, f"Not attempted: {reason}.")
            ops = journal.operations(db, plan_id)
            status = journal.outcome_status(ops, cancelled)
            journal.finish_task(db, task_id, status, _summary(ops), error)
            return {}

        graph = StateGraph(ExecState)
        graph.add_node("revalidate", revalidate)
        graph.add_node("execute_operations", execute)
        graph.add_node("finalize", finalize)
        graph.add_edge(START, "revalidate")
        graph.add_conditional_edges(
            "revalidate", lambda s: "finalize" if s.get("error") else "execute_operations",
            ["execute_operations", "finalize"],
        )
        graph.add_edge("execute_operations", "finalize")
        graph.add_edge("finalize", END)
        return graph.compile()

    # ------------------------------------------------------------------ API

    async def interpret(self, text: str, model: str | None) -> tuple[Interpretation, journal.FileTask | None]:
        result = await interpret(self._adapter, model, text)
        if result.intent != "organize_by_type":
            return result, None
        task = journal.create_task(self._db, text, result.source, result.model, result.detail)
        return result, task

    async def set_scope(self, task_id: str, raw_root: str, *, rescan: bool = False) -> journal.TaskDetail:
        task = journal.get_task(self._db, task_id)
        if task.status not in ("awaiting_folder", "awaiting_approval"):
            raise TaskBusy(task.status)
        await self._plan_graph.ainvoke({"task_id": task_id, "raw_root": raw_root, "rescan": rescan})
        return journal.get_detail(self._db, task_id)

    async def replan(self, task_id: str) -> journal.TaskDetail:
        """Re-scan the already authorized folder (e.g. after a plan expired). Never widens the scope."""
        task = journal.get_task(self._db, task_id)
        if task.status != "awaiting_approval" or task.root_path is None:
            raise TaskBusy(task.status)
        return await self.set_scope(task_id, task.root_path, rescan=True)

    def approve(self, task_id: str, plan_id: str, digest: str) -> journal.TaskDetail:
        task = journal.approve(self._db, task_id, plan_id, digest)
        assert task.root_path is not None and task.root_identity is not None
        scope = Scope(Path(task.root_path), task.root_identity)
        self._cancel[task_id] = asyncio.Event()
        self._running[task_id] = asyncio.create_task(self._run(task_id, plan_id, scope), name=f"file-task-{task_id}")
        return journal.get_detail(self._db, task_id)

    async def _run(self, task_id: str, plan_id: str, scope: Scope) -> None:
        try:
            await self._exec_graph.ainvoke({"task_id": task_id, "plan_id": plan_id, "scope": scope})
        except Exception:
            log.exception("file task %s failed unexpectedly", task_id)
            journal.mark_not_attempted(self._db, plan_id, "Not attempted: internal error.")
            ops = journal.operations(self._db, plan_id)
            journal.finish_task(
                self._db, task_id, journal.outcome_status(ops, False), _summary(ops),
                ("internal_error", "Unexpected error in the core (see core log)."),
            )
        finally:
            self._running.pop(task_id, None)
            self._cancel.pop(task_id, None)

    def reject(self, task_id: str, plan_id: str) -> journal.TaskDetail:
        journal.reject(self._db, task_id, plan_id)
        return journal.get_detail(self._db, task_id)

    def cancel(self, task_id: str) -> journal.TaskDetail:
        task = journal.get_task(self._db, task_id)
        if task.status == "executing":
            if journal.request_cancel(self._db, task_id) and task_id in self._cancel:
                self._cancel[task_id].set()
        elif not journal.cancel_open(self._db, task_id):
            raise TaskBusy(task.status)
        return journal.get_detail(self._db, task_id)

    async def wait_idle(self, task_id: str, timeout: float = 10.0) -> None:
        running = self._running.get(task_id)
        if running is not None:
            await asyncio.wait({running}, timeout=timeout)

    async def shutdown(self) -> None:
        """Stop starting new operations; the one in flight (a single rename) is allowed to finish."""
        for event in self._cancel.values():
            event.set()
        if self._running:
            await asyncio.wait(set(self._running.values()), timeout=SHUTDOWN_WAIT_S)


def _summary(ops: list[journal.FileOperation]) -> str:
    counts: dict[str, int] = {}
    for op in ops:
        counts[op.status] = counts.get(op.status, 0) + 1
    return ", ".join(f"{n} {status}" for status, n in sorted(counts.items()))


def recover_interrupted(database_path: Path) -> int:
    """At startup nothing can be executing: reconcile any run a crash or kill left behind.

    Operations written as 'started' are classified by inspecting the filesystem
    (moved / not moved / unknown); never-started ones become 'not_attempted'.
    Nothing is retried automatically.
    """
    recovered = 0
    for task in journal.executing_tasks(database_path):
        plan_id = task.approval_plan_id
        if plan_id is None or task.root_path is None or task.root_identity is None:
            continue
        scope = Scope(Path(task.root_path), task.root_identity)
        try:
            check_scope_unchanged(scope)
            root_ok = True
        except ScopeError:
            root_ok = False
        for op in journal.operations(database_path, plan_id):
            if op.status != "started":
                continue
            if root_ok:
                outcome = reconcile_move(scope, op.planned())
                journal.finish_operation(
                    database_path, op.id, outcome.status,
                    f"Recovered after interruption: {outcome.detail}", outcome.verification,
                )
            else:
                journal.finish_operation(
                    database_path, op.id, "unknown",
                    "Interrupted, and the folder changed since; the state could not be confirmed.", {},
                )
        journal.mark_not_attempted(database_path, plan_id, "Not attempted: the core stopped during the run.")
        ops = journal.operations(database_path, plan_id)
        journal.finish_task(
            database_path, task.id, journal.outcome_status(ops, False), _summary(ops),
            ("interrupted", "The core stopped during execution; results were reconciled from the filesystem."),
        )
        recovered += 1
    return recovered
