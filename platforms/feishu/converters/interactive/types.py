from __future__ import annotations

from dataclasses import dataclass
from typing import Any


Obj = dict[str, Any]
RawCardContent = dict[str, Any]


@dataclass(slots=True)
class ConvertCardResult:
    content: str = ""


class MODE:
    Concise = "concise"
    Detailed = "detailed"


__all__ = ["ConvertCardResult", "MODE", "Obj", "RawCardContent"]
