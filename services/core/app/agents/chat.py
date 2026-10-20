"""One chat turn: context assembly, provider streaming, persistence of the terminal state.

A generation runs as its own asyncio task that owns all database writes for
the reply, and publishes events to a queue that the HTTP response relays.
Cancelling the task (user Stop, client disconnect, shutdown) closes the
provider connection and records an honest non-success status.

This is deliberately a plain bounded function rather than a graph: Phase 1
has no tools. When Phase 2 introduces plan→approve→act→verify, LangGraph
replaces `run_turn` behind the same GenerationManager interface.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from app.memory import conversations as store
from app.models.base import (
    ChatMessage,
    GenerationOptions,
    GenerationResult,
    ModelAdapter,
    ProviderError,
    TextDelta,
)

log = logging.getLogger("aegis.agents.chat")

SYSTEM_PROMPT = (
    "You are AEGIS, a helpful assistant running locally on the user's computer. "
    "Help with any text task: answering questions, explaining, writing stories or code, and brainstorming. "
    "You have no tools in this chat: you cannot open or change files, browse the web, run programs, "
    "or act on the computer. Only if the user asks for one of those actions, say you cannot do it here, "
    "and never claim to have done it. AEGIS has one separate, user-approved file tool that you do not control: "
    "if the user wants files sorted, suggest they ask \"Organize the files in a folder by type\"."
)
HISTORY_LIMIT = 20
TOTAL_TIMEOUT_S = 300.0
MAX_OUTPUT_CHARS = 100_000

CancelReason = Literal["user", "disconnect", "shutdown"]


@dataclass
class Generation:
    message_id: str
    conversation_id: str
    queue: asyncio.Queue[dict[str, Any] | None] = field(default_factory=asyncio.Queue)
    task: asyncio.Task[None] | None = None
    cancel_reason: CancelReason | None = None

    def cancel(self, reason: CancelReason) -> None:
        if self.task and not self.task.done():
            self.cancel_reason = self.cancel_reason or reason
            self.task.cancel()

    async def events(self) -> AsyncIterator[dict[str, Any]]:
        while (event := await self.queue.get()) is not None:
            yield event


class GenerationManager:
    def __init__(
        self,
        database_path: Path,
        adapter: ModelAdapter,
        *,
        options: GenerationOptions | None = None,
        total_timeout_s: float = TOTAL_TIMEOUT_S,
    ) -> None:
        self._db = database_path
        self._adapter = adapter
        self._options = options or GenerationOptions()
        self._total_timeout_s = total_timeout_s
        self._active: dict[str, Generation] = {}

    def get(self, message_id: str) -> Generation | None:
        return self._active.get(message_id)

    def start(self, turn: store.Turn) -> Generation:
        generation = Generation(message_id=turn.assistant.id, conversation_id=turn.assistant.conversation_id)
        self._active[generation.message_id] = generation
        generation.task = asyncio.create_task(self._run(generation, turn), name=f"generation-{generation.message_id}")
        return generation

    async def cancel(self, message_id: str, reason: CancelReason, wait_s: float = 5.0) -> bool:
        generation = self._active.get(message_id)
        if generation is None or generation.task is None:
            return False
        generation.cancel(reason)
        await asyncio.wait({generation.task}, timeout=wait_s)
        return True

    async def shutdown(self) -> None:
        for message_id in list(self._active):
            await self.cancel(message_id, "shutdown")

    def _context(self, turn: store.Turn) -> list[ChatMessage]:
        prior = store.history(self._db, turn.user.conversation_id, before_seq=turn.user.seq, limit=HISTORY_LIMIT)
        return [
            ChatMessage("system", SYSTEM_PROMPT),
            *(ChatMessage(m.role, m.content) for m in prior),
            ChatMessage("user", turn.user.content),
        ]

    async def _run(self, generation: Generation, turn: store.Turn) -> None:
        message_id = turn.assistant.id
        model = turn.assistant.model or ""
        provider = self._adapter.provider_id
        started = time.monotonic()
        parts: list[str] = []
        size = 0
        result: GenerationResult | None = None

        def elapsed_ms() -> int:
            return int((time.monotonic() - started) * 1000)

        def finish(status: Literal["complete", "failed", "cancelled"], **fields: Any) -> None:
            message = store.finish_message(
                self._db,
                message_id,
                status=status,
                content="".join(parts),
                provider=provider,
                model=model,
                duration_ms=elapsed_ms(),
                **fields,
            )
            event: dict[str, Any] = {"type": status, "message": message}
            if status == "failed":
                event["error"] = {"code": message.error_code, "detail": message.error_detail}
            generation.queue.put_nowait(event)

        try:
            async with asyncio.timeout(self._total_timeout_s):
                async for item in self._adapter.stream_chat(model, self._context(turn), self._options):
                    if isinstance(item, TextDelta):
                        if not parts:
                            store.mark_streaming(self._db, message_id, provider)
                            generation.queue.put_nowait({"type": "streaming", "message_id": message_id})
                        size += len(item.text)
                        if size > MAX_OUTPUT_CHARS:
                            raise ProviderError("invalid_response", "The reply exceeded the output size limit.")
                        parts.append(item.text)
                        generation.queue.put_nowait({"type": "delta", "message_id": message_id, "text": item.text})
                    else:
                        result = item
            if result is None:
                raise ProviderError("invalid_response", "The provider stream ended without a completion record.")
            model = result.model
            finish(
                "complete",
                finish_reason=result.finish_reason,
                prompt_tokens=result.prompt_tokens,
                completion_tokens=result.completion_tokens,
            )
        except ProviderError as error:
            finish("failed", error_code=error.code, error_detail=error.detail)
        except TimeoutError:
            finish(
                "failed",
                error_code="timeout",
                error_detail=f"The reply did not finish within {int(self._total_timeout_s)} s.",
            )
        except asyncio.CancelledError:
            if generation.cancel_reason == "user":
                finish("cancelled", error_code="cancelled", error_detail="Stopped by the user.")
            else:
                finish(
                    "failed",
                    error_code="interrupted",
                    error_detail="The request was interrupted before the reply finished"
                    + (" (the core is shutting down)." if generation.cancel_reason == "shutdown" else "."),
                )
            # Swallow: this task is the owner of the reply and has recorded its fate.
        except Exception:
            log.exception("generation %s failed unexpectedly", message_id)
            finish("failed", error_code="internal_error", error_detail="Unexpected error in the core (see core log).")
        finally:
            self._active.pop(message_id, None)
            generation.queue.put_nowait(None)
