from __future__ import annotations

import asyncio
from dataclasses import replace
from typing import Any

from shared.logging import logger

from .client import AsyncMcpClient
from .config import McpConfig, McpServerConfig, load_mcp_config
from .models import McpRoute, McpServerStatus, McpToolInfo
from .naming import normalize_mcp_tools
from .schema import mcp_tool_description, model_visible_input_schema


class McpConnectionManager:
    def __init__(self, config: McpConfig) -> None:
        self.config = config
        self._clients: dict[str, AsyncMcpClient] = {}
        self._statuses: dict[str, McpServerStatus] = {}
        self._tools: list[McpToolInfo] = []

    @property
    def tools(self) -> list[McpToolInfo]:
        return list(self._tools)

    @property
    def statuses(self) -> list[McpServerStatus]:
        ordered = []
        for server in self.config.servers:
            ordered.append(
                self._statuses.get(
                    server.name,
                    McpServerStatus(
                        name=server.name,
                        enabled=server.enabled,
                        transport=server.transport,
                        status="disabled" if not server.enabled else "error",
                    ),
                )
            )
        return ordered

    async def start(self) -> None:
        disabled = [server for server in self.config.servers if not server.enabled]
        for server in disabled:
            self._statuses[server.name] = McpServerStatus(
                name=server.name,
                enabled=False,
                transport=server.transport,
                status="disabled",
                connector_id=server.connector_id,
                connector_name=server.connector_name,
                connector_description=server.connector_description,
            )
        await asyncio.gather(
            *(self._start_server(server) for server in self.config.enabled_servers()),
            return_exceptions=False,
        )
        self._tools = normalize_mcp_tools(self._tools)
        self._sync_status_tools()

    async def _start_server(self, server: McpServerConfig) -> None:
        client = AsyncMcpClient(server)
        try:
            await client.start()
        except Exception as exc:
            logger.warning("[MCP] server startup failed: server=%s error=%s", server.name, exc)
            self._statuses[server.name] = McpServerStatus(
                name=server.name,
                enabled=True,
                transport=server.transport,
                status="error",
                error=str(exc),
                connector_id=server.connector_id,
                connector_name=server.connector_name,
                connector_description=server.connector_description,
            )
            return

        self._clients[server.name] = client
        init_result = client.initialize_result
        server_info = getattr(init_result, "serverInfo", None)
        instructions = str(getattr(init_result, "instructions", "") or "").strip()
        tools = [
            self._tool_info_from_raw(server, raw_tool, instructions)
            for raw_tool in client.tools
            if server.allows_tool(str(getattr(raw_tool, "name", "") or "").strip())
        ]
        self._tools.extend(tools)
        self._statuses[server.name] = McpServerStatus(
            name=server.name,
            enabled=True,
            transport=server.transport,
            status="ready",
            tool_count=len(tools),
            server_title=str(getattr(server_info, "title", "") or getattr(server_info, "name", "") or "").strip(),
            server_version=str(getattr(server_info, "version", "") or "").strip(),
            instructions=instructions,
            connector_id=server.connector_id,
            connector_name=server.connector_name,
            connector_description=server.connector_description,
        )

    def _tool_info_from_raw(
        self,
        server: McpServerConfig,
        raw_tool: Any,
        instructions: str,
    ) -> McpToolInfo:
        raw_name = str(getattr(raw_tool, "name", "") or "").strip()
        title = str(getattr(raw_tool, "title", "") or "").strip()
        description = mcp_tool_description(raw_tool)
        input_schema = model_visible_input_schema(getattr(raw_tool, "inputSchema", {}) or {})
        output_schema = getattr(raw_tool, "outputSchema", None)
        callable_namespace = server.connector_name or server.name
        callable_name = raw_name
        exposure = "direct" if server.exposure == "direct" else "deferred"
        search_text = _build_search_text(
            server=server,
            raw_name=raw_name,
            callable_namespace=callable_namespace,
            callable_name=callable_name,
            title=title,
            description=description,
            input_schema=input_schema,
            instructions=instructions,
        )
        return McpToolInfo(
            server_name=server.name,
            raw_tool_name=raw_name,
            callable_namespace=callable_namespace,
            callable_name=callable_name,
            model_name=raw_name,
            description=description,
            input_schema=input_schema,
            output_schema=dict(output_schema or {}) if isinstance(output_schema, dict) else None,
            title=title,
            server_instructions=instructions,
            connector_id=server.connector_id,
            connector_name=server.connector_name,
            connector_description=server.connector_description,
            exposure=exposure,
            search_text=search_text,
        )

    def _sync_status_tools(self) -> None:
        tools_by_server: dict[str, list[dict[str, Any]]] = {}
        for tool in self._tools:
            tools_by_server.setdefault(tool.server_name, []).append(tool.to_payload())
        for server_name, status in list(self._statuses.items()):
            status.tools = sorted(
                tools_by_server.get(server_name, []),
                key=lambda item: str(item.get("model_name") or "").casefold(),
            )
            status.tool_count = len(status.tools) if status.status == "ready" else status.tool_count
            self._statuses[server_name] = status

    async def call_tool(self, route: McpRoute, arguments: dict[str, Any] | None = None) -> Any:
        client = self._clients.get(route.server_name)
        if client is None:
            raise RuntimeError(f"MCP server is not connected: {route.server_name}")
        return await client.call_tool(route.raw_tool_name, arguments)

    async def close(self) -> None:
        clients = list(self._clients.values())
        self._clients.clear()
        await asyncio.gather(*(client.close() for client in clients), return_exceptions=True)

    def status_payloads(self) -> list[dict[str, Any]]:
        return [status.to_payload() for status in self.statuses]

    def tool_payloads(self) -> list[dict[str, Any]]:
        return [tool.to_payload() for tool in self._tools]


def _build_search_text(
    *,
    server: McpServerConfig,
    raw_name: str,
    callable_namespace: str,
    callable_name: str,
    title: str,
    description: str,
    input_schema: dict[str, Any],
    instructions: str,
) -> str:
    properties = dict(input_schema.get("properties") or {})
    parts = [
        server.name,
        server.connector_id,
        server.connector_name,
        server.connector_description,
        raw_name,
        callable_namespace,
        callable_name,
        title,
        description,
        instructions,
        " ".join(sorted(str(key) for key in properties)),
    ]
    return " ".join(part.strip() for part in parts if str(part or "").strip())


async def build_mcp_connection_manager(config: McpConfig | None = None) -> McpConnectionManager:
    manager = McpConnectionManager(config or load_mcp_config())
    await manager.start()
    return manager


__all__ = ["McpConnectionManager", "build_mcp_connection_manager"]
