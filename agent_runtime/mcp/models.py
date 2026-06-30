from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal


@dataclass(frozen=True)
class McpRoute:
    server_name: str
    raw_tool_name: str

    def to_dict(self) -> dict[str, str]:
        return asdict(self)


@dataclass(frozen=True)
class McpToolInfo:
    server_name: str
    raw_tool_name: str
    callable_namespace: str
    callable_name: str
    model_name: str
    description: str
    input_schema: dict[str, Any]
    output_schema: dict[str, Any] | None = None
    title: str = ""
    server_instructions: str = ""
    connector_id: str = ""
    connector_name: str = ""
    connector_description: str = ""
    exposure: Literal["direct", "deferred"] = "deferred"
    search_text: str = ""

    @property
    def route(self) -> McpRoute:
        return McpRoute(server_name=self.server_name, raw_tool_name=self.raw_tool_name)

    def to_payload(self) -> dict[str, Any]:
        return {
            "server_name": self.server_name,
            "raw_tool_name": self.raw_tool_name,
            "callable_namespace": self.callable_namespace,
            "callable_name": self.callable_name,
            "model_name": self.model_name,
            "description": self.description,
            "parameters": dict(self.input_schema or {}),
            "output_schema": dict(self.output_schema or {}),
            "title": self.title,
            "connector_id": self.connector_id,
            "connector_name": self.connector_name,
            "connector_description": self.connector_description,
            "exposure": self.exposure,
            "search_text": self.search_text,
        }


@dataclass
class McpServerStatus:
    name: str
    enabled: bool
    transport: str
    status: Literal["disabled", "ready", "error"] = "disabled"
    tool_count: int = 0
    error: str = ""
    server_title: str = ""
    server_version: str = ""
    instructions: str = ""
    connector_id: str = ""
    connector_name: str = ""
    connector_description: str = ""
    tools: list[dict[str, Any]] = field(default_factory=list)

    def to_payload(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "enabled": self.enabled,
            "transport": self.transport,
            "status": self.status,
            "tool_count": self.tool_count,
            "error": self.error,
            "server_title": self.server_title,
            "server_version": self.server_version,
            "instructions": self.instructions,
            "connector_id": self.connector_id,
            "connector_name": self.connector_name,
            "connector_description": self.connector_description,
            "tools": list(self.tools),
        }


__all__ = ["McpRoute", "McpServerStatus", "McpToolInfo"]
