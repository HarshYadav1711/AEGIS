"""Voice API (Phase 5). Reached only through Electron main (bearer token).

  GET  /voice/status                       local speech engines and limits
  POST /voice/transcriptions               raw audio/wav body (16 kHz mono PCM16), header X-Aegis-Request-Id
  POST /voice/jobs/{request_id}/cancel     stop a transcription or synthesis
  POST /voice/interpret                    {text, conversation_id, low_confidence}: deterministic classification
  POST /voice/memory-corrections           {request_id, target_id, content, category, conversation_id}
  POST /voice/speech                       {request_id, text, voice, rate} -> audio/wav

The recording is decoded in memory and discarded after transcription; it is
never written to disk or logged. Interpretation never writes anything. A
spoken correction is applied only by this explicit call (a click in the app),
through the same revision function as the memory panel. No voice endpoint can
approve a plan, run a tool or delete memory.
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field

from app.agents import voice_commands
from app.agents.voice import VoiceBusy, VoiceManager
from app.memory import adaptive as memory
from app.models import stt, tts

router = APIRouter(prefix="/voice")

MAX_INTERPRET_CHARS = 2000
_CATEGORY_LABEL = {
    "explicit_correction": "explicit correction",
    "project_exception": "narrowed to an exception",
    "temporary": "temporary instruction applied permanently by the user",
    "transcription_doubt": "low-confidence transcript checked by the user",
}


class InterpretRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: Annotated[str, Field(min_length=1, max_length=MAX_INTERPRET_CHARS)]
    conversation_id: uuid.UUID | None = None
    low_confidence: bool = False


class CorrectionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: uuid.UUID
    target_id: uuid.UUID
    content: Annotated[str, Field(min_length=1, max_length=memory.MAX_CONTENT)]
    category: Literal["explicit_correction", "project_exception", "temporary", "transcription_doubt"]
    conversation_id: uuid.UUID | None = None


class SpeechRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: uuid.UUID
    text: Annotated[str, Field(min_length=1, max_length=100_000)]
    voice: Annotated[str | None, Field(max_length=80)] = None
    rate: Annotated[int, Field(ge=-10, le=10)] = 0


def _manager(request: Request) -> VoiceManager:
    manager: VoiceManager | None = request.app.state.voice
    if manager is None:
        raise HTTPException(503, detail="voice_unavailable")
    return manager


def _db(request: Request) -> Path:
    if request.app.state.database_init is None:
        raise HTTPException(503, detail="database_unavailable")
    return request.app.state.settings.database_path


def _fact(path: Path, fact: memory.Fact | None) -> dict[str, Any] | None:
    return memory.describe(path, fact.id) if fact is not None else None


@router.get("/status")
async def status(request: Request) -> dict[str, Any]:
    manager = _manager(request)
    recognizer = await manager.stt_status_async()
    speech = await manager.tts_status()
    return {
        "stt": {"engine": recognizer.engine, "model": recognizer.model, "available": recognizer.available,
                "detail": recognizer.detail},
        "tts": {"engine": speech.engine, "available": speech.available, "detail": speech.detail,
                "voices": speech.voices},
        "limits": {"sample_rate": stt.SAMPLE_RATE, "max_seconds": stt.MAX_AUDIO_SECONDS,
                   "max_speak_chars": tts.MAX_SPEAK_CHARS},
    }


async def _read_body(request: Request, limit: int) -> bytes:
    declared = request.headers.get("content-length")
    if declared is not None and (not declared.isdigit() or int(declared) > limit):
        raise HTTPException(413, detail="audio_too_long")
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            raise HTTPException(413, detail="audio_too_long")
        chunks.append(chunk)
    return b"".join(chunks)


@router.post("/transcriptions")
async def transcribe(
    request: Request, x_aegis_request_id: Annotated[uuid.UUID, Header()],
) -> dict[str, Any]:
    manager = _manager(request)
    if request.headers.get("content-type", "").split(";")[0].strip() != "audio/wav":
        raise HTTPException(415, detail="invalid_audio")
    body = await _read_body(request, stt.MAX_WAV_BYTES)
    try:
        audio = stt.decode_wav(body)
        del body  # the encoded recording is not kept
        result = await manager.transcribe(str(x_aegis_request_id), audio)
    except stt.SttError as error:
        code = {"audio_too_long": 413, "invalid_audio": 422, "audio_too_short": 422, "cancelled": 409,
                "stt_unavailable": 503}.get(error.code, 500)
        raise HTTPException(code, detail=error.code) from None
    except VoiceBusy as error:
        raise HTTPException(409, detail=str(error)) from None
    return {
        "request_id": str(x_aegis_request_id),
        "status": result.status,
        "text": result.text,
        "audio_ms": result.audio_ms,
        "processing_ms": result.processing_ms,
        "engine": result.engine,
        "model": result.model,
        "low_confidence": result.low_confidence,
    }


@router.post("/jobs/{request_id}/cancel")
def cancel(request_id: uuid.UUID, request: Request) -> dict[str, Any]:
    return {"cancel_requested": _manager(request).cancel(str(request_id))}


@router.post("/interpret")
def interpret(body: InterpretRequest, request: Request) -> dict[str, Any]:
    path = _db(request)
    result = voice_commands.interpret(
        path, body.text, conversation_id=str(body.conversation_id) if body.conversation_id else None,
        low_confidence=body.low_confidence,
    )
    return {
        "kind": result.kind,
        "text": result.text,
        "review_required": result.review_required,
        "reason": result.reason,
        "category": result.category,
        "body": result.body,
        "target": _fact(path, result.target),
        "candidates": [memory.describe(path, f.id) for f in result.candidates],
        "proposed_content": result.proposed_content,
        "conflict": _fact(path, result.conflict),
    }


@router.post("/memory-corrections")
def apply_correction(body: CorrectionRequest, request: Request) -> dict[str, Any]:
    path = _db(request)
    manager = _manager(request)
    recognizer = manager.stt_status()
    source = memory.VoiceSource(
        request_id=str(body.request_id),
        conversation_id=str(body.conversation_id) if body.conversation_id else None,
        detail=f"{_CATEGORY_LABEL[body.category]}; transcribed locally by {recognizer.engine} {recognizer.model} "
               "and confirmed in the app.",
    )
    try:
        fact = memory.correct(path, str(body.target_id), body.content, voice=source)
    except memory.MemoryError as error:
        status_code = {"memory_not_found": 404, "secret_detected": 422, "empty_memory": 422,
                       "memory_too_long": 422}.get(error.code, 409)
        raise HTTPException(status_code, detail=error.code) from None
    return {"memory": memory.describe(path, fact.id)}


@router.post("/speech")
async def speech(body: SpeechRequest, request: Request) -> Response:
    manager = _manager(request)
    try:
        result = await manager.synthesize(str(body.request_id), body.text, body.voice, body.rate)
    except tts.TtsError as error:
        code = {"nothing_to_say": 422, "unknown_voice": 422, "cancelled": 409, "tts_unavailable": 503,
                "tts_timeout": 504}.get(error.code, 500)
        raise HTTPException(code, detail=error.code) from None
    except VoiceBusy as error:
        raise HTTPException(409, detail=str(error)) from None
    return Response(
        content=result.wav,
        media_type="audio/wav",
        headers={
            "X-Aegis-Voice": result.voice,
            "X-Aegis-Synthesis-Ms": str(result.synthesis_ms),
            "X-Aegis-Audio-Ms": str(result.audio_ms),
            "X-Aegis-Spoken-Chars": str(result.spoken_chars),
            "X-Aegis-Truncated": "1" if result.truncated else "0",
        },
    )
