from __future__ import annotations

import time
from contextlib import contextmanager
from typing import Any, Iterator

from selenium.common.exceptions import WebDriverException

from services.browser.browser.selenium_runner import SeleniumRunner, SeleniumRunnerError
from services.browser.core.driver_binary import driver_folder_path


def _resolve_browser_driver() -> SeleniumRunner:
    return SeleniumRunner(driver_folder_path())


def create_driver(*, browser_path: str, debugging_port: int) -> Any:
    try:
        return _resolve_browser_driver().get_driver(
            {
                "browserPath": str(browser_path or "").strip(),
                "debuggingPort": int(debugging_port or 0),
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


def list_browser_tabs(driver: Any) -> list[dict[str, str]]:
    if driver is None:
        return []

    try:
        handles = list(getattr(driver, "window_handles", []) or [])
    except Exception:
        handles = []

    try:
        original_handle = str(getattr(driver, "current_window_handle", "") or "").strip()
    except Exception:
        original_handle = ""

    tabs: list[dict[str, str]] = []
    for handle in handles:
        safe_handle = str(handle or "").strip()
        try:
            driver.switch_to.window(handle)
            tabs.append(
                {
                    "handle": safe_handle,
                    "url": _safe_current_url(driver),
                    "title": _safe_title(driver),
                }
            )
        except Exception as exc:
            tabs.append(
                {
                    "handle": safe_handle,
                    "url": "",
                    "title": f"无法读取标签页: {str(exc).strip()}",
                }
            )

    if original_handle:
        try:
            driver.switch_to.window(original_handle)
        except Exception:
            pass

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


@contextmanager
def attached_driver(*, browser_path: str, debugging_port: int) -> Iterator[Any]:
    driver = create_driver(browser_path=browser_path, debugging_port=debugging_port)
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
    "is_normal_tab_url",
    "list_browser_tabs",
    "open_launcher_page",
    "select_first_normal_tab",
]
