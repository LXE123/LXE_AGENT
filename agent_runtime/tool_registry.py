from __future__ import annotations

from shared.logging import logger

from .tools.coding_tools import CODING_TOOL_NAMES, register_coding_tools
from .tools.feishu_im_tools import register_feishu_im_tools
from .types import ToolDefinition, ToolSchema


class UnifiedToolRegistry:
    """Global registry for tools available to the agent loop."""

    def __init__(self) -> None:
        self._tools: dict[str, ToolDefinition] = {}

    def register(self, tool: ToolDefinition) -> None:
        name = str(tool.name or "").strip()
        if not name:
            raise ValueError("tool name is required")
        self._tools[name] = tool

    def get(self, name: str) -> ToolDefinition | None:
        return self._tools.get(str(name or "").strip())

    def all_names(self) -> list[str]:
        return list(self._tools.keys())

    def tool_schemas(self, names: list[str] | None = None) -> list[ToolSchema]:
        tools = self._tools.values() if names is None else [self._tools[name] for name in names if name in self._tools]
        return [
            {
                "name": tool.name,
                "description": tool.description,
                "parameters": dict(tool.parameters),
            }
            for tool in tools
        ]

    def has(self, name: str) -> bool:
        return str(name or "").strip() in self._tools

    def definitions(self, names: list[str] | None = None) -> list[ToolDefinition]:
        if names is None:
            return list(self._tools.values())
        return [self._tools[name] for name in names if name in self._tools]


_registry = UnifiedToolRegistry()


def get_registry() -> UnifiedToolRegistry:
    return _registry


ALWAYS_AVAILABLE_NAMES: set[str] = set()


def register_browser_tools(registry: UnifiedToolRegistry | None = None) -> None:
    from agent_runtime.packs.browser.tools import browser_planner_tool_schemas
    from agent_runtime.tool_executor import make_browser_tool_handler
    from services.browser.store.ziniao_config import ziniao_tool_config_status

    reg = registry or _registry
    configured, reason = ziniao_tool_config_status()
    if not configured:
        logger.info("[ToolRegistry] skip Ziniao browser tools: %s", reason)
        return

    registered_count = 0
    for schema in browser_planner_tool_schemas():
        name = str(schema.get("name") or "").strip()
        if not name or reg.has(name):
            continue
        reg.register(
            ToolDefinition(
                name=name,
                description=str(schema.get("description") or "").strip(),
                parameters=dict(schema.get("input_schema") or {"type": "object", "properties": {}}),
                handler=make_browser_tool_handler(name),
                requires_resource="browser",
            )
        )
        registered_count += 1
    logger.info("[ToolRegistry] registered browser tools=%s total_tools=%s", registered_count, len(reg.all_names()))


def ensure_all_tools_registered(registry: UnifiedToolRegistry | None = None) -> UnifiedToolRegistry:
    reg = registry or _registry
    register_coding_tools(reg)
    register_feishu_im_tools(reg)
    register_browser_tools(reg)
    return reg


__all__ = [
    "ALWAYS_AVAILABLE_NAMES",
    "UnifiedToolRegistry",
    "ensure_all_tools_registered",
    "get_registry",
]
