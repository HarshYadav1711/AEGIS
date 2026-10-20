"""files.plan_organize / files.move_approved / verification (ADR-007).

Planning is pure deterministic code: list the direct children of the scope
root (never following links), classify each file by extension and propose
`<root>/<Category>/<name>`. Execution moves one planned file at a time with a
no-overwrite primitive, after re-validating everything the plan assumed, and
reports success only after observing the file at its destination.

Nothing here deletes, overwrites, copies, opens for writing or executes files.
The only mutations are creating a category folder inside the root and renaming
a planned file into it.
"""

from __future__ import annotations

import errno
import hashlib
import os
import stat
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from app.tools.file_scope import (
    Scope,
    ScopeError,
    check_scope_unchanged,
    child_path,
    identity_of,
    is_hidden_or_system,
    is_link_like,
    same_path,
)
from app.tools.file_types import Category, classify

MAX_ENTRIES = 2000
HASH_MAX_FILE_BYTES = 64 * 1024 * 1024
HASH_MAX_TOTAL_BYTES = 512 * 1024 * 1024
_CHUNK = 1024 * 1024


@dataclass(frozen=True)
class PlannedOperation:
    seq: int
    action: Literal["move", "skip"]
    source_name: str
    category: Category | None
    dest_rel: str | None
    size: int | None
    mtime_ns: int | None
    file_id: str | None
    sha256: str | None
    reason: str | None


@dataclass(frozen=True)
class OperationOutcome:
    status: Literal["verified", "failed", "unknown"]
    detail: str
    verification: dict[str, Any] = field(default_factory=dict)
    created_folder: bool = False


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:  # read-only
        while chunk := handle.read(_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def _folder_problem(scope: Scope, category: str) -> str | None:
    """Why the category folder cannot receive files, or None if it can (exists as a folder or is absent)."""
    path = child_path(scope, category)
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return None
    if is_link_like(st):
        return f"'{category}' is a link or junction; AEGIS will not move files through it."
    if not stat.S_ISDIR(st.st_mode):
        return f"A file named '{category}' already occupies the destination folder name."
    return None


def build_plan(scope: Scope) -> list[PlannedOperation]:
    """List direct children of the root and propose a move or an explained skip for each."""
    check_scope_unchanged(scope)
    with os.scandir(scope.root) as iterator:
        entries = []
        for entry in iterator:
            entries.append(entry)
            if len(entries) > MAX_ENTRIES:
                raise ScopeError("too_many_entries", f"The folder has more than {MAX_ENTRIES} entries.")
    entries.sort(key=lambda e: (e.name.casefold(), e.name))

    folder_problems: dict[str, str | None] = {}
    hashed_total = 0
    ops: list[PlannedOperation] = []

    def skip(name: str, reason: str, category: Category | None = None) -> None:
        ops.append(PlannedOperation(len(ops) + 1, "skip", name, category, None, None, None, None, None, reason))

    for entry in entries:
        name = entry.name
        try:
            # os.lstat, not DirEntry.stat: on Windows the latter leaves st_ino/st_dev unset (0).
            st = os.lstat(entry.path)
        except OSError:
            skip(name, "Could not be inspected; left untouched.")
            continue
        if is_link_like(st) or entry.is_junction():
            skip(name, "Link, junction or reparse point; not followed or moved.")
            continue
        if stat.S_ISDIR(st.st_mode):
            skip(name, "Folder; only files directly inside the selected folder are organized.")
            continue
        if not stat.S_ISREG(st.st_mode):
            skip(name, "Not a regular file; left untouched.")
            continue
        if is_hidden_or_system(name, st):
            skip(name, "Hidden, system or dot-file (for example .env); protected and left untouched.")
            continue

        category = classify(name)
        if category not in folder_problems:
            folder_problems[category] = _folder_problem(scope, category)
        if (problem := folder_problems[category]) is not None:
            skip(name, problem, category)
            continue
        if same_path(child_path(scope, category), entry.path):
            skip(name, "The file is itself named like its destination folder.", category)
            continue
        dest = child_path(scope, category, name)
        if os.path.lexists(dest):
            skip(name, f"Conflict: {category}/{name} already exists; nothing is overwritten.", category)
            continue

        digest: str | None = None
        if st.st_size <= HASH_MAX_FILE_BYTES and hashed_total + st.st_size <= HASH_MAX_TOTAL_BYTES:
            try:
                digest = sha256_file(Path(entry.path))
                hashed_total += st.st_size
            except OSError:
                skip(name, "Could not be read for its integrity hash (locked or inaccessible); left untouched.")
                continue
        ops.append(
            PlannedOperation(
                seq=len(ops) + 1,
                action="move",
                source_name=name,
                category=category,
                dest_rel=f"{category}/{name}",
                size=st.st_size,
                mtime_ns=st.st_mtime_ns,
                file_id=identity_of(st),
                sha256=digest,
                reason=None,
            )
        )
    return ops


def _move_no_overwrite(src: Path, dst: Path) -> None:
    if sys.platform == "win32":
        os.rename(src, dst)  # MoveFileExW without REPLACE_EXISTING: fails if dst exists
    else:  # pragma: no cover - Windows-first; POSIX rename would overwrite
        os.link(src, dst)
        os.unlink(src)


def _ensure_category_folder(scope: Scope, category: str) -> tuple[Path, bool]:
    folder = child_path(scope, category)
    created = False
    try:
        os.mkdir(folder)
        created = True
    except FileExistsError:
        pass
    st = os.lstat(folder)
    if is_link_like(st) or not stat.S_ISDIR(st.st_mode):
        raise ScopeError("destination_changed", f"'{category}' is no longer an ordinary folder.")
    if not same_path(os.path.realpath(folder), folder):
        raise ScopeError("destination_changed", f"'{category}' now resolves outside the selected folder.")
    return folder, created


def _source_matches(st: os.stat_result, op: PlannedOperation) -> bool:
    return (
        stat.S_ISREG(st.st_mode)
        and not is_link_like(st)
        and identity_of(st) == op.file_id
        and st.st_size == op.size
        and st.st_mtime_ns == op.mtime_ns
    )


def verify_move(scope: Scope, op: PlannedOperation) -> OperationOutcome:
    """Observe the filesystem and decide whether the planned move demonstrably happened."""
    assert op.category is not None
    src = child_path(scope, op.source_name)
    dst = child_path(scope, op.category, op.source_name)
    checks: dict[str, Any] = {"source_absent": not os.path.lexists(src)}
    try:
        st = os.lstat(dst)
    except FileNotFoundError:
        checks["destination_present"] = False
        return OperationOutcome("unknown", "The file is not at its destination.", checks)
    checks["destination_present"] = True
    checks["regular_file"] = stat.S_ISREG(st.st_mode) and not is_link_like(st)
    checks["same_file_id"] = identity_of(st) == op.file_id
    checks["size_match"] = st.st_size == op.size
    checks["mtime_match"] = st.st_mtime_ns == op.mtime_ns
    checks["inside_scope"] = same_path(os.path.realpath(dst), dst) and same_path(dst.parent.parent, scope.root)
    if op.sha256 is not None:
        try:
            checks["sha256_match"] = sha256_file(dst) == op.sha256
        except OSError:
            checks["sha256_match"] = False
    else:
        checks["sha256_match"] = None  # not hashed (size limit); identity and size are the evidence
    ok = all(v is not False for v in checks.values())
    if ok:
        return OperationOutcome("verified", f"Moved to {op.dest_rel} and verified.", checks)
    return OperationOutcome("unknown", "The file was found at the destination but did not match the plan.", checks)


def execute_move(scope: Scope, op: PlannedOperation) -> OperationOutcome:
    """Re-validate, move one file without overwriting, then verify. Never raises for filesystem problems."""
    assert op.action == "move" and op.category is not None
    created = False
    try:
        check_scope_unchanged(scope)
        src = child_path(scope, op.source_name)
        try:
            st = os.lstat(src)
        except FileNotFoundError:
            return OperationOutcome("failed", "The file is no longer in the folder; nothing was moved.")
        if not _source_matches(st, op):
            return OperationOutcome("failed", "The file changed since the plan was approved; it was not moved.")
        _, created = _ensure_category_folder(scope, op.category)
        dst = child_path(scope, op.category, op.source_name)
        if os.path.lexists(dst):
            return OperationOutcome(
                "failed", f"{op.dest_rel} appeared after planning; nothing was overwritten.", created_folder=created
            )
        try:
            _move_no_overwrite(src, dst)
        except FileExistsError:
            return OperationOutcome(
                "failed", f"{op.dest_rel} already exists; nothing was overwritten.", created_folder=created
            )
        except OSError as error:
            # The call failed; look at what is actually on disk before saying anything.
            outcome = reconcile_move(scope, op)
            if outcome.status == "failed":
                reason = os.strerror(error.errno) if error.errno else "operating system error"
                if error.errno in (errno.EACCES, errno.EPERM) or getattr(error, "winerror", None) == 32:
                    reason = "the file is in use or access was denied"
                return OperationOutcome("failed", f"Move failed ({reason}); the file was left in place.",
                                        outcome.verification, created)
            return OperationOutcome(outcome.status, outcome.detail, outcome.verification, created)
    except ScopeError as error:
        return OperationOutcome("failed", error.detail, created_folder=created)
    outcome = verify_move(scope, op)
    return OperationOutcome(outcome.status, outcome.detail, outcome.verification, created)


def reconcile_move(scope: Scope, op: PlannedOperation) -> OperationOutcome:
    """After an ambiguous failure or crash: classify an operation by what the filesystem shows."""
    assert op.category is not None
    src = child_path(scope, op.source_name)
    dst = child_path(scope, op.category, op.source_name)
    try:
        src_st = os.lstat(src)
    except FileNotFoundError:
        src_st = None
    if src_st is not None and _source_matches(src_st, op) and not os.path.lexists(dst):
        return OperationOutcome("failed", "Not moved: the file is still in its original place.",
                                {"source_present": True, "destination_present": False})
    if src_st is None and os.path.lexists(dst):
        return verify_move(scope, op)
    return OperationOutcome(
        "unknown",
        "The file's state could not be confirmed; inspect the folder before retrying.",
        {"source_present": src_st is not None, "destination_present": os.path.lexists(dst)},
    )
