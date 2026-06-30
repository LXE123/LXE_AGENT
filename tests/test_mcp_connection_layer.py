from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

from agent_runtime.mcp.config import load_mcp_config, resolve_server_headers
from agent_runtime.mcp.manager import build_mcp_connection_manager
from agent_runtime.mcp.models import McpToolInfo
from agent_runtime.mcp.naming import normalize_mcp_tools
from agent_runtime.mcp.registry import register_mcp_tools
from agent_runtime.tool_exposure import TOOL_SEARCH_NAME, ToolExposureState, register_tool_search
from agent_runtime.tool_registry import UnifiedToolRegistry
from agent_runtime.types import ToolDefinition, text_tool_result


def test_mcp_config_parses_saihu_streamable_http_and_env_header(monkeypatch, tmp_path: Path) -> None:
    config_path = tmp_path / "mcp.yaml"
    config_path.write_text(
        """
mcpServers:
  lxe-saihu:
    enabled: true
    type: streamable-http
    url: "http://127.0.0.1:8000/mcp/"
    headers:
      Authorization: "Bearer ${LXE_DATA_SERVER_API_KEY}"
    startup_timeout_s: 3
    tool_timeout_s: 9
    exposure: deferred
    enabled_tools:
      - shop_list
    disabled_tools:
      - hidden_tool
    connector_id: lxe-saihu
    connector_name: Saihu
""",
        encoding="utf-8",
    )
    monkeypatch.setenv("LXE_DATA_SERVER_API_KEY", "secret-token")

    config = load_mcp_config(config_path)

    assert len(config.servers) == 1
    server = config.servers[0]
    assert server.name == "lxe-saihu"
    assert server.transport == "streamable-http"
    assert server.url == "http://127.0.0.1:8000/mcp/"
    assert server.enabled_tools == frozenset({"shop_list"})
    assert server.disabled_tools == frozenset({"hidden_tool"})
    assert server.allows_tool("shop_list") is True
    assert server.allows_tool("hidden_tool") is False
    assert resolve_server_headers(server) == {"Authorization": "Bearer secret-token"}


def test_mcp_config_rejects_invalid_server_names(tmp_path: Path) -> None:
    config_path = tmp_path / "mcp.yaml"
    config_path.write_text(
        """
mcpServers:
  "bad/name":
    type: stdio
    command: python
""",
        encoding="utf-8",
    )

    with pytest.raises(RuntimeError, match="invalid MCP server name"):
        load_mcp_config(config_path)


def test_mcp_tool_normalization_deduplicates_and_limits_names() -> None:
    long_name = "tool-" + ("x" * 120)
    tools = [
        McpToolInfo(
            server_name="srv_a",
            raw_tool_name=long_name,
            callable_namespace="Saihu Connector",
            callable_name=long_name,
            model_name="",
            description="",
            input_schema={"type": "object", "properties": {}},
        ),
        McpToolInfo(
            server_name="srv_b",
            raw_tool_name=long_name,
            callable_namespace="Saihu Connector",
            callable_name=long_name,
            model_name="",
            description="",
            input_schema={"type": "object", "properties": {}},
        ),
    ]

    normalized = normalize_mcp_tools(tools)
    model_names = [tool.model_name for tool in normalized]

    assert len(set(model_names)) == 2
    assert all(name.startswith("mcp__Saihu_Connector__tool") for name in model_names)
    assert all(len(name.encode("utf-8")) <= 64 for name in model_names)
    assert {tool.route.server_name for tool in normalized} == {"srv_a", "srv_b"}
    assert {tool.route.raw_tool_name for tool in normalized} == {long_name}


def test_tool_search_loads_deferred_mcp_tools_for_next_step() -> None:
    registry = UnifiedToolRegistry()

    async def builtin_handler(**_kwargs):
        return text_tool_result("ok")

    async def mcp_handler(**_kwargs):
        return text_tool_result("mcp")

    registry.register(
        ToolDefinition(
            name="read",
            description="Read files",
            parameters={"type": "object", "properties": {}},
            handler=builtin_handler,
        )
    )
    registry.register(
        ToolDefinition(
            name="mcp__saihu__shop_list",
            description="List Saihu shops",
            parameters={"type": "object", "properties": {}},
            handler=mcp_handler,
            source="mcp",
            exposure="deferred",
            search_text="saihu shop list",
            server_name="lxe-saihu",
            connector_name="Saihu",
        )
    )
    exposure = ToolExposureState(registry=registry, search_enabled=True)
    register_tool_search(registry, exposure)

    assert "read" in exposure.active_names()
    assert TOOL_SEARCH_NAME in exposure.active_names()
    assert "mcp__saihu__shop_list" not in exposure.active_names()

    search_tool = registry.get(TOOL_SEARCH_NAME)
    assert search_tool is not None
    result = asyncio.run(search_tool.handler(query="saihu shop", limit=5))

    assert "mcp__saihu__shop_list" in result.content[0]["text"]
    assert "mcp__saihu__shop_list" in exposure.active_names()


def test_stdio_mcp_server_lists_and_executes_tools(tmp_path: Path) -> None:
    server_script = tmp_path / "fake_mcp_server.py"
    server_script.write_text(
        """
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("fake-stdio")

@mcp.tool()
def echo(text: str) -> str:
    return "echo:" + text

if __name__ == "__main__":
    mcp.run()
""",
        encoding="utf-8",
    )
    config_path = tmp_path / "mcp.yaml"
    config_path.write_text(
        f"""
mcpServers:
  fake:
    type: stdio
    command: "{sys.executable}"
    args:
      - "{server_script}"
    startup_timeout_s: 8
    tool_timeout_s: 8
    exposure: direct
""",
        encoding="utf-8",
    )

    async def _run() -> None:
        manager = await build_mcp_connection_manager(load_mcp_config(config_path))
        try:
            assert manager.status_payloads()[0]["status"] == "ready"
            assert [tool["raw_tool_name"] for tool in manager.tool_payloads()] == ["echo"]

            registry = UnifiedToolRegistry()
            registered = register_mcp_tools(registry, manager)
            assert len(registered) == 1
            tool_def = registry.get(registered[0])
            assert tool_def is not None
            result = await tool_def.handler(text="hi")
            assert result.content[0]["text"] == "echo:hi"
        finally:
            await manager.close()

    asyncio.run(_run())
