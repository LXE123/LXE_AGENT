from __future__ import annotations

from ..types import ConvertContext, ConvertResult
from ..utils import as_record, safe_parse
from .card_converter import CardConverter, MODE
from .legacy import convert_legacy_card


def convert_interactive(raw: str, _ctx: ConvertContext) -> ConvertResult:
    parsed = safe_parse(raw)
    parsed_record = as_record(parsed)
    if not parsed_record:
        return ConvertResult(content="[interactive card]")
    raw_card = parsed_record.get("json_card")
    if isinstance(raw_card, str):
        result = CardConverter(MODE.Concise).convert(parsed_record)
        return ConvertResult(content=result.content or "[interactive card]")
    legacy = convert_legacy_card(parsed_record)
    return ConvertResult(content=str(legacy.get("content") or "[interactive card]"))


__all__ = ["convert_interactive"]
