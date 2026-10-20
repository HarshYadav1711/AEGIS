from __future__ import annotations

import secrets
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.server import create_app


@pytest.fixture
def token() -> str:
    return secrets.token_hex(32)


@pytest.fixture
def settings(tmp_path: Path, token: str) -> Settings:
    return Settings(data_dir=tmp_path / "data", session_token=token)


@pytest.fixture
def client(settings: Settings) -> Iterator[TestClient]:
    # base_url host must be the loopback literal the core accepts.
    with TestClient(create_app(settings), base_url="http://127.0.0.1:8765") as test_client:
        yield test_client


@pytest.fixture
def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}
