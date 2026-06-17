from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


def _clean_tool_steps(raw_steps: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_steps, list):
        return []
    steps: list[dict[str, Any]] = []
    for raw_step in raw_steps:
        if not isinstance(raw_step, dict):
            continue
        status = str(raw_step.get("status") or "running").strip()
        if status not in {"running", "success", "error"}:
            status = "running"
        steps.append(
            {
                "id": str(raw_step.get("id") or "").strip(),
                "name": str(raw_step.get("name") or "tool").strip() or "tool",
                "title": str(raw_step.get("title") or "Tool").strip() or "Tool",
                "detail": str(raw_step.get("detail") or "").strip(),
                "status": status,
                "duration_ms": max(0, int(raw_step.get("duration_ms") or 0)),
            }
        )
    return steps


@dataclass(slots=True)
class AgentJob:
    job_id: str
    session_id: str
    session_key: str
    response_route_id: str
    user_id: str
    conversation_id: str
    is_group: bool
    message_id: str
    user_input: str
    job_kind: str = "turn"
    sender_nick: str = ""
    source: dict[str, Any] = field(default_factory=dict)
    raw_data: dict[str, Any] = field(default_factory=dict)
    user_content_blocks: list[dict[str, Any]] = field(default_factory=list)

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "AgentJob":
        raw = dict(payload or {})
        return cls(
            job_id=str(raw.get("job_id") or "").strip(),
            job_kind=str(raw.get("job_kind") or "turn").strip() or "turn",
            session_id=str(raw.get("session_id") or "").strip(),
            session_key=str(raw.get("session_key") or "").strip(),
            response_route_id=str(raw.get("response_route_id") or "").strip(),
            user_id=str(raw.get("user_id") or "").strip(),
            conversation_id=str(raw.get("conversation_id") or "").strip(),
            is_group=bool(raw.get("is_group")),
            message_id=str(raw.get("message_id") or "").strip(),
            user_input=str(raw.get("user_input") or "").strip(),
            sender_nick=str(raw.get("sender_nick") or "").strip(),
            source=dict(raw.get("source") or {}),
            raw_data=dict(raw.get("raw_data") or {}),
            user_content_blocks=list(raw.get("user_content_blocks") or []),
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class EmitRequest:
    session_id: str
    response_route_id: str = ""
    content: str = ""
    thinking: str = ""
    redacted_thinking_count: int = 0
    thinking_elapsed_ms: int = 0
    tool_pending: bool = False
    tool_elapsed_ms: int = 0
    tool_steps: list[dict[str, Any]] = field(default_factory=list)
    files: list[str] = field(default_factory=list)
    emit_kind: str = ""
    emit_id: str = ""
    stream_type: str = ""
    state: str = ""
    seq: int = 0

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "EmitRequest":
        raw = dict(payload or {})
        files_raw = raw.get("files") or []
        files: list[str] = []
        if isinstance(files_raw, list):
            files = [str(item or "").strip() for item in files_raw if str(item or "").strip()]
        return cls(
            session_id=str(raw.get("session_id") or "").strip(),
            response_route_id=str(raw.get("response_route_id") or "").strip(),
            content=str(raw.get("content") or "").strip(),
            thinking=str(raw.get("thinking") or "").strip(),
            redacted_thinking_count=max(0, int(raw.get("redacted_thinking_count") or 0)),
            thinking_elapsed_ms=max(0, int(raw.get("thinking_elapsed_ms") or 0)),
            tool_pending=bool(raw.get("tool_pending")),
            tool_elapsed_ms=max(0, int(raw.get("tool_elapsed_ms") or 0)),
            tool_steps=_clean_tool_steps(raw.get("tool_steps")),
            files=files,
            emit_kind=str(raw.get("emit_kind") or "").strip(),
            emit_id=str(raw.get("emit_id") or "").strip(),
            stream_type=str(raw.get("stream_type") or "").strip(),
            state=str(raw.get("state") or "").strip(),
            seq=int(raw.get("seq") or 0),
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class HeartbeatWakeRequest:
    session_id: str
    reason: str = "exec-event"
    response_route_id: str = ""

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "HeartbeatWakeRequest":
        raw = dict(payload or {})
        return cls(
            session_id=str(raw.get("session_id") or "").strip(),
            reason=str(raw.get("reason") or "exec-event").strip() or "exec-event",
            response_route_id=str(raw.get("response_route_id") or "").strip(),
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
