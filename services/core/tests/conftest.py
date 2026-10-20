from __future__ import annotations

import asyncio
import secrets
import socket
import threading
import time
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import httpx
import pytest
import uvicorn
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import server_config
from app.server import create_app
from tests.fixture_adapter import FixtureAdapter


@pytest.fixture
def token() -> str:
    return secrets.token_hex(32)


@pytest.fixture
def settings(tmp_path: Path, token: str) -> Settings:
    return Settings(data_dir=tmp_path / "data", session_token=token)


@pytest.fixture
def adapter() -> FixtureAdapter:
    # Tests never talk to a real model server unless they opt in explicitly (see test_ollama_live.py).
    return FixtureAdapter()


@pytest.fixture
def client(settings: Settings, adapter: FixtureAdapter) -> Iterator[TestClient]:
    # base_url host must be the loopback literal the core accepts.
    with TestClient(create_app(settings, adapter), base_url="http://127.0.0.1:8765") as test_client:
        yield test_client


@pytest.fixture
def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@dataclass
class LiveServer:
    app: FastAPI
    base_url: str
    loop: asyncio.AbstractEventLoop
    headers: dict[str, str]

    def client(self, **kwargs) -> httpx.Client:  # type: ignore[no-untyped-def]
        return httpx.Client(base_url=self.base_url, headers=self.headers, trust_env=False, **kwargs)

    def call(self, fn) -> None:  # type: ignore[no-untyped-def]
        """Run fn on the server's event loop thread (for asyncio objects owned by the server)."""
        self.loop.call_soon_threadsafe(fn)


@pytest.fixture
def live_server(settings: Settings, adapter: FixtureAdapter, auth: dict[str, str]) -> Iterator[LiveServer]:
    """The real FastAPI app on a real loopback socket via uvicorn, as Electron main sees it."""
    app = create_app(settings, adapter)
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    server = uvicorn.Server(server_config(app))
    loops: list[asyncio.AbstractEventLoop] = []

    def run() -> None:
        loop = asyncio.new_event_loop()
        loops.append(loop)
        loop.run_until_complete(server.serve(sockets=[sock]))

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not server.started:
        if time.monotonic() > deadline:
            raise RuntimeError("test server did not start")
        time.sleep(0.02)
    try:
        yield LiveServer(app, f"http://127.0.0.1:{port}", loops[0], auth)
    finally:
        server.should_exit = True
        thread.join(timeout=10)
