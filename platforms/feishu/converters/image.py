from __future__ import annotations

from .types import ConvertContext, ConvertResult, ResourceDescriptor
from .utils import safe_parse, text_value


def convert_image(raw: str, ctx: ConvertContext) -> ConvertResult:
    parsed = safe_parse(raw)
    image_key = text_value(parsed.get("image_key")) if isinstance(parsed, dict) else ""
    if not image_key:
        return ConvertResult(content="[image]")
    content = f"![image]({image_key})" if ctx.include_resource_placeholders else ""
    return ConvertResult(
        content=content,
        resources=[ResourceDescriptor(type="image", file_key=image_key)],
    )


__all__ = ["convert_image"]
