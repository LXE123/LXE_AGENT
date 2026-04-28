from __future__ import annotations

from typing import Any, Mapping

GENERAL_CARD_PARAM_KEYS = {
    "markdown_head",
    "markdown_head_display",
    "markdown",
    "markdown_display",
    "input_display",
    "button1_display",
    "button2_display",
    "button3_display",
    "button1_text",
    "button1_color",
    "button1_status",
    "button1_callback",
    "button2_text",
    "button2_color",
    "button2_status",
    "button2_callback",
    "button3_text",
    "button3_color",
    "button3_status",
    "button3_callback",
    "flowStatus",
}


def is_general_card_params(params: Mapping[str, Any] | None) -> bool:
    if not params:
        return False
    return any(key in params for key in GENERAL_CARD_PARAM_KEYS)


def build_general_card_params(
    *,
    markdown_head: str = "",
    markdown_head_display: bool | None = None,
    markdown: str = "",
    markdown_display: bool | None = None,
    input_display: bool = False,
    button1_display: bool | None = None,
    button2_display: bool | None = None,
    button3_display: bool | None = None,
    button1_text: str = "",
    button1_color: str = "blue",
    button1_status: str = "disabled",
    button1_callback: str = "callback1",
    button2_text: str = "",
    button2_color: str = "blue",
    button2_status: str = "disabled",
    button2_callback: str = "callback2",
    button3_text: str = "",
    button3_color: str = "blue",
    button3_status: str = "disabled",
    button3_callback: str = "callback3",
    flowStatus: int | str = 3,
) -> dict[str, Any]:
    markdown_head_text = str(markdown_head or "").strip()
    markdown_text = str(markdown or "").strip() or "暂无内容"

    button1_text = str(button1_text or "").strip()
    button2_text = str(button2_text or "").strip()
    button3_text = str(button3_text or "").strip()

    if markdown_head_display is None:
        markdown_head_display = bool(markdown_head_text)
    if markdown_display is None:
        markdown_display = True
    if button1_display is None:
        button1_display = bool(button1_text)
    if button2_display is None:
        button2_display = bool(button2_text)
    if button3_display is None:
        button3_display = bool(button3_text)

    return {
        "markdown_head": markdown_head_text,
        "markdown_head_display": bool(markdown_head_display),
        "markdown": markdown_text,
        "markdown_display": bool(markdown_display),
        "input_display": bool(input_display),
        "button1_display": bool(button1_display),
        "button2_display": bool(button2_display),
        "button3_display": bool(button3_display),
        "button1_text": button1_text,
        "button1_color": str(button1_color or "blue"),
        "button1_status": str(button1_status or "disabled"),
        "button1_callback": str(button1_callback or "callback1"),
        "button2_text": button2_text,
        "button2_color": str(button2_color or "blue"),
        "button2_status": str(button2_status or "disabled"),
        "button2_callback": str(button2_callback or "callback2"),
        "button3_text": button3_text,
        "button3_color": str(button3_color or "blue"),
        "button3_status": str(button3_status or "disabled"),
        "button3_callback": str(button3_callback or "callback3"),
        "flowStatus": 3 if str(flowStatus or "3").strip() else 3,
    }
