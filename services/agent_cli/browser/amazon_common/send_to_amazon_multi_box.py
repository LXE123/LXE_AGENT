from __future__ import annotations

import os
import time
from typing import Any

from selenium.webdriver.common.keys import Keys

from services.browser.browser.actions import (
    _download_dir_from_path,
    _snapshot_download_dir,
    _wait_for_downloaded_file,
)
from services.browser.browser.shadow_dom import SHADOW_DOM_HELPERS_JS


_MULTI_BOX_RADIO_SELECTOR = 'input[name="cli-input-method"][value="MULTI_BOX_WEBFORM"]'
_STEP1_CONTINUE_SELECTOR = '[data-testid="step1-continue"]'
_PACKING_METHOD_BOX_SELECTOR = '[data-testid="packing-method-box"]'
_PACKING_METHOD_BOX_CONTENT_SELECTOR = '[data-testid="packing-method-box-content"]'
_STANDARD_PACKING_METHOD_TEXT = "标准包装方式"
_PACK_GROUP_CONTROLS_SELECTOR = '[data-testid="pack-group-controls"]'
_BOX_COUNT_INPUT_SELECTOR = 'input[type="number"]'
_DOWNLOAD_FILENAME_SELECTOR = '[data-testid="download-link-filename"]'
_STEP2_UPLOAD_FILE_INPUT_SELECTOR = 'input[type="file"]'
_STEP2_UPLOAD_ERROR_SELECTOR = '[data-testid="pack-group-row-validation-error-message"]'
_STEP2_UPLOAD_ERROR_WITH_SKU_SELECTOR = '[data-testid="inbound-problem-message-with-sku-list"]'
_STEP2_UPLOAD_WARNING_ALERT_SELECTOR = '[data-testid="pack-group-cli-warning-results"]'
_STEP2_UPLOAD_WARNING_SELECTOR = '[data-testid="inbound-problem-message"]'
_STEP2_UPLOAD_SUCCESS_SELECTOR = '[data-testid="pack-group-success-results"]'
_CONFIRM_AND_CONTINUE_SELECTOR = '[data-testid="confirm-and-continue"]'
_WORKFLOW_LOADING_LABEL_SELECTOR = '[data-testid="workflow-loading-label"]'
_STEP_HEADER_TITLE_SELECTOR = 'h4[data-testid="step-header-title"]'
_STEP_HEADER_CHECKMARK_SELECTOR = 'kat-icon[data-testid="header-checkmark"][name="check"]'
_STEP1_SKU_FOOTER_ERROR_ALERT_SELECTOR = 'kat-alert[data-testid="all-sku-footer-error-results"]'
_CONFIRMED_INVENTORY_COMPLETED_NOTICE = "已确认要发送的库存"
_PACK_SINGLE_UNITS_COMPLETED_NOTICE = "已完成包装单件商品步骤"
_STEP2_UPLOAD_VALIDATE_WAIT_SECONDS = 60
_STEP2_UPLOAD_RESULT_WAIT_SECONDS = 60
_STEP2_UPLOAD_ALLOWLISTED_WARNING_MARKERS = (
    "包装箱体积未达到预期的最小体积",
)
_STEP2_UPLOAD_MANUAL_HANDLE_MARKER = "不得超过 40 磅"
_STEP2_UPLOAD_MANUAL_HANDLE_NOTICE = "内含珠宝首饰或钟表的包装箱不得超过 40 磅，无法进入第三阶段，需业务人员手动处理"


def _execute_page_script(driver: Any, script_body: str, *args):
    return driver.execute_script(SHADOW_DOM_HELPERS_JS + script_body, *args)


def _download_dir_for_session(session: Any):
    return _download_dir_from_path(str(getattr(session, "download_path", "") or "").strip())


def _read_download_filename_notice(driver: Any) -> str:
    raw_notice = _execute_page_script(
        driver,
        """
function cleanText(value) {
  return String(value || '').replace(/\\s+/g, ' ').trim();
}

const root = deepQuerySelector(arguments[0]);
if (!root) return '';
return cleanText(root.innerText || root.textContent || '');
""",
        _DOWNLOAD_FILENAME_SELECTOR,
    )
    return str(raw_notice or "").strip()


def _slow_workflow_loading_visible(driver: Any) -> bool:
    return bool(
        _execute_page_script(
            driver,
            """
const root = deepQuerySelector(arguments[0]);
return Boolean(root);
""",
            _WORKFLOW_LOADING_LABEL_SELECTOR,
        )
    )


def _read_completed_step_notice(driver: Any, required_keywords: tuple[str, ...], done_notice: str) -> str:
    raw_notice = _execute_page_script(
        driver,
        """
function cleanText(value) {
  return String(value || '').replace(/\\s+/g, ' ').trim();
}

const titleSelector = String(arguments[0] || '');
const checkmarkSelector = String(arguments[1] || '');
const requiredKeywords = Array.from(arguments[2] || []).map((value) => String(value || '').trim()).filter(Boolean);
const doneNotice = String(arguments[3] || '');
if (!requiredKeywords.length) return '';

for (const title of deepQuerySelectorAll(titleSelector)) {
  const titleText = cleanText(title.innerText || title.textContent || '');
  if (!requiredKeywords.every((keyword) => titleText.includes(keyword))) continue;

  let current = title;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    const rowText = cleanText(current.innerText || current.textContent || '');
    const classText = cleanText(current.getAttribute ? current.getAttribute('class') || '' : '');
    const isHeaderRow = classText.includes('flexRow') || classText.includes('flex-row');
    if (isHeaderRow && requiredKeywords.every((keyword) => rowText.includes(keyword))) {
      const checkmark = deepQuerySelector(checkmarkSelector, current);
      return checkmark ? doneNotice : '';
    }
    const rootNode = typeof current.getRootNode === 'function' ? current.getRootNode() : null;
    current = current.parentElement || (rootNode && rootNode.host ? rootNode.host : null);
  }
}
return '';
""",
        _STEP_HEADER_TITLE_SELECTOR,
        _STEP_HEADER_CHECKMARK_SELECTOR,
        list(required_keywords),
        done_notice,
    )
    return str(raw_notice or "").strip()


def _read_confirmed_inventory_completed_notice(driver: Any) -> str:
    return _read_completed_step_notice(
        driver,
        ("第 1 步", _CONFIRMED_INVENTORY_COMPLETED_NOTICE),
        _CONFIRMED_INVENTORY_COMPLETED_NOTICE,
    )


def _read_pack_single_units_completed_notice(driver: Any) -> str:
    return _read_completed_step_notice(
        driver,
        ("第 1b", "包装单件商品"),
        _PACK_SINGLE_UNITS_COMPLETED_NOTICE,
    )


def _read_step1_sku_footer_error(driver: Any) -> str:
    raw_notice = _execute_page_script(
        driver,
        """
function cleanText(value) {
  return String(value || '').replace(/\\s+/g, ' ').trim();
}

const root = deepQuerySelector(arguments[0]);
if (!root) return '';

const messages = [];
for (const item of deepQuerySelectorAll('.alert-error-list', root)) {
  const problemMessages = deepQuerySelectorAll('[data-testid="inbound-problem-message"]', item);
  if (problemMessages.length) {
    for (const problem of problemMessages) {
      const text = cleanText(problem.innerText || problem.textContent || '');
      if (text) messages.push(text);
    }
    continue;
  }
  const itemText = cleanText(item.innerText || item.textContent || '');
  if (itemText) messages.push(itemText);
}
if (!messages.length) {
  for (const item of deepQuerySelectorAll('[data-testid="inbound-problem-message"]', root)) {
    const text = cleanText(item.innerText || item.textContent || '');
    if (text) messages.push(text);
  }
}
if (!messages.length) {
  const text = cleanText(root.innerText || root.textContent || '');
  if (text) messages.push(text);
}
return Array.from(new Set(messages)).join('；');
""",
        _STEP1_SKU_FOOTER_ERROR_ALERT_SELECTOR,
    )
    message = str(raw_notice or "").strip()
    if not message:
        return ""
    return f"第一阶段库存确认失败: {message}"


def _has_multi_box_radio(driver: Any) -> bool:
    return bool(
        _execute_page_script(
            driver,
            """
return Boolean(deepQuerySelector(arguments[0]));
""",
            _MULTI_BOX_RADIO_SELECTOR,
        )
    )


def _has_pack_group_controls(driver: Any) -> bool:
    return bool(
        _execute_page_script(
            driver,
            """
return Boolean(deepQuerySelector(arguments[0]));
""",
            _PACK_GROUP_CONTROLS_SELECTOR,
        )
    )


def _read_packing_method_box_state(driver: Any) -> str:
    raw_state = _execute_page_script(
        driver,
        """
const boxes = deepQuerySelectorAll(arguments[0]);
const targetText = String(arguments[1] || '');
const root = boxes.find((box) => String(box.innerText || box.textContent || '').includes(targetText));
if (!root) return 'missing';

const classText = String(root.getAttribute('class') || '');
const classes = new Set(classText.split(/\\s+/).filter(Boolean));
if (classes.has('not-selected')) return 'not_selected';

const checkmark = deepQuerySelector('kat-icon[name="checkmark"], .checkmark-icon', root);
if (classes.has('selected') || checkmark) return 'selected';
return 'present';
""",
        _PACKING_METHOD_BOX_SELECTOR,
        _STANDARD_PACKING_METHOD_TEXT,
    )
    return str(raw_state or "").strip()


def _click_packing_method_box_if_present(driver: Any) -> bool:
    return bool(
        _execute_page_script(
            driver,
            """
const boxes = deepQuerySelectorAll(arguments[0]);
const targetText = String(arguments[2] || '');
const root = boxes.find((box) => String(box.innerText || box.textContent || '').includes(targetText));
if (!root) return false;
const target = deepQuerySelector(arguments[1], root) || root;

function dispatchPointerOrMouseEvent(el, eventName) {
  const EventClass = eventName.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
  try {
    el.dispatchEvent(new EventClass(eventName, {
      bubbles: true,
      cancelable: true,
      view: window,
    }));
    return true;
  } catch (error) {
    try {
      el.dispatchEvent(new MouseEvent(eventName, {
        bubbles: true,
        cancelable: true,
        view: window,
      }));
      return true;
    } catch (innerError) {}
  }
  return false;
}

try {
  target.scrollIntoView({ block: 'center', inline: 'center' });
} catch (error) {}
try {
  if (target.focus) target.focus();
} catch (error) {}

let dispatched = false;
for (const eventName of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
  dispatched = dispatchPointerOrMouseEvent(target, eventName) || dispatched;
}
try {
  target.click();
  return true;
} catch (error) {}
return dispatched;
""",
            _PACKING_METHOD_BOX_SELECTOR,
            _PACKING_METHOD_BOX_CONTENT_SELECTOR,
            _STANDARD_PACKING_METHOD_TEXT,
        )
    )


def _packing_method_box_is_complete(driver: Any) -> bool:
    return _has_pack_group_controls(driver) and _read_packing_method_box_state(driver) == "selected"


def _wait_click_packing_method_box_or_skip(driver: Any, *, timeout_seconds: float = 5.0) -> bool:
    deadline = time.time() + max(0.0, float(timeout_seconds or 0))
    click_count = 0

    while True:
        if _packing_method_box_is_complete(driver):
            return True

        state = _read_packing_method_box_state(driver)
        if state == "not_selected" and click_count < 2:
            click_count += 1
            _click_packing_method_box_if_present(driver)
            time.sleep(0.5)
            if _packing_method_box_is_complete(driver):
                return True
            continue

        if state == "not_selected" and click_count >= 2:
            return False

        if time.time() >= deadline:
            return False

        time.sleep(0.5)


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
    const text = cleanText(el.innerText || el.textContent || el.getAttribute('label') || '');
    if (!text || !text.includes(targetText) || !isVisible(el)) continue;
    if (clickElement(el)) return true;
  }
}
return false;
""",
            text,
        )
    )


def _click_first_matching(driver: Any, selectors: tuple[str, ...]) -> bool:
    return bool(
        _execute_page_script(
            driver,
            """
const selectors = Array.isArray(arguments[0]) ? arguments[0] : [];

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

for (const selector of selectors) {
  const el = deepQuerySelector(String(selector || ''));
  if (el && clickElement(el)) return true;
}
return false;
""",
            list(selectors),
        )
    )


def _resolve_first_matching_element(driver: Any, selectors: tuple[str, ...]):
    return _execute_page_script(
        driver,
        """
const selectors = Array.isArray(arguments[0]) ? arguments[0] : [];
for (const selector of selectors) {
  const el = deepQuerySelector(String(selector || ''));
  if (el) return el;
}
return null;
""",
        list(selectors),
    )


def _click_pack_single_units_button(driver: Any) -> bool:
    if _click_first_matching(driver, (_STEP1_CONTINUE_SELECTOR,)):
        return True
    return _click_button_by_text(driver, "包装单件商品")


def _click_confirm_button(driver: Any) -> bool:
    return _click_button_by_text(driver, "确认")


def _click_generate_excel_button(driver: Any) -> bool:
    return _click_button_by_text(driver, "生成 Excel 文件")


def _click_upload_and_validate_button(driver: Any) -> bool:
    return _click_button_by_text(driver, "上传并验证文件")


def _click_confirm_and_continue_button(driver: Any) -> bool:
    if _click_first_matching(driver, (_CONFIRM_AND_CONTINUE_SELECTOR,)):
        return True
    return _click_button_by_text(driver, "确认并继续")


def _click_multi_box_radio(driver: Any) -> bool:
    return bool(
        _execute_page_script(
            driver,
            """
const radio = deepQuerySelector(arguments[0]);
if (!radio) return false;
try {
  radio.scrollIntoView({ block: 'center', inline: 'center' });
} catch (error) {}
try {
  radio.click();
} catch (error) {
  radio.checked = true;
}
try {
  radio.checked = true;
} catch (error) {}
for (const eventName of ['input', 'change', 'click']) {
  try {
    radio.dispatchEvent(new Event(eventName, { bubbles: true, cancelable: true }));
  } catch (error) {}
}
return true;
""",
            _MULTI_BOX_RADIO_SELECTOR,
        )
    )


def _open_input_method_dropdown(driver: Any) -> bool:
    return bool(
        _execute_page_script(
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
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  } catch (error) {}
  return false;
}

for (const header of deepQuerySelectorAll('.kat-select-container .select-header, .kat-select-container [part="dropdown-header"]')) {
  const text = cleanText(header.innerText || header.textContent || '');
  if (!isVisible(header)) continue;
  if (text.includes('通过 Web 表单输入') || !text) {
    if (clickElement(header)) return true;
  }
}
return false;
""",
        )
    )


def _select_excel_upload_option(driver: Any) -> bool:
    return bool(
        _execute_page_script(
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
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  } catch (error) {}
  return false;
}

const direct = deepQuerySelector('kat-option[value="FILE_UPLOAD"]');
if (direct && clickElement(direct)) return true;

for (const option of deepQuerySelectorAll('kat-option, [role="option"]')) {
  const text = cleanText(option.innerText || option.textContent || '');
  if (!text.includes('上传 Excel 文件 (.xls)') || !isVisible(option)) continue;
  if (clickElement(option)) return true;
}
return false;
""",
        )
    )


def _set_box_count(driver: Any, box_count: int) -> bool:
    input_element = _resolve_first_matching_element(driver, (_BOX_COUNT_INPUT_SELECTOR,))
    if input_element is None:
        return False

    input_element.click()
    input_element.send_keys(Keys.CONTROL, "a")
    input_element.send_keys(Keys.BACKSPACE)
    input_element.send_keys(str(int(box_count or 0)))
    input_element.send_keys(Keys.TAB)
    return True


def _click_download_filename(driver: Any) -> bool:
    return bool(
        _execute_page_script(
            driver,
            """
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
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  } catch (error) {}
  return false;
}

let current = deepQuerySelector(arguments[0]);
for (let index = 0; index < 8 && current; index += 1) {
  if (clickElement(current)) return true;
  const rootNode = typeof current.getRootNode === 'function' ? current.getRootNode() : null;
  current = current.parentElement || (rootNode && rootNode.host ? rootNode.host : null);
}
return false;
""",
            _DOWNLOAD_FILENAME_SELECTOR,
        )
    )


def _read_step2_upload_result(driver: Any) -> dict[str, str]:
    raw_result = _execute_page_script(
        driver,
        """
function cleanText(value) {
  return String(value || '').replace(/\\s+/g, ' ').trim();
}

const warningAlert = deepQuerySelector(arguments[2]);
if (warningAlert) {
  const rows = [];
  for (const row of deepQuerySelectorAll('.alert-error-list', warningAlert)) {
    const rowText = cleanText(row.innerText || row.textContent || '');
    if (rowText) rows.push(rowText);
  }
  const text = rows.length ? rows.join('；') : cleanText(warningAlert.innerText || warningAlert.textContent || '');
  if (text) return { status: 'warning', notice: text };
}

const warningRoot = deepQuerySelector(arguments[3]);
if (warningRoot) {
  const text = cleanText(warningRoot.innerText || warningRoot.textContent || '');
  if (text) return { status: 'warning', notice: text };
}

for (const selector of [arguments[0], arguments[1]]) {
  const root = deepQuerySelector(selector);
  if (!root) continue;
  const text = cleanText(root.innerText || root.textContent || '');
  if (text) return { status: 'error', notice: text };
}

const successRoot = deepQuerySelector(arguments[4]);
if (successRoot) {
  const text = cleanText(successRoot.innerText || successRoot.textContent || '');
  if (text) return { status: 'success', notice: text };
}

return { status: '', notice: '' };
    """,
        _STEP2_UPLOAD_ERROR_SELECTOR,
        _STEP2_UPLOAD_ERROR_WITH_SKU_SELECTOR,
        _STEP2_UPLOAD_WARNING_ALERT_SELECTOR,
        _STEP2_UPLOAD_WARNING_SELECTOR,
        _STEP2_UPLOAD_SUCCESS_SELECTOR,
    )
    result = dict(raw_result or {})
    return {
        "status": str(result.get("status") or "").strip(),
        "notice": str(result.get("notice") or "").strip(),
    }


def _is_allowlisted_step2_warning(notice: str) -> bool:
    safe_notice = str(notice or "").strip()
    if not safe_notice:
        return False
    return any(marker in safe_notice for marker in _STEP2_UPLOAD_ALLOWLISTED_WARNING_MARKERS)


def _normalize_step2_upload_notice(notice: str) -> str:
    safe_notice = str(notice or "").strip()
    if not safe_notice:
        return ""
    if _STEP2_UPLOAD_MANUAL_HANDLE_MARKER in safe_notice:
        return _STEP2_UPLOAD_MANUAL_HANDLE_NOTICE
    return safe_notice


def _wait_for_click(step_name: str, clicker, *, timeout_seconds: int, interval_seconds: float = 0.5) -> None:
    deadline = time.time() + max(1, int(timeout_seconds or 0))
    while time.time() < deadline:
        if clicker():
            return
        time.sleep(max(0.2, float(interval_seconds or 0.5)))
    raise RuntimeError(f"等待{step_name}超时")


def _wait_for_notice(reader, *, timeout_seconds: int, interval_seconds: float = 0.5) -> str:
    deadline = time.time() + max(1, int(timeout_seconds or 0))
    while time.time() < deadline:
        notice = str(reader() or "").strip()
        if notice:
            return notice
        time.sleep(max(0.2, float(interval_seconds or 0.5)))
    return ""


def probe_multi_box_ready(session: Any, *, timeout_seconds: int = 10) -> dict[str, Any]:
    deadline = time.time() + max(1, min(int(timeout_seconds or 0), 10))
    if _has_multi_box_radio(session.driver):
        return {
            "ready": True,
            "notice": "",
        }

    _wait_click_packing_method_box_or_skip(
        session.driver,
        timeout_seconds=min(5.0, max(0.0, deadline - time.time())),
    )

    while time.time() < deadline:
        if _has_multi_box_radio(session.driver):
            return {
                "ready": True,
                "notice": "",
            }
        time.sleep(0.5)
    return {
        "ready": False,
        "notice": "",
    }


def advance_to_multi_box_entry(session: Any, *, timeout_seconds: int = 60) -> dict[str, Any]:
    deadline = time.time() + max(10, int(timeout_seconds or 0))
    clicked_continue = False
    clicked_at: float | None = None

    while time.time() < deadline:
        notice = _read_confirmed_inventory_completed_notice(session.driver)
        if notice:
            return {
                "ready": True,
                "notice": notice,
            }

        if clicked_at is not None and time.time() - clicked_at >= 10.0:
            error_notice = _read_step1_sku_footer_error(session.driver)
            if error_notice:
                raise RuntimeError(error_notice)

        if not clicked_continue and _click_pack_single_units_button(session.driver):
            clicked_continue = True
            clicked_at = time.time()
            time.sleep(1.0)
            continue

        time.sleep(0.5)

    raise RuntimeError("等待第 1 步库存确认完成超时")


def generate_multi_box_excel(session: Any, box_count: int, *, timeout_seconds: int = 60) -> dict[str, Any]:
    safe_box_count = int(box_count or 0)
    if safe_box_count <= 0:
        raise RuntimeError(f"箱数必须大于 0: {box_count}")

    packing_ready = _wait_click_packing_method_box_or_skip(session.driver, timeout_seconds=5.0)

    if not _has_multi_box_radio(session.driver):
        if not packing_ready:
            raise RuntimeError("标准包装方式卡片点击后仍未选中")
        raise RuntimeError("当前页面未进入多包装箱流程")

    _wait_for_click("需要多个包装箱单选框", lambda: _click_multi_box_radio(session.driver), timeout_seconds=timeout_seconds)
    time.sleep(0.5)

    _wait_for_click("确认按钮", lambda: _click_confirm_button(session.driver), timeout_seconds=timeout_seconds)
    time.sleep(1.0)

    _wait_for_click("输入方式下拉框", lambda: _open_input_method_dropdown(session.driver), timeout_seconds=timeout_seconds)
    time.sleep(0.5)

    _wait_for_click("Excel 输入方式选项", lambda: _select_excel_upload_option(session.driver), timeout_seconds=timeout_seconds)
    time.sleep(0.5)

    _wait_for_click(
        "包装箱数量输入框",
        lambda: _set_box_count(session.driver, safe_box_count),
        timeout_seconds=timeout_seconds,
    )
    time.sleep(0.5)

    _wait_for_click("生成 Excel 文件按钮", lambda: _click_generate_excel_button(session.driver), timeout_seconds=timeout_seconds)

    notice = _wait_for_notice(
        lambda: _read_download_filename_notice(session.driver),
        timeout_seconds=timeout_seconds,
        interval_seconds=1.0,
    )
    if not notice:
        raise RuntimeError("等待下载文件名出现超时")
    return {"notice": notice}


def download_generated_multi_box_template(session: Any, *, timeout_seconds: int = 60) -> dict[str, Any]:
    download_dir = _download_dir_for_session(session)
    before_files = _snapshot_download_dir(download_dir)
    deadline = time.time() + max(10, int(timeout_seconds or 0))

    while time.time() < deadline:
        if _click_download_filename(session.driver):
            downloaded_file = _wait_for_downloaded_file(
                download_dir,
                before_files=before_files,
                timeout_seconds=max(10, int(timeout_seconds or 0)),
            )
            if downloaded_file is None:
                raise RuntimeError("step2 模板下载未在超时时间内确认落盘")
            return {"template_path": str(downloaded_file)}
        time.sleep(0.5)

    raise RuntimeError("等待 step2 模板下载入口超时")


def upload_filled_multi_box_excel(session: Any, filled_template_path: str, *, timeout_seconds: int = 60) -> dict[str, Any]:
    safe_path = str(filled_template_path or "").strip()
    if not safe_path:
        raise RuntimeError("filled_template_path 不能为空")
    if not os.path.isfile(safe_path):
        raise RuntimeError(f"已填写 step2 文件不存在: {safe_path}")

    input_deadline = time.time() + max(10, int(timeout_seconds or 0))
    file_input = None
    while time.time() < input_deadline:
        file_input = _resolve_first_matching_element(session.driver, (_STEP2_UPLOAD_FILE_INPUT_SELECTOR,))
        if file_input is not None:
            break
        time.sleep(0.5)
    if file_input is None:
        raise RuntimeError("等待 step2 上传控件出现超时")

    element_type = str(file_input.get_attribute("type") or "").strip().lower()
    if str(file_input.tag_name or "").strip().lower() != "input" or element_type != "file":
        raise RuntimeError("upload_file requires input[type=file]")

    file_input.send_keys(safe_path)
    time.sleep(1.0)

    click_deadline = time.time() + max(_STEP2_UPLOAD_VALIDATE_WAIT_SECONDS, int(timeout_seconds or 0))
    while time.time() < click_deadline:
        current = _read_step2_upload_result(session.driver)
        current["notice"] = _normalize_step2_upload_notice(str(current.get("notice") or "").strip())
        if str(current.get("status") or "").strip().lower() == "warning":
            if _is_allowlisted_step2_warning(str(current.get("notice") or "").strip()):
                return {
                    "status": "warning",
                    "notice": str(current.get("notice") or "").strip(),
                }
            return {
                "status": "error",
                "notice": str(current.get("notice") or "").strip(),
            }
        if current.get("status"):
            return current
        if _click_upload_and_validate_button(session.driver):
            time.sleep(1.0)
            break
        time.sleep(0.5)

    result_deadline = time.time() + max(_STEP2_UPLOAD_RESULT_WAIT_SECONDS, int(timeout_seconds or 0))
    while time.time() < result_deadline:
        current = _read_step2_upload_result(session.driver)
        current["notice"] = _normalize_step2_upload_notice(str(current.get("notice") or "").strip())
        if str(current.get("status") or "").strip().lower() == "warning":
            if _is_allowlisted_step2_warning(str(current.get("notice") or "").strip()):
                return {
                    "status": "warning",
                    "notice": str(current.get("notice") or "").strip(),
                }
            return {
                "status": "error",
                "notice": str(current.get("notice") or "").strip(),
            }
        if current.get("status"):
            return current
        time.sleep(1.0)

    raise RuntimeError("等待 step2 上传结果超时")


def confirm_and_continue_to_own_carrier(session: Any, *, timeout_seconds: int = 70) -> dict[str, Any]:
    remaining_budget = float(max(70, int(timeout_seconds or 0)))
    clicked = False

    while remaining_budget > 0:
        loop_started = time.time()
        notice = _read_pack_single_units_completed_notice(session.driver)
        if notice:
            return {"notice": notice}
        if not clicked and _click_confirm_and_continue_button(session.driver):
            clicked = True
            time.sleep(1.0)
        else:
            time.sleep(1.0)
        elapsed = max(0.0, float(time.time() - loop_started))
        if not _slow_workflow_loading_visible(session.driver):
            remaining_budget -= elapsed

    raise RuntimeError("等待第 1b 步包装单件商品完成超时")


__all__ = [
    "advance_to_multi_box_entry",
    "confirm_and_continue_to_own_carrier",
    "download_generated_multi_box_template",
    "generate_multi_box_excel",
    "probe_multi_box_ready",
    "upload_filled_multi_box_excel",
]
