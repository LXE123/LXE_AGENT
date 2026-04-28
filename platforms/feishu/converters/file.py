from __future__ import annotations

from .types import ConvertContext, ConvertResult, ResourceDescriptor
from .utils import safe_parse, text_value


def convert_file(raw: str, ctx: ConvertContext) -> ConvertResult:
    parsed = safe_parse(raw)
    if not isinstance(parsed, dict):
        return ConvertResult(content="[file]")
    file_key = text_value(parsed.get("file_key"))
    file_name = text_value(parsed.get("file_name"))
    if not file_key:
        return ConvertResult(content="[file]")
    name_attr = f' name="{file_name}"' if file_name else ""
    content = f"<file key=\"{file_key}\"{name_attr}/>" if ctx.include_resource_placeholders else ""
    return ConvertResult(
        content=content,
        resources=[ResourceDescriptor(type="file", file_key=file_key, file_name=file_name)],
    )


__all__ = ["convert_file"]
