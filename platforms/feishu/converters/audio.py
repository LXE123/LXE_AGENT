from __future__ import annotations

from .types import ConvertContext, ConvertResult, ResourceDescriptor
from .utils import safe_parse, text_value


def convert_audio(raw: str, ctx: ConvertContext) -> ConvertResult:
    parsed = safe_parse(raw)
    if not isinstance(parsed, dict):
        return ConvertResult(content="[audio]")
    file_key = text_value(parsed.get("file_key"))
    if not file_key:
        return ConvertResult(content="[audio]")
    duration_raw = parsed.get("duration")
    duration_value = int(duration_raw) if isinstance(duration_raw, (int, float)) else None
    duration_attr = f' duration="{duration_value}"' if duration_value is not None else ""
    content = f"<audio key=\"{file_key}\"{duration_attr}/>" if ctx.include_resource_placeholders else ""
    return ConvertResult(
        content=content,
        resources=[ResourceDescriptor(type="audio", file_key=file_key, duration=duration_value)],
    )


__all__ = ["convert_audio"]
