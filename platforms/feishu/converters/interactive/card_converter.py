from __future__ import annotations

from typing import Any

from ..utils import as_list, as_record, join_non_empty, safe_parse, text_value
from .card_utils import format_milliseconds_to_iso8601, normalize_time_format
from .types import ConvertCardResult, MODE, Obj, RawCardContent


class CardConverter:
    def __init__(self, mode: str = MODE.Concise) -> None:
        self._mode = mode

    def convert(self, input_card: RawCardContent) -> ConvertCardResult:
        raw_card = input_card.get("json_card") if isinstance(input_card, dict) else input_card
        card = as_record(raw_card)
        if not card and isinstance(raw_card, str):
            card = as_record(safe_parse(raw_card))
        if not card:
            card = as_record(input_card)
        if not card:
            return ConvertCardResult(content="")
        lines: list[str] = []
        self._append(lines, self._render_header(card.get("header")))
        self._append(lines, self._render_node(card.get("body")))
        self._append(lines, self._render_node(card.get("elements")))
        return ConvertCardResult(content=join_non_empty(lines))

    def _append(self, lines: list[str], value: str) -> None:
        text = str(value or "").strip()
        if not text:
            return
        for line in text.splitlines():
            normalized = line.strip()
            if not normalized:
                continue
            if lines and lines[-1] == normalized:
                continue
            lines.append(normalized)

    def _render_header(self, header: object) -> str:
        record = as_record(header)
        if not record:
            return ""
        title = self._textish(record.get("title"))
        subtitle = self._textish(record.get("subtitle"))
        return join_non_empty(
            [
                title,
                subtitle,
            ]
        )

    def _render_node(self, node: object) -> str:
        if isinstance(node, list):
            return join_non_empty([self._render_node(item) for item in node])
        record = as_record(node)
        if not record:
            return text_value(node)

        tag = str(record.get("tag") or "").strip().lower()
        prop = as_record(record.get("property"))

        if tag in {"plain_text", "text", "fallback_text"}:
            return self._textish(record)
        if tag in {"markdown", "markdown_v1"}:
            return join_non_empty([self._textish(record), self._render_node(prop.get("elements"))])
        if tag == "heading":
            heading = self._textish(record)
            return f"### {heading}" if heading else ""
        if tag == "button":
            label = self._textish(record.get("text")) or self._textish(prop.get("text")) or self._textish(record)
            return f"[button] {label}" if label else "[button]"
        if tag in {"at", "person", "person_v1"}:
            name = (
                self._textish(record.get("name"))
                or self._textish(prop.get("name"))
                or text_value(prop.get("user_id"))
            )
            return f"@{name}" if name else ""
        if tag == "at_all":
            return "@all"
        if tag == "person_list":
            return join_non_empty([self._render_node(item) for item in as_list(prop.get("persons"))], sep=", ")
        if tag in {"img", "image", "avatar"}:
            alt = self._textish(record.get("alt")) or self._textish(prop.get("alt")) or self._textish(prop.get("title"))
            return f"[image] {alt}".strip()
        if tag in {"audio", "video", "chart"}:
            label = self._textish(prop.get("title")) or self._textish(record.get("title"))
            return f"[{tag}] {label}".strip()
        if tag in {"code_block", "code_span"}:
            code = self._textish(record)
            return f"`{code}`" if tag == "code_span" and code else f"```\n{code}\n```" if code else ""
        if tag == "blockquote":
            content = self._textish(record)
            return f"> {content}" if content else ""
        if tag in {"link", "overflow"}:
            title = self._textish(record.get("text")) or self._textish(prop.get("text")) or self._textish(record.get("title"))
            url = text_value(record.get("href") or prop.get("href") or record.get("url") or prop.get("url"))
            if title and url:
                return f"[{title}]({url})"
            return title or url
        if tag in {
            "select_static",
            "multi_select_static",
            "select_person",
            "multi_select_person",
            "select_img",
            "input",
            "checker",
        }:
            label = self._textish(record.get("label")) or self._textish(prop.get("label")) or self._textish(record.get("placeholder"))
            return f"[{tag}] {label}".strip()
        if tag in {"date_picker", "picker_time", "picker_datetime", "local_datetime"}:
            formatted = (
                format_milliseconds_to_iso8601(prop.get("timestamp") or record.get("timestamp"))
                or normalize_time_format(text_value(prop.get("value") or record.get("value")))
            )
            return formatted
        if tag == "text_tag":
            text = self._textish(record)
            return f"[tag] {text}".strip()
        if tag == "number_tag":
            text = self._textish(record)
            return f"[number] {text}".strip()
        if tag in {"table", "list"}:
            return join_non_empty(
                [
                    self._textish(record.get("title")),
                    self._render_node(prop.get("rows")),
                    self._render_node(prop.get("items")),
                    self._render_node(record.get("rows")),
                    self._render_node(record.get("items")),
                ]
            )
        if tag in {"column_set", "column", "actions", "action", "note", "div", "form", "interactive_container", "collapsible_panel", "repeat", "card_header"}:
            return join_non_empty(
                [
                    self._textish(record),
                    self._render_node(record.get("text")),
                    self._render_node(record.get("elements")),
                    self._render_node(record.get("columns")),
                    self._render_node(record.get("actions")),
                    self._render_node(prop.get("elements")),
                    self._render_node(prop.get("columns")),
                    self._render_node(prop.get("actions")),
                ]
            )

        return join_non_empty(
            [
                self._textish(record),
                self._render_node(record.get("text")),
                self._render_node(record.get("title")),
                self._render_node(record.get("header")),
                self._render_node(record.get("body")),
                self._render_node(record.get("elements")),
                self._render_node(record.get("columns")),
                self._render_node(prop.get("text")),
                self._render_node(prop.get("title")),
                self._render_node(prop.get("body")),
                self._render_node(prop.get("elements")),
                self._render_node(prop.get("columns")),
                self._render_node(prop.get("items")),
                self._render_node(prop.get("fields")),
            ]
        )

    def _textish(self, node: object) -> str:
        if isinstance(node, str):
            return node.strip()
        record = as_record(node)
        if not record:
            return ""
        prop = as_record(record.get("property"))
        for candidate in (
            prop.get("content"),
            record.get("content"),
            prop.get("text"),
            record.get("text"),
            prop.get("title"),
            record.get("title"),
            prop.get("value"),
            record.get("value"),
            prop.get("label"),
            record.get("label"),
            prop.get("placeholder"),
            record.get("placeholder"),
            prop.get("name"),
            record.get("name"),
        ):
            text = text_value(candidate)
            if text:
                return text
        return ""


__all__ = ["CardConverter", "MODE"]
