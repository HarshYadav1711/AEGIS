"""Request gate for the loopback API.

Every HTTP request must carry `Host: 127.0.0.1[:port]` (defends against DNS
rebinding from a browser) and `Authorization: Bearer <per-launch token>`.
Non-HTTP scopes (websockets) are refused outright.
"""

from __future__ import annotations

import hmac
import json

from starlette.types import ASGIApp, Receive, Scope, Send

ALLOWED_HOSTNAME = "127.0.0.1"


def _hostname(host_header: str) -> str:
    # IPv4 literal with optional port; anything else (names, IPv6) is rejected by comparison.
    return host_header.rsplit(":", 1)[0] if host_header.count(":") == 1 else host_header


class LocalAuthMiddleware:
    def __init__(self, app: ASGIApp, token: str) -> None:
        self._app = app
        self._expected = f"Bearer {token}".encode("ascii")

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "lifespan":
            await self._app(scope, receive, send)
            return
        if scope["type"] != "http":
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": 1008})
            return

        headers = dict(scope.get("headers") or [])
        host = headers.get(b"host", b"").decode("latin-1")
        if _hostname(host) != ALLOWED_HOSTNAME:
            await _reject(send, 400, "invalid_host")
            return
        supplied = headers.get(b"authorization", b"")
        if not hmac.compare_digest(supplied, self._expected):
            await _reject(send, 401, "unauthorized", {b"www-authenticate": b"Bearer"})
            return
        await self._app(scope, receive, send)


async def _reject(send: Send, status: int, error: str, extra: dict[bytes, bytes] | None = None) -> None:
    body = json.dumps({"error": error}).encode("utf-8")
    headers = [
        (b"content-type", b"application/json"),
        (b"content-length", str(len(body)).encode("ascii")),
        (b"cache-control", b"no-store"),
        (b"x-content-type-options", b"nosniff"),
    ]
    headers.extend((extra or {}).items())
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": body})
