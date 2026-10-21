"""REAL public-web research acceptance. Skipped unless explicitly enabled; a skip means NOT RUN, never PASS.

    $env:AEGIS_LIVE_WEB = '1'                       # real network fetch + isolated Chromium
    $env:AEGIS_LIVE_MODEL = 'qwen3:4b'              # optional: also a real Ollama report
    .venv\\Scripts\\python -m pytest tests/test_research_live.py -s

Prints what was actually fetched and how the findings were verified.
"""

from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path

import pytest

from app.agents.research_agent import ResearchManager
from app.memory import db
from app.models.ollama import OllamaAdapter
from app.tasks import research_journal as journal
from app.tools.web_guard import GuardedFetcher, UrlRejected
from app.tools.web_reader import PageReader, robots_allows

LIVE = os.environ.get("AEGIS_LIVE_WEB", "").strip() == "1"
MODEL = os.environ.get("AEGIS_LIVE_MODEL", "").strip()
pytestmark = pytest.mark.skipif(not LIVE, reason="NOT CONFIGURED: set AEGIS_LIVE_WEB=1 to fetch real public pages")

PAGE = "https://docs.python.org/3/library/asyncio-task.html"


def test_live_fetch_and_extract() -> None:
    async def scenario() -> None:
        fetcher = GuardedFetcher()
        try:
            allowed, why = await robots_allows(fetcher, PAGE)
            print(f"robots: {allowed} ({why})")
            assert allowed
            started = time.monotonic()
            page = await fetcher.fetch(PAGE, 2_000_000)
            async with PageReader() as reader:
                ex = await reader.extract(page.final_url, page.raw_content_type, page.body, 40_000)
            print(f"HTTP {page.status} {page.content_type} {len(page.body)} bytes -> {len(ex.text)} chars, "
                  f"title={ex.title!r}, canonical={ex.canonical_url}, blocked={ex.blocked_requests}, "
                  f"{time.monotonic() - started:.1f}s")
            assert page.status == 200 and "coroutine" in ex.text.lower() and ex.blocked_requests > 0
        finally:
            await fetcher.aclose()

    asyncio.run(scenario())


def test_live_private_targets_are_refused_before_connecting() -> None:
    async def scenario() -> None:
        fetcher = GuardedFetcher()
        try:
            for url in ("https://localhost/", "https://127.0.0.1/", "https://192.168.1.1/", "http://example.com/"):
                with pytest.raises(UrlRejected) as info:
                    await fetcher.fetch(url, 1000)
                print(f"{url}: refused ({info.value.code})")
        finally:
            await fetcher.aclose()

    asyncio.run(scenario())


@pytest.mark.skipif(not MODEL, reason="NOT CONFIGURED: set AEGIS_LIVE_MODEL for a real model-backed report")
def test_live_model_backed_report(tmp_path: Path) -> None:
    async def scenario() -> None:
        database = tmp_path / "aegis.db"
        db.initialize(database)
        adapter = OllamaAdapter("http://127.0.0.1:11434")
        await adapter.health()
        manager = ResearchManager(database, adapter)
        result = await manager.interpret(f"Research how asyncio tasks are cancelled {PAGE}", MODEL)
        task_id = result["task_id"]
        assert task_id, result
        manager.approve(task_id, journal.get_task(database, task_id)["plan_digest"])
        await manager.wait_idle(task_id, timeout=480)
        detail = journal.get_detail(database, task_id)
        print(detail["task"]["status"], detail["task"]["error_code"], detail["task"]["error_detail"])
        assert detail["task"]["status"] == "awaiting_save"
        for f in detail["report"]["findings"]:
            print(f"{f['id']} {f['status']}: {f['claim']} {f['citations']} {f['reasons']}")
        out = tmp_path / "out"
        out.mkdir()
        await manager.save(task_id, str(out))
        saved = Path(journal.get_task(database, task_id)["saved_path"])
        print(f"saved {saved} ({saved.stat().st_size} bytes)")
        await adapter.aclose()

    asyncio.run(scenario())
