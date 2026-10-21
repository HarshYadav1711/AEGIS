"""Vault index repository (M0A, schema v6).

Authority: the Markdown files are the source of truth for note content.
SQLite holds a derived, rebuildable search index (FTS5) plus AEGIS's own
observation history (content hashes per version, valid time = file mtime,
recorded time = when AEGIS saw it). Removing a vault from AEGIS deletes only
this index, never a file.

Vault text is untrusted data and never becomes system instructions or policy.
Since Phase 4 the only path into model context is `read_excerpt`: a bounded
excerpt of a note the user consented to for one repository task, read only if
the file still has the exact content hash that was shown at approval.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.memory.adaptive import contains_secret
from app.memory.db import connect
from app.tools import vault_scan as scan
from app.tools.file_scope import Scope, ScopeError, check_scope_unchanged, validate_root

STALE_AFTER_S = 10.0
_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


class VaultError(Exception):
    def __init__(self, code: str, detail: str) -> None:
        super().__init__(f"{code}: {detail}")
        self.code = code
        self.detail = detail


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class _closing:
    def __init__(self, path: Path) -> None:
        self._path = path

    def __enter__(self) -> sqlite3.Connection:
        self._conn = connect(self._path)
        self._conn.row_factory = sqlite3.Row
        return self._conn

    def __exit__(self, *exc: object) -> None:
        self._conn.close()


def _lock(vault_id: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(vault_id, threading.Lock())


# ------------------------------------------------------------------ vaults


def _vault(conn: sqlite3.Connection, vault_id: str) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM vaults WHERE id = ?", (vault_id,)).fetchone()
    if row is None:
        raise VaultError("vault_not_found", "This vault is not registered with AEGIS.")
    return dict(row)


def _scope(vault: dict[str, Any]) -> Scope:
    scope = Scope(Path(vault["root_path"]), vault["root_identity"])
    check_scope_unchanged(scope)
    return scope


def register(path: Path, raw_root: str, protected: tuple[Path, ...]) -> dict[str, Any]:
    scope = validate_root(raw_root, protected)
    kind = scan.classify_root(scope)
    vault_id, now = str(uuid.uuid4()), _now()
    with _closing(path) as conn:
        try:
            conn.execute(
                "INSERT INTO vaults (id, root_path, root_identity, kind, write_area, created_at, index_status, "
                "index_detail) VALUES (?, ?, ?, ?, ?, ?, 'never', 'Not indexed yet.')",
                # A new (empty) folder is AEGIS's own vault; an existing personal vault starts read-only.
                (vault_id, str(scope.root), scope.identity, kind, scan.WRITE_AREA if kind == "new" else None, now),
            )
        except sqlite3.IntegrityError:
            raise VaultError("vault_exists", "This folder is already registered as a vault.") from None
    reindex(path, vault_id)
    return describe(path, vault_id)


def describe(path: Path, vault_id: str) -> dict[str, Any]:
    with _closing(path) as conn:
        vault = _vault(conn, vault_id)
        counts = dict(conn.execute(
            "SELECT status, COUNT(*) FROM vault_notes WHERE vault_id = ? GROUP BY status", (vault_id,)
        ).fetchall())
    return {**vault, "counts": counts}


def list_vaults(path: Path) -> list[dict[str, Any]]:
    with _closing(path) as conn:
        ids = [r["id"] for r in conn.execute("SELECT id FROM vaults ORDER BY created_at")]
    return [describe(path, i) for i in ids]


def set_write_area(path: Path, vault_id: str, enabled: bool) -> dict[str, Any]:
    with _closing(path) as conn:
        _vault(conn, vault_id)
        conn.execute("UPDATE vaults SET write_area = ? WHERE id = ?", (scan.WRITE_AREA if enabled else None, vault_id))
    return describe(path, vault_id)


def remove(path: Path, vault_id: str) -> None:
    """Forget the vault: drop its index and history. Files on disk are never touched."""
    with _lock(vault_id), _closing(path) as conn:
        _vault(conn, vault_id)
        conn.execute("BEGIN IMMEDIATE")
        conn.execute("DELETE FROM vault_fts WHERE rowid IN (SELECT rowid FROM vault_notes WHERE vault_id = ?)", (vault_id,))
        conn.execute("DELETE FROM vaults WHERE id = ?", (vault_id,))
        conn.execute("COMMIT")


# ------------------------------------------------------------------ indexing


def reindex(path: Path, vault_id: str) -> dict[str, int]:
    """Incremental index: stat every note, read only changed ones, record each content change as a version."""
    with _lock(vault_id):
        with _closing(path) as conn:
            vault = _vault(conn, vault_id)
            known = {r["rel_path"]: dict(r) for r in conn.execute("SELECT * FROM vault_notes WHERE vault_id = ?", (vault_id,))}
            writes = {r["rel_path"]: r["sha256"] for r in conn.execute(
                "SELECT rel_path, sha256 FROM vault_writes WHERE vault_id = ?", (vault_id,))}
        try:
            scope = _scope(vault)
            walked = scan.walk(scope)
        except (ScopeError, OSError) as error:
            detail = error.detail if isinstance(error, ScopeError) else str(error)
            _finish(path, vault_id, "failed", f"Could not read the vault: {detail}")
            raise VaultError("vault_unavailable", f"The vault could not be read: {detail}") from None

        counts = {k: 0 for k in ("created", "modified", "renamed", "restored", "deleted", "unchanged",
                                 "skipped_secret", "skipped_large", "unreadable")}
        by_file_id = {n["file_id"]: n for n in known.values() if n["status"] != "deleted" and n["file_id"]}
        seen_paths = {n.rel_path for n in walked.notes} | {n.rel_path for n in walked.skipped_large}
        plan: list[tuple[str, scan.NoteFile, dict[str, Any] | None, scan.ParsedNote | None]] = []
        for note in walked.skipped_large:
            plan.append(("skipped_large", note, known.get(note.rel_path), None))
        for note in walked.notes:
            old = known.get(note.rel_path)
            if old is None and note.file_id in by_file_id and by_file_id[note.file_id]["rel_path"] not in seen_paths:
                old = by_file_id.pop(note.file_id)  # same file, new name: a rename in Obsidian or Explorer
            if (old and old["status"] != "deleted" and old["rel_path"] == note.rel_path and old["size"] == note.size
                    and old["mtime_ns"] == note.mtime_ns and old["file_id"] == note.file_id):
                counts["unchanged"] += 1
                continue
            try:
                parsed = scan.read_note(scope, note)
            except (ScopeError, OSError):
                plan.append(("unreadable", note, old, None))
                continue
            plan.append(("skipped_secret" if parsed.has_secret else "indexed", note, old, parsed))

        renamed_from = {old["rel_path"] for _, _, old, _ in plan if old and old["rel_path"] not in seen_paths}
        gone = [n for p, n in known.items() if n["status"] != "deleted" and p not in seen_paths and p not in renamed_from]
        now = _now()
        with _closing(path) as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                for status, note, old, parsed in plan:
                    change = _apply(conn, vault_id, status, note, old, parsed, writes, now)
                    counts[(change or "unchanged") if status == "indexed" else status] += 1
                for old in gone:
                    conn.execute("DELETE FROM vault_fts WHERE rowid = (SELECT rowid FROM vault_notes WHERE id = ?)", (old["id"],))
                    conn.execute(
                        "UPDATE vault_notes SET status = 'deleted', deleted_at = ?, indexed_at = ?, version = version + 1 "
                        "WHERE id = ?", (now, now, old["id"]))
                    _version(conn, old["id"], old["version"] + 1, "deleted", old["rel_path"], None, None, None, now)
                    counts["deleted"] += 1
                conn.execute("COMMIT")
            except BaseException:
                conn.execute("ROLLBACK")
                raise
        problems = counts["unreadable"] + int(walked.truncated)
        detail = (
            f"{counts['created']} new, {counts['modified']} changed, {counts['renamed']} renamed, "
            f"{counts['deleted']} deleted, {counts['unchanged']} unchanged; skipped {counts['skipped_secret']} "
            f"with secrets, {counts['skipped_large']} too large, {walked.skipped_links} links, "
            f"{counts['unreadable']} unreadable" + (f"; stopped at {scan.MAX_NOTES} notes" if walked.truncated else "")
        )
        _finish(path, vault_id, "partial" if problems else "ok", detail)
        return {**counts, "skipped_links": walked.skipped_links, "truncated": int(walked.truncated)}


def _apply(
    conn: sqlite3.Connection, vault_id: str, status: str, note: scan.NoteFile, old: dict[str, Any] | None,
    parsed: scan.ParsedNote | None, writes: dict[str, str], now: str,
) -> str | None:
    sha = parsed.sha256 if parsed else None
    # Authored by AEGIS only while the file is byte-identical to what AEGIS wrote; any outside edit makes it the user's.
    author = "aegis_user" if sha is not None and writes.get(note.rel_path) == sha else "user"
    indexed = status == "indexed" and parsed is not None
    title = parsed.title if indexed and parsed else Path(note.rel_path).stem
    tags = json.dumps(parsed.tags if indexed and parsed else [])
    links = json.dumps(parsed.links if indexed and parsed else [])
    if old is None:
        note_id, version, change = str(uuid.uuid4()), 1, "created"
        conn.execute(
            """INSERT INTO vault_notes (id, vault_id, rel_path, file_id, status, author, title, tags, links, size,
                   mtime_ns, sha256, version, first_seen_at, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)""",
            (note_id, vault_id, note.rel_path, note.file_id, status, author, title, tags, links, note.size,
             note.mtime_ns, sha, now, now),
        )
    else:
        note_id = old["id"]
        if old["status"] == "deleted":
            change = "restored"
        elif old["rel_path"] != note.rel_path:
            change = "renamed"
        elif old["sha256"] == sha and old["status"] == status:
            change = None  # touched but identical content: refresh stat only, no new version
        else:
            change = "modified"
        version = old["version"] + (1 if change else 0)
        conn.execute(
            """UPDATE vault_notes SET rel_path = ?, file_id = ?, status = ?, author = ?, title = ?, tags = ?, links = ?,
                   size = ?, mtime_ns = ?, sha256 = ?, version = ?, indexed_at = ?, deleted_at = NULL WHERE id = ?""",
            (note.rel_path, note.file_id, status, author, title, tags, links, note.size, note.mtime_ns, sha, version,
             now, note_id),
        )
        conn.execute("DELETE FROM vault_fts WHERE rowid = (SELECT rowid FROM vault_notes WHERE id = ?)", (note_id,))
    if indexed and parsed:
        conn.execute(
            "INSERT INTO vault_fts (rowid, title, tags, body) SELECT rowid, ?, ?, ? FROM vault_notes WHERE id = ?",
            (title, " ".join(parsed.tags), parsed.body, note_id),
        )
    if change:
        _version(conn, note_id, version, change, note.rel_path, sha, note.size, scan.modified_at(note.mtime_ns), now)
    return change


def _version(conn: sqlite3.Connection, note_id: str, version: int, change: str, rel_path: str, sha: str | None,
             size: int | None, modified: str | None, now: str) -> None:
    conn.execute(
        "INSERT INTO vault_note_versions (id, note_id, version, change, rel_path, sha256, size, modified_at, observed_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (str(uuid.uuid4()), note_id, version, change, rel_path, sha, size, modified, now),
    )


def _finish(path: Path, vault_id: str, status: str, detail: str) -> None:
    with _closing(path) as conn:
        conn.execute("UPDATE vaults SET index_status = ?, index_detail = ?, indexed_at = ? WHERE id = ?",
                     (status, detail, _now(), vault_id))


def refresh_stale(path: Path) -> None:
    """Pick up external edits before a search (stat-only for unchanged files)."""
    cutoff = datetime.now(timezone.utc).timestamp() - STALE_AFTER_S
    for vault in list_vaults(path):
        last = vault["indexed_at"]
        if last is None or datetime.fromisoformat(last).timestamp() < cutoff:
            try:
                reindex(path, vault["id"])
            except VaultError:
                pass  # recorded on the vault as index_status='failed'; search shows what is still indexed


# ------------------------------------------------------------------ reads and the one write


def _note_json(row: sqlite3.Row | dict[str, Any], root: str) -> dict[str, Any]:
    note = dict(row)
    return {
        "id": note["id"], "vault_id": note["vault_id"], "vault_root": root, "rel_path": note["rel_path"],
        "status": note["status"], "author": note["author"], "title": note["title"],
        "tags": json.loads(note["tags"]), "links": json.loads(note["links"]), "size": note["size"],
        "modified_at": scan.modified_at(note["mtime_ns"]) if note["mtime_ns"] else None,
        "sha256": note["sha256"], "version": note["version"], "first_seen_at": note["first_seen_at"],
        "indexed_at": note["indexed_at"], "deleted_at": note["deleted_at"], "snippet": note.get("snippet"),
    }


def search(path: Path, query: str, limit: int = 50) -> list[dict[str, Any]]:
    terms = []
    for word in "".join(ch if ch.isalnum() else " " for ch in query.casefold()).split():
        if word not in terms:
            terms.append(word)
    if not terms:
        return []
    match = " OR ".join(f'"{t}"*' for t in terms[:16])  # quoted: FTS5 operators in user text are inert
    with _closing(path) as conn:
        rows = conn.execute(
            """SELECT n.*, v.root_path, snippet(vault_fts, 2, '«', '»', ' … ', 14) AS snippet
               FROM vault_fts JOIN vault_notes n ON n.rowid = vault_fts.rowid JOIN vaults v ON v.id = n.vault_id
               WHERE vault_fts MATCH ? AND n.status = 'indexed' ORDER BY bm25(vault_fts, 5.0, 3.0, 1.0) LIMIT ?""",
            (match, limit),
        ).fetchall()
    return [_note_json(r, r["root_path"]) for r in rows]


def get_note(path: Path, note_id: str) -> dict[str, Any]:
    with _closing(path) as conn:
        row = conn.execute(
            "SELECT n.*, v.root_path FROM vault_notes n JOIN vaults v ON v.id = n.vault_id WHERE n.id = ?", (note_id,)
        ).fetchone()
        if row is None:
            raise VaultError("note_not_found", "This note is not in the index.")
        versions = [dict(r) for r in conn.execute(
            "SELECT version, change, rel_path, sha256, size, modified_at, observed_at FROM vault_note_versions "
            "WHERE note_id = ? ORDER BY version", (note_id,))]
    return {**_note_json(row, row["root_path"]), "versions": versions}


def note_path(path: Path, note_id: str) -> Path:
    """Absolute path of an indexed note for opening, re-validated against the vault scope right now."""
    note = get_note(path, note_id)
    if note["status"] == "deleted":
        raise VaultError("note_deleted", "This note was deleted from the vault.")
    with _closing(path) as conn:
        vault = _vault(conn, note["vault_id"])
    try:
        return scan.resolve(_scope(vault), note["rel_path"])
    except ScopeError as error:
        raise VaultError(error.code, error.detail) from None


def version_id(path: Path, note_id: str, version: int) -> str | None:
    with _closing(path) as conn:
        row = conn.execute("SELECT id FROM vault_note_versions WHERE note_id = ? AND version = ?",
                           (note_id, version)).fetchone()
    return row["id"] if row else None


def read_excerpt(path: Path, note_id: str, expected_sha256: str, terms: list[str], max_chars: int) -> dict[str, Any]:
    """Bounded excerpt of one note for model context, only if the file is still exactly the planned version.

    Used only after the user consented to these notes for one task (Phase 4). Returns a status instead of
    raising: 'used', 'stale' (content changed since it was proposed), 'unavailable' or 'withheld_secret'.
    """
    try:
        file_path = note_path(path, note_id)
        data = file_path.read_bytes()[: scan.MAX_NOTE_BYTES + 1]
    except (VaultError, OSError) as error:
        return {"status": "unavailable", "detail": getattr(error, "detail", None) or "The note could not be read."}
    current = hashlib.sha256(data).hexdigest()
    if current != expected_sha256:
        return {"status": "stale", "detail": f"The note changed after it was proposed (planned SHA-256 "
                                             f"{expected_sha256[:12]}…, now {current[:12]}…); it was not used.",
                "current_sha256": current}
    parsed = scan.parse(data, file_path.stem)
    if parsed.has_secret:
        return {"status": "withheld_secret", "detail": "The note now matches a secret pattern; it was not used."}
    paragraphs = [p.strip() for p in parsed.body.split("\n\n") if p.strip()]
    wanted = {t.casefold() for t in terms}
    ranked = sorted(range(len(paragraphs)),
                    key=lambda i: (-sum(w in paragraphs[i].casefold() for w in wanted), i))
    picked: list[int] = []
    used = 0
    for index in ranked:
        if used + len(paragraphs[index]) > max_chars and picked:
            continue
        picked.append(index)
        used += len(paragraphs[index])
        if used >= max_chars:
            break
    text = "\n\n".join(paragraphs[i] for i in sorted(picked))[:max_chars]
    return {"status": "used", "text": text, "chars": len(text)}


def add_note(path: Path, vault_id: str, title: str, body: str) -> dict[str, Any]:
    """Create a new note in the vault's AEGIS area (never overwrites), then index it."""
    if contains_secret(title) or contains_secret(body):
        raise VaultError("secret_detected", "This looks like a password, key or token; AEGIS does not store secrets.")
    with _closing(path) as conn:
        vault = _vault(conn, vault_id)
    if vault["write_area"] is None:
        raise VaultError("read_only_vault", "This vault is read-only for AEGIS. Allow the AEGIS folder first.")
    note_id = str(uuid.uuid4())
    try:
        with _lock(vault_id):
            written, data = scan.write_note(_scope(vault), title, body, note_id, _now())
    except ScopeError as error:
        raise VaultError(error.code, error.detail) from None
    with _closing(path) as conn:
        conn.execute(
            "INSERT INTO vault_writes (id, vault_id, rel_path, file_id, sha256, written_at) VALUES (?, ?, ?, ?, ?, ?)",
            (note_id, vault_id, written.rel_path, written.file_id, hashlib.sha256(data).hexdigest(), _now()),
        )
    reindex(path, vault_id)
    with _closing(path) as conn:
        row = conn.execute("SELECT id FROM vault_notes WHERE vault_id = ? AND rel_path = ?",
                           (vault_id, written.rel_path)).fetchone()
    return get_note(path, row["id"])
