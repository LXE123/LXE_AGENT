from __future__ import annotations

from typing import Any

def build_markdown_card(markdown: str, *, title: str = "") -> dict[str, Any]:
    return {
        "markdown_head": str(title or "").strip(),
        "markdown": str(markdown or "").strip() or "暂无内容",
    }
