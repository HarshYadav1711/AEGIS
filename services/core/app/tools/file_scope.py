"""Folder scope policy for the file tools.

A scope is one folder the user chose in the native picker. Everything the
file tools touch must be that folder or a direct child of it (or a category
subfolder created inside it). This module decides whether a folder is an
acceptable scope and inspects entries without following links.

The checks guard against model-suggested or stale paths and accidental link
traversal. They are not a sandbox: the core runs with the user's own rights.
"""

from __future__ import annotations

import ctypes
import os
import stat
import sys
from dataclasses import dataclass
from pathlib import Path

MAX_PATH_CHARS = 1024
FILE_ATTRIBUTE_HIDDEN = 0x2
FILE_ATTRIBUTE_SYSTEM = 0x4
FILE_ATTRIBUTE_REPARSE_POINT = 0x400
DRIVE_REMOTE = 4


class ScopeError(Exception):
    def __init__(self, code: str, detail: str) -> None:
        super().__init__(f"{code}: {detail}")
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class Scope:
    """A validated folder: canonical path plus the identity it had when validated."""

    root: Path
    identity: str


def identity_of(st: os.stat_result) -> str:
    return f"{st.st_dev}:{st.st_ino}"


def is_link_like(st: os.stat_result) -> bool:
    """Symlink, junction or any other reparse point (cloud placeholder, mount point...)."""
    attrs = getattr(st, "st_file_attributes", 0)
    return stat.S_ISLNK(st.st_mode) or bool(attrs & FILE_ATTRIBUTE_REPARSE_POINT)


def is_hidden_or_system(name: str, st: os.stat_result) -> bool:
    attrs = getattr(st, "st_file_attributes", 0)
    return name.startswith(".") or bool(attrs & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM))


def same_path(a: Path | str, b: Path | str) -> bool:
    return os.path.normcase(os.path.normpath(str(a))) == os.path.normcase(os.path.normpath(str(b)))


def _is_remote_drive(path: Path) -> bool:
    if sys.platform != "win32":
        return False
    drive = path.drive
    if not drive:
        return True
    return ctypes.windll.kernel32.GetDriveTypeW(drive + "\\") == DRIVE_REMOTE  # type: ignore[attr-defined]


def _forbidden_roots(protected: tuple[Path, ...]) -> list[Path]:
    roots = list(protected)
    system_root = os.environ.get("SYSTEMROOT") or os.environ.get("WINDIR")
    if system_root:
        roots.append(Path(system_root))
    return roots


def _within(child: Path, parent: Path) -> bool:
    child_n = os.path.normcase(os.path.normpath(str(child)))
    parent_n = os.path.normcase(os.path.normpath(str(parent)))
    return child_n == parent_n or child_n.startswith(parent_n.rstrip("\\/") + os.sep)


def validate_root(raw: str, protected: tuple[Path, ...] = ()) -> Scope:
    """Accept a user-selected folder as a scope, or raise ScopeError explaining why not."""
    if not raw or len(raw) > MAX_PATH_CHARS or "\x00" in raw:
        raise ScopeError("invalid_path", "The folder path is empty, too long or malformed.")
    if raw.startswith(("\\\\", "//")):
        raise ScopeError("network_path", "Network shares and device paths are not supported in this version.")
    selected = Path(os.path.normpath(raw))
    if not selected.is_absolute():
        raise ScopeError("invalid_path", "The folder path must be absolute.")
    if selected.parent == selected:
        raise ScopeError("drive_root", "A whole drive cannot be organized; choose a folder inside it.")
    if _is_remote_drive(selected):
        raise ScopeError("network_path", "Folders on network drives are not supported in this version.")

    # The selected folder and every folder above it must be ordinary directories, not links.
    for part in (selected, *selected.parents):
        if part.parent == part:
            break
        try:
            st = os.lstat(part)
        except FileNotFoundError:
            raise ScopeError("not_found", "The selected folder no longer exists.") from None
        except OSError as error:
            raise ScopeError("inaccessible", f"The folder could not be inspected ({error.strerror}).") from None
        if is_link_like(st):
            raise ScopeError(
                "link_in_path", f"'{part}' is a link, junction or reparse point; AEGIS does not follow those."
            )
        if part == selected and not stat.S_ISDIR(st.st_mode):
            raise ScopeError("not_a_folder", "The selected path is not a folder.")

    canonical = Path(os.path.realpath(selected, strict=True))
    for forbidden in _forbidden_roots(protected):
        if _within(canonical, forbidden) or _within(forbidden, canonical):
            raise ScopeError("protected_folder", "This folder contains or is inside a protected system/app folder.")
    return Scope(root=canonical, identity=identity_of(os.lstat(canonical)))


def check_scope_unchanged(scope: Scope) -> None:
    """Re-check right before use that the scope still is the same ordinary folder."""
    try:
        st = os.lstat(scope.root)
    except OSError:
        raise ScopeError("root_changed", "The selected folder is gone or no longer accessible.") from None
    if is_link_like(st) or not stat.S_ISDIR(st.st_mode) or identity_of(st) != scope.identity:
        raise ScopeError("root_changed", "The selected folder was replaced or changed since the plan was made.")
    if not same_path(os.path.realpath(scope.root), scope.root):
        raise ScopeError("root_changed", "The selected folder's location now resolves elsewhere.")


def child_path(scope: Scope, *parts: str) -> Path:
    """Join plain names under the scope root, refusing anything that is not a single path component."""
    for part in parts:
        if (
            not part
            or part in (".", "..")
            or any(sep in part for sep in ("/", "\\"))
            or ":" in part
            or "\x00" in part
        ):
            raise ScopeError("invalid_name", "A planned name is not a plain file or folder name.")
    path = scope.root.joinpath(*parts)
    if not _within(path, scope.root) or same_path(path, scope.root):
        raise ScopeError("outside_scope", "A planned path falls outside the selected folder.")
    return path
