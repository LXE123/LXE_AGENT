from __future__ import annotations

import time
from contextlib import contextmanager
from typing import Any, Iterator
from urllib.parse import urlsplit

from selenium.common.exceptions import WebDriverException

from services.browser.browser.selenium_runner import SeleniumRunner, SeleniumRunnerError
from services.browser.core.driver_binary import driver_folder_path


def _resolve_browser_driver() -> SeleniumRunner:
    return SeleniumRunner(driver_folder_path())


def create_driver(*, browser_path: str, debugging_port: int, core_type: Any = None, core_version: str = "") -> Any:
    try:
        return _resolve_browser_driver().get_driver(
            {
                "browserPath": str(browser_path or "").strip(),
                "debuggingPort": int(debugging_port or 0),
                "core_type": core_type,
                "core_version": str(core_version or "").strip(),
            }
        )
    except SeleniumRunnerError as exc:
        raise RuntimeError(str(exc).strip() or "无法连接当前紫鸟浏览器，请重新打开店铺") from exc
    except WebDriverException as exc:
        raise RuntimeError("无法连接当前紫鸟浏览器，请重新打开店铺") from exc


def detach_driver(driver: Any) -> None:
    if driver is None:
        return
    try:
        executor = getattr(driver, "command_executor", None)
        if executor is not None and hasattr(executor, "close"):
            executor.close()
    except Exception:
        pass
    try:
        service = getattr(driver, "service", None)
        if service is not None and hasattr(service, "stop"):
            service.stop()
    except Exception:
        pass


def is_normal_tab_url(url: str, *, allow_blank: bool = False) -> bool:
    text = str(url or "").strip().lower()
    if allow_blank and text == "about:blank":
        return True
    return text.startswith("http://") or text.startswith("https://")


def _safe_current_url(driver: Any) -> str:
    try:
        return str(getattr(driver, "current_url", "") or "").strip()
    except Exception:
        return ""


def _safe_title(driver: Any) -> str:
    try:
        return str(getattr(driver, "title", "") or "").strip()
    except Exception:
        return ""


def _safe_current_handle(driver: Any) -> str:
    try:
        return str(getattr(driver, "current_window_handle", "") or "").strip()
    except Exception:
        return ""


def list_browser_tabs(driver: Any, *, restore_original: bool = True, strict: bool = False) -> list[dict[str, str]]:
    """Read live tab metadata; target selectors may defer restoring the original."""
    if driver is None:
        return []

    try:
        handles = list(getattr(driver, "window_handles", []) or [])
    except Exception:
        if strict:
            raise
        handles = []

    original_handle = str(driver.current_window_handle or "").strip() if strict else _safe_current_handle(driver)
    current_handle = original_handle

    tabs: list[dict[str, str]] = []
    for handle in handles:
        safe_handle = str(handle or "").strip()
        try:
            if safe_handle != current_handle:
                driver.switch_to.window(handle)
                current_handle = safe_handle
            tabs.append(
                {
                    "handle": safe_handle,
                    "url": str(driver.current_url or "").strip() if strict else _safe_current_url(driver),
                    "title": str(driver.title or "").strip() if strict else _safe_title(driver),
                }
            )
        except Exception as exc:
            current_handle = _safe_current_handle(driver)
            tabs.append(
                {
                    "handle": safe_handle,
                    "url": "",
                    "title": f"无法读取标签页: {str(exc).strip()}",
                }
            )

    if restore_original and original_handle and current_handle != original_handle:
        try:
            driver.switch_to.window(original_handle)
        except Exception:
            if strict:
                raise

    return tabs


def _format_tab_summary(tabs: list[dict[str, str]]) -> str:
    if not tabs:
        return "(no tabs)"
    lines: list[str] = []
    for index, tab in enumerate(tabs, start=1):
        title = str(tab.get("title") or "").strip() or "-"
        url = str(tab.get("url") or "").strip() or "-"
        lines.append(f"{index}. title={title} url={url}")
    return "; ".join(lines)


def select_first_normal_tab(driver: Any, *, allow_blank: bool = False) -> dict[str, str]:
    tabs = list_browser_tabs(driver)
    for tab in tabs:
        if is_normal_tab_url(str(tab.get("url") or ""), allow_blank=allow_blank):
            driver.switch_to.window(tab["handle"])
            return dict(tab)
    raise RuntimeError(f"未找到可操作的普通页面。当前标签页: {_format_tab_summary(tabs)}")


def validate_target_handle(value: Any) -> str:
    if not isinstance(value, str) or not value or len(value) > 256 or any(ch.isspace() or ord(ch) < 32 or ord(ch) == 127 for ch in value):
        raise ValueError("target_handle must be a non-empty browser handle of at most 256 characters without whitespace")
    return value


def select_unique_host_tab(driver: Any, target_host: str, *, target_handle: str = "") -> dict[str, str]:
    safe_target_host = str(target_host or "").strip().lower().rstrip(".")
    if not safe_target_host:
        raise RuntimeError("target_host missing")
    original_handle = _safe_current_handle(driver)
    try:
        if target_handle:
            validate_target_handle(target_handle)
            if target_handle not in driver.window_handles:
                raise RuntimeError(f"目标标签页 {target_handle} 已关闭或不存在；请重新列出标签页")
            if _safe_current_handle(driver) != target_handle:
                driver.switch_to.window(target_handle)
            url = str(driver.current_url or "").strip()
            if not is_normal_tab_url(url) or (urlsplit(url).hostname or "").lower().rstrip(".") != safe_target_host:
                raise RuntimeError(f"目标标签页 {target_handle} 不再属于域名 {safe_target_host}")
            return {"handle": target_handle, "url": url, "title": _safe_title(driver)}
        # Inspect every tab for uniqueness, then select directly from the last
        # inspected context instead of bouncing through the original page.
        tabs = list_browser_tabs(driver, restore_original=False)
        matches = [
            tab
            for tab in tabs
            if is_normal_tab_url(str(tab.get("url") or ""))
            and str(urlsplit(str(tab.get("url") or "")).hostname or "").strip().lower().rstrip(".")
            == safe_target_host
        ]
        if not matches:
            raise RuntimeError(
                f"未找到域名为 {safe_target_host} 的可操作页面。当前标签页: {_format_tab_summary(tabs)}"
            )
        if len(matches) > 1:
            raise RuntimeError(
                f"域名 {safe_target_host} 匹配到 {len(matches)} 个标签页，无法唯一定位。当前标签页: {_format_tab_summary(tabs)}"
            )
        selected = matches[0]
        if _safe_current_handle(driver) != selected["handle"]:
            driver.switch_to.window(selected["handle"])
        return dict(selected)
    except Exception as exc:
        if original_handle:
            try:
                if _safe_current_handle(driver) != original_handle:
                    driver.switch_to.window(original_handle)
            except Exception as restore_error:
                raise RuntimeError(
                    f"{exc}; 无法恢复原标签页 {original_handle}: {type(restore_error).__name__}: {restore_error}"
                ) from exc
        raise


@contextmanager
def attached_driver(
    *,
    browser_path: str,
    debugging_port: int,
    core_type: Any = None,
    core_version: str = "",
) -> Iterator[Any]:
    driver = create_driver(
        browser_path=browser_path,
        debugging_port=debugging_port,
        core_type=core_type,
        core_version=core_version,
    )
    try:
        try:
            driver.implicitly_wait(20)
        except Exception:
            pass
        yield driver
    finally:
        detach_driver(driver)


def check_ip(driver: Any, ip_detection_page: str) -> bool:
    safe_ip_detection_page = str(ip_detection_page or "").strip()
    if not safe_ip_detection_page:
        raise RuntimeError("ip_detection_page missing")
    return bool(_resolve_browser_driver().check_ip(driver, safe_ip_detection_page))


def open_launcher_page(driver: Any, launcher_page: str) -> str:
    safe_launcher_page = str(launcher_page or "").strip()
    if not safe_launcher_page:
        raise RuntimeError("launcher_page missing")
    driver.get(safe_launcher_page)
    time.sleep(6)
    try:
        current_url = str(driver.current_url or "").strip()
        if current_url:
            return current_url
    except Exception:
        pass
    return safe_launcher_page


__all__ = [
    "attached_driver",
    "check_ip",
    "create_driver",
    "detach_driver",
    "select_unique_host_tab",
    "is_normal_tab_url",
    "list_browser_tabs",
    "open_launcher_page",
    "select_first_normal_tab",
]
