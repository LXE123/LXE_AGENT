from __future__ import annotations

from .types import ConvertContext, ConvertResult
from .utils import safe_parse


def convert_unknown(raw: str, _ctx: ConvertContext) -> ConvertResult:
    parsed = safe_parse(raw)
    if isinstance(parsed, dict):
        text = parsed.get("text")
        if isinstance(text, str) and text.strip():
            return ConvertResult(content=text.strip())
    return ConvertResult(content="[unsupported message]")


__all__ = ["convert_unknown"]
