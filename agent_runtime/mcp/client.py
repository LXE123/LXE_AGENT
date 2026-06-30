from __future__ import annotations

import asyncio
from contextlib import AsyncExitStack
from datetime import timedelta
from typing import Any

from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client
from mcp.client.streamable_http import streamablehttp_client
from mcp.types import Implementation

from .config import McpServerConfig, resolve_env_placeholders, resolve_server_headers


class AsyncMcpClient:
    def __init__(self, config: McpServerConfig) -> None:
        self.config = config
        self._exit_stack: AsyncExitStack | None = None
        self.session: ClientSession | None = None
        self.initialize_result: Any = None
        self.tools: list[Any] = []

    async def start(self) -> None:
        stack = AsyncExitStack()
        try:
            if self.config.transport == "stdio":
                if not self.config.command:
                    raise RuntimeError(f"MCP server {self.config.name} missing command")
                params = StdioServerParameters(
                    command=self.config.command,
                    args=list(self.config.args),
                    env={
                        key: resolve_env_placeholders(value, field_name=f"{self.config.name}.env.{key}")
                        for key, value in self.config.env.items()
                    },
                    cwd=self.config.cwd or None,
                )
                read_stream, write_stream = await stack.enter_async_context(stdio_client(params))
            elif self.config.transport == "streamable-http":
                if not self.config.url:
                    raise RuntimeError(f"MCP server {self.config.name} missing url")
                headers = resolve_server_headers(self.config)
                read_stream, write_stream, _session_id = await stack.enter_async_context(
                    streamablehttp_client(
                        self.config.url,
                        headers=headers or None,
                        timeout=self.config.startup_timeout_s,
                        sse_read_timeout=max(self.config.tool_timeout_s, self.config.startup_timeout_s),
                    )
                )
            else:
                raise RuntimeError(f"unsupported MCP transport: {self.config.transport}")

            session = ClientSession(
                read_stream,
                write_stream,
                read_timeout_seconds=timedelta(seconds=self.config.tool_timeout_s),
                client_info=Implementation(name="lxe-agent", title="LXE Agent", version="0.1.0"),
            )
            self.session = await stack.enter_async_context(session)
            self.initialize_result = await asyncio.wait_for(
                self.session.initialize(),
                timeout=self.config.startup_timeout_s,
            )
            self.tools = await self._list_all_tools()
            self._exit_stack = stack
        except Exception:
            await stack.aclose()
            self.session = None
            raise

    async def _list_all_tools(self) -> list[Any]:
        if self.session is None:
            return []
        tools: list[Any] = []
        cursor: str | None = None
        while True:
            result = await asyncio.wait_for(
                self.session.list_tools(cursor=cursor),
                timeout=self.config.startup_timeout_s,
            )
            tools.extend(list(result.tools or []))
            cursor = str(result.nextCursor or "").strip() or None
            if cursor is None:
                return tools

    async def call_tool(self, raw_tool_name: str, arguments: dict[str, Any] | None = None) -> Any:
        if self.session is None:
            raise RuntimeError(f"MCP server {self.config.name} is not connected")
        return await self.session.call_tool(
            str(raw_tool_name or "").strip(),
            arguments=dict(arguments or {}),
            read_timeout_seconds=timedelta(seconds=self.config.tool_timeout_s),
        )

    async def close(self) -> None:
        if self._exit_stack is not None:
            await self._exit_stack.aclose()
        self._exit_stack = None
        self.session = None


__all__ = ["AsyncMcpClient"]
