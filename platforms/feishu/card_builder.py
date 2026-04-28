"""Translate build_general_card_params() output → Feishu Card JSON (schema 2.0).

The card_params dict from DingTalk presenters is our intermediate representation.
This module converts it to Feishu-native interactive card JSON.
"""
from __future__ import annotations

from typing import Any

# DingTalk button color → Feishu button type
_BUTTON_TYPE_MAP: dict[str, str] = {
    "blue": "primary",
    "red": "danger",
    "gray": "default",
    "grey": "default",
}


def _is_truthy(val: Any) -> bool:
    return str(val or "").strip().lower() in {"true", "1", "yes"}


def card_params_to_feishu_card(params: dict[str, Any]) -> dict[str, Any]:
    """Convert agent card_params → Feishu Card Kit schema 2.0 JSON."""
    elements: list[dict[str, Any]] = []

    # --- Header ---
    header: dict[str, Any] | None = None
    head_text = str(params.get("markdown_head") or "").strip()
    if head_text and params.get("markdown_head_display") != "false":
        header = {
            "title": {"tag": "plain_text", "content": head_text},
            "template": "blue",
        }

    # --- Body markdown ---
    md = str(params.get("markdown") or "").strip()
    if md and params.get("markdown_display") != "false":
        elements.append({
            "tag": "markdown",
            "content": md,
            "element_id": "content",
        })

    # --- Buttons ---
    buttons: list[dict[str, Any]] = []
    for i in range(1, 4):
        pfx = f"button{i}"
        if not _is_truthy(params.get(f"{pfx}_display")):
            continue
        text = str(params.get(f"{pfx}_text") or "")
        color = str(params.get(f"{pfx}_color") or "blue")
        status = str(params.get(f"{pfx}_status") or "disabled")
        callback = str(params.get(f"{pfx}_callback") or f"callback{i}")

        btn: dict[str, Any] = {
            "tag": "button",
            "text": {"tag": "plain_text", "content": text},
            "type": _BUTTON_TYPE_MAP.get(color, "default"),
            "value": {"callback": callback},
        }
        if status == "disabled":
            btn["disabled"] = True
        buttons.append(btn)

    if buttons:
        elements.append({"tag": "action", "actions": buttons})

    # --- Assemble card ---
    card: dict[str, Any] = {
        "schema": "2.0",
        "config": {"wide_screen_mode": True},
        "body": {"elements": elements or [{"tag": "markdown", "content": "⏳", "element_id": "content"}]},
    }
    if header:
        card["header"] = header

    return card
