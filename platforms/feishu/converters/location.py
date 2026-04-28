from __future__ import annotations

from .types import ConvertContext, ConvertResult
from .utils import safe_parse, text_value


def convert_location(raw: str, _ctx: ConvertContext) -> ConvertResult:
    parsed = safe_parse(raw)
    if not isinstance(parsed, dict):
        return ConvertResult(content="<location/>")
    name = text_value(parsed.get("name"))
    lat = text_value(parsed.get("latitude"))
    lng = text_value(parsed.get("longitude"))
    attrs = []
    if name:
        attrs.append(f'name="{name}"')
    if lat and lng:
        attrs.append(f'coords="lat:{lat},lng:{lng}"')
    attr_text = f" {' '.join(attrs)}" if attrs else ""
    return ConvertResult(content=f"<location{attr_text}/>")


__all__ = ["convert_location"]
