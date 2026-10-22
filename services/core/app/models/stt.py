"""Local speech-to-text for push-to-talk (Phase 5).

Audio arrives as one in-memory WAV (16 kHz, mono, 16-bit PCM) recorded by the
renderer between the user's explicit start and stop. It is decoded here with the
standard library, transcribed on the CPU and dropped: nothing is written to disk.

The engine is faster-whisper (MIT) with a Whisper model that must already be in
the local Hugging Face cache. `local_files_only=True` is always set, so this
module never downloads a model or contacts the network; a missing model is
reported as unavailable instead.

Outcomes are honest: `silence` when the signal is too quiet or voice activity
detection finds no speech (the model is not asked to guess), `unintelligible`
when the model returns nothing usable, `ok` otherwise, with a low-confidence
flag from Whisper's own segment statistics.
"""

from __future__ import annotations

import io
import logging
import os
import threading
import time
import wave
from dataclasses import dataclass
from typing import Any, Literal

log = logging.getLogger("aegis.models.stt")

SAMPLE_RATE = 16_000
MAX_AUDIO_SECONDS = 60
MIN_AUDIO_SECONDS = 0.3
# A WAV header plus 60 s of 16 kHz mono 16-bit samples, with slack for header chunks.
MAX_WAV_BYTES = 44 + MAX_AUDIO_SECONDS * SAMPLE_RATE * 2 + 4096
# Peak below about -46 dBFS: nothing a microphone picked up from a speaker.
SILENCE_PEAK = 0.005
# Whisper segment statistics (as used by Whisper's own fallback heuristics).
LOW_LOGPROB = -0.8
NO_SPEECH = 0.6
DEFAULT_MODEL = "base.en"


class SttError(Exception):
    def __init__(self, code: str, detail: str) -> None:
        super().__init__(f"{code}: {detail}")
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class EngineStatus:
    engine: str
    model: str
    available: bool
    detail: str


@dataclass(frozen=True)
class Transcript:
    status: Literal["ok", "silence", "unintelligible"]
    text: str
    audio_ms: int
    processing_ms: int
    engine: str
    model: str
    low_confidence: bool
    avg_logprob: float | None
    no_speech_prob: float | None


@dataclass(frozen=True)
class Audio:
    samples: Any  # numpy float32 array in [-1, 1]
    duration_s: float
    peak: float


def decode_wav(data: bytes) -> Audio:
    """Strictly decode the renderer's WAV. Anything else is refused rather than guessed."""
    import numpy as np

    if len(data) > MAX_WAV_BYTES:
        raise SttError("audio_too_long", f"Recordings are limited to {MAX_AUDIO_SECONDS} s.")
    if len(data) < 44 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise SttError("invalid_audio", "The recording is not a WAV file.")
    try:
        with wave.open(io.BytesIO(data), "rb") as wav:
            if wav.getcomptype() != "NONE" or wav.getsampwidth() != 2:
                raise SttError("invalid_audio", "The recording must be 16-bit PCM.")
            if wav.getnchannels() != 1 or wav.getframerate() != SAMPLE_RATE:
                raise SttError("invalid_audio", f"The recording must be mono at {SAMPLE_RATE} Hz.")
            frames = wav.readframes(wav.getnframes())
    except (wave.Error, EOFError) as error:
        raise SttError("invalid_audio", "The WAV data is malformed.") from error
    samples = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    duration = len(samples) / SAMPLE_RATE
    if duration > MAX_AUDIO_SECONDS + 0.5:
        raise SttError("audio_too_long", f"Recordings are limited to {MAX_AUDIO_SECONDS} s.")
    if duration < MIN_AUDIO_SECONDS:
        raise SttError("audio_too_short", "The recording is too short to contain speech.")
    peak = float(np.max(np.abs(samples))) if len(samples) else 0.0
    return Audio(samples, duration, peak)


def _usable(text: str) -> bool:
    return any(ch.isalnum() for ch in text)


class FasterWhisperRecognizer:
    """faster-whisper on the CPU (int8). The model is loaded on first use and kept for the process lifetime."""

    engine = "faster-whisper"

    def __init__(self, model_name: str = DEFAULT_MODEL, cpu_threads: int = 4) -> None:
        # Belt and braces next to local_files_only: the Hugging Face client must not reach the network at all.
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
        self.model = model_name
        self._cpu_threads = cpu_threads
        self._loaded: Any = None
        self._load_lock = threading.Lock()

    def status(self) -> EngineStatus:
        try:
            from faster_whisper.utils import download_model
        except ImportError:
            return EngineStatus(self.engine, self.model, False, "faster-whisper is not installed in the core environment.")
        try:
            download_model(self.model, local_files_only=True)  # resolves the cache path only; never downloads
        except Exception:
            return EngineStatus(
                self.engine, self.model, False,
                f"Whisper model '{self.model}' is not in the local model cache (AEGIS never downloads it itself).",
            )
        state = "loaded" if self._loaded is not None else "loads on first use"
        return EngineStatus(self.engine, self.model, True, f"Local Whisper model '{self.model}' on CPU ({state}).")

    def _model(self) -> Any:
        with self._load_lock:
            if self._loaded is None:
                from faster_whisper import WhisperModel

                started = time.perf_counter()
                self._loaded = WhisperModel(
                    self.model, device="cpu", compute_type="int8", cpu_threads=self._cpu_threads,
                    local_files_only=True,
                )
                log.info("loaded whisper model %s in %.2f s", self.model, time.perf_counter() - started)
            return self._loaded

    def transcribe(self, audio: Audio, cancel: threading.Event) -> Transcript:
        started = time.perf_counter()

        def done(status: Literal["ok", "silence", "unintelligible"], text: str = "", low: bool = False,
                 logprob: float | None = None, no_speech: float | None = None) -> Transcript:
            return Transcript(status, text, int(audio.duration_s * 1000), int((time.perf_counter() - started) * 1000),
                              self.engine, self.model, low, logprob, no_speech)

        if audio.peak < SILENCE_PEAK:
            return done("silence")  # no model call for a recording that holds no signal
        try:
            model = self._model()
        except Exception as error:
            log.exception("whisper model failed to load")
            raise SttError("stt_unavailable", "The local speech model could not be loaded (see core log).") from error
        if cancel.is_set():
            raise SttError("cancelled", "Transcription was cancelled.")
        segments, _info = model.transcribe(
            audio.samples, language="en" if self.model.endswith(".en") else None, beam_size=1,
            vad_filter=True, condition_on_previous_text=False, without_timestamps=True,
        )
        texts: list[str] = []
        logprobs: list[float] = []
        no_speech: list[float] = []
        for segment in segments:  # lazy: decoding happens while iterating, so cancel is checked per segment
            if cancel.is_set():
                raise SttError("cancelled", "Transcription was cancelled.")
            texts.append(segment.text)
            logprobs.append(segment.avg_logprob)
            no_speech.append(segment.no_speech_prob)
        if cancel.is_set():
            raise SttError("cancelled", "Transcription was cancelled.")
        if not texts:
            return done("silence")  # voice activity detection found no speech
        text = " ".join(t.strip() for t in texts).strip()
        logprob = sum(logprobs) / len(logprobs)
        silent = max(no_speech)
        if not _usable(text) or (logprob < -1.0 and silent > NO_SPEECH):
            return done("unintelligible", text if _usable(text) else "", True, logprob, silent)
        return done("ok", text, logprob < LOW_LOGPROB or silent > NO_SPEECH, logprob, silent)
