from __future__ import annotations

import os
import time
from typing import Any

from services.agent_cli.browser.amazon_common.seller_central_url import (
    DEFAULT_SELLER_CENTRAL_ORIGIN,
    build_seller_central_url,
)
from services.browser.browser.actions import (
    _download_dir_from_path,
    _snapshot_download_dir,
    _wait_for_downloaded_file,
)
from services.browser.browser.shadow_dom import SHADOW_DOM_HELPERS_JS


SEND_TO_AMAZON_PATH = "/fba/sendtoamazon?ref=fbacentral_nav_fba"
SEND_TO_AMAZON_URL = f"{DEFAULT_SELLER_CENTRAL_ORIGIN}{SEND_TO_AMAZON_PATH}"

_START_NEW_SELECTORS = (
    '[data-testid="start-new-button"]',
)
_FILE_UPLOAD_MODE_SELECTORS = (
    'input[type="radio"][name="file-upload"][value="STA_SKU_SELECTION_METHOD_FILE_UPLOAD"]',
    '[data-testid="file-upload-radio-button"]',
)
_TEMPLATE_DOWNLOAD_SELECTORS = (
    '[data-testid="manifest-file-upload-template-generator-download-link"]',
    '[data-testid="manifest-file-upload-template-generator-download-button"]',
)
_TEMPLATE_FILE_INPUT_SELECTORS = (
    'input[type="file"][data-testid="file-upload-button-input"]',
)
_TEMPLATE_UPLOAD_BUTTON_SELECTORS = (
    '[data-testid="manifest-file-upload-button"]',
)
_UPLOAD_SUCCESS_NOTICE_SELECTORS = (
    '[data-testid="bold-translation"]',
)


def _execute_page_script(driver: Any, script_body: str, *args):
    return driver.execute_script(SHADOW_DOM_HELPERS_JS + script_body, *args)


def _probe_send_to_amazon_state(driver: Any) -> dict[str, Any]:
    result = _execute_page_script(
        driver,
        """
const url = String(window.location.href || '');
const onSendToAmazonPage = url.toLowerCase().includes('/fba/sendtoamazon');
const hasStartNew = Boolean(deepQuerySelector('[data-testid="start-new-button"]'));
const hasFileUploadRadio = Boolean(
  deepQuerySelector('input[type="radio"][name="file-upload"][value="STA_SKU_SELECTION_METHOD_FILE_UPLOAD"]') ||
  deepQuerySelector('[data-testid="file-upload-radio-button"]')
);
const hasTemplateDownload = Boolean(
  deepQuerySelector('[data-testid="manifest-file-upload-template-generator-download-link"]') ||
  deepQuerySelector('[data-testid="manifest-file-upload-template-generator-download-button"]')
);
const hasTemplateFileInput = Boolean(
  deepQuerySelector('input[type="file"][data-testid="file-upload-button-input"]')
);
const hasTemplateUploadButton = Boolean(
  deepQuerySelector('[data-testid="manifest-file-upload-button"]')
);
return {
  url,
  on_send_to_amazon_page: onSendToAmazonPage,
  has_start_new: hasStartNew,
  has_file_upload_radio: hasFileUploadRadio,
  has_template_download: hasTemplateDownload,
  has_template_file_input: hasTemplateFileInput,
  has_template_upload_button: hasTemplateUploadButton,
};
""",
    )
    return dict(result or {})


def _click_first_matching(driver: Any, selectors: tuple[str, ...]) -> bool:
    return bool(
        _execute_page_script(
            driver,
            """
const selectors = Array.isArray(arguments[0]) ? arguments[0] : [];

function resolveClickTarget(el) {
  if (!el || !el.shadowRoot) return el;
  const innerButton = el.shadowRoot.querySelector('button');
  return innerButton || el;
}

function clickElement(el) {
  const target = resolveClickTarget(el);
  if (!target) return false;
  try {
    target.scrollIntoView({ block: 'center', inline: 'center' });
  } catch (error) {}
  try {
    target.click();
    return true;
  } catch (error) {}
  try {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
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


def _click_start_new_workflow(driver: Any) -> bool:
    return _click_first_matching(driver, _START_NEW_SELECTORS)


def _click_file_upload_mode(driver: Any) -> bool:
    return _click_first_matching(driver, _FILE_UPLOAD_MODE_SELECTORS)


def _click_template_download(driver: Any) -> bool:
    return _click_first_matching(driver, _TEMPLATE_DOWNLOAD_SELECTORS)


def _find_template_file_input(driver: Any):
    return _resolve_first_matching_element(driver, _TEMPLATE_FILE_INPUT_SELECTORS)


def _click_template_upload_button(driver: Any) -> bool:
    return _click_first_matching(driver, _TEMPLATE_UPLOAD_BUTTON_SELECTORS)


def _read_upload_notice(driver: Any) -> str:
    raw_notice = _execute_page_script(
        driver,
        """
function cleanText(value) {
  return String(value || '').replace(/\\s+/g, ' ').trim();
}

const root = deepQuerySelector('[data-testid="manifest-file-upload-page-uploading-failed"]');
if (root) {
  const parts = [];
  const heading = root.querySelector('h5');
  const detail = root.querySelector('p');
  for (const node of [heading, detail]) {
    const text = cleanText(node ? node.innerText || node.textContent || '' : '');
    if (text) parts.push(text);
  }
  if (!parts.length) {
    const fallback = cleanText(root.innerText || root.textContent || '');
    if (fallback) parts.push(fallback);
  }
  if (parts.length) return parts.join('\\n');
}

for (const selector of arguments[0] || []) {
  const el = deepQuerySelector(String(selector || ''));
  if (!el) continue;
  const text = cleanText(el.innerText || el.textContent || '');
  if (text && text.includes('准备发送的 SKU')) {
    return text;
  }
}
return '';
""",
        list(_UPLOAD_SUCCESS_NOTICE_SELECTORS),
    )
    return str(raw_notice or "").strip()


def _is_placeholder_upload_notice(notice: str) -> bool:
    text = str(notice or "").strip()
    return bool(text) and "准备发送的 SKU" in text and "0（0 件商品）" in text


def _download_dir_for_session(session: Any):
    return _download_dir_from_path(str(getattr(session, "download_path", "") or "").strip())


def open_send_to_amazon_upload_mode(session: Any, *, timeout_seconds: int = 60) -> dict[str, Any]:
    deadline = time.time() + max(10, int(timeout_seconds or 0))
    session.open_url(build_seller_central_url(session, SEND_TO_AMAZON_PATH))
    last_state: dict[str, Any] = {}
    start_new_clicked = False

    while time.time() < deadline:
        state = _probe_send_to_amazon_state(session.driver)
        last_state = state

        if not bool(state.get("has_start_new")):
            start_new_clicked = False

        if bool(state.get("has_template_download")):
            return {"state": state}

        if bool(state.get("has_file_upload_radio")):
            if not _click_file_upload_mode(session.driver):
                raise RuntimeError("未找到文件上传模式按钮")
            time.sleep(1.0)
            continue

        if bool(state.get("has_start_new")):
            if start_new_clicked:
                time.sleep(1.0)
                continue
            if not _click_start_new_workflow(session.driver):
                raise RuntimeError("未找到重新开始按钮")
            start_new_clicked = True
            time.sleep(2.0)
            follow_up_state = _probe_send_to_amazon_state(session.driver)
            last_state = follow_up_state

            if not bool(follow_up_state.get("has_start_new")):
                start_new_clicked = False

            if bool(follow_up_state.get("has_template_download")):
                return {"state": follow_up_state}

            if bool(follow_up_state.get("has_file_upload_radio")):
                if not _click_file_upload_mode(session.driver):
                    raise RuntimeError("未找到文件上传模式按钮")
                time.sleep(1.0)
                continue

            time.sleep(1.0)
            continue

        time.sleep(1.0)

    current_url = str(last_state.get("url") or "").strip()
    suffix = f" 当前页面: {current_url}" if current_url else ""
    raise RuntimeError(f"等待 Send to Amazon 进入文件上传模式超时。{suffix}")


def download_template(session: Any, *, timeout_seconds: int = 60) -> dict[str, Any]:
    deadline = time.time() + max(10, int(timeout_seconds or 0))
    download_dir = _download_dir_for_session(session)
    before_files = _snapshot_download_dir(download_dir)

    while time.time() < deadline:
        if _click_template_download(session.driver):
            downloaded_file = _wait_for_downloaded_file(
                download_dir,
                before_files=before_files,
                timeout_seconds=max(10, int(timeout_seconds or 0)),
            )
            if downloaded_file is None:
                raise RuntimeError("模板下载未在超时时间内确认落盘")
            return {
                "template_path": str(downloaded_file),
            }
        time.sleep(0.5)

    raise RuntimeError("等待 Amazon 模板下载控件超时")


def upload_filled_template(session: Any, filled_template_path: str, *, timeout_seconds: int = 120) -> dict[str, Any]:
    safe_path = str(filled_template_path or "").strip()
    if not safe_path:
        raise RuntimeError("filled_template_path 不能为空")
    if not os.path.isfile(safe_path):
        raise RuntimeError(f"已填写模板文件不存在: {safe_path}")

    input_deadline = time.time() + max(10, int(timeout_seconds or 0))
    file_input = None
    while time.time() < input_deadline:
        file_input = _find_template_file_input(session.driver)
        if file_input is not None:
            break
        time.sleep(0.5)
    if file_input is None:
        raise RuntimeError("等待模板上传控件出现超时")

    element_type = str(file_input.get_attribute("type") or "").strip().lower()
    if str(file_input.tag_name or "").strip().lower() != "input" or element_type != "file":
        raise RuntimeError("upload_file requires input[type=file]")

    file_input.send_keys(safe_path)
    time.sleep(1.0)
    time.sleep(5.0)

    click_deadline = time.time() + min(10, max(1, int(timeout_seconds or 0)))
    while time.time() < click_deadline:
        notice = _read_upload_notice(session.driver)
        if notice and not _is_placeholder_upload_notice(notice):
            return {"notice": notice}
        if _click_template_upload_button(session.driver):
            time.sleep(1.0)
            break
        time.sleep(0.5)

    last_notice = ""
    notice_deadline = time.time() + 10
    while time.time() < notice_deadline:
        notice = _read_upload_notice(session.driver)
        if notice:
            last_notice = notice
        if notice and not _is_placeholder_upload_notice(notice):
            return {"notice": notice}
        time.sleep(0.5)

    return {"notice": "" if _is_placeholder_upload_notice(last_notice) else last_notice}


__all__ = [
    "SEND_TO_AMAZON_PATH",
    "SEND_TO_AMAZON_URL",
    "download_template",
    "open_send_to_amazon_upload_mode",
    "upload_filled_template",
]
