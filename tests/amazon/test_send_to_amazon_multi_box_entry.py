from __future__ import annotations

import pytest

from services.agent_cli.browser.amazon_common import send_to_amazon_multi_box as multi_box


class _FakeSession:
    def __init__(self) -> None:
        self.driver = object()


def test_advance_to_multi_box_entry_returns_when_step1_already_completed(monkeypatch) -> None:
    session = _FakeSession()
    click_calls: list[str] = []
    monkeypatch.setattr(multi_box, "_read_confirmed_inventory_completed_notice", lambda driver: "已确认要发送的库存")
    monkeypatch.setattr(
        multi_box,
        "_click_pack_single_units_button",
        lambda driver: click_calls.append("click") or True,
    )

    payload = multi_box.advance_to_multi_box_entry(session, timeout_seconds=10)

    assert payload == {
        "ready": True,
        "notice": "已确认要发送的库存",
    }
    assert click_calls == []


def test_advance_to_multi_box_entry_clicks_continue_and_waits_for_step1_checkmark(monkeypatch) -> None:
    session = _FakeSession()
    notices = iter(["", "已确认要发送的库存"])
    click_calls: list[str] = []
    monkeypatch.setattr(multi_box, "_read_confirmed_inventory_completed_notice", lambda driver: next(notices))
    monkeypatch.setattr(
        multi_box,
        "_click_pack_single_units_button",
        lambda driver: click_calls.append("click") or True,
    )
    monkeypatch.setattr(multi_box.time, "sleep", lambda _seconds: None)

    payload = multi_box.advance_to_multi_box_entry(session, timeout_seconds=10)

    assert payload["ready"] is True
    assert click_calls == ["click"]


def test_advance_to_multi_box_entry_does_not_read_footer_error_before_click(monkeypatch) -> None:
    session = _FakeSession()
    ticks = iter([0.0, 0.0, 11.0])
    monkeypatch.setattr(multi_box.time, "time", lambda: next(ticks))
    monkeypatch.setattr(multi_box.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(multi_box, "_read_confirmed_inventory_completed_notice", lambda driver: "")
    monkeypatch.setattr(multi_box, "_click_pack_single_units_button", lambda driver: False)
    monkeypatch.setattr(
        multi_box,
        "_read_step1_sku_footer_error",
        lambda driver: pytest.fail("SKU footer error should not be read before clicking continue"),
    )

    with pytest.raises(RuntimeError, match="等待第 1 步库存确认完成超时"):
        multi_box.advance_to_multi_box_entry(session, timeout_seconds=10)


def test_advance_to_multi_box_entry_does_not_read_footer_error_during_first_10_seconds(monkeypatch) -> None:
    session = _FakeSession()
    ticks = iter([0.0, 0.0, 0.0, 5.0])
    notices = iter(["", "已确认要发送的库存"])
    monkeypatch.setattr(multi_box.time, "time", lambda: next(ticks))
    monkeypatch.setattr(multi_box.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(multi_box, "_read_confirmed_inventory_completed_notice", lambda driver: next(notices))
    monkeypatch.setattr(multi_box, "_click_pack_single_units_button", lambda driver: True)
    monkeypatch.setattr(
        multi_box,
        "_read_step1_sku_footer_error",
        lambda driver: pytest.fail("SKU footer error should not be read during the first 10 seconds"),
    )

    payload = multi_box.advance_to_multi_box_entry(session, timeout_seconds=20)

    assert payload == {
        "ready": True,
        "notice": "已确认要发送的库存",
    }


def test_advance_to_multi_box_entry_raises_footer_error_after_10_seconds(monkeypatch) -> None:
    session = _FakeSession()
    ticks = iter([0.0, 0.0, 0.0, 11.0, 11.0])
    monkeypatch.setattr(multi_box.time, "time", lambda: next(ticks))
    monkeypatch.setattr(multi_box.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(multi_box, "_read_confirmed_inventory_completed_notice", lambda driver: "")
    monkeypatch.setattr(multi_box, "_click_pack_single_units_button", lambda driver: True)
    monkeypatch.setattr(
        multi_box,
        "_read_step1_sku_footer_error",
        lambda driver: "第一阶段库存确认失败: 此商品超出了仓储的容量限制。",
    )

    with pytest.raises(RuntimeError, match="第一阶段库存确认失败: .*仓储"):
        multi_box.advance_to_multi_box_entry(session, timeout_seconds=60)


def test_advance_to_multi_box_entry_times_out_without_step1_checkmark(monkeypatch) -> None:
    session = _FakeSession()
    ticks = iter([0.0, 0.0, 11.0])
    monkeypatch.setattr(multi_box.time, "time", lambda: next(ticks))
    monkeypatch.setattr(multi_box.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(multi_box, "_read_confirmed_inventory_completed_notice", lambda driver: "")
    monkeypatch.setattr(multi_box, "_click_pack_single_units_button", lambda driver: False)

    with pytest.raises(RuntimeError, match="等待第 1 步库存确认完成超时"):
        multi_box.advance_to_multi_box_entry(session, timeout_seconds=10)


def test_generate_multi_box_excel_does_not_click_step1_continue_when_radio_missing(monkeypatch) -> None:
    session = _FakeSession()
    wait_calls: list[str] = []
    monkeypatch.setattr(
        multi_box,
        "_wait_click_packing_method_box_or_skip",
        lambda driver, **kwargs: wait_calls.append("wait_packing_method") or False,
    )
    monkeypatch.setattr(multi_box.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(multi_box, "_has_multi_box_radio", lambda driver: False)
    monkeypatch.setattr(
        multi_box,
        "_click_pack_single_units_button",
        lambda driver: pytest.fail("step1 continue should not be clicked in step2"),
    )

    with pytest.raises(RuntimeError, match="标准包装方式卡片点击后仍未选中"):
        multi_box.generate_multi_box_excel(session, box_count=1)
    assert wait_calls == ["wait_packing_method"]


def test_generate_multi_box_excel_keeps_original_error_when_packing_selected_but_radio_missing(monkeypatch) -> None:
    session = _FakeSession()
    monkeypatch.setattr(
        multi_box,
        "_wait_click_packing_method_box_or_skip",
        lambda driver, **kwargs: True,
    )
    monkeypatch.setattr(multi_box.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(multi_box, "_has_multi_box_radio", lambda driver: False)

    with pytest.raises(RuntimeError, match="当前页面未进入多包装箱流程"):
        multi_box.generate_multi_box_excel(session, box_count=1)


def test_generate_multi_box_excel_clicks_packing_method_before_multi_box_radio(monkeypatch) -> None:
    session = _FakeSession()
    calls: list[str] = []
    monkeypatch.setattr(
        multi_box,
        "_wait_click_packing_method_box_or_skip",
        lambda driver, **kwargs: calls.append("wait_packing_method") or True,
    )
    monkeypatch.setattr(multi_box, "_has_multi_box_radio", lambda driver: calls.append("has_radio") or True)
    monkeypatch.setattr(multi_box, "_click_multi_box_radio", lambda driver: calls.append("click_radio") or True)
    monkeypatch.setattr(multi_box, "_click_confirm_button", lambda driver: calls.append("confirm") or True)
    monkeypatch.setattr(multi_box, "_open_input_method_dropdown", lambda driver: calls.append("open_input_method") or True)
    monkeypatch.setattr(multi_box, "_select_excel_upload_option", lambda driver: calls.append("select_excel") or True)
    monkeypatch.setattr(multi_box, "_set_box_count", lambda driver, box_count: calls.append(f"set_box_count:{box_count}") or True)
    monkeypatch.setattr(multi_box, "_click_generate_excel_button", lambda driver: calls.append("generate") or True)
    monkeypatch.setattr(multi_box, "_read_download_filename_notice", lambda driver: calls.append("read_notice") or "template.xlsx")
    monkeypatch.setattr(multi_box.time, "sleep", lambda _seconds: None)

    assert multi_box.generate_multi_box_excel(session, box_count=2, timeout_seconds=5) == {"notice": "template.xlsx"}
    assert calls == [
        "wait_packing_method",
        "has_radio",
        "click_radio",
        "confirm",
        "open_input_method",
        "select_excel",
        "set_box_count:2",
        "generate",
        "read_notice",
    ]
