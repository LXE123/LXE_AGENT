from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class ToolExecutionFact:
    tool_name: str
    success: bool
    state_data_patch: dict[str, Any] = field(default_factory=dict)
    summary: str = ""
    verification: dict[str, Any] = field(default_factory=dict)
    after_snapshot: dict[str, Any] = field(default_factory=dict)
    screenshot_path: str = ""
    payload: dict[str, Any] = field(default_factory=dict)
    failure_reason: str = ""
    error_code: str = ""
    clicked_element: dict[str, Any] = field(default_factory=dict)
    latency_ms: int = 0
    control_kind: str = ""
    control_text: str = ""
    user_goal: str = ""


__all__ = ["ToolExecutionFact"]
