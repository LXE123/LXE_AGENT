from __future__ import annotations

from .types import ConvertContext, ConvertResult
from .utils import safe_parse, text_value


def convert_folder(raw: str, _ctx: ConvertContext) -> ConvertResult:
    parsed = safe_parse(raw)
    if not isinstance(parsed, dict):
        return ConvertResult(content="[folder]")
    file_key = text_value(parsed.get("file_key"))
    file_name = text_value(parsed.get("file_name"))
    if not file_key:
        return ConvertResult(content="[folder]")
    name_attr = f' name="{file_name}"' if file_name else ""
    return ConvertResult(content=f"<folder key=\"{file_key}\"{name_attr}/>")


__all__ = ["convert_folder"]
