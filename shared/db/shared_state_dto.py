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
class AgentContextState:
    context_id: str
    context_data: Dict[str, Any]
    created_at: Optional[datetime]
    updated_at: Optional[datetime]


@dataclass
class AgentSessionState:
    session_id: str
    context_id: str
    source: Dict[str, Any]
    status: str
    state_data: Dict[str, Any]
    created_at: Optional[datetime]
    updated_at: Optional[datetime]


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
    "AgentContextState",
    "AgentSessionState",
    "CardContext",
    "ZiniaoStoreSessionState",
]
