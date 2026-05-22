from __future__ import annotations

import pytest

from agent_runtime.packs.browser.driver_session import (
    is_normal_tab_url,
    list_browser_tabs,
    select_first_normal_tab,
)


class _FakeSwitchTo:
    def __init__(self, driver: "_FakeDriver") -> None:
        self._driver = driver

    def window(self, handle: str) -> None:
        if handle not in self._driver.pages:
            raise RuntimeError(f"unknown handle: {handle}")
        self._driver.current_handle = handle
        self._driver.switch_calls.append(handle)


class _FakeDriver:
    def __init__(self, pages: list[tuple[str, str, str]], *, current_handle: str | None = None) -> None:
        self.pages = {handle: {"url": url, "title": title} for handle, url, title in pages}
        self.window_handles = [handle for handle, _url, _title in pages]
        self.current_handle = current_handle or self.window_handles[0]
        self.switch_to = _FakeSwitchTo(self)
        self.switch_calls: list[str] = []
        self.close_calls = 0

    @property
    def current_window_handle(self) -> str:
        return self.current_handle

    @property
    def current_url(self) -> str:
        return self.pages[self.current_handle]["url"]

    @property
    def title(self) -> str:
        return self.pages[self.current_handle]["title"]

    def close(self) -> None:
        self.close_calls += 1


def test_is_normal_tab_url_accepts_only_http_https_by_default() -> None:
    assert is_normal_tab_url("https://sellercentral.amazon.com")
    assert is_normal_tab_url("HTTP://example.test")
    assert not is_normal_tab_url("devtools://devtools/bundled/devtools_app.html")
    assert not is_normal_tab_url("chrome-extension://abc/index.html")
    assert not is_normal_tab_url("about:blank")


def test_is_normal_tab_url_allows_blank_when_requested() -> None:
    assert is_normal_tab_url("about:blank", allow_blank=True)
    assert not is_normal_tab_url("about:srcdoc", allow_blank=True)


def test_list_browser_tabs_reads_tabs_and_restores_original_handle() -> None:
    driver = _FakeDriver(
        [
            ("h1", "https://sellercentral.amazon.com/home", "Home"),
            ("h2", "https://sellercentral.amazon.com/fba/sendtoamazon", "FBA"),
        ],
        current_handle="h2",
    )

    tabs = list_browser_tabs(driver)

    assert tabs == [
        {"handle": "h1", "url": "https://sellercentral.amazon.com/home", "title": "Home"},
        {"handle": "h2", "url": "https://sellercentral.amazon.com/fba/sendtoamazon", "title": "FBA"},
    ]
    assert driver.current_window_handle == "h2"


def test_select_first_normal_tab_skips_devtools() -> None:
    driver = _FakeDriver(
        [
            ("h1", "devtools://devtools/bundled/devtools_app.html", "DevTools"),
            ("h2", "https://sellercentral.amazon.com/fba/sendtoamazon", "Send to Amazon"),
        ]
    )

    selected = select_first_normal_tab(driver)

    assert selected["handle"] == "h2"
    assert driver.current_window_handle == "h2"
    assert driver.close_calls == 0


def test_select_first_normal_tab_uses_first_http_page_without_closing_tabs() -> None:
    driver = _FakeDriver(
        [
            ("h1", "https://sellercentral.amazon.com/home", "Home"),
            ("h2", "https://sellercentral.amazon.com/fba/sendtoamazon", "Send to Amazon"),
        ],
        current_handle="h2",
    )

    selected = select_first_normal_tab(driver)

    assert selected["handle"] == "h1"
    assert driver.current_window_handle == "h1"
    assert driver.close_calls == 0


def test_select_first_normal_tab_raises_with_tab_summary_when_no_normal_page() -> None:
    driver = _FakeDriver(
        [
            ("h1", "devtools://devtools/bundled/devtools_app.html", "DevTools"),
            ("h2", "chrome-extension://abc/index.html", "Extension"),
        ]
    )

    with pytest.raises(RuntimeError) as exc_info:
        select_first_normal_tab(driver)

    message = str(exc_info.value)
    assert "未找到可操作的普通页面" in message
    assert "DevTools" in message
    assert "chrome-extension://abc/index.html" in message


def test_select_first_normal_tab_can_select_blank_for_open_store() -> None:
    driver = _FakeDriver(
        [
            ("h1", "devtools://devtools/bundled/devtools_app.html", "DevTools"),
            ("h2", "about:blank", ""),
        ]
    )

    selected = select_first_normal_tab(driver, allow_blank=True)

    assert selected["handle"] == "h2"
    assert driver.current_window_handle == "h2"
