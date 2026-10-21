"""Public-web policy: URL syntax, DNS/IP validation, redirects and connect-time pinning (no real network)."""

from __future__ import annotations

import asyncio

import httpx
import pytest

from app.tools.web_guard import (
    GuardedFetcher,
    UrlRejected,
    _PinnedBackend,
    check_url,
    is_public_address,
    normalize_url,
)
from tests.web_fixtures import PUBLIC_IP, standard_web


def run(coro):  # type: ignore[no-untyped-def]
    return asyncio.run(coro)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("https://Example.COM", "https://example.com/"),
        ("https://example.com/a/b?q=1#frag", "https://example.com/a/b?q=1"),
        ("https://example.com:443/x", "https://example.com/x"),
        ("https://bücher.example/x", "https://xn--bcher-kva.example/x"),
    ],
)
def test_public_urls_are_normalized(raw: str, expected: str) -> None:
    assert normalize_url(raw) == expected


@pytest.mark.parametrize(
    ("raw", "code"),
    [
        ("http://example.com/", "https_only"),
        ("file:///C:/Windows/win.ini", "https_only"),
        ("ftp://example.com/", "https_only"),
        ("https://user:pass@example.com/", "credentials_in_url"),
        ("https://example.com:8443/", "port_not_allowed"),
        ("https://127.0.0.1/", "ip_literal"),
        ("https://[::1]/", "ip_literal"),
        ("https://169.254.169.254/latest/meta-data", "ip_literal"),
        ("https://2130706433/", "not_public_name"),
        ("https://0x7f000001/", "not_public_name"),
        ("https://localhost/", "not_public_name"),
        ("https://intranet/", "not_public_name"),
        ("https://printer.local/", "local_name"),
        ("https://api.localhost/", "local_name"),
        ("https://db.internal/", "local_name"),
        ("https://exa mple.com/", "invalid_url"),
        ("", "invalid_url"),
    ],
)
def test_unsafe_urls_are_rejected(raw: str, code: str) -> None:
    with pytest.raises(UrlRejected) as info:
        normalize_url(raw)
    assert info.value.code == code


@pytest.mark.parametrize(
    ("address", "public"),
    [
        (PUBLIC_IP, True),
        ("2606:4700:4700::1111", True),
        ("127.0.0.1", False),
        ("10.1.2.3", False),
        ("172.16.0.1", False),
        ("192.168.0.10", False),
        ("169.254.169.254", False),
        ("100.64.0.1", False),
        ("0.0.0.0", False),
        ("224.0.0.1", False),
        ("::1", False),
        ("fe80::1", False),
        ("fc00::1", False),
        ("::ffff:192.168.1.10", False),
        ("not-an-ip", False),
    ],
)
def test_address_classification(address: str, public: bool) -> None:
    assert is_public_address(address) is public


@pytest.mark.parametrize(
    ("host", "code"),
    [
        ("rebind.example.com", "private_address"),
        ("mixed.example.com", "private_address"),  # one private answer is enough to refuse
        ("metadata.example.com", "private_address"),
        ("v6local.example.com", "private_address"),
        ("mapped.example.com", "private_address"),
    ],
)
def test_names_resolving_to_private_addresses_are_rejected(host: str, code: str) -> None:
    with pytest.raises(UrlRejected) as info:
        run(check_url(f"https://{host}/", standard_web().resolve))
    assert info.value.code == code


def test_dns_failure_is_reported() -> None:
    async def failing(host: str, port: int) -> list[str]:
        raise OSError("no such host")

    with pytest.raises(UrlRejected) as info:
        run(check_url("https://nowhere.example.com/", failing))
    assert info.value.code == "dns_failed"


def test_redirects_are_revalidated_at_every_hop() -> None:
    web = standard_web()

    async def go(url: str):  # type: ignore[no-untyped-def]
        fetcher = web.fetcher()
        try:
            return await fetcher.fetch(url, 100_000)
        finally:
            await fetcher.aclose()

    for url, code in (
        ("https://redirect.example.com/to-http", "https_only"),
        ("https://redirect.example.com/to-private", "private_address"),
    ):
        with pytest.raises(UrlRejected) as info:
            run(go(url))
        assert info.value.code == code
    # The private targets were never requested.
    assert not any("127.0.0.1" in u or "rebind" in u for u in web.requested)

    ok = run(go("https://redirect.example.com/ok"))
    assert ok.final_url == "https://redirect.example.com/final" and ok.redirects == ["https://redirect.example.com/ok"]


def test_redirect_loops_are_bounded() -> None:
    web = standard_web()
    web.redirect("https://loop.example.com/a", "https://loop.example.com/b")
    web.redirect("https://loop.example.com/b", "https://loop.example.com/a")
    fetcher = web.fetcher()
    with pytest.raises(UrlRejected) as info:
        run(fetcher.fetch("https://loop.example.com/a", 1000))
    assert info.value.code == "too_many_redirects"
    assert len(web.requested) == 5


def test_body_is_capped_and_other_types_are_not_downloaded() -> None:
    web = standard_web()
    web.page("https://big.example.com/", "x" * 50_000)
    fetcher = web.fetcher()
    big = run(fetcher.fetch("https://big.example.com/", 1_000))
    assert big.truncated and len(big.body) == 1_000
    pdf = run(fetcher.fetch("https://pdf.example.com/doc", 1_000))
    assert pdf.content_type == "application/pdf" and pdf.body == b""


def test_connect_time_check_refuses_rebinding() -> None:
    """Even if a name passed the earlier check, the socket is never opened to a private address."""
    answers = iter([[PUBLIC_IP], ["127.0.0.1"]])

    async def rebinding(host: str, port: int) -> list[str]:
        return next(answers)

    async def scenario() -> None:
        await check_url("https://flip.example.com/", rebinding)  # first answer: public
        with pytest.raises(UrlRejected) as info:
            await _PinnedBackend(rebinding).connect_tcp("flip.example.com", 443)  # second answer: loopback
        assert info.value.code == "private_address"

    run(scenario())


def test_real_transport_never_connects_to_loopback() -> None:
    """End to end through the production transport: a name resolving to 127.0.0.1 fails before any socket."""

    async def loopback(host: str, port: int) -> list[str]:
        return ["127.0.0.1"]

    async def scenario() -> None:
        fetcher = GuardedFetcher(resolver=loopback)
        try:
            with pytest.raises(UrlRejected):
                await fetcher.fetch("https://looks-public.example.com/", 1000)
        finally:
            await fetcher.aclose()

    run(scenario())


def test_no_cookies_are_kept_between_requests() -> None:
    web = standard_web()
    web.pages["https://cookie.example.com/"] = httpx.Response(
        200, headers={"content-type": "text/html", "set-cookie": "session=abc"}, text="<p>hi</p>"
    )
    fetcher = web.fetcher()

    async def twice() -> None:
        await fetcher.fetch("https://cookie.example.com/", 1000)
        await fetcher.fetch("https://cookie.example.com/", 1000)  # the fixture asserts no Cookie header
        await fetcher.aclose()

    run(twice())
