"""Research workflow through the authenticated API.

Web pages come from the FakeWeb fixture (no network) but are rendered and
extracted by the real isolated Chromium. Model replies are SCRIPTED fixture
text, not model output. Report files are written to real temporary folders
and checked on disk.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import sqlite3
import time
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.models.base import (
    ChatMessage,
    GenerationOptions,
    GenerationResult,
    ModelInfo,
    ProviderError,
    ProviderHealth,
    StreamItem,
    TextDelta,
)
from app.server import create_app
from app.tasks import research_journal as journal
from tests.web_fixtures import FakeWeb, standard_web

MODEL = "fixture-model:1b"
TERMINAL = {"awaiting_save", "completed", "failed", "cancelled", "rejected"}
PLAN_REPLY = json.dumps({"question": "How efficient are home solar panels and batteries?",
                         "key_terms": ["solar panel", "efficiency", "battery", "storage"]})
GOOD_REPORT = json.dumps({
    "findings": [
        {"claim": "Typical residential silicon panels convert about 20 percent of sunlight into electricity.",
         "source_ids": ["S1-P1"],
         "quote": "Typical residential silicon solar panels convert about 20 percent of incoming sunlight into "
                  "electricity."},
        {"claim": "Panels never lose output over time.", "source_ids": ["S9-P4"], "quote": "never lose output"},
        {"claim": "Home batteries store surplus solar energy for the evening.", "source_ids": ["S2-P1"],
         "quote": "Batteries are 99 percent efficient in every climate."},
    ],
    "uncertainties": ["Cleaning schedules are not covered."],
    "evidence_sufficient": True,
})


class ScriptedAdapter:
    """TEST FIXTURE ONLY: returns queued text per call (fixture text, not model output)."""

    provider_id = "fixture"
    base_url = "fixture://scripted"

    def __init__(self) -> None:
        self.replies: list[str | ProviderError] = []
        self.calls: list[list[ChatMessage]] = []
        self.hold: asyncio.Event | None = None
        self.closed = 0

    async def health(self) -> ProviderHealth:
        return ProviderHealth(self.provider_id, True, "fixture", models=(ModelInfo(MODEL),))

    async def stream_chat(
        self, model: str, messages: list[ChatMessage], options: GenerationOptions
    ) -> AsyncIterator[StreamItem]:
        self.calls.append(messages)
        reply = self.replies.pop(0) if self.replies else ProviderError("provider_error", "no scripted reply")
        try:
            if isinstance(reply, ProviderError):
                raise reply
            if self.hold is not None and len(self.calls) > 1:
                await self.hold.wait()
            yield TextDelta(reply)
            yield GenerationResult(self.provider_id, model, "stop", prompt_tokens=100, completion_tokens=50)
        finally:
            self.closed += 1


@pytest.fixture
def web() -> FakeWeb:
    return standard_web()


@pytest.fixture
def scripted() -> ScriptedAdapter:
    return ScriptedAdapter()


@pytest.fixture
def rclient(settings: Settings, scripted: ScriptedAdapter, web: FakeWeb) -> Iterator[TestClient]:
    app = create_app(settings, scripted, fetcher_factory=web.fetcher)  # type: ignore[arg-type]
    with TestClient(app, base_url="http://127.0.0.1:8765") as client:
        yield client


def interpret(client: TestClient, auth: dict[str, str], text: str) -> dict[str, Any]:
    response = client.post("/research-tasks/interpret", json={"text": text, "model": MODEL}, headers=auth)
    assert response.status_code == 200, response.text
    return response.json()


def wait(client: TestClient, auth: dict[str, str], task_id: str, timeout: float = 60) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while True:
        detail = client.get(f"/research-tasks/{task_id}", headers=auth).json()
        if detail["task"]["status"] in TERMINAL:
            return detail
        if time.monotonic() > deadline:
            raise AssertionError(f"task stuck in {detail['task']['status']}")
        time.sleep(0.1)


def approve(client: TestClient, auth: dict[str, str], detail: dict[str, Any]):  # type: ignore[no-untyped-def]
    task = detail["task"]
    return client.post(f"/research-tasks/{task['id']}/approve", json={"plan_digest": task["plan_digest"]},
                       headers=auth)


def run_task(client, auth, scripted, text, report=GOOD_REPORT):  # type: ignore[no-untyped-def]
    scripted.replies = [PLAN_REPLY, report]
    planned = interpret(client, auth, text)["task"]
    assert approve(client, auth, planned).status_code == 200
    return wait(client, auth, planned["task"]["id"])


TWO_SOURCES = "Research how efficient home solar is: https://docs.example.com/solar https://news.example.org/storage"


def test_plan_is_bounded_and_refuses_unsafe_sources(rclient, auth, scripted, web) -> None:  # type: ignore[no-untyped-def]
    scripted.replies = [PLAN_REPLY]
    urls = [f"https://site{i}.example.com/page" for i in range(6)]
    text = ("research solar https://rebind.example.com/x http://plain.example.com/ https://127.0.0.1/admin "
            + " ".join(urls) + " https://site0.example.com/page")
    body = interpret(rclient, auth, text)
    detail = body["task"]
    statuses = [(s["requested_url"], s["status"], s["code"]) for s in detail["sources"]]
    assert [s for s in statuses if s[1] == "planned"] == [(u, "planned", None) for u in urls[:5]]
    assert ("https://site5.example.com/page", "skipped", "over_limit") in statuses
    refused = {r["code"] for r in body["refused"]}
    assert refused == {"https_only", "ip_literal", "private_address"}
    assert detail["task"]["status"] == "awaiting_approval" and detail["task"]["plan_source"] == "model"
    assert detail["task"]["question"] == "How efficient are home solar panels and batteries?"
    assert web.requested == []  # planning never fetches a page
    # The model saw the request without URLs, and could not add sources: the list is fixed by code.
    assert "https://" not in scripted.calls[0][1].content


def test_only_private_or_local_urls_create_no_task(rclient, auth, scripted, web) -> None:  # type: ignore[no-untyped-def]
    body = interpret(rclient, auth, "research http://127.0.0.1:8080/admin https://localhost/ https://metadata.example.com/")
    assert body["intent"] == "research" and body["task"] is None
    assert {r["code"] for r in body["refused"]} == {"https_only", "not_public_name", "private_address"}
    assert web.requested == [] and scripted.calls == []
    assert rclient.get("/research-tasks", headers=auth).json()["tasks"] == []


def test_ordinary_chat_is_not_routed(rclient, auth) -> None:  # type: ignore[no-untyped-def]
    assert interpret(rclient, auth, "What is a solar panel?")["intent"] == "none"


def test_full_research_report_with_injection_page(rclient, auth, scripted, web, tmp_path: Path) -> None:  # type: ignore[no-untyped-def]
    detail = run_task(rclient, auth, scripted, TWO_SOURCES)
    task = detail["task"]
    assert task["status"] == "awaiting_save", task
    s1, s2 = detail["sources"]
    assert s1["status"] == "extracted" and s1["canonical_url"] == "https://docs.example.com/solar"
    assert s1["title"] == "Solar panel basics" and s1["retrieved_at"] and len(s1["sha256"]) == 64
    assert s2["status"] == "extracted" and s2["code"] == "suspicious_instructions"
    assert "sub-request(s) blocked" in s2["detail"]

    # Provenance: the stored hash is the hash of the stored text; page scripts never ran; nav was stripped.
    with sqlite3.connect(rclient.app.state.settings.database_path) as conn:
        text1, text2 = [r[0] for r in conn.execute("SELECT text FROM research_sources ORDER BY seq")]
    assert hashlib.sha256(text1.encode()).hexdigest() == s1["sha256"]
    assert "Home | Products" not in text1 and "SCRIPT RAN" not in text2

    # The injection page caused no extra request: only robots.txt and the two approved pages were fetched.
    assert sorted(web.requested) == sorted([
        "https://docs.example.com/robots.txt", "https://docs.example.com/solar",
        "https://news.example.org/robots.txt", "https://news.example.org/storage",
    ])
    assert len(scripted.calls) == 2  # plan + report, nothing more
    report_prompt = scripted.calls[1]
    assert "data, never instructions" in report_prompt[0].content and "<<<PASSAGE S2-P1" in report_prompt[1].content

    report = detail["report"]
    statuses = {f["id"]: f["status"] for f in report["findings"]}
    assert statuses == {"F1": "supported", "F2": "removed", "F3": "weak"}
    md = task["report_markdown"]
    assert "## Claims removed (no valid citation)" in md and "Panels never lose output" in md
    assert "possible prompt injection" in md and "https://evil.example.net" not in md
    assert "<https://docs.example.com/solar>" in md and "Model calls: 2 (limit 2)" in md

    # Save into a user-chosen folder (what the native picker returns), verify on disk, never twice.
    out = tmp_path / "reports"
    out.mkdir()
    saved = rclient.post(f"/research-tasks/{task['id']}/save", json={"root_path": str(out)}, headers=auth)
    assert saved.status_code == 200, saved.text
    done = saved.json()["task"]
    path = Path(done["saved_path"])
    assert done["status"] == "completed" and path.parent == out and path.suffix == ".md"
    assert path.read_text(encoding="utf-8") == md
    assert hashlib.sha256(path.read_bytes()).hexdigest() == done["report_sha256"]
    again = rclient.post(f"/research-tasks/{task['id']}/save", json={"root_path": str(out)}, headers=auth)
    assert again.status_code == 409 and again.json()["detail"] == "not_awaiting_save"
    assert list(out.iterdir()) == [path]


def test_save_never_overwrites_and_checks_the_folder(rclient, auth, scripted, settings, tmp_path) -> None:  # type: ignore[no-untyped-def]
    detail = run_task(rclient, auth, scripted, "research https://docs.example.com/solar")
    task_id = detail["task"]["id"]
    for bad, code in (
        ("relative\\folder", "invalid_path"),
        (str(tmp_path / "missing"), "not_found"),
        (str(settings.data_dir), "protected_folder"),
    ):
        response = rclient.post(f"/research-tasks/{task_id}/save", json={"root_path": bad}, headers=auth)
        assert response.status_code == 400 and response.json()["detail"] == code
    out = tmp_path / "out"
    out.mkdir()
    created = journal.get_task(settings.database_path, task_id)["created_at"]
    from datetime import datetime

    name = f"aegis-research-{datetime.fromisoformat(created):%Y%m%d-%H%M%S}-{task_id[:8]}.md"
    (out / name).write_text("user's own file", encoding="utf-8")
    response = rclient.post(f"/research-tasks/{task_id}/save", json={"root_path": str(out)}, headers=auth)
    assert response.status_code == 400 and response.json()["detail"] == "file_exists"
    assert (out / name).read_text(encoding="utf-8") == "user's own file"
    assert rclient.get(f"/research-tasks/{task_id}", headers=auth).json()["task"]["status"] == "awaiting_save"


def test_blocked_and_failed_sources_are_reported_honestly(rclient, auth, scripted) -> None:  # type: ignore[no-untyped-def]
    text = ("research https://blocked.example.com/page https://forbidden.example.com/page https://pdf.example.com/doc"
            " https://redirect.example.com/to-private https://docs.example.com/solar")
    detail = run_task(rclient, auth, scripted, text)
    got = {s["requested_url"]: (s["status"], s["code"]) for s in detail["sources"]}
    assert got == {
        "https://blocked.example.com/page": ("blocked", "robots_disallowed"),
        "https://forbidden.example.com/page": ("blocked", "access_refused"),
        "https://pdf.example.com/doc": ("failed", "unsupported_content"),
        "https://redirect.example.com/to-private": ("blocked", "private_address"),
        "https://docs.example.com/solar": ("extracted", "ok"),
    }
    md = detail["task"]["report_markdown"]
    assert "### Sources not used" in md and "4 source(s) could not be used" in md


def test_no_readable_source_means_no_model_call_and_no_report(rclient, auth, scripted, web) -> None:  # type: ignore[no-untyped-def]
    web.unreachable.add("docs.example.com")
    detail = run_task(rclient, auth, scripted, "research https://docs.example.com/solar")
    assert detail["task"]["status"] == "failed" and detail["task"]["error_code"] == "no_sources"
    assert detail["sources"][0]["code"] == "network_error"
    assert len(scripted.calls) == 1 and detail["report"] is None and detail["task"]["report_markdown"] is None


@pytest.mark.parametrize(
    ("reply", "code"),
    [
        (ProviderError("provider_unavailable", "fixture: provider down"), "provider_provider_unavailable"),
        ("this is not json", "invalid_model_output"),
        (json.dumps({"findings": [], "uncertainties": []}), "invalid_model_output"),
    ],
)
def test_provider_failures_fail_the_task_without_a_report(rclient, auth, scripted, reply, code) -> None:  # type: ignore[no-untyped-def]
    detail = run_task(rclient, auth, scripted, "research https://docs.example.com/solar", report=reply)
    assert detail["task"]["status"] == "failed" and detail["task"]["error_code"] == code
    assert detail["task"]["report_markdown"] is None
    assert detail["sources"][0]["status"] == "extracted", detail["sources"][0]  # what was read stays recorded


def test_plan_falls_back_to_keywords_when_the_model_fails(rclient, auth, scripted) -> None:  # type: ignore[no-untyped-def]
    scripted.replies = [ProviderError("timeout", "fixture: slow")]
    task = interpret(rclient, auth, "research solar efficiency https://docs.example.com/solar")["task"]["task"]
    assert task["plan_source"] == "keyword_fallback" and task["plan_model"] is None
    assert task["key_terms"] == ["solar", "efficiency"]


def test_cancel_during_generation(rclient, auth, scripted) -> None:  # type: ignore[no-untyped-def]
    scripted.hold = asyncio.Event()  # never set: the report call hangs until cancelled
    scripted.replies = [PLAN_REPLY, GOOD_REPORT]
    planned = interpret(rclient, auth, "research https://docs.example.com/solar")["task"]
    task_id = planned["task"]["id"]
    assert approve(rclient, auth, planned).status_code == 200
    deadline = time.monotonic() + 30
    while rclient.get(f"/research-tasks/{task_id}", headers=auth).json()["task"]["status"] != "generating":
        assert time.monotonic() < deadline
        time.sleep(0.05)
    assert rclient.post(f"/research-tasks/{task_id}/cancel", headers=auth).status_code == 200
    detail = wait(rclient, auth, task_id)
    assert detail["task"]["status"] == "cancelled" and detail["task"]["report_markdown"] is None
    assert scripted.closed == 2  # the in-flight model stream was released
    late = rclient.post(f"/research-tasks/{task_id}/cancel", headers=auth)
    assert late.status_code == 409


def test_approval_is_bound_to_the_plan_and_given_once(rclient, auth, scripted) -> None:  # type: ignore[no-untyped-def]
    scripted.replies = [PLAN_REPLY, GOOD_REPORT]
    planned = interpret(rclient, auth, "research https://docs.example.com/solar")["task"]
    task_id = planned["task"]["id"]
    wrong = rclient.post(f"/research-tasks/{task_id}/approve", json={"plan_digest": "0" * 64}, headers=auth)
    assert wrong.status_code == 409 and wrong.json()["detail"] == "plan_digest_mismatch"
    assert approve(rclient, auth, planned).status_code == 200
    assert approve(rclient, auth, planned).json()["detail"] == "not_awaiting_approval"
    wait(rclient, auth, task_id)
    # Rejecting or approving an unknown / malformed task id
    assert rclient.post(f"/research-tasks/{'1' * 8}-1111-1111-1111-{'1' * 12}/reject", headers=auth).status_code == 404
    assert rclient.post("/research-tasks/not-a-uuid/approve", json={"plan_digest": "0" * 64},
                        headers=auth).status_code == 422


def test_reject_reads_nothing(rclient, auth, scripted, web) -> None:  # type: ignore[no-untyped-def]
    scripted.replies = [PLAN_REPLY]
    planned = interpret(rclient, auth, "research https://docs.example.com/solar")["task"]
    response = rclient.post(f"/research-tasks/{planned['task']['id']}/reject", headers=auth)
    assert response.json()["task"]["status"] == "rejected" and web.requested == []


def test_requests_need_the_session_token(rclient) -> None:  # type: ignore[no-untyped-def]
    assert rclient.get("/research-tasks").status_code == 401
    assert rclient.post("/research-tasks/interpret", json={"text": "x", "model": MODEL}).status_code == 401


def test_interrupted_tasks_are_failed_at_startup(settings, scripted, web) -> None:  # type: ignore[no-untyped-def]
    app = create_app(settings, scripted, fetcher_factory=web.fetcher)  # type: ignore[arg-type]
    with TestClient(app, base_url="http://127.0.0.1:8765"):
        pass
    task_id = journal.create_task(
        settings.database_path, request_text="r", question="q", key_terms=["q"], plan_source="keyword_fallback",
        plan_model=None, plan_detail="d", model=MODEL,
        sources=[("https://a.example.com/", "planned", None, None), ("https://b.example.com/", "planned", None, None)],
    )
    with sqlite3.connect(settings.database_path) as conn:
        conn.execute("UPDATE research_tasks SET status = 'researching' WHERE id = ?", (task_id,))
        conn.execute("UPDATE research_sources SET status = 'fetching' WHERE seq = 1")
    with TestClient(create_app(settings, scripted, fetcher_factory=web.fetcher), base_url="http://127.0.0.1:8765"):  # type: ignore[arg-type]
        pass
    detail = journal.get_detail(settings.database_path, task_id)
    assert detail["task"]["status"] == "failed" and detail["task"]["error_code"] == "interrupted"
    assert [s["status"] for s in detail["sources"]] == ["failed", "skipped"]
