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
from app.models.base import ProviderHealth

log = logging.getLogger("aegis.health")
router = APIRouter()


class DatabaseHealth(BaseModel):
    ok: bool
    schema_version: int | None
    journal_mode: str | None
    fts5_available: bool | None


class Capabilities(BaseModel):
    # True only while the provider was reachable at its last probe and has at least one model.
    chat: bool = False


class ProviderHealthOut(BaseModel):
    """Redacted provider view: identity, endpoint and reachability. No credentials exist or are shown."""

    id: str
    base_url: str
    reachable: bool
    detail: str
    models: list[str]


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    service: Literal["aegis-core"] = "aegis-core"
    version: str
    uptime_seconds: float
    database: DatabaseHealth
    capabilities: Capabilities
    provider: ProviderHealthOut | None


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

    probe: ProviderHealth | None = state.provider_health
    provider = (
        ProviderHealthOut(
            id=probe.provider,
            base_url=getattr(state.adapter, "base_url", ""),
            reachable=probe.reachable,
            detail=probe.detail,
            models=[m.name for m in probe.models],
        )
        if probe is not None
        else None
    )
    chat_ready = database.ok and provider is not None and provider.reachable and len(provider.models) > 0

    return HealthResponse(
        status="ok" if database.ok else "degraded",
        version=__version__,
        uptime_seconds=round(time.monotonic() - state.started_monotonic, 3),
        database=database,
        capabilities=Capabilities(chat=chat_ready),
        provider=provider,
    )
