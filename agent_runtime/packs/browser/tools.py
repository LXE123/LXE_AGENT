from __future__ import annotations

from typing import Any

from services.browser.models.models import ToolCall


def _clean_text(value: Any, limit: int = 240) -> str:
    return " ".join(str(value or "").strip().split())[:limit]


def _coerce_int(value: Any) -> int | None:
    if value in ("", None):
        return None
    try:
        return int(value)
    except Exception as exc:
        raise ValueError(f"invalid integer value: {value}") from exc


def _coerce_bool(value: Any) -> bool | None:
    if value in ("", None):
        return None
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"invalid boolean value: {value}")


_ZINIAO_BROWSER_ACTIONS = (
    "open_store",
    "get_status",
    "exit_store",
)

_ZINIAO_PAGE_ACTIONS = (
    "browser_snapshot",
    "browser_vision",
    "browser_navigate",
    "browser_click",
    "browser_type",
    "browser_scroll",
)


_BROWSER_TOOL_SCHEMAS: tuple[dict[str, Any], ...] = (
    {
        "name": "ziniao_browser",
        "description": (
            "Manage Ziniao store lifecycle. "
            "Use get_status to inspect store status and discover store_id; "
            "use open_store/exit_store to start or stop one store."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "description": "Browser action to run.",
                    "enum": list(_ZINIAO_BROWSER_ACTIONS),
                },
                "store_id": {
                    "type": "string",
                    "description": "Target store oauth. Required by open_store and exit_store.",
                },
            },
            "required": ["action"],
            "additionalProperties": False,
        },
    },
    {
        "name": "ziniao_page",
        "description": (
            "Control one Ziniao store page. "
            "Every action requires store_id. Observe with browser_snapshot/browser_vision, "
            "then interact with browser_click/browser_type/browser_navigate/browser_scroll."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "description": "Page action to run.",
                    "enum": list(_ZINIAO_PAGE_ACTIONS),
                },
                "store_id": {
                    "type": "string",
                    "description": "Target store oauth.",
                },
                "full": {
                    "type": "boolean",
                    "description": "Return a more complete page snapshot. Used by browser_snapshot.",
                },
                "url": {
                    "type": "string",
                    "description": "Absolute URL used by browser_navigate.",
                },
                "ref": {
                    "type": "string",
                    "description": "Element ref returned by browser_snapshot. Used by browser_click and browser_type.",
                },
                "text": {
                    "type": "string",
                    "description": "Text typed into the target input. Used by browser_type.",
                },
                "direction": {
                    "type": "string",
                    "description": "Scroll direction used by browser_scroll.",
                    "enum": ["up", "down"],
                },
                "pixels": {
                    "type": "integer",
                    "description": "Approximate scroll distance used by browser_scroll.",
                    "minimum": 100,
                    "maximum": 4000,
                },
            },
            "required": ["action", "store_id"],
            "additionalProperties": False,
        },
    },
)

_TOOL_SCHEMA_MAP = {
    str(item.get("name") or "").strip(): dict(item)
    for item in _BROWSER_TOOL_SCHEMAS
}


def browser_planner_tool_schemas() -> list[dict[str, Any]]:
    return [dict(schema) for schema in _BROWSER_TOOL_SCHEMAS]


def browser_tool_names() -> tuple[str, ...]:
    return tuple(_TOOL_SCHEMA_MAP.keys())


def _normalize_ziniao_browser_arguments(arguments: dict[str, Any]) -> dict[str, Any]:
    action = _clean_text(arguments.get("action"), 40)
    if action not in _ZINIAO_BROWSER_ACTIONS:
        raise ValueError(f"Unknown ziniao_browser action: {action or '(missing)'}")

    normalized: dict[str, Any] = {"action": action}
    if action in {"open_store", "exit_store"}:
        extra_keys = sorted(set(arguments) - {"action", "store_id"})
        if extra_keys:
            raise ValueError(f"{action} only accepts store_id")
        store_id = _clean_text(arguments.get("store_id"), 120)
        if not store_id:
            raise ValueError(f"{action} requires store_id")
        normalized["store_id"] = store_id
        return normalized

    extra_keys = sorted(set(arguments) - {"action"})
    if extra_keys:
        raise ValueError("get_status does not accept extra arguments")
    return normalized


def _normalize_ziniao_page_arguments(arguments: dict[str, Any]) -> dict[str, Any]:
    action = _clean_text(arguments.get("action"), 40)
    if action not in _ZINIAO_PAGE_ACTIONS:
        raise ValueError(f"Unknown ziniao_page action: {action or '(missing)'}")

    store_id = _clean_text(arguments.get("store_id"), 120)
    if not store_id:
        raise ValueError(f"{action} requires store_id")

    normalized: dict[str, Any] = {
        "action": action,
        "store_id": store_id,
    }

    if action == "browser_snapshot":
        extra_keys = sorted(set(arguments) - {"action", "store_id", "full"})
        if extra_keys:
            raise ValueError("browser_snapshot only accepts store_id and full")
        full = _coerce_bool(arguments.get("full"))
        if full is not None:
            normalized["full"] = full
        return normalized

    if action == "browser_vision":
        extra_keys = sorted(set(arguments) - {"action", "store_id"})
        if extra_keys:
            raise ValueError("browser_vision only accepts store_id")
        return normalized

    if action == "browser_navigate":
        extra_keys = sorted(set(arguments) - {"action", "store_id", "url"})
        if extra_keys:
            raise ValueError("browser_navigate only accepts store_id and url")
        url = _clean_text(arguments.get("url"), 600)
        if not url:
            raise ValueError("browser_navigate requires url")
        normalized["url"] = url
        return normalized

    if action == "browser_click":
        extra_keys = sorted(set(arguments) - {"action", "store_id", "ref"})
        if extra_keys:
            raise ValueError("browser_click only accepts store_id and ref")
        ref = _clean_text(arguments.get("ref"), 120)
        if not ref:
            raise ValueError("browser_click requires ref")
        normalized["ref"] = ref
        return normalized

    if action == "browser_type":
        extra_keys = sorted(set(arguments) - {"action", "store_id", "ref", "text"})
        if extra_keys:
            raise ValueError("browser_type only accepts store_id, ref and text")
        ref = _clean_text(arguments.get("ref"), 120)
        if not ref:
            raise ValueError("browser_type requires ref")
        if "text" not in arguments:
            raise ValueError("browser_type requires text")
        normalized["ref"] = ref
        normalized["text"] = str(arguments.get("text") or "")
        return normalized

    if action == "browser_scroll":
        extra_keys = sorted(set(arguments) - {"action", "store_id", "direction", "pixels"})
        if extra_keys:
            raise ValueError("browser_scroll only accepts store_id, direction and pixels")
        direction = _clean_text(arguments.get("direction") or "down", 20)
        if direction not in {"up", "down"}:
            raise ValueError("browser_scroll direction must be up or down")
        pixels = _coerce_int(arguments.get("pixels"))
        normalized["direction"] = direction
        normalized["pixels"] = pixels if pixels is not None else 800
        return normalized

    raise ValueError(f"Unsupported ziniao_page action: {action}")


def build_browser_tool_call(
    *,
    name: str,
    arguments: dict[str, Any] | None = None,
    reason: str = "",
    raw: dict[str, Any] | None = None,
) -> ToolCall:
    tool_name = _clean_text(name, 60)
    if tool_name not in _TOOL_SCHEMA_MAP:
        raise ValueError(f"Unknown browser tool: {name}")

    source = dict(arguments or {})
    if tool_name == "ziniao_browser":
        normalized_arguments = _normalize_ziniao_browser_arguments(source)
    elif tool_name == "ziniao_page":
        normalized_arguments = _normalize_ziniao_page_arguments(source)
    else:
        raise ValueError(f"Unknown browser tool: {name}")

    return ToolCall(
        name=tool_name,
        arguments=normalized_arguments,
        reason=_clean_text(reason, 240),
        question="",
        summary="",
        raw={"source": "agent_runtime.packs.browser.tools", **dict(raw or {})},
    )


def browser_tool_reply_kind(tool_name: str, arguments: dict[str, Any] | None = None) -> str:
    safe_name = _clean_text(tool_name, 60)
    safe_args = dict(arguments or {})
    if safe_name == "ziniao_page":
        action = _clean_text(safe_args.get("action"), 40)
        if action == "browser_snapshot":
            return "observation"
        if action == "browser_vision":
            return "content"
    return "action"


__all__ = [
    "browser_planner_tool_schemas",
    "browser_tool_names",
    "browser_tool_reply_kind",
    "build_browser_tool_call",
]
