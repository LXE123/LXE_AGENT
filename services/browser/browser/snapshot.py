from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

from selenium.webdriver.remote.webdriver import WebDriver

from services.browser.browser.seller_central_adapters import (
    SELLER_CENTRAL_EXTRACTION_JS,
    seller_central_home_favorite_links,
    seller_central_landmarks,
    seller_central_summary_lines,
)
from services.browser.browser.shadow_dom import SHADOW_DOM_HELPERS_JS


def _safe_text(value: Any, limit: int = 400) -> str:
    text = " ".join(str(value or "").strip().split())
    return text[:limit]


_REGION_ORDER = ("dialog", "nav", "toolbar", "main", "sidebar", "pagination", "other")
_REGION_TITLES = {
    "dialog": "弹窗",
    "nav": "导航",
    "toolbar": "工具栏",
    "main": "主内容",
    "sidebar": "侧边栏",
    "pagination": "分页",
    "other": "其他",
}


def _short_url(value: Any) -> str:
    text = _safe_text(value, 240)
    if not text:
        return ""
    if text.startswith("/"):
        return text[:120]
    parsed = urlparse(text if "://" in text else f"https://{text}")
    host = _safe_text(parsed.netloc, 80)
    path = _safe_text(parsed.path, 120).rstrip("/")
    if host and path:
        return f"{host}{path}"
    return host or path or text[:120]


def _element_label(item: dict[str, Any]) -> str:
    element = dict(item or {})
    for key in ("text", "aria_label", "placeholder", "data_testid", "name", "id"):
        value = _safe_text(element.get(key), 80)
        if value:
            return value
    return _safe_text(element.get("tag"), 40) or "未命名元素"


def _normalized_region(value: Any) -> str:
    region = _safe_text(value, 24).lower()
    if region in _REGION_TITLES:
        return region
    return "other"


def _display_tag(item: dict[str, Any]) -> str:
    tag = _safe_text(dict(item or {}).get("tag"), 24).lower()
    if tag == "a":
        return "link"
    if tag:
        return tag
    return "element"


def _quoted_text(value: Any, limit: int = 120) -> str:
    return _safe_text(value, limit).replace('"', "'")


def _combined_interactive_elements(
    page_snapshot: dict[str, Any],
    *,
    element_limit: int | None = None,
) -> list[dict[str, Any]]:
    snapshot = dict(page_snapshot or {})
    safe_limit = None if element_limit is None else max(1, int(element_limit))
    combined: list[dict[str, Any]] = []
    seen_aids: set[str] = set()
    for key in ("sendtoamazon_controls", "interactive_elements"):
        for raw_item in list(snapshot.get(key) or []):
            item = dict(raw_item or {})
            aid = _safe_text(item.get("aid"), 64)
            if not aid or aid in seen_aids:
                continue
            if key == "sendtoamazon_controls" and not _safe_text(item.get("region"), 24):
                item["region"] = "main"
            combined.append(item)
            seen_aids.add(aid)
            if safe_limit is not None and len(combined) >= safe_limit:
                return combined[:safe_limit]
    return combined if safe_limit is None else combined[:safe_limit]


def _ordered_indexed_elements(
    page_snapshot: dict[str, Any],
    *,
    element_limit: int = 80,
) -> list[tuple[int, dict[str, Any]]]:
    snapshot = dict(page_snapshot or {})
    grouped: dict[str, list[dict[str, Any]]] = {region: [] for region in _REGION_ORDER}
    safe_limit = max(1, int(element_limit or 80))
    for item in _combined_interactive_elements(snapshot, element_limit=safe_limit):
        element = dict(item or {})
        aid = _safe_text(element.get("aid"), 64)
        if not aid:
            continue
        grouped[_normalized_region(element.get("region"))].append(element)

    ordered: list[tuple[int, dict[str, Any]]] = []
    next_index = 1
    for region in _REGION_ORDER:
        for item in grouped[region]:
            ordered.append((next_index, item))
            next_index += 1
    return ordered


def _format_element_line(index: int, item: dict[str, Any]) -> str:
    element = dict(item or {})
    label = _quoted_text(_element_label(element), 100)
    tag = _display_tag(element)
    parts = [f"[{int(index)}] {tag}"]
    if label and label.lower() != tag.lower():
        parts.append(f'"{label}"')

    attribute_parts: list[str] = []
    element_type = _safe_text(element.get("type"), 40).lower()
    if tag == "input" and element_type == "file":
        attribute_parts.append('type="file"')
    if bool(element.get("download")):
        attribute_parts.append("download")
    control_kind = _safe_text(element.get("control_kind"), 64)
    if control_kind:
        attribute_parts.append(f'control="{control_kind}"')

    placeholder = _quoted_text(element.get("placeholder"), 100)
    if placeholder and placeholder != label:
        attribute_parts.append(f'placeholder="{placeholder}"')

    value = _quoted_text(element.get("selected_option") or element.get("value"), 100)
    if value and value != label:
        attribute_parts.append(f'value="{value}"')

    options = [
        _quoted_text(option, 40)
        for option in list(element.get("options") or [])
        if _quoted_text(option, 40)
    ]
    if options:
        formatted_options = ",".join(f'"{option}"' for option in options[:6])
        attribute_parts.append(f"options=[{formatted_options}]")

    if element.get("disabled"):
        attribute_parts.append("disabled")

    parts.extend(attribute_parts)
    return " ".join(part for part in parts if part).strip()


def _format_navigation_item(item: dict[str, Any]) -> str:
    entry = dict(item or {})
    label = _safe_text(entry.get("label") or entry.get("text"), 80)
    return label


def _execute_page_snapshot(driver: WebDriver, *, element_limit: int, text_limit: int) -> dict[str, Any]:
    script = f"""
{SHADOW_DOM_HELPERS_JS}
const limit = arguments[0];
const textLimit = arguments[1];

function isVisible(el) {{
  if (!el || !(el instanceof Element)) return false;
  const style = window.getComputedStyle(el);
  if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {{
    return false;
  }}
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}}

function isFileInput(el) {{
  return (el.tagName || '').toLowerCase() === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'file';
}}

function compactText(el) {{
  const raw = (el.innerText || el.textContent || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim();
  return raw.replace(/\\s+/g, ' ').slice(0, 120);
}}

function compactValue(value, limit = 120) {{
  return String(value || '').trim().replace(/\\s+/g, ' ').slice(0, limit);
}}

function pushUnique(items, value, limit = 10) {{
  const text = compactValue(value, 120);
  if (!text || items.includes(text)) return;
  items.push(text);
  if (items.length > limit) items.length = limit;
}}

function findAid(el) {{
  if (!el || !(el instanceof Element)) return '';
  return el.getAttribute('data-aid') || '';
}}

function ensureAid(el) {{
  const existing = findAid(el);
  if (existing) return existing;
  const aid = `aid-${{index++}}`;
  el.setAttribute('data-aid', aid);
  return aid;
}}

function regionOf(el) {{
  if (!el || !(el instanceof Element)) return 'other';
  if (deepClosest(el, 'dialog, [role="dialog"], [aria-modal="true"], [data-testid*="modal"], [class*="modal"]')) {{
    return 'dialog';
  }}
  if (deepClosest(el, '[aria-label*="pagination" i], [class*="pagination"], [class*="pager"], [data-testid*="pagination"], nav[aria-label*="page" i]')) {{
    return 'pagination';
  }}
  if (deepClosest(el, 'nav, [role="navigation"], [data-testid*="nav"], [class*="nav"], [data-testid*="menu"]')) {{
    return 'nav';
  }}
  if (deepClosest(el, 'aside, [role="complementary"], [data-testid*="sidebar"], [class*="sidebar"]')) {{
    return 'sidebar';
  }}
  if (deepClosest(el, '[role="toolbar"], [data-testid*="toolbar"], [class*="toolbar"], [class*="filter"], [class*="search"], header')) {{
    return 'toolbar';
  }}
  if (deepClosest(el, 'main, [role="main"], article, section, form, table, [data-testid*="main"], [class*="content"]')) {{
    return 'main';
  }}
  return 'other';
}}

const seen = new Set();
const interactive = [];
const collectLimit = Math.max(limit * 3, limit);
let index = 0;
for (const el of deepQuerySelectorAll('button, a, input, select, textarea, [role="button"], [role="link"], [data-testid]')) {{
  const visible = isVisible(el);
  const fileInput = isFileInput(el);
  if (!visible && !fileInput) continue;
  const rect = el.getBoundingClientRect();
  const key = [
    el.tagName,
    el.id || '',
    el.getAttribute('name') || '',
    compactText(el),
    Math.round(rect.top),
    Math.round(rect.left),
  ].join('|');
  if (seen.has(key)) continue;
  seen.add(key);
  const aid = ensureAid(el);
    interactive.push({{
      aid,
      tag: (el.tagName || '').toLowerCase(),
      text: compactText(el),
      type: el.getAttribute('type') || '',
      download: el.hasAttribute('download'),
      visible,
      disabled: Boolean(el.disabled),
    id: el.id || '',
    name: el.getAttribute('name') || '',
    placeholder: el.getAttribute('placeholder') || '',
    aria_label: el.getAttribute('aria-label') || '',
    data_testid: el.getAttribute('data-testid') || '',
    value: ('value' in el ? String(el.value || '').trim() : ''),
    options: (el.tagName || '').toLowerCase() === 'select'
      ? Array.from(el.options || []).slice(0, 20).map(opt => (opt.textContent || opt.label || opt.value || '').trim()).filter(Boolean)
      : [],
    selected_option: (el.tagName || '').toLowerCase() === 'select' && el.selectedOptions && el.selectedOptions[0]
      ? ((el.selectedOptions[0].textContent || el.selectedOptions[0].label || el.selectedOptions[0].value || '').trim())
      : '',
    region: regionOf(el),
    top: Math.round(rect.top),
    left: Math.round(rect.left),
  }});
  if (interactive.length >= collectLimit) break;
}}

function isCustomElementTag(tag) {{
  return String(tag || '').includes('-');
}}

function isNativeInteractiveTag(tag) {{
  const normalizedTag = String(tag || '').toLowerCase();
  return ['a', 'button', 'input', 'select', 'textarea'].includes(normalizedTag);
}}

function dedupeLabel(item) {{
  return compactValue(item.text || item.aria_label || item.placeholder || item.data_testid || item.name || item.id || item.tag || '', 80);
}}

function positionKey(item) {{
  return `${{dedupeLabel(item)}}|${{Math.round(Number(item.top || 0) / 5)}}|${{Math.round(Number(item.left || 0) / 5)}}`;
}}

const nativePositions = new Set();
for (const item of interactive) {{
  if (isNativeInteractiveTag(item.tag)) {{
    nativePositions.add(positionKey(item));
  }}
}}

const filteredInteractive = interactive
  .filter(item => !(isCustomElementTag(item.tag) && nativePositions.has(positionKey(item))))
  .slice(0, limit);

const headingSeen = new Set();
const headings = [];
for (const el of deepQuerySelectorAll('h1, h2, h3, [role="heading"], legend')) {{
  if (!isVisible(el)) continue;
  const text = compactText(el);
  if (!text || headingSeen.has(text)) continue;
  headingSeen.add(text);
  headings.push(text);
  if (headings.length >= 8) break;
}}

const rawBodyText = document.body ? (document.body.innerText || '') : '';
const textLines = [];
const lineSeen = new Set();
for (const rawLine of rawBodyText.split(/\\n+/)) {{
  const line = compactValue(rawLine, 140);
  if (!line || lineSeen.has(line) || line.length < 2 || /^[\\d\\W]+$/.test(line)) continue;
  lineSeen.add(line);
  textLines.push(line);
  if (textLines.length >= 12) break;
}}

const breadcrumbs = [];
for (const container of deepQuerySelectorAll('nav, ol, ul, div')) {{
  if (!isVisible(container)) continue;
  const hint = [
    container.getAttribute('aria-label') || '',
    container.className || '',
    container.getAttribute('data-testid') || '',
  ].join(' ').toLowerCase();
  if (!hint.includes('breadcrumb') && !hint.includes('crumb')) continue;
  for (const item of deepQuerySelectorAll('a, span, li', container)) {{
    if (!isVisible(item)) continue;
    pushUnique(breadcrumbs, item.innerText || item.textContent, 8);
  }}
  if (breadcrumbs.length) break;
}}

const tabs = [];
for (const el of deepQuerySelectorAll('[role="tab"], [data-testid*="tab"], button[aria-controls], a[aria-controls]')) {{
  if (!isVisible(el)) continue;
  const text = compactText(el);
  if (!text) continue;
  tabs.push({{
    text,
    selected: String(el.getAttribute('aria-selected') || '').toLowerCase() === 'true'
      || el.getAttribute('tabindex') === '0'
      || el.getAttribute('aria-current') === 'page',
  }});
  if (tabs.length >= 8) break;
}}

const pagination = [];
for (const container of deepQuerySelectorAll('nav, ul, div')) {{
  if (!isVisible(container)) continue;
  const hint = [
    container.getAttribute('aria-label') || '',
    container.className || '',
    container.getAttribute('data-testid') || '',
  ].join(' ').toLowerCase();
  if (!hint.includes('pagination') && !hint.includes('pager') && !hint.includes('page')) continue;
  const items = [];
  for (const el of deepQuerySelectorAll('a, button, span', container)) {{
    if (!isVisible(el)) continue;
    const text = compactText(el);
    if (!text) continue;
    items.push({{
      text,
      current: el.getAttribute('aria-current') === 'page'
        || String(el.className || '').toLowerCase().includes('selected')
        || String(el.className || '').toLowerCase().includes('active'),
    }});
    if (items.length >= 10) break;
  }}
  if (items.length >= 2) {{
    pagination.push(...items.slice(0, 10));
    break;
  }}
}}

const dialogs = [];
for (const el of deepQuerySelectorAll('dialog, [role="dialog"], [aria-modal="true"], [data-testid*="modal"], [class*="modal"]')) {{
  if (!isVisible(el)) continue;
  dialogs.push({{
    title: compactValue(((deepQuerySelector('h1, h2, h3, [role="heading"], header', el) || {{}}).innerText || ''), 120),
    text: compactValue(el.innerText || el.textContent, 200),
    actions: [],
  }});
  if (dialogs.length >= 4) break;
}}

const forms = [];
for (const el of deepQuerySelectorAll('form, [role="form"]')) {{
  if (!isVisible(el)) continue;
  forms.push({{
    title: compactValue(((deepQuerySelector('h1, h2, h3, legend, [role="heading"]', el) || {{}}).innerText || ''), 120),
    field_count: deepQuerySelectorAll('input, select, textarea', el).length,
    button_count: deepQuerySelectorAll('button, [role="button"], input[type="submit"]', el).length,
  }});
  if (forms.length >= 4) break;
}}

{SELLER_CENTRAL_EXTRACTION_JS}

const bodyText = rawBodyText.replace(/\\s+/g, ' ').trim();
return {{
  title: document.title || '',
  url: window.location.href || '',
  viewport_y: Math.round(window.scrollY || window.pageYOffset || 0),
  headings,
  breadcrumbs,
  tabs,
  pagination,
  dialogs,
  forms,
  tables: tableMeta.tables,
  favorite_links: favoriteLinkItems,
  top_nav: topNav,
  side_nav: sideNav,
  sendtoamazon_controls: sendToAmazonControlItems,
  search_controls: searchControlItems,
  upload_controls: uploadControlItems,
  table_actions: tableMeta.tableActions,
  inventory_flows: inventoryFlowItems,
  row_action_menus: tableMeta.rowActionMenus,
  upload_dialogs: uploadDialogItems,
  modal_confirmations: modalConfirmationItems,
  text_lines: textLines,
  visible_text: bodyText.slice(0, textLimit),
  interactive_elements: filteredInteractive,
}};
"""
    return dict(driver.execute_script(script, int(element_limit), int(text_limit)) or {})


def build_page_snapshot(driver: WebDriver, *, element_limit: int = 80, text_limit: int = 2000) -> dict[str, Any]:
    return _execute_page_snapshot(driver, element_limit=int(element_limit), text_limit=int(text_limit))


def get_element_index_map(
    page_snapshot: dict[str, Any],
    *,
    element_limit: int = 80,
) -> dict[int, str]:
    return {
        index: _safe_text(item.get("aid"), 64)
        for index, item in _ordered_indexed_elements(page_snapshot, element_limit=element_limit)
    }


def format_dom_snapshot(
    page_snapshot: dict[str, Any],
    *,
    element_limit: int = 80,
) -> tuple[str, dict[int, str]]:
    snapshot = dict(page_snapshot or {})
    title = _safe_text(snapshot.get("title"), 200)
    url = _safe_text(snapshot.get("url"), 300)
    header = f"📍 {title or '当前页面'}"
    short_url = _short_url(url)
    if short_url:
        header += f" | {short_url}"

    index_map = get_element_index_map(snapshot, element_limit=element_limit)
    ordered_aids = [aid for _, aid in sorted(index_map.items(), key=lambda item: int(item[0]))]
    aid_to_element = {
        _safe_text(item.get("aid"), 64): dict(item or {})
        for item in _combined_interactive_elements(snapshot)
    }

    sections: list[str] = [header]
    grouped_lines: dict[str, list[str]] = {region: [] for region in _REGION_ORDER}
    for index, aid in enumerate(ordered_aids, start=1):
        item = dict(aid_to_element.get(aid) or {})
        if not item:
            continue
        region = _normalized_region(item.get("region"))
        grouped_lines[region].append(_format_element_line(index, item))

    for region in _REGION_ORDER:
        lines = grouped_lines[region]
        if not lines:
            continue
        sections.append("")
        sections.append(f"[{_REGION_TITLES[region]}]")
        sections.extend(lines)

    if len(sections) == 1:
        sections.append("")
        sections.append("当前页面没有提取到可编号的可交互元素。")
    return "\n".join(sections), index_map


def format_element_details(element_details: dict[str, Any]) -> str:
    details = dict(element_details or {})
    if not details:
        return "没有找到目标元素的详细信息。"

    lines = []
    aid = _safe_text(details.get("aid"), 80)
    tag = _safe_text(details.get("tag"), 40)
    if aid:
        lines.append(f"元素标识: {aid}")
    if tag:
        lines.append(f"标签: {tag}")
    for label, key in (
        ("文本", "text"),
        ("类型", "type"),
        ("控件标记", "control_kind"),
        ("当前值", "value"),
        ("占位提示", "placeholder"),
        ("ARIA 标签", "aria_label"),
        ("链接", "href"),
        ("name", "name"),
        ("id", "id"),
        ("data-testid", "data_testid"),
        ("已选选项", "selected_option"),
    ):
        value = _safe_text(details.get(key), 200)
        if value:
            lines.append(f"{label}: {value}")

    if bool(details.get("download")):
        lines.append("下载属性: present")

    labels = [_safe_text(item, 80) for item in list(details.get("labels") or []) if _safe_text(item, 80)]
    if labels:
        lines.append(f"关联标签: {' | '.join(labels[:5])}")

    options = [_safe_text(item, 60) for item in list(details.get("options") or []) if _safe_text(item, 60)]
    if options:
        lines.append(f"可选项: {' | '.join(options[:8])}")

    container_text = _safe_text(details.get("container_text"), 240)
    if container_text:
        lines.append(f"附近上下文: {container_text}")

    html = _safe_text(details.get("html"), 700)
    if html:
        lines.append(f"HTML: {html}")

    return "\n".join(lines) if lines else "没有找到目标元素的详细信息。"


def summarize_page_landmarks(page_snapshot: dict[str, Any], *, limit: int = 8) -> list[str]:
    snapshot = dict(page_snapshot or {})
    favorite_links = seller_central_home_favorite_links(snapshot)
    if favorite_links:
        home_items = seller_central_landmarks(snapshot, safe_text=_safe_text, limit=limit)
        return home_items[:limit]
    items: list[str] = []
    for value in list(snapshot.get("headings") or []):
        text = _safe_text(value, 80)
        if text and text not in items:
            items.append(text)
        if len(items) >= limit:
            return items[:limit]
    for value in list(snapshot.get("breadcrumbs") or []):
        text = _safe_text(value, 80)
        if text and text not in items:
            items.append(text)
        if len(items) >= limit:
            return items[:limit]
    for text in seller_central_landmarks(snapshot, safe_text=_safe_text, limit=limit):
        if text and text not in items:
            items.append(text)
        if len(items) >= limit:
            return items[:limit]
    for dialog in list(snapshot.get("dialogs") or []):
        for key in ("title", "text"):
            text = _safe_text(dict(dialog or {}).get(key), 80)
            if text and text not in items:
                items.append(text)
            if len(items) >= limit:
                return items[:limit]
    for value in list(snapshot.get("text_lines") or []):
        text = _safe_text(value, 80)
        if text and text not in items:
            items.append(text)
        if len(items) >= limit:
            return items[:limit]
    return items[:limit]


def get_element_details(driver: WebDriver, aid: str) -> dict[str, Any]:
    return dict(
        driver.execute_script(
            SHADOW_DOM_HELPERS_JS + """
const aid = arguments[0];
const el = deepQuerySelector(`[data-aid="${aid}"]`);
if (!el) return {};

function compact(value, limit) {
  return String(value || '').trim().replace(/\\s+/g, ' ').slice(0, limit);
}

const labels = [];
if (el.id) {
  for (const label of deepQuerySelectorAll('label')) {
    if ((label.htmlFor || '') === el.id) {
      labels.push(compact(label.innerText || label.textContent, 120));
    }
  }
}
const parentLabel = deepClosest(el, 'label');
if (parentLabel) {
  labels.push(compact(parentLabel.innerText || parentLabel.textContent, 120));
}

const rect = el.getBoundingClientRect();
const container = deepClosest(el, 'form, table, [role="dialog"], dialog, section, article, li, tr, div');
const options = (el.tagName || '').toLowerCase() === 'select'
  ? Array.from(el.options || []).slice(0, 30).map(opt => compact(opt.textContent || opt.label || opt.value, 80)).filter(Boolean)
  : [];

  return {
  aid,
  tag: (el.tagName || '').toLowerCase(),
  type: el.getAttribute('type') || '',
  download: el.hasAttribute('download'),
  text: compact(el.innerText || el.textContent || '', 240),
  value: compact(el.value || '', 240),
  placeholder: compact(el.getAttribute('placeholder') || '', 120),
  aria_label: compact(el.getAttribute('aria-label') || '', 120),
  href: compact(el.getAttribute('href') || '', 240),
  id: compact(el.id || '', 120),
  name: compact(el.getAttribute('name') || '', 120),
  data_testid: compact(el.getAttribute('data-testid') || '', 120),
  labels: labels.filter(Boolean).slice(0, 5),
  options,
  selected_option: (el.tagName || '').toLowerCase() === 'select' && el.selectedOptions && el.selectedOptions[0]
    ? compact(el.selectedOptions[0].textContent || el.selectedOptions[0].label || el.selectedOptions[0].value, 80)
    : '',
  container_text: compact(container ? (container.innerText || container.textContent || '') : '', 280),
  top: Math.round(rect.top),
  left: Math.round(rect.left),
  width: Math.round(rect.width),
  height: Math.round(rect.height),
  html: compact(el.outerHTML || '', 800),
};
""",
            str(aid or "").strip(),
        )
        or {}
    )


__all__ = [
    "build_page_snapshot",
    "format_dom_snapshot",
    "format_element_details",
    "get_element_index_map",
    "get_element_details",
    "summarize_page_landmarks",
]
