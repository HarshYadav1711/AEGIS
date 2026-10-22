"""Conversation API.

  GET  /models                                   live provider status and installed models
  GET  /conversations                            list, most recently updated first
  POST /conversations                            create an empty conversation
  GET  /conversations/{id}                       conversation with all messages
  POST /conversations/{id}/messages              send a prompt; NDJSON event stream
  POST /generations/{assistant_message_id}/cancel  stop an in-flight reply

Stream events (one JSON object per line):
  accepted  {user_message, assistant_message}   rows persisted before the provider is called
  streaming {message_id}                        first text arrived
  delta     {message_id, text}
  complete | failed | cancelled  {message[, error]}   terminal, exactly once, already persisted
A retried request with the same client_request_id replays `accepted` plus the
stored terminal event instead of generating a second reply.
"""

from __future__ import annotations

import json
import re
import uuid
from collections.abc import AsyncIterator
from dataclasses import asdict
from typing import Annotated, Any, Literal

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.agents.chat import GenerationManager
from app.memory import conversations as store
from app.models.base import ModelAdapter

router = APIRouter()

MAX_PROMPT_CHARS = 8000
MODEL_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")


class SendMessageRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=False)

    client_request_id: uuid.UUID
    content: Annotated[str, Field(min_length=1, max_length=MAX_PROMPT_CHARS)]
    model: Annotated[str, Field(min_length=1, max_length=128)]
    # Provenance only: a spoken message is still an ordinary message and gains no authority.
    input_mode: Literal["text", "voice"] = "text"

    @field_validator("content")
    @classmethod
    def not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("content must not be blank")
        if "\x00" in value:
            raise ValueError("content must not contain NUL characters")
        return value

    @field_validator("model")
    @classmethod
    def model_name(cls, value: str) -> str:
        if not MODEL_NAME.fullmatch(value):
            raise ValueError("model name contains unsupported characters")
        return value


class ModelOut(BaseModel):
    name: str
    parameter_size: str | None


class ProviderStatusOut(BaseModel):
    provider: str
    base_url: str
    reachable: bool
    detail: str
    models: list[ModelOut]


def _manager(request: Request) -> GenerationManager:
    manager: GenerationManager | None = request.app.state.generations
    if manager is None:
        raise HTTPException(503, detail="database_unavailable")
    return manager


def _db(request: Request):  # type: ignore[no-untyped-def]
    if request.app.state.database_init is None:
        raise HTTPException(503, detail="database_unavailable")
    return request.app.state.settings.database_path


def message_json(message: store.Message) -> dict[str, Any]:
    return asdict(message)


def _line(event: dict[str, Any]) -> bytes:
    payload = {k: (message_json(v) if isinstance(v, store.Message) else v) for k, v in event.items()}
    return (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")


@router.get("/models", response_model=ProviderStatusOut)
async def models(request: Request) -> ProviderStatusOut:
    adapter: ModelAdapter = request.app.state.adapter
    health = await adapter.health()
    request.app.state.provider_health = health
    return ProviderStatusOut(
        provider=health.provider,
        base_url=getattr(adapter, "base_url", ""),
        reachable=health.reachable,
        detail=health.detail,
        models=[ModelOut(name=m.name, parameter_size=m.parameter_size) for m in health.models],
    )


@router.get("/conversations")
def list_conversations(request: Request) -> dict[str, Any]:
    return {"conversations": [asdict(c) for c in store.list_conversations(_db(request))]}


@router.post("/conversations", status_code=201)
def create_conversation(request: Request) -> dict[str, Any]:
    return {"conversation": asdict(store.create_conversation(_db(request)))}


@router.get("/conversations/{conversation_id}")
def get_conversation(conversation_id: uuid.UUID, request: Request) -> dict[str, Any]:
    try:
        conversation, messages = store.get_conversation(_db(request), str(conversation_id))
    except store.NotFound:
        raise HTTPException(404, detail="conversation_not_found") from None
    return {"conversation": asdict(conversation), "messages": [message_json(m) for m in messages]}


@router.post("/conversations/{conversation_id}/messages")
async def send_message(conversation_id: uuid.UUID, body: SendMessageRequest, request: Request) -> StreamingResponse:
    path = _db(request)
    manager = _manager(request)
    convo_id, request_id = str(conversation_id), str(body.client_request_id)

    existing = store.find_turn(path, request_id)
    if existing is not None:
        if existing.user.conversation_id != convo_id:
            raise HTTPException(409, detail="request_id_reused")
        if existing.assistant.status not in store.TERMINAL_STATUSES:
            raise HTTPException(409, detail="generation_in_progress")
        return _stream(_replay(existing))

    try:
        turn = store.start_turn(path, convo_id, request_id, body.content, body.model, body.input_mode)
    except store.NotFound:
        raise HTTPException(404, detail="conversation_not_found") from None
    except store.GenerationInProgress:
        raise HTTPException(409, detail="generation_in_progress") from None
    except store.RequestIdConflict:
        raise HTTPException(409, detail="request_id_reused") from None

    generation = manager.start(turn)

    async def relay() -> AsyncIterator[bytes]:
        yield _line({"type": "accepted", "user_message": turn.user, "assistant_message": turn.assistant})
        try:
            async for event in generation.events():
                yield _line(event)
        finally:
            # Reached early only if the client went away: the reply cannot be delivered.
            generation.cancel("disconnect")

    return _stream(relay())


async def _replay(turn: store.Turn) -> AsyncIterator[bytes]:
    yield _line({"type": "accepted", "user_message": turn.user, "assistant_message": turn.assistant, "replay": True})
    terminal: dict[str, Any] = {"type": turn.assistant.status, "message": turn.assistant, "replay": True}
    if turn.assistant.status == "failed":
        terminal["error"] = {"code": turn.assistant.error_code, "detail": turn.assistant.error_detail}
    yield _line(terminal)


def _stream(body: AsyncIterator[bytes]) -> StreamingResponse:
    return StreamingResponse(body, media_type="application/x-ndjson", headers={"X-Accel-Buffering": "no"})


@router.post("/generations/{message_id}/cancel")
async def cancel_generation(message_id: uuid.UUID, request: Request) -> dict[str, Any]:
    path = _db(request)
    manager = _manager(request)
    cancelled = await manager.cancel(str(message_id), "user")
    try:
        message = store.get_message(path, str(message_id))
    except store.NotFound:
        raise HTTPException(404, detail="message_not_found") from None
    if not cancelled and message.status not in store.TERMINAL_STATUSES:  # pragma: no cover - defensive
        raise HTTPException(409, detail="generation_not_tracked")
    return {"cancel_requested": cancelled, "message": message_json(message)}
