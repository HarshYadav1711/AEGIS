"""End-to-end check of the real process handshake used by Electron main."""

from __future__ import annotations

import json
import os
import secrets
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

import pytest

CORE_DIR = Path(__file__).resolve().parents[1]


def _spawn(tmp_path: Path, env_extra: dict[str, str] | None = None) -> subprocess.Popen[str]:
    env = {k: v for k, v in os.environ.items() if k in ("SYSTEMROOT", "PATH", "TEMP", "TMP")}
    env["AEGIS_DATA_DIR"] = str(tmp_path / "data")
    env.update(env_extra or {})
    return subprocess.Popen(
        [sys.executable, "-m", "app.main"],
        cwd=CORE_DIR,
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def _get(port: int, token: str | None) -> int:
    request = urllib.request.Request(f"http://127.0.0.1:{port}/health")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code


def test_handshake_health_auth_and_graceful_shutdown(tmp_path: Path) -> None:
    token = secrets.token_hex(32)
    proc = _spawn(tmp_path)
    try:
        assert proc.stdin and proc.stdout and proc.stderr
        proc.stdin.write(token + "\n")
        proc.stdin.flush()
        line = proc.stdout.readline()
        assert line.startswith("AEGIS_READY "), line
        port = json.loads(line.removeprefix("AEGIS_READY "))["port"]
        assert isinstance(port, int) and port > 1024

        assert _get(port, token) == 200
        assert _get(port, None) == 401
        assert _get(port, secrets.token_hex(32)) == 401

        # Closing stdin is the parent's shutdown request.
        proc.stdin.close()
        try:
            returncode = proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            pytest.fail(f"core did not exit after stdin EOF; stderr:\n{proc.stderr.read()}")
        assert returncode == 0
        stderr = proc.stderr.read()
        assert token not in stderr, "session token must never be logged"
        assert (tmp_path / "data" / "aegis.db").exists()
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


@pytest.mark.parametrize("bad", ["", "short", "z" * 64])
def test_invalid_token_refuses_to_start(tmp_path: Path, bad: str) -> None:
    proc = _spawn(tmp_path)
    out, err = proc.communicate(bad + "\n", timeout=15)
    assert proc.returncode == 2
    assert "AEGIS_READY" not in out
    if bad:
        assert bad not in err


def test_missing_data_dir_refuses_to_start(tmp_path: Path) -> None:
    proc = _spawn(tmp_path, {"AEGIS_DATA_DIR": ""})
    out, _ = proc.communicate(secrets.token_hex(32) + "\n", timeout=15)
    assert proc.returncode == 2
    assert "AEGIS_READY" not in out


def test_core_stays_responsive_when_voice_loads_native_libraries(tmp_path: Path) -> None:
    """Regression (Phase 5): the first /voice/status imports numpy/ctranslate2. On Windows that froze the whole core
    while the parent-watch thread held a blocking read on the stdin pipe; the watch now polls the pipe instead."""
    token = secrets.token_hex(32)
    proc = _spawn(tmp_path)
    try:
        assert proc.stdin and proc.stdout
        proc.stdin.write(token + "\n")
        proc.stdin.flush()
        port = json.loads(proc.stdout.readline().removeprefix("AEGIS_READY "))["port"]
        request = urllib.request.Request(f"http://127.0.0.1:{port}/voice/status")
        request.add_header("Authorization", f"Bearer {token}")
        with urllib.request.urlopen(request, timeout=30) as response:
            body = json.loads(response.read())
        assert {"stt", "tts", "limits"} <= set(body)
        assert _get(port, token) == 200
        proc.stdin.close()
        assert proc.wait(timeout=10) == 0
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
