"""Ollama-compatible local adapter (POST /api/chat NDJSON stream, GET /api/tags).

Only loopback endpoints are accepted: Phase 1 never sends conversation text
off the machine. Remote/hosted providers need their own opt-in adapter.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from typing import Any
from urllib.parse import urlsplit

import httpx

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

log = logging.getLogger("aegis.models.ollama")

DEFAULT_BASE_URL = "http://127.0.0.1:11434"
# Literal addresses only: a name such as "localhost" could be re-pointed by a hosts-file entry.
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1"})
MAX_MODELS_REPORTED = 50
MAX_LINE_BYTES = 1_000_000
MAX_ERROR_DETAIL = 300
# Reasoning models spend tokens on a hidden trace before answering; give them room for both.
THINKING_TOKEN_BUDGET = 4096


def validate_base_url(raw: str) -> str:
    parts = urlsplit(raw)
    if parts.scheme != "http" or parts.hostname not in LOOPBACK_HOSTS or parts.path not in ("", "/"):
        raise ValueError("Ollama base URL must be http://127.0.0.1:<port> (loopback only, no path).")
    if parts.username or parts.password or parts.query or parts.fragment:
        raise ValueError("Ollama base URL must not contain credentials, query or fragment.")
    return raw.rstrip("/")


def _short(text: str) -> str:
    text = " ".join(text.split())
    return text if len(text) <= MAX_ERROR_DETAIL else text[: MAX_ERROR_DETAIL - 1] + "…"


def _provider_message(response_text: str) -> str:
    try:
        payload = json.loads(response_text)
        if isinstance(payload, dict) and isinstance(payload.get("error"), str):
            return _short(payload["error"])
    except ValueError:
        pass
    return _short(response_text) or "no error body"


def _optional_int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


class OllamaAdapter:
    provider_id = "ollama"
    is_local = True  # validate_base_url accepts loopback literals only

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        *,
        connect_timeout: float = 3.0,
        read_timeout: float = 180.0,
        health_timeout: float = 2.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.base_url = validate_base_url(base_url)
        self._timeout = httpx.Timeout(connect=connect_timeout, read=read_timeout, write=10.0, pool=5.0)
        self._health_timeout = httpx.Timeout(health_timeout)
        # trust_env=False: never route loopback traffic through a system proxy.
        self._client = httpx.AsyncClient(base_url=self.base_url, transport=transport, trust_env=False)
        self._thinking_models: set[str] = set()

    async def aclose(self) -> None:
        await self._client.aclose()

    async def health(self) -> ProviderHealth:
        try:
            response = await self._client.get("/api/tags", timeout=self._health_timeout)
        except httpx.TimeoutException:
            return ProviderHealth(self.provider_id, False, f"Ollama at {self.base_url} did not answer in time.")
        except httpx.TransportError:
            return ProviderHealth(
                self.provider_id, False, f"Ollama is not reachable at {self.base_url}. Is it running?"
            )
        if response.status_code != 200:
            return ProviderHealth(self.provider_id, False, f"Ollama /api/tags returned HTTP {response.status_code}.")
        try:
            models = self._parse_models(response.json())
        except (ValueError, TypeError):
            return ProviderHealth(self.provider_id, False, "Ollama returned a model list that does not match its API.")
        self._thinking_models = {m.name for m in models if "thinking" in m.capabilities}
        detail = f"{len(models)} local model(s) installed." if models else "Ollama is running but has no models installed."
        return ProviderHealth(self.provider_id, True, detail, models=models)

    @staticmethod
    def _parse_models(payload: Any) -> tuple[ModelInfo, ...]:
        if not isinstance(payload, dict) or not isinstance(payload.get("models"), list):
            raise ValueError("missing models list")
        models: list[ModelInfo] = []
        for entry in payload["models"][:MAX_MODELS_REPORTED]:
            if not isinstance(entry, dict) or not isinstance(entry.get("name"), str):
                raise ValueError("model entry without name")
            details = entry.get("details") if isinstance(entry.get("details"), dict) else {}
            size = details.get("parameter_size")
            caps = entry.get("capabilities")
            models.append(
                ModelInfo(
                    name=entry["name"],
                    parameter_size=size if isinstance(size, str) else None,
                    capabilities=tuple(c for c in caps if isinstance(c, str)) if isinstance(caps, list) else (),
                )
            )
        return tuple(models)

    async def stream_chat(
        self, model: str, messages: list[ChatMessage], options: GenerationOptions
    ) -> AsyncIterator[StreamItem]:
        body: dict[str, Any] = {
            "model": model,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "stream": True,
            "options": {"num_predict": options.max_output_tokens, "temperature": options.temperature},
        }
        if options.json_schema is not None:
            body["format"] = options.json_schema
        if options.context_tokens is not None:
            body["options"]["num_ctx"] = options.context_tokens
        if model in self._thinking_models and not options.allow_reasoning:
            body["think"] = False
        elif model in self._thinking_models:
            # Some reasoning models cannot switch reasoning off (with think=false it leaks into the
            # answer). Ask Ollama to return it separately; the trace is discarded, never shown or stored.
            body["think"] = True
            body["options"]["num_predict"] = max(options.max_output_tokens, THINKING_TOKEN_BUDGET)

        try:
            async with self._client.stream("POST", "/api/chat", json=body, timeout=self._timeout) as response:
                if response.status_code != 200:
                    text = (await response.aread()).decode("utf-8", "replace")
                    message = _provider_message(text)
                    if response.status_code == 404:
                        raise ProviderError("model_not_found", f"Ollama does not have model '{model}': {message}")
                    raise ProviderError("provider_error", f"Ollama returned HTTP {response.status_code}: {message}")
                async for item in self._parse_stream(response, model):
                    yield item
        except httpx.TimeoutException as error:
            kind = "connect" if isinstance(error, httpx.ConnectTimeout) else "response"
            raise ProviderError("timeout", f"Ollama {kind} timed out.") from None
        except httpx.TransportError:
            raise ProviderError(
                "provider_unavailable", f"Lost or could not open the connection to Ollama at {self.base_url}."
            ) from None

    async def _parse_stream(self, response: httpx.Response, requested_model: str) -> AsyncIterator[StreamItem]:
        produced_text = False
        async for line in response.aiter_lines():
            if not line.strip():
                continue
            if len(line) > MAX_LINE_BYTES:
                raise ProviderError("invalid_response", "Ollama sent an oversized stream line.")
            try:
                chunk = json.loads(line)
            except ValueError:
                raise ProviderError("invalid_response", "Ollama sent a stream line that is not JSON.") from None
            if not isinstance(chunk, dict):
                raise ProviderError("invalid_response", "Ollama sent a stream item that is not an object.")
            if "error" in chunk:
                raise ProviderError("provider_error", f"Ollama reported: {_short(str(chunk['error']))}")

            message = chunk.get("message")
            if message is not None:
                if not isinstance(message, dict) or not isinstance(message.get("content", ""), str):
                    raise ProviderError("invalid_response", "Ollama sent a message without text content.")
                if not isinstance(message.get("thinking", ""), str):
                    raise ProviderError("invalid_response", "Ollama sent a malformed reasoning field.")
                text = message.get("content", "")
                if text:
                    produced_text = True
                    yield TextDelta(text)

            done = chunk.get("done")
            if done is True:
                if not produced_text:
                    if chunk.get("done_reason") == "length":
                        raise ProviderError(
                            "empty_response", "The model used its whole output budget before writing an answer."
                        )
                    raise ProviderError("empty_response", "The model finished without producing any text.")
                reported_model = chunk.get("model")
                yield GenerationResult(
                    provider=self.provider_id,
                    # Record what the provider says it ran; fall back to what was requested.
                    model=reported_model if isinstance(reported_model, str) and reported_model else requested_model,
                    finish_reason=chunk.get("done_reason") if isinstance(chunk.get("done_reason"), str) else None,
                    prompt_tokens=_optional_int(chunk.get("prompt_eval_count")),
                    completion_tokens=_optional_int(chunk.get("eval_count")),
                    extra={
                        k: v
                        for k in ("total_duration", "load_duration", "eval_duration")
                        if (v := _optional_int(chunk.get(k))) is not None
                    },
                )
                return
            if done is not False:
                raise ProviderError("invalid_response", "Ollama stream item is missing its 'done' flag.")
        raise ProviderError("invalid_response", "Ollama closed the stream before signalling completion.")
