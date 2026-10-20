from __future__ import annotations

from fastapi.testclient import TestClient

from app import __version__
from app.memory.db import LATEST_SCHEMA_VERSION


def test_health_with_valid_token_reports_real_state(client: TestClient, auth: dict[str, str]) -> None:
    response = client.get("/health", headers=auth)
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["service"] == "aegis-core"
    assert body["version"] == __version__
    assert body["uptime_seconds"] >= 0
    assert body["database"]["ok"] is True
    assert body["database"]["schema_version"] == LATEST_SCHEMA_VERSION
    assert body["database"]["journal_mode"] == "wal"
    assert isinstance(body["database"]["fts5_available"], bool)
    # No model exists in Phase 0; health must not claim chat capability.
    assert body["capabilities"] == {"chat": False}
    assert response.headers["cache-control"] == "no-store"


def test_missing_token_is_rejected(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 401
    assert response.json() == {"error": "unauthorized"}
    assert response.headers["www-authenticate"] == "Bearer"


def test_wrong_token_is_rejected(client: TestClient, token: str) -> None:
    wrong = ("0" if token[0] != "0" else "1") + token[1:]
    assert client.get("/health", headers={"Authorization": f"Bearer {wrong}"}).status_code == 401


def test_token_without_bearer_scheme_is_rejected(client: TestClient, token: str) -> None:
    assert client.get("/health", headers={"Authorization": token}).status_code == 401


def test_foreign_host_header_is_rejected_even_with_token(client: TestClient, auth: dict[str, str]) -> None:
    # DNS-rebinding style request: right token irrelevant, wrong Host.
    for host in ("localhost:8765", "evil.example", "0.0.0.0:8765", "[::1]:8765"):
        response = client.get("/health", headers={**auth, "Host": host})
        assert response.status_code == 400, host


def test_unknown_routes_and_docs_require_auth_and_do_not_exist(client: TestClient, auth: dict[str, str]) -> None:
    for path in ("/docs", "/openapi.json", "/redoc", "/nope"):
        assert client.get(path).status_code == 401
        assert client.get(path, headers=auth).status_code == 404


def test_health_reports_degraded_when_database_is_unavailable(
    client: TestClient, auth: dict[str, str], settings
) -> None:
    settings.database_path.unlink()
    for suffix in ("-wal", "-shm"):
        sidecar = settings.database_path.with_name(settings.database_path.name + suffix)
        sidecar.unlink(missing_ok=True)
    body = client.get("/health", headers=auth).json()
    assert body["status"] == "degraded"
    assert body["database"]["ok"] is False
