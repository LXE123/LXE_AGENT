from __future__ import annotations

import pytest

from services.agent_cli.browser.amazon_common import seller_central_url
from services.agent_cli.browser.amazon_common import send_to_amazon


class _FakeDriver:
    def __init__(self, current_url: str):
        self.current_url = current_url


class _FakeSession:
    def __init__(self, current_url: str):
        self.driver = _FakeDriver(current_url)
        self.opened_urls: list[str] = []

    def open_url(self, url: str) -> dict[str, str]:
        self.opened_urls.append(url)
        return {}


@pytest.mark.parametrize(
    ("current_url", "expected_origin"),
    [
        ("https://sellercentral.amazon.co.uk/home", "https://sellercentral.amazon.co.uk"),
        ("https://sellercentral.amazon.com.mx/orders", "https://sellercentral.amazon.com.mx"),
        ("https://sellercentral-japan.amazon.com/home", "https://sellercentral-japan.amazon.com"),
        ("https://example.com/not-seller-central", "https://example.com"),
        ("", "https://sellercentral.amazon.com"),
        ("about:blank", "https://sellercentral.amazon.com"),
    ],
)
def test_build_send_to_amazon_url_uses_current_page_origin(
    current_url: str,
    expected_origin: str,
) -> None:
    session = _FakeSession(current_url)

    assert send_to_amazon.build_send_to_amazon_url(session) == (
        f"{expected_origin}/fba/sendtoamazon?ref=fbacentral_nav_fba"
    )


@pytest.mark.parametrize(
    ("current_url", "expected_url"),
    [
        (
            "https://sellercentral-japan.amazon.com/home",
            "https://sellercentral-japan.amazon.com/account-switcher/default/merchantMarketplace",
        ),
        (
            "https://sellercentral.amazon.co.uk/home",
            "https://sellercentral.amazon.co.uk/account-switcher/default/merchantMarketplace",
        ),
        (
            "",
            "https://sellercentral.amazon.com/account-switcher/default/merchantMarketplace",
        ),
        (
            "about:blank",
            "https://sellercentral.amazon.com/account-switcher/default/merchantMarketplace",
        ),
    ],
)
def test_build_seller_central_url_uses_shared_current_page_origin(
    current_url: str,
    expected_url: str,
) -> None:
    session = _FakeSession(current_url)

    assert seller_central_url.build_seller_central_url(
        session,
        "/account-switcher/default/merchantMarketplace",
    ) == expected_url


def test_open_send_to_amazon_upload_mode_opens_current_origin_url(monkeypatch: pytest.MonkeyPatch) -> None:
    session = _FakeSession("https://sellercentral.amazon.co.uk/account-switcher/default/merchantMarketplace")

    monkeypatch.setattr(
        send_to_amazon,
        "_probe_send_to_amazon_state",
        lambda _driver: {"has_template_download": True},
    )
    monkeypatch.setattr(
        send_to_amazon,
        "_ensure_agl_unchecked",
        lambda _driver: {"found": False, "checked": False, "clicked": False},
    )

    payload = send_to_amazon.open_send_to_amazon_upload_mode(session, timeout_seconds=10)

    assert payload == {"state": {"has_template_download": True}}
    assert session.opened_urls == [
        "https://sellercentral.amazon.co.uk/fba/sendtoamazon?ref=fbacentral_nav_fba"
    ]


@pytest.mark.parametrize(
    "state",
    [
        {"found": False, "checked": False},
        {"found": True, "checked": False},
    ],
)
def test_ensure_agl_unchecked_noops_when_missing_or_unchecked(
    monkeypatch: pytest.MonkeyPatch,
    state: dict[str, bool],
) -> None:
    clicks: list[str] = []
    monkeypatch.setattr(send_to_amazon, "_read_agl_checkbox_state", lambda _driver: dict(state))
    monkeypatch.setattr(send_to_amazon, "_click_agl_checkbox", lambda _driver: clicks.append("click") or True)

    result = send_to_amazon._ensure_agl_unchecked(object())

    assert result == {
        "found": state["found"],
        "checked": False,
        "clicked": False,
    }
    assert clicks == []


def test_ensure_agl_unchecked_clicks_when_checked(monkeypatch: pytest.MonkeyPatch) -> None:
    states = iter(
        [
            {"found": True, "checked": True},
            {"found": True, "checked": False},
        ]
    )
    clicks: list[str] = []
    sleeps: list[float] = []

    monkeypatch.setattr(send_to_amazon, "_read_agl_checkbox_state", lambda _driver: next(states))
    monkeypatch.setattr(send_to_amazon, "_click_agl_checkbox", lambda _driver: clicks.append("click") or True)
    monkeypatch.setattr(send_to_amazon.time, "sleep", lambda seconds: sleeps.append(float(seconds)))

    result = send_to_amazon._ensure_agl_unchecked(object())

    assert result == {"found": True, "checked": False, "clicked": True}
    assert clicks == ["click"]
    assert sleeps == [0.2]


def test_click_agl_checkbox_prefers_inner_checkbox_node() -> None:
    class _Driver:
        def execute_script(self, script: str, selector: str):
            assert selector == 'kat-checkbox[data-testid="agl-eligible-checkbox"]'
            assert 'div[part~="checkbox-check"][role="checkbox"]' in script
            assert script.index("clickElement(checkNode)") < script.index("clickElement(checkbox)")
            return True

    assert send_to_amazon._click_agl_checkbox(_Driver()) is True


def test_read_agl_checkbox_state_checks_inner_aria_checked() -> None:
    class _Driver:
        def execute_script(self, script: str, selector: str):
            assert selector == 'kat-checkbox[data-testid="agl-eligible-checkbox"]'
            assert 'div[part~="checkbox-check"][role="checkbox"]' in script
            assert "getAttribute('aria-checked') === 'true'" in script
            assert ".includes('checked')" in script
            return {"found": True, "checked": True}

    assert send_to_amazon._read_agl_checkbox_state(_Driver()) == {"found": True, "checked": True}


def test_ensure_agl_unchecked_raises_when_still_checked(monkeypatch: pytest.MonkeyPatch) -> None:
    clock = {"now": 0.0}
    monkeypatch.setattr(send_to_amazon, "_read_agl_checkbox_state", lambda _driver: {"found": True, "checked": True})
    monkeypatch.setattr(send_to_amazon, "_click_agl_checkbox", lambda _driver: True)
    monkeypatch.setattr(send_to_amazon.time, "time", lambda: clock["now"])
    monkeypatch.setattr(
        send_to_amazon.time,
        "sleep",
        lambda seconds: clock.__setitem__("now", clock["now"] + float(seconds)),
    )

    with pytest.raises(RuntimeError, match="取消亚马逊全球物流勾选失败"):
        send_to_amazon._ensure_agl_unchecked(object(), timeout_seconds=0.5)


def test_ensure_agl_unchecked_raises_when_click_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(send_to_amazon, "_read_agl_checkbox_state", lambda _driver: {"found": True, "checked": True})
    monkeypatch.setattr(send_to_amazon, "_click_agl_checkbox", lambda _driver: False)

    with pytest.raises(RuntimeError, match="取消亚马逊全球物流勾选失败"):
        send_to_amazon._ensure_agl_unchecked(object())


def test_open_send_to_amazon_upload_mode_clears_agl_after_file_upload(monkeypatch: pytest.MonkeyPatch) -> None:
    session = _FakeSession("https://sellercentral.amazon.co.uk/home")
    states = iter(
        [
            {"has_file_upload_radio": True},
            {"has_template_download": True},
        ]
    )
    calls: list[str] = []

    def fake_probe(_driver):
        calls.append("probe")
        return next(states)

    monkeypatch.setattr(send_to_amazon, "_probe_send_to_amazon_state", fake_probe)
    monkeypatch.setattr(send_to_amazon, "_click_file_upload_mode", lambda _driver: calls.append("click_file_upload") or True)
    monkeypatch.setattr(
        send_to_amazon,
        "_ensure_agl_unchecked",
        lambda _driver: calls.append("ensure_agl") or {"found": True, "checked": False, "clicked": False},
    )
    monkeypatch.setattr(send_to_amazon.time, "sleep", lambda _seconds: None)

    payload = send_to_amazon.open_send_to_amazon_upload_mode(session, timeout_seconds=10)

    assert payload == {"state": {"has_template_download": True}}
    assert calls == ["probe", "click_file_upload", "ensure_agl", "probe", "ensure_agl"]


def test_open_send_to_amazon_upload_mode_reprobes_after_agl_click(monkeypatch: pytest.MonkeyPatch) -> None:
    session = _FakeSession("https://sellercentral.amazon.co.uk/home")
    states = iter(
        [
            {"has_template_download": True},
            {"has_template_download": True},
        ]
    )
    agl_states = iter(
        [
            {"found": True, "checked": False, "clicked": True},
            {"found": True, "checked": False, "clicked": False},
        ]
    )
    calls: list[str] = []

    def fake_probe(_driver):
        calls.append("probe")
        return next(states)

    def fake_ensure(_driver):
        calls.append("ensure_agl")
        return next(agl_states)

    monkeypatch.setattr(send_to_amazon, "_probe_send_to_amazon_state", fake_probe)
    monkeypatch.setattr(send_to_amazon, "_ensure_agl_unchecked", fake_ensure)
    monkeypatch.setattr(send_to_amazon.time, "sleep", lambda _seconds: None)

    payload = send_to_amazon.open_send_to_amazon_upload_mode(session, timeout_seconds=10)

    assert payload == {"state": {"has_template_download": True}}
    assert calls == ["probe", "ensure_agl", "probe", "ensure_agl"]
