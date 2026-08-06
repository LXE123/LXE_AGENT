"""`lxeskill shopee keywords config` — 查看/更新默认搜索关键词。"""
from __future__ import annotations

from typing import Any

from services.agent_cli._shared.json_cli import exception_text as _exception_text
from services.agent_cli.shopee._shared import (
    keywords_state,
    save_default_keywords,
)


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    action = str(arguments.get("action") or "").strip()
    try:
        if not action:
            raise ValueError("缺少必填参数 action（get 或 set）")
        if action == "get":
            return {"success": True, **keywords_state()}
        if action == "set":
            keywords = save_default_keywords(arguments.get("keywords") or [])
            state = keywords_state()
            return {
                "success": True,
                "keywords": keywords,
                "count": len(keywords),
                "updated_at": state["updated_at"],
                "path": state["path"],
            }
        raise ValueError(f"不支持的 action：{action!r}（应为 get 或 set）")
    except Exception as exc:  # noqa: BLE001 — failure context belongs in the payload
        return {"success": False, "exception": f"{type(exc).__name__}: {_exception_text(exc)}"}
