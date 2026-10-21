"""TEST FIXTURE ONLY — a scripted stand-in for a model provider.

Its output is fixed text written in this file, not model output. It exists so
the conversation pipeline can be tested deterministically; it is never wired
into the application at runtime.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass, field

from app.models.base import (
    ChatMessage,
    GenerationOptions,
    GenerationResult,
    ModelInfo,
    ProviderError,
    ProviderHealth,
    StreamItem,
    TextDelta,
)

FIXTURE_MODEL = "fixture-model:1b"


@dataclass
class Script:
    chunks: list[str] = field(default_factory=lambda: ["FIXTURE ", "reply"])
    error_after: ProviderError | None = None
    delay_s: float = 0.0
    # When set, the stream waits on this event after the first chunk (to exercise cancel/disconnect).
    hold: asyncio.Event | None = None


class FixtureAdapter:
    provider_id = "fixture"
    is_local = True
    base_url = "fixture://scripted"

    def __init__(self, reachable: bool = True) -> None:
        self.reachable = reachable
        self.script = Script()
        self.calls: list[tuple[str, list[ChatMessage]]] = []
        self.closed_streams = 0

    async def health(self) -> ProviderHealth:
        if not self.reachable:
            return ProviderHealth(self.provider_id, False, "fixture provider is switched off")
        return ProviderHealth(self.provider_id, True, "fixture", models=(ModelInfo(FIXTURE_MODEL, "1B"),))

    async def stream_chat(
        self, model: str, messages: list[ChatMessage], options: GenerationOptions
    ) -> AsyncIterator[StreamItem]:
        self.calls.append((model, messages))
        script = self.script
        try:
            if not self.reachable:
                raise ProviderError("provider_unavailable", "fixture provider is switched off")
            if model != FIXTURE_MODEL:
                raise ProviderError("model_not_found", f"fixture has no model '{model}'")
            for index, chunk in enumerate(script.chunks):
                if script.delay_s:
                    await asyncio.sleep(script.delay_s)
                yield TextDelta(chunk)
                if index == 0 and script.hold is not None:
                    await script.hold.wait()
            if script.error_after is not None:
                raise script.error_after
            yield GenerationResult(self.provider_id, model, "stop", prompt_tokens=3, completion_tokens=2)
        finally:
            self.closed_streams += 1
