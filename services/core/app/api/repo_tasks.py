"""Repository investigation API (Phase 4). Reached only through Electron main (bearer token).

  POST /repo-tasks/interpret                    route a request; creates a task waiting for a folder
  GET  /repo-tasks                              recent tasks
  GET  /repo-tasks/{id}                         task, plan, evidence used, report, events
  POST /repo-tasks/{id}/scope                   {root_path}: folder from the native picker -> read-only scan + plan
  POST /repo-tasks/{id}/approve                 {plan_digest, use_vault_notes}: run exactly that plan
  POST /repo-tasks/{id}/reject
  POST /repo-tasks/{id}/cancel                  before the run: cancel; during: stop
  POST /repo-tasks/{id}/save                    {root_path}: save folder from the picker (never inside the repo)
  POST /repo-tasks/{id}/proposals/{n}/accept    store one code-built memory proposal as the user's own fact

No request field can name a file to read, a tool, or a vault note: the files and notes are fixed by the
scan and the approved plan digest; the only paths are the two folders chosen in the native pickers.
"""

from __future__ import annotations

import uuid
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Request
from fastapi import Path as PathParam
from pydantic import BaseModel, ConfigDict, Field

from app.agents.repo_agent import RepoManager
from app.agents.research_agent import TaskBusy
from app.api.file_tasks import DIGEST, InterpretRequest, ScopeRequest
from app.memory.adaptive import MemoryError
from app.tasks import repo_journal as journal
from app.tools.file_scope import ScopeError

router = APIRouter(prefix="/repo-tasks")


class RepoInterpretRequest(InterpretRequest):
    model: Annotated[str, Field(min_length=1, max_length=128)]


class ApproveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    plan_digest: Annotated[str, Field(pattern=DIGEST.pattern)]
    use_vault_notes: bool


def _manager(request: Request) -> RepoManager:
    manager: RepoManager | None = request.app.state.repo
    if manager is None:
        raise HTTPException(503, detail="database_unavailable")
    return manager


def _detail(request: Request, task_id: str) -> dict[str, Any]:
    try:
        return journal.get_detail(request.app.state.settings.database_path, task_id)
    except journal.NotFound:
        raise HTTPException(404, detail="task_not_found") from None


def _error(error: Exception) -> HTTPException:
    if isinstance(error, journal.NotFound):
        return HTTPException(404, detail="task_not_found")
    if isinstance(error, ScopeError):
        return HTTPException(400, detail=error.code)
    if isinstance(error, MemoryError):
        return HTTPException(422 if error.code == "secret_detected" else 409, detail=error.code)
    return HTTPException(409, detail=getattr(error, "code", "conflict"))


_HANDLED = (journal.NotFound, journal.StateError, TaskBusy, ScopeError, MemoryError)


@router.post("/interpret")
def interpret(body: RepoInterpretRequest, request: Request) -> dict[str, Any]:
    result = _manager(request).interpret(body.text, body.model)
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


@router.post("/{task_id}/scope")
async def scope(task_id: uuid.UUID, body: ScopeRequest, request: Request) -> dict[str, Any]:
    try:
        await _manager(request).scope(str(task_id), body.root_path)
    except _HANDLED as error:
        raise _error(error) from None
    return _detail(request, str(task_id))


@router.post("/{task_id}/approve")
async def approve(task_id: uuid.UUID, body: ApproveRequest, request: Request) -> dict[str, Any]:
    try:
        _manager(request).approve(str(task_id), body.plan_digest, body.use_vault_notes)
    except _HANDLED as error:
        raise _error(error) from None
    return _detail(request, str(task_id))


@router.post("/{task_id}/reject")
async def reject(task_id: uuid.UUID, request: Request) -> dict[str, Any]:
    try:
        _manager(request).reject(str(task_id))
    except _HANDLED as error:
        raise _error(error) from None
    return _detail(request, str(task_id))


@router.post("/{task_id}/cancel")
async def cancel(task_id: uuid.UUID, request: Request) -> dict[str, Any]:
    try:
        _manager(request).cancel(str(task_id))
    except _HANDLED as error:
        raise _error(error) from None
    return _detail(request, str(task_id))


@router.post("/{task_id}/save")
async def save(task_id: uuid.UUID, body: ScopeRequest, request: Request) -> dict[str, Any]:
    try:
        await _manager(request).save(str(task_id), body.root_path)
    except _HANDLED as error:
        raise _error(error) from None
    return _detail(request, str(task_id))


@router.post("/{task_id}/proposals/{index}/accept")
def accept_proposal(task_id: uuid.UUID, index: Annotated[int, PathParam(ge=0, le=9)], request: Request) -> dict[str, Any]:
    try:
        result = _manager(request).accept_proposal(str(task_id), index)
    except _HANDLED as error:
        raise _error(error) from None
    return {**result, "detail": _detail(request, str(task_id))}
