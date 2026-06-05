from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, Optional


@dataclass
class CardContext:
    out_track_id: str
    owner_user_id: str
    platform: str
    platform_message_id: Optional[str]
    conversation_id: Optional[str]
    conversation_type: Optional[str]
    sender_nick: Optional[str]
    extra_data: Dict[str, Any]
    created_at: Optional[datetime]
    updated_at: Optional[datetime]


@dataclass
class AgentSessionState:
    session_id: str
    source: Dict[str, Any]
    state_data: Dict[str, Any]
    model: str
    model_config: Dict[str, Any]
    created_at: float
    last_active_at: float
    message_count: int
    tool_call_count: int
    input_tokens: int
    output_tokens: int
    title: str
    api_call_count: int


@dataclass
class ZiniaoStoreSessionState:
    host_id: str
    browser_oauth: str
    browser_id: int
    browser_name: str
    debugging_port: int
    download_path: str
    browser_path: str
    created_at: Optional[datetime]
    updated_at: Optional[datetime]


__all__ = [
    "AgentSessionState",
    "CardContext",
    "ZiniaoStoreSessionState",
]
