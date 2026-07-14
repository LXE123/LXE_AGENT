from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any

from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.by import By
from selenium.webdriver.remote.webdriver import WebDriver
from selenium.webdriver.support.ui import Select

from services.browser.browser.seller_central_adapters import (
    resolve_inventory_search_aid,
    resolve_modal_confirmation_aid,
    resolve_row_action_aid,
    resolve_sendtoamazon_aid,
    resolve_upload_aid as resolve_seller_upload_aid,
)
from services.browser.browser.shadow_dom import SHADOW_DOM_HELPERS_JS
from services.browser.browser.snapshot import (
    build_page_snapshot,
    format_dom_snapshot,
    format_element_details,
    get_element_details,
)
from services.browser.tools.verification import matching_element_from_snapshot, verify_browser_action


_CLICK_MATCH_THRESHOLD = 2200
_MAX_DOM_SCRIPT_CHARS = 2000
_DOWNLOAD_INCOMPLETE_SUFFIXES = (".crdownload", ".tmp", ".part", ".partial")
_GENERIC_TARGET_WORDS = {
    "点击",
    "点开",
    "点一下",
    "进入",
    "打开",
    "查看",
    "看看",
    "管理",
    "页面",
    "按钮",
    "链接",
    "一下",
    "下",
}

_DOM_SCRIPT_BLOCK_RULES: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\basync\b", re.IGNORECASE), "async is not allowed"),
    (re.compile(r"\bPromise\b", re.IGNORECASE), "Promise is not allowed"),
    (re.compile(r"\bsetTimeout\s*\(", re.IGNORECASE), "setTimeout is not allowed"),
    (re.compile(r"\bsetInterval\s*\(", re.IGNORECASE), "setInterval is not allowed"),
    (re.compile(r"\bfetch\s*\(", re.IGNORECASE), "network requests are not allowed"),
    (re.compile(r"\bXMLHttpRequest\b", re.IGNORECASE), "XMLHttpRequest is not allowed"),
    (re.compile(r"\bWebSocket\b", re.IGNORECASE), "WebSocket is not allowed"),
    (re.compile(r"navigator\s*\.\s*sendBeacon\b", re.IGNORECASE), "sendBeacon is not allowed"),
    (re.compile(r"document\s*\.\s*cookie\b", re.IGNORECASE), "cookie access is not allowed"),
    (re.compile(r"\blocalStorage\b", re.IGNORECASE), "localStorage is not allowed"),
    (re.compile(r"\bsessionStorage\b", re.IGNORECASE), "sessionStorage is not allowed"),
    (re.compile(r"\bindexedDB\b", re.IGNORECASE), "indexedDB is not allowed"),
    (re.compile(r"navigator\s*\.\s*clipboard\b", re.IGNORECASE), "clipboard access is not allowed"),
    (re.compile(r"window\s*\.\s*open\s*\(", re.IGNORECASE), "window.open is not allowed"),
    (re.compile(r"(^|[^\\w$])location\s*=", re.IGNORECASE), "location assignment is not allowed"),
    (re.compile(r"location\s*\.\s*href\b", re.IGNORECASE), "location.href is not allowed"),
    (re.compile(r"history\s*\.\s*back\s*\(", re.IGNORECASE), "history.back is not allowed"),
    (re.compile(r"history\s*\.\s*forward\s*\(", re.IGNORECASE), "history.forward is not allowed"),
    (re.compile(r"\beval\s*\(", re.IGNORECASE), "eval is not allowed"),
    (re.compile(r"(^|[^\\w$])Function\s*\("), "Function constructor is not allowed"),
    (re.compile(r"new\s+Function\s*\(", re.IGNORECASE), "Function constructor is not allowed"),
    (re.compile(r"(^|[^\\w$])postMessage\s*\(", re.IGNORECASE), "postMessage is not allowed"),
    (re.compile(r"\.\s*postMessage\s*\(", re.IGNORECASE), "postMessage is not allowed"),
    (re.compile(r"document\s*\.\s*write\s*\(", re.IGNORECASE), "document.write is not allowed"),
)


def _normalized_text(value: Any) -> str:
    return "".join(str(value or "").lower().split())


def _matching_score(target: str, candidate: str) -> int:
    normalized_target = _normalized_text(target)
    normalized_candidate = _normalized_text(candidate)
    if not normalized_target or not normalized_candidate:
        return 0
    if normalized_candidate == normalized_target:
        return 5000
    if normalized_target in normalized_candidate:
        return 3600 - max(0, len(normalized_candidate) - len(normalized_target)) * 80
    if normalized_candidate in normalized_target:
        if normalized_candidate in _GENERIC_TARGET_WORDS or len(normalized_candidate) < 2:
            return 0
        gap = max(0, len(normalized_target) - len(normalized_candidate))
        if gap > 12:
            return 0
        return 3000 - gap * 120
    return 0


def _matching_text(target: str, *candidates: str) -> bool:
    return max((_matching_score(target, candidate) for candidate in candidates), default=0) >= _CLICK_MATCH_THRESHOLD


def _clicked_element_payload(*candidates: dict[str, Any] | None) -> dict[str, Any]:
    for candidate in candidates:
        item = dict(candidate or {})
        aid = str(item.get("aid") or "").strip()
        tag = str(item.get("tag") or "").strip().lower()
        text = " ".join(
            str(item.get("text") or item.get("label") or item.get("aria_label") or item.get("title") or "").strip().split()
        )[:240]
        if aid or tag or text:
            return {
                "aid": aid,
                "tag": tag,
                "text": text,
            }
    return {}


def _click_summary(clicked_element: dict[str, Any], fallback_summary: str) -> str:
    item = dict(clicked_element or {})
    aid = str(item.get("aid") or "").strip()
    tag = str(item.get("tag") or "").strip()
    text = str(item.get("text") or "").strip()
    parts = []
    if aid:
        parts.append(f"[{aid}]")
    if tag:
        parts.append(tag)
    if text:
        parts.append(text)
    if parts:
        return f"已点击元素 {' | '.join(parts)}"
    return str(fallback_summary or "").strip() or "已点击元素"


def _resolve_aid_from_list(items: list[dict[str, Any]], target_text: str, *, extra_keys: tuple[str, ...] = ()) -> str:
    safe_target = str(target_text or "").strip()
    if not safe_target:
        return ""
    for item in items:
        entry = dict(item or {})
        values = [entry.get("label"), entry.get("text"), entry.get("href"), entry.get("table_title"), entry.get("row_hint")]
        values.extend(entry.get(key) for key in extra_keys)
        if _matching_text(safe_target, *(str(value or "") for value in values)):
            aid = str(entry.get("aid") or "").strip()
            if aid:
                return aid
    return ""


def _action_target_hints(action: dict[str, Any]) -> list[str]:
    action_name = str(action.get("action") or "").strip().lower()
    hints: list[str] = []
    for value in [action.get("text"), action.get("target")]:
        text = str(value or "").strip()
        if not text:
            continue
        text = " ".join(text.split())
        if len(text) > 40 and action_name in {"click", "hover", "scroll", "get_element_details"}:
            continue
        if text and text not in hints:
            hints.append(text)
    return hints


def _resolve_click_aid_by_live_dom(driver: WebDriver, target_text: str) -> str:
    safe_target = str(target_text or "").strip()
    if not safe_target:
        return ""
    return str(
        driver.execute_script(
            SHADOW_DOM_HELPERS_JS + """
const target = String(arguments[0] || '').trim();
if (!target) return '';

function normalize(value) {
  return String(value || '').toLowerCase().replace(/\\s+/g, '');
}

function isVisible(el) {
  if (!el || !(el instanceof Element)) return false;
  const style = window.getComputedStyle(el);
  if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function labelOf(el) {
  return [
    el.innerText || el.textContent || '',
    el.getAttribute('aria-label') || '',
    el.getAttribute('title') || '',
    el.getAttribute('data-page-id') || '',
    el.getAttribute('data-testid') || '',
    el.getAttribute('name') || '',
    el.getAttribute('id') || '',
    el.getAttribute('value') || '',
    el.getAttribute('href') || '',
  ].join(' ');
}

function ensureAid(el) {
  const existing = el.getAttribute('data-aid') || '';
  if (existing) return existing;
  const counter = Number(window.__amazonAgentLiveAidCounter || 1000000);
  const nextValue = counter + 1;
  window.__amazonAgentLiveAidCounter = nextValue;
  const aid = `aid-live-${nextValue}`;
  el.setAttribute('data-aid', aid);
  return aid;
}

function isNativeInteractive(el) {
  const tag = String((el && el.tagName) || '').toLowerCase();
  return ['a', 'button', 'input', 'select', 'textarea'].includes(tag);
}

function isCustomHost(el) {
  return String((el && el.tagName) || '').includes('-');
}

const normalizedTarget = normalize(target);
const candidates = [];
for (const el of deepQuerySelectorAll('a, button, input[type="button"], input[type="submit"], [role="button"], [role="link"], [data-page-id]')) {
  if (!isVisible(el)) continue;
  const label = labelOf(el);
  const normalizedLabel = normalize(label);
  if (!normalizedLabel) continue;
  let score = 0;
  if (normalizedLabel === normalizedTarget) {
    score = 4000;
  } else if (normalizedLabel.includes(normalizedTarget)) {
    score = 3000 - Math.max(0, normalizedLabel.length - normalizedTarget.length);
  } else if (normalizedTarget.includes(normalizedLabel)) {
    score = 2000 - Math.max(0, normalizedTarget.length - normalizedLabel.length);
  } else {
    continue;
  }
  if (isNativeInteractive(el)) score += 200;
  if (isCustomHost(el)) score -= 120;
  if ((el.tagName || '').toLowerCase() === 'a') score += 50;
  if (String(el.getAttribute('href') || '').includes('/myinventory/')) score += 100;
  if (String(el.getAttribute('data-page-id') || '').toLowerCase().includes('inventory')) score += 100;
candidates.push({ score, aid: ensureAid(el) });
}
candidates.sort((left, right) => right.score - left.score);
if (!candidates.length || Number(candidates[0].score || 0) < 3200) return '';
return String(candidates[0].aid || '');
""",
            safe_target,
        )
        or ""
    ).strip()


def _resolve_click_aid_by_point(driver: WebDriver, x: int, y: int) -> str:
    return str(
        driver.execute_script(
            """
const x = Number(arguments[0] || 0);
const y = Number(arguments[1] || 0);

function isVisible(el) {
  if (!el || !(el instanceof Element)) return false;
  const style = window.getComputedStyle(el);
  if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function ensureAid(el) {
  const existing = el.getAttribute('data-aid') || '';
  if (existing) return existing;
  const counter = Number(window.__amazonAgentLiveAidCounter || 1000000);
  const nextValue = counter + 1;
  window.__amazonAgentLiveAidCounter = nextValue;
  const aid = `aid-live-${nextValue}`;
  el.setAttribute('data-aid', aid);
  return aid;
}

const raw = document.elementFromPoint(x, y);
if (!raw) return '';
const clickable = raw.closest('a, button, input[type="button"], input[type="submit"], [role="button"], [role="link"]');
const target = clickable || raw;
if (!isVisible(target)) return '';
return ensureAid(target);
""",
            int(x or 0),
            int(y or 0),
        )
        or ""
    ).strip()


def _resolve_click_aid(
    driver: WebDriver,
    page_snapshot: dict[str, Any],
    action: dict[str, Any],
    *,
    output_dir: Path,
) -> str:
    snapshot = dict(page_snapshot or {})
    x = action.get("x")
    y = action.get("y")
    if x not in ("", None) and y not in ("", None):
        aid = _resolve_click_aid_by_point(driver, int(x or 0), int(y or 0))
        if aid:
            return aid
    for action_text in _action_target_hints(action):
        aid = resolve_sendtoamazon_aid(snapshot, action_text, action_name=str(action.get("action") or ""))
        if aid:
            return aid
        for resolver in (
            resolve_modal_confirmation_aid,
            resolve_row_action_aid,
            resolve_inventory_search_aid,
            resolve_seller_upload_aid,
        ):
            aid = resolver(snapshot, action_text)
            if aid:
                return aid
        for dialog in list(snapshot.get("dialogs") or []):
            aid = _resolve_aid_from_list(list(dict(dialog or {}).get("actions") or []), action_text)
            if aid:
                return aid
        for key in ("favorite_links", "top_nav", "side_nav", "table_actions", "upload_controls", "interactive_elements"):
            aid = _resolve_aid_from_list(list(snapshot.get(key) or []), action_text)
            if aid:
                return aid
        aid = _resolve_click_aid_by_live_dom(driver, action_text)
        if aid:
            return aid
    return ""


def _resolve_type_aid(page_snapshot: dict[str, Any], action: dict[str, Any]) -> str:
    snapshot = dict(page_snapshot or {})
    for target in _action_target_hints(action):
        aid = resolve_inventory_search_aid(snapshot, target)
        if aid:
            return aid
        aid = _resolve_aid_from_list(list(snapshot.get("search_controls") or []), target, extra_keys=("value",))
        if aid:
            return aid
    for item in list(snapshot.get("interactive_elements") or []):
        entry = dict(item or {})
        if str(entry.get("tag") or "").strip().lower() in {"input", "textarea"}:
            return str(entry.get("aid") or "").strip()
    return ""


def _resolve_select_aid(page_snapshot: dict[str, Any], action: dict[str, Any]) -> str:
    snapshot = dict(page_snapshot or {})
    for target in _action_target_hints(action):
        aid = resolve_inventory_search_aid(snapshot, target)
        if aid:
            return aid
        aid = _resolve_aid_from_list(list(snapshot.get("search_controls") or []), target)
        if aid:
            return aid
    for item in list(snapshot.get("interactive_elements") or []):
        entry = dict(item or {})
        if str(entry.get("tag") or "").strip().lower() == "select":
            return str(entry.get("aid") or "").strip()
    return ""


def _resolve_upload_aid(page_snapshot: dict[str, Any], action: dict[str, Any]) -> str:
    snapshot = dict(page_snapshot or {})
    for target in _action_target_hints(action) + [str(action.get("file_path") or "").strip()]:
        safe_target = str(target or "").strip()
        if not safe_target:
            continue
        aid = resolve_sendtoamazon_aid(snapshot, safe_target, action_name="upload_file")
        if aid:
            return aid
        aid = resolve_seller_upload_aid(snapshot, safe_target)
        if aid:
            return aid
        aid = _resolve_aid_from_list(list(snapshot.get("upload_controls") or []), safe_target)
        if aid:
            return aid
    for item in list(snapshot.get("upload_controls") or []):
        entry = dict(item or {})
        if str(entry.get("type") or "").strip().lower() == "file":
            return str(entry.get("aid") or "").strip()
    return ""


def _find_by_aid(driver: WebDriver, aid: str):
    safe_aid = str(aid or "").strip()
    if not safe_aid:
        raise RuntimeError("missing aid")
    try:
        return driver.find_element(By.CSS_SELECTOR, f'[data-aid="{safe_aid}"]')
    except Exception:
        pass
    element = driver.execute_script(
        SHADOW_DOM_HELPERS_JS + """
return deepQuerySelector('[data-aid="' + arguments[0] + '"]');
""",
        safe_aid,
    )
    if element is None:
        raise RuntimeError(f'element not found: [data-aid="{safe_aid}"]')
    return element


def _click_resolved_element(driver: WebDriver, aid: str):
    element = _find_by_aid(driver, aid)
    driver.execute_script("arguments[0].scrollIntoView({block:'center'});", element)
    try:
        element.click()
    except Exception:
        driver.execute_script("arguments[0].click();", element)
    return element


def save_screenshot(driver: WebDriver, output_dir: Path, *, prefix: str = "page") -> str:
    output_dir.mkdir(parents=True, exist_ok=True)
    file_path = output_dir / f"{prefix}-{int(time.time())}.png"
    driver.save_screenshot(str(file_path))
    return str(file_path)


def _download_dir_from_path(download_path: str) -> Path:
    raw_path = str(download_path or "").strip()
    if not raw_path:
        raise RuntimeError("download_path not configured")
    download_dir = Path(raw_path).expanduser()
    download_dir.mkdir(parents=True, exist_ok=True)
    if not download_dir.is_dir():
        raise RuntimeError(f"download_path is not a directory: {download_dir}")
    return download_dir


def _snapshot_download_dir(download_dir: Path) -> dict[str, tuple[int, int]]:
    snapshots: dict[str, tuple[int, int]] = {}
    try:
        entries = list(download_dir.iterdir())
    except OSError:
        return snapshots
    for entry in entries:
        if not entry.is_file():
            continue
        try:
            stat = entry.stat()
        except OSError:
            continue
        snapshots[entry.name] = (int(stat.st_mtime_ns), int(stat.st_size))
    return snapshots


def _is_incomplete_download(name: str) -> bool:
    lowered = str(name or "").strip().lower()
    return any(lowered.endswith(suffix) for suffix in _DOWNLOAD_INCOMPLETE_SUFFIXES)


def _wait_for_downloaded_file(
    download_dir: Path,
    *,
    before_files: dict[str, tuple[int, int]],
    timeout_seconds: int,
) -> Path | None:
    deadline = time.time() + max(1, int(timeout_seconds or 0))
    last_signature: tuple[str, int, int] | None = None
    stable_hits = 0

    while time.time() < deadline:
        current_files = _snapshot_download_dir(download_dir)
        candidates: list[tuple[int, str]] = []
        for name, metadata in current_files.items():
            if _is_incomplete_download(name):
                continue
            if before_files.get(name) != metadata:
                candidates.append((int(metadata[0]), name))
        if candidates:
            _, candidate_name = max(candidates, key=lambda item: item[0])
            candidate_path = download_dir / candidate_name
            try:
                stat = candidate_path.stat()
            except OSError:
                time.sleep(0.5)
                continue
            signature = (candidate_name, int(stat.st_size), int(stat.st_mtime_ns))
            if signature == last_signature:
                stable_hits += 1
            else:
                last_signature = signature
                stable_hits = 1
            if stable_hits >= 2:
                return candidate_path
        time.sleep(0.5)
    return None


def _validate_dom_script(script_body: str) -> str:
    safe_script = str(script_body or "").strip()
    if not safe_script:
        raise RuntimeError("run_dom_script requires script")
    if len(safe_script) > _MAX_DOM_SCRIPT_CHARS:
        raise RuntimeError(f"run_dom_script exceeds {_MAX_DOM_SCRIPT_CHARS} characters")
    for pattern, reason in _DOM_SCRIPT_BLOCK_RULES:
        if pattern.search(safe_script):
            raise RuntimeError(f"Blocked DOM script pattern: {reason}")
    return safe_script


def _preview_dom_script_data(value: Any, *, limit: int = 240) -> str:
    try:
        text = json.dumps(value, ensure_ascii=False)
    except Exception:
        text = str(value or "")
    safe_text = " ".join(text.split())
    if len(safe_text) <= limit:
        return safe_text
    return safe_text[: max(0, limit - 3)] + "..."


def _execute_dom_script(driver: WebDriver, script_body: str) -> dict[str, Any]:
    wrapper = (
        """
function __normalizeDomScriptValue(value, depth) {
  if (depth > 4) return null;
  if (value === undefined || value === null) return null;
  const kind = typeof value;
  if (kind === 'string' || kind === 'number' || kind === 'boolean') return value;
  if (kind === 'bigint') return String(value);
  if (kind === 'function' || kind === 'symbol') {
    throw new Error('Return value must be JSON-like data only.');
  }
  if (typeof Element !== 'undefined' && value instanceof Element) {
    throw new Error('Return value cannot include DOM elements.');
  }
  if (typeof Node !== 'undefined' && value instanceof Node) {
    throw new Error('Return value cannot include DOM nodes.');
  }
  if (value === window || value === document) {
    throw new Error('Return value cannot include window or document.');
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => __normalizeDomScriptValue(item, depth + 1));
  }
  if (kind === 'object') {
    const out = {};
    for (const key of Object.keys(value).slice(0, 50)) {
      out[String(key)] = __normalizeDomScriptValue(value[key], depth + 1);
    }
    return out;
  }
  return String(value);
}

try {
  const __result = (() => {
"""
        + script_body
        + """
  })();
  return { ok: true, data: __normalizeDomScriptValue(__result, 0) };
} catch (error) {
  return {
    ok: false,
    error: String(error && error.message ? error.message : error || 'DOM script failed'),
  };
}
"""
    )
    result = driver.execute_script(wrapper)
    return dict(result or {})


def execute_browser_action(
    driver: WebDriver,
    action: dict[str, Any],
    *,
    download_path: str = "",
    output_dir: Path,
    before_snapshot: dict[str, Any] | None = None,
) -> dict[str, Any]:
    action_name = str(action.get("action") or "").strip().lower()
    snapshot_before = dict(before_snapshot or build_page_snapshot(driver))
    resolved_action = dict(action or {})

    if action_name in {"click", "download_file", "hover", "scroll", "get_element_details"} and not str(resolved_action.get("aid") or "").strip():
        resolved_action["aid"] = _resolve_click_aid(
            driver,
            snapshot_before,
            resolved_action,
            output_dir=output_dir,
        )
    if action_name == "type" and not str(resolved_action.get("aid") or "").strip():
        resolved_action["aid"] = _resolve_type_aid(snapshot_before, resolved_action)
    if action_name == "select_option" and not str(resolved_action.get("aid") or "").strip():
        resolved_action["aid"] = _resolve_select_aid(snapshot_before, resolved_action)
    if action_name == "upload_file" and not str(resolved_action.get("aid") or "").strip():
        resolved_action["aid"] = _resolve_upload_aid(snapshot_before, resolved_action)

    before_details: dict[str, Any] = {}
    if str(resolved_action.get("aid") or "").strip():
        try:
            before_details = get_element_details(driver, str(resolved_action.get("aid") or ""))
        except Exception:
            before_details = {}

    summary = ""
    clicked_element: dict[str, Any] = {}
    click_info: dict[str, Any] = {}
    download_file_name = ""
    download_file_path = ""
    download_confirmed = False
    if action_name == "open_url":
        url = str(resolved_action.get("url") or "").strip()
        if not url:
            raise RuntimeError("open_url requires url")
        driver.get(url)
        summary = f"已打开页面: {url}"
    elif action_name == "click":
        aid = str(resolved_action.get("aid") or "").strip()
        x = resolved_action.get("x")
        y = resolved_action.get("y")
        if aid:
            _click_resolved_element(driver, aid)
            summary = f"已点击元素 {aid}"
        elif x not in ("", None) and y not in ("", None):
            click_info = dict(
                driver.execute_script(
                    """
const x = Number(arguments[0] || 0);
const y = Number(arguments[1] || 0);

function isVisible(el) {
  if (!el || !(el instanceof Element)) return false;
  const style = window.getComputedStyle(el);
  if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function ensureAid(el) {
  const existing = el.getAttribute('data-aid') || '';
  if (existing) return existing;
  const counter = Number(window.__amazonAgentLiveAidCounter || 1000000);
  const nextValue = counter + 1;
  window.__amazonAgentLiveAidCounter = nextValue;
  const aid = `aid-live-${nextValue}`;
  el.setAttribute('data-aid', aid);
  return aid;
}

function labelOf(el) {
  return [
    el.innerText || el.textContent || '',
    el.getAttribute('aria-label') || '',
    el.getAttribute('title') || '',
    el.getAttribute('data-page-id') || '',
    el.getAttribute('data-testid') || '',
  ].join(' ').trim();
}

const raw = document.elementFromPoint(x, y);
if (!raw) return {};
const clickable = raw.closest('a, button, input[type="button"], input[type="submit"], [role="button"], [role="link"]');
const target = clickable || raw;
if (!isVisible(target)) return {};
target.scrollIntoView({block:'center'});
try {
  target.click();
} catch (error) {
  const evt = new MouseEvent('click', {bubbles: true, cancelable: true, clientX: x, clientY: y});
  target.dispatchEvent(evt);
}
return {
  aid: ensureAid(target),
  tag: String(target.tagName || '').toLowerCase(),
  text: labelOf(target),
  label: labelOf(target),
  x,
  y,
};
""",
                    int(x or 0),
                    int(y or 0),
                )
                or {}
            )
            resolved_action["aid"] = str(click_info.get("aid") or "").strip()
            summary = f"已点击坐标 ({int(x or 0)}, {int(y or 0)})"
        else:
            raise RuntimeError("missing aid")
    elif action_name == "download_file":
        aid = str(resolved_action.get("aid") or "").strip()
        if not aid:
            raise RuntimeError("download_file requires aid or target")
        timeout_seconds = max(3, min(120, int(resolved_action.get("timeout_seconds") or 15)))
        download_dir = _download_dir_from_path(download_path)
        before_files = _snapshot_download_dir(download_dir)
        _click_resolved_element(driver, aid)
        downloaded_file = _wait_for_downloaded_file(
            download_dir,
            before_files=before_files,
            timeout_seconds=timeout_seconds,
        )
        if downloaded_file is not None:
            download_file_name = downloaded_file.name
            download_file_path = str(downloaded_file)
            download_confirmed = True
            summary = f"已下载文件: {download_file_name}\n本地路径: {download_file_path}"
        else:
            summary = f"已触发下载，但未在 {timeout_seconds} 秒内确认文件落盘。"
    elif action_name == "type":
        element = _find_by_aid(driver, str(resolved_action.get("aid") or ""))
        text = str(resolved_action.get("text") or "")
        driver.execute_script("arguments[0].scrollIntoView({block:'center'});", element)
        try:
            element.clear()
        except Exception:
            pass
        element.send_keys(text)
        summary = f"已输入内容到元素 {resolved_action.get('aid')}"
    elif action_name == "hover":
        element = _find_by_aid(driver, str(resolved_action.get("aid") or ""))
        driver.execute_script("arguments[0].scrollIntoView({block:'center'});", element)
        ActionChains(driver).move_to_element(element).perform()
        summary = f"已悬停元素 {resolved_action.get('aid')}"
    elif action_name == "scroll":
        aid = str(resolved_action.get("aid") or "").strip()
        if aid:
            element = _find_by_aid(driver, aid)
            driver.execute_script("arguments[0].scrollIntoView({block:'center'});", element)
            summary = f"已滚动到元素 {aid}"
        else:
            direction = str(resolved_action.get("direction") or "down").strip().lower()
            pixels = max(200, min(3000, int(resolved_action.get("pixels") or 800)))
            offset = pixels if direction != "up" else -pixels
            driver.execute_script("window.scrollBy(0, arguments[0]);", offset)
            summary = f"已向{'上' if offset < 0 else '下'}滚动 {abs(offset)} 像素"
    elif action_name == "select_option":
        element = _find_by_aid(driver, str(resolved_action.get("aid") or ""))
        option_text = str(resolved_action.get("text") or "").strip()
        if not option_text:
            raise RuntimeError("select_option requires text")
        if str(element.tag_name or "").strip().lower() != "select":
            raise RuntimeError("select_option requires a native select element")
        selector = Select(element)
        try:
            selector.select_by_visible_text(option_text)
        except Exception:
            matched = None
            for option in list(selector.options or []):
                visible_text = " ".join(str(option.text or "").split()).strip()
                if option_text == visible_text or option_text in visible_text:
                    matched = visible_text
                    option.click()
                    break
            if not matched:
                raise RuntimeError(f"未找到下拉选项: {option_text}")
        summary = f"已选择下拉选项: {option_text}"
    elif action_name == "upload_file":
        element = _find_by_aid(driver, str(resolved_action.get("aid") or ""))
        file_path = str(resolved_action.get("file_path") or resolved_action.get("text") or "").strip()
        if not file_path:
            raise RuntimeError("upload_file requires file_path")
        element_type = str(element.get_attribute("type") or "").strip().lower()
        if str(element.tag_name or "").strip().lower() != "input" or element_type != "file":
            raise RuntimeError("upload_file requires input[type=file]")
        element.send_keys(file_path)
        summary = f"已上传文件: {Path(file_path).name}"
    elif action_name == "get_element_details":
        details = get_element_details(driver, str(resolved_action.get("aid") or ""))
        focus_candidate = {
            "aid": str(details.get("aid") or "").strip(),
            "tag": str(details.get("tag") or "").strip(),
            "text": str(details.get("text") or "").strip(),
            "left": int(details.get("left") or 0),
            "top": int(details.get("top") or 0),
            "width": int(details.get("width") or 0),
            "height": int(details.get("height") or 0),
        }
        return {
            "summary": format_element_details(details),
            "candidate_elements": [focus_candidate] if focus_candidate.get("aid") or focus_candidate.get("text") else [],
            "focus_candidate": focus_candidate if focus_candidate.get("aid") or focus_candidate.get("text") else {},
        }
    elif action_name == "wait":
        seconds = max(1, min(10, int(resolved_action.get("seconds") or 2)))
        time.sleep(seconds)
        summary = f"已等待 {seconds} 秒"
    elif action_name == "inspect_dom":
        snapshot = build_page_snapshot(driver, element_limit=80)
        formatted_text, _index_map = format_dom_snapshot(snapshot, element_limit=80)
        return {
            "summary": formatted_text,
            "after_snapshot": snapshot,
            "verification": {
                "action": action_name,
                "meaningful_change": True,
                "summary": "已完成页面观察。",
            },
            "resolved_action": resolved_action,
        }
    elif action_name == "run_dom_script":
        goal = str(resolved_action.get("goal") or "").strip() or "执行 DOM 脚本"
        script_body = _validate_dom_script(resolved_action.get("script"))
        script_result = _execute_dom_script(driver, script_body)
        if not bool(script_result.get("ok")):
            raise RuntimeError(f"DOM script failed: {script_result.get('error') or 'unknown error'}")
        returned_data = script_result.get("data")
        preview = _preview_dom_script_data(returned_data)
        summary = f"已执行 DOM 脚本: {goal}"
        if preview and preview not in {"null", '""', "{}", "[]"}:
            summary = f"{summary}\n返回: {preview}"
    elif action_name == "screenshot":
        screenshot_path = save_screenshot(driver, output_dir, prefix="agent")
        return {
            "summary": "已截取当前页面截图。",
            "after_snapshot": build_page_snapshot(driver),
            "verification": {"action": action_name, "meaningful_change": True, "summary": "已截取页面截图。"},
            "screenshot_path": screenshot_path,
            "resolved_action": resolved_action,
        }
    else:
        raise RuntimeError(f"unsupported action: {action_name or 'unknown'}")

    post_action_delay = 2 if action_name == "open_url" else 1
    time.sleep(post_action_delay)
    after_snapshot = build_page_snapshot(driver)
    after_details: dict[str, Any] = {}
    if str(resolved_action.get("aid") or "").strip():
        try:
            after_details = get_element_details(driver, str(resolved_action.get("aid") or ""))
        except Exception:
            after_details = {}
        if not after_details:
            after_details = matching_element_from_snapshot(after_snapshot, str(resolved_action.get("aid") or ""), before_details)
    if action_name == "click":
        clicked_element = _clicked_element_payload(
            after_details,
            click_info,
            before_details,
            {"aid": str(resolved_action.get("aid") or "").strip()},
        )
        summary = _click_summary(clicked_element, summary)

    verification = verify_browser_action(
        before_snapshot=snapshot_before,
        after_snapshot=after_snapshot,
        action=resolved_action,
        before_details=before_details,
        after_details=after_details,
    )
    if action_name == "download_file":
        verification = dict(verification or {})
        verification["action"] = action_name
        verification["meaningful_change"] = download_confirmed
        verification["summary"] = (
            f"已确认下载文件: {download_file_name}"
            if download_confirmed and download_file_name
            else "已触发下载，但未在超时时间内确认文件落盘。"
        )
    screenshot_path = ""
    result = {
        "summary": summary,
        "verification": verification,
        "after_snapshot": after_snapshot,
        "screenshot_path": screenshot_path,
        "resolved_action": resolved_action,
        "clicked_element": clicked_element,
    }
    if action_name == "download_file":
        result["file_name"] = download_file_name
        result["file_path"] = download_file_path
        result["download_confirmed"] = download_confirmed
    return result


__all__ = ["execute_browser_action", "save_screenshot"]
