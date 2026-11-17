"""SaturnoLab — Lightweight AI-first Python Notebook Environment."""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version
from pathlib import Path


def _resolve_version() -> str:
    try:
        return version("saturnolab")
    except PackageNotFoundError:
        try:
            import tomllib

            pyproject = Path(__file__).resolve().parent.parent / "pyproject.toml"
            if pyproject.is_file():
                with pyproject.open("rb") as fh:
                    return str(tomllib.load(fh)["project"]["version"])
        except Exception:
            pass
        return "0.1.6"


__version__ = _resolve_version()
