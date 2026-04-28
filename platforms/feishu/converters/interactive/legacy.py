from __future__ import annotations

from .types import Obj


def convert_legacy_card(parsed: Obj) -> dict[str, object]:
    lines: list[str] = []

    header = parsed.get("header")
    if isinstance(header, dict):
        title = header.get("title")
        if isinstance(title, dict):
            title_content = str(title.get("content") or "").strip()
            if title_content:
                lines.append(f"**{title_content}**")

    def extract_texts(value: object) -> None:
        if isinstance(value, list):
            for item in value:
                extract_texts(item)
            return
        if not isinstance(value, dict):
            return
        tag = str(value.get("tag") or "").strip().lower()
        if tag in {"markdown", "lark_md"}:
            content = str(value.get("content") or "").strip()
            if content:
                lines.append(content)
        text = value.get("text")
        if isinstance(text, dict):
            content = str(text.get("content") or "").strip()
            if content:
                lines.append(content)
        content = str(value.get("content") or "").strip()
        if content and tag in {"plain_text", "div", "text"}:
            lines.append(content)
        extract_texts(value.get("elements"))
        extract_texts(value.get("columns"))

    extract_texts(parsed.get("elements"))
    extract_texts(parsed.get("body"))
    content = "\n".join(part for part in lines if part).strip() or "[interactive card]"
    return {"content": content, "resources": []}


__all__ = ["convert_legacy_card"]
