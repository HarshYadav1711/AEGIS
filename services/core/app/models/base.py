"""Provider-neutral model adapter contract (ADR-005).

Every adapter reports which provider and model actually produced the output,
raises ProviderError with a stable code on failure, and never substitutes a
different model or provider on its own.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Literal, Protocol

ChatRole = Literal["system", "user", "assistant"]

ProviderErrorCode = Literal[
    "provider_unavailable",  # cannot connect to the provider at all
    "model_not_found",  # provider is up but does not have the requested model
    "timeout",  # connect / first token / inter-token / total limit exceeded
    "invalid_response",  # provider answered with something outside its contract
    "provider_error",  # provider reported an error of its own (HTTP 4xx/5xx)
    "empty_response",  # provider finished without producing any text
]


class ProviderError(Exception):
    def __init__(self, code: ProviderErrorCode, detail: str) -> None:
        super().__init__(f"{code}: {detail}")
        self.code: ProviderErrorCode = code
        self.detail = detail


@dataclass(frozen=True)
class ChatMessage:
    role: ChatRole
    content: str


@dataclass(frozen=True)
class GenerationOptions:
    max_output_tokens: int = 1024
    temperature: float = 0.7


@dataclass(frozen=True)
class ModelInfo:
    name: str
    parameter_size: str | None = None
    capabilities: tuple[str, ...] = ()


@dataclass(frozen=True)
class ProviderHealth:
    provider: str
    reachable: bool
    detail: str
    models: tuple[ModelInfo, ...] = ()
    version: str | None = None


@dataclass(frozen=True)
class TextDelta:
    text: str


@dataclass(frozen=True)
class GenerationResult:
    """Terminal metadata. Only produced after the provider signalled a normal finish."""

    provider: str
    model: str
    finish_reason: str | None
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    extra: dict[str, int] = field(default_factory=dict)


StreamItem = TextDelta | GenerationResult


class ModelAdapter(Protocol):
    provider_id: str

    async def health(self) -> ProviderHealth: ...

    def stream_chat(
        self, model: str, messages: list[ChatMessage], options: GenerationOptions
    ) -> AsyncIterator[StreamItem]:
        """Yield TextDelta items, then exactly one GenerationResult as the last item.

        Raises ProviderError on any failure. Cancellation is by cancelling the
        consuming task; the adapter must release its connection when that happens.
        """
        ...
