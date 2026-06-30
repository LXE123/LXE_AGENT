from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from .tool_registry import UnifiedToolRegistry
from .types import ToolDefinition, text_tool_result


TOOL_SEARCH_NAME = "tool_search"


@dataclass
class ToolExposureState:
    registry: UnifiedToolRegistry
    search_enabled: bool = True
    loaded_deferred_names: set[str] = field(default_factory=set)

    def deferred_tools(self) -> list[ToolDefinition]:
        if not self.search_enabled:
            return []
        return [
            tool
            for tool in self.registry.definitions()
            if tool.source == "mcp" and tool.exposure == "deferred"
        ]

    def active_names(self) -> list[str]:
        names: list[str] = []
        has_deferred = bool(self.deferred_tools())
        for tool in self.registry.definitions():
            if tool.name == TOOL_SEARCH_NAME:
                if self.search_enabled and has_deferred:
                    names.append(tool.name)
                continue
            if tool.source != "mcp":
                names.append(tool.name)
                continue
            if not self.search_enabled:
                names.append(tool.name)
                continue
            if tool.exposure == "direct" or tool.name in self.loaded_deferred_names:
                names.append(tool.name)
        return sorted(set(names))

    def active_schemas(self) -> list[dict[str, Any]]:
        return self.registry.tool_schemas(self.active_names())

    def load_tools(self, names: list[str]) -> None:
        for name in names:
            tool = self.registry.get(name)
            if tool is not None and tool.source == "mcp" and tool.exposure == "deferred":
                self.loaded_deferred_names.add(tool.name)

    def search(self, query: str, *, limit: int = 8) -> list[ToolDefinition]:
        safe_query = " ".join(str(query or "").strip().casefold().split())
        terms = [term for term in safe_query.split(" ") if term]
        scored: list[tuple[int, str, ToolDefinition]] = []
        for tool in self.deferred_tools():
            haystack = " ".join(
                [
                    tool.name,
                    tool.description,
                    tool.search_text,
                    tool.server_name,
                    tool.connector_name,
                ]
            ).casefold()
            if not terms:
                score = 1
            else:
                score = sum(2 if term in tool.name.casefold() else 1 for term in terms if term in haystack)
            if score > 0:
                scored.append((score, tool.name, tool))
        scored.sort(key=lambda item: (-item[0], item[1]))
        return [tool for _score, _name, tool in scored[: max(1, min(int(limit or 8), 20))]]


def register_tool_search(registry: UnifiedToolRegistry, exposure_state: ToolExposureState) -> None:
    if registry.has(TOOL_SEARCH_NAME):
        return

    async def _handler(query: str = "", limit: int = 8, **_: Any):
        matches = exposure_state.search(query, limit=limit)
        loaded_names = [tool.name for tool in matches]
        exposure_state.load_tools(loaded_names)
        payload = {
            "loaded_tools": [
                {
                    "name": tool.name,
                    "description": tool.description,
                    "server_name": tool.server_name,
                    "connector_name": tool.connector_name,
                    "parameters": dict(tool.parameters or {}),
                }
                for tool in matches
            ],
            "next_step": "The listed tools are now available to call in the next model step.",
        }
        return text_tool_result(
            json.dumps(payload, ensure_ascii=False, indent=2),
            details=payload,
        )

    registry.register(
        ToolDefinition(
            name=TOOL_SEARCH_NAME,
            description=(
                "Search deferred MCP tools by name, description, connector, server, or parameter names. "
                "Call this before using MCP tools that are not already visible."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search query for MCP tools.",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum tools to load. Defaults to 8.",
                        "minimum": 1,
                        "maximum": 20,
                    },
                },
                "required": ["query"],
                "additionalProperties": False,
            },
            handler=_handler,
            source="builtin",
            exposure="direct",
        )
    )


__all__ = ["TOOL_SEARCH_NAME", "ToolExposureState", "register_tool_search"]
