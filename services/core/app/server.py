"""FastAPI application factory."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import AsyncIterator
from typing import Any
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.agents.chat import GenerationManager
from app.agents.file_agent import FileTaskManager, recover_interrupted
from app.agents.research_agent import ResearchManager
from app.api import chat, file_tasks, health, memory, research_tasks, vaults
from app.api.security import LocalAuthMiddleware
from app.config import Settings
from app.memory import conversations, db
from app.models.base import ModelAdapter, ProviderHealth
from app.models.ollama import OllamaAdapter
from app.tasks import research_journal

log = logging.getLogger("aegis.server")

PROVIDER_PROBE_INTERVAL_S = 5.0
SHUTDOWN_STEP_TIMEOUT_S = 2.0


async def _monitor_provider(app: FastAPI, adapter: ModelAdapter) -> None:
    """Keep a cached provider status so /health stays fast and never blocks on the model server."""
    while True:
        await asyncio.sleep(PROVIDER_PROBE_INTERVAL_S)
        await _probe_provider(app, adapter)


async def _probe_provider(app: FastAPI, adapter: ModelAdapter) -> None:
    try:
        app.state.provider_health = await adapter.health()
    except Exception:
        log.exception("provider health probe failed")
        app.state.provider_health = ProviderHealth(adapter.provider_id, False, "Provider health probe failed.")


def create_app(
    settings: Settings, adapter: ModelAdapter | None = None, fetcher_factory: Any = None
) -> FastAPI:
    model_adapter: ModelAdapter = adapter or OllamaAdapter(settings.ollama_base_url)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.started_monotonic = time.monotonic()
        try:
            app.state.database_init = db.initialize(settings.database_path)
            log.info("database ready (schema v%s)", app.state.database_init.schema_version)
            recovered = conversations.recover_interrupted(settings.database_path)
            if recovered:
                log.warning("marked %d interrupted reply(ies) from a previous run as failed", recovered)
            app.state.generations = GenerationManager(settings.database_path, model_adapter)
            reconciled = recover_interrupted(settings.database_path)
            if reconciled:
                log.warning("reconciled %d file task(s) interrupted by a previous shutdown", reconciled)
            # The app's own data folder can never be chosen as (or inside) an organize scope.
            app.state.file_tasks = FileTaskManager(
                settings.database_path, model_adapter, protected=(settings.data_dir,)
            )
            interrupted = research_journal.recover_interrupted(settings.database_path)
            if interrupted:
                log.warning("marked %d research task(s) interrupted by a previous shutdown as failed", interrupted)
            # fetcher_factory is injected only by tests (fixture web); the app always uses the guarded network fetcher.
            extra = {"fetcher_factory": fetcher_factory} if fetcher_factory else {}
            app.state.research = ResearchManager(
                settings.database_path, model_adapter, protected=(settings.data_dir,), **extra
            )
        except Exception:
            # Keep serving so /health can report the failure instead of the app vanishing.
            log.exception("database initialisation failed")
            app.state.database_init = None
        # One probe before serving (bounded by the adapter's health timeout) so the first /health is accurate.
        await _probe_provider(app, model_adapter)
        monitor = asyncio.create_task(_monitor_provider(app, model_adapter), name="provider-monitor")
        yield
        log.info("core shutting down")
        monitor.cancel()
        if app.state.file_tasks is not None:
            await app.state.file_tasks.shutdown()
        if app.state.research is not None:
            await app.state.research.shutdown()
        if app.state.generations is not None:
            await app.state.generations.shutdown()
        # Bounded: a provider call stuck in the OS must not keep the core alive after shutdown.
        await asyncio.wait({monitor}, timeout=SHUTDOWN_STEP_TIMEOUT_S)
        close = getattr(model_adapter, "aclose", None)
        if close is not None:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(close(), SHUTDOWN_STEP_TIMEOUT_S)

    app = FastAPI(
        title="AEGIS core",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.adapter = model_adapter
    app.state.database_init = None
    app.state.generations = None
    app.state.file_tasks = None
    app.state.research = None
    app.state.provider_health = None
    app.state.started_monotonic = time.monotonic()
    app.include_router(health.router)
    app.include_router(chat.router)
    app.include_router(file_tasks.router)
    app.include_router(research_tasks.router)
    app.include_router(memory.router)
    app.include_router(vaults.router)
    app.add_middleware(LocalAuthMiddleware, token=settings.session_token)

    @app.middleware("http")
    async def no_store(request, call_next):  # type: ignore[no-untyped-def]
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    return app
