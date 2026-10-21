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
    Migration(
        version=2,
        name="conversations",
        statements=(
            """
            CREATE TABLE conversations (
                id         TEXT PRIMARY KEY,
                title      TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """,
            # One row per user prompt or assistant reply. An assistant row is created
            # as 'pending' before the provider is called and always ends in exactly one
            # terminal status; 'complete' is written only after the provider signalled
            # a normal finish.
            """
            CREATE TABLE messages (
                id                TEXT PRIMARY KEY,
                conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                seq               INTEGER NOT NULL,
                role              TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
                content           TEXT NOT NULL,
                status            TEXT NOT NULL
                                  CHECK (status IN ('pending', 'streaming', 'complete', 'failed', 'cancelled')),
                reply_to          TEXT REFERENCES messages(id),
                client_request_id TEXT,
                provider          TEXT,
                model             TEXT,
                error_code        TEXT,
                error_detail      TEXT,
                finish_reason     TEXT,
                prompt_tokens     INTEGER,
                completion_tokens INTEGER,
                duration_ms       INTEGER,
                created_at        TEXT NOT NULL,
                completed_at      TEXT,
                UNIQUE (conversation_id, seq),
                CHECK ((role = 'user') = (client_request_id IS NOT NULL))
            )
            """,
            # Idempotency: a retried send with the same request id never creates a second turn.
            "CREATE UNIQUE INDEX messages_client_request ON messages(client_request_id)",
            # At most one generation in flight per conversation, enforced by the database.
            """
            CREATE UNIQUE INDEX messages_one_active_generation ON messages(conversation_id)
            WHERE status IN ('pending', 'streaming')
            """,
            "CREATE INDEX conversations_updated ON conversations(updated_at DESC)",
        ),
    ),
    Migration(
        version=3,
        name="file_task_journal",
        statements=(
            # One row per user request that was interpreted as a file-organization task.
            # root_path is set only from the trusted folder picker (via Electron main).
            """
            CREATE TABLE file_tasks (
                id                 TEXT PRIMARY KEY,
                request_text       TEXT NOT NULL,
                intent             TEXT NOT NULL CHECK (intent IN ('organize_by_type')),
                intent_source      TEXT NOT NULL CHECK (intent_source IN ('model', 'keyword_fallback')),
                intent_model       TEXT,
                intent_detail      TEXT NOT NULL,
                status             TEXT NOT NULL CHECK (status IN (
                                       'awaiting_folder', 'planning', 'awaiting_approval', 'executing',
                                       'completed', 'partial', 'failed', 'unknown', 'cancelled', 'rejected')),
                root_path          TEXT,
                root_identity      TEXT,
                current_plan_id    TEXT,
                approval_decision  TEXT CHECK (approval_decision IN ('approved', 'rejected')),
                approval_plan_id   TEXT,
                approval_at        TEXT,
                cancel_requested   INTEGER NOT NULL DEFAULT 0,
                error_code         TEXT,
                error_detail       TEXT,
                created_at         TEXT NOT NULL,
                updated_at         TEXT NOT NULL,
                started_at         TEXT,
                finished_at        TEXT
            )
            """,
            # Immutable once written: a re-plan creates a new row and supersedes the old one.
            """
            CREATE TABLE file_plans (
                id            TEXT PRIMARY KEY,
                task_id       TEXT NOT NULL REFERENCES file_tasks(id) ON DELETE CASCADE,
                digest        TEXT NOT NULL,
                status        TEXT NOT NULL CHECK (status IN (
                                  'awaiting_approval', 'approved', 'rejected', 'superseded', 'cancelled')),
                root_path     TEXT NOT NULL,
                root_identity TEXT NOT NULL,
                created_at    TEXT NOT NULL,
                expires_at    TEXT NOT NULL
            )
            """,
            # Planned operations and their execution journal. A 'move' is written as 'started'
            # before the filesystem call, so a crash leaves evidence of what may have happened.
            """
            CREATE TABLE file_operations (
                id            TEXT PRIMARY KEY,
                plan_id       TEXT NOT NULL REFERENCES file_plans(id) ON DELETE CASCADE,
                seq           INTEGER NOT NULL,
                action        TEXT NOT NULL CHECK (action IN ('move', 'skip')),
                source_name   TEXT NOT NULL,
                category      TEXT,
                dest_rel      TEXT,
                size          INTEGER,
                mtime_ns      INTEGER,
                file_id       TEXT,
                sha256        TEXT,
                plan_reason   TEXT,
                status        TEXT NOT NULL CHECK (status IN (
                                  'planned', 'skipped', 'started', 'verified', 'failed', 'unknown', 'not_attempted')),
                detail        TEXT,
                verification  TEXT,
                started_at    TEXT,
                finished_at   TEXT,
                UNIQUE (plan_id, seq)
            )
            """,
            # Append-only audit trail of workflow events (no file contents).
            """
            CREATE TABLE file_task_events (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id  TEXT NOT NULL REFERENCES file_tasks(id) ON DELETE CASCADE,
                at       TEXT NOT NULL,
                kind     TEXT NOT NULL,
                detail   TEXT NOT NULL
            )
            """,
            "CREATE INDEX file_tasks_updated ON file_tasks(updated_at DESC)",
            "CREATE INDEX file_plans_task ON file_plans(task_id)",
            "CREATE INDEX file_task_events_task ON file_task_events(task_id, id)",
        ),
    ),
    Migration(
        version=4,
        name="research_journal",
        statements=(
            # One row per research request. The source list is fixed when the plan is made
            # (only URLs the user typed); approval is bound to plan_digest.
            """
            CREATE TABLE research_tasks (
                id              TEXT PRIMARY KEY,
                request_text    TEXT NOT NULL,
                question        TEXT NOT NULL,
                key_terms       TEXT NOT NULL,
                plan_source     TEXT NOT NULL CHECK (plan_source IN ('model', 'keyword_fallback')),
                plan_model      TEXT,
                plan_detail     TEXT NOT NULL,
                plan_digest     TEXT NOT NULL,
                model           TEXT,
                status          TEXT NOT NULL CHECK (status IN (
                                    'awaiting_approval', 'researching', 'generating', 'awaiting_save',
                                    'completed', 'failed', 'cancelled', 'rejected')),
                approval_at     TEXT,
                cancel_requested INTEGER NOT NULL DEFAULT 0,
                error_code      TEXT,
                error_detail    TEXT,
                report_json     TEXT,
                report_markdown TEXT,
                report_sha256   TEXT,
                saved_path      TEXT,
                saved_at        TEXT,
                created_at      TEXT NOT NULL,
                updated_at      TEXT NOT NULL,
                started_at      TEXT,
                finished_at     TEXT
            )
            """,
            # Provenance of every source considered: what was asked for, what was fetched,
            # and the bounded extracted text the report was built from.
            """
            CREATE TABLE research_sources (
                id            TEXT PRIMARY KEY,
                task_id       TEXT NOT NULL REFERENCES research_tasks(id) ON DELETE CASCADE,
                seq           INTEGER NOT NULL,
                requested_url TEXT NOT NULL,
                final_url     TEXT,
                canonical_url TEXT,
                status        TEXT NOT NULL CHECK (status IN (
                                  'planned', 'rejected', 'fetching', 'extracted', 'failed', 'blocked', 'skipped')),
                code          TEXT,
                detail        TEXT,
                http_status   INTEGER,
                content_type  TEXT,
                title         TEXT,
                sha256        TEXT,
                bytes         INTEGER,
                text_chars    INTEGER,
                truncated     INTEGER NOT NULL DEFAULT 0,
                redirects     TEXT,
                text          TEXT,
                retrieved_at  TEXT,
                UNIQUE (task_id, seq)
            )
            """,
            """
            CREATE TABLE research_events (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id  TEXT NOT NULL REFERENCES research_tasks(id) ON DELETE CASCADE,
                at       TEXT NOT NULL,
                kind     TEXT NOT NULL,
                detail   TEXT NOT NULL
            )
            """,
            "CREATE INDEX research_tasks_updated ON research_tasks(updated_at DESC)",
            "CREATE INDEX research_events_task ON research_events(task_id, id)",
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
