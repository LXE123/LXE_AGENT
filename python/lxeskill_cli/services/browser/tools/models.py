from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class ExecuteToolResult:
    tool_name: str
    success: bool
    summary: str = ""
    verification: dict[str, Any] = field(default_factory=dict)
    payload: dict[str, Any] = field(default_factory=dict)
    failure_reason: str = ""
    error_code: str = ""
    latency_ms: int = 0

@dataclass(frozen=True)
class ToolExecutionResult:
    tool_name: str
    success: bool
    content: list[dict[str, Any]] = field(default_factory=list)
    files: list[str] = field(default_factory=list)
    error_code: str = ""
    error_message: str = ""


__all__ = ["ExecuteToolResult", "ToolExecutionResult"]
