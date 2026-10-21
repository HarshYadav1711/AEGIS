"""Read-only scanning of one user-selected Obsidian-compatible vault (M0A).

Walks the vault without following links, junctions or reparse points, skips
hidden/system entries (``.obsidian``, ``.git``, ``.trash`` ...) and anything
that is not a bounded ``.md`` file. Parses only what search needs: title,
tags, aliases and wikilink targets. Nothing here writes, except
``write_note``, which only ever creates a new file inside the vault's AEGIS
write area and never overwrites.

Like file_scope, these checks guard against stale or crafted paths and link
traversal; they are not a sandbox.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import yaml

from app.memory.adaptive import contains_secret
from app.tools.file_scope import (
    Scope,
    ScopeError,
    check_scope_unchanged,
    child_path,
    identity_of,
    is_hidden_or_system,
    is_link_like,
)

WRITE_AREA = "AEGIS"
MAX_NOTE_BYTES = 1_000_000
MAX_NOTES = 5000
MAX_DEPTH = 20
MAX_BODY_CHARS = 200_000
_TAG = re.compile(r"(?<![\w/#])#([A-Za-z][\w/-]{0,63})")
_WIKILINK = re.compile(r"!?\[\[([^\]|#^\n]{1,200})(?:[#^][^\]|\n]*)?(?:\|[^\]\n]*)?\]\]")
_H1 = re.compile(r"^#\s+(.+?)\s*#*\s*$", re.MULTILINE)
_UNSAFE_NAME = re.compile(r"[^A-Za-z0-9 _.-]+")


@dataclass(frozen=True)
class NoteFile:
    rel_path: str  # forward slashes, relative to the vault root
    file_id: str
    size: int
    mtime_ns: int


@dataclass(frozen=True)
class ParsedNote:
    sha256: str
    title: str
    tags: list[str]
    links: list[str]
    body: str
    has_secret: bool


@dataclass
class Walk:
    notes: list[NoteFile] = field(default_factory=list)
    skipped_links: int = 0
    skipped_hidden: int = 0
    skipped_large: list[NoteFile] = field(default_factory=list)
    truncated: bool = False


def modified_at(mtime_ns: int) -> str:
    return datetime.fromtimestamp(mtime_ns / 1e9, timezone.utc).isoformat(timespec="milliseconds")


def classify_root(scope: Scope) -> str:
    """'existing' for a folder Obsidian already opened (.obsidian present), 'new' for an empty folder."""
    entries = [e for e in os.scandir(scope.root)]
    if any(e.name == ".obsidian" and e.is_dir(follow_symlinks=False) for e in entries):
        return "existing"
    if not entries:
        return "new"
    raise ScopeError(
        "not_a_vault",
        "This folder is neither an Obsidian vault (no .obsidian folder) nor empty. "
        "Choose an existing vault, or an empty folder to create a new one.",
    )


def walk(scope: Scope) -> Walk:
    check_scope_unchanged(scope)
    result = Walk()
    stack: list[tuple[Path, int]] = [(scope.root, 0)]
    while stack:
        folder, depth = stack.pop()
        try:
            entries = sorted(os.scandir(folder), key=lambda e: e.name)
        except OSError:
            continue
        for entry in entries:
            # os.lstat, not entry.stat(): on Windows the cached DirEntry stat has no file index (st_ino 0).
            try:
                st = os.lstat(entry.path)
            except OSError:
                continue
            if is_link_like(st):
                result.skipped_links += 1
                continue
            if is_hidden_or_system(entry.name, st):
                result.skipped_hidden += 1
                continue
            if stat.S_ISDIR(st.st_mode):
                if depth < MAX_DEPTH:
                    stack.append((Path(entry.path), depth + 1))
                continue
            if not stat.S_ISREG(st.st_mode) or not entry.name.lower().endswith(".md"):
                continue
            rel = Path(entry.path).relative_to(scope.root).as_posix()
            note = NoteFile(rel, identity_of(st), st.st_size, st.st_mtime_ns)
            if st.st_size > MAX_NOTE_BYTES:
                result.skipped_large.append(note)
            elif len(result.notes) >= MAX_NOTES:
                result.truncated = True
            else:
                result.notes.append(note)
    return result


def resolve(scope: Scope, rel_path: str) -> Path:
    """Map a stored relative path back to a file in the vault, refusing links and anything outside it."""
    parts = rel_path.split("/")
    path = child_path(scope, *parts)
    current = scope.root
    for part in parts:
        current = current / part
        try:
            st = os.lstat(current)
        except OSError:
            raise ScopeError("not_found", "The note no longer exists at its indexed location.") from None
        if is_link_like(st):
            raise ScopeError("link_in_path", "The note path now contains a link or junction; it is not opened.")
    return path


def read_note(scope: Scope, note: NoteFile) -> ParsedNote:
    path = resolve(scope, note.rel_path)
    with open(path, "rb") as handle:
        st = os.fstat(handle.fileno())
        if identity_of(st) != note.file_id:
            raise ScopeError("changed_during_read", "The note was replaced while it was being read.")
        data = handle.read(MAX_NOTE_BYTES + 1)
    if len(data) > MAX_NOTE_BYTES:
        raise ScopeError("too_large", "The note grew beyond the size limit.")
    return parse(data, Path(note.rel_path).stem)


def parse(data: bytes, fallback_title: str) -> ParsedNote:
    text = data.decode("utf-8", errors="replace").lstrip("﻿")
    meta: dict[str, object] = {}
    body = text
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            try:
                loaded = yaml.safe_load(text[3:end])
            except yaml.YAMLError:
                loaded = None
            if isinstance(loaded, dict):
                meta = loaded
                body = text[end + 4:].lstrip("\r\n")
    tags = {str(t).lstrip("#") for t in _as_list(meta.get("tags")) if str(t).strip()}
    tags.update(_TAG.findall(body))
    title = meta.get("title") if isinstance(meta.get("title"), str) else None
    heading = _H1.search(body)
    aliases = [str(a) for a in _as_list(meta.get("aliases"))]
    return ParsedNote(
        sha256=hashlib.sha256(data).hexdigest(),
        title=" ".join(str(title or (heading.group(1) if heading else fallback_title)).split())[:200],
        tags=sorted(tags)[:50],
        links=sorted({m.strip() for m in _WIKILINK.findall(body)})[:200],
        body=" ".join([*aliases, body])[:MAX_BODY_CHARS],
        has_secret=contains_secret(text),
    )


def _as_list(value: object) -> list[object]:
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def note_filename(title: str) -> str:
    stem = " ".join(_UNSAFE_NAME.sub(" ", title).split()).strip(" .")[:80]
    return (stem or "Untitled") + ".md"


def write_note(scope: Scope, title: str, body: str, note_id: str, created: str) -> tuple[NoteFile, bytes]:
    """Create a new note in <vault>/AEGIS/ (exclusive create, never overwrite) and read it back."""
    check_scope_unchanged(scope)
    area = child_path(scope, WRITE_AREA)
    try:
        st = os.lstat(area)
        if is_link_like(st) or not stat.S_ISDIR(st.st_mode):
            raise ScopeError("write_area_invalid", f"{WRITE_AREA}/ in the vault is not an ordinary folder.")
    except FileNotFoundError:
        os.mkdir(area)
    safe_title = json_string(title)
    data = (
        "---\n"
        f"title: {safe_title}\n"
        f"aegis_note_id: {note_id}\n"
        "aegis_author: user-via-aegis\n"
        f"created: {created}\n"
        "---\n\n"
        f"{body.rstrip()}\n"
    ).encode("utf-8")
    base = note_filename(title)
    for n in range(1, 100):
        name = base if n == 1 else f"{base[:-3]} {n}.md"
        path = child_path(scope, WRITE_AREA, name)
        try:
            with open(path, "xb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
                st = os.fstat(handle.fileno())
            break
        except FileExistsError:
            continue
        except OSError as error:
            raise ScopeError("write_failed", f"The note could not be written ({error.strerror}).") from None
    else:
        raise ScopeError("file_exists", "Too many notes with this title already exist.")
    check_scope_unchanged(scope)
    if path.read_bytes() != data:
        raise ScopeError("verify_failed", "The written note does not match what was sent; check it before use.")
    rel = f"{WRITE_AREA}/{name}"
    return NoteFile(rel, identity_of(st), st.st_size, st.st_mtime_ns), data


def json_string(value: str) -> str:
    """A YAML-safe scalar (JSON strings are valid YAML) on one line."""
    return json.dumps(" ".join(value.split()), ensure_ascii=False)
