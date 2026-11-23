from __future__ import annotations

from typing import Any

from services.browser.models.models import ToolCall


def _clean_text(value: Any, limit: int = 240) -> str:
    return " ".join(str(value or "").strip().split())[:limit]


_ZINIAO_BROWSER_ACTIONS = (
    "open_store",
    "get_status",
    "exit_store",
)


def _normalize_ziniao_browser_arguments(arguments: dict[str, Any]) -> dict[str, Any]:
    action = _clean_text(arguments.get("action"), 40)
    if action not in _ZINIAO_BROWSER_ACTIONS:
        raise ValueError(f"Unknown ziniao_browser action: {action or '(missing)'}")

    normalized: dict[str, Any] = {"action": action}
    if action == "open_store":
        if set(arguments) - {"action", "store_id", "store_name"}:
            raise ValueError("open_store only accepts store_id or store_name")
        selectors = [key for key in ("store_id", "store_name") if key in arguments]
        if len(selectors) != 1:
            raise ValueError("open_store requires exactly one of store_id or store_name; 请提供店铺名称")
        key = selectors[0]
        value = arguments[key]
        limit = 256 if key == "store_name" else 120
        if (
            not isinstance(value, str) or not value.strip() or len(value) > limit
            or any(ord(ch) < 32 for ch in value)
        ):
            raise ValueError(f"open_store requires a non-empty {key} of at most {limit} characters")
        normalized[key] = value.strip()
        return normalized

    if action == "exit_store":
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


def build_browser_tool_call(
    *,
    name: str,
    arguments: dict[str, Any] | None = None,
    reason: str = "",
    raw: dict[str, Any] | None = None,
) -> ToolCall:
    tool_name = _clean_text(name, 60)
    if tool_name != "ziniao_browser":
        raise ValueError(f"Unknown browser tool: {name}")

    return ToolCall(
        name=tool_name,
        arguments=_normalize_ziniao_browser_arguments(dict(arguments or {})),
        reason=_clean_text(reason, 240),
        question="",
        summary="",
        raw={"source": "services.browser.tools.schema", **dict(raw or {})},
    )


__all__ = [
    "build_browser_tool_call",
]
