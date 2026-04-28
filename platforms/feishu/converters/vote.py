from __future__ import annotations

from .types import ConvertContext, ConvertResult
from .utils import as_list, safe_parse, text_value


def convert_vote(raw: str, _ctx: ConvertContext) -> ConvertResult:
    parsed = safe_parse(raw)
    if not isinstance(parsed, dict):
        return ConvertResult(content="<vote>\n[vote]\n</vote>")
    parts = []
    topic = text_value(parsed.get("topic"))
    if topic:
        parts.append(topic)
    parts.extend(f"• {text_value(option)}" for option in as_list(parsed.get("options")) if text_value(option))
    inner = "\n".join(parts).strip() or "[vote]"
    return ConvertResult(content=f"<vote>\n{inner}\n</vote>")


__all__ = ["convert_vote"]
