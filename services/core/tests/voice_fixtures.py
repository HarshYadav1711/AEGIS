"""TEST FIXTURES ONLY — scripted stand-ins for the local speech engines, and WAV builders.

The fixture recognizer returns text written in this file, not a transcription;
the fixture synthesizer returns generated silence, not speech. They exist so the
voice API, memory integration and lifecycle can be tested deterministically.
Real engine behaviour is covered separately in test_voice_engines.py.
"""

from __future__ import annotations

import io
import math
import threading
import wave
from dataclasses import dataclass, field

from app.models.stt import SAMPLE_RATE, Audio, EngineStatus, SttError, Transcript
from app.models.tts import Synthesis, TtsError, _wav

FIXTURE_TEXT = "FIXTURE transcript"


def wav_bytes(samples: list[float] | None = None, *, seconds: float = 1.0, rate: int = SAMPLE_RATE,
              channels: int = 1, width: int = 2, tone: float = 0.3) -> bytes:
    """A WAV in the renderer's format: a 440 Hz tone of `tone` amplitude unless samples are given."""
    if samples is None:
        samples = [tone * math.sin(2 * math.pi * 440 * i / rate) for i in range(int(seconds * rate))]
    out = io.BytesIO()
    with wave.open(out, "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(width)
        wav.setframerate(rate)
        if width == 2:
            frames = b"".join(int(max(-1, min(1, s)) * 32767).to_bytes(2, "little", signed=True)
                              for s in samples for _ in range(channels))
        else:
            frames = bytes(len(samples) * channels * width)
        wav.writeframes(frames)
    return out.getvalue()


@dataclass
class FixtureRecognizer:
    engine: str = "fixture-stt"
    model: str = "fixture"
    text: str = FIXTURE_TEXT
    status_value: str = "ok"
    low_confidence: bool = False
    available: bool = True
    # When set, transcription blocks until released or cancelled (to exercise cancel and shutdown).
    hold: threading.Event | None = None
    started: threading.Event = field(default_factory=threading.Event)
    calls: int = 0

    def status(self) -> EngineStatus:
        return EngineStatus(self.engine, self.model, self.available, "fixture recognizer")

    def transcribe(self, audio: Audio, cancel: threading.Event) -> Transcript:
        self.calls += 1
        self.started.set()
        if not self.available:
            raise SttError("stt_unavailable", "fixture recognizer is switched off")
        while self.hold is not None and not self.hold.is_set():
            if cancel.wait(0.02):
                break
        if cancel.is_set():
            raise SttError("cancelled", "Transcription was cancelled.")
        text = self.text if self.status_value == "ok" else ""
        return Transcript(self.status_value, text, int(audio.duration_s * 1000), 5, self.engine, self.model,  # type: ignore[arg-type]
                          self.low_confidence, -0.2, 0.01)


@dataclass
class FixtureSynthesizer:
    engine: str = "fixture-tts"
    hold: threading.Event | None = None
    started: threading.Event = field(default_factory=threading.Event)
    texts: list[str] = field(default_factory=list)

    def voices(self) -> list[str]:
        return ["Fixture Voice"]

    def synthesize(self, text: str, voice: str | None, rate: int, cancel: threading.Event) -> Synthesis:
        self.started.set()
        if voice not in (None, "Fixture Voice"):
            raise TtsError("unknown_voice", "That voice is not installed.")
        if not text.strip():
            raise TtsError("nothing_to_say", "There is no readable text to speak.")
        while self.hold is not None and not self.hold.is_set():
            if cancel.wait(0.02):
                break
        if cancel.is_set():
            raise TtsError("cancelled", "Speech synthesis was cancelled.")
        self.texts.append(text)
        pcm = bytes(2 * 2205)  # 0.1 s of silence
        return Synthesis(_wav(pcm), "Fixture Voice", 1, 100, len(text), False)
