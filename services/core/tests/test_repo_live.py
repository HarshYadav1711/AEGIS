"""REAL model repository investigation. Skipped unless AEGIS_LIVE_MODEL names an installed Ollama model, e.g.

    $env:AEGIS_LIVE_MODEL = 'qwen3:4b'; .venv\\Scripts\\python -m pytest tests/test_repo_live.py -s

A skip means NOT CONFIGURED, never PASS. The repository is a disposable fixture; the model's findings are
printed with the status the deterministic verifier gave them, so a human can judge them.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.memory import adaptive as memory
from app.server import create_app
from tests.repo_fixtures import FAKE_KEY, make_repo, tree_digest

MODEL = os.environ.get("AEGIS_LIVE_MODEL", "").strip()
pytestmark = pytest.mark.skipif(not MODEL, reason="NOT CONFIGURED: set AEGIS_LIVE_MODEL to run a real Ollama request")
REQUEST = "Analyze this repository, explain its architecture, identify important problems, and suggest improvements."


def test_real_model_investigation_is_grounded(tmp_path: Path) -> None:
    settings = Settings(data_dir=tmp_path / "data", session_token="t" * 64)
    headers = {"Authorization": f"Bearer {settings.session_token}"}
    repo = make_repo(tmp_path / "inventory")
    before = tree_digest(repo)
    with TestClient(create_app(settings), base_url="http://127.0.0.1:8765") as client:
        memory.add_explicit(settings.database_path, content="The inventory service uses Flask for its HTTP layer.",
                            kind="fact", subject=None, scope="project:inventory")
        task = client.post("/repo-tasks/interpret", json={"text": REQUEST, "model": MODEL}, headers=headers).json()
        task_id = task["task"]["task"]["id"]
        planned = client.post(f"/repo-tasks/{task_id}/scope", json={"root_path": str(repo)}, headers=headers).json()
        started = time.monotonic()
        client.post(f"/repo-tasks/{task_id}/approve", json={"plan_digest": planned["task"]["plan_digest"],
                                                            "use_vault_notes": False}, headers=headers)
        while True:
            detail = client.get(f"/repo-tasks/{task_id}", headers=headers).json()
            if detail["task"]["status"] not in ("inspecting", "generating"):
                break
            assert time.monotonic() - started < 600
            time.sleep(1)
    report = detail["report"]
    print(f"\n[{MODEL}] {time.monotonic() - started:.1f}s status={detail['task']['status']} "
          f"error={detail['task']['error_code']}")
    assert detail["task"]["status"] == "awaiting_save", detail["task"]
    print("summary:", report["summary"])
    for f in report["model_findings"]:
        print(f"  {f['id']} [{f['status']}] {f['title']} @ {f['path']}:{f['start_line']}-{f['end_line']} "
              f"quote={f['quote'][:80]!r} {' '.join(f['reasons'])}")
    for h in report["hypotheses"]:
        print("  hypothesis:", json.dumps(h)[:300])
    print("metadata:", json.dumps(report["metadata"]))
    md = detail["task"]["report_markdown"]
    assert FAKE_KEY not in md and "hunter2" not in md
    flask = next(m for m in report["memory"] if "Flask" in m["content"])
    assert flask["used"] is False and "contradicted" in flask["check"]
    assert tree_digest(repo) == before
