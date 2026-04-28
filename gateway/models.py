from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class InboundEvent:
    platform: str
    connector_key: str
    event_type: str
    user_input: str
    user_id: str
    conversation_id: str
    is_group: bool
    message_id: str
    sender_nick: str = ""
    card_id: str = ""
    raw_data: dict[str, Any] = field(default_factory=dict)
    user_content_blocks: list[dict[str, Any]] = field(default_factory=list)


@dataclass(slots=True)
class CallbackEvent:
    platform: str
    connector_key: str
    out_track_id: str
    message_id: str
    user_id: str
    raw_data: dict[str, Any] = field(default_factory=dict)
    params: dict[str, Any] = field(default_factory=dict)
    callback_id: str = ""


@dataclass(frozen=True, slots=True)
class LaneKey:
    platform: str
    connector_key: str
    owner_id: str
    conversation_id: str = ""
    scope: str = "message"

    def as_key(self) -> str:
        return "|".join(
            [
                str(self.platform or "").strip(),
                str(self.connector_key or "").strip(),
                str(self.scope or "").strip(),
                str(self.owner_id or "").strip(),
                str(self.conversation_id or "").strip(),
            ]
        )


@dataclass(slots=True)
class RouteDecision:
    route_kind: str
    lane_key: str
    connector_key: str
    platform: str


@dataclass(slots=True)
class OutboundRequest:
    action: str
    platform: str
    connector_key: str
    payload: dict[str, Any] = field(default_factory=dict)
    session_id: str = ""
    card_id: str = ""
    event_id: str = ""
    execution_token: str = ""


@dataclass(slots=True)
class OutboundHandle:
    platform: str
    connector_key: str
    conversation_id: str
    platform_message_id: str = ""
