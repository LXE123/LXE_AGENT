"""Platform-neutral session context."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class SessionContext:
    platform: str
    user_input: str
    user_id: str
    response_route_id: str
    conversation_id: str
    is_group: bool
    message_id: str
    sender_nick: str = ""
    session_key: str = ""
    source: dict[str, Any] = field(default_factory=dict)
    raw_data: dict[str, Any] = field(default_factory=dict)
    user_content_blocks: list[dict[str, Any]] = field(default_factory=list)
