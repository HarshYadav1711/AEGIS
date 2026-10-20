"""REAL model smoke test. Skipped unless AEGIS_LIVE_MODEL names an installed Ollama model, e.g.

    $env:AEGIS_LIVE_MODEL = 'llama3.2:3b'; .venv\\Scripts\\python -m pytest tests/test_ollama_live.py -s

A skip means NOT CONFIGURED, never PASS.
"""

from __future__ import annotations

import asyncio
import os
import time

import pytest

from app.models.base import ChatMessage, GenerationOptions, GenerationResult, ProviderError, TextDelta
from app.models.ollama import OllamaAdapter

MODEL = os.environ.get("AEGIS_LIVE_MODEL", "").strip()
pytestmark = pytest.mark.skipif(not MODEL, reason="NOT CONFIGURED: set AEGIS_LIVE_MODEL to run a real Ollama request")


def test_real_ollama_generates_text() -> None:
    async def scenario() -> tuple[str, GenerationResult, float]:
        adapter = OllamaAdapter()
        try:
            health = await adapter.health()
            assert health.reachable, health.detail
            assert MODEL in [m.name for m in health.models], f"{MODEL} not installed"
            started = time.monotonic()
            text, result = "", None
            messages = [ChatMessage("user", "Reply with one short sentence about the colour of the sky.")]
            async for item in adapter.stream_chat(MODEL, messages, GenerationOptions(max_output_tokens=60)):
                if isinstance(item, TextDelta):
                    text += item.text
                else:
                    result = item
            assert result is not None
            return text, result, time.monotonic() - started
        finally:
            await adapter.aclose()

    text, result, seconds = asyncio.run(scenario())
    print(f"\nLIVE {result.provider}/{result.model} in {seconds:.1f}s, {result.completion_tokens} tokens: {text!r}")
    assert text.strip()
    assert result.provider == "ollama" and result.model == MODEL


def test_real_ollama_missing_model_is_reported() -> None:
    async def scenario() -> None:
        adapter = OllamaAdapter()
        try:
            async for _ in adapter.stream_chat("aegis-definitely-missing:0b", [ChatMessage("user", "hi")], GenerationOptions()):
                pass
        finally:
            await adapter.aclose()

    with pytest.raises(ProviderError) as caught:
        asyncio.run(scenario())
    assert caught.value.code == "model_not_found"
