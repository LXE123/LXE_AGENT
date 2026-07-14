from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class ExecuteToolResult:
    tool_name: str
    success: bool
    summary: str = ""
    verification: dict[str, Any] = field(default_factory=dict)
    after_snapshot: dict[str, Any] = field(default_factory=dict)
    screenshot_path: str = ""
    payload: dict[str, Any] = field(default_factory=dict)
    failure_reason: str = ""
    error_code: str = ""
    clicked_element: dict[str, Any] = field(default_factory=dict)
    latency_ms: int = 0
    state_data: dict[str, Any] = field(default_factory=dict)

@dataclass(frozen=True)
class ToolExecutionResult:
    tool_name: str
    success: bool
    content: list[dict[str, Any]] = field(default_factory=list)
    state_patch: dict[str, Any] = field(default_factory=dict)
    files: list[str] = field(default_factory=list)
    error_code: str = ""
    error_message: str = ""


__all__ = ["ExecuteToolResult", "ToolExecutionResult"]
