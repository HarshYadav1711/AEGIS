"""Vault API (M0A). Reached only through Electron main (bearer token).

  GET  /vaults                        registered vaults with index status and counts
  POST /vaults                        {root_path}: folder from the native picker; registers and indexes it
  POST /vaults/{id}/reindex           pick up external edits now
  POST /vaults/{id}/write-area        {enabled}: allow / revoke AEGIS creating notes in <vault>/AEGIS/
  POST /vaults/{id}/remove            forget the vault (index only; files are never touched)
  POST /vaults/{id}/notes             {title, body}: create a new note in the AEGIS area (never overwrites)
  GET  /vault-search?q=               FTS5 search over indexed notes (stale vaults are re-scanned first)
  GET  /vault-notes/{id}              one note with its observed version history

Plain synchronous handlers: FastAPI runs them in its thread pool, off the event loop.
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from app.api.file_tasks import ScopeRequest
from app.memory import vault_index as vaults
from app.tools.file_scope import ScopeError

router = APIRouter()

_STATUS = {"vault_not_found": 404, "note_not_found": 404, "secret_detected": 422, "read_only_vault": 409}


class WriteAreaRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool


class NoteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: Annotated[str, Field(min_length=1, max_length=120)]
    body: Annotated[str, Field(min_length=1, max_length=20_000)]


def _db(request: Request) -> Path:
    if request.app.state.database_init is None:
        raise HTTPException(503, detail="database_unavailable")
    return request.app.state.settings.database_path


def _fail(error: vaults.VaultError | ScopeError) -> HTTPException:
    return HTTPException(_STATUS.get(error.code, 400 if isinstance(error, ScopeError) else 409), detail=error.code)


@router.get("/vaults")
def list_vaults(request: Request) -> dict[str, Any]:
    return {"vaults": vaults.list_vaults(_db(request))}


@router.post("/vaults", status_code=201)
def register(body: ScopeRequest, request: Request) -> dict[str, Any]:
    try:
        return {"vault": vaults.register(_db(request), body.root_path, (request.app.state.settings.data_dir,))}
    except (vaults.VaultError, ScopeError) as error:
        raise _fail(error) from None


@router.post("/vaults/{vault_id}/reindex")
def reindex(vault_id: uuid.UUID, request: Request) -> dict[str, Any]:
    path = _db(request)
    try:
        changes = vaults.reindex(path, str(vault_id))
        return {"vault": vaults.describe(path, str(vault_id)), "changes": changes}
    except vaults.VaultError as error:
        raise _fail(error) from None


@router.post("/vaults/{vault_id}/write-area")
def write_area(vault_id: uuid.UUID, body: WriteAreaRequest, request: Request) -> dict[str, Any]:
    try:
        return {"vault": vaults.set_write_area(_db(request), str(vault_id), body.enabled)}
    except vaults.VaultError as error:
        raise _fail(error) from None


@router.post("/vaults/{vault_id}/remove")
def remove(vault_id: uuid.UUID, request: Request) -> dict[str, Any]:
    try:
        vaults.remove(_db(request), str(vault_id))
    except vaults.VaultError as error:
        raise _fail(error) from None
    return {"removed": True}


@router.post("/vaults/{vault_id}/notes", status_code=201)
def add_note(vault_id: uuid.UUID, body: NoteRequest, request: Request) -> dict[str, Any]:
    try:
        return {"note": vaults.add_note(_db(request), str(vault_id), body.title, body.body)}
    except vaults.VaultError as error:
        raise _fail(error) from None


@router.get("/vault-search")
def search(request: Request, q: Annotated[str, Query(max_length=200)] = "") -> dict[str, Any]:
    path = _db(request)
    vaults.refresh_stale(path)
    return {"notes": vaults.search(path, q), "vaults": vaults.list_vaults(path)}


@router.get("/vault-notes/{note_id}")
def get_note(note_id: uuid.UUID, request: Request) -> dict[str, Any]:
    try:
        return {"note": vaults.get_note(_db(request), str(note_id))}
    except vaults.VaultError as error:
        raise _fail(error) from None


@router.get("/vault-notes/{note_id}/path")
def note_path(note_id: uuid.UUID, request: Request) -> dict[str, Any]:
    """For Electron main only, to open the file: re-validated against the vault scope on every call."""
    try:
        return {"path": str(vaults.note_path(_db(request), str(note_id)))}
    except vaults.VaultError as error:
        raise _fail(error) from None
