from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from selenium import webdriver
from selenium.common.exceptions import NoSuchElementException
from selenium.webdriver.common.by import By
from selenium.webdriver.chrome.service import Service


class SeleniumRunnerError(RuntimeError):
    pass


class SeleniumRunner:
    def __init__(self, driver_folder_path: str):
        self._driver_folder_path = Path(driver_folder_path or "").expanduser()

    def get_driver(self, open_ret_json: dict[str, Any]) -> webdriver.Chrome:
        browser_path = open_ret_json.get("browserPath")
        core_type = open_ret_json.get("core_type")
        chrome_driver_path = self._resolve_driver_path(
            browser_path=browser_path,
            core_type=core_type,
            core_version=str(open_ret_json.get("core_version") or "").strip(),
        )
        if not chrome_driver_path:
            raise SeleniumRunnerError("could not resolve ChromeDriver path")

        port = open_ret_json.get("debuggingPort")
        if not port:
            raise SeleniumRunnerError("debuggingPort missing from Ziniao response")

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
