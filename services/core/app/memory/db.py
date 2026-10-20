"""SQLite initialisation with explicit, versioned migrations.

Migrations are append-only: never edit a released migration, add a new one.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


@dataclass(frozen=True)
class Migration:
    version: int
    name: str
    statements: tuple[str, ...]


MIGRATIONS: tuple[Migration, ...] = (
    Migration(
        version=1,
        name="baseline",
        statements=(
            """
            CREATE TABLE app_meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
            """,
            "INSERT INTO app_meta (key, value) VALUES ('created_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        ),
    ),
)

LATEST_SCHEMA_VERSION = MIGRATIONS[-1].version


@dataclass(frozen=True)
class DatabaseStatus:
    ok: bool
    schema_version: int | None
    journal_mode: str | None
    fts5_available: bool | None


def connect(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path, timeout=5.0, isolation_level=None)
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _current_version(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT COALESCE(MAX(version), 0) FROM schema_migrations").fetchone()
    return int(row[0])


def apply_migrations(conn: sqlite3.Connection) -> int:
    """Apply pending migrations, each in its own transaction. Returns the resulting version."""
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version    INTEGER PRIMARY KEY,
            name       TEXT NOT NULL,
            applied_at TEXT NOT NULL
        )
        """
    )
    current = _current_version(conn)
    if current > LATEST_SCHEMA_VERSION:
        raise RuntimeError(
            f"Database schema version {current} is newer than this build supports ({LATEST_SCHEMA_VERSION})."
        )
    for migration in MIGRATIONS:
        if migration.version <= current:
            continue
        conn.execute("BEGIN IMMEDIATE")
        try:
            for statement in migration.statements:
                conn.execute(statement)
            conn.execute(
                "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
                (migration.version, migration.name, datetime.now(timezone.utc).isoformat()),
            )
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
    return _current_version(conn)


def fts5_available(conn: sqlite3.Connection) -> bool:
    """Probe FTS5 support with a throwaway temp table (no persistent change)."""
    try:
        conn.execute("CREATE VIRTUAL TABLE temp._aegis_fts5_probe USING fts5(body)")
        conn.execute("DROP TABLE temp._aegis_fts5_probe")
        return True
    except sqlite3.OperationalError:
        return False


def initialize(path: Path) -> DatabaseStatus:
    """Create the data directory and database if needed, enable WAL, run migrations."""
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = connect(path)
    try:
        journal_mode = str(conn.execute("PRAGMA journal_mode = WAL").fetchone()[0])
        version = apply_migrations(conn)
        return DatabaseStatus(
            ok=True,
            schema_version=version,
            journal_mode=journal_mode,
            fts5_available=fts5_available(conn),
        )
    finally:
        conn.close()


def probe(path: Path) -> DatabaseStatus:
    """Cheap liveness check of an initialised database, used by /health."""
    if not path.exists():
        return DatabaseStatus(ok=False, schema_version=None, journal_mode=None, fts5_available=None)
    conn = connect(path)
    try:
        journal_mode = str(conn.execute("PRAGMA journal_mode").fetchone()[0])
        version = _current_version(conn)
        return DatabaseStatus(
            ok=version == LATEST_SCHEMA_VERSION,
            schema_version=version,
            journal_mode=journal_mode,
            fts5_available=None,
        )
    finally:
        conn.close()
