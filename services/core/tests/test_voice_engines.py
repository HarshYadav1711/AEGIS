"""The REAL local speech engines (no fixtures): Windows SAPI synthesis and faster-whisper transcription.

These run only where the engines exist (Windows with System.Speech, and the Whisper
model already in the local cache); elsewhere they are SKIPPED, which is not a pass.
Speech for the recognizer is produced by the real synthesizer and resampled to the
renderer's 16 kHz format, so the round trip exercises both engines end to end. It
is synthetic speech, not a microphone recording; the microphone path is verified
in the desktop app.
"""

from __future__ import annotations

import io
import sys
import threading
import time
import wave

import numpy as np
import pytest

from app.models import stt, tts

recognizer = stt.FasterWhisperRecognizer()
pytestmark = [
    pytest.mark.skipif(sys.platform != "win32", reason="Windows speech synthesis only"),
    pytest.mark.skipif(not recognizer.status().available, reason="Whisper model not in the local cache"),
]


def _to_16k(wav_bytes: bytes) -> stt.Audio:
    with wave.open(io.BytesIO(wav_bytes)) as wav:
        rate = wav.getframerate()
        samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").astype(np.float32) / 32768
    positions = np.arange(0, len(samples), rate / stt.SAMPLE_RATE)
    resampled = np.interp(positions, np.arange(len(samples)), samples).astype(np.float32)
    out = io.BytesIO()
    with wave.open(out, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(stt.SAMPLE_RATE)
        wav.writeframes((np.clip(resampled, -1, 1) * 32767).astype("<i2").tobytes())
    return stt.decode_wav(out.getvalue())


def _speak(text: str) -> bytes:
    return tts.WindowsSapiSynthesizer().synthesize(text, None, 0, threading.Event()).wav


def test_sapi_lists_voices_and_synthesizes_a_wav() -> None:
    synth = tts.WindowsSapiSynthesizer()
    voices = synth.voices()
    assert voices, "no Windows voice installed"
    result = synth.synthesize("AEGIS local speech check.", voices[0], 0, threading.Event())
    assert result.wav[:4] == b"RIFF" and result.audio_ms > 500 and result.voice == voices[0]
    print(f"\nSAPI: voices={voices} synthesis={result.synthesis_ms} ms audio={result.audio_ms} ms")


def test_sapi_text_is_data_not_code() -> None:
    # PowerShell syntax in the text is spoken (or ignored), never executed: the text only travels as base64 on stdin.
    result = tts.WindowsSapiSynthesizer().synthesize("$(Start-Process notepad); `whoami`", None, 0, threading.Event())
    assert result.wav[:4] == b"RIFF"


def test_sapi_cancel_kills_the_process() -> None:
    cancel = threading.Event()
    threading.Timer(0.3, cancel.set).start()
    started = time.perf_counter()
    with pytest.raises(tts.TtsError) as error:
        tts.WindowsSapiSynthesizer().synthesize("A long sentence. " * 60, None, 0, cancel)
    assert error.value.code == "cancelled" and time.perf_counter() - started < 10


def test_whisper_transcribes_synthesized_speech() -> None:
    audio = _to_16k(_speak("Remember that my preferred development workflow uses manual commits."))
    result = recognizer.transcribe(audio, threading.Event())
    print(f"\nwhisper {result.model}: audio={result.audio_ms} ms processing={result.processing_ms} ms "
          f"text={result.text!r} low_confidence={result.low_confidence}")
    assert result.status == "ok"
    words = result.text.lower()
    assert "remember" in words and "manual commits" in words


def test_whisper_reports_silence_without_inventing_text() -> None:
    audio = stt.decode_wav(_wav(np.zeros(stt.SAMPLE_RATE * 2, dtype=np.float32)))
    result = recognizer.transcribe(audio, threading.Event())
    assert (result.status, result.text) == ("silence", "")


def test_whisper_on_noise_is_not_reported_as_speech() -> None:
    rng = np.random.default_rng(7)
    audio = stt.decode_wav(_wav((rng.standard_normal(stt.SAMPLE_RATE * 2) * 0.05).astype(np.float32)))
    result = recognizer.transcribe(audio, threading.Event())
    assert result.status in ("silence", "unintelligible") or result.low_confidence, result


def test_whisper_cancel_before_decoding() -> None:
    audio = _to_16k(_speak("This will be cancelled."))
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(stt.SttError) as error:
        recognizer.transcribe(audio, cancel)
    assert error.value.code == "cancelled"


def _wav(samples: np.ndarray) -> bytes:
    out = io.BytesIO()
    with wave.open(out, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(stt.SAMPLE_RATE)
        wav.writeframes((np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes())
    return out.getvalue()
