from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from selenium import webdriver
from selenium.common.exceptions import NoSuchElementException
from selenium.webdriver.common.by import By
from selenium.webdriver.chrome.service import Service

from services.browser.store.ziniao_trace import trace_event


class SeleniumRunnerError(RuntimeError):
    pass


class SeleniumRunner:
    def __init__(self, driver_folder_path: str):
        self._driver_folder_path = Path(driver_folder_path or "").expanduser()

    def get_driver(self, open_ret_json: dict[str, Any]) -> webdriver.Chrome:
        browser_path = open_ret_json.get("browserPath")
        core_type = open_ret_json.get("core_type")
        core_version = str(open_ret_json.get("core_version") or "").strip()
        chrome_driver_path = self._resolve_driver_path(
            browser_path=browser_path,
            core_type=core_type,
            core_version=core_version,
        )
        if not chrome_driver_path:
            trace_event(
                "driver.resolve.failure",
                level="error",
                **self._driver_resolution_diagnostics(
                    browser_path=browser_path,
                    core_type=core_type,
                    core_version=core_version,
                ),
            )
            raise SeleniumRunnerError("could not resolve ChromeDriver path")

        port = open_ret_json.get("debuggingPort")
        if not port:
            trace_event("driver.attach.failure", level="error", reason="debuggingPort missing")
            raise SeleniumRunnerError("debuggingPort missing from Ziniao response")

        trace_event(
            "driver.resolve.success",
            chrome_driver_path=chrome_driver_path,
            debugging_port=port,
            **self._driver_resolution_diagnostics(
                browser_path=browser_path,
                core_type=core_type,
                core_version=core_version,
            ),
        )
        options = webdriver.ChromeOptions()
        options.add_argument("--log-level=3")
        options.add_experimental_option("debuggerAddress", f"127.0.0.1:{port}")
        return webdriver.Chrome(service=Service(chrome_driver_path), options=options)

    def check_ip(self, driver: webdriver.Chrome, ip_check_url: str) -> bool:
        try:
            driver.get(str(ip_check_url or "").strip())
            driver.find_element(By.XPATH, '//button[contains(@class, "styles_btn--success")]')
            return True
        except NoSuchElementException:
            return False
        except Exception:
            return False

    def detach(self, driver: webdriver.Chrome | None) -> None:
        self.quit(driver)

    def quit(self, driver: webdriver.Chrome | None) -> None:
        if driver is None:
            return
        try:
            driver.quit()
        except Exception:
            try:
                service = getattr(driver, "service", None)
                if service is not None:
                    service.stop()
            except Exception:
                pass

    def _resolve_driver_path(
        self,
        *,
        browser_path: str | None,
        core_type: Any,
        core_version: str,
    ) -> str | None:
        if browser_path:
            candidate_root = browser_path
            if browser_path.endswith(("superbrowser.exe", "superbrowser")):
                candidate_root = os.path.dirname(browser_path)
            embedded_name = "webdriver.exe" if os.name == "nt" else "webdriver"
            embedded_path = os.path.join(candidate_root, embedded_name)
            if os.path.exists(embedded_path):
                return embedded_path

        if core_type not in {"Chromium", 0} or not core_version:
            return None
        major = core_version.split(".")[0]
        file_name = f"chromedriver{major}.exe" if os.name == "nt" else f"chromedriver{major}"
        driver_path = self._driver_folder_path / file_name
        if driver_path.exists():
            return str(driver_path)
        return None

    def _driver_resolution_diagnostics(
        self,
        *,
        browser_path: str | None,
        core_type: Any,
        core_version: str,
    ) -> dict[str, Any]:
        safe_browser_path = str(browser_path or "").strip()
        candidate_root = safe_browser_path
        if safe_browser_path.endswith(("superbrowser.exe", "superbrowser")):
            candidate_root = os.path.dirname(safe_browser_path)

        embedded_name = "webdriver.exe" if os.name == "nt" else "webdriver"
        embedded_path = os.path.join(candidate_root, embedded_name) if candidate_root else ""

        fallback_driver_path = ""
        if core_type in {"Chromium", 0} and core_version:
            major = core_version.split(".")[0]
            file_name = f"chromedriver{major}.exe" if os.name == "nt" else f"chromedriver{major}"
            fallback_driver_path = str(self._driver_folder_path / file_name)

        try:
            available = sorted(path.name for path in self._driver_folder_path.glob("chromedriver*") if path.is_file())
        except Exception:
            available = []

        return {
            "browserPath": safe_browser_path,
            "candidate_root": candidate_root,
            "embedded_driver_candidate": embedded_path,
            "embedded_driver_exists": bool(embedded_path and os.path.exists(embedded_path)),
            "core_type": core_type,
            "core_version": core_version,
            "driver_folder_path": str(self._driver_folder_path),
            "fallback_driver_candidate": fallback_driver_path,
            "fallback_driver_exists": bool(fallback_driver_path and os.path.exists(fallback_driver_path)),
            "available_chromedrivers": available,
        }
