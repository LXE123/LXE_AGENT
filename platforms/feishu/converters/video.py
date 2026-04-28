from __future__ import annotations

from .types import ConvertContext, ConvertResult, ResourceDescriptor
from .utils import safe_parse, text_value


def convert_video(raw: str, ctx: ConvertContext) -> ConvertResult:
    parsed = safe_parse(raw)
    if not isinstance(parsed, dict):
        return ConvertResult(content="[video]")
    file_key = text_value(parsed.get("file_key"))
    if not file_key:
        return ConvertResult(content="[video]")
    file_name = text_value(parsed.get("file_name"))
    cover_image_key = text_value(parsed.get("image_key"))
    duration_raw = parsed.get("duration")
    duration_value = int(duration_raw) if isinstance(duration_raw, (int, float)) else None
    attrs = []
    if file_name:
        attrs.append(f'name="{file_name}"')
    if duration_value is not None:
        attrs.append(f'duration="{duration_value}"')
    attr_text = f" {' '.join(attrs)}" if attrs else ""
    content = f"<video key=\"{file_key}\"{attr_text}/>" if ctx.include_resource_placeholders else ""
    return ConvertResult(
        content=content,
        resources=[
            ResourceDescriptor(
                type="video",
                file_key=file_key,
                file_name=file_name,
                duration=duration_value,
                cover_image_key=cover_image_key,
            )
        ],
    )


__all__ = ["convert_video"]
