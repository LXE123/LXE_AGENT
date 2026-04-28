from __future__ import annotations

from .types import ConvertContext, ConvertResult
from .utils import safe_parse, text_value


def convert_hongbao(raw: str, _ctx: ConvertContext) -> ConvertResult:
    parsed = safe_parse(raw)
    text = text_value(parsed.get("text")) if isinstance(parsed, dict) else ""
    text_attr = f' text="{text}"' if text else ""
    return ConvertResult(content=f"<hongbao{text_attr}/>")


__all__ = ["convert_hongbao"]
