from __future__ import annotations

import pytest

from services.agent_cli.browser.amazon_common import region_switch


class _Driver:
    def __init__(self, current_url: str = "https://sellercentral.amazon.com/home") -> None:
        self.current_url = current_url


class _Session:
    def __init__(self, current_url: str = "https://sellercentral.amazon.com/home") -> None:
        self.driver = _Driver(current_url)
        self.opened_urls: list[str] = []

    def open_url(self, url: str) -> dict[str, str]:
        self.opened_urls.append(str(url))
        return {"screenshot_path": "switcher.png"}


def _patch_successful_switcher(
    monkeypatch,
    *,
    current_path: str,
    initial_label: str = "",
    home_label: str = "日本",
    option_label: str = "日本",
) -> list[tuple[object, int]]:
    verify_calls: list[tuple[object, int]] = []
    monkeypatch.setattr(region_switch.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(
        region_switch,
        "_wait_for_switcher_options",
        lambda *_args, **_kwargs: {
            "options": [{"label": option_label, "aid": "aid-target"}],
            "confirm_aid": "aid-confirm",
        },
    )
    monkeypatch.setattr(region_switch, "_click_switcher_region", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(region_switch, "_click_switcher_confirm", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(region_switch, "_read_home_region_label", lambda *_args, **_kwargs: initial_label)
    monkeypatch.setattr(region_switch, "_read_current_path", lambda _driver: current_path)
    monkeypatch.setattr(region_switch, "_wait_for_home_region_match", lambda *_args, **_kwargs: home_label)

    def fake_verify(driver, *, timeout_seconds: int):
        verify_calls.append((driver, timeout_seconds))
        return {"handled": True, "click_count": 1, "last_path": "/home", "notice": "登录验证已完成"}

    monkeypatch.setattr(region_switch, "verify_seller_central_login", fake_verify)
    return verify_calls


@pytest.mark.parametrize("site", ["AU", "Australia", "澳大利亚"])
def test_normalize_site_code_accepts_australia(site: str) -> None:
    assert region_switch.normalize_site_code(site) == "AU"


def test_site_aliases_include_australia() -> None:
    aliases = region_switch.site_aliases("AU")

    assert "AUSTRALIA" in aliases
    assert "澳大利亚" in aliases


def test_switch_region_skips_switcher_when_current_label_matches_target(monkeypatch) -> None:
    monkeypatch.setattr(region_switch.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(region_switch, "_read_home_region_label", lambda _session: "英国")
    monkeypatch.setattr(
        region_switch,
        "_wait_for_switcher_options",
        lambda *_args, **_kwargs: pytest.fail("should not read switcher options"),
    )
    monkeypatch.setattr(
        region_switch,
        "_click_switcher_region",
        lambda *_args, **_kwargs: pytest.fail("should not click target region"),
    )
    monkeypatch.setattr(
        region_switch,
        "_click_switcher_confirm",
        lambda *_args, **_kwargs: pytest.fail("should not click confirm"),
    )
    session = _Session()

    result = region_switch.switch_region(session, "UK", timeout_seconds=45)

    assert result == {
        "site": "UK",
        "switched": False,
        "current_label": "英国",
        "available_options": [],
        "screenshots": [],
    }
    assert session.opened_urls == []


def test_switch_region_opens_switcher_when_current_label_does_not_match(monkeypatch) -> None:
    _patch_successful_switcher(
        monkeypatch,
        current_path="/home",
        initial_label="日本",
        home_label="英国",
        option_label="英国",
    )
    session = _Session()

    result = region_switch.switch_region(session, "UK", timeout_seconds=45)

    assert result["switched"] is True
    assert result["current_label"] == "英国"
    assert len(session.opened_urls) == 1


def test_switch_region_opens_switcher_when_current_label_is_empty(monkeypatch) -> None:
    _patch_successful_switcher(
        monkeypatch,
        current_path="/home",
        initial_label="",
        home_label="英国",
        option_label="英国",
    )
    session = _Session()

    result = region_switch.switch_region(session, "UK", timeout_seconds=45)

    assert result["switched"] is True
    assert result["current_label"] == "英国"
    assert len(session.opened_urls) == 1


def test_switch_region_does_not_verify_login_when_not_on_login_path(monkeypatch) -> None:
    verify_calls = _patch_successful_switcher(monkeypatch, current_path="/home")
    session = _Session()

    result = region_switch.switch_region(session, "JP", timeout_seconds=45)

    assert result["switched"] is True
    assert result["current_label"] == "日本"
    assert verify_calls == []


def test_switch_region_supports_australia_labels(monkeypatch) -> None:
    _patch_successful_switcher(
        monkeypatch,
        current_path="/home",
        home_label="澳大利亚",
        option_label="Australia",
    )
    session = _Session()

    result = region_switch.switch_region(session, "AU", timeout_seconds=45)

    assert result["switched"] is True
    assert result["site"] == "AU"
    assert result["current_label"] == "澳大利亚"


def test_switch_region_opens_switcher_on_current_origin(monkeypatch) -> None:
    _patch_successful_switcher(monkeypatch, current_path="/home")
    session = _Session("https://sellercentral-japan.amazon.com/home")

    result = region_switch.switch_region(session, "JP", timeout_seconds=45)

    assert result["switched"] is True
    assert session.opened_urls == [
        "https://sellercentral-japan.amazon.com/account-switcher/default/merchantMarketplace"
    ]


def test_switch_region_verifies_login_after_confirm_on_signin(monkeypatch) -> None:
    verify_calls = _patch_successful_switcher(monkeypatch, current_path="/ap/signin")
    session = _Session()

    result = region_switch.switch_region(session, "JP", timeout_seconds=45)

    assert result["switched"] is True
    assert verify_calls == [(session.driver, 45)]


def test_switch_region_verifies_login_after_confirm_on_mfa(monkeypatch) -> None:
    verify_calls = _patch_successful_switcher(monkeypatch, current_path="/ap/mfa")
    session = _Session()

    result = region_switch.switch_region(session, "JP", timeout_seconds=45)

    assert result["switched"] is True
    assert verify_calls == [(session.driver, 45)]


def test_switch_region_stops_when_login_verify_requires_manual_action(monkeypatch) -> None:
    _patch_successful_switcher(monkeypatch, current_path="/ap/signin")
    monkeypatch.setattr(
        region_switch,
        "verify_seller_central_login",
        lambda *_args, **_kwargs: {
            "manual_required": True,
            "click_count": 10,
            "notice": "登录验证自动点击已达上限，仍停留在登录页面，请让用户手动完成登录验证",
        },
    )
    session = _Session()

    with pytest.raises(RuntimeError, match="请让用户手动完成登录验证，共点击 10 次"):
        region_switch.switch_region(session, "JP", timeout_seconds=45)


def test_switch_region_propagates_login_verify_failure(monkeypatch) -> None:
    _patch_successful_switcher(monkeypatch, current_path="/ap/signin")

    def fail_login(*_args, **_kwargs):
        raise RuntimeError("等待登录验证完成超时: path=/ap/signin")

    monkeypatch.setattr(region_switch, "verify_seller_central_login", fail_login)
    session = _Session()

    with pytest.raises(RuntimeError, match="等待登录验证完成超时: path=/ap/signin"):
        region_switch.switch_region(session, "JP", timeout_seconds=45)
