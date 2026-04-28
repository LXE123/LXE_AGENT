from __future__ import annotations

import json
from datetime import datetime, timezone
from sqlite3 import Row
from typing import Any, Optional

from shared.db.shared_state_dto import CardContext
from shared.logging import logger

from .engine import connection_scope


_NULL_BYTE = "\x00"
_NULL_BYTE_ESCAPE = "\\u0000"


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _datetime_to_storage(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


def _datetime_from_storage(value: Any) -> Optional[datetime]:
    text = str(value or "").strip()
    if not text:
        return None
    return datetime.fromisoformat(text)


def _sanitize_text(value: Any) -> str:
    if value is None:
        return ""
    text = str(value)
    return text.replace(_NULL_BYTE, _NULL_BYTE_ESCAPE)


def _sanitize_optional_text(value: Any, *, strip: bool = True) -> Optional[str]:
    if value is None:
        return None
    text = _sanitize_text(value)
    if strip:
        text = text.strip()
    return text or None


def _sanitize_json_for_storage(value: Any) -> Any:
    if isinstance(value, str):
        return _sanitize_text(value)
    if isinstance(value, dict):
        return {
            _sanitize_text(key) if isinstance(key, str) else key: _sanitize_json_for_storage(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_sanitize_json_for_storage(item) for item in value]
    if isinstance(value, tuple):
        return [_sanitize_json_for_storage(item) for item in value]
    return value


def _json_object_to_storage(value: dict[str, Any] | None) -> str:
    cleaned = _sanitize_json_for_storage(dict(value or {}))
    if not isinstance(cleaned, dict):
        raise RuntimeError("extra_data must be a JSON object")
    return json.dumps(cleaned, ensure_ascii=False, separators=(",", ":"))


def _json_object_from_storage(value: Any) -> dict[str, Any]:
    try:
        parsed = json.loads(str(value or "{}"))
    except json.JSONDecodeError as exc:
        raise RuntimeError("invalid card_owners.extra_data JSON") from exc
    if not isinstance(parsed, dict):
        raise RuntimeError("card_owners.extra_data must be a JSON object")
    return parsed


def _normalize_platform(value: Any) -> str:
    return str(value or "").strip() or "dingtalk"


def _normalize_connector_key(value: Any) -> str:
    return str(value or "").strip() or "agent"


def _to_context(row: Row) -> CardContext:
    return CardContext(
        out_track_id=str(row["out_track_id"]),
        owner_user_id=str(row["owner_user_id"]),
        platform=_normalize_platform(row["platform"]),
        connector_key=_normalize_connector_key(row["connector_key"]),
        platform_message_id=str(row["platform_message_id"] or "").strip() or None,
        conversation_id=row["conversation_id"],
        conversation_type=row["conversation_type"],
        sender_nick=row["sender_nick"],
        extra_data=_json_object_from_storage(row["extra_data"]),
        created_at=_datetime_from_storage(row["created_at"]),
        updated_at=_datetime_from_storage(row["updated_at"]),
    )


def create_context(ctx: Any) -> None:
    if not getattr(ctx, "card_id", None) or not getattr(ctx, "user_id", None):
        return

    now = _datetime_to_storage(_utc_now())
    raw_data = dict(getattr(ctx, "raw_data", {}) or {})
    platform = _normalize_platform(getattr(ctx, "platform", None) or raw_data.get("platform"))
    connector_key = _normalize_connector_key(
        getattr(ctx, "connector_key", None)
        or raw_data.get("connector_key")
        or raw_data.get("_bot_name")
    )
    extra_data = {
        "platform": platform,
        "connector_key": connector_key,
        "bot_name": str(raw_data.get("_bot_name") or getattr(ctx, "connector_key", "") or "").strip() or "agent",
        "robot_code": str(raw_data.get("robotCode") or "").strip(),
        "source_message_id": str(
            getattr(ctx, "message_id", "") or raw_data.get("message_id") or ""
        ).strip(),
    }

    with connection_scope() as conn:
        conn.execute(
            """
            INSERT INTO card_owners (
                out_track_id,
                owner_user_id,
                platform,
                connector_key,
                platform_message_id,
                conversation_id,
                conversation_type,
                sender_nick,
                extra_data,
                created_at,
                updated_at
            )
            VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(out_track_id) DO UPDATE SET
                owner_user_id = excluded.owner_user_id,
                platform = excluded.platform,
                connector_key = excluded.connector_key,
                conversation_id = excluded.conversation_id,
                conversation_type = excluded.conversation_type,
                sender_nick = excluded.sender_nick,
                extra_data = excluded.extra_data,
                updated_at = excluded.updated_at
            """,
            (
                str(ctx.card_id),
                str(ctx.user_id),
                platform,
                connector_key,
                getattr(ctx, "conversation_id", None),
                "2" if bool(getattr(ctx, "is_group", False)) else "1",
                getattr(ctx, "sender_nick", None),
                _json_object_to_storage(extra_data),
                now,
                now,
            ),
        )


def load_context(out_track_id: str) -> Optional[CardContext]:
    safe_out_track_id = str(out_track_id or "").strip()
    if not safe_out_track_id:
        return None

    with connection_scope() as conn:
        row = conn.execute(
            "SELECT * FROM card_owners WHERE out_track_id = ?",
            (safe_out_track_id,),
        ).fetchone()
        return _to_context(row) if row is not None else None


def save_session_patch(out_track_id: str, patch: dict[str, Any]) -> None:
    safe_out_track_id = str(out_track_id or "").strip()
    if not safe_out_track_id or not patch:
        return

    with connection_scope() as conn:
        row = conn.execute(
            "SELECT * FROM card_owners WHERE out_track_id = ?",
            (safe_out_track_id,),
        ).fetchone()
        if row is None:
            logger.warning("[CardState] card missing, skip patch: %s", safe_out_track_id)
            return

        current_data = _json_object_from_storage(row["extra_data"])
        current_data.update(dict(_sanitize_json_for_storage(patch) or {}))
        platform = row["platform"]
        connector_key = row["connector_key"]
        platform_message_id = row["platform_message_id"]
        if "platform" in patch:
            platform = _normalize_platform(patch.get("platform"))
        if "connector_key" in patch:
            connector_key = _normalize_connector_key(patch.get("connector_key"))
        if "platform_message_id" in patch:
            platform_message_id = _sanitize_optional_text(patch.get("platform_message_id"))
        conn.execute(
            """
            UPDATE card_owners
            SET platform = ?,
                connector_key = ?,
                platform_message_id = ?,
                extra_data = ?,
                updated_at = ?
            WHERE out_track_id = ?
            """,
            (
                platform,
                connector_key,
                platform_message_id,
                _json_object_to_storage(current_data),
                _datetime_to_storage(_utc_now()),
                safe_out_track_id,
            ),
        )


def save_delivery_handle(
    out_track_id: str,
    *,
    platform: str | None = None,
    connector_key: str | None = None,
    platform_message_id: str | None = None,
) -> bool:
    safe_out_track_id = str(out_track_id or "").strip()
    if not safe_out_track_id:
        return False

    with connection_scope() as conn:
        row = conn.execute(
            "SELECT * FROM card_owners WHERE out_track_id = ?",
            (safe_out_track_id,),
        ).fetchone()
        if row is None:
            return False

        extra_data = _json_object_from_storage(row["extra_data"])
        stored_platform = row["platform"]
        stored_connector_key = row["connector_key"]
        stored_platform_message_id = row["platform_message_id"]
        if platform is not None:
            stored_platform = _normalize_platform(platform)
            extra_data["platform"] = stored_platform
        if connector_key is not None:
            stored_connector_key = _normalize_connector_key(connector_key)
            extra_data["connector_key"] = stored_connector_key
        if platform_message_id is not None:
            stored_platform_message_id = _sanitize_optional_text(platform_message_id)

        conn.execute(
            """
            UPDATE card_owners
            SET platform = ?,
                connector_key = ?,
                platform_message_id = ?,
                extra_data = ?,
                updated_at = ?
            WHERE out_track_id = ?
            """,
            (
                stored_platform,
                stored_connector_key,
                stored_platform_message_id,
                _json_object_to_storage(extra_data),
                _datetime_to_storage(_utc_now()),
                safe_out_track_id,
            ),
        )
        return True


def touch(out_track_id: str) -> bool:
    safe_out_track_id = str(out_track_id or "").strip()
    if not safe_out_track_id:
        return False

    with connection_scope() as conn:
        result = conn.execute(
            "UPDATE card_owners SET updated_at = ? WHERE out_track_id = ?",
            (_datetime_to_storage(_utc_now()), safe_out_track_id),
        )
        return bool(result.rowcount or 0)


__all__ = [
    "create_context",
    "load_context",
    "save_delivery_handle",
    "save_session_patch",
    "touch",
]
