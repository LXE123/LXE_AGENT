from __future__ import annotations

from typing import Any


SELLER_CENTRAL_EXTRACTION_JS = r"""
function navItems(selectors, limit) {
  const items = [];
  const seenKeys = new Set();
  for (const el of deepQuerySelectorAll(selectors)) {
    if (!isVisible(el)) continue;
    const label = compactText(el);
    const aid = ensureAid(el);
    const href = compactValue(el.getAttribute('href') || '', 160);
    const key = `${label}|${href}|${aid}`;
    if ((!label && !aid) || seenKeys.has(key)) continue;
    seenKeys.add(key);
    items.push({ aid, label, href, text: label || '' });
    if (items.length >= limit) break;
  }
  return items;
}

function favoriteLinks(limit) {
  const items = [];
  const seenKeys = new Set();
  for (const el of deepQuerySelectorAll('#fav-bar__links-list a, .fav-bar__links-list a, [id*="fav-bar"] a, [class*="fav-bar"] a')) {
    const label = compactText(el) || compactValue(el.getAttribute('aria-label') || el.getAttribute('data-page-id') || '', 120);
    const aid = ensureAid(el);
    const href = compactValue(el.getAttribute('href') || '', 160);
    const key = `${label}|${href}|${aid}`;
    if ((!label && !href) || seenKeys.has(key)) continue;
    seenKeys.add(key);
    items.push({
      aid,
      label,
      href,
      text: label || '',
      visible: isVisible(el),
    });
    if (items.length >= limit) break;
  }
  return items;
}

function searchControls() {
  const controls = [];
  const hints = ['search', 'filter', 'sku', 'asin', 'keyword', 'query', '搜索', '筛选', '过滤'];
  for (const el of deepQuerySelectorAll('input, select, textarea')) {
    const visible = isVisible(el);
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (!visible && type !== 'file') continue;
    const form = deepClosest(el, 'form');
    const haystack = [
      el.getAttribute('placeholder') || '',
      el.getAttribute('aria-label') || '',
      el.getAttribute('name') || '',
      el.getAttribute('data-testid') || '',
      form ? (form.innerText || '') : '',
    ].join(' ').toLowerCase();
    if (!hints.some(token => haystack.includes(token))) continue;
    controls.push({
      aid: ensureAid(el),
      tag: (el.tagName || '').toLowerCase(),
      type: type || '',
      label: compactValue(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('data-testid') || '', 120),
      value: compactValue(el.value || '', 120),
      text: compactText(el),
    });
    if (controls.length >= 10) break;
  }
  return controls;
}

function uploadControls() {
  const controls = [];
  const hints = ['upload', 'import', '上传', '导入'];
  for (const el of deepQuerySelectorAll('input[type="file"], button, a, [role="button"], [role="link"]')) {
    const type = (el.getAttribute('type') || '').toLowerCase();
    const visible = isVisible(el);
    if (!visible && type !== 'file') continue;
    const haystack = [
      el.innerText || el.textContent || '',
      el.getAttribute('aria-label') || '',
      el.getAttribute('data-testid') || '',
      el.getAttribute('id') || '',
    ].join(' ').toLowerCase();
    if (type !== 'file' && !hints.some(token => haystack.includes(token))) continue;
    controls.push({
      aid: ensureAid(el),
      tag: (el.tagName || '').toLowerCase(),
      type: type || '',
      label: compactValue(el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('data-testid') || '', 120),
      text: compactText(el),
    });
    if (controls.length >= 10) break;
  }
  return controls;
}

function isSendToAmazonPage() {
  const href = String(window.location.href || '').toLowerCase();
  if (href.includes('/fba/sendtoamazon')) return true;
  return Boolean(
    deepQuerySelector('[data-testid="start-new-button"]') ||
    deepQuerySelector('[data-testid="file-upload-radio-button"]') ||
    deepQuerySelector('[data-testid="file-upload-button-input"]') ||
    deepQuerySelector('[data-testid="manifest-file-upload-template-generator-download-link"]')
  );
}

function clickableDescendant(el) {
  if (!el || !(el instanceof Element)) return null;
  const tag = String(el.tagName || '').toLowerCase();
  if (['a', 'button'].includes(tag)) return el;
  if (tag === 'input' && ['button', 'submit', 'radio', 'checkbox', 'file'].includes(String(el.getAttribute('type') || '').toLowerCase())) {
    return el;
  }
  if (el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link') return el;
  if (el.shadowRoot) {
    const shadowMatch = deepQuerySelector('a, button, input[type="button"], input[type="submit"], input[type="radio"], input[type="file"], [role="button"], [role="link"]', el.shadowRoot);
    if (shadowMatch) return shadowMatch;
  }
  return deepQuerySelector('a, button, input[type="button"], input[type="submit"], input[type="radio"], input[type="file"], [role="button"], [role="link"]', el);
}

function controlItem(el, config) {
  if (!el || !(el instanceof Element)) return null;
  const target = clickableDescendant(el) || el;
  const rect = target.getBoundingClientRect();
  const label = compactValue(
    config.label ||
    target.getAttribute('aria-label') ||
    target.innerText ||
    target.textContent ||
    target.getAttribute('data-testid') ||
    target.getAttribute('name') ||
    '',
    120
  );
  return {
    aid: ensureAid(target),
    tag: String(target.tagName || '').toLowerCase(),
    type: target.getAttribute('type') || '',
    text: compactText(target) || label,
    label,
    data_testid: compactValue(
      target.getAttribute('data-testid') ||
      el.getAttribute('data-testid') ||
      config.dataTestid ||
      '',
      120
    ),
    download: Boolean(target.hasAttribute('download') || el.hasAttribute('download')),
    region: 'main',
    top: Math.round(rect.top),
    left: Math.round(rect.left),
    control_kind: config.controlKind || '',
    preferred_action: config.preferredAction || '',
    priority: Number(config.priority || 0),
  };
}

function sendToAmazonControls() {
  if (!isSendToAmazonPage()) return [];
  const controls = [];
  const seenKinds = new Set();

  function pushControl(kind, el, config) {
    if (!el || seenKinds.has(kind)) return;
    const item = controlItem(el, { ...config, controlKind: kind });
    if (!item || !item.aid) return;
    seenKinds.add(kind);
    controls.push(item);
  }

  const startNewHost = deepQuerySelector('[data-testid="start-new-button"]');
  pushControl('start_new_workflow_button', startNewHost, {
    label: '重新开始',
    preferredAction: 'click',
    priority: 100,
  });

  const fileUploadRadio =
    deepQuerySelector('input[type="radio"][name="file-upload"][value="STA_SKU_SELECTION_METHOD_FILE_UPLOAD"]') ||
    deepQuerySelector('[data-testid="file-upload-radio-button"]');
  pushControl('file_upload_mode_radio', fileUploadRadio, {
    label: '文件上传',
    preferredAction: 'click',
    priority: 95,
    dataTestid: 'file-upload-radio-button',
  });

  const downloadLink =
    deepQuerySelector('[data-testid="manifest-file-upload-template-generator-download-link"]') ||
    deepQuerySelector('[data-testid="manifest-file-upload-template-generator-download-button"]');
  pushControl('template_download_link', downloadLink, {
    label: '生成并下载模板',
    preferredAction: 'download_file',
    priority: 98,
    dataTestid: 'manifest-file-upload-template-generator-download-link',
  });

  const templateFileInput = deepQuerySelector('input[type="file"][data-testid="file-upload-button-input"]');
  pushControl('template_file_input', templateFileInput, {
    label: '上传已填写的文件',
    preferredAction: 'upload_file',
    priority: 97,
    dataTestid: 'file-upload-button-input',
  });

  const templateUploadButton = deepQuerySelector('[data-testid="manifest-file-upload-button"]');
  pushControl('template_upload_button', templateUploadButton, {
    label: '上传已填写的文件',
    preferredAction: 'click',
    priority: 80,
    dataTestid: 'manifest-file-upload-button',
  });

  controls.sort((left, right) => Number(right.priority || 0) - Number(left.priority || 0));
  return controls.slice(0, 8);
}

function inventoryFlows(topNav, sideNav, favoriteLinks, searchControls) {
  const flows = [];
  const hints = ['inventory', 'manage all inventory', '库存', '管理所有库存', 'search', 'sku', 'asin', '筛选'];
  for (const item of [...favoriteLinks, ...topNav, ...sideNav, ...searchControls]) {
    const haystack = [item.label || '', item.text || '', item.href || ''].join(' ').toLowerCase();
    if (!hints.some(token => haystack.includes(token))) continue;
    flows.push(item);
    if (flows.length >= 12) break;
  }
  return flows;
}

function tableMetadata() {
  const tables = [];
  const tableActions = [];
  const rowActionMenus = [];
  for (const el of deepQuerySelectorAll('table, [role="table"], [role="grid"]')) {
    if (!isVisible(el)) continue;
    const headers = [];
    for (const header of deepQuerySelectorAll('th, [role="columnheader"]', el)) {
      pushUnique(headers, header.innerText || header.textContent, 6);
    }
    const title = compactValue(
      (deepQuerySelector('caption, h1, h2, h3, [role="heading"]', el) || {}).innerText || '',
      120
    );
    tables.push({
      title,
      headers,
      row_count: deepQuerySelectorAll('tbody tr, [role="row"]', el).length,
    });
    for (const row of deepQuerySelectorAll('tbody tr, [role="row"]', el)) {
      if (!isVisible(row)) continue;
      const rowHint = compactValue(
        Array.from(deepQuerySelectorAll('td, th, [role="cell"], [role="rowheader"]', row))
          .slice(0, 3)
          .map(cell => cell.innerText || cell.textContent || '')
          .join(' | '),
        160
      );
      const rowActions = [];
      for (const action of deepQuerySelectorAll('button, a, [role="button"], [role="link"]', row)) {
        if (!isVisible(action)) continue;
        const label = compactText(action);
        const aid = ensureAid(action);
        if (!label && !aid) continue;
        const item = {
          aid,
          label: label || compactValue(action.getAttribute('aria-label') || action.getAttribute('data-testid'), 80),
          row_hint: rowHint,
          table_title: title,
        };
        tableActions.push(item);
        rowActions.push(item);
        if (tableActions.length >= 16) break;
      }
      if (rowActions.length) {
        rowActionMenus.push({ row_hint: rowHint, table_title: title, actions: rowActions.slice(0, 6) });
      }
      if (tableActions.length >= 16) break;
    }
    if (tables.length >= 4) break;
  }
  return {
    tables,
    tableActions: tableActions.slice(0, 16),
    rowActionMenus: rowActionMenus.slice(0, 8),
  };
}

function uploadDialogs(dialogs, uploadControls) {
  const results = [];
  for (const dialog of dialogs) {
    const text = [dialog.title || '', dialog.text || ''].join(' ').toLowerCase();
    if (!text.includes('upload') && !text.includes('import') && !text.includes('上传') && !text.includes('导入')) continue;
    results.push(dialog);
    if (results.length >= 4) break;
  }
  if (!results.length && uploadControls.length) {
    results.push({
      title: '页面上传入口',
      text: uploadControls.map(item => item.label || item.text || item.aid || '').filter(Boolean).slice(0, 4).join(' | '),
      actions: uploadControls.slice(0, 4),
    });
  }
  return results;
}

function modalConfirmations(dialogs) {
  const results = [];
  const confirmHints = ['confirm', 'continue', 'submit', 'yes', '确定', '确认', '继续', '提交', '保存'];
  for (const dialog of dialogs) {
    const actions = Array.isArray(dialog.actions) ? dialog.actions : [];
    const matched = actions.filter(item => confirmHints.some(token => String(item.label || '').toLowerCase().includes(token)));
    if (!matched.length) continue;
    results.push({
      title: dialog.title || dialog.text || '',
      text: dialog.text || '',
      actions: matched.slice(0, 4),
    });
    if (results.length >= 4) break;
  }
  return results;
}

const favoriteLinkItems = favoriteLinks(24);
const topNav = navItems('header a, header button, header [role="link"], header [role="button"], [data-testid*="nav"] a, [data-testid*="nav"] button', 12);
const sideNav = navItems('aside a, aside button, nav[aria-label*="导航"] a, nav[aria-label*="导航"] button, [data-testid*="side"] a, [data-testid*="side"] button', 12);
const searchControlItems = searchControls();
const uploadControlItems = uploadControls();
const sendToAmazonControlItems = sendToAmazonControls();
const tableMeta = tableMetadata();
const inventoryFlowItems = inventoryFlows(topNav, sideNav, favoriteLinkItems, searchControlItems);
const uploadDialogItems = uploadDialogs(dialogs, uploadControlItems);
const modalConfirmationItems = modalConfirmations(dialogs);
"""


def _normalize_match(text: Any) -> str:
    return "".join(str(text or "").lower().split())


def _match_text(target: str, *candidates: str) -> bool:
    normalized_target = _normalize_match(target)
    if not normalized_target:
        return False
    for candidate in candidates:
        normalized_candidate = _normalize_match(candidate)
        if normalized_candidate and (
            normalized_candidate == normalized_target
            or normalized_candidate in normalized_target
            or normalized_target in normalized_candidate
        ):
            return True
    return False


def _resolve_from_items(items: list[dict[str, Any]], target_text: str, *, extra_keys: tuple[str, ...] = ()) -> str:
    safe_target = str(target_text or "").strip()
    if not safe_target:
        return ""
    for item in items:
        entry = dict(item or {})
        values = [entry.get("label"), entry.get("text"), entry.get("href"), entry.get("row_hint"), entry.get("table_title")]
        values.extend(entry.get(key) for key in extra_keys)
        if _match_text(safe_target, *(str(value or "") for value in values)):
            aid = str(entry.get("aid") or "").strip()
            if aid:
                return aid
    return ""


def resolve_inventory_search_aid(snapshot: dict[str, Any], target_text: str) -> str:
    data = dict(snapshot or {})
    for key in ("inventory_flows", "favorite_links", "search_controls", "top_nav", "side_nav"):
        aid = _resolve_from_items(list(data.get(key) or []), target_text, extra_keys=("value",))
        if aid:
            return aid
    return ""


_SEND_TO_AMAZON_TARGETS: dict[str, tuple[str, ...]] = {
    "start_new_workflow_button": ("重新开始", "startnew", "start new", "start-new-button"),
    "file_upload_mode_radio": (
        "文件上传",
        "file upload",
        "file-upload-radio-button",
        "sta_sku_selection_method_file_upload",
    ),
    "template_download_link": (
        "生成并下载模板",
        "下载模板",
        "模板下载",
        "template download",
        "manifest-file-upload-template-generator-download-link",
        "manifest-file-upload-template-generator-download-button",
    ),
    "template_file_input": (
        "上传已填写的文件",
        "上传模板",
        "file-upload-button-input",
        "manifest-file-upload-button",
    ),
    "template_upload_button": (
        "上传已填写的文件",
        "上传模板",
        "manifest-file-upload-button",
    ),
}


def resolve_sendtoamazon_aid(snapshot: dict[str, Any], target_text: str, *, action_name: str = "") -> str:
    data = dict(snapshot or {})
    safe_target = str(target_text or "").strip()
    if not safe_target:
        return ""

    preferred_by_action = {
        "download_file": ("template_download_link",),
        "upload_file": ("template_file_input",),
        "click": (
            "start_new_workflow_button",
            "file_upload_mode_radio",
            "template_download_link",
            "template_upload_button",
        ),
        "get_element_details": (
            "template_download_link",
            "template_file_input",
            "file_upload_mode_radio",
            "start_new_workflow_button",
            "template_upload_button",
        ),
    }
    preferred_kinds = preferred_by_action.get(str(action_name or "").strip().lower(), ())
    controls = [dict(item or {}) for item in list(data.get("sendtoamazon_controls") or [])]

    def find_match(kinds: tuple[str, ...] | None = None) -> str:
        for entry in controls:
            control_kind = str(entry.get("control_kind") or "").strip()
            if kinds and control_kind not in kinds:
                continue
            values = [
                entry.get("label"),
                entry.get("text"),
                entry.get("data_testid"),
                entry.get("preferred_action"),
                control_kind,
            ]
            values.extend(_SEND_TO_AMAZON_TARGETS.get(control_kind, ()))
            if _match_text(safe_target, *(str(value or "") for value in values)):
                aid = str(entry.get("aid") or "").strip()
                if aid:
                    return aid
        return ""

    if preferred_kinds:
        aid = find_match(preferred_kinds)
        if aid:
            return aid
    return find_match()


def resolve_row_action_aid(snapshot: dict[str, Any], target_text: str) -> str:
    data = dict(snapshot or {})
    for item in list(data.get("row_action_menus") or []):
        aid = _resolve_from_items(list(dict(item or {}).get("actions") or []), target_text)
        if aid:
            return aid
    return _resolve_from_items(list(data.get("table_actions") or []), target_text)


def resolve_upload_aid(snapshot: dict[str, Any], target_text: str) -> str:
    data = dict(snapshot or {})
    for item in list(data.get("upload_dialogs") or []):
        aid = _resolve_from_items(list(dict(item or {}).get("actions") or []), target_text)
        if aid:
            return aid
    aid = resolve_sendtoamazon_aid(data, target_text, action_name="upload_file")
    if aid:
        return aid
    return _resolve_from_items(list(data.get("upload_controls") or []), target_text)


def resolve_modal_confirmation_aid(snapshot: dict[str, Any], target_text: str) -> str:
    data = dict(snapshot or {})
    for item in list(data.get("modal_confirmations") or []):
        aid = _resolve_from_items(list(dict(item or {}).get("actions") or []), target_text)
        if aid:
            return aid
    return ""


def seller_central_home_favorite_links(snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    for raw_item in list(dict(snapshot or {}).get("favorite_links") or []):
        item = dict(raw_item or {})
        label = str(item.get("label") or item.get("text") or "").strip()
        href = str(item.get("href") or "").strip()
        aid = str(item.get("aid") or "").strip()
        key = (label, href, aid)
        if not label or key in seen:
            continue
        seen.add(key)
        items.append(
            {
                "aid": aid,
                "label": label,
                "text": label,
                "href": href,
            }
        )
    return items


def seller_central_summary_lines(snapshot: dict[str, Any], *, safe_text) -> list[str]:
    data = dict(snapshot or {})
    lines: list[str] = []

    sendtoamazon_controls = [
        safe_text(dict(item or {}).get("label") or dict(item or {}).get("text"), 30)
        for item in list(data.get("sendtoamazon_controls") or [])
    ]
    sendtoamazon_controls = [item for item in sendtoamazon_controls if item]
    if sendtoamazon_controls:
        lines.append(f"货件创建控件: {' | '.join(sendtoamazon_controls[:5])}")
        return lines

    favorite_links = [
        safe_text(dict(item or {}).get("label") or dict(item or {}).get("text"), 24)
        for item in seller_central_home_favorite_links(data)
    ]
    favorite_links = [item for item in favorite_links if item]
    if favorite_links:
        lines.append(f"首页快捷导航: {' | '.join(favorite_links[:10])}")
        return lines

    inventory_items = [safe_text(dict(item or {}).get("label") or dict(item or {}).get("text"), 40) for item in list(data.get("inventory_flows") or [])]
    inventory_items = [item for item in inventory_items if item]
    if inventory_items:
        lines.append(f"库存/搜索路径: {' | '.join(inventory_items[:6])}")

    row_actions = []
    for item in list(data.get("row_action_menus") or [])[:3]:
        entry = dict(item or {})
        row_hint = safe_text(entry.get("row_hint"), 40)
        labels = [
            safe_text(dict(action or {}).get('label') or dict(action or {}).get('text'), 24)
            for action in list(entry.get("actions") or [])[:3]
        ]
        labels = [label for label in labels if label]
        if row_hint and labels:
            row_actions.append(f"{row_hint}: {' / '.join(labels)}")
    if row_actions:
        lines.append(f"行操作菜单: {' | '.join(row_actions[:3])}")

    upload_dialogs = [safe_text(dict(item or {}).get("title") or dict(item or {}).get("text"), 50) for item in list(data.get("upload_dialogs") or [])]
    upload_dialogs = [item for item in upload_dialogs if item]
    if upload_dialogs:
        lines.append(f"上传对话框: {' | '.join(upload_dialogs[:3])}")

    modal_confirmations = [safe_text(dict(item or {}).get("title") or dict(item or {}).get("text"), 50) for item in list(data.get("modal_confirmations") or [])]
    modal_confirmations = [item for item in modal_confirmations if item]
    if modal_confirmations:
        lines.append(f"确认弹窗: {' | '.join(modal_confirmations[:3])}")

    return lines


def seller_central_landmarks(snapshot: dict[str, Any], *, safe_text, limit: int = 8) -> list[str]:
    items: list[str] = []
    for item in list(dict(snapshot or {}).get("sendtoamazon_controls") or []):
        text = safe_text(dict(item or {}).get("label") or dict(item or {}).get("text"), 80)
        if text and text not in items:
            items.append(text)
        if len(items) >= limit:
            return items[:limit]
    for item in seller_central_home_favorite_links(snapshot):
        text = safe_text(dict(item or {}).get("label") or dict(item or {}).get("text"), 80)
        if text and text not in items:
            items.append(text)
        if len(items) >= limit:
            return items[:limit]
    for key in ("favorite_links", "inventory_flows", "top_nav", "side_nav", "upload_dialogs", "modal_confirmations"):
        for item in list(dict(snapshot or {}).get(key) or []):
            text = safe_text(dict(item or {}).get("label") or dict(item or {}).get("title") or dict(item or {}).get("text"), 80)
            if text and text not in items:
                items.append(text)
            if len(items) >= limit:
                return items[:limit]
    return items[:limit]


__all__ = [
    "SELLER_CENTRAL_EXTRACTION_JS",
    "resolve_inventory_search_aid",
    "resolve_modal_confirmation_aid",
    "resolve_row_action_aid",
    "resolve_sendtoamazon_aid",
    "resolve_upload_aid",
    "seller_central_home_favorite_links",
    "seller_central_landmarks",
    "seller_central_summary_lines",
]
