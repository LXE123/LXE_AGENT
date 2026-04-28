from __future__ import annotations

from inspect import isawaitable

from .index import CONVERTERS
from .types import ConvertContext, ConvertResult


async def convert_message_content(raw: str, message_type: str, ctx: ConvertContext) -> ConvertResult:
    converter = CONVERTERS.get(str(message_type or "").strip() or "unknown") or CONVERTERS["unknown"]
    next_ctx = ctx if ctx.convert_message_content is not None else ctx.child()
    next_ctx.convert_message_content = convert_message_content
    result = converter(raw, next_ctx)
    if isawaitable(result):
        result = await result
    return result if isinstance(result, ConvertResult) else ConvertResult(content=str(getattr(result, "content", "") or ""))


def convert_message_content_sync(raw: str, message_type: str, ctx: ConvertContext) -> ConvertResult:
    converter = CONVERTERS.get(str(message_type or "").strip() or "unknown") or CONVERTERS["unknown"]
    next_ctx = ctx if ctx.convert_message_content is not None else ctx.child()
    next_ctx.convert_message_content = convert_message_content
    result = converter(raw, next_ctx)
    if isawaitable(result):
        close = getattr(result, "close", None)
        if callable(close):
            close()
        if str(message_type or "").strip() == "merge_forward":
            return ConvertResult(content="<forwarded_messages/>")
        return ConvertResult(content=str(raw or "").strip())
    return result if isinstance(result, ConvertResult) else ConvertResult(content=str(getattr(result, "content", "") or ""))


__all__ = ["convert_message_content", "convert_message_content_sync"]
