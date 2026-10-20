from __future__ import annotations

import pytest

from services.browser.tools.driver_session import (
    is_normal_tab_url,
    list_browser_tabs,
    select_first_normal_tab,
    select_unique_host_tab,
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
    assert driver.switch_calls == ["h1", "h2"]


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


def test_select_unique_host_tab_selects_exact_host() -> None:
    driver = _FakeDriver(
        [
            ("h1", "https://sellercentral.amazon.com/home", "Amazon"),
            ("h2", "http://wsaexp.nextsls.com/wos", "威飒"),
        ]
    )

    selected = select_unique_host_tab(driver, "WSAEXP.NEXTSLS.COM.")

    assert selected["handle"] == "h2"
    assert driver.current_window_handle == "h2"
    assert driver.switch_calls == ["h2"]


def test_select_unique_host_tab_does_not_switch_when_the_only_tab_is_already_selected() -> None:
    driver = _FakeDriver([("wesa", "http://wsaexp.nextsls.com/wos", "威飒")])

    selected = select_unique_host_tab(driver, "wsaexp.nextsls.com")

    assert selected["handle"] == "wesa"
    assert driver.switch_calls == []


def test_select_unique_host_tab_checks_later_tabs_without_returning_to_the_original_first() -> None:
    driver = _FakeDriver([
        ("amazon", "https://sellercentral.amazon.com/home", "Amazon"),
        ("wesa", "http://wsaexp.nextsls.com/wos", "威飒"),
        ("feiwo", "http://feichi.nextsls.com/tracking", "飞沃"),
    ])

    selected = select_unique_host_tab(driver, "wsaexp.nextsls.com")

    assert selected["handle"] == "wesa"
    assert driver.switch_calls == ["wesa", "feiwo", "wesa"]


@pytest.mark.parametrize("extra_url,error", [
    ("http://feichi.nextsls.com/tracking", "未找到域名为"),
    ("http://wsaexp.nextsls.com/orders", "匹配到 2 个标签页"),
])
def test_host_selection_failure_restores_original_and_keeps_the_actual_tab_summary(extra_url, error) -> None:
    pages = [("amazon", "https://sellercentral.amazon.com/home", "Amazon")]
    if "wsaexp" in extra_url:
        pages.append(("wesa", "http://wsaexp.nextsls.com/wos", "威飒"))
    pages.append(("extra", extra_url, "其他页面"))
    driver = _FakeDriver(pages)

    with pytest.raises(RuntimeError, match=error) as caught:
        select_unique_host_tab(driver, "wsaexp.nextsls.com")

    assert extra_url in str(caught.value)
    assert driver.current_window_handle == "amazon"
    assert driver.switch_calls == [handle for handle, _url, _title in pages[1:]] + ["amazon"]


def test_host_selection_checks_for_new_duplicate_tabs_on_every_call() -> None:
    driver = _FakeDriver([
        ("amazon", "https://sellercentral.amazon.com/home", "Amazon"),
        ("wesa", "http://wsaexp.nextsls.com/wos", "威飒"),
    ])
    select_unique_host_tab(driver, "wsaexp.nextsls.com")
    driver.pages["duplicate"] = {"url": "http://wsaexp.nextsls.com/orders", "title": "另一个威飒"}
    driver.window_handles.append("duplicate")

    with pytest.raises(RuntimeError, match="匹配到 2 个标签页"):
        select_unique_host_tab(driver, "wsaexp.nextsls.com")

    assert driver.current_window_handle == "wesa"


@pytest.mark.parametrize("restore_fails", [False, True])
def test_failed_target_selection_restores_original_or_reports_both_actual_errors(monkeypatch, restore_fails) -> None:
    driver = _FakeDriver([
        ("amazon", "https://sellercentral.amazon.com/home", "Amazon"),
        ("wesa", "http://wsaexp.nextsls.com/wos", "威飒"),
        ("feiwo", "http://feichi.nextsls.com/tracking", "飞沃"),
    ])
    switch = driver.switch_to.window
    def fail_after_scan(handle):
        if "feiwo" in driver.switch_calls:
            if handle == "wesa":
                raise RuntimeError("fixture target tab closed after scan")
            if handle == "amazon" and restore_fails:
                raise RuntimeError("fixture original tab unavailable")
        switch(handle)
    monkeypatch.setattr(driver.switch_to, "window", fail_after_scan)

    with pytest.raises(RuntimeError) as caught:
        select_unique_host_tab(driver, "wsaexp.nextsls.com")

    assert "fixture target tab closed after scan" in str(caught.value)
    if restore_fails:
        assert "fixture original tab unavailable" in str(caught.value)
        assert driver.current_window_handle == "feiwo"
    else:
        assert driver.current_window_handle == "amazon"


def test_tab_scan_rechecks_context_after_a_switch_fails_after_taking_effect(monkeypatch) -> None:
    driver = _FakeDriver([
        ("wesa", "http://wsaexp.nextsls.com/wos", "威飒"),
        ("amazon", "https://sellercentral.amazon.com/home", "Amazon"),
    ], current_handle="amazon")
    switch = driver.switch_to.window
    def lose_switch_reply(handle):
        switch(handle)
        if handle == "wesa":
            raise RuntimeError("fixture reply lost after switching")
    monkeypatch.setattr(driver.switch_to, "window", lose_switch_reply)

    tabs = list_browser_tabs(driver)

    assert tabs[0]["url"] == ""
    assert "fixture reply lost after switching" in tabs[0]["title"]
    assert tabs[1] == {"handle": "amazon", "url": "https://sellercentral.amazon.com/home", "title": "Amazon"}
    assert driver.current_window_handle == "amazon"
    assert driver.switch_calls == ["wesa", "amazon"]


def test_select_unique_host_tab_rejects_missing_host_with_real_tab_summary() -> None:
    driver = _FakeDriver(
        [
            ("h1", "https://sellercentral.amazon.com/home", "Amazon"),
            ("h2", "http://feichi.nextsls.com/tracking", "飞沃"),
        ],
        current_handle="h2",
    )

    with pytest.raises(RuntimeError) as exc_info:
        select_unique_host_tab(driver, "wsaexp.nextsls.com")

    message = str(exc_info.value)
    assert "未找到域名为 wsaexp.nextsls.com" in message
    assert "sellercentral.amazon.com" in message
    assert "feichi.nextsls.com" in message
    assert driver.current_window_handle == "h2"


def test_select_unique_host_tab_rejects_ambiguous_matches() -> None:
    driver = _FakeDriver(
        [
            ("h1", "http://wsaexp.nextsls.com/wos", "威飒 1"),
            ("h2", "http://wsaexp.nextsls.com/wos/orders", "威飒 2"),
        ]
    )

    with pytest.raises(RuntimeError, match="匹配到 2 个标签页"):
        select_unique_host_tab(driver, "wsaexp.nextsls.com")
