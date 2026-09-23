from __future__ import annotations

from typing import Any

from ._workflow import run as _run


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    return _run(arguments)
