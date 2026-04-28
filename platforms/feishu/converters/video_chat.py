from __future__ import annotations

from .types import ConvertContext, ConvertResult
from .utils import millis_to_datetime, safe_parse, text_value


def convert_video_chat(raw: str, _ctx: ConvertContext) -> ConvertResult:
    parsed = safe_parse(raw)
    if not isinstance(parsed, dict):
        return ConvertResult(content="<meeting>[video chat]</meeting>")
    parts = []
    topic = text_value(parsed.get("topic"))
    if topic:
        parts.append(f"📹 {topic}")
    start_time = millis_to_datetime(parsed.get("start_time") or "")
    if start_time:
        parts.append(f"🕙 {start_time}")
    inner = "\n".join(parts).strip() or "[video chat]"
    return ConvertResult(content=f"<meeting>{inner}</meeting>")


__all__ = ["convert_video_chat"]
