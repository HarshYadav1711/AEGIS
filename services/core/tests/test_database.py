from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from app.memory import db


def test_initialize_creates_database_with_wal_and_schema(tmp_path: Path) -> None:
    path = tmp_path / "nested" / "aegis.db"
    status = db.initialize(path)
    assert path.exists()
    assert status.ok and status.schema_version == db.LATEST_SCHEMA_VERSION
    assert status.journal_mode == "wal"
    conn = sqlite3.connect(path)
    try:
        versions = [row[0] for row in conn.execute("SELECT version FROM schema_migrations ORDER BY version")]
        assert versions == [m.version for m in db.MIGRATIONS]
        created = conn.execute("SELECT value FROM app_meta WHERE key = 'created_at'").fetchone()
        assert created is not None
    finally:
        conn.close()


def test_initialize_is_idempotent(tmp_path: Path) -> None:
    path = tmp_path / "aegis.db"
    db.initialize(path)
    db.initialize(path)
    conn = sqlite3.connect(path)
    try:
        assert conn.execute("SELECT COUNT(*) FROM schema_migrations").fetchone()[0] == len(db.MIGRATIONS)
        assert conn.execute("SELECT COUNT(*) FROM app_meta").fetchone()[0] == 1
    finally:
        conn.close()


def test_newer_schema_than_build_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "aegis.db"
    db.initialize(path)
    conn = sqlite3.connect(path)
    conn.execute("INSERT INTO schema_migrations VALUES (999, 'future', 'x')")
    conn.commit()
    conn.close()
    with pytest.raises(RuntimeError, match="newer"):
        db.initialize(path)


def test_failed_migration_rolls_back(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    broken = db.Migration(version=2, name="broken", statements=("CREATE TABLE t (x)", "NOT VALID SQL"))
    monkeypatch.setattr(db, "MIGRATIONS", (*db.MIGRATIONS, broken))
    monkeypatch.setattr(db, "LATEST_SCHEMA_VERSION", 2)
    path = tmp_path / "aegis.db"
    with pytest.raises(sqlite3.OperationalError):
        db.initialize(path)
    conn = sqlite3.connect(path)
    try:
        assert conn.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0] == 1
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert "t" not in tables
    finally:
        conn.close()


def test_probe_reports_missing_database(tmp_path: Path) -> None:
    status = db.probe(tmp_path / "absent.db")
    assert status.ok is False
    assert not (tmp_path / "absent.db").exists()
