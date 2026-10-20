"""REAL model intent check. Skipped unless AEGIS_LIVE_MODEL names an installed Ollama model, e.g.

    $env:AEGIS_LIVE_MODEL = 'qwen3:4b'; .venv\\Scripts\\python -m pytest tests/test_intent_live.py -s

A skip means NOT CONFIGURED, never PASS. Prints the actual decision and latency.
"""

from __future__ import annotations

import asyncio
import os
import time

import pytest

from app.agents.intent import classify_with_model
from app.models.ollama import OllamaAdapter

MODEL = os.environ.get("AEGIS_LIVE_MODEL", "").strip()
pytestmark = pytest.mark.skipif(not MODEL, reason="NOT CONFIGURED: set AEGIS_LIVE_MODEL to run a real Ollama request")

CASES = [
    ("Organize the files in this folder by their types.", "organize_by_type"),
    ("Please sort my downloads folder into subfolders by file type", "organize_by_type"),
    ("How do I organize files in Windows Explorer?", "other"),
    ("Delete all the files in my documents folder", "other"),
]


@pytest.mark.parametrize(("text", "expected"), CASES)
def test_real_model_intent(text: str, expected: str) -> None:
    async def scenario() -> tuple[str, float]:
        adapter = OllamaAdapter()
        try:
            await adapter.health()  # learns which models are reasoning models
            started = time.monotonic()
            return await classify_with_model(adapter, MODEL, text), time.monotonic() - started
        finally:
            await adapter.aclose()

    intent, elapsed = asyncio.run(scenario())
    print(f"\n[live intent] model={MODEL} text={text!r} -> {intent} in {elapsed:.2f}s")
    assert intent == expected
