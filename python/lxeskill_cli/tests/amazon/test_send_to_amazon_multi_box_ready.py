from __future__ import annotations

from typing import Any

from services.agent_cli.browser.amazon_common import send_to_amazon_multi_box as multi_box


class _FakeDriver:
    def __init__(
        self,
        *,
        has_multi_box_radio: bool,
        ready_sku_notice: str = "",
        has_pack_group_controls: bool = False,
    ) -> None:
        self.has_multi_box_radio = bool(has_multi_box_radio)
        self.ready_sku_notice = str(ready_sku_notice or "")
        self.has_pack_group_controls = bool(has_pack_group_controls)

    def execute_script(self, _script: str, *args: Any) -> Any:
        selector = str(args[0] or "") if args else ""
        if selector == 'input[name="cli-input-method"][value="MULTI_BOX_WEBFORM"]':
            return self.has_multi_box_radio
        if selector == '[data-testid="pack-group-controls"]':
            return self.has_pack_group_controls
        if selector == '[data-testid="bold-translation"]':
            return self.ready_sku_notice
        return False


class _FakeSession:
    def __init__(self, driver: _FakeDriver) -> None:
        self.driver = driver


class _PackingMethodDriver:
    def __init__(self, *, standard_selected: bool, recommended_selected: bool = True) -> None:
        self.standard_selected = bool(standard_selected)
        self.recommended_selected = bool(recommended_selected)
        self.click_count = 0

    def execute_script(self, script: str, *args: Any) -> Any:
        if args and args[0] == multi_box._PACKING_METHOD_BOX_SELECTOR:
            if len(args) >= 3 and args[2] == multi_box._STANDARD_PACKING_METHOD_TEXT:
                self.click_count += 1
                self.standard_selected = True
                return True
            if len(args) >= 2 and args[1] == multi_box._STANDARD_PACKING_METHOD_TEXT:
                return "selected" if self.standard_selected else "not_selected"
            return "selected" if self.recommended_selected else "not_selected"
        return False


def test_probe_multi_box_ready_true_when_radio_exists() -> None:
    session = _FakeSession(_FakeDriver(has_multi_box_radio=True))

    assert multi_box.probe_multi_box_ready(session, timeout_seconds=1) == {
        "ready": True,
        "notice": "",
    }


def test_probe_multi_box_ready_clicks_packing_method_before_radio(monkeypatch) -> None:
    session = _FakeSession(_FakeDriver(has_multi_box_radio=False))
    calls: list[str] = []
    radio_states = iter([False, True])
    monkeypatch.setattr(
        multi_box,
        "_has_multi_box_radio",
        lambda _driver: calls.append("has_radio") or next(radio_states),
    )
    monkeypatch.setattr(
        multi_box,
        "_wait_click_packing_method_box_or_skip",
        lambda _driver, **_kwargs: calls.append("wait_packing_method") or True,
    )

    assert multi_box.probe_multi_box_ready(session, timeout_seconds=1) == {
        "ready": True,
        "notice": "",
    }
    assert calls == ["has_radio", "wait_packing_method", "has_radio"]


def test_probe_multi_box_ready_ignores_ready_sku_notice_without_radio(monkeypatch) -> None:
    session = _FakeSession(
        _FakeDriver(
            has_multi_box_radio=False,
            ready_sku_notice="准备发送的 SKU：65（2185 件商品）",
        )
    )
    ticks = iter([0.0, 0.0, 2.0])
    monkeypatch.setattr(multi_box.time, "time", lambda: next(ticks))
    monkeypatch.setattr(multi_box.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(multi_box, "_wait_click_packing_method_box_or_skip", lambda _driver, **_kwargs: False)

    assert multi_box.probe_multi_box_ready(session, timeout_seconds=1) == {
        "ready": False,
        "notice": "",
    }


def test_probe_multi_box_ready_stays_not_ready_when_packing_method_clicked_but_radio_missing(monkeypatch) -> None:
    session = _FakeSession(_FakeDriver(has_multi_box_radio=False))
    ticks = iter([0.0, 0.0, 2.0])
    wait_calls: list[str] = []
    monkeypatch.setattr(multi_box.time, "time", lambda: next(ticks))
    monkeypatch.setattr(multi_box.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(
        multi_box,
        "_wait_click_packing_method_box_or_skip",
        lambda _driver, **_kwargs: wait_calls.append("wait") or True,
    )

    assert multi_box.probe_multi_box_ready(session, timeout_seconds=1) == {
        "ready": False,
        "notice": "",
    }
    assert wait_calls == ["wait"]


def test_probe_multi_box_ready_false_without_radio(monkeypatch) -> None:
    session = _FakeSession(_FakeDriver(has_multi_box_radio=False))
    ticks = iter([0.0, 0.0, 2.0])
    monkeypatch.setattr(multi_box.time, "time", lambda: next(ticks))
    monkeypatch.setattr(multi_box.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(multi_box, "_wait_click_packing_method_box_or_skip", lambda _driver, **_kwargs: False)

    assert multi_box.probe_multi_box_ready(session, timeout_seconds=1) == {
        "ready": False,
        "notice": "",
    }


def test_wait_click_packing_method_succeeds_when_controls_exist_and_box_selected(monkeypatch) -> None:
    driver = object()
    click_calls: list[str] = []
    monkeypatch.setattr(multi_box, "_has_pack_group_controls", lambda _driver: True)
    monkeypatch.setattr(multi_box, "_has_multi_box_radio", lambda _driver: False)
    monkeypatch.setattr(multi_box, "_read_packing_method_box_state", lambda _driver: "selected")
    monkeypatch.setattr(
        multi_box,
        "_click_packing_method_box_if_present",
        lambda _driver: click_calls.append("click") or True,
    )

    assert multi_box._wait_click_packing_method_box_or_skip(driver, timeout_seconds=5) is True
    assert click_calls == []


def test_wait_click_packing_method_clicks_not_selected_box_until_ready(monkeypatch) -> None:
    driver = object()
    sleeps: list[float] = []
    pack_group_visible = False
    box_state = "not_selected"
    click_calls: list[str] = []

    def click_box(_driver: object) -> bool:
        nonlocal pack_group_visible, box_state
        click_calls.append("click")
        pack_group_visible = True
        box_state = "selected"
        return True

    monkeypatch.setattr(multi_box, "_has_pack_group_controls", lambda _driver: pack_group_visible)
    monkeypatch.setattr(multi_box, "_has_multi_box_radio", lambda _driver: False)
    monkeypatch.setattr(multi_box, "_read_packing_method_box_state", lambda _driver: box_state)
    monkeypatch.setattr(multi_box, "_click_packing_method_box_if_present", click_box)
    monkeypatch.setattr(multi_box.time, "sleep", lambda seconds: sleeps.append(float(seconds)))

    assert multi_box._wait_click_packing_method_box_or_skip(driver, timeout_seconds=5) is True
    assert click_calls == ["click"]
    assert sleeps == [0.5]


def test_wait_click_packing_method_selected_without_controls_is_not_complete(monkeypatch) -> None:
    driver = object()
    ticks = iter([0.0, 0.0, 5.1])
    click_calls: list[str] = []
    monkeypatch.setattr(multi_box.time, "time", lambda: next(ticks))
    monkeypatch.setattr(multi_box.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(multi_box, "_has_pack_group_controls", lambda _driver: False)
    monkeypatch.setattr(multi_box, "_has_multi_box_radio", lambda _driver: False)
    monkeypatch.setattr(multi_box, "_read_packing_method_box_state", lambda _driver: "selected")
    monkeypatch.setattr(
        multi_box,
        "_click_packing_method_box_if_present",
        lambda _driver: click_calls.append("click") or True,
    )

    assert multi_box._wait_click_packing_method_box_or_skip(driver, timeout_seconds=5) is False
    assert click_calls == []


def test_wait_click_packing_method_returns_false_when_two_clicks_do_not_change_state(monkeypatch) -> None:
    driver = object()
    sleeps: list[float] = []
    click_calls: list[str] = []
    monkeypatch.setattr(multi_box.time, "sleep", lambda seconds: sleeps.append(float(seconds)))
    monkeypatch.setattr(multi_box, "_has_pack_group_controls", lambda _driver: False)
    monkeypatch.setattr(multi_box, "_has_multi_box_radio", lambda _driver: False)
    monkeypatch.setattr(multi_box, "_read_packing_method_box_state", lambda _driver: "not_selected")
    monkeypatch.setattr(
        multi_box,
        "_click_packing_method_box_if_present",
        lambda _driver: click_calls.append("click") or True,
    )

    assert multi_box._wait_click_packing_method_box_or_skip(driver, timeout_seconds=5) is False
    assert sleeps == [0.5, 0.5]
    assert click_calls == ["click", "click"]


def test_packing_method_state_ignores_selected_recommended_box() -> None:
    driver = _PackingMethodDriver(standard_selected=False, recommended_selected=True)

    assert multi_box._read_packing_method_box_state(driver) == "not_selected"


def test_packing_method_click_targets_standard_box() -> None:
    driver = _PackingMethodDriver(standard_selected=False, recommended_selected=True)

    assert multi_box._click_packing_method_box_if_present(driver) is True
    assert driver.standard_selected is True
    assert driver.click_count == 1
