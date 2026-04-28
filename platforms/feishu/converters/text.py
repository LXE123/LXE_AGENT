from __future__ import annotations

from .content_converter_helpers import resolve_mentions
from .types import ConvertContext, ConvertResult
from .utils import safe_parse


def convert_text(raw: str, ctx: ConvertContext) -> ConvertResult:
    parsed = safe_parse(raw)
    text = raw
    if isinstance(parsed, dict):
        text = str(parsed.get("text") or raw or "")
    return ConvertResult(content=resolve_mentions(text, ctx))


__all__ = ["convert_text"]
