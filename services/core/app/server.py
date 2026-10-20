"""FastAPI application factory."""

from __future__ import annotations

import logging
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api import health
from app.api.security import LocalAuthMiddleware
from app.config import Settings
from app.memory import db

log = logging.getLogger("aegis.server")


def create_app(settings: Settings) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.started_monotonic = time.monotonic()
        try:
            app.state.database_init = db.initialize(settings.database_path)
            log.info("database ready (schema v%s)", app.state.database_init.schema_version)
        except Exception:
            # Keep serving so /health can report the failure instead of the app vanishing.
            log.exception("database initialisation failed")
            app.state.database_init = None
        yield
        log.info("core shutting down")

    app = FastAPI(
        title="AEGIS core",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.database_init = None
    app.state.started_monotonic = time.monotonic()
    app.include_router(health.router)
    app.add_middleware(LocalAuthMiddleware, token=settings.session_token)

    @app.middleware("http")
    async def no_store(request, call_next):  # type: ignore[no-untyped-def]
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    return app
