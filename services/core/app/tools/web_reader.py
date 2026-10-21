"""`browser.read_public`: render one already-fetched public page in an isolated browser and extract its text.

Isolation (ADR-008):
  * a fresh headless Chromium per research task and a fresh, ephemeral
    context per page: no profile, cookies, storage, service workers or downloads;
  * page JavaScript is disabled, so page code never runs;
  * every request the page makes is intercepted: the one main document is
    answered with the bytes GuardedFetcher already fetched, everything else
    (images, scripts, frames, meta-refresh navigations) is aborted;
  * Chromium's own resolver maps every name to NOTFOUND, so even a request that
    escaped interception could not reach the network.

The extracted text is untrusted data. Nothing in it is ever interpreted as an
instruction; it only becomes quoted evidence.
"""

from __future__ import annotations

import hashlib
import os
import re
from dataclasses import dataclass
from types import TracebackType
from urllib.parse import urlsplit
from urllib.robotparser import RobotFileParser

# Browsers are installed inside the venv's playwright package (setup.ps1), not in the user profile.
os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", "0")

from playwright.async_api import Browser, Playwright, Route, async_playwright  # noqa: E402

from app.tools.web_guard import ROBOTS_AGENT, GuardedFetcher, UrlRejected, normalize_url  # noqa: E402

RENDER_TIMEOUT_MS = 15_000
ROBOTS_MAX_BYTES = 256 * 1024
BROWSER_ARGS = ["--host-resolver-rules=MAP * ~NOTFOUND", "--disable-background-networking"]

_EXTRACT_JS = """
() => {
  const drop = 'script,style,noscript,template,nav,footer,aside,form,svg,iframe,object,embed,'
    + 'body > header,[hidden],[aria-hidden="true"]';
  for (const el of document.querySelectorAll(drop)) el.remove();
  const candidates = [...document.querySelectorAll('main, article, [role="main"]')]
    .sort((a, b) => b.innerText.length - a.innerText.length);
  const main = candidates[0];
  const root = main && main.innerText.trim().length >= 200 ? main : document.body;
  const canonical = document.querySelector('link[rel~="canonical"]');
  return {
    title: document.title || '',
    text: root ? root.innerText : '',
    canonical: canonical ? canonical.href : null,
  };
}
"""


@dataclass(frozen=True)
class Extracted:
    title: str
    text: str
    truncated: bool
    canonical_url: str
    sha256: str
    blocked_requests: int


def clean_text(raw: str, max_chars: int) -> tuple[str, bool]:
    lines = [re.sub(r"[ \t ]+", " ", line).strip() for line in raw.replace("\r", "").split("\n")]
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()
    if len(text) <= max_chars:
        return text, False
    return text[:max_chars].rsplit(" ", 1)[0], True


def canonical_for(final_url: str, declared: str | None) -> str:
    """The page's declared canonical URL, accepted only on the same host over https; else the fetched URL."""
    if declared:
        try:
            url = normalize_url(declared)
        except UrlRejected:
            return final_url
        if urlsplit(url).hostname == urlsplit(final_url).hostname:
            return url
    return final_url


async def robots_allows(fetcher: GuardedFetcher, url: str) -> tuple[bool, str]:
    """robots.txt for our agent token. 401/403/5xx mean "do not fetch"; a missing file allows."""
    parts = urlsplit(url)
    robots_url = f"https://{parts.hostname}/robots.txt"
    result = await fetcher.fetch(robots_url, ROBOTS_MAX_BYTES, accept=frozenset({"text/plain"}))
    if result.status in (401, 403) or result.status >= 500:
        return False, f"robots.txt answered HTTP {result.status}; treated as disallowed."
    if result.status != 200 or not result.body:
        return True, f"No usable robots.txt (HTTP {result.status})."
    parser = RobotFileParser()
    parser.parse(result.body.decode("utf-8", "replace").splitlines())
    if parser.can_fetch(ROBOTS_AGENT, url):
        return True, "Allowed by robots.txt."
    return False, "Disallowed by the site's robots.txt."


class PageReader:
    """One isolated headless browser for the duration of a research task."""

    def __init__(self) -> None:
        self._pw: Playwright | None = None
        self._browser: Browser | None = None

    async def __aenter__(self) -> PageReader:
        self._pw = await async_playwright().start()
        try:
            self._browser = await self._pw.chromium.launch(headless=True, args=BROWSER_ARGS)
        except BaseException:
            await self._pw.stop()
            raise
        return self

    async def __aexit__(self, *exc: type[BaseException] | BaseException | TracebackType | None) -> None:
        if self._browser is not None:
            await self._browser.close()
        if self._pw is not None:
            await self._pw.stop()

    async def extract(self, final_url: str, content_type: str, body: bytes, max_chars: int) -> Extracted:
        assert self._browser is not None
        context = await self._browser.new_context(
            java_script_enabled=False, accept_downloads=False, service_workers="block", offline=False
        )
        blocked = 0
        served = False

        async def handle(route: Route) -> None:
            nonlocal blocked, served
            request = route.request
            if not served and request.is_navigation_request() and request.url == final_url:
                served = True
                await route.fulfill(status=200, headers={"content-type": content_type}, body=body)
            else:
                blocked += 1
                await route.abort("blockedbyclient")

        try:
            await context.route("**/*", handle)
            page = await context.new_page()
            await page.goto(final_url, wait_until="domcontentloaded", timeout=RENDER_TIMEOUT_MS)
            data = await page.evaluate(_EXTRACT_JS)
        finally:
            await context.close()
        text, truncated = clean_text(str(data.get("text") or ""), max_chars)
        title = re.sub(r"\s+", " ", str(data.get("title") or "")).strip()[:300]
        return Extracted(
            title=title,
            text=text,
            truncated=truncated,
            canonical_url=canonical_for(final_url, data.get("canonical")),
            sha256=hashlib.sha256(text.encode("utf-8")).hexdigest(),
            blocked_requests=blocked,
        )
