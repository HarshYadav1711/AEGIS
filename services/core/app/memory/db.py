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
    # Table rebuilds (SQLite's documented 12-step ALTER) need foreign keys off outside the transaction;
    # integrity is re-checked with PRAGMA foreign_key_check before commit.
    foreign_keys_off: bool = False


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
    Migration(
        version=5,
        name="adaptive_memory",
        statements=(
            # Internal events memory was derived from or changed by. References only, never message or file content.
            """
            CREATE TABLE memory_events (
                id              TEXT PRIMARY KEY,
                kind            TEXT NOT NULL CHECK (kind IN (
                                    'remember', 'extracted', 'task_outcome', 'added', 'corrected', 'confirmed',
                                    'rejected', 'deleted', 'refused', 'settings')),
                source_type     TEXT NOT NULL CHECK (source_type IN (
                                    'user_message', 'memory_ui', 'file_task', 'research_task')),
                source_id       TEXT,
                conversation_id TEXT,
                detail          TEXT NOT NULL,
                at              TEXT NOT NULL
            )
            """,
            # A message or task is captured at most once, whatever retries happen.
            """
            CREATE UNIQUE INDEX memory_events_capture_once ON memory_events(kind, source_type, source_id)
            WHERE source_id IS NOT NULL AND kind IN ('remember', 'extracted', 'task_outcome')
            """,
            # One row per version. Content is immutable: a correction inserts a new version of the same lineage
            # and marks the old one superseded, so history is never overwritten.
            """
            CREATE TABLE memory_facts (
                id              TEXT PRIMARY KEY,
                lineage_id      TEXT NOT NULL,
                version         INTEGER NOT NULL CHECK (version >= 1),
                kind            TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'inference', 'experience')),
                subject         TEXT,
                content         TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 500),
                normalized      TEXT NOT NULL,
                scope           TEXT NOT NULL CHECK (scope = 'global' OR scope LIKE 'project:_%'),
                status          TEXT NOT NULL CHECK (status IN (
                                    'candidate', 'active', 'disputed', 'superseded', 'rejected')),
                verification    TEXT NOT NULL CHECK (verification IN (
                                    'user_stated', 'user_confirmed', 'tool_verified', 'model_proposed')),
                source_event_id TEXT NOT NULL REFERENCES memory_events(id),
                supersedes_id   TEXT REFERENCES memory_facts(id),
                -- No FK: the replacement may later be deleted; the dangling id still records what happened.
                superseded_by   TEXT,
                conflicts_with  TEXT REFERENCES memory_facts(id) ON DELETE SET NULL,
                observed_at     TEXT NOT NULL,
                recorded_at     TEXT NOT NULL,
                expires_at      TEXT,
                status_at       TEXT NOT NULL,
                status_reason   TEXT,
                UNIQUE (lineage_id, version),
                CHECK (status != 'superseded' OR superseded_by IS NOT NULL),
                -- A model proposal is never current truth until the user confirms or restates it.
                CHECK (verification != 'model_proposed' OR status != 'active'),
                CHECK ((kind = 'experience') = (verification = 'tool_verified'))
            )
            """,
            # Deduplication and one live version per lineage, enforced by the database.
            """
            CREATE UNIQUE INDEX memory_facts_live_unique ON memory_facts(scope, normalized)
            WHERE status IN ('candidate', 'active', 'disputed')
            """,
            """
            CREATE UNIQUE INDEX memory_facts_lineage_live ON memory_facts(lineage_id)
            WHERE status IN ('candidate', 'active', 'disputed')
            """,
            "CREATE INDEX memory_facts_recorded ON memory_facts(recorded_at DESC)",
            """
            CREATE TRIGGER memory_facts_immutable
            BEFORE UPDATE OF lineage_id, version, kind, subject, content, normalized, scope, source_event_id,
                             supersedes_id, observed_at, recorded_at
            ON memory_facts
            BEGIN
                SELECT RAISE(ABORT, 'memory fact versions are immutable');
            END
            """,
            """
            CREATE VIRTUAL TABLE memory_fts USING fts5(
                content, subject, content='memory_facts', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
            )
            """,
            """
            CREATE TRIGGER memory_facts_fts_insert AFTER INSERT ON memory_facts BEGIN
                INSERT INTO memory_fts(rowid, content, subject) VALUES (new.rowid, new.content, coalesce(new.subject, ''));
            END
            """,
            """
            CREATE TRIGGER memory_facts_fts_delete AFTER DELETE ON memory_facts BEGIN
                INSERT INTO memory_fts(memory_fts, rowid, content, subject)
                VALUES ('delete', old.rowid, old.content, coalesce(old.subject, ''));
            END
            """,
            # Which memory versions were put into which reply's context (audit, never model-claimed).
            """
            CREATE TABLE memory_retrievals (
                message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
                fact_id    TEXT NOT NULL REFERENCES memory_facts(id) ON DELETE CASCADE,
                rank       INTEGER NOT NULL,
                PRIMARY KEY (message_id, fact_id)
            )
            """,
            "CREATE INDEX memory_retrievals_fact ON memory_retrievals(fact_id)",
        ),
    ),
    Migration(
        version=6,
        name="vault_index",
        statements=(
            # A user-selected Obsidian-compatible folder. The Markdown files are the authority for note
            # content; these tables are a rebuildable index plus AEGIS's own observation history.
            # write_area is NULL (read-only) or the one sub-folder AEGIS may create notes in.
            """
            CREATE TABLE vaults (
                id              TEXT PRIMARY KEY,
                root_path       TEXT NOT NULL,
                root_identity   TEXT NOT NULL UNIQUE,
                kind            TEXT NOT NULL CHECK (kind IN ('existing', 'new')),
                write_area      TEXT CHECK (write_area IS NULL OR write_area = 'AEGIS'),
                created_at      TEXT NOT NULL,
                indexed_at      TEXT,
                index_status    TEXT NOT NULL CHECK (index_status IN ('never', 'indexing', 'ok', 'partial', 'failed')),
                index_detail    TEXT NOT NULL
            )
            """,
            # One row per note path AEGIS has seen. file_id (volume:file index) follows renames.
            # author comes only from AEGIS's own write records, never from a note's frontmatter.
            """
            CREATE TABLE vault_notes (
                id              TEXT PRIMARY KEY,
                vault_id        TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
                rel_path        TEXT NOT NULL,
                file_id         TEXT,
                status          TEXT NOT NULL CHECK (status IN (
                                    'indexed', 'skipped_secret', 'skipped_large', 'unreadable', 'deleted')),
                author          TEXT NOT NULL CHECK (author IN ('user', 'aegis_user')),
                title           TEXT NOT NULL,
                tags            TEXT NOT NULL,
                links           TEXT NOT NULL,
                size            INTEGER,
                mtime_ns        INTEGER,
                sha256          TEXT,
                version         INTEGER NOT NULL CHECK (version >= 1),
                first_seen_at   TEXT NOT NULL,
                indexed_at      TEXT NOT NULL,
                deleted_at      TEXT,
                UNIQUE (vault_id, rel_path)
            )
            """,
            "CREATE INDEX vault_notes_file ON vault_notes(vault_id, file_id)",
            # Evidence identity over time: every observed content state (hash only, no text).
            # valid time = file modification time; recorded time = when AEGIS observed it.
            """
            CREATE TABLE vault_note_versions (
                id          TEXT PRIMARY KEY,
                note_id     TEXT NOT NULL REFERENCES vault_notes(id) ON DELETE CASCADE,
                version     INTEGER NOT NULL,
                change      TEXT NOT NULL CHECK (change IN ('created', 'modified', 'renamed', 'deleted', 'restored')),
                rel_path    TEXT NOT NULL,
                sha256      TEXT,
                size        INTEGER,
                modified_at TEXT,
                observed_at TEXT NOT NULL,
                UNIQUE (note_id, version)
            )
            """,
            # Notes AEGIS itself wrote (exclusive create into the write area): the only source of author=aegis_user.
            """
            CREATE TABLE vault_writes (
                id          TEXT PRIMARY KEY,
                vault_id    TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
                rel_path    TEXT NOT NULL,
                file_id     TEXT NOT NULL,
                sha256      TEXT NOT NULL,
                written_at  TEXT NOT NULL,
                UNIQUE (vault_id, rel_path)
            )
            """,
            "CREATE VIRTUAL TABLE vault_fts USING fts5(title, tags, body, tokenize='unicode61 remove_diacritics 2')",
        ),
    ),
    Migration(
        version=7,
        name="repo_intelligence",
        foreign_keys_off=True,
        statements=(
            # memory_events gains the 'repo_task' source type (CHECK constraints need a table rebuild).
            """
            CREATE TABLE memory_events_v7 (
                id              TEXT PRIMARY KEY,
                kind            TEXT NOT NULL CHECK (kind IN (
                                    'remember', 'extracted', 'task_outcome', 'added', 'corrected', 'confirmed',
                                    'rejected', 'deleted', 'refused', 'settings')),
                source_type     TEXT NOT NULL CHECK (source_type IN (
                                    'user_message', 'memory_ui', 'file_task', 'research_task', 'repo_task')),
                source_id       TEXT,
                conversation_id TEXT,
                detail          TEXT NOT NULL,
                at              TEXT NOT NULL
            )
            """,
            "INSERT INTO memory_events_v7 SELECT id, kind, source_type, source_id, conversation_id, detail, at "
            "FROM memory_events",
            "DROP TABLE memory_events",
            "ALTER TABLE memory_events_v7 RENAME TO memory_events",
            """
            CREATE UNIQUE INDEX memory_events_capture_once ON memory_events(kind, source_type, source_id)
            WHERE source_id IS NOT NULL AND kind IN ('remember', 'extracted', 'task_outcome')
            """,
            # One row per read-only repository investigation. The repository root comes only from the native
            # picker; approval is bound to plan_digest, which covers the files to read and the exact memory and
            # vault-note versions proposed as context. scan_json is internal (snapshot for the unchanged check).
            """
            CREATE TABLE repo_tasks (
                id              TEXT PRIMARY KEY,
                request_text    TEXT NOT NULL,
                model           TEXT NOT NULL,
                status          TEXT NOT NULL CHECK (status IN (
                                    'awaiting_repo', 'awaiting_approval', 'inspecting', 'generating',
                                    'awaiting_save', 'completed', 'failed', 'cancelled', 'rejected')),
                root_path       TEXT,
                root_identity   TEXT,
                repo_name       TEXT,
                plan_json       TEXT,
                plan_digest     TEXT,
                scan_json       TEXT,
                vault_consent   INTEGER NOT NULL DEFAULT 0,
                approval_at     TEXT,
                cancel_requested INTEGER NOT NULL DEFAULT 0,
                error_code      TEXT,
                error_detail    TEXT,
                evidence_json   TEXT,
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
            """
            CREATE TABLE repo_events (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id  TEXT NOT NULL REFERENCES repo_tasks(id) ON DELETE CASCADE,
                at       TEXT NOT NULL,
                kind     TEXT NOT NULL,
                detail   TEXT NOT NULL
            )
            """,
            "CREATE INDEX repo_tasks_created ON repo_tasks(created_at DESC)",
            "CREATE INDEX repo_events_task ON repo_events(task_id, id)",
        ),
    ),
    Migration(
        version=8,
        name="voice_input",
        foreign_keys_off=True,
        statements=(
            # Whether a user message was typed or spoken (transcribed locally and shown to the user before sending).
            # Raw audio is never stored anywhere.
            "ALTER TABLE messages ADD COLUMN input_mode TEXT NOT NULL DEFAULT 'text' "
            "CHECK (input_mode IN ('text', 'voice'))",
            # memory_events gains the 'voice_command' source type (a reviewed spoken memory correction).
            """
            CREATE TABLE memory_events_v8 (
                id              TEXT PRIMARY KEY,
                kind            TEXT NOT NULL CHECK (kind IN (
                                    'remember', 'extracted', 'task_outcome', 'added', 'corrected', 'confirmed',
                                    'rejected', 'deleted', 'refused', 'settings')),
                source_type     TEXT NOT NULL CHECK (source_type IN (
                                    'user_message', 'memory_ui', 'file_task', 'research_task', 'repo_task',
                                    'voice_command')),
                source_id       TEXT,
                conversation_id TEXT,
                detail          TEXT NOT NULL,
                at              TEXT NOT NULL
            )
            """,
            "INSERT INTO memory_events_v8 SELECT id, kind, source_type, source_id, conversation_id, detail, at "
            "FROM memory_events",
            "DROP TABLE memory_events",
            "ALTER TABLE memory_events_v8 RENAME TO memory_events",
            """
            CREATE UNIQUE INDEX memory_events_capture_once ON memory_events(kind, source_type, source_id)
            WHERE source_id IS NOT NULL AND kind IN ('remember', 'extracted', 'task_outcome')
            """,
            # A spoken correction (identified by its client request id) is applied at most once, whatever retries.
            """
            CREATE UNIQUE INDEX memory_events_voice_once ON memory_events(source_id)
            WHERE source_type = 'voice_command'
            """,
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
        if migration.foreign_keys_off:
            conn.execute("PRAGMA foreign_keys = OFF")
        conn.execute("BEGIN IMMEDIATE")
        try:
            for statement in migration.statements:
                conn.execute(statement)
            if migration.foreign_keys_off and conn.execute("PRAGMA foreign_key_check").fetchone() is not None:
                raise RuntimeError(f"Migration {migration.version} would break foreign keys; not applied.")
            conn.execute(
                "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
                (migration.version, migration.name, datetime.now(timezone.utc).isoformat()),
            )
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        finally:
            conn.execute("PRAGMA foreign_keys = ON")
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
