from __future__ import annotations

from datetime import date

import pytest

from services.agent_cli.browser.amazon_common import own_carrier


def test_detect_own_carrier_layout_phase_3_2_takes_priority(monkeypatch) -> None:
    def fake_has_selector(_driver, selector: str) -> bool:
        return selector in {
            '[data-testid="cross-border-non-pcp-box-test-id"]',
            'kat-option[value="PCP"]',
            'kat-option[value="nPCP"]',
        }

    monkeypatch.setattr(own_carrier, "_has_selector", fake_has_selector)

    assert own_carrier._detect_own_carrier_layout(object()) == "phase_3_2"


def test_detect_own_carrier_layout_phase_3_1(monkeypatch) -> None:
    def fake_has_selector(_driver, selector: str) -> bool:
        return selector in {'kat-option[value="PCP"]', 'kat-option[value="nPCP"]'}

    monkeypatch.setattr(own_carrier, "_has_selector", fake_has_selector)

    assert own_carrier._detect_own_carrier_layout(object()) == "phase_3_1"


def test_detect_own_carrier_layout_legacy(monkeypatch) -> None:
    monkeypatch.setattr(own_carrier, "_has_selector", lambda _driver, _selector: False)

    assert own_carrier._detect_own_carrier_layout(object()) == "legacy"


def test_phase_3_1_selects_date_updates_and_skips_transport_mode(monkeypatch) -> None:
    calls: list[str] = []
    driver = object()
    target_date = date(2026, 5, 20)

    def fake_wait_for_click(step_name, clicker, **_kwargs):
        calls.append(f"wait_click:{step_name}")
        assert clicker() is True

    def fake_wait_for_condition(step_name, checker, **_kwargs):
        calls.append(f"wait_condition:{step_name}")
        assert checker() is True

    monkeypatch.setattr(own_carrier, "_wait_for_click", fake_wait_for_click)
    monkeypatch.setattr(own_carrier, "_wait_for_condition", fake_wait_for_condition)
    monkeypatch.setattr(
        own_carrier,
        "_wait_phase_3_2_refresh_after_selection",
        lambda: pytest.fail("phase_3_1 should not wait for phase_3_2 refresh"),
    )
    monkeypatch.setattr(
        own_carrier,
        "_select_non_amazon_partner_carrier_type",
        lambda _driver: calls.append("select_npcp") or True,
    )
    monkeypatch.setattr(own_carrier, "_click_phase_3_1_date_input", lambda _driver: calls.append("click_date") or True)
    monkeypatch.setattr(own_carrier, "_calendar_visible", lambda _driver: calls.append("calendar_visible") or True)
    monkeypatch.setattr(
        own_carrier,
        "_select_pickup_date",
        lambda _driver, selected_date, **_kwargs: calls.append(f"select_date:{selected_date.isoformat()}"),
    )
    monkeypatch.setattr(own_carrier, "_click_delivery_window_modal_confirm_button", lambda _driver: calls.append("update") or True)
    monkeypatch.setattr(
        own_carrier,
        "_open_phase_3_1_carrier_dropdown",
        lambda _driver: pytest.fail("phase_3_1 should not open carrier dropdown"),
    )
    monkeypatch.setattr(own_carrier, "_select_phase_3_1_other_carrier", lambda _driver: calls.append("select_other") or True)
    own_carrier._select_pickup_date_for_layout(
        driver,
        target_date,
        layout="phase_3_1",
        timeout_seconds=60,
    )
    own_carrier._select_carrier_mode_for_layout(
        driver,
        {"ui_text": "空运"},
        layout="phase_3_1",
        timeout_seconds=60,
    )

    assert calls == [
        "wait_click:非亚马逊合作承运人选项",
        "select_npcp",
        "wait_click:计划送达日期输入框",
        "click_date",
        "wait_condition:日历出现",
        "calendar_visible",
        "select_date:2026-05-20",
        "wait_click:日期更新按钮",
        "update",
        "wait_click:其他承运人选项",
        "select_other",
    ]


def test_phase_3_1_date_input_clicks_arrival_delivery_window_inner_input(monkeypatch) -> None:
    driver = object()
    seen_args: list[str] = []

    def fake_execute(_driver, script: str, selector: str):
        seen_args.append(selector)
        assert 'input[part="input"]' in script
        assert 'input[type="text"]' in script
        assert "plan-delivery-window-input" not in script
        assert "el.focus" in script
        assert "pointerdown" in script
        return True

    monkeypatch.setattr(own_carrier, "_execute_page_script", fake_execute)

    assert own_carrier._click_phase_3_1_date_input(driver) is True
    assert seen_args == ['[data-testid="arrival-edit-delivery-window-link"]']


def test_phase_3_1_non_amazon_partner_uses_npcp_penetrating_click(monkeypatch) -> None:
    driver = object()
    calls: list[str] = []

    monkeypatch.setattr(
        own_carrier,
        "_select_dropdown_option_by_value",
        lambda _driver, selector, value, **kwargs: calls.append(f"{selector}:{value}:{kwargs['option_text']}") or True,
    )
    monkeypatch.setattr(
        own_carrier,
        "_select_option_by_text",
        lambda *_args, **_kwargs: pytest.fail("phase_3_1 should not require visible option text"),
    )

    assert own_carrier._select_non_amazon_partner_carrier_type(driver) is True
    assert calls == [
        f"{own_carrier._CARRIER_TYPE_PLACEMENT_DROPDOWN_SELECTOR}:nPCP:非亚马逊合作承运人"
    ]


def test_phase_3_1_other_carrier_uses_shipping_dropdown_penetrating_click(monkeypatch) -> None:
    driver = object()
    calls: list[str] = []

    monkeypatch.setattr(
        own_carrier,
        "_select_dropdown_option_by_value",
        lambda _driver, selector, value, **kwargs: calls.append(f"{selector}:{value}:{kwargs['option_text']}") or True,
    )
    monkeypatch.setattr(
        own_carrier,
        "_select_option_by_text",
        lambda *_args, **_kwargs: pytest.fail("phase_3_1 should not require visible carrier option text"),
    )

    assert own_carrier._select_phase_3_1_other_carrier(driver) is True
    assert calls == [
        f"{own_carrier._SHIPPING_CARRIER_NON_PCP_DROPDOWN_SELECTOR}:OTHER:其他"
    ]


def test_phase_3_2_selects_date_transport_and_carrier_without_update(monkeypatch) -> None:
    calls: list[str] = []
    driver = object()
    target_date = date(2026, 5, 20)

    def fake_wait_for_click(step_name, clicker, **_kwargs):
        calls.append(f"wait_click:{step_name}")
        assert clicker() is True

    def fake_wait_for_condition(step_name, checker, **_kwargs):
        calls.append(f"wait_condition:{step_name}")
        assert checker() is True

    monkeypatch.setattr(own_carrier, "_wait_for_click", fake_wait_for_click)
    monkeypatch.setattr(own_carrier, "_wait_for_condition", fake_wait_for_condition)
    monkeypatch.setattr(own_carrier, "_wait_phase_3_2_refresh_after_selection", lambda: calls.append("refresh_wait"))
    monkeypatch.setattr(own_carrier, "_click_phase_3_2_date_input", lambda _driver: calls.append("click_date") or True)
    monkeypatch.setattr(own_carrier, "_phase_3_2_calendar_visible", lambda _driver: calls.append("scoped_calendar_visible") or True)
    monkeypatch.setattr(
        own_carrier,
        "_select_phase_3_2_pickup_date",
        lambda _driver, selected_date, **_kwargs: calls.append(f"select_date:{selected_date.isoformat()}"),
    )
    monkeypatch.setattr(
        own_carrier,
        "_click_delivery_window_modal_confirm_button",
        lambda _driver: pytest.fail("phase_3_2 should not click date update"),
    )
    monkeypatch.setattr(
        own_carrier,
        "_select_phase_3_2_dropdown_value",
        lambda _driver, **kwargs: calls.append(f"select_dropdown:{kwargs['step_name']}:{kwargs['option_value']}"),
    )

    own_carrier._select_pickup_date_for_layout(
        driver,
        target_date,
        layout="phase_3_2",
        timeout_seconds=60,
    )
    own_carrier._select_carrier_mode_for_layout(
        driver,
        {"canonical": "OCEAN", "ui_text": "海运"},
        layout="phase_3_2",
        timeout_seconds=60,
    )

    assert calls == [
        "wait_click:计划送达日期输入框",
        "click_date",
        "wait_condition:送达时段日历出现",
        "scoped_calendar_visible",
        "select_date:2026-05-20",
        "refresh_wait",
        "select_dropdown:海运运输方式:OCEAN",
        "select_dropdown:非合作承运人:OTHER",
        "select_dropdown:海运运输方式:OCEAN",
        "select_dropdown:非合作承运人:OTHER",
    ]


def test_phase_3_2_date_input_uses_delivery_window_picker(monkeypatch) -> None:
    driver = object()
    seen_args: list[tuple[str, str]] = []

    def fake_execute(_driver, script: str, section_selector: str, picker_selector: str):
        seen_args.append((section_selector, picker_selector))
        assert "placeholder=\"YYYY/MM/DD\"" not in script
        assert "deepQuerySelector(pickerSelector, section)" in script
        return True

    monkeypatch.setattr(own_carrier, "_execute_page_script", fake_execute)

    assert own_carrier._click_phase_3_2_date_input(driver) is True
    assert seen_args == [
        (
            'kat-accordion-item[data-testid="delivery-window-section-accordion-header"]',
            'kat-date-picker[data-testid="delivery-window-date-picker"]',
        )
    ]


def test_phase_3_2_calendar_day_uses_delivery_window_picker_scope(monkeypatch) -> None:
    driver = object()
    seen_args: list[tuple[str, str, str]] = []

    def fake_execute(_driver, script: str, section_selector: str, picker_selector: str, label_prefix: str):
        seen_args.append((section_selector, picker_selector, label_prefix))
        assert "getScopedCalendar()" in script
        assert "scopedQuerySelectorAll('button[aria-label]', calendar)" in script
        assert "deepQuerySelectorAll('button[aria-label]')" not in script
        return True

    monkeypatch.setattr(own_carrier, "_execute_page_script", fake_execute)

    assert own_carrier._click_phase_3_2_calendar_day(driver, date(2026, 5, 20)) is True
    assert seen_args == [
        (
            'kat-accordion-item[data-testid="delivery-window-section-accordion-header"]',
            'kat-date-picker[data-testid="delivery-window-date-picker"]',
            "2026年5月20日",
        )
    ]


def test_phase_3_2_ship_date_input_uses_ship_date_picker(monkeypatch) -> None:
    driver = object()
    seen_args: list[tuple[str, list[str]]] = []

    def fake_execute(_driver, script: str, picker_selector: str, fallback_selectors: list[str]):
        seen_args.append((picker_selector, fallback_selectors))
        assert "getShipDatePicker()" in script
        assert "delivery-window-date-picker" not in script
        assert "kat-input" not in script
        assert "placeholder=\"YYYY/MM/DD\"" not in script
        return True

    monkeypatch.setattr(own_carrier, "_execute_page_script", fake_execute)

    assert own_carrier._click_phase_3_2_ship_date_input(driver) is True
    assert seen_args == [
        (
            'kat-date-picker[data-testid="kat-ship-date-picker"]',
            ["kat-date-picker#sendByDatePicker", 'kat-date-picker[kat-aria-label="发货日期"]'],
        )
    ]


def test_phase_3_2_ship_date_calendar_day_uses_ship_date_scope(monkeypatch) -> None:
    driver = object()
    seen_args: list[tuple[str, list[str], str]] = []

    def fake_execute(_driver, script: str, picker_selector: str, fallback_selectors: list[str], label_prefix: str):
        seen_args.append((picker_selector, fallback_selectors, label_prefix))
        assert "getScopedCalendar()" in script
        assert "getShipDatePicker()" in script
        assert "scopedQuerySelectorAll('button[aria-label]', calendar)" in script
        assert "deepQuerySelectorAll('button[aria-label]')" not in script
        assert "delivery-window-date-picker" not in script
        return True

    monkeypatch.setattr(own_carrier, "_execute_page_script", fake_execute)

    assert own_carrier._click_phase_3_2_ship_date_calendar_day(driver, date(2026, 5, 7)) is True
    assert seen_args == [
        (
            'kat-date-picker[data-testid="kat-ship-date-picker"]',
            ["kat-date-picker#sendByDatePicker", 'kat-date-picker[kat-aria-label="发货日期"]'],
            "2026年5月7日",
        )
    ]


def test_select_phase_3_2_ship_date_reclicks_when_picker_value_matches(monkeypatch) -> None:
    driver = object()
    calls: list[str] = []
    state = {"calendar_visible": False}

    def fake_wait_for_click(step_name, clicker, **_kwargs):
        calls.append(f"wait_click:{step_name}")
        assert clicker() is True

    def fake_wait_for_condition(step_name, checker, **_kwargs):
        calls.append(f"wait_condition:{step_name}")
        assert checker() is True

    monkeypatch.setattr(own_carrier, "_wait_for_click", fake_wait_for_click)
    monkeypatch.setattr(own_carrier, "_wait_for_condition", fake_wait_for_condition)
    monkeypatch.setattr(own_carrier, "_phase_3_2_ship_date_value_matches", lambda _driver, _ship_date: True)
    monkeypatch.setattr(own_carrier, "_phase_3_2_ship_date_calendar_visible", lambda _driver: calls.append("calendar_visible") or state["calendar_visible"])
    monkeypatch.setattr(own_carrier, "_click_phase_3_2_ship_date_input", lambda _driver: calls.append("click_input") or state.__setitem__("calendar_visible", True) or True)

    own_carrier._select_phase_3_2_ship_date(driver, date(2026, 5, 7), timeout_seconds=5)

    assert calls == [
        "calendar_visible",
        "wait_click:发货日期输入框",
        "click_input",
        "wait_condition:发货日期日历出现",
        "calendar_visible",
    ]


def test_date_picker_value_matches_unpadded_ship_date() -> None:
    assert own_carrier._date_picker_value_matches("2026/5/7", date(2026, 5, 7)) is True
    assert own_carrier._date_picker_value_matches("2026/05/07", date(2026, 5, 7)) is True
    assert own_carrier._date_picker_value_matches("2026/5/8", date(2026, 5, 7)) is False


def test_phase_3_2_reselects_transport_then_carrier_when_values_already_match(monkeypatch) -> None:
    driver = object()
    calls: list[str] = []

    def fake_select_dropdown(_driver, **kwargs):
        calls.append(
            f"{kwargs['dropdown_selector']}:{kwargs['option_value']}:{kwargs['option_text']}"
        )

    monkeypatch.setattr(own_carrier, "_select_phase_3_2_dropdown_value", fake_select_dropdown)

    own_carrier._select_carrier_mode_for_layout(
        driver,
        {"canonical": "AIR", "ui_text": "空运"},
        layout="phase_3_2",
        timeout_seconds=60,
    )

    assert calls == [
        f"{own_carrier._TRANSPORTATION_MODE_DROPDOWN_SELECTOR}:AIR:空运",
        f"{own_carrier._NON_PCP_CARRIER_CHOICES_SELECTOR}:OTHER:其他",
        f"{own_carrier._TRANSPORTATION_MODE_DROPDOWN_SELECTOR}:AIR:空运",
        f"{own_carrier._NON_PCP_CARRIER_CHOICES_SELECTOR}:OTHER:其他",
    ]


def test_select_phase_3_2_dropdown_value_clicks_option_and_waits(monkeypatch) -> None:
    calls: list[str] = []
    driver = object()

    def fake_wait_for_click(step_name, clicker, **_kwargs):
        calls.append(f"wait_click:{step_name}")
        assert clicker() is True

    monkeypatch.setattr(own_carrier, "_wait_for_click", fake_wait_for_click)
    monkeypatch.setattr(
        own_carrier,
        "_select_dropdown_option_by_value",
        lambda _driver, selector, value, **kwargs: calls.append(f"select_option:{selector}:{value}:{kwargs['option_text']}") or True,
    )
    monkeypatch.setattr(
        own_carrier,
        "_wait_for_dropdown_value",
        lambda _driver, **kwargs: calls.append(f"value:{kwargs['dropdown_selector']}:{kwargs['expected_value']}"),
    )
    monkeypatch.setattr(own_carrier, "_wait_phase_3_2_refresh_after_selection", lambda: calls.append("refresh_wait"))

    own_carrier._select_phase_3_2_dropdown_value(
        driver,
        dropdown_selector="[data-testid='example']",
        option_value="OTHER",
        option_text="其他",
        step_name="非合作承运人",
        value_label="非合作承运人",
        timeout_seconds=60,
    )

    assert calls == [
        "wait_click:非合作承运人选项",
        "select_option:[data-testid='example']:OTHER:其他",
        "value:[data-testid='example']:OTHER",
        "refresh_wait",
    ]


def test_select_dropdown_option_prefers_dropdown_scope_then_global_dom(monkeypatch) -> None:
    driver = object()
    seen_args: list[tuple[str, str, str]] = []

    def fake_execute(_driver, script: str, dropdown_selector: str, option_value: str, option_text: str):
        seen_args.append((dropdown_selector, option_value, option_text))
        assert "if (dropdownSelector)" in script
        assert "const dropdown = deepQuerySelector(dropdownSelector)" in script
        assert "roots.push(document)" in script
        assert "collectOptions(root)" in script
        assert "isVisible" not in script
        assert "hasAttribute('expanded')" not in script
        return True

    monkeypatch.setattr(own_carrier, "_execute_page_script", fake_execute)

    assert own_carrier._select_dropdown_option_by_value(
        driver,
        "[data-testid='example']",
        "OTHER",
        option_text="其他",
    ) is True
    assert seen_args == [("[data-testid='example']", "OTHER", "其他")]


def test_select_dropdown_option_allows_empty_dropdown_selector(monkeypatch) -> None:
    driver = object()
    seen_args: list[tuple[str, str, str]] = []

    def fake_execute(_driver, script: str, dropdown_selector: str, option_value: str, option_text: str):
        seen_args.append((dropdown_selector, option_value, option_text))
        assert "if (dropdownSelector)" in script
        assert "roots.push(document)" in script
        return True

    monkeypatch.setattr(own_carrier, "_execute_page_script", fake_execute)

    assert own_carrier._select_dropdown_option_by_value(
        driver,
        "",
        "nPCP",
        option_text="非亚马逊合作承运人",
    ) is True
    assert seen_args == [("", "nPCP", "非亚马逊合作承运人")]


def test_confirm_modal_if_visible_skips_when_no_dialog(monkeypatch) -> None:
    calls: list[str] = []
    driver = object()

    monkeypatch.setattr(own_carrier, "_dialog_visible", lambda _driver: False)
    monkeypatch.setattr(own_carrier, "_click_confirm_modal", lambda _driver: calls.append("confirm") or True)

    assert own_carrier._confirm_modal_if_visible(driver) is True
    assert calls == []


def test_confirm_modal_if_visible_clicks_confirm_when_dialog_exists(monkeypatch) -> None:
    calls: list[str] = []
    driver = object()

    monkeypatch.setattr(own_carrier, "_dialog_visible", lambda _driver: True)
    monkeypatch.setattr(own_carrier, "_click_confirm_modal", lambda _driver: calls.append("confirm") or True)

    assert own_carrier._confirm_modal_if_visible(driver) is True
    assert calls == ["confirm"]


def test_prepare_phase_3_2_own_carrier_entry_clicks_card_and_optional_confirm(monkeypatch) -> None:
    calls: list[str] = []
    driver = object()

    def fake_wait_for_click(step_name, clicker, **_kwargs):
        calls.append(f"wait_click:{step_name}")
        assert clicker() is True

    monkeypatch.setattr(own_carrier, "_wait_for_click", fake_wait_for_click)
    monkeypatch.setattr(own_carrier, "_click_first_matching", lambda _driver, _selectors: calls.append("click_cross_border") or True)
    monkeypatch.setattr(own_carrier, "_confirm_modal_if_visible", lambda _driver: calls.append("confirm_modal_if_visible") or True)

    own_carrier._prepare_phase_3_2_own_carrier_entry(driver, timeout_seconds=60)

    assert calls == [
        "wait_click:非合作承运人入口",
        "click_cross_border",
        "wait_click:非合作承运人确认弹窗",
        "confirm_modal_if_visible",
    ]


def test_wait_collect_shipment_summaries_retries_until_success(monkeypatch) -> None:
    driver = object()
    calls: list[str] = []
    attempts = {"count": 0}
    summaries = [{"shipment_name": "FBA", "shipment_id": "FBA123", "shipment_tracking_id": "--", "send_to_address": "RDU2"}]

    def fake_collect(_driver):
        attempts["count"] += 1
        calls.append("collect")
        if attempts["count"] < 3:
            raise RuntimeError("未找到货件摘要区域 shipment-summary")
        return summaries

    monkeypatch.setattr(own_carrier, "_collect_shipment_summaries", fake_collect)
    monkeypatch.setattr(own_carrier, "_raise_if_returned_to_step2_start", lambda _driver: None)
    monkeypatch.setattr(own_carrier.time, "sleep", lambda _seconds: calls.append("sleep"))

    assert own_carrier._wait_collect_shipment_summaries(driver, timeout_seconds=10) == summaries
    assert calls == ["collect", "sleep", "collect", "sleep", "collect"]


def test_wait_collect_shipment_summaries_raises_last_error_after_timeout(monkeypatch) -> None:
    driver = object()
    clock = {"now": 0.0}
    calls: list[str] = []

    def fake_collect(_driver):
        calls.append("collect")
        raise RuntimeError(f"last failure {len(calls)}")

    monkeypatch.setattr(own_carrier, "_collect_shipment_summaries", fake_collect)
    monkeypatch.setattr(own_carrier, "_raise_if_returned_to_step2_start", lambda _driver: None)
    monkeypatch.setattr(own_carrier.time, "time", lambda: clock["now"])
    monkeypatch.setattr(own_carrier.time, "sleep", lambda seconds: clock.__setitem__("now", clock["now"] + float(seconds)))

    with pytest.raises(RuntimeError, match="last failure 2"):
        own_carrier._wait_collect_shipment_summaries(driver, timeout_seconds=1)
    assert calls == ["collect", "collect"]


def test_confirm_own_carrier_phase_3_2_selects_carrier_before_date(monkeypatch) -> None:
    calls: list[str] = []
    driver = object()
    session = type("Session", (), {"driver": driver})()

    monkeypatch.setattr(own_carrier, "_detect_own_carrier_layout", lambda _driver: "phase_3_2")
    monkeypatch.setattr(own_carrier, "calculate_pickup_date", lambda _transport_mode, **_kwargs: date(2026, 5, 20))
    monkeypatch.setattr(own_carrier, "normalize_transport_mode", lambda _transport_mode: {"canonical": "AIR", "ui_text": "空运"})
    monkeypatch.setattr(
        own_carrier,
        "_prepare_phase_3_2_own_carrier_entry",
        lambda _driver, **_kwargs: calls.append("prepare_entry"),
    )
    monkeypatch.setattr(
        own_carrier,
        "_select_carrier_mode_for_layout",
        lambda _driver, _mode, **_kwargs: calls.append("select_carrier_mode"),
    )
    monkeypatch.setattr(
        own_carrier,
        "_select_phase_3_2_ship_date",
        lambda _driver, selected_date, **_kwargs: calls.append(f"select_ship_date:{selected_date.isoformat()}"),
    )
    monkeypatch.setattr(
        own_carrier,
        "_select_pickup_date_for_layout",
        lambda _driver, _target_date, **_kwargs: calls.append("select_date"),
    )
    monkeypatch.setattr(own_carrier, "_wait_phase_3_2_refresh_after_selection", lambda: calls.append("refresh_wait"))
    monkeypatch.setattr(own_carrier, "_wait_phase_3_2_after_carrier_before_dates", lambda: calls.append("wait_after_carrier"))
    monkeypatch.setattr(own_carrier, "_wait_for_click", lambda _step_name, clicker, **_kwargs: calls.append("accept") or None)
    monkeypatch.setattr(own_carrier, "_wait_for_condition", lambda _step_name, checker, **_kwargs: calls.append("tracking_ready") or None)
    monkeypatch.setattr(own_carrier, "_collect_shipment_summaries", lambda _driver: pytest.fail("confirm flow should use retry helper"))
    monkeypatch.setattr(own_carrier, "_wait_collect_shipment_summaries", lambda _driver, **_kwargs: calls.append("collect_summaries") or [])
    monkeypatch.setattr(own_carrier, "_write_shipment_summary_excel", lambda *_args, **_kwargs: "")

    result = own_carrier.confirm_own_carrier_shipment(session, "空运", timeout_seconds=60, today=date(2026, 5, 7))

    assert result["notice"] == own_carrier._FINAL_SUCCESS_NOTICE
    assert calls[:5] == [
        "prepare_entry",
        "select_carrier_mode",
        "wait_after_carrier",
        "select_ship_date:2026-05-07",
        "refresh_wait",
    ]
    assert calls[5:6] == [
        "select_date",
    ]
    assert "collect_summaries" in calls


def test_phase_3_2_raises_when_carrier_value_stays_wrong(monkeypatch) -> None:
    driver = object()
    clock = {"now": 0.0}

    monkeypatch.setattr(own_carrier.time, "time", lambda: clock["now"])
    monkeypatch.setattr(own_carrier.time, "sleep", lambda seconds: clock.__setitem__("now", clock["now"] + float(seconds)))
    monkeypatch.setattr(own_carrier, "_dropdown_value_equals", lambda _driver, _selector, _expected: False)
    monkeypatch.setattr(own_carrier, "_read_dropdown_value", lambda _driver, _selector: "GUBB")

    with pytest.raises(RuntimeError, match="非合作承运人未选择为 OTHER"):
        own_carrier._wait_for_dropdown_value(
            driver,
            dropdown_selector=own_carrier._NON_PCP_CARRIER_CHOICES_SELECTOR,
            expected_value="OTHER",
            label="非合作承运人",
            timeout_seconds=1,
        )


def test_click_calendar_day_uses_prefix_match_and_skips_disabled(monkeypatch) -> None:
    driver = object()

    def fake_execute(_driver, script: str, label_prefix: str):
        assert label_prefix == "2026年5月20日"
        assert "startsWith(labelPrefix)" in script
        assert "aria-disabled" in script
        assert "classList.contains('disabled')" in script
        assert "pointerdown" in script
        return True

    monkeypatch.setattr(own_carrier, "_execute_page_script", fake_execute)

    assert own_carrier._click_calendar_day(driver, date(2026, 5, 20)) is True


def test_select_pickup_date_confirms_current_month_selection(monkeypatch) -> None:
    driver = object()
    selected = {"value": False}

    monkeypatch.setattr(own_carrier, "_calendar_visible", lambda _driver: True)
    monkeypatch.setattr(own_carrier, "_calendar_day_selected", lambda _driver, _target_date: selected["value"])
    monkeypatch.setattr(own_carrier, "_click_calendar_day", lambda _driver, _target_date: selected.__setitem__("value", True) or True)
    monkeypatch.setattr(own_carrier, "_read_calendar_month_label", lambda _driver: pytest.fail("current month should not be read after selection"))
    monkeypatch.setattr(own_carrier.time, "sleep", lambda _seconds: None)

    own_carrier._select_pickup_date(driver, date(2026, 5, 20), timeout_seconds=5)

    assert selected["value"] is True


def test_select_pickup_date_moves_to_next_month(monkeypatch) -> None:
    driver = object()
    state = {"month": 5, "selected": False}
    month_labels = {5: "五月 2026", 6: "六月 2026"}

    monkeypatch.setattr(own_carrier, "_calendar_visible", lambda _driver: True)
    monkeypatch.setattr(own_carrier, "_calendar_day_selected", lambda _driver, _target_date: state["selected"])
    monkeypatch.setattr(own_carrier, "_read_calendar_month_label", lambda _driver: month_labels[state["month"]])

    def fake_click_day(_driver, _target_date):
        if state["month"] != 6:
            return False
        state["selected"] = True
        return True

    monkeypatch.setattr(own_carrier, "_click_calendar_day", fake_click_day)
    monkeypatch.setattr(own_carrier, "_click_calendar_next_month", lambda _driver: state.__setitem__("month", 6) or True)
    monkeypatch.setattr(own_carrier, "_click_calendar_prev_month", lambda _driver: pytest.fail("should not move to previous month"))
    monkeypatch.setattr(own_carrier.time, "sleep", lambda _seconds: None)

    own_carrier._select_pickup_date(driver, date(2026, 6, 5), timeout_seconds=5)

    assert state == {"month": 6, "selected": True}


def test_select_phase_3_2_pickup_date_uses_scoped_next_month(monkeypatch) -> None:
    driver = object()
    state = {"month": 5, "selected": False}
    month_labels = {5: "五月 2026", 6: "六月 2026"}

    monkeypatch.setattr(own_carrier, "_phase_3_2_calendar_visible", lambda _driver: True)
    monkeypatch.setattr(own_carrier, "_phase_3_2_calendar_day_selected", lambda _driver, _target_date: state["selected"])
    monkeypatch.setattr(own_carrier, "_read_phase_3_2_calendar_month_label", lambda _driver: month_labels[state["month"]])

    def fake_click_day(_driver, _target_date):
        if state["month"] != 6:
            return False
        state["selected"] = True
        return True

    monkeypatch.setattr(own_carrier, "_click_phase_3_2_calendar_day", fake_click_day)
    monkeypatch.setattr(own_carrier, "_click_phase_3_2_calendar_next_month", lambda _driver: state.__setitem__("month", 6) or True)
    monkeypatch.setattr(own_carrier, "_click_phase_3_2_calendar_prev_month", lambda _driver: pytest.fail("should not move to previous month"))
    monkeypatch.setattr(own_carrier, "_read_calendar_month_label", lambda _driver: pytest.fail("global calendar month should not be read"))
    monkeypatch.setattr(own_carrier, "_click_calendar_next_month", lambda _driver: pytest.fail("global next month should not be clicked"))
    monkeypatch.setattr(own_carrier.time, "sleep", lambda _seconds: None)

    own_carrier._select_phase_3_2_pickup_date(driver, date(2026, 6, 5), timeout_seconds=5)

    assert state == {"month": 6, "selected": True}


def test_select_phase_3_2_ship_date_uses_ship_date_scoped_next_month(monkeypatch) -> None:
    driver = object()
    state = {"month": 5, "selected": False}
    month_labels = {5: "五月 2026", 6: "六月 2026"}

    monkeypatch.setattr(own_carrier, "_phase_3_2_ship_date_calendar_visible", lambda _driver: True)
    monkeypatch.setattr(own_carrier, "_phase_3_2_ship_date_value_matches", lambda _driver, _target_date: False)
    monkeypatch.setattr(own_carrier, "_phase_3_2_ship_date_calendar_day_selected", lambda _driver, _target_date: state["selected"])
    monkeypatch.setattr(own_carrier, "_read_phase_3_2_ship_date_calendar_month_label", lambda _driver: month_labels[state["month"]])

    def fake_click_day(_driver, _target_date):
        if state["month"] != 6:
            return False
        state["selected"] = True
        return True

    monkeypatch.setattr(own_carrier, "_click_phase_3_2_ship_date_calendar_day", fake_click_day)
    monkeypatch.setattr(own_carrier, "_click_phase_3_2_ship_date_calendar_next_month", lambda _driver: state.__setitem__("month", 6) or True)
    monkeypatch.setattr(own_carrier, "_click_phase_3_2_ship_date_calendar_prev_month", lambda _driver: pytest.fail("should not move to previous month"))
    monkeypatch.setattr(own_carrier, "_read_phase_3_2_calendar_month_label", lambda _driver: pytest.fail("delivery window month should not be read"))
    monkeypatch.setattr(own_carrier, "_click_phase_3_2_calendar_next_month", lambda _driver: pytest.fail("delivery window next month should not be clicked"))
    monkeypatch.setattr(own_carrier, "_read_calendar_month_label", lambda _driver: pytest.fail("global calendar month should not be read"))
    monkeypatch.setattr(own_carrier, "_click_calendar_next_month", lambda _driver: pytest.fail("global next month should not be clicked"))
    monkeypatch.setattr(own_carrier.time, "sleep", lambda _seconds: None)

    own_carrier._select_phase_3_2_ship_date(driver, date(2026, 6, 5), timeout_seconds=5)

    assert state == {"month": 6, "selected": True}


def test_select_pickup_date_moves_to_previous_month(monkeypatch) -> None:
    driver = object()
    state = {"month": 6, "selected": False}
    month_labels = {5: "五月 2026", 6: "六月 2026"}

    monkeypatch.setattr(own_carrier, "_calendar_visible", lambda _driver: True)
    monkeypatch.setattr(own_carrier, "_calendar_day_selected", lambda _driver, _target_date: state["selected"])
    monkeypatch.setattr(own_carrier, "_read_calendar_month_label", lambda _driver: month_labels[state["month"]])

    def fake_click_day(_driver, _target_date):
        if state["month"] != 5:
            return False
        state["selected"] = True
        return True

    monkeypatch.setattr(own_carrier, "_click_calendar_day", fake_click_day)
    monkeypatch.setattr(own_carrier, "_click_calendar_next_month", lambda _driver: pytest.fail("should not move to next month"))
    monkeypatch.setattr(own_carrier, "_click_calendar_prev_month", lambda _driver: state.__setitem__("month", 5) or True)
    monkeypatch.setattr(own_carrier.time, "sleep", lambda _seconds: None)

    own_carrier._select_pickup_date(driver, date(2026, 5, 20), timeout_seconds=5)

    assert state == {"month": 5, "selected": True}


def test_select_pickup_date_times_out_when_click_does_not_select(monkeypatch) -> None:
    driver = object()
    clock = {"now": 0.0}

    monkeypatch.setattr(own_carrier.time, "time", lambda: clock["now"])
    monkeypatch.setattr(own_carrier.time, "sleep", lambda seconds: clock.__setitem__("now", clock["now"] + float(seconds)))
    monkeypatch.setattr(own_carrier, "_calendar_visible", lambda _driver: True)
    monkeypatch.setattr(own_carrier, "_calendar_day_selected", lambda _driver, _target_date: False)
    monkeypatch.setattr(own_carrier, "_click_calendar_day", lambda _driver, _target_date: True)
    monkeypatch.setattr(own_carrier, "_read_calendar_month_label", lambda _driver: pytest.fail("clicked target should retry selection"))

    with pytest.raises(RuntimeError, match="等待目标日期选中超时: 2026-05-20"):
        own_carrier._select_pickup_date(driver, date(2026, 5, 20), timeout_seconds=1)


def test_legacy_layout_preserves_existing_date_and_carrier_flow(monkeypatch) -> None:
    calls: list[str] = []
    wait_timeouts: dict[str, int] = {}
    driver = object()
    target_date = date(2026, 5, 20)

    def fake_wait_for_click(step_name, clicker, **_kwargs):
        calls.append(f"wait_click:{step_name}")
        wait_timeouts[str(step_name)] = int(_kwargs["timeout_seconds"])
        assert clicker() is True

    def fake_wait_for_condition(step_name, checker, **_kwargs):
        calls.append(f"wait_condition:{step_name}")
        assert checker() is True

    monkeypatch.setattr(own_carrier, "_wait_for_click", fake_wait_for_click)
    monkeypatch.setattr(own_carrier, "_wait_for_condition", fake_wait_for_condition)
    monkeypatch.setattr(
        own_carrier,
        "_wait_phase_3_2_refresh_after_selection",
        lambda: pytest.fail("legacy should not wait for phase_3_2 refresh"),
    )
    monkeypatch.setattr(own_carrier, "_date_picker_visible", lambda _driver: calls.append("date_picker_visible") or True)
    monkeypatch.setattr(
        own_carrier,
        "_select_pickup_date",
        lambda _driver, selected_date, **_kwargs: calls.append(f"select_date:{selected_date.isoformat()}"),
    )
    monkeypatch.setattr(own_carrier, "_click_update_button", lambda _driver: calls.append("update") or True)
    monkeypatch.setattr(own_carrier, "_open_carrier_dropdown", lambda _driver: calls.append("open_carrier") or True)
    monkeypatch.setattr(own_carrier, "_select_other_carrier", lambda _driver: calls.append("select_other") or True)
    monkeypatch.setattr(own_carrier, "_open_transport_mode_dropdown", lambda _driver: calls.append("open_transport") or True)
    monkeypatch.setattr(
        own_carrier,
        "_select_transport_mode_option",
        lambda _driver, text: calls.append(f"select_transport:{text}") or True,
    )

    own_carrier._select_pickup_date_for_layout(
        driver,
        target_date,
        layout="legacy",
        timeout_seconds=60,
    )
    own_carrier._select_carrier_mode_for_layout(
        driver,
        {"ui_text": "陆运"},
        layout="legacy",
        timeout_seconds=60,
    )

    assert calls == [
        "wait_condition:日期选择器出现",
        "date_picker_visible",
        "select_date:2026-05-20",
        "wait_click:更新按钮",
        "update",
        "wait_click:承运人下拉框",
        "open_carrier",
        "wait_click:其他承运人选项",
        "select_other",
        "wait_click:运输方式下拉框",
        "open_transport",
        "wait_click:陆运运输方式选项",
        "select_transport:陆运",
    ]
    assert wait_timeouts["更新按钮"] == 30
