"""REAL model memory tests. Skipped unless AEGIS_LIVE_MODEL names an installed Ollama model, e.g.

    $env:AEGIS_LIVE_MODEL = 'qwen3:4b'; .venv\\Scripts\\python -m pytest tests/test_memory_live.py -s

A skip means NOT CONFIGURED, never PASS. The model's text is printed so a human can judge it;
assertions check only what the store and the reply actually contain.
"""

from __future__ import annotations

import asyncio
import os
import time
import uuid

import pytest
from fastapi.testclient import TestClient

from app.agents import memory_extract
from app.config import Settings
from app.memory import adaptive as memory
from app.models.ollama import OllamaAdapter
from app.server import create_app

MODEL = os.environ.get("AEGIS_LIVE_MODEL", "").strip()
pytestmark = pytest.mark.skipif(not MODEL, reason="NOT CONFIGURED: set AEGIS_LIVE_MODEL to run a real Ollama request")


def test_real_extraction_matches_the_contract() -> None:
    async def scenario() -> list[tuple[str, str | None, str]]:
        adapter = OllamaAdapter()
        try:
            assert (await adapter.health()).reachable  # as the app does at startup: learns which models reason
            return await memory_extract.extract(
                adapter, MODEL, "From now on I prefer short answers with one code example, and call me Captain."
            )
        finally:
            await adapter.aclose()

    started = time.monotonic()
    found = asyncio.run(scenario())
    print(f"\n[{MODEL}] {time.monotonic() - started:.1f}s candidates={found}")
    assert 1 <= len(found) <= memory_extract.MAX_CANDIDATES
    assert all(kind in ("fact", "preference", "inference") and content for kind, _, content in found)


def _reply(client: TestClient, headers: dict[str, str], convo: str, text: str) -> str:
    body = {"client_request_id": str(uuid.uuid4()), "content": text, "model": MODEL}
    with client.stream("POST", f"/conversations/{convo}/messages", json=body, headers=headers) as response:
        lines = [line for line in response.iter_lines() if line]
    import json

    final = json.loads(lines[-1])
    assert final["type"] == "complete", final
    return final["message"]["content"]


def test_real_remember_restart_recall_correct_recall(tmp_path) -> None:  # type: ignore[no-untyped-def]
    settings = Settings(data_dir=tmp_path / "data", session_token="t" * 64)
    headers = {"Authorization": f"Bearer {settings.session_token}"}
    question = "What is my test folder name? Answer with the name only."

    with TestClient(create_app(settings), base_url="http://127.0.0.1:8765") as first:
        convo = first.post("/conversations", headers=headers).json()["conversation"]["id"]
        print("\nremember ->", _reply(first, headers, convo, "Remember: my test folder name is Zephyr-42"))
    [fact] = memory.search(settings.database_path)
    assert fact["content"] == "my test folder name is Zephyr-42" and fact["status"] == "active"

    with TestClient(create_app(settings), base_url="http://127.0.0.1:8765") as second:  # restarted core
        convo = second.post("/conversations", headers=headers).json()["conversation"]["id"]
        recalled = _reply(second, headers, convo, question)
        print("recall ->", recalled)
        assert "zephyr-42" in recalled.casefold()
        second.post(f"/memory/{fact['id']}/correct", json={"content": "My test folder name is Orion-7"}, headers=headers)
        corrected = _reply(second, headers, second.post("/conversations", headers=headers).json()["conversation"]["id"],
                           question)
        print("recall after correction ->", corrected)
    assert "orion-7" in corrected.casefold() and "zephyr" not in corrected.casefold()
