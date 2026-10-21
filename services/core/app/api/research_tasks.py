"""Research task API (Phase 3). Reached only through Electron main (bearer token).

  POST /research-tasks/interpret      route + plan a request; creates a task only if a source is readable
  GET  /research-tasks                recent tasks
  GET  /research-tasks/{id}           task, sources with provenance, report, events
  POST /research-tasks/{id}/approve   {plan_digest}: read exactly the planned sources
  POST /research-tasks/{id}/reject
  POST /research-tasks/{id}/cancel    before reading: cancel; during: stop
  POST /research-tasks/{id}/save      {dest_dir}: folder from the native picker; writes a new .md file

No request field can add a source, a tool or a file path other than the one
save folder, and that folder passes the same scope checks as Phase 2.
"""

from __future__ import annotations

import uuid
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from app.agents.research_agent import ResearchManager, TaskBusy
from app.api.file_tasks import DIGEST, InterpretRequest, ScopeRequest
from app.tasks import research_journal as journal
from app.tools.file_scope import ScopeError

router = APIRouter(prefix="/research-tasks")


class ResearchInterpretRequest(InterpretRequest):
    # The report needs a model; planning falls back to keywords if the model fails.
    model: Annotated[str, Field(min_length=1, max_length=128)]


class ApproveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    plan_digest: Annotated[str, Field(pattern=DIGEST.pattern)]


class SaveRequest(ScopeRequest):
    pass


def _manager(request: Request) -> ResearchManager:
    manager: ResearchManager | None = request.app.state.research
    if manager is None:
        raise HTTPException(503, detail="database_unavailable")
    return manager


def _detail(request: Request, task_id: str) -> dict[str, Any]:
    try:
        return journal.get_detail(request.app.state.settings.database_path, task_id)
    except journal.NotFound:
        raise HTTPException(404, detail="task_not_found") from None


@router.post("/interpret")
async def interpret(body: ResearchInterpretRequest, request: Request) -> dict[str, Any]:
    result = await _manager(request).interpret(body.text, body.model)
    task_id = result.pop("task_id")
    return {**result, "task": _detail(request, task_id) if task_id else None}


@router.get("")
def list_tasks(request: Request) -> dict[str, Any]:
    _manager(request)
    return {"tasks": journal.list_tasks(request.app.state.settings.database_path)}


@router.get("/{task_id}")
def get_task(task_id: uuid.UUID, request: Request) -> dict[str, Any]:
    _manager(request)
    return _detail(request, str(task_id))


@router.post("/{task_id}/approve")
async def approve(task_id: uuid.UUID, body: ApproveRequest, request: Request) -> dict[str, Any]:
    try:
        _manager(request).approve(str(task_id), body.plan_digest)
    except journal.NotFound:
        raise HTTPException(404, detail="task_not_found") from None
    except (journal.StateError, TaskBusy) as error:
        raise HTTPException(409, detail=error.code) from None
    return _detail(request, str(task_id))


@router.post("/{task_id}/reject")
async def reject(task_id: uuid.UUID, request: Request) -> dict[str, Any]:
    try:
        _manager(request).reject(str(task_id))
    except journal.NotFound:
        raise HTTPException(404, detail="task_not_found") from None
    except journal.StateError as error:
        raise HTTPException(409, detail=error.code) from None
    return _detail(request, str(task_id))


@router.post("/{task_id}/cancel")
async def cancel(task_id: uuid.UUID, request: Request) -> dict[str, Any]:
    try:
        _manager(request).cancel(str(task_id))
    except journal.NotFound:
        raise HTTPException(404, detail="task_not_found") from None
    except TaskBusy as error:
        raise HTTPException(409, detail=error.code) from None
    return _detail(request, str(task_id))


@router.post("/{task_id}/save")
async def save(task_id: uuid.UUID, body: SaveRequest, request: Request) -> dict[str, Any]:
    try:
        await _manager(request).save(str(task_id), body.root_path)
    except journal.NotFound:
        raise HTTPException(404, detail="task_not_found") from None
    except TaskBusy as error:
        raise HTTPException(409, detail=error.code) from None
    except ScopeError as error:
        raise HTTPException(400, detail=error.code) from None
    return _detail(request, str(task_id))
