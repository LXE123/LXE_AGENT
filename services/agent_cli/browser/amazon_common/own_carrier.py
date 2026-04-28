from __future__ import annotations

import re
import time
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from services.browser.browser.shadow_dom import SHADOW_DOM_HELPERS_JS


_OWN_CARRIER_SELECTORS = (
    '[data-testid="own-carrier-box"]',
    'kat-box[data-testid="own-carrier-box"]',
    '[data-testid="own-carrier-box-body"]',
)
_DIALOG_SELECTOR = ".dialog"
_DELIVERY_WINDOW_LINK_SELECTOR = '[data-testid="arrival-edit-delivery-window-link"]'
_PLACEMENT_GROUP_SELECTED_ICON_SELECTOR = '.placement-group-tile-selected-icon'
_AMAZON_OPERATIONS_CENTER_TITLE = "亚马逊运营中心"
_AMAZON_OPERATIONS_CENTER_READY_NOTICE = "已进入亚马逊运营中心步骤"
_DATE_INPUT_SELECTOR = 'input[type="text"]'
_CALENDAR_SELECTOR = ".calendar"
_CALENDAR_MONTH_SELECTOR = ".cal-month"
_CALENDAR_PREV_SELECTOR = '[part="calendar-prev-month"]'
_CALENDAR_NEXT_SELECTOR = '[part="calendar-next-month"]'
_CONTINUE_INPUT_TRACKING_TEXT = "继续输入追踪详情"
_TRACKING_INPUT_TEXT = "输入追踪编码"
_FINAL_SUCCESS_NOTICE = "恭喜第三步完成，现在需要输入追踪编码，请运行第四阶段脚本"
_RETURN_TO_STEP2_BUTTON_TEXT = "创建货件并稍后包装"
_RETURN_TO_STEP2_NOTICE = "亚马逊店铺页面店铺出现bug，已返回第二步开头，请执行第二阶段CLI"
_SHIPMENT_SUMMARY_SELECTOR = '[data-testid="shipment-summary"]'
_SHIPMENT_NAME_SELECTOR = '[data-testid="shipment-name"]'
_SHIPMENT_ID_SELECTOR = '[data-testid="shipment-id"]'
_SHIPMENT_TRACKING_ID_SELECTOR = '[data-testid="purchase-order-id"]'
_SHIPMENT_SEND_TO_ADDRESS_SELECTOR = '[data-testid="send-to-address"]'

_MONTH_NAME_TO_NUMBER = {
    "一月": 1,
    "二月": 2,
    "三月": 3,
    "四月": 4,
    "五月": 5,
    "六月": 6,
    "七月": 7,
    "八月": 8,
    "九月": 9,
    "十月": 10,
    "十一月": 11,
    "十二月": 12,
}


class _ReturnedToStep2Start(RuntimeError):
    pass


class _OwnCarrierWorkflowError(RuntimeError):
    def __init__(self, message: str, *, shipment_summary_excel_path: str = "") -> None:
        super().__init__(str(message or "").strip())
        self.shipment_summary_excel_path = str(shipment_summary_excel_path or "").strip()


def _execute_page_script(driver: Any, script_body: str, *args):
    return driver.execute_script(SHADOW_DOM_HELPERS_JS + script_body, *args)


def _read_selector_text(driver: Any, selector: str) -> str:
    raw_text = _execute_page_script(
        driver,
        """
function cleanText(value) {
  return String(value || '').replace(/\\s+/g, ' ').trim();
}

const root = deepQuerySelector(arguments[0]);
if (!root) return '';
return cleanText(root.innerText || root.textContent || '');
""",
        selector,
    )
    return str(raw_text or "").strip()


def _require_openpyxl_workbook():
    try:
        from openpyxl import Workbook
    except Exception as exc:
        raise RuntimeError("缺少 openpyxl 依赖，无法生成货件摘要 Excel") from exc
    return Workbook


def _has_selector(driver: Any, selector: str) -> bool:
    return bool(
        _execute_page_script(
            driver,
            """
return Boolean(deepQuerySelector(arguments[0]));
""",
            selector,
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
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
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


def _extract_labeled_value(text: str, label: str) -> str:
    safe_text = str(text or "").strip()
    safe_label = str(label or "").strip()
    if not safe_text or not safe_label:
        return safe_text
    for separator in ("：", ":"):
        prefix = f"{safe_label}{separator}"
        if safe_text.startswith(prefix):
            return safe_text[len(prefix):].strip()
    return safe_text


def _collect_shipment_summaries(driver: Any) -> list[dict[str, str]]:
    payload = _execute_page_script(
        driver,
        """
function cleanText(value) {
  return String(value || '').replace(/\\s+/g, ' ').trim();
}

function readWithin(root, selector) {
  if (!root) return '';
  const element = deepQuerySelector(selector, root);
  if (!element) return '';
  return cleanText(element.innerText || element.textContent || '');
}

const roots = Array.from(deepQuerySelectorAll(arguments[0]) || []);
return roots.map((root) => ({
  shipment_name: readWithin(root, arguments[1]),
  shipment_id: readWithin(root, arguments[2]),
  shipment_tracking_id: readWithin(root, arguments[3]),
  send_to_address: readWithin(root, arguments[4]),
}));
""",
        _SHIPMENT_SUMMARY_SELECTOR,
        _SHIPMENT_NAME_SELECTOR,
        _SHIPMENT_ID_SELECTOR,
        _SHIPMENT_TRACKING_ID_SELECTOR,
        _SHIPMENT_SEND_TO_ADDRESS_SELECTOR,
    )
    if not isinstance(payload, list) or not payload:
        raise RuntimeError("未找到货件摘要区域 shipment-summary")

    summaries: list[dict[str, str]] = []
    for index, item in enumerate(payload, start=1):
        row = dict(item or {})
        summary = {
            "shipment_name": _extract_labeled_value(str(row.get("shipment_name") or "").strip(), "货件名称"),
            "shipment_id": _extract_labeled_value(str(row.get("shipment_id") or "").strip(), "货件编号"),
            "shipment_tracking_id": _extract_labeled_value(
                str(row.get("shipment_tracking_id") or "").strip(),
                "货件追踪编号",
            ),
            "send_to_address": _extract_labeled_value(
                str(row.get("send_to_address") or "").strip(),
                "收货地址",
            ),
        }
        missing = [key for key, value in summary.items() if not str(value or "").strip()]
        if missing:
            raise RuntimeError(f"第{index}个货件摘要字段缺失: {', '.join(missing)}")
        summaries.append(summary)
    return summaries


def _sanitize_excel_filename(raw_name: str) -> str:
    safe_name = re.sub(r'[<>:"/\\\\|?*\\x00-\\x1F]+', "_", str(raw_name or "").strip())
    safe_name = safe_name.strip(" .")
    return safe_name or f"shipment-summary-{int(time.time())}"


def _reserve_output_file(directory: Path, filename: str) -> Path:
    target = directory / filename
    if not target.exists():
        return target
    stem = target.stem
    suffix = target.suffix
    for index in range(1, 1000):
        candidate = directory / f"{stem}-{index}{suffix}"
        if not candidate.exists():
            return candidate
    raise RuntimeError(f"无法为货件摘要 Excel 预留文件名: {target}")


def _write_shipment_summary_excel(
    output_dir: Path,
    summaries: list[dict[str, str]],
    *,
    consignment_no: str = "",
) -> str:
    Workbook = _require_openpyxl_workbook()
    safe_output_dir = Path(output_dir).expanduser().resolve()
    safe_output_dir.mkdir(parents=True, exist_ok=True)
    safe_consignment_no = str(consignment_no or "").strip()
    file_stub = (
        f"shipment-summary-{safe_consignment_no}"
        if safe_consignment_no
        else f"shipment-summary-{int(time.time())}"
    )
    excel_path = _reserve_output_file(
        safe_output_dir,
        f"{_sanitize_excel_filename(file_stub)}.xlsx",
    )

    workbook = Workbook()
    worksheet = workbook.active
    worksheet.title = "货件摘要"
    headers = ("序号", "货件名称", "货件编号", "货件追踪编号", "收货地址")
    for column_index, header in enumerate(headers, start=1):
        worksheet.cell(row=1, column=column_index, value=header)
    for row_index, summary in enumerate(list(summaries or []), start=2):
        worksheet.cell(row=row_index, column=1, value=row_index - 1)
        worksheet.cell(row=row_index, column=2, value=str(summary.get("shipment_name") or "").strip())
        worksheet.cell(row=row_index, column=3, value=str(summary.get("shipment_id") or "").strip())
        worksheet.cell(row=row_index, column=4, value=str(summary.get("shipment_tracking_id") or "").strip())
        worksheet.cell(row=row_index, column=5, value=str(summary.get("send_to_address") or "").strip())
    worksheet.column_dimensions["A"].width = 10
    worksheet.column_dimensions["B"].width = 36
    worksheet.column_dimensions["C"].width = 24
    worksheet.column_dimensions["D"].width = 24
    worksheet.column_dimensions["E"].width = 96

    try:
        workbook.save(excel_path)
    except Exception as exc:
        raise RuntimeError(f"保存货件摘要 Excel 失败: {exc}") from exc
    return str(excel_path)


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
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
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


def _click_select_header(
    driver: Any,
    *,
    index: int | None = None,
) -> bool:
    return bool(
        _execute_page_script(
            driver,
            """
const targetIndex = Number.isInteger(arguments[0]) ? arguments[0] : null;

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

const headers = Array.from(
  deepQuerySelectorAll('.select-header[part="dropdown-header"]')
).filter(isVisible);

if (targetIndex !== null && targetIndex >= 0 && targetIndex < headers.length) {
  return clickElement(headers[targetIndex]);
}
return false;
""",
            index,
        )
    )


def _select_option_by_text(driver: Any, text: str) -> bool:
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
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  } catch (error) {}
  return false;
}

// Read text from element, including shadow DOM content
function readOptionText(el) {
  // 1. Try light DOM text first
  const lightText = cleanText(el.innerText || el.textContent || '');
  if (lightText) return lightText;
  // 2. Penetrate into shadowRoot to read rendered text
  if (el.shadowRoot) {
    const shadowText = cleanText(el.shadowRoot.innerText || el.shadowRoot.textContent || '');
    if (shadowText) return shadowText;
  }
  // 3. Fall back to value / label attributes
  return cleanText(el.getAttribute('value') || el.getAttribute('label') || '');
}

for (const selector of ['kat-option', '[role="option"]']) {
  for (const el of deepQuerySelectorAll(selector)) {
    const text = readOptionText(el);
    if (!text || !text.includes(targetText) || !isVisible(el)) continue;
    if (clickElement(el)) return true;
  }
}
return false;
""",
            text,
        )
    )


def _click_own_carrier_entry(driver: Any) -> bool:
    return _click_first_matching(driver, _OWN_CARRIER_SELECTORS)


def _dialog_visible(driver: Any) -> bool:
    return _has_selector(driver, _DIALOG_SELECTOR)


def _click_confirm_modal(driver: Any) -> bool:
    return _click_button_by_text(driver, "Confirm")


def _delivery_window_link_visible(driver: Any) -> bool:
    return _has_selector(driver, _DELIVERY_WINDOW_LINK_SELECTOR)


def _amazon_operations_center_selected(driver: Any) -> bool:
    return bool(
        _execute_page_script(
            driver,
            """
function cleanText(value) {
  return String(value || '').replace(/\\s+/g, ' ').trim();
}

const selectedIconSelector = String(arguments[0] || '');
const expectedTitle = cleanText(arguments[1]);
for (const icon of deepQuerySelectorAll(selectedIconSelector)) {
  let current = icon;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    const title = deepQuerySelector('h5', current);
    const text = cleanText(title?.innerText || title?.textContent || '');
    if (text === expectedTitle) {
      return true;
    }
    const rootNode = typeof current.getRootNode === 'function' ? current.getRootNode() : null;
    current = current.parentElement || (rootNode && rootNode.host ? rootNode.host : null);
  }
}
return false;
""",
            _PLACEMENT_GROUP_SELECTED_ICON_SELECTOR,
            _AMAZON_OPERATIONS_CENTER_TITLE,
        )
    )


def _date_picker_visible(driver: Any) -> bool:
    return _delivery_window_link_visible(driver) or _has_selector(driver, _CALENDAR_SELECTOR)


def _calendar_visible(driver: Any) -> bool:
    return _has_selector(driver, _CALENDAR_SELECTOR)


def _click_date_input(driver: Any) -> bool:
    return _click_first_matching(driver, (_DELIVERY_WINDOW_LINK_SELECTOR, _DATE_INPUT_SELECTOR))


def _click_update_button(driver: Any) -> bool:
    return _click_button_by_text(driver, "更新")


def _open_carrier_dropdown(driver: Any) -> bool:
    return _click_select_header(driver, index=1)


def _select_other_carrier(driver: Any) -> bool:
    return _select_option_by_text(driver, "其他")


def _open_transport_mode_dropdown(driver: Any) -> bool:
    return _click_select_header(driver, index=2)


def _select_transport_mode_option(driver: Any, option_text: str) -> bool:
    return _select_option_by_text(driver, option_text)


def _click_accept_fees_button(driver: Any) -> bool:
    return _click_button_by_text(driver, "接受费用并确认发货")


def _click_continue_input_tracking_button(driver: Any) -> bool:
    return _click_button_by_text(driver, _CONTINUE_INPUT_TRACKING_TEXT)


def _button_text_visible(driver: Any, text: str) -> bool:
    return bool(
        _execute_page_script(
            driver,
            """
const targetText = String(arguments[0] || '').replace(/\\s+/g, ' ').trim();

function cleanText(value) {
  return String(value || '').replace(/\\s+/g, ' ').trim();
}

for (const selector of ['button', 'kat-button', '[role="button"]']) {
  for (const el of deepQuerySelectorAll(selector)) {
    const text = cleanText(el.innerText || el.textContent || el.getAttribute('label') || '');
    if (text.includes(targetText)) return true;
  }
}
return false;
""",
            text,
        )
    )


def _continue_input_tracking_visible(driver: Any) -> bool:
    return _button_text_visible(driver, _CONTINUE_INPUT_TRACKING_TEXT)


def _tracking_input_visible(driver: Any) -> bool:
    return _button_text_visible(driver, _TRACKING_INPUT_TEXT) or bool(
        _execute_page_script(
            driver,
            """
const targetText = String(arguments[0] || '').replace(/\\s+/g, ' ').trim();

function cleanText(value) {
  return String(value || '').replace(/\\s+/g, ' ').trim();
}

for (const el of deepQuerySelectorAll('div, span, label, kat-text, p')) {
  const text = cleanText(el.innerText || el.textContent || '');
  if (text.includes(targetText)) return true;
}
return false;
""",
            _TRACKING_INPUT_TEXT,
        )
    )


def _return_to_step2_start_visible(driver: Any) -> bool:
    return _button_text_visible(driver, _RETURN_TO_STEP2_BUTTON_TEXT)


def _raise_if_returned_to_step2_start(driver: Any | None) -> None:
    if driver is None or not hasattr(driver, "execute_script"):
        return
    if _return_to_step2_start_visible(driver):
        raise _ReturnedToStep2Start(_RETURN_TO_STEP2_NOTICE)


def _read_calendar_month_label(driver: Any) -> str:
    return _read_selector_text(driver, _CALENDAR_MONTH_SELECTOR)


def _click_calendar_prev_month(driver: Any) -> bool:
    return _click_first_matching(driver, (_CALENDAR_PREV_SELECTOR,))


def _click_calendar_next_month(driver: Any) -> bool:
    return _click_first_matching(driver, (_CALENDAR_NEXT_SELECTOR,))


def _click_calendar_day(driver: Any, target_date: date) -> bool:
    label = f"{target_date.year}年{target_date.month}月{target_date.day}日"
    return bool(
        _execute_page_script(
            driver,
            """
const labels = Array.isArray(arguments[0]) ? arguments[0] : [];

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

const expected = new Set(labels.map((item) => String(item || '').trim()).filter(Boolean));
for (const button of deepQuerySelectorAll('button[aria-label]')) {
  const label = String(button.getAttribute('aria-label') || '').trim();
  if (!expected.has(label)) continue;
  if (clickElement(button)) return true;
}
return false;
""",
            [label, f"{label}. Selected"],
        )
    )


def _parse_calendar_month_label(label: str) -> tuple[int, int]:
    text = str(label or "").replace(" ", "").strip()
    if not text:
        raise RuntimeError("日历月份标题为空")

    year_text = ""
    for char in text:
        if char.isdigit():
            year_text += char
    if len(year_text) < 4:
        raise RuntimeError(f"无法解析日历年份: {label}")
    year = int(year_text[:4])

    month_text = text.replace(str(year), "")
    month_text = month_text.strip()
    if month_text in _MONTH_NAME_TO_NUMBER:
        return year, _MONTH_NAME_TO_NUMBER[month_text]
    if month_text.endswith("月"):
        numeric_text = month_text[:-1]
        if numeric_text.isdigit():
            month = int(numeric_text)
            if 1 <= month <= 12:
                return year, month
    raise RuntimeError(f"无法解析日历月份: {label}")


def normalize_transport_mode(raw_mode: str) -> dict[str, Any]:
    raw_text = str(raw_mode or "").strip()
    normalized = raw_text.upper().replace(" ", "")
    if raw_text in ("空运",) or normalized == "AIR":
        return {"canonical": "AIR", "ui_text": "空运", "offset_days": 14}
    if raw_text in ("海运",) or normalized == "OCEAN":
        return {"canonical": "OCEAN", "ui_text": "海运", "offset_days": 30}
    if raw_text in ("低价商城", "陆运") or normalized == "GROUND":
        return {"canonical": "GROUND", "ui_text": "陆运", "offset_days": 1}
    if raw_text in ("DHL/UPS快递（空运速派）", "DHL/UPS快递(空运速派)") or normalized in (
        "EXPRESS_AIR",
        "DHL_UPS",
    ):
        return {"canonical": "EXPRESS_AIR", "ui_text": "空运", "offset_days": 7}
    raise RuntimeError(f"不支持的 transport_mode: {raw_text}")


def calculate_pickup_date(raw_mode: str, *, today: date | None = None) -> date:
    mode = normalize_transport_mode(raw_mode)
    base_date = today or date.today()
    return base_date + timedelta(days=int(mode["offset_days"]))


def _wait_for_condition(
    step_name: str,
    checker,
    *,
    timeout_seconds: int,
    interval_seconds: float = 0.5,
    driver: Any | None = None,
) -> None:
    deadline = time.time() + max(1, int(timeout_seconds or 0))
    while time.time() < deadline:
        _raise_if_returned_to_step2_start(driver)
        if checker():
            return
        time.sleep(max(0.2, float(interval_seconds or 0.5)))
    _raise_if_returned_to_step2_start(driver)
    raise RuntimeError(f"等待{step_name}超时")


def _wait_for_click(
    step_name: str,
    clicker,
    *,
    timeout_seconds: int,
    interval_seconds: float = 0.5,
    driver: Any | None = None,
) -> None:
    deadline = time.time() + max(1, int(timeout_seconds or 0))
    while time.time() < deadline:
        _raise_if_returned_to_step2_start(driver)
        if clicker():
            return
        time.sleep(max(0.2, float(interval_seconds or 0.5)))
    _raise_if_returned_to_step2_start(driver)
    raise RuntimeError(f"等待{step_name}超时")


def _select_pickup_date(driver: Any, target_date: date, *, timeout_seconds: int = 60) -> None:
    _raise_if_returned_to_step2_start(driver)
    if not _calendar_visible(driver):
        _wait_for_click("日期输入框", lambda: _click_date_input(driver), timeout_seconds=timeout_seconds, driver=driver)
        _wait_for_condition("日历出现", lambda: _calendar_visible(driver), timeout_seconds=timeout_seconds, driver=driver)

    deadline = time.time() + max(1, int(timeout_seconds or 0))
    while time.time() < deadline:
        _raise_if_returned_to_step2_start(driver)
        if _click_calendar_day(driver, target_date):
            return
        current_year, current_month = _parse_calendar_month_label(_read_calendar_month_label(driver))
        current_tuple = (current_year, current_month)
        target_tuple = (target_date.year, target_date.month)
        if current_tuple < target_tuple:
            if not _click_calendar_next_month(driver):
                raise RuntimeError("日历切换到下一月失败")
        elif current_tuple > target_tuple:
            if not _click_calendar_prev_month(driver):
                raise RuntimeError("日历切换到上一月失败")
        else:
            time.sleep(0.5)
            continue
        time.sleep(0.5)
    _raise_if_returned_to_step2_start(driver)
    raise RuntimeError(f"等待目标日期出现超时: {target_date.isoformat()}")


def probe_own_carrier_ready(session: Any, *, timeout_seconds: int = 10) -> dict[str, Any]:
    deadline = time.time() + max(1, min(int(timeout_seconds or 0), 10))
    while time.time() < deadline:
        if _delivery_window_link_visible(session.driver):
            return {"ready": True, "notice": "已进入日期选择器步骤"}
        if _amazon_operations_center_selected(session.driver):
            return {"ready": True, "notice": _AMAZON_OPERATIONS_CENTER_READY_NOTICE}
        time.sleep(0.5)
    return {"ready": False, "notice": ""}


def confirm_own_carrier_shipment(
    session: Any,
    transport_mode: str,
    *,
    consignment_no: str = "",
    timeout_seconds: int = 60,
    today: date | None = None,
) -> dict[str, str]:
    mode = normalize_transport_mode(transport_mode)
    target_date = calculate_pickup_date(transport_mode, today=today)
    driver = session.driver
    shipment_summary_excel_path = ""

    try:
        if not _delivery_window_link_visible(driver):
            _wait_for_click(
                "自己的承运人入口",
                lambda: _click_own_carrier_entry(driver),
                timeout_seconds=min(timeout_seconds, 10),
                driver=driver,
            )
            _wait_for_condition("弹窗出现", lambda: _dialog_visible(driver), timeout_seconds=min(timeout_seconds, 10), driver=driver)
            _wait_for_click(
                "弹窗 Confirm 按钮",
                lambda: _click_confirm_modal(driver),
                timeout_seconds=min(timeout_seconds, 10),
                driver=driver,
            )
        _wait_for_condition(
            "日期选择器出现",
            lambda: _date_picker_visible(driver),
            timeout_seconds=min(timeout_seconds, 60),
            driver=driver,
        )
        _select_pickup_date(driver, target_date, timeout_seconds=min(timeout_seconds, 60))
        _wait_for_click("更新按钮", lambda: _click_update_button(driver), timeout_seconds=min(timeout_seconds, 10), driver=driver)
        _wait_for_click("承运人下拉框", lambda: _open_carrier_dropdown(driver), timeout_seconds=min(timeout_seconds, 10), driver=driver)
        _wait_for_click("其他承运人选项", lambda: _select_other_carrier(driver), timeout_seconds=min(timeout_seconds, 10), driver=driver)
        _wait_for_click(
            "运输方式下拉框",
            lambda: _open_transport_mode_dropdown(driver),
            timeout_seconds=min(timeout_seconds, 10),
            driver=driver,
        )
        _wait_for_click(
            f"{mode['ui_text']}运输方式选项",
            lambda: _select_transport_mode_option(driver, str(mode["ui_text"])),
            timeout_seconds=min(timeout_seconds, 10),
            driver=driver,
        )
        _wait_for_click(
            "接受费用并确认发货按钮",
            lambda: _click_accept_fees_button(driver),
            timeout_seconds=min(timeout_seconds, 10),
            driver=driver,
        )
        _wait_for_condition(
            _CONTINUE_INPUT_TRACKING_TEXT,
            lambda: _continue_input_tracking_visible(driver),
            timeout_seconds=max(30, int(timeout_seconds or 0)),
            interval_seconds=1.0,
            driver=driver,
        )
        shipment_summaries = _collect_shipment_summaries(driver)
        shipment_summary_excel_path = _write_shipment_summary_excel(
            Path(getattr(session, "output_dir", Path.cwd())),
            shipment_summaries,
            consignment_no=consignment_no,
        )
        _wait_for_click(
            _CONTINUE_INPUT_TRACKING_TEXT,
            lambda: _click_continue_input_tracking_button(driver),
            timeout_seconds=min(timeout_seconds, 10),
            driver=driver,
        )
        _wait_for_condition(
            _TRACKING_INPUT_TEXT,
            lambda: _tracking_input_visible(driver),
            timeout_seconds=60,
            interval_seconds=1.0,
            driver=driver,
        )
        return {
            "notice": _FINAL_SUCCESS_NOTICE,
            "shipment_summary_excel_path": shipment_summary_excel_path,
        }
    except _ReturnedToStep2Start:
        payload = {"notice": _RETURN_TO_STEP2_NOTICE}
        if shipment_summary_excel_path:
            payload["shipment_summary_excel_path"] = shipment_summary_excel_path
        return payload
    except Exception as exc:
        raise _OwnCarrierWorkflowError(
            str(exc).strip() or exc.__class__.__name__,
            shipment_summary_excel_path=shipment_summary_excel_path,
        ) from exc


__all__ = [
    "calculate_pickup_date",
    "confirm_own_carrier_shipment",
    "normalize_transport_mode",
    "probe_own_carrier_ready",
]
