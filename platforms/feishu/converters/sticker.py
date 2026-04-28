from __future__ import annotations

from .types import ConvertContext, ConvertResult, ResourceDescriptor
from .utils import safe_parse, text_value


def convert_sticker(raw: str, ctx: ConvertContext) -> ConvertResult:
    parsed = safe_parse(raw)
    file_key = text_value(parsed.get("file_key")) if isinstance(parsed, dict) else ""
    if not file_key:
        return ConvertResult(content="[sticker]")
    content = f"<sticker key=\"{file_key}\"/>" if ctx.include_resource_placeholders else ""
    return ConvertResult(
        content=content,
        resources=[ResourceDescriptor(type="sticker", file_key=file_key)],
    )


__all__ = ["convert_sticker"]
