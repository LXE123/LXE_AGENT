from __future__ import annotations

import json
from datetime import datetime, timezone
from sqlite3 import Row
from typing import Any, Optional

from shared.db.shared_state_dto import ResponseRouteContext
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
        raise RuntimeError("invalid response_routes.extra_data JSON") from exc
    if not isinstance(parsed, dict):
        raise RuntimeError("response_routes.extra_data must be a JSON object")
    return parsed


def _normalize_platform(value: Any) -> str:
    return str(value or "").strip() or "feishu"


def _to_context(row: Row) -> ResponseRouteContext:
    return ResponseRouteContext(
        response_route_id=str(row["response_route_id"]),
        owner_user_id=str(row["owner_user_id"]),
        platform=_normalize_platform(row["platform"]),
        platform_message_id=str(row["platform_message_id"] or "").strip() or None,
        conversation_id=row["conversation_id"],
        conversation_type=row["conversation_type"],
        sender_nick=row["sender_nick"],
        extra_data=_json_object_from_storage(row["extra_data"]),
        created_at=_datetime_from_storage(row["created_at"]),
        updated_at=_datetime_from_storage(row["updated_at"]),
    )


def create_context(ctx: Any) -> None:
    response_route_id = str(getattr(ctx, "response_route_id", "") or "").strip()
    if not response_route_id or not getattr(ctx, "user_id", None):
        return

    now = _datetime_to_storage(_utc_now())
    raw_data = dict(getattr(ctx, "raw_data", {}) or {})
    platform = _normalize_platform(getattr(ctx, "platform", None) or raw_data.get("platform"))
    extra_data = {
        "platform": platform,
        "source_message_id": str(
            getattr(ctx, "message_id", "") or raw_data.get("message_id") or ""
        ).strip(),
    }

    with connection_scope() as conn:
        conn.execute(
            """
            INSERT INTO response_routes (
                response_route_id,
                owner_user_id,
                platform,
                platform_message_id,
                conversation_id,
                conversation_type,
                sender_nick,
                extra_data,
                created_at,
                updated_at
            )
            VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(response_route_id) DO UPDATE SET
                owner_user_id = excluded.owner_user_id,
                platform = excluded.platform,
                conversation_id = excluded.conversation_id,
                conversation_type = excluded.conversation_type,
                sender_nick = excluded.sender_nick,
                extra_data = excluded.extra_data,
                updated_at = excluded.updated_at
            """,
            (
                response_route_id,
                str(ctx.user_id),
                platform,
                getattr(ctx, "conversation_id", None),
                "2" if bool(getattr(ctx, "is_group", False)) else "1",
                getattr(ctx, "sender_nick", None),
                _json_object_to_storage(extra_data),
                now,
                now,
            ),
        )


def load_context(response_route_id: str) -> Optional[ResponseRouteContext]:
    safe_response_route_id = str(response_route_id or "").strip()
    if not safe_response_route_id:
        return None

    with connection_scope() as conn:
        row = conn.execute(
            "SELECT * FROM response_routes WHERE response_route_id = ?",
            (safe_response_route_id,),
        ).fetchone()
        return _to_context(row) if row is not None else None


def save_session_patch(response_route_id: str, patch: dict[str, Any]) -> None:
    safe_response_route_id = str(response_route_id or "").strip()
    if not safe_response_route_id or not patch:
        return

    with connection_scope() as conn:
        row = conn.execute(
            "SELECT * FROM response_routes WHERE response_route_id = ?",
            (safe_response_route_id,),
        ).fetchone()
        if row is None:
            logger.warning("[ResponseRouteState] response route missing, skip patch: %s", safe_response_route_id)
            return

        current_data = _json_object_from_storage(row["extra_data"])
        current_data.update(dict(_sanitize_json_for_storage(patch) or {}))
        platform = row["platform"]
        platform_message_id = row["platform_message_id"]
        if "platform" in patch:
            platform = _normalize_platform(patch.get("platform"))
        if "platform_message_id" in patch:
            platform_message_id = _sanitize_optional_text(patch.get("platform_message_id"))
        conn.execute(
            """
            UPDATE response_routes
            SET platform = ?,
                platform_message_id = ?,
                extra_data = ?,
                updated_at = ?
            WHERE response_route_id = ?
            """,
            (
                platform,
                platform_message_id,
                _json_object_to_storage(current_data),
                _datetime_to_storage(_utc_now()),
                safe_response_route_id,
            ),
        )


def save_delivery_handle(
    response_route_id: str,
    *,
    platform: str | None = None,
    platform_message_id: str | None = None,
) -> bool:
    safe_response_route_id = str(response_route_id or "").strip()
    if not safe_response_route_id:
        return False

    with connection_scope() as conn:
        row = conn.execute(
            "SELECT * FROM response_routes WHERE response_route_id = ?",
            (safe_response_route_id,),
        ).fetchone()
        if row is None:
            return False

        extra_data = _json_object_from_storage(row["extra_data"])
        stored_platform = row["platform"]
        stored_platform_message_id = row["platform_message_id"]
        if platform is not None:
            stored_platform = _normalize_platform(platform)
            extra_data["platform"] = stored_platform
        if platform_message_id is not None:
            stored_platform_message_id = _sanitize_optional_text(platform_message_id)

        conn.execute(
            """
            UPDATE response_routes
            SET platform = ?,
                platform_message_id = ?,
                extra_data = ?,
                updated_at = ?
            WHERE response_route_id = ?
            """,
            (
                stored_platform,
                stored_platform_message_id,
                _json_object_to_storage(extra_data),
                _datetime_to_storage(_utc_now()),
                safe_response_route_id,
            ),
        )
        return True


def touch(response_route_id: str) -> bool:
    safe_response_route_id = str(response_route_id or "").strip()
    if not safe_response_route_id:
        return False

    with connection_scope() as conn:
        result = conn.execute(
            "UPDATE response_routes SET updated_at = ? WHERE response_route_id = ?",
            (_datetime_to_storage(_utc_now()), safe_response_route_id),
        )
        return bool(result.rowcount or 0)


__all__ = [
    "create_context",
    "load_context",
    "save_delivery_handle",
    "save_session_patch",
    "touch",
]
