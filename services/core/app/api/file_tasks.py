"""File-organization task API (Phase 2). Reached only through Electron main (bearer token).

  POST /file-tasks/interpret            classify a request; creates a task only for organize_by_type
  GET  /file-tasks                      recent tasks
  GET  /file-tasks/{id}                 task, current plan, operations journal, events
  POST /file-tasks/{id}/scope           folder chosen in the native picker -> deterministic plan
  POST /file-tasks/{id}/replan          re-scan the same authorized folder
  POST /file-tasks/{id}/approve         {plan_id, plan_digest}: start executing exactly that plan
  POST /file-tasks/{id}/reject          {plan_id}
  POST /file-tasks/{id}/cancel          before execution: cancel; during: stop further operations

The model never calls these endpoints and no request field can carry approval
by itself: approval requires the stored plan's id and digest while the task is
awaiting approval, and succeeds at most once.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import asdict
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.agents.file_agent import FileTaskManager, TaskBusy
from app.tasks import file_journal as journal

router = APIRouter(prefix="/file-tasks")

MAX_REQUEST_CHARS = 2000
MODEL_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")
DIGEST = re.compile(r"^[0-9a-f]{64}$")


class InterpretRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: Annotated[str, Field(min_length=1, max_length=MAX_REQUEST_CHARS)]
    model: Annotated[str, Field(min_length=1, max_length=128)] | None = None

    @field_validator("text")
    @classmethod
    def not_blank(cls, value: str) -> str:
        if not value.strip() or "\x00" in value:
            raise ValueError("text must be non-blank and contain no NUL")
        return value

    @field_validator("model")
    @classmethod
    def model_name(cls, value: str | None) -> str | None:
        if value is not None and not MODEL_NAME.fullmatch(value):
            raise ValueError("model name contains unsupported characters")
        return value


class ScopeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    root_path: Annotated[str, Field(min_length=1, max_length=1024)]


class ApproveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    plan_id: uuid.UUID
    plan_digest: Annotated[str, Field(pattern=DIGEST.pattern)]


class RejectRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    plan_id: uuid.UUID


def _manager(request: Request) -> FileTaskManager:
    manager: FileTaskManager | None = request.app.state.file_tasks
    if manager is None:
        raise HTTPException(503, detail="database_unavailable")
    return manager


def _detail(request: Request, task_id: str) -> dict[str, Any]:
    try:
        return journal.to_json(journal.get_detail(request.app.state.settings.database_path, task_id))
    except journal.NotFound:
        raise HTTPException(404, detail="task_not_found") from None


@router.post("/interpret")
async def interpret(body: InterpretRequest, request: Request) -> dict[str, Any]:
    manager = _manager(request)
    result, task = await manager.interpret(body.text, body.model)
    return {
        "intent": result.intent,
        "source": result.source,
        "model": result.model,
        "detail": result.detail,
        "task": _detail(request, task.id) if task else None,
    }


@router.get("")
def list_tasks(request: Request) -> dict[str, Any]:
    _manager(request)
    tasks = journal.list_tasks(request.app.state.settings.database_path)
    return {"tasks": [asdict(t) for t in tasks]}


@router.get("/{task_id}")
def get_task(task_id: uuid.UUID, request: Request) -> dict[str, Any]:
    _manager(request)
    return _detail(request, str(task_id))


@router.post("/{task_id}/scope")
async def set_scope(task_id: uuid.UUID, body: ScopeRequest, request: Request) -> dict[str, Any]:
    manager = _manager(request)
    try:
        await manager.set_scope(str(task_id), body.root_path)
    except journal.NotFound:
        raise HTTPException(404, detail="task_not_found") from None
    except TaskBusy:
        raise HTTPException(409, detail="task_not_open") from None
    return _detail(request, str(task_id))


@router.post("/{task_id}/replan")
async def replan(task_id: uuid.UUID, request: Request) -> dict[str, Any]:
    manager = _manager(request)
    try:
        await manager.replan(str(task_id))
    except journal.NotFound:
        raise HTTPException(404, detail="task_not_found") from None
    except TaskBusy:
        raise HTTPException(409, detail="task_not_open") from None
    return _detail(request, str(task_id))


@router.post("/{task_id}/approve")
async def approve(task_id: uuid.UUID, body: ApproveRequest, request: Request) -> dict[str, Any]:
    manager = _manager(request)
    try:
        detail = manager.approve(str(task_id), str(body.plan_id), body.plan_digest)
    except journal.NotFound:
        raise HTTPException(404, detail="task_not_found") from None
    except journal.ApprovalError as error:
        raise HTTPException(409, detail=error.code) from None
    return journal.to_json(detail)


@router.post("/{task_id}/reject")
async def reject(task_id: uuid.UUID, body: RejectRequest, request: Request) -> dict[str, Any]:
    manager = _manager(request)
    try:
        detail = manager.reject(str(task_id), str(body.plan_id))
    except journal.NotFound:
        raise HTTPException(404, detail="task_not_found") from None
    except journal.ApprovalError as error:
        raise HTTPException(409, detail=error.code) from None
    return journal.to_json(detail)


@router.post("/{task_id}/cancel")
async def cancel(task_id: uuid.UUID, request: Request) -> dict[str, Any]:
    manager = _manager(request)
    try:
        detail = manager.cancel(str(task_id))
    except journal.NotFound:
        raise HTTPException(404, detail="task_not_found") from None
    except TaskBusy:
        raise HTTPException(409, detail="task_already_finished") from None
    return journal.to_json(detail)
