from __future__ import annotations

import time
from typing import Any

from services.browser.browser.shadow_dom import SHADOW_DOM_HELPERS_JS


_TRACKING_READY_TEXT = "输入追踪编码"
_TRACKING_TAB_SELECTOR = '[data-testid="shipment-tracking-tab"]'
_TRACKING_ROW_SELECTOR = "kat-table-row.tracking-id-row"
_TRACKING_INPUT_SELECTOR = '[data-testid="tracking-row-input"]'
_SAVE_BUTTON_TEXT = "保存"
_SHIPPED_SECTION_TEXT = "此货件已完成，其货件状态为"
_SHIPPED_BADGE_TEXT = "已发货"
_FINAL_SUCCESS_NOTICE = "恭喜！创建货件流程完整结束！"
_READY_WAIT_SECONDS = 60
_TAB_WAIT_SECONDS = 10
_COMPLETED_WAIT_SECONDS = 60


def _execute_page_script(driver: Any, script_body: str, *args):
    return driver.execute_script(SHADOW_DOM_HELPERS_JS + script_body, *args)


def _page_has_visible_text(driver: Any, target_text: str) -> bool:
    return bool(
        _execute_page_script(
            driver,
            """
const targetText = String(arguments[0] || '').replace(/\\s+/g, ' ').trim();

function cleanText(value) {
  return String(value || '').replace(/\\s+/g, ' ').trim();
}

function isVisible(el) {
  if (!el) return false;
  if (typeof el.getClientRects === 'function' && el.getClientRects().length > 0) return true;
  return Boolean(el.offsetWidth || el.offsetHeight);
}

if (!targetText) return false;
for (const el of deepQuerySelectorAll('div, span, label, p, b, strong, button, kat-badge, kat-link, h1, h2, h3, h4, h5')) {
  if (!isVisible(el)) continue;
  const text = cleanText(el.innerText || el.textContent || el.getAttribute('label') || '');
  if (text && text.includes(targetText)) return true;
}
return false;
""",
            target_text,
        )
    )


def _tracking_input_ready_visible(driver: Any) -> bool:
    return _page_has_visible_text(driver, _TRACKING_READY_TEXT)


def _shipment_completed_visible(driver: Any, shipment_id: str) -> bool:
    target_shipment_id = str(shipment_id or "").strip()
    if not target_shipment_id:
        return False
    return bool(
        _execute_page_script(
            driver,
            """
const targetShipmentId = String(arguments[0] || '').trim();

function cleanText(value) {
  return String(value || '').replace(/\\s+/g, ' ').trim();
}

function isVisible(el) {
  if (!el) return false;
  if (typeof el.getClientRects === 'function' && el.getClientRects().length > 0) return true;
  return Boolean(el.offsetWidth || el.offsetHeight);
}

function combinedText(root) {
  if (!root) return '';
  return cleanText(root.innerText || root.textContent || '');
}

function hasShippedBadge(root, targetText) {
  if (!root) return false;
  for (const badge of deepQuerySelectorAll('kat-badge', root)) {
    if (!isVisible(badge)) continue;
    const text = cleanText(badge.innerText || badge.textContent || badge.getAttribute('label') || '');
    if (text.includes(targetText)) return true;
  }
  return false;
}

if (!targetShipmentId) return false;
for (const link of deepQuerySelectorAll('[data-testid="spd-tracking-table-track-shipment"], kat-link[data-testid="spd-tracking-table-track-shipment"]')) {
  if (!isVisible(link)) continue;
  const href = String(link.getAttribute('href') || link.href || '');
  if (!href.includes(targetShipmentId)) continue;

  let current = link;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    const text = combinedText(current);
    if (text.includes(arguments[1]) && (text.includes(arguments[2]) || hasShippedBadge(current, arguments[2]))) {
      return true;
    }
    const rootNode = typeof current.getRootNode === 'function' ? current.getRootNode() : null;
    current = current.parentElement || (rootNode && rootNode.host ? rootNode.host : null);
  }
}
return false;
""",
            target_shipment_id,
            _SHIPPED_SECTION_TEXT,
            _SHIPPED_BADGE_TEXT,
        )
    )


def _read_tracking_tabs(driver: Any) -> list[dict[str, Any]]:
    raw_tabs = _execute_page_script(
        driver,
        """
function cleanText(value) {
  return String(value || '').replace(/\\s+/g, ' ').trim();
}

function isVisible(el) {
  if (!el) return false;
  if (typeof el.getClientRects === 'function' && el.getClientRects().length > 0) return true;
  return Boolean(el.offsetWidth || el.offsetHeight);
}

const tabs = [];
for (const tab of deepQuerySelectorAll(arguments[0])) {
  if (!isVisible(tab)) continue;
  const text = cleanText(tab.innerText || tab.textContent || '');
  const shipmentMatch = text.match(/货件编号:\\s*([A-Z0-9]+)/i);
  tabs.push({
    text,
    selected: tab.classList ? tab.classList.contains('selected') : /(^|\\s)selected(\\s|$)/.test(String(tab.className || '')),
    shipment_id: shipmentMatch ? String(shipmentMatch[1] || '').trim() : '',
  });
}
return tabs;
""",
        _TRACKING_TAB_SELECTOR,
    )
    return [dict(item or {}) for item in list(raw_tabs or [])]


def _click_tracking_tab(driver: Any, tab_index: int) -> bool:
    return bool(
        _execute_page_script(
            driver,
            """
const targetIndex = Number(arguments[0]);

function isVisible(el) {
  if (!el) return false;
  if (typeof el.getClientRects === 'function' && el.getClientRects().length > 0) return true;
  return Boolean(el.offsetWidth || el.offsetHeight);
}

function clickElement(el) {
  if (!el) return false;
  try {
    el.scrollIntoView({ block: 'center', inline: 'center' });
  } catch (error) {}
  try {
    el.click();
    return true;
  } catch (error) {}
  try {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    return true;
  } catch (error) {}
  return false;
}

const tabs = Array.from(deepQuerySelectorAll(arguments[1])).filter(isVisible);
if (!(targetIndex >= 0) || targetIndex >= tabs.length) return false;
const target = tabs[targetIndex];
if (target.classList ? target.classList.contains('selected') : /(^|\\s)selected(\\s|$)/.test(String(target.className || ''))) return true;
return clickElement(target);
""",
            int(tab_index),
            _TRACKING_TAB_SELECTOR,
        )
    )


def _read_tracking_rows(driver: Any) -> list[dict[str, str]]:
    raw_rows = _execute_page_script(
        driver,
        """
function cleanText(value) {
  return String(value || '').replace(/\\s+/g, ' ').trim();
}

function isVisible(el) {
  if (!el) return false;
  if (typeof el.getClientRects === 'function' && el.getClientRects().length > 0) return true;
  return Boolean(el.offsetWidth || el.offsetHeight);
}

const rows = [];
for (const row of deepQuerySelectorAll(arguments[0])) {
  if (!isVisible(row)) continue;
  const cells = [];
  for (const cell of deepQuerySelectorAll('kat-table-cell[role="cell"], [role="cell"]', row)) {
    if (deepClosest(cell, arguments[0]) !== row) continue;
    cells.push(cleanText(cell.innerText || cell.textContent || ''));
  }
  rows.push({ tracking_code: String(cells[1] || '').trim() });
}
return rows;
""",
        _TRACKING_ROW_SELECTOR,
    )
    return [dict(item or {}) for item in list(raw_rows or [])]


def _fill_tracking_row_input(driver: Any, row_index: int, tracking_code: str) -> bool:
    return bool(
        _execute_page_script(
            driver,
            """
const targetIndex = Number(arguments[0]);
const targetValue = String(arguments[1] || '').trim();

function isVisible(el) {
  if (!el) return false;
  if (typeof el.getClientRects === 'function' && el.getClientRects().length > 0) return true;
  return Boolean(el.offsetWidth || el.offsetHeight);
}

function setInputValue(input, value) {
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  if (descriptor && typeof descriptor.set === 'function') {
    descriptor.set.call(input, value);
  } else {
    input.value = value;
  }
}

const rows = Array.from(deepQuerySelectorAll(arguments[2])).filter(isVisible);
if (!(targetIndex >= 0) || targetIndex >= rows.length) return false;
const row = rows[targetIndex];
const host =
  deepQuerySelector(arguments[3], row) ||
  deepQuerySelector('kat-input[data-testid="tracking-row-input"]', row);
if (!host) return false;

const input =
  (String(host.tagName || '').toLowerCase() === 'input' ? host : null) ||
  deepQuerySelector('input[part="input"], input', host.shadowRoot || host);
if (!input) return false;

try {
  input.scrollIntoView({ block: 'center', inline: 'center' });
} catch (error) {}
try {
  input.focus();
} catch (error) {}

setInputValue(input, targetValue);
try {
  input.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      composed: true,
      data: targetValue,
      inputType: 'insertText',
    })
  );
} catch (error) {
  try {
    input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true, composed: true }));
  } catch (innerError) {}
}
for (const eventName of ['change', 'blur']) {
  try {
    input.dispatchEvent(new Event(eventName, { bubbles: true, cancelable: true, composed: true }));
  } catch (error) {}
}
return String(input.value || '').trim() === targetValue;
""",
            int(row_index),
            str(tracking_code or "").strip(),
            _TRACKING_ROW_SELECTOR,
            _TRACKING_INPUT_SELECTOR,
        )
    )


def _click_button_by_text(driver: Any, text: str) -> bool:
    return bool(
        _execute_page_script(
            driver,
            """
const targetText = String(arguments[0] || '').replace(/\\s+/g, ' ').trim();

function cleanText(value) {
  return String(value || '').replace(/\\s+/g, ' ').trim();
}

function isVisible(el) {
  if (!el) return false;
  if (typeof el.getClientRects === 'function' && el.getClientRects().length > 0) return true;
  return Boolean(el.offsetWidth || el.offsetHeight);
}

function isDisabled(el) {
  if (!el) return true;
  if (el.disabled) return true;
  if (el.hasAttribute && el.hasAttribute('disabled')) return true;
  return String(el.getAttribute && el.getAttribute('aria-disabled') || '').toLowerCase() === 'true';
}

function clickElement(el) {
  if (!el) return false;
  try {
    el.scrollIntoView({ block: 'center', inline: 'center' });
  } catch (error) {}
  try {
    el.click();
    return true;
  } catch (error) {}
  try {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    return true;
  } catch (error) {}
  return false;
}

for (const selector of ['button', 'kat-button', '[role="button"]']) {
  for (const el of deepQuerySelectorAll(selector)) {
    if (!isVisible(el)) continue;
    if (isDisabled(el)) continue;
    const text = cleanText(el.innerText || el.textContent || el.getAttribute('label') || '');
    if (!text || !text.includes(targetText)) continue;
    if (clickElement(el)) return true;
  }
}
return false;
""",
            text,
        )
    )


def _click_save_button(driver: Any) -> bool:
    return _click_button_by_text(driver, _SAVE_BUTTON_TEXT)


def _wait_for_condition(
    description: str,
    predicate,
    *,
    timeout_seconds: int,
    interval_seconds: float = 0.5,
) -> None:
    deadline = time.time() + max(1, int(timeout_seconds or 0))
    while time.time() < deadline:
        if predicate():
            return
        time.sleep(interval_seconds)
    raise RuntimeError(f"等待{description}超时")


def _wait_for_click(
    description: str,
    clicker,
    *,
    timeout_seconds: int,
    interval_seconds: float = 0.5,
) -> None:
    deadline = time.time() + max(1, int(timeout_seconds or 0))
    while time.time() < deadline:
        if clicker():
            return
        time.sleep(interval_seconds)
    raise RuntimeError(f"等待{description}超时")


def _step_timeout(deadline: float, max_seconds: int, description: str) -> int:
    remaining = deadline - time.time()
    if remaining <= 0:
        raise RuntimeError(f"等待{description}超时")
    return max(1, min(int(max_seconds), int(remaining)))


def probe_tracking_input_ready(session: Any, *, timeout_seconds: int = _READY_WAIT_SECONDS) -> dict[str, Any]:
    deadline = time.time() + max(1, min(int(timeout_seconds or 0), _READY_WAIT_SECONDS))
    while time.time() < deadline:
        if _tracking_input_ready_visible(session.driver):
            return {"ready": True, "notice": _TRACKING_READY_TEXT}
        time.sleep(0.5)
    return {"ready": False, "notice": ""}


def enter_tracking_codes(
    session: Any,
    *,
    timeout_seconds: int = 180,
) -> dict[str, str]:
    driver = session.driver
    deadline = time.time() + max(1, int(timeout_seconds or 180))

    _wait_for_condition(
        "输入追踪编码流程",
        lambda: _tracking_input_ready_visible(driver),
        timeout_seconds=_step_timeout(deadline, _READY_WAIT_SECONDS, "输入追踪编码流程"),
    )
    _wait_for_condition(
        "货件标签页出现",
        lambda: bool(_read_tracking_tabs(driver)),
        timeout_seconds=_step_timeout(deadline, _TAB_WAIT_SECONDS, "货件标签页出现"),
    )

    initial_tabs = _read_tracking_tabs(driver)
    if not initial_tabs:
        raise RuntimeError("等待货件标签页出现超时")
    total_shipments = len(initial_tabs)
    completed_count = 0

    for tab_index in range(total_shipments):
        current_tabs = _read_tracking_tabs(driver)
        if tab_index >= len(current_tabs):
            raise RuntimeError("仍有未完成货件")
        shipment_id = str(current_tabs[tab_index].get("shipment_id") or "").strip()
        if not shipment_id:
            raise RuntimeError("当前货件缺少货件编号")

        _wait_for_click(
            "货件标签页",
            lambda index=tab_index: _click_tracking_tab(driver, index),
            timeout_seconds=_step_timeout(deadline, _TAB_WAIT_SECONDS, "货件标签页"),
        )
        _wait_for_condition(
            "货件详情加载",
            lambda: _shipment_completed_visible(driver, shipment_id) or bool(_read_tracking_rows(driver)),
            timeout_seconds=_step_timeout(deadline, _TAB_WAIT_SECONDS, "货件详情加载"),
        )

        if _shipment_completed_visible(driver, shipment_id):
            completed_count += 1
            continue

        rows = _read_tracking_rows(driver)
        if not rows:
            raise RuntimeError("当前货件未找到追踪编码行")

        for row_index, row in enumerate(rows):
            tracking_code = str(row.get("tracking_code") or "").strip()
            if not tracking_code:
                raise RuntimeError("追踪编码行缺少箱号编码")

            fill_deadline = time.time() + _step_timeout(deadline, _TAB_WAIT_SECONDS, "追踪编码输入框")
            while time.time() < fill_deadline:
                if _fill_tracking_row_input(driver, row_index, tracking_code):
                    break
                time.sleep(0.5)
            else:
                raise RuntimeError("追踪编码输入框不可用")

        _wait_for_click(
            "保存按钮",
            lambda: _click_save_button(driver),
            timeout_seconds=_step_timeout(deadline, _TAB_WAIT_SECONDS, "保存按钮"),
        )
        _wait_for_condition(
            "当前货件已发货",
            lambda: _shipment_completed_visible(driver, shipment_id),
            timeout_seconds=_step_timeout(deadline, _COMPLETED_WAIT_SECONDS, "当前货件已发货"),
            interval_seconds=1.0,
        )
        completed_count += 1

    if completed_count != total_shipments:
        raise RuntimeError("仍有未完成货件")

    return {"notice": _FINAL_SUCCESS_NOTICE}


__all__ = [
    "enter_tracking_codes",
    "probe_tracking_input_ready",
]
