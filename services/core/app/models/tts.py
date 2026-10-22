"""Local text-to-speech with the Windows built-in speech synthesizer (Phase 5).

Windows ships SAPI voices (Microsoft David and Zira on this machine); they are
used through System.Speech in a short-lived Windows PowerShell process:

- the executable is a fixed absolute path under %SystemRoot% (no shell, no PATH lookup);
- the script is a fixed literal; the text travels on stdin as base64 and the voice
  name and rate as environment values, so nothing the model wrote can become code;
- the voice must be one of the installed voices; output is raw PCM that this module
  wraps in a WAV header itself.

The WAV is returned to Electron main and played by the renderer, which is what
reports real playback start, end and levels. Synthesis is local; nothing is sent
over the network. The audio is never stored.
"""

from __future__ import annotations

import base64
import io
import logging
import os
import re
import subprocess
import sys
import threading
import time
import wave
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger("aegis.models.tts")

SAMPLE_RATE = 22_050
MAX_SPEAK_CHARS = 1_200
SYNTH_TIMEOUT_S = 60.0
LIST_TIMEOUT_S = 20.0
MAX_OUTPUT_BYTES = 16 * 1024 * 1024
VOICE_NAME = re.compile(r"^[A-Za-z0-9 ()._-]{1,80}$")

_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  if ($env:AEGIS_TTS_MODE -eq 'voices') {
    foreach ($v in $synth.GetInstalledVoices()) { if ($v.Enabled) { [Console]::Out.WriteLine($v.VoiceInfo.Name) } }
    exit 0
  }
  $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()))
  if ($env:AEGIS_TTS_VOICE) { $synth.SelectVoice($env:AEGIS_TTS_VOICE) }
  $synth.Rate = [int]$env:AEGIS_TTS_RATE
  $stream = New-Object System.IO.MemoryStream
  $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(22050, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $synth.SetOutputToAudioStream($stream, $format)
  $synth.Speak($text)
  $synth.SetOutputToNull()
  [Console]::Out.Write([Convert]::ToBase64String($stream.ToArray()))
} finally {
  $synth.Dispose()
}
"""


class TtsError(Exception):
    def __init__(self, code: str, detail: str) -> None:
        super().__init__(f"{code}: {detail}")
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class Synthesis:
    wav: bytes
    voice: str
    synthesis_ms: int
    audio_ms: int
    spoken_chars: int
    truncated: bool


_FENCE = re.compile(r"```.*?(?:```|$)", re.DOTALL)
_INLINE_CODE = re.compile(r"`([^`\n]{1,80})`")
_LONG_CODE = re.compile(r"`[^`]*`")
_LINK = re.compile(r"\[([^\]]+)\]\((?:[^)]+)\)")
_URL = re.compile(r"https?://\S+")
_MARKS = re.compile(r"(^|\s)[#>*+-]{1,6}\s+|[*_~#|]+")


def speech_text(markdown: str, limit: int = MAX_SPEAK_CHARS) -> tuple[str, bool]:
    """Plain text to read aloud from a Markdown reply, and whether it had to be shortened."""
    text = _FENCE.sub(" (code block, shown on screen) ", markdown)
    text = _INLINE_CODE.sub(r"\1", text)
    text = _LONG_CODE.sub(" ", text)
    text = _LINK.sub(r"\1", text)
    text = _URL.sub(" (link) ", text)
    text = _MARKS.sub(" ", text)
    text = " ".join("".join(ch if ch.isprintable() else " " for ch in text).split())
    if len(text) <= limit:
        return text, False
    cut = text[:limit]
    end = max(cut.rfind(". "), cut.rfind("! "), cut.rfind("? "))
    return (cut[: end + 1] if end > limit // 2 else cut).strip(), True


def _powershell() -> Path:
    root = os.environ.get("SystemRoot", r"C:\Windows")
    return Path(root) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"


def _wav(pcm: bytes) -> bytes:
    out = io.BytesIO()
    with wave.open(out, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(pcm)
    return out.getvalue()


class WindowsSapiSynthesizer:
    engine = "windows-sapi"

    def __init__(self, executable: Path | None = None) -> None:
        self._exe = executable or _powershell()
        self._voices: list[str] | None = None
        self._lock = threading.Lock()

    def _run(self, env: dict[str, str], stdin: bytes, timeout: float, cancel: threading.Event | None) -> bytes:
        if sys.platform != "win32" or not self._exe.is_file():
            raise TtsError("tts_unavailable", "Windows speech synthesis is not available on this system.")
        process = subprocess.Popen(  # fixed executable and fixed script; no shell
            [str(self._exe), "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
             "-Command", _SCRIPT],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env={**os.environ, **env}, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        watcher: threading.Thread | None = None
        if cancel is not None:
            def watch() -> None:
                while process.poll() is None:
                    if cancel.wait(0.05):
                        process.kill()
                        return
            watcher = threading.Thread(target=watch, daemon=True, name="tts-cancel-watch")
            watcher.start()
        try:
            out, err = process.communicate(stdin, timeout=timeout)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
            raise TtsError("tts_timeout", f"Speech synthesis did not finish within {int(timeout)} s.") from None
        if cancel is not None and cancel.is_set():
            raise TtsError("cancelled", "Speech synthesis was cancelled.")
        if process.returncode != 0:
            log.warning("speech synthesis failed (exit %s): %s", process.returncode, err[-500:].decode(errors="replace"))
            raise TtsError("tts_failed", "Windows speech synthesis failed (see core log).")
        if len(out) > MAX_OUTPUT_BYTES:
            raise TtsError("tts_failed", "Speech output exceeded the size limit.")
        return out

    def voices(self) -> list[str]:
        with self._lock:
            if self._voices is None:
                out = self._run({"AEGIS_TTS_MODE": "voices"}, b"", LIST_TIMEOUT_S, None)
                self._voices = [v.strip() for v in out.decode("utf-8", "replace").splitlines() if v.strip()]
            return list(self._voices)

    def synthesize(self, text: str, voice: str | None, rate: int, cancel: threading.Event) -> Synthesis:
        spoken, truncated = speech_text(text)
        if not spoken:
            raise TtsError("nothing_to_say", "There is no readable text to speak.")
        installed = self.voices()
        if not installed:
            raise TtsError("tts_unavailable", "No Windows speech voice is installed.")
        if voice is not None and (not VOICE_NAME.fullmatch(voice) or voice not in installed):
            raise TtsError("unknown_voice", "That voice is not installed.")
        chosen = voice or installed[0]
        started = time.perf_counter()
        out = self._run(
            {"AEGIS_TTS_MODE": "speak", "AEGIS_TTS_VOICE": chosen, "AEGIS_TTS_RATE": str(max(-10, min(10, rate)))},
            base64.b64encode(spoken.encode("utf-8")), SYNTH_TIMEOUT_S, cancel,
        )
        try:
            pcm = base64.b64decode(out.strip(), validate=True)
        except ValueError as error:
            raise TtsError("tts_failed", "Windows speech synthesis returned malformed audio.") from error
        if not pcm:
            raise TtsError("tts_failed", "Windows speech synthesis returned no audio.")
        return Synthesis(
            wav=_wav(pcm), voice=chosen, synthesis_ms=int((time.perf_counter() - started) * 1000),
            audio_ms=int(len(pcm) / 2 / SAMPLE_RATE * 1000), spoken_chars=len(spoken), truncated=truncated,
        )
