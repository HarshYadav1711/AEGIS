"""Network policy for public-web research (ADR-008, threat T07).

Only https URLs on the default port, with a DNS name (no IP literals, no
local-only names), whose every resolved address is globally routable, may be
fetched. The check runs at three points:

  1. when the plan is made (so a private URL is refused before approval),
  2. before every request hop, including each redirect target,
  3. inside the connection itself: the socket is opened to an address that was
     just validated, so DNS rebinding between the check and the connect cannot
     redirect the request to a private address.

The browser never touches the network itself (see web_reader.py); it renders
bytes fetched here.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpcore
import httpx

MAX_URL_CHARS = 2048
MAX_REDIRECTS = 4
USER_AGENT = "AEGIS-Research/0.3 (local desktop research assistant; bounded, reads single pages)"
ROBOTS_AGENT = "AEGIS-Research"
HTML_TYPES = frozenset({"text/html", "application/xhtml+xml", "text/plain"})
REDIRECT_CODES = frozenset({301, 302, 303, 307, 308})
# Names that only make sense on a local network or this machine.
LOCAL_SUFFIXES = (".localhost", ".local", ".internal", ".lan", ".home", ".corp", ".intranet", ".arpa", ".onion")

Resolver = Callable[[str, int], Awaitable[list[str]]]


class UrlRejected(Exception):
    """A URL or one of its addresses is outside the public-web policy; `code` is stable."""

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(f"{code}: {detail}")
        self.code = code
        self.detail = detail


async def system_resolver(host: str, port: int) -> list[str]:
    infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return [str(info[4][0]) for info in infos]


def normalize_url(raw: str) -> str:
    """Syntactic policy. Returns the URL without its fragment, or raises UrlRejected."""
    if not raw or len(raw) > MAX_URL_CHARS or any(c.isspace() or ord(c) < 32 for c in raw):
        raise UrlRejected("invalid_url", "The URL is empty, too long or contains spaces/control characters.")
    try:
        parts = urlsplit(raw)
        port = parts.port
    except ValueError:
        raise UrlRejected("invalid_url", "The URL could not be parsed.") from None
    if parts.scheme.lower() != "https":
        raise UrlRejected("https_only", "Only https:// URLs are fetched.")
    if parts.username is not None or parts.password is not None:
        raise UrlRejected("credentials_in_url", "URLs with embedded user names or passwords are refused.")
    if port not in (None, 443):
        raise UrlRejected("port_not_allowed", "Only the default https port (443) is allowed.")
    host = (parts.hostname or "").rstrip(".").lower()
    if not host:
        raise UrlRejected("invalid_url", "The URL has no host name.")
    try:
        ipaddress.ip_address(host)
        raise UrlRejected("ip_literal", "IP-address URLs are refused; use the site's domain name.")
    except ValueError:
        pass
    try:
        ascii_host = host.encode("idna").decode("ascii")
    except UnicodeError:
        raise UrlRejected("invalid_url", "The host name is not a valid domain name.") from None
    labels = ascii_host.split(".")
    tld = labels[-1]
    # A real public TLD is alphabetic (or punycode); this also refuses numeric host forms like 2130706433.
    if len(labels) < 2 or not (tld.isalpha() or tld.startswith("xn--")):
        raise UrlRejected("not_public_name", "The host is not a public domain name.")
    if ascii_host == "localhost" or ascii_host.endswith(LOCAL_SUFFIXES):
        raise UrlRejected("local_name", "Local-network and loopback host names are refused.")
    return urlunsplit(("https", ascii_host, parts.path or "/", parts.query, ""))


def is_public_address(raw: str) -> bool:
    try:
        ip = ipaddress.ip_address(raw.split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip.is_global and not ip.is_multicast and not ip.is_reserved


async def resolve_public(host: str, port: int, resolver: Resolver) -> list[str]:
    """Resolve and require that EVERY address is public (a mixed answer is refused)."""
    try:
        addresses = list(dict.fromkeys(await resolver(host, port)))
    except (OSError, UnicodeError):
        raise UrlRejected("dns_failed", f"The name {host} could not be resolved.") from None
    if not addresses:
        raise UrlRejected("dns_failed", f"The name {host} has no addresses.")
    private = [a for a in addresses if not is_public_address(a)]
    if private:
        raise UrlRejected(
            "private_address", f"{host} resolves to a private, loopback or reserved address; it is not fetched."
        )
    return addresses


async def check_url(raw: str, resolver: Resolver) -> str:
    url = normalize_url(raw)
    await resolve_public(urlsplit(url).hostname or "", 443, resolver)
    return url


class _PinnedBackend(httpcore.AsyncNetworkBackend):
    """Connects only to an address validated at connect time; TLS still verifies the host name."""

    def __init__(self, resolver: Resolver) -> None:
        self._resolver = resolver
        self._inner = httpcore.AnyIOBackend()

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Iterable[Any] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        addresses = await resolve_public(host, port, self._resolver)
        return await self._inner.connect_tcp(
            addresses[0], port, timeout=timeout, local_address=local_address, socket_options=socket_options
        )

    async def connect_unix_socket(self, *args: Any, **kwargs: Any) -> httpcore.AsyncNetworkStream:
        raise httpcore.ConnectError("unix sockets are not allowed")

    async def sleep(self, seconds: float) -> None:
        await self._inner.sleep(seconds)


class _PinnedTransport(httpx.AsyncHTTPTransport):
    def __init__(self, resolver: Resolver) -> None:
        super().__init__(trust_env=False)
        # shortcut: replaces httpx's private connection pool to inject the pinned backend; re-check on httpx upgrade.
        self._pool = httpcore.AsyncConnectionPool(
            ssl_context=httpx.create_ssl_context(trust_env=False),
            max_connections=4,
            network_backend=_PinnedBackend(resolver),
        )


@dataclass
class FetchResult:
    requested_url: str
    final_url: str
    status: int
    content_type: str
    body: bytes
    truncated: bool
    redirects: list[str] = field(default_factory=list)
    # The full header (with charset) handed to the renderer unchanged.
    raw_content_type: str = ""


class GuardedFetcher:
    """GET with manual, re-validated redirects and a byte cap. No cookies, proxies or auth are ever sent."""

    def __init__(self, resolver: Resolver | None = None, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.resolver: Resolver = resolver or system_resolver
        self._client = httpx.AsyncClient(
            transport=transport or _PinnedTransport(self.resolver),
            trust_env=False,
            follow_redirects=False,
            timeout=httpx.Timeout(15.0, connect=10.0),
            headers={"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9"},
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def fetch(self, url: str, max_bytes: int, accept: frozenset[str] = HTML_TYPES) -> FetchResult:
        requested = url
        current = await check_url(url, self.resolver)
        hops: list[str] = []
        for _ in range(MAX_REDIRECTS + 1):
            async with self._client.stream("GET", current) as response:
                self._client.cookies.clear()
                if response.status_code in REDIRECT_CODES:
                    location = response.headers.get("location")
                    if not location:
                        raise UrlRejected("bad_redirect", "The site sent a redirect without a target.")
                    hops.append(current)
                    current = await check_url(urljoin(current, location), self.resolver)
                    continue
                content_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
                body = bytearray()
                truncated = False
                if response.status_code == 200 and content_type in accept:
                    async for chunk in response.aiter_bytes():
                        body += chunk
                        if len(body) > max_bytes:
                            del body[max_bytes:]
                            truncated = True
                            break
                return FetchResult(
                    requested, current, response.status_code, content_type,
                    bytes(body), truncated, hops, response.headers.get("content-type", ""),
                )
        raise UrlRejected("too_many_redirects", f"More than {MAX_REDIRECTS} redirects.")
