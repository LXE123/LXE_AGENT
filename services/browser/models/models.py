from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class AgentCommand:
    session_id: str
    message_text: str = ""
    state_data: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class AgentResult:
    success: bool
    status: str
    message: str
    waiting_reason: str = ""
    state_data: dict[str, Any] = field(default_factory=dict)
    error: str = ""


@dataclass(frozen=True, slots=True)
class ToolArgumentDefinition:
    name: str
    description: str
    value_type: str = "string"
    required: bool = False
    default: Any = None
    enum: tuple[str, ...] = field(default_factory=tuple)
    minimum: int | None = None
    maximum: int | None = None


@dataclass(frozen=True, slots=True)
class ToolDefinition:
    name: str
    description: str
    arguments: tuple[ToolArgumentDefinition, ...] = field(default_factory=tuple)
    stop_after_call: bool = False


@dataclass(slots=True)
class ToolCall:
    name: str
    arguments: dict[str, Any] = field(default_factory=dict)
    reason: str = ""
    summary: str = ""
    question: str = ""
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class ToolResult:
    tool_name: str
    summary: str = ""
    verification: dict[str, Any] = field(default_factory=dict)
    after_snapshot: dict[str, Any] = field(default_factory=dict)
    screenshot_path: str = ""
    payload: dict[str, Any] = field(default_factory=dict)
