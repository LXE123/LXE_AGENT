from __future__ import annotations

import asyncio
from typing import Any

from agent_runtime.tool_registry import UnifiedToolRegistry
from agent_runtime.types import ToolDefinition, ToolExecutionError

from .manager import McpConnectionManager
from .models import McpToolInfo
from .schema import mcp_result_to_tool_result


def tool_definition_from_mcp_info(manager: McpConnectionManager, info: McpToolInfo) -> ToolDefinition:
    async def _handler(**kwargs: Any):
        try:
            result = await manager.call_tool(info.route, dict(kwargs or {}))
        except asyncio.CancelledError as exc:
            raise ToolExecutionError(
                f"MCP tool call failed for {info.server_name}.{info.raw_tool_name}: "
                "server disconnected or call was cancelled"
            ) from exc
        except Exception as exc:
            message = str(exc).strip() or exc.__class__.__name__
            raise ToolExecutionError(
                f"MCP tool call failed for {info.server_name}.{info.raw_tool_name}: {message}"
            ) from exc
        return mcp_result_to_tool_result(result)

    description = str(info.description or "").strip()
    if info.connector_name:
        source_note = f"MCP tool from {info.connector_name}."
    else:
        source_note = f"MCP tool from server {info.server_name}."
    if description:
        description = description.rstrip()
        if description[-1:] not in {".", "!", "?"}:
            description += "."
        description = f"{description} {source_note}"
    else:
        description = source_note

    return ToolDefinition(
        name=info.model_name,
        description=description,
        parameters=dict(info.input_schema or {}),
        handler=_handler,
        source="mcp",
        exposure=info.exposure,
        search_text=info.search_text,
        mcp_route=info.route,
        server_name=info.server_name,
        connector_id=info.connector_id,
        connector_name=info.connector_name,
        connector_description=info.connector_description,
    )


def register_mcp_tools(registry: UnifiedToolRegistry, manager: McpConnectionManager) -> list[str]:
    registered: list[str] = []
    for info in manager.tools:
        if not info.model_name or registry.has(info.model_name):
            continue
        registry.register(tool_definition_from_mcp_info(manager, info))
        registered.append(info.model_name)
    return registered


__all__ = ["register_mcp_tools", "tool_definition_from_mcp_info"]
