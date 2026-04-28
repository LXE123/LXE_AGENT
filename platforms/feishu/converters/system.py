from __future__ import annotations

from typing import Any

from .types import ConvertContext, ConvertResult
from .utils import safe_parse


def _stringify(value: Any) -> str:
    if isinstance(value, list):
        return ", ".join(str(item or "").strip() for item in value if str(item or "").strip())
    if isinstance(value, dict):
        return str(value.get("text") or value.get("name") or "").strip()
    return str(value or "").strip()


def convert_system(raw: str, _ctx: ConvertContext) -> ConvertResult:
    parsed = safe_parse(raw)
    if not isinstance(parsed, dict):
        return ConvertResult(content="[system message]")
    template = str(parsed.get("template") or "").strip()
    if not template:
        return ConvertResult(content="[system message]")
    content = template
    for key, value in parsed.items():
        if key == "template":
            continue
        content = content.replace(f"{{{key}}}", _stringify(value))
    return ConvertResult(content=" ".join(content.split()).strip())


__all__ = ["convert_system"]
