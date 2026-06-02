from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True, slots=True)
class LLMToolCall:
    """Parsed tool_use block from an LLM response."""

    id: str
    name: str
    arguments: dict[str, Any]


@dataclass(frozen=True, slots=True)
class LLMStreamEvent:
    event_type: str
    text: str = ""
    thinking_text: str = ""
    signature: str = ""
    redacted_data: str = ""
    tool_call: LLMToolCall | None = None
    usage: dict[str, Any] = field(default_factory=dict)
    stop_reason: str = ""
    message_id: str = ""
    model: str = ""
    index: int = -1
    raw: dict[str, Any] = field(default_factory=dict)


__all__ = [
    "LLMStreamEvent",
    "LLMToolCall",
]
