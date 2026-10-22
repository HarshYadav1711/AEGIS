"""Voice jobs: one transcription or synthesis per client request id, cancellable, bounded.

Speech work is CPU-bound and runs in worker threads so the event loop keeps
serving health checks and chat streams. Only one transcription runs at a time
(one push-to-talk user, one model in memory). A job is identified by the
client's request id so Electron main can cancel it; cancellation stops a
transcription between segments and kills a synthesis process. Shutdown cancels
everything. Audio and text are held only for the duration of the job.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from dataclasses import dataclass
from typing import Any

from app.models.stt import Audio, EngineStatus, FasterWhisperRecognizer, SttError, Transcript
from app.models.tts import Synthesis, TtsError, WindowsSapiSynthesizer

log = logging.getLogger("aegis.agents.voice")


@dataclass(frozen=True)
class SpeechStatus:
    engine: str
    available: bool
    detail: str
    voices: list[str]


class VoiceBusy(RuntimeError):
    pass


class VoiceManager:
    def __init__(self, recognizer: Any = None, synthesizer: Any = None) -> None:
        self.recognizer = recognizer or FasterWhisperRecognizer()
        self.synthesizer = synthesizer or WindowsSapiSynthesizer()
        self._jobs: dict[str, threading.Event] = {}
        self._stt_lock = asyncio.Lock()
        self._closed = False

    def stt_status(self) -> EngineStatus:
        return self.recognizer.status()

    async def stt_status_async(self) -> EngineStatus:
        # The first check imports the speech stack (about a second); keep it off the event loop.
        return await asyncio.to_thread(self.recognizer.status)

    async def tts_status(self) -> SpeechStatus:
        try:
            voices = await asyncio.to_thread(self.synthesizer.voices)
        except TtsError as error:
            return SpeechStatus(self.synthesizer.engine, False, error.detail, [])
        if not voices:
            return SpeechStatus(self.synthesizer.engine, False, "No Windows speech voice is installed.", [])
        return SpeechStatus(self.synthesizer.engine, True, f"Windows built-in voices ({len(voices)}).", voices)

    def _register(self, request_id: str) -> threading.Event:
        if self._closed:
            raise VoiceBusy("shutting_down")
        if request_id in self._jobs:
            raise VoiceBusy("request_in_progress")
        event = threading.Event()
        self._jobs[request_id] = event
        return event

    def cancel(self, request_id: str) -> bool:
        event = self._jobs.get(request_id)
        if event is None:
            return False
        event.set()
        return True

    async def transcribe(self, request_id: str, audio: Audio) -> Transcript:
        if self._stt_lock.locked():
            raise VoiceBusy("voice_busy")
        async with self._stt_lock:
            cancel = self._register(request_id)
            try:
                return await asyncio.to_thread(self.recognizer.transcribe, audio, cancel)
            finally:
                self._jobs.pop(request_id, None)

    async def synthesize(self, request_id: str, text: str, voice: str | None, rate: int) -> Synthesis:
        cancel = self._register(request_id)
        try:
            return await asyncio.to_thread(self.synthesizer.synthesize, text, voice, rate, cancel)
        finally:
            self._jobs.pop(request_id, None)

    async def shutdown(self) -> None:
        self._closed = True
        for event in list(self._jobs.values()):
            event.set()


__all__ = ["SttError", "TtsError", "VoiceBusy", "VoiceManager"]
