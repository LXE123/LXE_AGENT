from __future__ import annotations

import json
from typing import Any

from agent_runtime.types import ToolExecutionError, ToolResult, image_content_block, text_content_block


def model_visible_input_schema(raw_schema: Any) -> dict[str, Any]:
    schema = dict(raw_schema or {}) if isinstance(raw_schema, dict) else {}
    if str(schema.get("type") or "").strip() != "object":
        schema["type"] = "object"
    if not isinstance(schema.get("properties"), dict):
        schema["properties"] = {}
    return schema


def mcp_tool_description(tool: Any) -> str:
    description = str(getattr(tool, "description", "") or "").strip()
    title = str(getattr(tool, "title", "") or "").strip()
    if description:
        return description
    return title


def mcp_result_to_tool_result(result: Any) -> ToolResult:
    content_blocks: list[dict[str, Any]] = []
    text_parts: list[str] = []
    for raw_item in list(getattr(result, "content", None) or []):
        item_type = str(getattr(raw_item, "type", "") or "").strip()
        if item_type == "text":
            text = str(getattr(raw_item, "text", "") or "")
            content_blocks.append(text_content_block(text))
            if text.strip():
                text_parts.append(text.strip())
            continue
        if item_type == "image":
            data = str(getattr(raw_item, "data", "") or "")
            mime_type = str(getattr(raw_item, "mimeType", "") or "").strip() or "image/png"
            if data:
                content_blocks.append(image_content_block(media_type=mime_type, data=data))
            continue
        try:
            payload = raw_item.model_dump(by_alias=True, exclude_none=True)
        except Exception:
            payload = {"type": item_type or "unknown", "value": str(raw_item)}
        text = json.dumps(payload, ensure_ascii=False, sort_keys=True)
        content_blocks.append(text_content_block(text))
        text_parts.append(text)

    structured = getattr(result, "structuredContent", None)
    if structured:
        structured_text = json.dumps(structured, ensure_ascii=False, indent=2, sort_keys=True)
        content_blocks.append(text_content_block("structuredContent:\n" + structured_text))
        text_parts.append(structured_text)

    if bool(getattr(result, "isError", False)):
        message = "\n".join(text_parts).strip() or "MCP tool returned isError=true"
        raise ToolExecutionError(message)

    if not content_blocks:
        content_blocks.append(text_content_block("OK"))

    details: dict[str, Any] = {}
    if structured:
        details["structuredContent"] = structured
    meta = getattr(result, "meta", None)
    if meta:
        details["_meta"] = dict(meta)
    return ToolResult(content=content_blocks, details=details)


__all__ = ["mcp_result_to_tool_result", "mcp_tool_description", "model_visible_input_schema"]
