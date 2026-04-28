from __future__ import annotations

from .types import ConvertContext, ConvertResult
from .utils import as_list, millis_to_datetime, safe_parse, text_value


def _extract_plain_text(content: object) -> str:
    lines: list[str] = []
    for paragraph in as_list(content):
        if not isinstance(paragraph, list):
            continue
        line = "".join(text_value(getattr(element, "get", lambda _k, _d=None: "")("text")) for element in paragraph if isinstance(element, dict))
        if line.strip():
            lines.append(line.strip())
    return "\n".join(lines).strip()


def convert_todo(raw: str, _ctx: ConvertContext) -> ConvertResult:
    parsed = safe_parse(raw)
    if not isinstance(parsed, dict):
        return ConvertResult(content="<todo>\n[todo]\n</todo>")
    summary = parsed.get("summary")
    summary_title = text_value(summary.get("title")) if isinstance(summary, dict) else ""
    summary_body = _extract_plain_text(summary.get("content")) if isinstance(summary, dict) else ""
    due_time = millis_to_datetime(parsed.get("due_time") or "")
    parts = [part for part in (summary_title, summary_body, f"Due: {due_time}" if due_time else "") if part]
    inner = "\n".join(parts).strip() or "[todo]"
    return ConvertResult(content=f"<todo>\n{inner}\n</todo>")


__all__ = ["convert_todo"]
