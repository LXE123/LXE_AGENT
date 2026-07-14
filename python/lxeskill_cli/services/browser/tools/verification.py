from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from services.browser.browser.snapshot import _element_label, _safe_text, _short_url


def _snapshot_digest(page_snapshot: dict[str, Any]) -> str:
    snapshot = dict(page_snapshot or {})
    payload = {
        "url": _safe_text(snapshot.get("url"), 300),
        "title": _safe_text(snapshot.get("title"), 120),
        "viewport_y": int(snapshot.get("viewport_y") or 0),
        "headings": [_safe_text(item, 80) for item in list(snapshot.get("headings") or [])[:6]],
        "breadcrumbs": [_safe_text(item, 80) for item in list(snapshot.get("breadcrumbs") or [])[:6]],
        "text_lines": [_safe_text(item, 80) for item in list(snapshot.get("text_lines") or [])[:8]],
        "dialogs": [
            {
                "title": _safe_text(dict(item or {}).get("title"), 80),
                "text": _safe_text(dict(item or {}).get("text"), 120),
            }
            for item in list(snapshot.get("dialogs") or [])[:4]
        ],
        "interactive": [
            {
                "tag": _safe_text(dict(item or {}).get("tag"), 24),
                "label": _element_label(dict(item or {})),
                "href": _short_url(dict(item or {}).get("href")),
                "type": _safe_text(dict(item or {}).get("type"), 24),
            }
            for item in list(snapshot.get("interactive_elements") or [])[:12]
        ],
        "forms": [
            {
                "title": _safe_text(dict(item or {}).get("title"), 80),
                "field_count": int(dict(item or {}).get("field_count") or 0),
                "button_count": int(dict(item or {}).get("button_count") or 0),
            }
            for item in list(snapshot.get("forms") or [])[:4]
        ],
        "tables": [
            {
                "title": _safe_text(dict(item or {}).get("title"), 80),
                "headers": [_safe_text(header, 40) for header in list(dict(item or {}).get("headers") or [])[:4]],
                "row_count": int(dict(item or {}).get("row_count") or 0),
            }
            for item in list(snapshot.get("tables") or [])[:4]
        ],
        "top_nav": [
            {"label": _safe_text(dict(item or {}).get("label"), 40), "href": _short_url(dict(item or {}).get("href"))}
            for item in list(snapshot.get("top_nav") or [])[:8]
        ],
        "favorite_links": [
            {"label": _safe_text(dict(item or {}).get("label"), 40), "href": _short_url(dict(item or {}).get("href"))}
            for item in list(snapshot.get("favorite_links") or [])[:12]
        ],
        "side_nav": [
            {"label": _safe_text(dict(item or {}).get("label"), 40), "href": _short_url(dict(item or {}).get("href"))}
            for item in list(snapshot.get("side_nav") or [])[:8]
        ],
        "inventory_flows": [
            _safe_text(dict(item or {}).get("label") or dict(item or {}).get("text"), 40)
            for item in list(snapshot.get("inventory_flows") or [])[:8]
        ],
        "row_action_menus": [
            {
                "row_hint": _safe_text(dict(item or {}).get("row_hint"), 80),
                "actions": [
                    _safe_text(dict(action or {}).get("label") or dict(action or {}).get("text"), 32)
                    for action in list(dict(item or {}).get("actions") or [])[:4]
                ],
            }
            for item in list(snapshot.get("row_action_menus") or [])[:6]
        ],
        "upload_dialogs": [
            _safe_text(dict(item or {}).get("title") or dict(item or {}).get("text"), 80)
            for item in list(snapshot.get("upload_dialogs") or [])[:4]
        ],
        "modal_confirmations": [
            _safe_text(dict(item or {}).get("title") or dict(item or {}).get("text"), 80)
            for item in list(snapshot.get("modal_confirmations") or [])[:4]
        ],
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    return hashlib.sha1(encoded.encode("utf-8")).hexdigest()


def _success_signal_set(page_snapshot: dict[str, Any]) -> set[str]:
    snapshot = dict(page_snapshot or {})
    signals: set[str] = set()
    keywords = (
        "成功",
        "已保存",
        "已更新",
        "已上传",
        "已提交",
        "完成",
        "success",
        "saved",
        "updated",
        "uploaded",
        "submitted",
        "completed",
    )
    candidates: list[str] = []
    candidates.extend(str(item or "") for item in list(snapshot.get("text_lines") or []))
    candidates.extend(str(item or "") for item in list(snapshot.get("headings") or []))
    for dialog in list(snapshot.get("dialogs") or []):
        item = dict(dialog or {})
        candidates.append(str(item.get("title") or ""))
        candidates.append(str(item.get("text") or ""))
    for raw in candidates:
        text = _safe_text(raw, 160).lower()
        if text and any(keyword in text for keyword in keywords):
            signals.add(text)
    return signals


def matching_element_from_snapshot(page_snapshot: dict[str, Any], aid: str, before_details: dict[str, Any] | None = None) -> dict[str, Any]:
    snapshot = dict(page_snapshot or {})
    safe_aid = str(aid or "").strip()
    interactive = [dict(item or {}) for item in list(snapshot.get("interactive_elements") or [])]
    for item in interactive:
        if str(item.get("aid") or "").strip() == safe_aid:
            return item

    reference = dict(before_details or {})
    reference_keys = (
        ("data_testid", 6),
        ("id", 5),
        ("name", 4),
        ("href", 4),
        ("text", 3),
        ("placeholder", 2),
        ("tag", 1),
    )
    best_match: dict[str, Any] = {}
    best_score = 0
    for item in interactive:
        score = 0
        for key, weight in reference_keys:
            left = _safe_text(reference.get(key), 120)
            right = _safe_text(item.get(key), 120)
            if left and right and left == right:
                score += weight
        if score > best_score:
            best_score = score
            best_match = item
    return best_match if best_score >= 3 else {}


def verify_browser_action(
    *,
    before_snapshot: dict[str, Any],
    after_snapshot: dict[str, Any],
    action: dict[str, Any],
    before_details: dict[str, Any] | None = None,
    after_details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    action_name = str(action.get("action") or "").strip().lower()
    aid = str(action.get("aid") or "").strip()
    before = dict(before_snapshot or {})
    after = dict(after_snapshot or {})

    url_changed = _safe_text(before.get("url"), 300) != _safe_text(after.get("url"), 300)
    viewport_changed = int(before.get("viewport_y") or 0) != int(after.get("viewport_y") or 0)
    page_changed = _snapshot_digest(before) != _snapshot_digest(after)
    new_success_signals = sorted(_success_signal_set(after) - _success_signal_set(before))

    target_changed = False
    target_removed = False
    if aid:
        before_target = dict(before_details or {})
        after_target = dict(after_details or {})
        if not after_target:
            after_target = matching_element_from_snapshot(after, aid, before_target)
        if not after_target:
            target_removed = True
        else:
            for key in ("text", "value", "placeholder", "selected_option", "html"):
                if _safe_text(before_target.get(key), 200) != _safe_text(after_target.get(key), 200):
                    target_changed = True
                    break

    meaningful_change = page_changed or url_changed or viewport_changed or target_changed or target_removed or bool(new_success_signals)
    if action_name == "type":
        typed_text = _safe_text(action.get("text"), 200)
        final_value = _safe_text(dict(after_details or {}).get("value"), 200)
        meaningful_change = meaningful_change or bool(typed_text and final_value and typed_text in final_value)
    if action_name == "select_option":
        selected_option = _safe_text(dict(after_details or {}).get("selected_option"), 120)
        option_text = _safe_text(action.get("text"), 120)
        meaningful_change = meaningful_change or bool(option_text and selected_option and option_text in selected_option)
    if action_name == "upload_file":
        file_name = Path(str(action.get("file_path") or action.get("text") or "").strip()).name
        final_value = _safe_text(dict(after_details or {}).get("value"), 200)
        meaningful_change = meaningful_change or bool(file_name and final_value and file_name.lower() in final_value.lower())
    if action_name in {"open_launcher_page", "open_url"}:
        meaningful_change = meaningful_change or url_changed
    if action_name == "scroll":
        meaningful_change = meaningful_change or viewport_changed

    summary_parts: list[str] = []
    if url_changed:
        summary_parts.append("URL 已变化")
    if viewport_changed and action_name == "scroll":
        summary_parts.append("页面滚动位置已变化")
    if target_removed:
        summary_parts.append("目标元素已消失")
    elif target_changed:
        summary_parts.append("目标元素状态已变化")
    if new_success_signals:
        summary_parts.append(f"检测到提示: {new_success_signals[0][:40]}")
    if page_changed and not url_changed and action_name not in {"scroll", "wait"}:
        summary_parts.append("页面内容已更新")
    if not summary_parts:
        summary_parts.append("未观察到明显页面变化" if not meaningful_change else "已观察到页面变化")

    return {
        "action": action_name,
        "meaningful_change": bool(meaningful_change),
        "url_changed": bool(url_changed),
        "viewport_changed": bool(viewport_changed),
        "target_changed": bool(target_changed),
        "target_removed": bool(target_removed),
        "page_changed": bool(page_changed),
        "success_signals": new_success_signals[:3],
        "summary": "；".join(summary_parts),
    }


__all__ = ["matching_element_from_snapshot", "verify_browser_action"]
