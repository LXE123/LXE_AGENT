from __future__ import annotations

import pytest

from services.agent_cli.browser.amazon_common import send_to_amazon_multi_box as multi_box


class _FakeStepHeaderDriver:
    def __init__(self, headers: list[dict[str, object]]) -> None:
        self.headers = list(headers)
        self.calls: list[tuple[str, tuple[object, ...]]] = []

    def execute_script(self, script: str, *args):
        self.calls.append((script, args))
        title_selector, checkmark_selector, required_keywords, done_notice = args
        assert title_selector == 'h4[data-testid="step-header-title"]'
        assert checkmark_selector == 'kat-icon[data-testid="header-checkmark"][name="check"]'
        keywords = [str(keyword) for keyword in required_keywords]
        for header in self.headers:
            title = str(header.get("title") or "")
            completed = bool(header.get("completed"))
            if all(keyword in title for keyword in keywords):
                return str(done_notice) if completed else ""
        return ""


class _FakeSession:
    def __init__(self) -> None:
        self.driver = object()


def test_read_confirmed_inventory_completed_notice_when_step1_has_checkmark() -> None:
    driver = _FakeStepHeaderDriver(
        [
            {"title": "第 1 步： 已确认要发送的库存", "completed": True},
            {"title": "第 1b 步 - 包装单件商品", "completed": False},
        ]
    )

    assert multi_box._read_confirmed_inventory_completed_notice(driver) == "已确认要发送的库存"


def test_read_confirmed_inventory_completed_notice_false_when_step1_still_selecting_inventory() -> None:
    driver = _FakeStepHeaderDriver(
        [
            {"title": "第 1 步： 选择要运送的库存", "completed": False},
            {"title": "第 1b 步 - 包装单件商品", "completed": True},
        ]
    )

    assert multi_box._read_confirmed_inventory_completed_notice(driver) == ""


def test_read_confirmed_inventory_completed_notice_ignores_other_step_checkmarks() -> None:
    driver = _FakeStepHeaderDriver(
        [
            {"title": "第 1 步： 选择要运送的库存", "completed": False},
            {"title": "第 1b 步 - 包装单件商品", "completed": True},
            {"title": "第 2 步： 确认发货", "completed": True},
        ]
    )

    assert multi_box._read_confirmed_inventory_completed_notice(driver) == ""


def test_read_pack_single_units_completed_notice_when_1b_has_checkmark() -> None:
    driver = _FakeStepHeaderDriver(
        [
            {"title": "第 1 步： 已确认要发送的库存", "completed": True},
            {"title": "第 1b 步 - 包装单件商品", "completed": True},
            {"title": "第 2 步： 确认发货", "completed": False},
        ]
    )

    assert multi_box._read_pack_single_units_completed_notice(driver) == "已完成包装单件商品步骤"


def test_read_pack_single_units_completed_notice_ignores_other_step_checkmarks() -> None:
    driver = _FakeStepHeaderDriver(
        [
            {"title": "第 1 步： 已确认要发送的库存", "completed": True},
            {"title": "第 1b 步 - 包装单件商品", "completed": False},
            {"title": "第 2 步： 确认发货", "completed": True},
        ]
    )

    assert multi_box._read_pack_single_units_completed_notice(driver) == ""


def test_read_pack_single_units_completed_notice_false_without_1b_checkmark() -> None:
    driver = _FakeStepHeaderDriver(
        [
            {"title": "第 1b 步 - 包装单件商品", "completed": False},
        ]
    )

    assert multi_box._read_pack_single_units_completed_notice(driver) == ""


def test_confirm_and_continue_waits_for_1b_checkmark_after_click(monkeypatch) -> None:
    session = _FakeSession()
    notices = iter(["", "已完成包装单件商品步骤"])
    calls: list[str] = []
    monkeypatch.setattr(
        multi_box,
        "_read_pack_single_units_completed_notice",
        lambda driver: calls.append("read_notice") or next(notices),
    )
    monkeypatch.setattr(
        multi_box,
        "_click_confirm_and_continue_button",
        lambda driver: calls.append("click_confirm") or True,
    )
    monkeypatch.setattr(multi_box, "_slow_workflow_loading_visible", lambda driver: False)
    monkeypatch.setattr(multi_box.time, "sleep", lambda _seconds: None)

    result = multi_box.confirm_and_continue_to_own_carrier(session, timeout_seconds=70)

    assert result == {"notice": "已完成包装单件商品步骤"}
    assert calls == ["read_notice", "click_confirm", "read_notice"]


def test_confirm_and_continue_times_out_without_1b_checkmark(monkeypatch) -> None:
    session = _FakeSession()
    ticks = iter([0.0, 71.0])
    monkeypatch.setattr(multi_box.time, "time", lambda: next(ticks))
    monkeypatch.setattr(multi_box.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(multi_box, "_read_pack_single_units_completed_notice", lambda driver: "")
    monkeypatch.setattr(multi_box, "_click_confirm_and_continue_button", lambda driver: True)
    monkeypatch.setattr(multi_box, "_slow_workflow_loading_visible", lambda driver: False)

    with pytest.raises(RuntimeError, match="等待第 1b 步包装单件商品完成超时"):
        multi_box.confirm_and_continue_to_own_carrier(session, timeout_seconds=70)
