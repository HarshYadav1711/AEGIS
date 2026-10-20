"""GET /health — truthful liveness and subsystem status."""

from __future__ import annotations

import logging
import sqlite3
import time
from typing import Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel

from app import __version__
from app.memory import db

log = logging.getLogger("aegis.health")
router = APIRouter()


class DatabaseHealth(BaseModel):
    ok: bool
    schema_version: int | None
    journal_mode: str | None
    fts5_available: bool | None


class Capabilities(BaseModel):
    # No model adapter exists in Phase 0. This stays false until a real one is wired.
    chat: bool = False


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    service: Literal["aegis-core"] = "aegis-core"
    version: str
    uptime_seconds: float
    database: DatabaseHealth
    capabilities: Capabilities


@router.get("/health", response_model=HealthResponse)
def health(request: Request) -> HealthResponse:
    state = request.app.state
    init: db.DatabaseStatus | None = state.database_init
    if init is None or not init.ok:
        database = DatabaseHealth(ok=False, schema_version=None, journal_mode=None, fts5_available=None)
    else:
        try:
            live = db.probe(state.settings.database_path)
            database = DatabaseHealth(
                ok=live.ok,
                schema_version=live.schema_version,
                journal_mode=live.journal_mode,
                fts5_available=init.fts5_available,
            )
        except sqlite3.Error:
            log.exception("database probe failed")
            database = DatabaseHealth(ok=False, schema_version=None, journal_mode=None, fts5_available=None)

    return HealthResponse(
        status="ok" if database.ok else "degraded",
        version=__version__,
        uptime_seconds=round(time.monotonic() - state.started_monotonic, 3),
        database=database,
        capabilities=Capabilities(),
    )
