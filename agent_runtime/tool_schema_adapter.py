from __future__ import annotations

from typing import Any

from .types import ToolSchema


def to_anthropic_tool_schema(tool: ToolSchema) -> dict[str, Any]:
    return {
        "name": str(tool["name"] or "").strip(),
        "description": str(tool["description"] or "").strip(),
        "input_schema": dict(tool["parameters"] or {}),
    }


def to_openai_function_schema(tool: ToolSchema) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": str(tool["name"] or "").strip(),
            "description": str(tool["description"] or "").strip(),
            "parameters": dict(tool["parameters"] or {}),
        },
    }


def adapt_tool_schemas(tool_schemas: list[ToolSchema] | None, api_style: str) -> list[dict[str, Any]]:
    schemas = list(tool_schemas or [])
    if not schemas:
        return []

    if str(api_style or "").strip() == "anthropic-messages":
        return [to_anthropic_tool_schema(tool) for tool in schemas]
    if str(api_style or "").strip() == "openai-chat":
        return [to_openai_function_schema(tool) for tool in schemas]
    raise ValueError(f"Unsupported tool schema api_style: {api_style}")


__all__ = [
    "adapt_tool_schemas",
    "to_anthropic_tool_schema",
    "to_openai_function_schema",
]
