"""Entry point used by Electron main: `python -m app.main`.

Startup handshake (stdin/stdout only; the token never appears in argv, env or logs):
  1. The parent writes the per-launch session token (64 hex chars) as one stdin line.
  2. The core binds 127.0.0.1 on an OS-assigned port, starts serving, then prints
     exactly one stdout line:  AEGIS_READY {"port": <int>}
  3. End-of-file on stdin (parent closed it or died) requests a graceful shutdown.
All logging goes to stderr.
"""

from __future__ import annotations

import json
import logging
import os
import socket
import string
import sys
import threading
import time
from typing import TextIO

import uvicorn
from starlette.types import ASGIApp

from app.config import Settings, data_dir_from_env
from app.server import create_app

READY_PREFIX = "AEGIS_READY "
TOKEN_LENGTH = 64
LOOPBACK = "127.0.0.1"
GRACEFUL_SHUTDOWN_S = 2
PARENT_POLL_S = 0.25

log = logging.getLogger("aegis.main")


class TokenError(ValueError):
    pass


def read_token(stream: TextIO) -> str:
    token = stream.readline().strip()
    if len(token) != TOKEN_LENGTH or any(c not in string.hexdigits for c in token):
        # Deliberately does not echo what was received.
        raise TokenError(f"expected a {TOKEN_LENGTH}-character hex session token on stdin")
    return token


def bind_loopback_socket() -> socket.socket:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
        # Windows: stop another process from binding the same port alongside us.
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
    sock.bind((LOOPBACK, 0))
    sock.set_inheritable(False)
    return sock


def server_config(app: ASGIApp) -> uvicorn.Config:
    return uvicorn.Config(
        app,
        log_level="warning",
        access_log=False,
        server_header=False,
        date_header=False,
        lifespan="on",
        http="h11",
        ws="none",
        loop="asyncio",
        # Without a bound, uvicorn waits for open reply streams to finish before shutting down.
        # After this, open requests are cancelled and their replies recorded as interrupted.
        timeout_graceful_shutdown=GRACEFUL_SHUTDOWN_S,
    )


class CoreServer(uvicorn.Server):
    """uvicorn server that announces readiness only after it is actually serving."""

    def __init__(self, config: uvicorn.Config, port: int, out: TextIO) -> None:
        super().__init__(config)
        self._port = port
        self._out = out

    async def startup(self, sockets: list[socket.socket] | None = None) -> None:
        await super().startup(sockets=sockets)
        if not self.should_exit:
            self._out.write(READY_PREFIX + json.dumps({"port": self._port}) + "\n")
            self._out.flush()


def _windows_pipe(stream: TextIO) -> int | None:
    if sys.platform != "win32":
        return None
    try:
        import _winapi
        import msvcrt

        handle = msvcrt.get_osfhandle(stream.fileno())
        return handle if _winapi.GetFileType(handle) == _winapi.FILE_TYPE_PIPE else None
    except (OSError, ValueError, AttributeError):
        return None


def watch_parent(stream: TextIO, server: uvicorn.Server) -> None:
    """Shut down when the parent closes our stdin (or dies).

    On Windows the stdin pipe is polled with PeekNamedPipe instead of a blocking read: while a synchronous
    ReadFile is pending on the stdin handle, native libraries that query the standard handles as their DLLs
    load (numpy's runtime, first imported when voice is used) block on it and freeze the whole core.
    """
    handle = _windows_pipe(stream)
    try:
        if handle is not None:
            import _winapi

            while True:
                available, _left = _winapi.PeekNamedPipe(handle, 0)  # BrokenPipeError once the parent closed it
                if available:
                    os.read(stream.fileno(), available)  # never blocks: the bytes are already there
                time.sleep(PARENT_POLL_S)
        else:
            while stream.read(4096):
                pass
    except (OSError, ValueError):
        pass
    log.info("parent closed stdin; shutting down")
    server.should_exit = True


def main() -> int:
    logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    try:
        token = read_token(sys.stdin)
        settings = Settings(data_dir=data_dir_from_env(), session_token=token)
    except (TokenError, RuntimeError) as error:
        log.error("startup refused: %s", error)
        return 2

    sock = bind_loopback_socket()
    port = sock.getsockname()[1]
    server = CoreServer(server_config(create_app(settings)), port=port, out=sys.stdout)
    threading.Thread(target=watch_parent, args=(sys.stdin, server), daemon=True, name="parent-watch").start()
    log.info("core starting on loopback (pid %s)", os.getpid())
    server.run(sockets=[sock])
    return 0


if __name__ == "__main__":
    sys.exit(main())
