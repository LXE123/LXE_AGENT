from __future__ import annotations

from typing import Any

from .content_converter_helpers import resolve_mentions
from .types import ConvertContext, ConvertResult, ResourceDescriptor
from .utils import as_list, as_record, join_non_empty, safe_parse, text_value


_LOCALE_PRIORITY = ("zh_cn", "en_us", "ja_jp")


def _unwrap_locale(parsed: dict[str, Any]) -> dict[str, Any]:
    if "title" in parsed or "content" in parsed:
        return parsed
    for locale in _LOCALE_PRIORITY:
        locale_data = parsed.get(locale)
        if isinstance(locale_data, dict):
            return locale_data
    first_value = next(iter(parsed.values()), None)
    return dict(first_value) if isinstance(first_value, dict) else {}


def _apply_style(text: str, styles: list[Any]) -> str:
    result = str(text or "")
    safe_styles = {str(style or "").strip() for style in styles}
    if "bold" in safe_styles:
        result = f"**{result}**"
    if "italic" in safe_styles:
        result = f"*{result}*"
    if "lineThrough" in safe_styles:
        result = f"~~{result}~~"
    if "codeInline" in safe_styles:
        result = f"`{result}`"
    return result


def _render_element(
    element: dict[str, Any],
    ctx: ConvertContext,
    resources: list[ResourceDescriptor],
) -> str:
    tag = str(element.get("tag") or "").strip()
    if tag == "text":
        return _apply_style(text_value(element.get("text")), as_list(element.get("style")))
    if tag == "md":
        return text_value(element.get("text"))
    if tag == "a":
        href = text_value(element.get("href"))
        text = text_value(element.get("text")) or href
        if href and text and text != href:
            return f" [{text}]({href})"
        return f" {text}" if text else ""
    if tag == "at":
        user_id = text_value(element.get("user_id"))
        if user_id == "all":
            return "@all"
        info = ctx.mentions_by_open_id.get(user_id)
        if info is not None:
            return info.key
        user_name = text_value(element.get("user_name"))
        return f"@{user_name}" if user_name else ""
    if tag == "img":
        image_key = text_value(element.get("image_key"))
        if image_key:
            resources.append(ResourceDescriptor(type="image", file_key=image_key))
            return f"![image]({image_key})" if ctx.include_resource_placeholders else ""
        return ""
    if tag == "media":
        file_key = text_value(element.get("file_key"))
        if file_key:
            file_name = (
                text_value(element.get("file_name"))
                or text_value(element.get("title"))
                or text_value(element.get("text"))
            )
            resources.append(ResourceDescriptor(type="file", file_key=file_key, file_name=file_name))
            if ctx.include_resource_placeholders:
                name_attr = f' name="{file_name}"' if file_name else ""
                return f"<file key=\"{file_key}\"{name_attr}/>"
        return ""
    if tag == "code_block":
        language = text_value(element.get("language"))
        code = text_value(element.get("text"))
        return f"\n```{language}\n{code}\n```\n".strip("\n")
    if tag == "hr":
        return "\n---\n"
    return text_value(element.get("text"))


def convert_post(raw: str, ctx: ConvertContext) -> ConvertResult:
    parsed = safe_parse(raw)
    if not isinstance(parsed, dict):
        return ConvertResult(content="[rich text message]")
    body = _unwrap_locale(parsed)
    if not body:
        return ConvertResult(content="[rich text message]")

    resources: list[ResourceDescriptor] = []
    lines: list[str] = []
    title = text_value(body.get("title"))
    if title:
        lines.extend([f"**{title}**", ""])
    for paragraph in as_list(body.get("content")):
        if not isinstance(paragraph, list):
            continue
        line = "".join(
            _render_element(as_record(element), ctx, resources)
            for element in paragraph
            if isinstance(element, dict)
        ).strip()
        if line:
            lines.append(line)
    content = resolve_mentions(join_non_empty(lines), ctx)
    if not content and resources:
        return ConvertResult(content="", resources=resources)
    content = content or "[rich text message]"
    return ConvertResult(content=content, resources=resources)


__all__ = ["convert_post"]
