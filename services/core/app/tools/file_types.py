"""Deterministic file-type classification by extension.

The category of a file is decided here, from its name alone; file contents are
never read for classification and the model is never consulted.
"""

from __future__ import annotations

from typing import Literal

Category = Literal["Documents", "Images", "Videos", "Audio", "Archives", "Code", "Other"]

CATEGORIES: tuple[Category, ...] = ("Documents", "Images", "Videos", "Audio", "Archives", "Code", "Other")

_EXTENSIONS: dict[Category, frozenset[str]] = {
    "Documents": frozenset(
        {
            "pdf", "doc", "docx", "odt", "rtf", "txt", "md", "tex", "epub",
            "xls", "xlsx", "ods", "csv", "tsv", "ppt", "pptx", "odp", "pages", "numbers", "key",
        }
    ),
    "Images": frozenset(
        {"jpg", "jpeg", "png", "gif", "bmp", "tif", "tiff", "webp", "heic", "heif", "svg", "ico", "raw", "cr2", "nef", "psd"}
    ),
    "Videos": frozenset({"mp4", "mkv", "mov", "avi", "wmv", "webm", "m4v", "flv", "mpg", "mpeg", "3gp"}),
    "Audio": frozenset({"mp3", "wav", "flac", "aac", "ogg", "oga", "m4a", "wma", "opus", "aiff", "mid", "midi"}),
    "Archives": frozenset({"zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "zst", "iso", "cab"}),
    "Code": frozenset(
        {
            "py", "ipynb", "js", "mjs", "cjs", "ts", "tsx", "jsx", "java", "kt", "c", "h", "cpp", "hpp", "cc",
            "cs", "go", "rs", "rb", "php", "swift", "sh", "ps1", "bat", "cmd", "sql", "html", "htm", "css",
            "scss", "json", "yaml", "yml", "toml", "xml", "ini", "lua", "r", "m", "scala", "dart",
        }
    ),
}

_BY_EXTENSION: dict[str, Category] = {ext: cat for cat, exts in _EXTENSIONS.items() for ext in exts}


def extension_of(name: str) -> str:
    """Lower-case final extension without the dot; '' for names without one (or dot-only names)."""
    stem, dot, ext = name.rpartition(".")
    return ext.lower() if dot and stem and ext else ""


def classify(name: str) -> Category:
    return _BY_EXTENSION.get(extension_of(name), "Other")
