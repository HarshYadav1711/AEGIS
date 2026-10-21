"""Memory API (workstream M0). Reached only through Electron main (bearer token).

  GET  /memory?q=&history=0|1     search (FTS5) or list; history=1 includes superseded/rejected versions
  POST /memory                    {content, kind, subject, scope, expires_at}: add an explicit memory
  POST /memory/{id}/correct       {content}: new version; the old one is kept as superseded
  POST /memory/{id}/confirm       accept a candidate / resolve a dispute in favour of this one
  POST /memory/{id}/reject
  POST /memory/{id}/delete        permanently delete every version of this memory
  GET  /memory/settings
  POST /memory/settings           {capture_enabled, project}

No request field can set a status, verification level or source: those are
decided by the store from the action taken.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, time, timezone
from pathlib import Path
from typing import Annotated, Any, Literal

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from app.memory import adaptive as memory

router = APIRouter(prefix="/memory")

_STATUS = {
    "memory_not_found": 404,
    "secret_detected": 422,
    "empty_memory": 422,
    "memory_too_long": 422,
    "invalid_project": 422,
    "no_project": 422,
}


class AddRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    content: Annotated[str, Field(min_length=1, max_length=memory.MAX_CONTENT)]
    kind: Literal["fact", "preference"]
    subject: Annotated[str | None, Field(max_length=memory.MAX_SUBJECT)] = None
    scope: Literal["global", "project"]
    expires_on: date | None = None


class CorrectRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    content: Annotated[str, Field(min_length=1, max_length=memory.MAX_CONTENT)]


class SettingsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    capture_enabled: bool
    project: Annotated[str | None, Field(max_length=40)] = None


def _db(request: Request) -> Path:
    if request.app.state.database_init is None:
        raise HTTPException(503, detail="database_unavailable")
    return request.app.state.settings.database_path


def _fail(error: memory.MemoryError) -> HTTPException:
    return HTTPException(_STATUS.get(error.code, 409), detail=error.code)


def _one(path: Path, fact: memory.Fact) -> dict[str, Any]:
    return memory.describe(path, fact.id)


@router.get("")
def search(
    request: Request,
    q: Annotated[str, Query(max_length=200)] = "",
    history: Annotated[int, Query(ge=0, le=1)] = 0,
) -> dict[str, Any]:
    path = _db(request)
    return {"memories": memory.search(path, q, include_history=bool(history)), "settings": memory.get_settings(path)}


@router.get("/settings")
def get_settings(request: Request) -> dict[str, Any]:
    return memory.get_settings(_db(request))


@router.post("/settings")
def set_settings(body: SettingsRequest, request: Request) -> dict[str, Any]:
    project = body.project.strip() if body.project and body.project.strip() else None
    try:
        return memory.update_settings(_db(request), capture_enabled=body.capture_enabled, project=project)
    except memory.MemoryError as error:
        raise _fail(error) from None


@router.post("", status_code=201)
def add(body: AddRequest, request: Request) -> dict[str, Any]:
    path = _db(request)
    project = memory.get_settings(path)["project"]
    if body.scope == "project" and not project:
        raise HTTPException(422, detail="no_project")
    expires = None
    if body.expires_on is not None:
        if body.expires_on <= date.today():
            raise HTTPException(422, detail="expiry_in_past")
        expires = datetime.combine(body.expires_on, time.min, timezone.utc).isoformat()
    try:
        fact, outcome = memory.add_explicit(
            path, content=body.content, kind=body.kind, subject=body.subject,
            scope=memory.scope_for(project if body.scope == "project" else None), expires_at=expires,
        )
    except memory.MemoryError as error:
        raise _fail(error) from None
    return {"memory": _one(path, fact), "outcome": outcome}


@router.post("/{fact_id}/correct")
def correct(fact_id: uuid.UUID, body: CorrectRequest, request: Request) -> dict[str, Any]:
    path = _db(request)
    try:
        return {"memory": _one(path, memory.correct(path, str(fact_id), body.content))}
    except memory.MemoryError as error:
        raise _fail(error) from None


@router.post("/{fact_id}/{action}")
def decide(fact_id: uuid.UUID, action: Literal["confirm", "reject", "delete"], request: Request) -> dict[str, Any]:
    path = _db(request)
    try:
        if action == "delete":
            return {"deleted": memory.delete(path, str(fact_id))}
        fact = (memory.confirm if action == "confirm" else memory.reject)(path, str(fact_id))
    except memory.MemoryError as error:
        raise _fail(error) from None
    return {"memory": _one(path, fact)}
