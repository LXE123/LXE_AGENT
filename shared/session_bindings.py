from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any
from uuid import uuid4

from shared.db.sqlite.engine import database_path


_DEFAULT_AGENT_NAME = "agent"
_DEFAULT_ENTRYPOINT = "main"


def _utc_now_text() -> str:
    return datetime.now(timezone.utc).isoformat()


def _clean_text(value: Any) -> str:
    return str(value or "").strip()


def _clean_extra(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


def _normalize_chat_type(value: Any) -> str:
    text = _clean_text(value).lower()
    if text in {"p2p", "private", "dm", "direct"}:
        return "dm"
    if text in {"group", "chat"}:
        return "group"
    if text in {"channel", "thread"}:
        return text
    return text or "dm"


def session_bindings_path() -> Path:
    configured = _clean_text(os.getenv("AGENT_SESSION_BINDINGS_PATH"))
    if configured:
        return Path(configured).expanduser()
    return database_path().parent / "sessions.json"


@dataclass(slots=True)
class SessionSource:
    platform: str
    chat_id: str
    chat_type: str
    user_id: str = ""
    user_id_alt: str = ""
    user_name: str = ""
    chat_name: str = ""
    thread_id: str = ""
    message_id: str = ""
    root_id: str = ""
    parent_id: str = ""
    is_bot: bool = False
    extra: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, value: dict[str, Any] | None) -> "SessionSource":
        raw = dict(value or {})
        return cls(
            platform=_clean_text(raw.get("platform")),
            chat_id=_clean_text(raw.get("chat_id")),
            chat_type=_normalize_chat_type(raw.get("chat_type")),
            user_id=_clean_text(raw.get("user_id")),
            user_id_alt=_clean_text(raw.get("user_id_alt")),
            user_name=_clean_text(raw.get("user_name")),
            chat_name=_clean_text(raw.get("chat_name")),
            thread_id=_clean_text(raw.get("thread_id")),
            message_id=_clean_text(raw.get("message_id")),
            root_id=_clean_text(raw.get("root_id")),
            parent_id=_clean_text(raw.get("parent_id")),
            is_bot=bool(raw.get("is_bot")),
            extra=_clean_extra(raw.get("extra")),
        )

    def normalized(self) -> "SessionSource":
        return SessionSource.from_dict(self.to_dict())

    @property
    def user_key(self) -> str:
        return _clean_text(self.user_id_alt) or _clean_text(self.user_id)

    @property
    def session_key(self) -> str:
        source = self.normalized()
        platform = _clean_text(source.platform)
        chat_type = _normalize_chat_type(source.chat_type)
        chat_id = _clean_text(source.chat_id)
        if not platform:
            raise RuntimeError("session source platform required")
        if not chat_id:
            raise RuntimeError("session source chat_id required")
        prefix = f"{_DEFAULT_AGENT_NAME}:{_DEFAULT_ENTRYPOINT}:{platform}"
        if chat_type == "dm":
            return f"{prefix}:dm:{chat_id}"
        if chat_type == "group":
            thread_id = _clean_text(source.thread_id)
            if thread_id:
                return f"{prefix}:group:{chat_id}:{thread_id}"
            user_key = source.user_key
            if not user_key:
                raise RuntimeError("group session source user_id or user_id_alt required")
            return f"{prefix}:group:{chat_id}:{user_key}"
        return f"{prefix}:{chat_type}:{chat_id}"

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["chat_type"] = _normalize_chat_type(data.get("chat_type"))
        return {
            key: value
            for key, value in data.items()
            if value is not None and value != "" and not (key == "extra" and not value)
        }


@dataclass(slots=True)
class SessionBindingEntry:
    session_key: str
    session_id: str
    created_at: str
    updated_at: str
    origin: dict[str, Any]
    platform: str
    chat_type: str
    resume_pending: bool = False
    suspended: bool = False

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "SessionBindingEntry":
        raw = dict(value or {})
        origin = dict(raw.get("origin") or {})
        return cls(
            session_key=_clean_text(raw.get("session_key")),
            session_id=_clean_text(raw.get("session_id")),
            created_at=_clean_text(raw.get("created_at")),
            updated_at=_clean_text(raw.get("updated_at")),
            origin=origin,
            platform=_clean_text(raw.get("platform") or origin.get("platform")),
            chat_type=_normalize_chat_type(raw.get("chat_type") or origin.get("chat_type")),
            resume_pending=bool(raw.get("resume_pending")),
            suspended=bool(raw.get("suspended")),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "session_key": self.session_key,
            "session_id": self.session_id,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "origin": dict(self.origin or {}),
            "platform": self.platform,
            "chat_type": self.chat_type,
            "resume_pending": bool(self.resume_pending),
            "suspended": bool(self.suspended),
        }


class SessionBindingStore:
    def __init__(self, path: Path | None = None) -> None:
        self.path = Path(path) if path is not None else session_bindings_path()

    def load_all(self) -> dict[str, SessionBindingEntry]:
        if not self.path.is_file():
            return {}
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8") or "{}")
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"invalid sessions.json: {self.path}") from exc
        if not isinstance(raw, dict):
            raise RuntimeError(f"sessions.json must be a JSON object: {self.path}")
        entries: dict[str, SessionBindingEntry] = {}
        for key, value in raw.items():
            if not isinstance(value, dict):
                continue
            entry = SessionBindingEntry.from_dict(value)
            session_key = _clean_text(entry.session_key or key)
            if session_key and entry.session_id:
                entry.session_key = session_key
                entries[session_key] = entry
        return entries

    def save_all(self, entries: dict[str, SessionBindingEntry]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            key: entry.to_dict()
            for key, entry in sorted(dict(entries or {}).items())
            if key and entry.session_id
        }
        encoded = json.dumps(payload, ensure_ascii=False, indent=2)
        with NamedTemporaryFile(
            "w",
            encoding="utf-8",
            dir=str(self.path.parent),
            delete=False,
            prefix=f".{self.path.name}.",
            suffix=".tmp",
        ) as fh:
            fh.write(encoded)
            fh.write("\n")
            temp_path = Path(fh.name)
        temp_path.replace(self.path)

    def get(self, session_key: str) -> SessionBindingEntry | None:
        return self.load_all().get(_clean_text(session_key))

    def bind(self, source: SessionSource, *, session_id: str) -> SessionBindingEntry:
        normalized = source.normalized()
        session_key = normalized.session_key
        now = _utc_now_text()
        entries = self.load_all()
        existing = entries.get(session_key)
        created_at = existing.created_at if existing else now
        entry = SessionBindingEntry(
            session_key=session_key,
            session_id=_clean_text(session_id),
            created_at=created_at,
            updated_at=now,
            origin=normalized.to_dict(),
            platform=_clean_text(normalized.platform),
            chat_type=_normalize_chat_type(normalized.chat_type),
            resume_pending=bool(existing.resume_pending) if existing else False,
            suspended=bool(existing.suspended) if existing else False,
        )
        entries[session_key] = entry
        self.save_all(entries)
        return entry

    def get_or_create(self, source: SessionSource) -> SessionBindingEntry:
        normalized = source.normalized()
        session_key = normalized.session_key
        entries = self.load_all()
        existing = entries.get(session_key)
        if existing is not None and existing.session_id:
            return existing
        return self.bind(normalized, session_id=uuid4().hex)

    def rotate(self, source: SessionSource) -> SessionBindingEntry:
        return self.bind(source.normalized(), session_id=uuid4().hex)


def build_session_source(value: dict[str, Any] | None) -> SessionSource:
    return SessionSource.from_dict(value)


__all__ = [
    "SessionBindingEntry",
    "SessionBindingStore",
    "SessionSource",
    "build_session_source",
    "session_bindings_path",
]
