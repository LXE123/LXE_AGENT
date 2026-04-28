from __future__ import annotations

from .types import ConvertContext, ConvertResult
from .utils import millis_to_datetime, safe_parse, text_value


def _format_calendar_content(parsed: dict[str, object] | None) -> str:
    if not parsed:
        return "[calendar event]"
    parts: list[str] = []
    summary = text_value(parsed.get("summary"))
    if summary:
        parts.append(f"📅 {summary}")
    start = millis_to_datetime(parsed.get("start_time") or "")
    end = millis_to_datetime(parsed.get("end_time") or "")
    if start and end:
        parts.append(f"🕙 {start} ~ {end}")
    elif start:
        parts.append(f"🕙 {start}")
    return "\n".join(parts).strip() or "[calendar event]"


def convert_share_calendar_event(raw: str, _ctx: ConvertContext) -> ConvertResult:
    parsed = safe_parse(raw)
    return ConvertResult(content=f"<calendar_share>{_format_calendar_content(parsed if isinstance(parsed, dict) else None)}</calendar_share>")


def convert_calendar(raw: str, _ctx: ConvertContext) -> ConvertResult:
    parsed = safe_parse(raw)
    return ConvertResult(content=f"<calendar_invite>{_format_calendar_content(parsed if isinstance(parsed, dict) else None)}</calendar_invite>")


def convert_general_calendar(raw: str, _ctx: ConvertContext) -> ConvertResult:
    parsed = safe_parse(raw)
    return ConvertResult(content=f"<calendar>{_format_calendar_content(parsed if isinstance(parsed, dict) else None)}</calendar>")


__all__ = [
    "convert_calendar",
    "convert_general_calendar",
    "convert_share_calendar_event",
]
