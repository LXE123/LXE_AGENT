from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

from .tool_registry import UnifiedToolRegistry
from .types import ToolDefinition, text_tool_result


TOOL_SEARCH_NAME = "tool_search"
_STOP_QUERY_TERMS = {"mcp", "tool", "tools", "server", "servers", "deferred"}
_SOURCE_NOTE_RE = re.compile(r"\s*MCP tool from (?:server\s+)?[^.?!]+[.?!]?", re.IGNORECASE)


def _normalize_query_terms(query: str) -> list[str]:
    safe_query = " ".join(str(query or "").strip().casefold().split())
    return [term for term in safe_query.split(" ") if term and term not in _STOP_QUERY_TERMS]


def _semantic_tool_name(tool_name: str) -> str:
    safe_name = str(tool_name or "").strip()
    if safe_name.startswith("mcp__"):
        parts = [part for part in safe_name.split("__") if part]
        return parts[-1] if parts else ""
    return safe_name


def _semantic_description(description: str) -> str:
    return " ".join(_SOURCE_NOTE_RE.sub(" ", str(description or "")).split())


def _parameter_names(parameters: dict[str, Any]) -> list[str]:
    properties = dict((parameters or {}).get("properties") or {})
    return sorted(str(name or "").strip() for name in properties if str(name or "").strip())


def _semantic_haystack(tool: ToolDefinition) -> str:
    parts = [
        _semantic_tool_name(tool.name),
        _semantic_description(tool.description),
        tool.search_text,
        tool.connector_name,
        tool.connector_description,
        " ".join(_parameter_names(tool.parameters)),
    ]
    return " ".join(part.strip() for part in parts if str(part or "").strip()).casefold()


def _tool_search_sources(tools: list[ToolDefinition]) -> list[tuple[str, str]]:
    sources: dict[str, str] = {}
    for tool in tools:
        name = str(tool.connector_name or tool.server_name or "").strip()
        if not name:
            continue
        description = str(tool.connector_description or "").strip()
        sources.setdefault(name, description)
    return sorted(sources.items(), key=lambda item: item[0].casefold())


def _tool_search_description(exposure_state: "ToolExposureState") -> str:
    sources = _tool_search_sources(exposure_state.deferred_tools())
    if sources:
        source_lines = "\n".join(
            f"- {name}: {description}" if description else f"- {name}"
            for name, description in sources
        )
    else:
        source_lines = "None currently enabled."
    return (
        f"Available deferred tool sources:\n{source_lines}\n\n"
        "Search deferred tools by source, capability, tool description, or parameter names. "
        "It exposes matching tools for the next model step. "
        "Use concrete source or capability terms such as connector names, business domains, "
        "or actions. Do not search for generic implementation words like mcp, tool, server, or deferred."
    )


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
        raw_terms = [term for term in " ".join(str(query or "").strip().casefold().split()).split(" ") if term]
        terms = _normalize_query_terms(query)
        if raw_terms and not terms:
            return []
        scored: list[tuple[int, str, ToolDefinition]] = []
        for tool in self.deferred_tools():
            haystack = _semantic_haystack(tool)
            semantic_name = _semantic_tool_name(tool.name).casefold()
            if not terms:
                score = 1
            else:
                score = sum(2 if term in semantic_name else 1 for term in terms if term in haystack)
            if score > 0:
                scored.append((score, tool.name, tool))
        scored.sort(key=lambda item: (-item[0], item[1]))
        return [tool for _score, _name, tool in scored[: max(1, min(int(limit or 8), 20))]]


def register_tool_search(registry: UnifiedToolRegistry, exposure_state: ToolExposureState) -> None:
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
            description=_tool_search_description(exposure_state),
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
