"""Runtime settings for the core, resolved once at startup."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

DATABASE_FILENAME = "aegis.db"


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    session_token: str

    @property
    def database_path(self) -> Path:
        return self.data_dir / DATABASE_FILENAME


def data_dir_from_env() -> Path:
    """AEGIS_DATA_DIR is set by Electron main (its userData directory)."""
    raw = os.environ.get("AEGIS_DATA_DIR", "").strip()
    if not raw:
        raise RuntimeError("AEGIS_DATA_DIR is not set; the core must be launched by the desktop app.")
    path = Path(raw)
    if not path.is_absolute():
        raise RuntimeError("AEGIS_DATA_DIR must be an absolute path.")
    return path
